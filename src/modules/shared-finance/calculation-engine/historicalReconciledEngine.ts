// ─────────────────────────────────────────────────────────────────────────
// historicalReconciledEngine — MOTOR 1 (Histórico Reconciliado, ≤ hoy).
// Emite la verdad histórica del efectivo a nivel línea: estado de cuenta
// bancario (`bank:`), el neto de traspasos internos (`internal-recon:`), y los
// rellenos sintéticos para meses sin banco desde cobranza JDE
// (`cobranza-historic:`) y el libro mayor AuxiliarContable
// (`auxiliar-historic:`). Los brutos del `monthly[]` ya vienen re-sourceados a
// la conciliación Auxiliar×Bancos (ver `computeBaseCashFlow` +
// `reconciledByCompanyMonth`). NO corre el prorrateo Citi — eso lo hace el
// orquestador (`canonicalProjection`) sobre la lista compuesta.
// ─────────────────────────────────────────────────────────────────────────

import {
  buildOwnAccountDetector,
  buildOwnAccountsIndex,
  buildPairMatchedKeys,
  classifyMovement,
} from '../../../domain/netCashFlowEngine';
import {
  buildClientLookup,
  findClientForCobranza,
} from '../../../domain/collectionCalendarEngine';
import { bankMovementKey } from '../../../domain/bankMovementKey';
import { isCorningAbono } from '../../../domain/bankStatements';
import { classifyBankConcept } from '../../../domain/bankConceptClassifier';
import { buildCargoProviderIndex, matchCargoToProvider } from '../../../domain/cargoProviderMatch';
import { enrichMovementWithCatalog, findBankAccount } from '../../../domain/bankAccountsCatalog';
import type { Client } from '../../../domain/types';
import type { BankInflowEnrichment } from '../../../domain/auxiliarProjectionAdapter';
import { calculateConfidenceBand } from './financialProjectionEngine';
import type {
  FinancialMovement,
  FinancialMovementCategory,
} from '../types';
import {
  cleanDate,
  clientDisplayCounterparty,
  cxcFacturaKey,
  filterCobranzaByCompany,
  INCOME_SUBCAT_CITI,
  resolveInflowSubcategory,
  usableJdeProviderCategory,
  type BuildArgs,
} from './canonicalProjectionShared';

/**
 * MOTOR 1 — Histórico reconciliado (≤ hoy). Emite la verdad histórica del
 * efectivo: estado de cuenta bancario (`bank:`), el neto de traspasos internos
 * (`internal-recon:`, ancla la caja al saldo bancario real), y los rellenos
 * sintéticos para meses sin banco desde cobranza JDE (`cobranza-historic:`) y
 * el libro mayor AuxiliarContable (`auxiliar-historic:`). Los brutos del
 * `monthly[]` ya vienen re-sourceados a la conciliación Auxiliar×Bancos (ver
 * `computeBaseCashFlow` + `reconciledByCompanyMonth`); este motor produce los
 * movimientos a nivel línea. NO corre el prorrateo Citi — eso lo hace el
 * orquestador sobre la lista compuesta.
 */
export function buildHistoricalReconciledMovements({ monthly, inputs }: BuildArgs): FinancialMovement[] {
  const out: FinancialMovement[] = [];
  const monthlyByYm = new Map(monthly.map((m) => [m.yearMonth, m]));
  // clientById debe resolver tanto por client.id (slug del catálogo) como
  // por noCliente JDE (numérico). Los ABONOs de cobranza pasan `noCliente`
  // crudo cuando el enriquecimiento no encontró el catalogClientId — sin
  // este alias, resolveInflowSubcategory no puede detectar grupos como
  // Viajes Especiales antes del default comercial Citi.
  const clientById = new Map<string, Client>();
  for (const c of inputs.clients) {
    clientById.set(c.id, c);
    for (const acc of c.jdeAccounts ?? []) {
      const nc = (acc?.noCliente ?? '').trim();
      if (nc && !clientById.has(nc)) clientById.set(nc, c);
    }
    // Indexar también por commercialGroupId. Cuando un movimiento se colapsa
    // al grupo padre como counterparty, `resolveInflowSubcategory` debe poder
    // resolver el grupo y aplicar reglas comerciales como Viajes Especiales.
    if (c.commercialGroupId && !clientById.has(c.commercialGroupId)) {
      clientById.set(c.commercialGroupId, c);
    }
  }

  // Mismo contexto de clasificación que `buildHistoricalMonths` del
  // Dashboard. Sin esto los traspasos internos (TRASPASO REF, RFCs del
  // grupo, pares CARGO/ABONO simétricos) se emitían como FinancialMovement
  // y la suma de movements[] no empataba con monthly[] — la gráfica de
  // Caja proyectada inflaba ingresos y egresos por igual.
  const ownAccountDetector = buildOwnAccountDetector(
    buildOwnAccountsIndex(inputs.bankStatements),
  );
  const pairedKeys = buildPairMatchedKeys(inputs.bankStatements);

  // Cobertura bancaria por (cia, ym): si hay AL MENOS un movimiento en el
  // estado de cuenta de esa empresa en ese mes, el ABONO bancario ya es la
  // verdad realizada del efectivo. El sintético `cobranza-historic:` (paso 1b)
  // solo debe rellenar cía/meses SIN estado de cuenta; si no, el cobro se
  // cuenta dos veces (ABONO real + sintético) e infla `realIncome` ~2×.
  const bankCoverage = new Set<string>();

  // Mapa movementKey → AbonoEnrichment. Permite reclasificar un ABONO
  // histórico como cobranza por cliente cuando el cruce contra cobranza JDE
  // detectó qué factura(s) cubrió. Sin esto los ingresos pasados quedaban
  // todos bajo "Transferencias" en Planeación, ocultando el ingreso por
  // cliente en meses pasados.
  const abonoEnrichmentByKey = new Map<string, BankInflowEnrichment>();
  for (const enrichment of inputs.abonoEnrichments ?? []) {
    abonoEnrichmentByKey.set(enrichment.movementKey, enrichment);
  }
  const cargoEnrichmentByKey = inputs.cargoEnrichments ?? new Map();
  // Índice para identificar CARGOs sin cruce a PagoProveedor: nombre del
  // proveedor en el concepto bancario + monto contra compras (OCs).
  const cargoProviderIndex = buildCargoProviderIndex(
    inputs.providers,
    inputs.purchaseReceipts ?? [],
  );

  // Reconciliación de traspasos internos. Cada CARGO/ABONO que descartamos
  // abajo (interno heurístico o cuenta neutra del catálogo) deja de contar en
  // la caja, PERO el saldo bancario real sí los incluye — se cancelan entre
  // cuentas propias. La detección no es perfectamente simétrica (con ~$18B de
  // traspasos, un residuo <1% = cientos de M), así que el neto descartado
  // (Σ ABONO − Σ CARGO internos) hace que la caja de `movements[]` derive del
  // saldo real (caja Base salía negativa con banco real positivo). Acumulamos
  // ese neto por (cia, mes) y lo re-emitimos como UN movimiento
  // `internal-recon:` para anclar la caja al banco sin re-inflar los brutos con
  // los miles de millones de traspasos individuales. `buildHistoricalMonths`
  // ya hace lo equivalente en su `closingCash` (suma todos los movimientos).
  const internalReconByKey = new Map<string, { net: number; cia: string; lastDate: string }>();
  const accrueInternalResidual = (cia: string, ym: string, tipo: string, importe: number, fecha: string) => {
    const amt = Math.abs(importe || 0);
    if (!(amt > 0)) return;
    const signed = tipo === 'ABONO' ? amt : -amt;
    const key = `${cia}::${ym}`;
    const date = fecha || `${ym}-01`;
    const cur = internalReconByKey.get(key);
    if (cur) {
      cur.net += signed;
      if (date > cur.lastDate) cur.lastDate = date;
    } else {
      internalReconByKey.set(key, { net: signed, cia, lastDate: date });
    }
  };

  // 1) Histórico bancario — los mismos números que sumó el Dashboard.
  for (const statement of inputs.bankStatements) {
    if (
      inputs.companyCode !== 'all'
      && inputs.companyCode
      && statement.cia !== inputs.companyCode
    ) continue;
    for (const line of statement.movimientos) {
      const ym = (line.fechaOperacion ?? '').slice(0, 7);
      if (ym.length !== 7) continue;
      if (!monthlyByYm.has(ym)) continue;
      // Hay estado de cuenta para esta (cia, ym): el ABONO bancario es la
      // verdad realizada; el sintético cobranza-historic de paso 1b se omite.
      // Se marca antes de los filtros interno/neutro a propósito: la
      // presencia del estado de cuenta no depende de la clasificación de una
      // línea individual.
      bankCoverage.add(`${statement.cia}::${ym}`);
      // Filtra traspasos internos antes de emitir el FinancialMovement —
      // mismo criterio que el Dashboard. Movimientos clasificados como
      // 'internal' nunca llegan a la tabla, gráfica ni drilldowns.
      if (
        classifyMovement(
          line,
          { ownAccountDetector, pairedKeys },
          statement.cia,
          statement.cuenta,
        ).kind === 'internal'
      ) {
        accrueInternalResidual(statement.cia, ym, line.tipoMovimiento, line.importe, line.fechaOperacion);
        continue;
      }
      // Catálogo de cuentas: cuentas con role neutro (reserva, ahorro,
      // crédito, garantía, por_cancelar, saldo_retenido) son traspasos
      // internos por definición — se excluyen del modelo de planeación
      // igual que los movimientos internos detectados por heurística.
      // Para cuentas operativas el catálogo aporta `unidadNegocio` y
      // `subRole`, que se usan más abajo para etiquetar el movimiento.
      const catalogEnrich = enrichMovementWithCatalog({
        cuenta: statement.cuenta,
        cuentaBancos: line.cuentaBancos ?? line.cuenta,
        tipoMovimiento: line.tipoMovimiento,
        importe: line.importe,
      });
      if (catalogEnrich && catalogEnrich.entry.flow === 'neutro') {
        accrueInternalResidual(statement.cia, ym, line.tipoMovimiento, line.importe, line.fechaOperacion);
        continue;
      }
      const isInflow = line.tipoMovimiento === 'ABONO';
      const movementKey = bankMovementKey(line);
      const enrichment = isInflow ? abonoEnrichmentByKey.get(movementKey) : undefined;
      const isCobranzaInflow = enrichment?.status === 'factura-cobrada'
        && (enrichment.facturas?.length ?? 0) > 0;
      const firstFactura = isCobranzaInflow ? enrichment!.facturas![0] : undefined;
      // CARGO enrichment: si PagoProveedor empata este CARGO con un pago a
      // proveedor, lo reclasificamos como AP_PAYMENT con el nombre del
      // proveedor. Sin match cae al cubo "Otros Egresos" (TRANSFER) con
      // drill-down por banco/concepto.
      const cargoEnrich = !isInflow ? cargoEnrichmentByKey.get(movementKey) : undefined;
      const matchedPayment = cargoEnrich?.status === 'MATCHED'
        ? cargoEnrich.payments?.[0]
        : undefined;
      const isMatchedAp = !!matchedPayment;
      const matchedPaymentProviderCategory = matchedPayment
        ? usableJdeProviderCategory(
            matchedPayment.clasificacionProveedor,
            matchedPayment.clasificacionProveedorFinanciera,
          )
        : undefined;
      // ABONOs sin match a factura → agrupar por banco origen para que la
      // tabla de Planeación no muestre cientos de filas únicas por concepto
      // bancario. Sin cruce de cobranza, Federal/Citi se decide por la cuenta
      // del catálogo; con cruce, manda la identidad comercial del cliente.
      const bankFallbackName = statement.nombreBanco || statement.banco || 'Banco';
      // Etiqueta de fila para ABONOs sin cruce de factura: preferimos el
      // CONCEPTO del catálogo de cuentas (ej. "CONCENTRADORA - IMSS",
      // "TPV AMEX", "CONCENTRADORA VENTA FEDERAL") sobre el nombre genérico
      // del banco. Así dentro de cada bucket (Federal/Citi) la Planeación
      // desglosa el ingreso por concepto en vez de colapsarlo en una sola
      // fila "BANAMEX". NO altera la clasificación: el bucket lo sigue
      // decidiendo `unidadNegocio` (resolveInflowSubcategory). Solo cambia el
      // label visible. Si la cuenta no está catalogada, cae al nombre de banco.
      const bankInflowName = catalogEnrich?.entry.concepto?.trim() || bankFallbackName;
      // CARGOs sin identificar (concepto sin patrón fiscal/proveedor) se
      // etiquetan por cuenta de banco origen. Sin esto, miles de cargos sin
      // cruce colapsan en una sola fila "Sin identificar" de varios miles de
      // millones — imposible de auditar. Por cuenta, la fila gigante se parte
      // en una por cuenta y el usuario ve de dónde sale el dinero.
      const unidentifiedOutflowName = `Sin identificar · ${
        (statement.nombreBanco || statement.banco || 'Banco')
      } ${statement.cuenta}`.trim();
      // CARGOs sin match a PagoProveedor: clasificar por concepto crudo
      // (`IVA`, `ISR`, `IMSS`, `COMISION`, etc.) para que miles de folios
      // únicos colapsen en pocas filas legibles. Detalle crudo permanece en
      // `concept` para drill-down al click.
      const unmatchedCargoClassification = !isInflow && !isMatchedAp
        ? classifyBankConcept({
            concepto: line.concepto,
            infAdi1: line.infAdi1,
            infAdi2: line.infAdi2,
            infAdi3: line.infAdi3,
          })
        : undefined;
      // CARGO sin cruce a PagoProveedor y sin patrón fiscal/bancario (cayó al
      // genérico TRANSFER): intentar identificar al proveedor por nombre en
      // el concepto o por monto contra compras (OCs). Cubre el caso "el pago
      // no quedó registrado en JDE".
      const cargoProviderHit = unmatchedCargoClassification?.category === 'TRANSFER'
        ? matchCargoToProvider({
            conceptHaystack: [line.concepto, line.infAdi1, line.infAdi2, line.infAdi3]
              .filter((v): v is string => typeof v === 'string' && v.length > 0)
              .join(' '),
            amount: Math.abs(line.importe),
            dateIso: line.fechaOperacion,
            index: cargoProviderIndex,
          })
        : null;
      // Si el ABONO se cruzó a una factura y el cliente está en catálogo con
      // grupo comercial, colapsa al grupo padre en lugar de la subsidiaria
      // individual. Mismo display para name e id.
      const cobranzaClient = isCobranzaInflow && enrichment!.catalogClientId
        ? clientById.get(enrichment!.catalogClientId) ?? clientById.get(firstFactura?.noCliente ?? '')
        : undefined;
      const cobranzaDisplay = cobranzaClient ? clientDisplayCounterparty(cobranzaClient) : undefined;
      const counterpartyName = isCobranzaInflow
        ? (cobranzaDisplay?.name ?? enrichment!.catalogClientName ?? firstFactura?.nombreCliente ?? undefined)
        : isMatchedAp
          ? matchedPayment!.nombreProveedor || undefined
          : isInflow
            ? bankInflowName
            : (cargoProviderHit?.counterpartyName
                ?? (unmatchedCargoClassification!.category === 'TRANSFER'
                  ? unidentifiedOutflowName
                  : unmatchedCargoClassification!.counterpartyName));
      const counterpartyId = isCobranzaInflow
        ? (cobranzaDisplay?.id ?? enrichment!.catalogClientId ?? firstFactura?.noCliente ?? undefined)
        : isMatchedAp
          ? (matchedPayment!.claveProveedor || undefined)
          : (cargoProviderHit?.counterpartyId ?? undefined);
      // Corning es ingreso Senda Citi que cae en una cuenta no catalogada
      // como CITI (depósito de la operadora). Sin este override el ABONO no
      // cruza factura ni catálogo y cae a "Otros ingresos". Misma regla
      // compartida que usa el sub-libro fideicomiso (isCorningAbono).
      const inflowSubcategory = isInflow
        ? (isCorningAbono(line)
            ? INCOME_SUBCAT_CITI
            : resolveInflowSubcategory({
                counterpartyId,
                counterpartyName,
                clientById,
                businessUnitId: catalogEnrich?.entry.unidadNegocio,
                bankSubRole: catalogEnrich?.entry.subRole,
                isRolCollection: isCobranzaInflow,
              }))
        : undefined;
      // Si se identificó proveedor, el CARGO es un pago a proveedor (AP_PAYMENT),
      // ya no un egreso genérico sin clasificar.
      const cargoCategory: FinancialMovementCategory = cargoProviderHit
        ? 'AP_PAYMENT'
        : unmatchedCargoClassification?.category ?? 'TRANSFER';
      // Si el clasificador de concepto bancario no produce subcategoría,
      // pero la cuenta vive en el catálogo, usamos el subRole/role del
      // catálogo (`nomina_operadores`, `dotacion_efectivo`, `dolares`,
      // `proveedores_nomina`, …). Esto evita cientos de CARGOs etiquetados
      // como genérico "Otros Egresos" cuando el banco solo manda folios
      // numéricos pero el destino de la cuenta es claro.
      const cargoSubcategory = isMatchedAp
        ? matchedPaymentProviderCategory
        : cargoProviderHit?.providerType
          ?? unmatchedCargoClassification?.subcategory
          ?? (catalogEnrich && !isInflow
            ? catalogEnrich.entry.subRole ?? catalogEnrich.entry.role
            : undefined);
      out.push({
        id: `bank:${statement.cia}:${statement.cuenta}:${line.referencia ?? ''}:${line.fechaOperacion}:${out.length}`,
        sourceSystem: 'BANK',
        sourceObjectId: line.referencia,
        type: isInflow ? 'INFLOW' : 'OUTFLOW',
        category: isCobranzaInflow
          ? 'AR_COLLECTION'
          : isMatchedAp
            ? 'AP_PAYMENT'
            : isInflow
              ? 'TRANSFER'
              : cargoCategory,
        subcategory: isInflow ? inflowSubcategory : cargoSubcategory,
        providerCategory: !isInflow ? (matchedPaymentProviderCategory ?? cargoProviderHit?.providerType ?? undefined) : undefined,
        companyId: statement.cia,
        businessUnitId: catalogEnrich?.entry.unidadNegocio,
        bankAccountId: statement.cuenta,
        counterpartyId,
        counterpartyName,
        counterpartyType: isCobranzaInflow
          ? 'CUSTOMER'
          : (isMatchedAp || cargoProviderHit)
            ? 'SUPPLIER'
            : 'BANK',
        concept: line.concepto || 'Movimiento bancario',
        currency: line.moneda || statement.moneda || 'MXN',
        originalAmount: Math.abs(line.importe),
        baseAmount: Math.abs(line.importe),
        projectedAmount: Math.abs(line.importe),
        actualDate: line.fechaOperacion,
        projectedDate: line.fechaOperacion,
        confidenceScore: 100,
        confidenceBand: calculateConfidenceBand(100),
        forecastMethod: 'RULE',
        ruleApplied: cargoProviderHit
          ? (cargoProviderHit.matchSource === 'concept-name'
              ? 'Proveedor identificado por concepto bancario'
              : 'Proveedor identificado por monto vs compras')
          : 'Estado de cuenta bancario',
        status: 'REAL',
        lockState: 'LOCKED',
        comments: ['Dato real del banco. No editable desde Planeación.'],
        createdAt: `${line.fechaOperacion}T00:00:00.000Z`,
        updatedAt: `${line.fechaOperacion}T00:00:00.000Z`,
      });
    }
  }

  // 1a) Re-emite el neto de traspasos internos descartados por (cia, mes).
  //     Sin esto la caja acumulada de `movements[]` quedaba por debajo del
  //     saldo bancario real (Σ ABONO − Σ CARGO internos no apareados). Un solo
  //     movimiento neutro por bucket; categoría INTERNAL_RECON queda fuera de
  //     los brutos de Ingresos/Egresos pero cuenta en la caja. status REAL +
  //     fecha pasada → sobrevive el filtro de Base (real corto plazo, ≤ hoy).
  for (const { net, cia, lastDate } of internalReconByKey.values()) {
    if (Math.abs(net) < 1) continue;
    const isInflow = net >= 0;
    out.push({
      id: `internal-recon:${cia}:${lastDate}`,
      sourceSystem: 'BANK',
      type: isInflow ? 'INFLOW' : 'OUTFLOW',
      category: 'INTERNAL_RECON',
      subcategory: 'Traspasos internos (neto)',
      companyId: cia,
      counterpartyType: 'BANK',
      concept: 'Traspasos internos (neto)',
      currency: 'MXN',
      originalAmount: Math.abs(net),
      baseAmount: Math.abs(net),
      projectedAmount: Math.abs(net),
      actualDate: lastDate,
      projectedDate: lastDate,
      confidenceScore: 100,
      confidenceBand: calculateConfidenceBand(100),
      forecastMethod: 'RULE',
      ruleApplied: 'Reconciliación neta de traspasos internos vs saldo bancario',
      status: 'REAL',
      lockState: 'LOCKED',
      comments: ['Neto de transferencias entre cuentas propias que la detección no pudo aparear individualmente. Ancla la caja al saldo bancario real; no es un ingreso/egreso económico.'],
      createdAt: `${lastDate}T00:00:00.000Z`,
      updatedAt: `${lastDate}T00:00:00.000Z`,
    });
  }

  // 1b) Histórico desde cobranza JDE. Cuando el banco no cubre meses
  //     pasados (estados de cuenta no cargados, periodo fuera de
  //     ventana), las facturas con `fechaCobro` real igual seguían sin
  //     aparecer por cliente en Planeación. Aquí emitimos un
  //     AR_COLLECTION sintético por factura cobrada cuya fecha cae en
  //     un mes histórico y NO fue ya cruzada con un ABONO bancario en
  //     el paso 1 (evita doble conteo).
  const cobradaBancoKeysHistoric = inputs.cobradaBancoKeys ?? new Set<string>();
  const companyCobranza = filterCobranzaByCompany(
    inputs.cobranzaRecords ?? [],
    inputs.companyCode,
  );
  const clientLookupHistoric = buildClientLookup(inputs.clients);
  for (const record of companyCobranza) {
    const cobroDate = cleanDate(record.fechaCobro);
    if (!cobroDate) continue;
    if (cobroDate >= inputs.asOfDate) continue;
    const ym = cobroDate.slice(0, 7);
    const monthInfo = monthlyByYm.get(ym);
    if (!monthInfo || !monthInfo.isHistorical) continue;
    // El banco ya cubre esta (cia, mes): el ABONO real es la verdad del
    // efectivo. Emitir aquí el sintético duplicaría el cobro (doble conteo
    // que inflaba `realIncome` ~2× en el chart del Dashboard). El sintético
    // solo rellena cía/meses sin estado de cuenta cargado.
    if (bankCoverage.has(`${record.cia}::${ym}`)) continue;
    const facturaKey = cxcFacturaKey(record);
    if (cobradaBancoKeysHistoric.has(facturaKey)) continue;
    const amount = Math.abs(record.importeBrutoPesos);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const clientMatch = findClientForCobranza(record, clientLookupHistoric);
    const counterpartyId = clientMatch?.client.id ?? record.noCliente;
    const counterpartyName = clientMatch?.client.name || record.nombreCliente || 'Cliente sin nombre';
    out.push({
      id: `cobranza-historic:${record.cia}:${record.noCliente}:${record.noFactura}:${cobroDate}`,
      sourceSystem: 'JDE',
      sourceObjectId: record.noFactura,
      type: 'INFLOW',
      category: 'AR_COLLECTION',
      subcategory: resolveInflowSubcategory({ counterpartyId, counterpartyName, clientById, isRolCollection: true }),
      companyId: record.cia,
      counterpartyId,
      counterpartyName,
      counterpartyType: 'CUSTOMER',
      concept: `Cobro factura ${record.noFactura || 'sin folio'} · ${counterpartyName}`,
      currency: record.moneda || 'MXN',
      originalAmount: amount,
      baseAmount: amount,
      projectedAmount: amount,
      issueDate: cleanDate(record.fechaFactura),
      dueDate: cleanDate(record.fechaVence),
      actualDate: cobroDate,
      projectedDate: cobroDate,
      confidenceScore: 100,
      confidenceBand: calculateConfidenceBand(100),
      forecastMethod: 'RULE',
      ruleApplied: 'Cobranza JDE (fechaCobro real)',
      status: 'REAL',
      lockState: 'LOCKED',
      comments: ['Cobro real reportado por JDE. No editable desde Planeación.'],
      createdAt: `${cobroDate}T00:00:00.000Z`,
      updatedAt: `${cobroDate}T00:00:00.000Z`,
    });
  }

  // 1c) Histórico desde AuxiliarContable (libro mayor JDE) — espejo de
  //     `cobranza-historic` pero cubre INGRESOS y EGRESOS. Cuando un mes
  //     histórico (cia, ym) NO tiene estado de cuenta cargado en el paso 1,
  //     las líneas GL son la verdad realizada del cash flow: salieron del
  //     banco/caja. Sin esto Planeación queda en blanco para egresos pasados
  //     hasta que el usuario cargue manualmente los estados de cuenta —
  //     AuxiliarContable se carga automático y cubre 2025-01 → hoy.
  //
  //     Filtros:
  //     - Sólo flujo ingreso/egreso (caja=movimientos internos de caja,
  //       interno=traspasos entre cuentas propias — no son flujo real).
  //     - Sólo meses históricos dentro de la ventana monthly.
  //     - Sólo (cia, ym) SIN cobertura bancaria (mismo cut que 1b).
  //     - Sólo líneas SIN `bankMovementKey` cuando el mes SÍ tiene cobertura
  //       (línea cruzada ya está representada vía `bank:*`).
  for (const line of inputs.auxiliarReconLines ?? []) {
    if (
      inputs.companyCode !== 'all'
      && inputs.companyCode
      && line.cia !== inputs.companyCode
    ) continue;
    if (line.flujo !== 'ingreso' && line.flujo !== 'egreso') continue;
    // Traspaso intercompañía / entre cuentas propias del grupo: el motor de
    // conciliación ya lo etiquetó `matchTier === 'interno'`. No es un ingreso
    // ni egreso económico real (el otro lado lo compensa), así que se excluye
    // del modelo de Planeación — mismo criterio que el filtro de movimientos
    // internos del paso 1 (banco) y los filtros CXP/CXC por contraparte interna.
    if (line.matchTier === 'interno') continue;
    const fecha = line.fechaContable;
    if (!fecha || fecha.length < 10) continue;
    if (fecha >= inputs.asOfDate) continue;
    const ym = fecha.slice(0, 7);
    const monthInfo = monthlyByYm.get(ym);
    if (!monthInfo || !monthInfo.isHistorical) continue;
    // Si el banco cubre el mes para esta cia, los movimientos ya están en
    // el paso 1. Sólo emitimos aux-historic cuando NO hay estado de cuenta:
    // el GL es la única fuente de la verdad realizada para ese período.
    if (bankCoverage.has(`${line.cia}::${ym}`)) continue;
    const monto = Math.abs(line.importe);
    if (!Number.isFinite(monto) || monto <= 0) continue;
    const isInflow = line.flujo === 'ingreso';
    const counterpartyName = line.source.contraparte
      || line.nombreCuenta
      || (isInflow ? 'Ingreso JDE' : 'Egreso JDE');
    const auxiliarTaxClassification = !isInflow
      ? classifyBankConcept({
          concepto: [
            line.tipoDoctoDesc,
            line.tipoDocto,
            line.source.ref,
            line.source.contraparte,
            line.nombreCuenta,
          ].filter(Boolean).join(' '),
        })
      : undefined;
    // Cliente catálogo: si la contraparte coincide con un cliente conocido,
    // colapsamos al grupo comercial. Para egresos no hacemos lookup de
    // proveedor (la línea GL no trae idProveedor confiable) — cae a
    // counterpartyName crudo + categoría TRANSFER.
    //
    // Para ABONOs históricos cubiertos por AuxiliarContable (paso 1c), la
    // cía del asiento contable + la cuenta bancaria son la fuente de verdad.
    // El subRole de la cuenta (`viajes_especiales` para la cuenta "678 38444"
    // de TRANSPORTES TAMAULIPAS) baja el ingreso al bucket correcto en vez
    // de caer al genérico FEDERAL por el `unidadNegocio` de la misma cuenta.
    const auxBankEntry = isInflow ? findBankAccount(line.cuentaBanco) : null;
    const inflowSubcategory = isInflow
      ? resolveInflowSubcategory({
          counterpartyId: undefined,
          clientById,
          businessUnitId: auxBankEntry?.unidadNegocio,
          bankSubRole: auxBankEntry?.subRole,
          isRolCollection: line.source.kind === 'factura',
        })
      : undefined;
    out.push({
      id: `auxiliar-historic:${line.glKey}`,
      sourceSystem: 'JDE',
      sourceObjectId: line.source.ref || line.glKey,
      type: isInflow ? 'INFLOW' : 'OUTFLOW',
      category: isInflow
        ? (line.source.kind === 'factura' ? 'AR_COLLECTION' : 'TRANSFER')
        : auxiliarTaxClassification?.category === 'TAX'
          ? 'TAX'
          : (line.source.kind === 'pago' || line.source.kind === 'factura'
            ? 'AP_PAYMENT'
            : 'TRANSFER'),
      subcategory: isInflow ? inflowSubcategory : auxiliarTaxClassification?.subcategory,
      companyId: line.cia,
      bankAccountId: line.cuentaBanco,
      counterpartyId: undefined,
      counterpartyName: auxiliarTaxClassification?.category === 'TAX'
        ? auxiliarTaxClassification.counterpartyName
        : counterpartyName,
      counterpartyType: isInflow
        ? 'CUSTOMER'
        : auxiliarTaxClassification?.category === 'TAX'
          ? 'TAX_AUTHORITY'
          : 'SUPPLIER',
      concept: `${line.tipoDoctoDesc || line.tipoDocto || 'GL'} ${line.source.ref || ''} · ${counterpartyName}`.trim(),
      currency: line.moneda || 'MXN',
      originalAmount: monto,
      baseAmount: monto,
      projectedAmount: monto,
      actualDate: fecha,
      projectedDate: fecha,
      confidenceScore: 100,
      confidenceBand: calculateConfidenceBand(100),
      forecastMethod: 'RULE',
      ruleApplied: 'AuxiliarContable JDE (libro mayor)',
      status: 'REAL',
      lockState: 'LOCKED',
      comments: ['Dato real del libro mayor JDE. Banco no cargado para este mes — fuente: AuxiliarContable.'],
      createdAt: `${fecha}T00:00:00.000Z`,
      updatedAt: `${fecha}T00:00:00.000Z`,
    });
  }

  return out;
}
