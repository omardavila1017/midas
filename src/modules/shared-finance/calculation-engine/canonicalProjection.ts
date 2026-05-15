// ─────────────────────────────────────────────────────────────────────────
// canonicalProjection — bridge entre el motor canónico del Dashboard
// (`computeBaseCashFlow`) y el modelo de movimientos que consumen
// Proyección Financiera y Planeación Financiera.
//
// Reglas del módulo:
//
//   1. La trayectoria de caja MENSUAL coincide byte-a-byte con la del
//      Dashboard. Para cada mes futuro tomamos el total canónico de
//      ingreso/egreso y lo distribuimos sobre catálogos reales:
//        - Inflows  → `projectClientMonth` por cada cliente con eventos
//          fechados en ese mes (respeta payment-day, créditos, factoraje).
//        - Outflows → CXP con `fechaProgramacionPago` real, costos de
//          nómina/compras, y patrones recurrentes de proveedores cuando
//          faltan CXP.
//
//   2. Cada movimiento informativo guarda su monto crudo en `baseAmount`
//      y el monto escalado al canónico en `projectedAmount`. La suma de
//      `projectedAmount` por mes empata con el Dashboard.
//
//   3. NUNCA caemos a mock data. Si los catálogos no producen líneas
//      para un mes, se emite UN movement sintético de resto operativo
//      con la fecha del día medio del mes — pero esto es el último
//      recurso, no la regla.
//
// Bug previo arreglado por este archivo:
//   - Antes la cobranza y los egresos futuros caían en una sola línea
//     genérica "Cobranza proyectada YYYY-MM" en el día 15 del mes,
//     porque el código solo emitía catálogo para el mes en curso. Ahora
//     itera todos los meses futuros del horizonte y usa el catálogo
//     real, lo que da granularidad útil para vistas semanales/diarias.
// ─────────────────────────────────────────────────────────────────────────

import { computeBaseCashFlow } from '../../../domain/dashboardEngine';
import type { ComputeInputs } from '../../../domain/dashboardEngine';
import type { BuildPredictiveResult } from '../../../domain/predictive';
import { compareYearMonth, toYearMonth } from '../../../domain/cashFlowEngine';
import { projectClientMonth } from '../../../domain/collectionEngine';
import { isNonOperatingDay } from '../../../domain/bankHolidays';
import type { ExpenseProjectionBreakdown } from '../../../domain/projectionEngine';
import {
  buildClientLookup,
  clientRuleLabel,
  findClientForCobranza,
  resolveCobranzaApiPaymentDate,
  resolveCobranzaRuleDate,
  type CollectionCalendarClientMatch,
} from '../../../domain/collectionCalendarEngine';
import {
  buildOwnAccountDetector,
  buildOwnAccountsIndex,
  buildPairMatchedKeys,
  classifyMovement,
} from '../../../domain/netCashFlowEngine';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import { getConcursoProviderIds, isConcursoMercantil, normalizeProviderId } from '../../../domain/concursoMercantil';
import type { Client, Provider, CashFlowAssumptions } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import type { CobranzaRecord } from '../../../services/jdeTypes';
import {
  bankMovementKey,
  type AbonoEnrichment,
  type RealReconciliationResult,
} from '../../../domain/realReconciliationEngine';
import { enrichFromCatalog } from '../../../domain/providerCatalog';
import { classifyBankConcept } from '../../../domain/bankConceptClassifier';
import { enrichMovementWithCatalog } from '../../../domain/bankAccountsCatalog';
import { calculateConfidenceBand } from './financialProjectionEngine';
import type {
  FinancialMovement,
  FinancialMovementCategory,
  FinancialTaxRate,
  PayrollCostRecord,
  PurchaseReceiptRecord,
} from '../types';
import {
  buildPayrollCostMovements,
  buildPurchaseReceiptMovements,
} from '../sourceRecords';

const DAY_MS = 86_400_000;

export interface CanonicalProjectionInputs {
  companyCode: string;
  bankStatements: BankAccountStatement[];
  clients: Client[];
  providers: Provider[];
  cxpRecords: CXPRecord[];
  cobranzaRecords?: CobranzaRecord[];
  purchaseReceipts?: PurchaseReceiptRecord[];
  payrollCosts?: PayrollCostRecord[];
  /**
   * Resultado del cruce JDE ↔ banco. Cuando se pasa, las facturas con
   * `match.status === 'cobrada-banco'` no se vuelven a proyectar como
   * cobro pendiente — el dinero ya está en los movimientos bancarios
   * históricos. Sin esto la suma anual queda doblada.
   */
  cobranzaReconciliation?: RealReconciliationResult;
  /**
   * Set de `${cia}::${noFactura}::${noProveedor}` de CXPs marcadas PAID por
   * PagoProveedor. Espejo egreso de cobranzaReconciliation: estas facturas
   * NO se proyectan como egreso futuro — el cargo bancario real ya
   * descontó el dinero. Si está PARTIAL, se proyecta el residuo.
   */
  paidCxpKeys?: Set<string>;
  /**
   * Mapa `bankMovementKey(line)` → enriquecimiento PagoProveedor. Cuando un
   * CARGO histórico empata con un pago a proveedor, se reclasifica como
   * AP_PAYMENT con el nombre del proveedor — en vez de caer al cubo
   * genérico "Otros Egresos". Mismo patrón que `abonoEnrichments` para
   * cobranza (ingresos).
   */
  cargoEnrichments?: Map<string, { status: 'MATCHED' | 'ORPHAN'; payments?: Array<{ nombreProveedor: string; importe: number }> }>;
  assumptions: CashFlowAssumptions;
  budget: Budget | null;
  startingBalance: number;
  asOfDate: string;
  /**
   * Si false, salta el motor predictivo (Holt-Winters tiered + extracción de
   * series). Default true para no romper Dashboard/Proyección. Planning lo
   * pasa false porque sólo consume `monthly`/`movements`, no `predictive`.
   * Saltarlo recorta varios cientos de ms en mounts cold de Planning.
   */
  enablePredictive?: boolean;
}

export interface CanonicalMonthlyPoint {
  yearMonth: string;
  isHistorical: boolean;
  income: number;
  expense: number;
  closingCash: number;
}

export interface CanonicalProjectionResult {
  monthly: CanonicalMonthlyPoint[];
  movements: FinancialMovement[];
  initialCash: number;
  fromYearMonth: string;
  toYearMonth: string;
  /**
   * Resultado del motor predictivo (Holt-Winters tiered) con bandas de
   * confianza a 4 granularidades (daily/weekly/monthly/annual) más
   * overlays informativos de OCs y CXC. Null si no se entrenó (ej. sin
   * datos suficientes).
   *
   * Esto es lo que Planeación Financiera (Base + Approved), Proyección
   * Financiera y Dashboard deben leer para mostrar bandas y horizonte.
   * Los `monthly[]` siguen siendo la trayectoria puntual byte-a-byte
   * con el Dashboard; `predictive` es la capa de incertidumbre encima.
   */
  predictive: BuildPredictiveResult | null;
}

export function buildCanonicalProjection(
  inputs: CanonicalProjectionInputs,
): CanonicalProjectionResult {
  const computeInputs: ComputeInputs = {
    bankStatements: inputs.bankStatements,
    aged: [],
    clients: inputs.clients,
    providers: inputs.providers,
    cxpRecords: inputs.cxpRecords,
    assumptions: inputs.assumptions,
    companyCode: inputs.companyCode,
    today: inputs.asOfDate,
    overrides: loadCanonicalOverrides(),
    budget: inputs.budget,
    startingBalance: inputs.startingBalance,
    purchaseReceipts: inputs.purchaseReceipts,
    cobranzaRecords: inputs.cobranzaRecords,
    enablePredictive: inputs.enablePredictive !== false,
  };
  const { base, projection, predictive } = computeBaseCashFlow(computeInputs);
  const projectionByYm = new Map(projection.months.map((month) => [month.yearMonth, month]));

  const monthly: CanonicalMonthlyPoint[] = base.map((m) => ({
    yearMonth: m.yearMonth,
    isHistorical: m.isHistorical,
    income: m.income,
    expense: m.expense,
    closingCash: m.closingCash,
  }));

  const movements = buildMovements({ monthly, inputs, projectionByYm });

  const initialCash = base.length > 0
    ? base[0].closingCash - base[0].income + base[0].expense
    : inputs.startingBalance;

  return {
    monthly,
    movements,
    initialCash,
    fromYearMonth: monthly[0]?.yearMonth ?? toYearMonth(inputs.asOfDate),
    toYearMonth: monthly[monthly.length - 1]?.yearMonth ?? toYearMonth(inputs.asOfDate),
    predictive,
  };
}

function loadCanonicalOverrides() {
  try {
    const raw = localStorage.getItem('midas.dashboard.projectionOverrides.v1');
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

interface BuildArgs {
  monthly: CanonicalMonthlyPoint[];
  inputs: CanonicalProjectionInputs;
  projectionByYm: Map<string, ReturnType<typeof computeBaseCashFlow>['projection']['months'][number]>;
}

// Grupos de filas para INFLOW en la tabla de Planeación. El usuario pidió
// 3 cubos: clientes etiquetados Viajes Especiales en el catálogo, el bucket
// "Federal" (lo que cae en cuentas Santander sin match a factura), y el resto.
const INCOME_SUBCAT_VIAJES = 'Viajes Especiales';
const INCOME_SUBCAT_FEDERAL = 'Federal';
const INCOME_SUBCAT_OTROS = 'Otros ingresos';
const CLIENT_VIAJES_ESPECIALES_GROUP_ID = 'group-viajes-especiales';

function resolveInflowSubcategory(args: {
  counterpartyId?: string;
  clientById: Map<string, Client>;
  bankFallbackLabel?: string;
}): string {
  if (args.counterpartyId) {
    const client = args.clientById.get(args.counterpartyId);
    if (client?.commercialGroupId === CLIENT_VIAJES_ESPECIALES_GROUP_ID) {
      return INCOME_SUBCAT_VIAJES;
    }
  }
  // Sin client match — usar bank label si es Santander como "Federal",
  // resto cae en "Otros ingresos".
  if (args.bankFallbackLabel && args.bankFallbackLabel.toUpperCase().includes('FEDERAL')) {
    return INCOME_SUBCAT_FEDERAL;
  }
  return INCOME_SUBCAT_OTROS;
}

function buildMovements({ monthly, inputs, projectionByYm }: BuildArgs): FinancialMovement[] {
  const out: FinancialMovement[] = [];
  const todayYm = toYearMonth(inputs.asOfDate);
  const monthlyByYm = new Map(monthly.map((m) => [m.yearMonth, m]));
  const inflowContext = buildInflowContext(inputs);
  const clientById = new Map(inputs.clients.map((c) => [c.id, c]));

  // Mismo contexto de clasificación que `buildHistoricalMonths` del
  // Dashboard. Sin esto los traspasos internos (TRASPASO REF, RFCs del
  // grupo, pares CARGO/ABONO simétricos) se emitían como FinancialMovement
  // y la suma de movements[] no empataba con monthly[] — la gráfica de
  // Caja proyectada inflaba ingresos y egresos por igual.
  const ownAccountDetector = buildOwnAccountDetector(
    buildOwnAccountsIndex(inputs.bankStatements),
  );
  const pairedKeys = buildPairMatchedKeys(inputs.bankStatements);

  // Proveedores en Concurso Mercantil: cualquier proveedor con AL MENOS una
  // factura ≤ CONCURSO_MERCANTIL_CUTOFF (deuda congelada). Sus pagos viven
  // en el módulo Concurso; aquí se excluyen del modelo predictivo para que
  // su deuda fresca no entre dos veces al flujo. Set indexado por noProveedor
  // (trim + upper) — la misma normalización que usa `normalizeProviderId`.
  const concursoProviderIds = getConcursoProviderIds(inputs.cxpRecords);

  // Mapa movementKey → AbonoEnrichment. Permite reclasificar un ABONO
  // histórico como cobranza por cliente cuando el cruce contra cobranza JDE
  // detectó qué factura(s) cubrió. Sin esto los ingresos pasados quedaban
  // todos bajo "Transferencias" en Planeación, ocultando el ingreso por
  // cliente en meses pasados.
  const abonoEnrichmentByKey = new Map<string, AbonoEnrichment>();
  for (const enrichment of inputs.cobranzaReconciliation?.abonoEnrichments ?? []) {
    abonoEnrichmentByKey.set(enrichment.movementKey, enrichment);
  }
  const cargoEnrichmentByKey = inputs.cargoEnrichments ?? new Map();

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
      ) continue;
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
      if (catalogEnrich && catalogEnrich.entry.flow === 'neutro') continue;
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
      // ABONOs sin match a factura → agrupar por banco origen para que la
      // tabla de Planeación no muestre cientos de filas únicas por concepto
      // bancario. Santander recibe etiqueta "Federal — Santander" según
      // convención de negocio del user (todo lo que cae en Santander es
      // ingreso federal). Otros bancos llevan su nombre legible.
      const bankLabel = (statement.banco || statement.nombreBanco || 'Banco').toUpperCase();
      const bankFallbackName = bankLabel === 'SANTANDER'
        ? 'Federal — Santander'
        : (statement.nombreBanco || statement.banco || 'Banco');
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
      const counterpartyName = isCobranzaInflow
        ? (enrichment!.catalogClientName ?? firstFactura?.nombreCliente ?? undefined)
        : isMatchedAp
          ? matchedPayment!.nombreProveedor || undefined
          : isInflow
            ? bankFallbackName
            : unmatchedCargoClassification!.counterpartyName;
      const counterpartyId = isCobranzaInflow
        ? (enrichment!.catalogClientId ?? firstFactura?.noCliente ?? undefined)
        : undefined;
      const inflowSubcategory = isInflow
        ? resolveInflowSubcategory({
            counterpartyId,
            clientById,
            bankFallbackLabel: !isCobranzaInflow ? bankFallbackName : undefined,
          })
        : undefined;
      const cargoCategory = unmatchedCargoClassification?.category ?? 'TRANSFER';
      // Si el clasificador de concepto bancario no produce subcategoría,
      // pero la cuenta vive en el catálogo, usamos el subRole/role del
      // catálogo (`nomina_operadores`, `dotacion_efectivo`, `dolares`,
      // `proveedores_nomina`, …). Esto evita cientos de CARGOs etiquetados
      // como genérico "Otros Egresos" cuando el banco solo manda folios
      // numéricos pero el destino de la cuenta es claro.
      const cargoSubcategory = unmatchedCargoClassification?.subcategory
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
        companyId: statement.cia,
        businessUnitId: catalogEnrich?.entry.unidadNegocio,
        bankAccountId: statement.cuenta,
        counterpartyId,
        counterpartyName,
        counterpartyType: isCobranzaInflow
          ? 'CUSTOMER'
          : isMatchedAp
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
        ruleApplied: 'Estado de cuenta bancario',
        status: 'REAL',
        lockState: 'LOCKED',
        comments: ['Dato real del banco. No editable desde Planeación.'],
        createdAt: `${line.fechaOperacion}T00:00:00.000Z`,
        updatedAt: `${line.fechaOperacion}T00:00:00.000Z`,
      });
    }
  }

  // 1b) Histórico desde cobranza JDE. Cuando el banco no cubre meses
  //     pasados (estados de cuenta no cargados, periodo fuera de
  //     ventana), las facturas con `fechaCobro` real igual seguían sin
  //     aparecer por cliente en Planeación. Aquí emitimos un
  //     AR_COLLECTION sintético por factura cobrada cuya fecha cae en
  //     un mes histórico y NO fue ya cruzada con un ABONO bancario en
  //     el paso 1 (evita doble conteo).
  const cobradaBancoKeysHistoric = buildCobradaBancoKeySet(inputs.cobranzaReconciliation);
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
      subcategory: resolveInflowSubcategory({ counterpartyId, clientById }),
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

  // 2) Para cada mes futuro: distribuimos los totales canónicos sobre
  //    catálogos reales (`projectClientMonth` para inflows, CXP/JDE,
  //    compras, nómina y proveedores recurrentes para outflows). El escalamiento garantiza que la
  //    suma de `projectedAmount` empate con el total canónico.
  const futureMonths = monthly.filter((m) => !m.isHistorical);
  const horizonYm = monthly[monthly.length - 1]?.yearMonth;
  // Hoist purchase-receipt build OUT of the per-month loop. It does
  // O(receipts × cxp) dedup work and is identical for every month. Running
  // it 12+ times per render was the main thread hog that hung the
  // Planeación / Proyección tabs once PROJECTED OCs multiplied the
  // receipt count (~5000+).
  const purchaseMovementsByYm = groupMovementsByYearMonth(buildPurchaseReceiptMovements({
    purchaseReceipts: inputs.purchaseReceipts ?? [],
    cxpRecords: inputs.cxpRecords,
    companyCode: inputs.companyCode,
    asOfDate: inputs.asOfDate,
    excludeProviderIds: concursoProviderIds,
  }));
  for (const month of futureMonths) {
    const inflowLines = collectInflowLines(month, inputs, todayYm, inflowContext);
    const hasCxcFromJde = inflowLines.some((line) => line.id.startsWith('cxc:'));
    out.push(...(hasCxcFromJde
      ? emitRawLines(inflowLines, 'INFLOW', inputs.asOfDate)
      : balanceInflowMonth({
        lines: inflowLines,
        target: month.income,
        ym: month.yearMonth,
        asOfDate: inputs.asOfDate,
        fallbackCategory: 'AR_COLLECTION',
        fallbackConcept: `Cobranza proyectada ${month.yearMonth}`,
        fallbackRule: 'Total proyectado mensual (Dashboard)',
      })));

    const outflowLines = collectOutflowLines(month, inputs, todayYm, projectionByYm.get(month.yearMonth)?.expense, horizonYm, purchaseMovementsByYm.get(month.yearMonth) ?? [], concursoProviderIds);
    out.push(...balanceOutflowMonth({
      lines: outflowLines,
      target: month.expense,
      ym: month.yearMonth,
      asOfDate: inputs.asOfDate,
      fallbackCategory: 'OPEX',
      fallbackConcept: `Egresos recurrentes operativos ${month.yearMonth}`,
      fallbackRule: 'Total proyectado mensual (Dashboard)',
    }));
  }

  // 3) Mes en curso (histórico parcial). Días pasados ya están como
  //    REAL desde el banco. El resto del mes no se rellena con plantillas;
  //    sólo se conserva lo que venga de fuentes operativas explícitas.
  const currentYm = todayYm;
  const currentHistorical = monthly.find((m) => m.isHistorical && m.yearMonth === currentYm);
  if (currentHistorical) {
    const remainingIncome = 0;
    const remainingExpense = 0;

    const inflowLines = collectInflowLines(currentHistorical, inputs, todayYm, inflowContext)
      .filter((line) => line.date >= inputs.asOfDate);
    if (remainingIncome > 0) {
      out.push(...balanceInflowMonth({
        lines: inflowLines,
        target: remainingIncome,
        ym: currentYm,
        asOfDate: inputs.asOfDate,
        fallbackCategory: 'AR_COLLECTION',
        fallbackConcept: `Cobranza proyectada ${currentYm} (resto del mes)`,
        fallbackRule: 'Proyección operativa del mes en curso menos cobranza real',
      }));
    } else {
      out.push(...emitRawLines(inflowLines, 'INFLOW', inputs.asOfDate));
    }

    const outflowLines = collectOutflowLines(currentHistorical, inputs, todayYm, projectionByYm.get(currentYm)?.expense, horizonYm, purchaseMovementsByYm.get(currentYm) ?? [])
      .filter((line) => line.date >= inputs.asOfDate);
    if (remainingExpense > 0) {
      out.push(...balanceMonth({
        lines: outflowLines,
        target: remainingExpense,
        ym: currentYm,
        type: 'OUTFLOW',
        asOfDate: inputs.asOfDate,
        fallbackCategory: 'OPEX',
        fallbackConcept: `Egresos proyectados ${currentYm} (resto del mes)`,
        fallbackRule: 'Proyección operativa del mes en curso menos egresos reales',
      }));
    } else {
      out.push(...emitRawLines(outflowLines, 'OUTFLOW', inputs.asOfDate));
    }
  }

  return out;
}

function groupMovementsByYearMonth(movements: FinancialMovement[]): Map<string, FinancialMovement[]> {
  const out = new Map<string, FinancialMovement[]>();
  for (const m of movements) {
    const ym = m.projectedDate.slice(0, 7);
    const arr = out.get(ym);
    if (arr) arr.push(m);
    else out.set(ym, [m]);
  }
  return out;
}

/**
 * Convierte `RawLine[]` directamente a `FinancialMovement[]` sin
 * escalar contra un total canónico. Se usa para el mes en curso, donde
 * los días pasados ya están cubiertos por movimientos REAL del banco
 * y los días futuros son proyecciones genuinas que no deben "balancear"
 * a nada — sólo sumarse.
 */
function emitRawLines(
  lines: RawLine[],
  type: FinancialMovement['type'],
  asOfDate: string,
): FinancialMovement[] {
  return lines.map((line) => ({
    id: line.id,
    sourceSystem: line.sourceSystem,
    sourceObjectId: line.sourceObjectId,
    type,
    category: line.category,
    subcategory: line.subcategory,
    companyId: line.companyId,
    counterpartyId: line.counterpartyId,
    counterpartyName: line.counterpartyName,
    counterpartyType: line.counterpartyType,
    providerCategory: line.providerCategory,
    concept: line.concept,
    currency: 'MXN',
    originalAmount: line.amount,
    baseAmount: line.amount,
    projectedAmount: line.amount,
    issueDate: line.issueDate,
    dueDate: line.dueDate,
    projectedDate: line.date,
    confidenceScore: line.confidenceScore,
    confidenceBand: calculateConfidenceBand(line.confidenceScore),
    forecastMethod: line.forecastMethod,
    ruleApplied: line.ruleApplied,
    taxTreatment: line.taxTreatment,
    taxRate: line.taxRate,
    ...scaleTaxMeta(line, line.amount),
    status: 'PROJECTED_BASE',
    lockState: line.lockState,
    comments: [line.comment],
    createdAt: `${asOfDate}T00:00:00.000Z`,
    updatedAt: `${asOfDate}T00:00:00.000Z`,
  }));
}

interface RawLine {
  id: string;
  amount: number;
  date: string;
  concept: string;
  category: FinancialMovementCategory;
  subcategory?: string;
  providerCategory?: string;
  counterpartyId?: string;
  counterpartyName?: string;
  counterpartyType?: FinancialMovement['counterpartyType'];
  ruleApplied: string;
  sourceSystem: FinancialMovement['sourceSystem'];
  sourceObjectId?: string;
  companyId?: string;
  issueDate?: string;
  dueDate?: string;
  forecastMethod: FinancialMovement['forecastMethod'];
  confidenceScore: number;
  lockState: FinancialMovement['lockState'];
  comment: string;
  taxTreatment?: FinancialMovement['taxTreatment'];
  taxRate?: FinancialTaxRate;
  taxBaseAmount?: number;
  taxAmount?: number;
  amountLocked?: boolean;
}

interface InflowContext {
  cxcRecords: CobranzaRecord[];
  cxcCoverageByClientMonth: Map<string, Set<string>>;
  clientMatchByFactura: Map<string, CollectionCalendarClientMatch | null>;
}

function buildInflowContext(inputs: CanonicalProjectionInputs): InflowContext {
  const clientLookup = buildClientLookup(inputs.clients);
  const cxcRecords = filterCobranzaByCompany(inputs.cobranzaRecords ?? [], inputs.companyCode);
  const cxcCoverageByClientMonth = new Map<string, Set<string>>();
  const clientMatchByFactura = new Map<string, CollectionCalendarClientMatch | null>();

  for (const record of cxcRecords) {
    const match = findClientForCobranza(record, clientLookup);
    clientMatchByFactura.set(cxcFacturaKey(record), match);
    if (match && record.fechaFactura) {
      addCoveredMonth(cxcCoverageByClientMonth, match.client.id, record.fechaFactura.slice(0, 7));
    }
  }

  return {
    cxcRecords,
    cxcCoverageByClientMonth,
    clientMatchByFactura,
  };
}

/**
 * Inflows: primero mete facturas CXC abiertas de JDE a valor nominal y
 * luego completa el resto del mes con `projectClientMonth` para clientes.
 * Cada evento tiene fecha real que respeta:
 *   - frecuencia (semanal, quincenal, mensual, contado)
 *   - días de crédito del cliente
 *   - patrón de pago (DOM, DOW, etc.) o factoraje
 *
 * Las facturas CXC emitidas bloquean su monto y cubren el ciclo del cliente
 * para no duplicar la misma venta como forecast genérico.
 * Esto produce muchos puntos en distintos días → la vista semanal/diaria
 * se ve poblada en lugar de un solo bloque a mediados de mes.
 */
function collectInflowLines(
  month: CanonicalMonthlyPoint,
  inputs: CanonicalProjectionInputs,
  _todayYm: string,
  context: InflowContext,
): RawLine[] {
  const [year, mNum] = month.yearMonth.split('-').map(Number);
  const targetMonthIdx = mNum - 1;
  const lines: RawLine[] = collectCxcInflowLines(month, inputs, context);

  // Necesitamos buscar un poco hacia atrás: facturas emitidas el mes
  // anterior pueden cobrarse en el mes objetivo (créditos cortos).
  // Iteramos el mes objetivo y los 2 meses previos.
  const monthsToScan: Array<{ year: number; monthIdx: number }> = [
    { year, monthIdx: targetMonthIdx - 2 },
    { year, monthIdx: targetMonthIdx - 1 },
    { year, monthIdx: targetMonthIdx },
  ].map(({ year: y, monthIdx }) => {
    if (monthIdx < 0) return { year: y - 1, monthIdx: monthIdx + 12 };
    if (monthIdx > 11) return { year: y + 1, monthIdx: monthIdx - 12 };
    return { year: y, monthIdx };
  });

  for (const client of inputs.clients) {
    const coveredMonths = context.cxcCoverageByClientMonth.get(client.id);
    let evIdx = 0;
    for (const scan of monthsToScan) {
      const invoiceYm = `${scan.year}-${String(scan.monthIdx + 1).padStart(2, '0')}`;
      if (coveredMonths?.has(invoiceYm)) continue;
      const events = projectClientMonth(client, scan.year, scan.monthIdx, {
        ...inputs.assumptions,
        year: scan.year,
      });
      const clientInflowSubcat = client.commercialGroupId === CLIENT_VIAJES_ESPECIALES_GROUP_ID
        ? INCOME_SUBCAT_VIAJES
        : INCOME_SUBCAT_OTROS;
      for (const event of events) {
        const ym = event.realDate.slice(0, 7);
        if (ym !== month.yearMonth) continue;
        if (event.amount <= 0) continue;
        const compliance = client.complianceRate ?? inputs.assumptions.globalCompliance ?? 1;
        const score = Math.round(55 + Math.min(40, compliance * 40));
        const taxRate = client.ivaRate ?? 16;
        lines.push({
          id: `client:${client.id}:${event.realDate}:${evIdx++}`,
          amount: event.amount,
          date: event.realDate,
          concept: `Cobranza ${client.name}`,
          category: 'AR_COLLECTION',
          subcategory: clientInflowSubcat,
          counterpartyId: client.id,
          counterpartyName: client.name,
          counterpartyType: 'CUSTOMER',
          ruleApplied: paymentPatternLabel(client),
          sourceSystem: 'FORECAST',
          sourceObjectId: client.id,
          forecastMethod: 'RULE',
          confidenceScore: score,
          lockState: 'UNLOCKED',
          taxTreatment: 'IVA_CAUSED',
          taxRate,
          taxBaseAmount: event.amount,
          taxAmount: event.amount * (taxRate / 100),
          comment: `Evento proyectado por collectionEngine. Lag teórico ${event.lagDays} días.`,
        });
      }
    }
  }

  return lines;
}

function collectCxcInflowLines(
  month: CanonicalMonthlyPoint,
  inputs: CanonicalProjectionInputs,
  context: InflowContext,
): RawLine[] {
  if (context.cxcRecords.length === 0) return [];
  const lines: RawLine[] = [];
  const seen = new Set<string>();
  // Facturas que el reconciliation engine ya cruzó al céntimo con un
  // ABONO bancario: el dinero ya está en los movimientos históricos del
  // banco. Si las re-proyectamos, queda doblada. Sólo las descartamos
  // cuando el cruce fue automático (status='cobrada-banco'); facturas en
  // revisión manual o sin cruce siguen como pendiente proyectada.
  const cobradaBancoKeys = buildCobradaBancoKeySet(inputs.cobranzaReconciliation);

  for (const record of context.cxcRecords) {
    if (record.importePendientePesos <= 0) continue;
    const key = cxcFacturaKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    if (cobradaBancoKeys.has(key)) continue;

    const clientMatch = context.clientMatchByFactura.get(key) ?? null;
    const resolved = clientMatch
      ? resolveCobranzaRuleDate(record, clientMatch.client, inputs.assumptions)
      : resolveCobranzaApiPaymentDate(record);
    const rawDate = resolved?.calendarDate
      ?? cleanDate(record.fechaVence)
      ?? cleanDate(record.fechaFactura)
      ?? inputs.asOfDate;
    const dateInfo = moveOpenReceivableIntoProjection(rawDate, inputs.asOfDate);
    if (dateInfo.date.slice(0, 7) !== month.yearMonth) continue;

    const taxMeta = cxcTaxMeta(record, clientMatch?.client);
    const confidenceScore = clientMatch
      ? Math.round(Math.min(92, 72 + clientMatch.confidence * 18))
      : 62;
    const dateReason = resolved
      ? resolved.reason
      : record.fechaVence
        ? 'Sin regla confiable; se usa vencimiento JDE.'
        : 'Sin regla confiable; se usa fecha de factura JDE.';

    const cxcSubcat = clientMatch?.client.commercialGroupId === CLIENT_VIAJES_ESPECIALES_GROUP_ID
      ? INCOME_SUBCAT_VIAJES
      : INCOME_SUBCAT_OTROS;
    lines.push({
      id: `cxc:${record.cia}:${record.noCliente}:${record.noFactura}`,
      amount: record.importePendientePesos,
      date: dateInfo.date,
      concept: `Factura CXC ${record.noFactura || 'sin folio'} · ${record.nombreCliente || 'Cliente sin nombre'}`,
      category: 'AR_COLLECTION',
      subcategory: cxcSubcat,
      companyId: record.cia,
      counterpartyId: clientMatch?.client.id ?? record.noCliente,
      counterpartyName: record.nombreCliente || clientMatch?.client.name,
      counterpartyType: 'CUSTOMER',
      ruleApplied: clientMatch
        ? clientRuleLabel(clientMatch.client)
        : record.nombreDiaPagoCc13 || record.claveDiaPagoCc13
          ? 'Día de pago CC13 /cobranza'
          : 'Fecha vencimiento JDE',
      sourceSystem: 'JDE',
      sourceObjectId: record.noFactura,
      issueDate: cleanDate(record.fechaFactura),
      dueDate: cleanDate(record.fechaVence),
      forecastMethod: 'RULE',
      confidenceScore,
      lockState: 'RESTRICTED',
      taxTreatment: 'IVA_CAUSED',
      taxRate: taxMeta.taxRate,
      taxBaseAmount: taxMeta.taxBaseAmount,
      taxAmount: taxMeta.taxAmount,
      comment: [
        'Factura CXC abierta en JDE; se proyecta sólo el saldo pendiente.',
        dateReason,
        dateInfo.moved ? 'La fecha esperada ya venció; se agenda al siguiente día operativo de la proyección.' : '',
      ].filter(Boolean).join(' '),
      amountLocked: true,
    });
  }

  return lines;
}

/**
 * Outflows: combina CXP (con fechas reales de programación de pago),
 * compras, nómina y proveedores recurrentes. Cuando no hay ninguna fuente,
 * `balanceMonth` cae al sintético.
 */
function collectOutflowLines(
  month: CanonicalMonthlyPoint,
  inputs: CanonicalProjectionInputs,
  todayYm: string,
  expenseProjection?: ExpenseProjectionBreakdown,
  projectThroughYearMonth?: string,
  /**
   * Movimientos de compras (PurchaseReceipt) ya filtrados para `month.yearMonth`.
   * Se inyectan desde `buildMovements` para evitar recomputar el dedup CXP
   * por cada mes (era O(receipts × cxp × meses) → ahora una sola vez).
   */
  purchaseMovementsForMonth: FinancialMovement[] = [],
  /**
   * Set de `noProveedor` (trim + upper) de proveedores en Concurso Mercantil.
   * Esos proveedores tienen al menos una factura ≤ CONCURSO_MERCANTIL_CUTOFF
   * y se excluyen de TODAS las proyecciones futuras (CXP nueva, recurrentes,
   * compras). Sus pagos pertenecen al módulo Concurso.
   */
  concursoProviderIds: Set<string> = new Set(),
): RawLine[] {
  const lines: RawLine[] = [];
  const providerByName = new Map(inputs.providers.map((p) => [supplierLookupKey(p.name), p]));
  const providerByJde = new Map<string, Provider>();
  // Lookup catalog provider id → noProveedor (trim + upper) para validar
  // recurring providers contra el set de concurso, que indexa por noProveedor.
  const providerJdeByCatalogId = new Map<string, string>();
  for (const provider of inputs.providers) {
    const jdeKey = providerJdeKey(provider.numProveedorJDE);
    if (jdeKey) providerByJde.set(jdeKey, provider);
    const noProv = normalizeProviderId(provider.numProveedorJDE);
    if (noProv) providerJdeByCatalogId.set(provider.id, noProv);
  }
  const filteredCxp = inputs.companyCode === 'all' || !inputs.companyCode
    ? inputs.cxpRecords
    : inputs.cxpRecords.filter((r) => r.cia === inputs.companyCode);

  // 1) CXP abierta de JDE. Si ya venció, se trae al día operativo actual
  // para que el scheduler decida si se paga hoy, se recorre o queda pendiente.
  filteredCxp.forEach((record, index) => {
    if (record.importePendientePesos <= 0) return;
    // Concurso Mercantil: facturas con `fechaFactura` ≤ 2022-12-31 son deuda
    // congelada que vive en su propio módulo. No se proyecta como egreso —
    // el flujo no se ve afectado por estos saldos.
    if (isConcursoMercantil(record)) return;
    // Y además: cualquier factura nueva de un proveedor que ya tenga deuda en
    // Concurso también se excluye. Sus pagos están bloqueados a nivel legal
    // y se manejan dentro del módulo Concurso, no en el modelo predictivo.
    if (concursoProviderIds.has(normalizeProviderId(record.noProveedor))) return;
    // PagoProveedor: si la CXP ya fue pagada (match en PagoProveedor),
    // omítela del egreso proyectado. El cargo bancario real ya cubrió el
    // movimiento. Si está parcial NO se omite — se proyecta el residuo.
    if (inputs.paidCxpKeys?.has(`${record.cia}::${record.noFactura}::${record.noProveedor}`)) return;
    const scheduledDate = cleanDate(record.fechaProgramacionPago)
      ?? cleanDate(record.fechaVence)
      ?? cleanDate(record.fechaFactura)
      ?? inputs.asOfDate;
    const dueDate = cleanDate(record.fechaVence);
    const rawDate = dueDate && scheduledDate < dueDate ? dueDate : scheduledDate;
    const dateInfo = moveOpenPayableIntoProjection(rawDate, inputs.asOfDate);
    if (dateInfo.date.slice(0, 7) !== month.yearMonth) return;
    if (compareYearMonth(dateInfo.date.slice(0, 7), todayYm) < 0) return;
    const provider = (record.noProveedor ? providerByJde.get(providerJdeKey(record.noProveedor)) : undefined)
      ?? providerByName.get(supplierLookupKey(record.nombre));
    const catalog = enrichFromCatalog({
      supplier: record.nombre,
      classification: record.clasificacionProveedor || record.clasifica,
    });
    const providerType = provider?.type
      || catalog.providerType
      || record.clasificacionProveedor
      || record.clasifica
      || 'Sin clasificar';
    const score = provider?.score != null
      ? Math.max(0, Math.min(100, Math.round(provider.score)))
      : (record.edoPago ?? '').toUpperCase().includes('APROB')
        ? 90
        : 76;
    const taxBreakdown = taxBreakdownFromCxp(record);
    lines.push({
      id: `cxp:${record.cia}:${record.noProveedor}:${record.noFactura}:${index}`,
      amount: record.importePendientePesos,
      date: dateInfo.date,
      concept: `Factura ${record.noFactura || 'sin folio'} · ${record.nombre}`,
      category: 'AP_PAYMENT',
      subcategory: providerType,
      providerCategory: providerType,
      counterpartyId: provider?.id ?? record.noProveedor,
      counterpartyName: record.nombre,
      counterpartyType: 'SUPPLIER',
      ruleApplied: provider?.flexibility ? `Proveedor ${provider.flexibility}` : 'Fecha programada JDE',
      sourceSystem: 'JDE',
      sourceObjectId: record.noFactura,
      companyId: record.cia,
      issueDate: cleanDate(record.fechaFactura),
      dueDate: cleanDate(record.fechaVence),
      forecastMethod: 'RULE',
      confidenceScore: score,
      lockState: provider?.flexibility === 'inamovible' ? 'LOCKED' : 'RESTRICTED',
      taxTreatment: taxBreakdown.taxRate ? 'IVA_CREDITABLE' : 'UNCLASSIFIED',
      taxRate: taxBreakdown.taxRate,
      taxBaseAmount: taxBreakdown.taxBaseAmount,
      taxAmount: taxBreakdown.taxAmount,
      comment: [
        'Factura abierta en JDE.',
        dateInfo.moved ? `Fecha original ${rawDate}; se agenda desde ${dateInfo.date} para decisión diaria.` : '',
      ].filter(Boolean).join(' '),
      amountLocked: true,
    });
  });

  // 2) Compras activas sin CXP matcheada. Son compromisos tempranos:
  // se emiten como locked para no perderlos al balancear el mes.
  // `purchaseMovementsForMonth` ya fue precomputado en buildMovements,
  // así que el dedup contra CXP corre una sola vez (no por mes).
  for (const movement of purchaseMovementsForMonth) {
    if (movement.projectedDate.slice(0, 7) !== month.yearMonth) continue;
    lines.push({
      id: movement.id,
      amount: movement.projectedAmount,
      date: movement.projectedDate,
      concept: movement.concept,
      category: movement.category,
      subcategory: movement.subcategory,
      providerCategory: movement.providerCategory,
      counterpartyId: movement.counterpartyId,
      counterpartyName: movement.counterpartyName,
      counterpartyType: movement.counterpartyType,
      ruleApplied: movement.ruleApplied ?? 'Recibo de compras',
      sourceSystem: movement.sourceSystem,
      sourceObjectId: movement.sourceObjectId,
      companyId: movement.companyId,
      issueDate: movement.issueDate,
      dueDate: movement.dueDate,
      forecastMethod: movement.forecastMethod,
      confidenceScore: movement.confidenceScore,
      lockState: movement.lockState,
      taxTreatment: movement.taxTreatment,
      taxRate: movement.taxRate,
      taxBaseAmount: movement.taxBaseAmount,
      taxAmount: movement.taxAmount,
      comment: movement.comments?.join(' ') ?? 'Compromiso temprano desde Recibo de Compras.',
      amountLocked: true,
    });
  }

  // 3) Nómina TRESS. No genera IVA; sí alimenta ISN/IMSS en el módulo fiscal.
  // Si TRESS solo tiene el mes en curso, replicamos la pauta hacia adelante
  // hasta el horizonte de proyección para que Dashboard / Planeación / Proyección
  // vean nómina proyectada y no caja "inflada" por ausencia del egreso.
  for (const movement of buildPayrollCostMovements({
    payrollCosts: inputs.payrollCosts ?? [],
    companyCode: inputs.companyCode,
    asOfDate: inputs.asOfDate,
    projectThroughYearMonth,
    targetYearMonth: month.yearMonth,
  })) {
    if (movement.projectedDate.slice(0, 7) !== month.yearMonth) continue;
    lines.push({
      id: movement.id,
      amount: movement.projectedAmount,
      date: movement.projectedDate,
      concept: movement.concept,
      category: movement.category,
      subcategory: movement.subcategory,
      counterpartyName: movement.counterpartyName,
      counterpartyType: movement.counterpartyType,
      ruleApplied: movement.ruleApplied ?? 'TRESS',
      sourceSystem: movement.sourceSystem,
      sourceObjectId: movement.sourceObjectId,
      companyId: movement.companyId,
      issueDate: movement.issueDate,
      dueDate: movement.dueDate,
      forecastMethod: movement.forecastMethod,
      confidenceScore: movement.confidenceScore,
      lockState: movement.lockState,
      taxTreatment: movement.taxTreatment,
      taxRate: movement.taxRate,
      taxBaseAmount: movement.taxBaseAmount,
      taxAmount: movement.taxAmount,
      comment: movement.comments?.join(' ') ?? 'Costo de nómina desde TRESS.',
      amountLocked: true,
    });
  }

  if (expenseProjection) {
    for (const providerLine of expenseProjection.providerLines) {
      const recurringAmount = positiveNumber(providerLine.parts.recurring);
      if (recurringAmount <= 0) continue;
      // Concurso Mercantil: omitir recurrentes de proveedores con deuda
      // congelada. Sus pagos viven en el módulo Concurso.
      const noProvRecurring = providerJdeByCatalogId.get(providerLine.providerId);
      if (noProvRecurring && concursoProviderIds.has(noProvRecurring)) continue;
      const taxMeta = providerLine.ivaRate ? grossToIvaTaxMeta(recurringAmount, providerLine.ivaRate) : undefined;
      lines.push({
        id: `recurring-provider:${month.yearMonth}:${providerLine.providerId}`,
        amount: recurringAmount,
        date: dateForDayOfMonth(month.yearMonth, providerLine.typicalPayDay ?? 15),
        concept: `Pago recurrente ${providerLine.providerName}`,
        category: 'AP_PAYMENT',
        subcategory: providerLine.providerCategory ?? 'Recurrente',
        providerCategory: providerLine.providerCategory,
        counterpartyId: providerLine.providerId.startsWith('__un::') ? undefined : providerLine.providerId,
        counterpartyName: providerLine.providerName,
        counterpartyType: 'SUPPLIER',
        ruleApplied: providerLine.source === 'mixed'
          ? 'Complemento recurrente sobre CXP'
          : 'Patrón recurrente bancario por proveedor',
        sourceSystem: 'FORECAST',
        sourceObjectId: `${month.yearMonth}:${providerLine.providerId}`,
        companyId: inputs.companyCode !== 'all' ? inputs.companyCode : undefined,
        forecastMethod: 'DRIVER',
        confidenceScore: providerLine.score != null ? Math.max(60, Math.min(90, Math.round(providerLine.score))) : 72,
        lockState: providerLine.flexibility === 'inamovible' ? 'RESTRICTED' : 'UNLOCKED',
        taxTreatment: taxMeta ? 'IVA_CREDITABLE' : 'UNCLASSIFIED',
        taxRate: taxMeta?.taxRate,
        taxBaseAmount: taxMeta?.taxBaseAmount,
        taxAmount: taxMeta?.taxAmount,
        comment: providerLine.source === 'mixed'
          ? `CXP cubre ${providerLine.parts.scheduled}; se agrega recurrente histórico por ${recurringAmount}.`
          : 'Gasto recurrente detectado en bancos y asociado al proveedor.',
      });
    }

    if (expenseProjection.providerLines.length === 0 && expenseProjection.recurring > 0) {
      lines.push({
        id: `recurring-operating:${month.yearMonth}`,
        amount: expenseProjection.recurring,
        date: midMonthDate(month.yearMonth),
        concept: 'Egresos recurrentes operativos',
        category: 'OPEX',
        subcategory: 'Recurrente',
        ruleApplied: 'Patrón recurrente bancario agrupado',
        sourceSystem: 'FORECAST',
        sourceObjectId: month.yearMonth,
        companyId: inputs.companyCode !== 'all' ? inputs.companyCode : undefined,
        forecastMethod: 'DRIVER',
        confidenceScore: 58,
        lockState: 'RESTRICTED',
        taxTreatment: 'UNCLASSIFIED',
        comment: 'Gasto recurrente detectado sin proveedor identificado; se agrupa para evitar conceptos bancarios crudos.',
      });
    }

    const emittedTotal = lines.reduce((sum, line) => sum + line.amount, 0);
    const budgetGap = Math.max(0, expenseProjection.total - emittedTotal);
    if (expenseProjection.fromBudget > 0 && budgetGap > 0) {
      lines.push({
        id: `budget-opex-gap:${month.yearMonth}`,
        amount: budgetGap,
        date: midMonthDate(month.yearMonth),
        concept: `Reserva presupuestal de gasto operativo ${month.yearMonth}`,
        category: 'OPEX',
        subcategory: 'Presupuesto',
        ruleApplied: 'Presupuesto mayor al gasto operativo explícito',
        sourceSystem: 'FORECAST',
        sourceObjectId: month.yearMonth,
        companyId: inputs.companyCode !== 'all' ? inputs.companyCode : undefined,
        forecastMethod: 'DRIVER',
        confidenceScore: 64,
        lockState: 'RESTRICTED',
        taxTreatment: 'UNCLASSIFIED',
        comment: 'Relleno presupuestal para conservar el total mensual sin inflar compromisos operativos explícitos.',
      });
    }
  }

  return lines;
}

interface BalanceArgs {
  lines: RawLine[];
  target: number;
  ym: string;
  type: FinancialMovement['type'];
  asOfDate: string;
  fallbackCategory: FinancialMovementCategory;
  fallbackConcept: string;
  fallbackRule: string;
}

function balanceInflowMonth({
  lines,
  target,
  ym,
  asOfDate,
  fallbackCategory,
  fallbackConcept,
  fallbackRule,
}: Omit<BalanceArgs, 'type'>): FinancialMovement[] {
  const locked = lines.filter((line) => line.amountLocked);
  const flexible = lines.filter((line) => !line.amountLocked);
  const lockedSum = locked.reduce((sum, line) => sum + line.amount, 0);
  const out = emitRawLines(locked, 'INFLOW', asOfDate);
  const remainingTarget = Math.max(0, target - lockedSum);

  out.push(...balanceMonth({
    lines: flexible,
    target: remainingTarget,
    ym,
    type: 'INFLOW',
    asOfDate,
    fallbackCategory,
    fallbackConcept,
    fallbackRule,
  }));
  return out;
}

function balanceOutflowMonth({
  lines,
  target,
  ym,
  asOfDate,
  fallbackCategory,
  fallbackConcept,
  fallbackRule,
}: Omit<BalanceArgs, 'type'>): FinancialMovement[] {
  const locked = lines.filter((line) => line.amountLocked);
  const flexible = lines.filter((line) => !line.amountLocked);
  const lockedSum = locked.reduce((sum, line) => sum + line.amount, 0);
  const out = emitRawLines(locked, 'OUTFLOW', asOfDate);
  const remainingTarget = Math.max(0, target - lockedSum);

  out.push(...balanceMonth({
    lines: flexible,
    target: remainingTarget,
    ym,
    type: 'OUTFLOW',
    asOfDate,
    fallbackCategory,
    fallbackConcept,
    fallbackRule,
  }));
  return out;
}

function balanceMonth({
  lines,
  target,
  ym,
  type,
  asOfDate,
  fallbackCategory,
  fallbackConcept,
  fallbackRule,
}: BalanceArgs): FinancialMovement[] {
  if (target <= 0) return [];
  if (lines.length === 0) {
    const fallbackTaxMeta = fallbackCategory === 'OPEX' || fallbackCategory === 'CAPEX' || fallbackCategory === 'AP_PAYMENT'
      ? grossToIvaTaxMeta(target, 16)
      : undefined;
    return [{
      id: `canonical-${type.toLowerCase()}:${ym}`,
      sourceSystem: 'FORECAST',
      type,
      category: fallbackCategory,
      concept: fallbackConcept,
      currency: 'MXN',
      originalAmount: target,
      baseAmount: target,
      projectedAmount: target,
      projectedDate: midMonthDate(ym),
      confidenceScore: 65,
      confidenceBand: calculateConfidenceBand(65),
      forecastMethod: 'DRIVER',
      ruleApplied: fallbackRule,
      taxTreatment: fallbackTaxMeta
        ? 'IVA_CREDITABLE'
        : fallbackCategory === 'AR_COLLECTION'
          ? 'UNCLASSIFIED'
          : fallbackCategory === 'PAYROLL' || fallbackCategory === 'TAX' || fallbackCategory === 'DEBT'
            ? 'IVA_EXEMPT'
            : 'UNCLASSIFIED',
      taxRate: fallbackTaxMeta?.taxRate,
      taxBaseAmount: fallbackTaxMeta?.taxBaseAmount,
      taxAmount: fallbackTaxMeta?.taxAmount,
      status: 'PROJECTED_BASE',
      lockState: 'RESTRICTED',
      comments: ['Sin desglose por catálogo en este mes; se usa el total del Dashboard.'],
      createdAt: `${asOfDate}T00:00:00.000Z`,
      updatedAt: `${asOfDate}T00:00:00.000Z`,
    }];
  }

  const sum = lines.reduce((s, l) => s + l.amount, 0);
  if (sum === 0) return [];

  const scale = target / sum;
  let runningTotal = 0;
  const out: FinancialMovement[] = [];
  lines.forEach((line, idx) => {
    const isLast = idx === lines.length - 1;
    const scaled = isLast
      ? Math.max(0, target - runningTotal)
      : Math.round(line.amount * scale);
    runningTotal += scaled;
    out.push({
      id: line.id,
      sourceSystem: line.sourceSystem,
      sourceObjectId: line.sourceObjectId,
      type,
      category: line.category,
      subcategory: line.subcategory,
      companyId: line.companyId,
      counterpartyId: line.counterpartyId,
      counterpartyName: line.counterpartyName,
      counterpartyType: line.counterpartyType,
      providerCategory: line.providerCategory,
      concept: line.concept,
      currency: 'MXN',
      originalAmount: line.amount,
      baseAmount: line.amount,
      projectedAmount: scaled,
      issueDate: line.issueDate,
      dueDate: line.dueDate,
      projectedDate: line.date,
      confidenceScore: line.confidenceScore,
      confidenceBand: calculateConfidenceBand(line.confidenceScore),
      forecastMethod: line.forecastMethod,
      ruleApplied: line.ruleApplied,
      taxTreatment: line.taxTreatment,
      taxRate: line.taxRate,
      ...scaleTaxMeta(line, scaled),
      status: 'PROJECTED_BASE',
      lockState: line.lockState,
      comments: [line.comment],
      createdAt: `${asOfDate}T00:00:00.000Z`,
      updatedAt: `${asOfDate}T00:00:00.000Z`,
    });
  });
  return out;
}

export function hasSufficientCanonicalData(inputs: CanonicalProjectionInputs): boolean {
  const cobranzaRecords = inputs.cobranzaRecords ?? [];
  const purchaseReceipts = inputs.purchaseReceipts ?? [];
  const payrollCosts = inputs.payrollCosts ?? [];
  if (
    inputs.bankStatements.length === 0
    && inputs.cxpRecords.length === 0
    && cobranzaRecords.length === 0
    && purchaseReceipts.length === 0
    && payrollCosts.length === 0
  ) return false;
  if (
    inputs.bankStatements.length === 0
    && inputs.providers.length === 0
    && inputs.clients.length === 0
    && inputs.cxpRecords.length === 0
    && cobranzaRecords.length === 0
    && purchaseReceipts.length === 0
    && payrollCosts.length === 0
  ) {
    return false;
  }
  return true;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function midMonthDate(yearMonth: string): string {
  return `${yearMonth}-15`;
}

function dateForDayOfMonth(yearMonth: string, day: number): string {
  const [year, month] = yearMonth.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const safeDay = Math.min(Math.max(1, Math.round(day || 15)), lastDay);
  return `${yearMonth}-${String(safeDay).padStart(2, '0')}`;
}

function cleanDate(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined;
}

function filterCobranzaByCompany(records: CobranzaRecord[], companyCode: string): CobranzaRecord[] {
  if (companyCode === 'all' || !companyCode) return records;
  return records.filter((record) => record.cia === companyCode);
}

function cxcFacturaKey(record: CobranzaRecord): string {
  return `${record.cia}::${record.noFactura}`;
}

/**
 * Set de facturas que el reconciliation engine ya cruzó automáticamente
 * con un ABONO bancario. Sólo el estado 'cobrada-banco' bloquea la
 * proyección. 'cobrada-jde-sin-banco' o 'pendiente' pasan derecho:
 * el cobro aún no aparece en el banco, así que la CXC pendiente sigue
 * siendo el mejor estimado para la trayectoria de caja.
 */
function buildCobradaBancoKeySet(
  reconciliation: RealReconciliationResult | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!reconciliation) return out;
  for (const match of reconciliation.matches) {
    if (match.status !== 'cobrada-banco') continue;
    out.add(`${match.cia}::${match.noFactura}`);
  }
  return out;
}

function addCoveredMonth(map: Map<string, Set<string>>, clientId: string, yearMonth: string): void {
  const set = map.get(clientId) ?? new Set<string>();
  set.add(yearMonth);
  map.set(clientId, set);
}

function moveOpenReceivableIntoProjection(
  rawDate: string,
  asOfDate: string,
): { date: string; moved: boolean } {
  const safeDate = cleanDate(rawDate) ?? asOfDate;
  if (safeDate > asOfDate) return { date: safeDate, moved: false };

  let next = parseIsoDate(asOfDate);
  next = new Date(next.getTime() + DAY_MS);
  while (isNonOperatingDay(next)) next = new Date(next.getTime() + DAY_MS);
  return { date: dateToIso(next), moved: true };
}

function moveOpenPayableIntoProjection(
  rawDate: string,
  asOfDate: string,
): { date: string; moved: boolean } {
  const safeDate = cleanDate(rawDate) ?? asOfDate;
  if (safeDate >= asOfDate) return { date: safeDate, moved: false };

  let next = parseIsoDate(asOfDate);
  while (isNonOperatingDay(next)) next = new Date(next.getTime() + DAY_MS);
  return { date: dateToIso(next), moved: true };
}

function parseIsoDate(value: string): Date {
  const safe = cleanDate(value) ?? new Date().toISOString().slice(0, 10);
  const [year, month, day] = safe.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function dateToIso(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function supplierLookupKey(value: string | undefined): string {
  if (!value) return '';
  return value
    .toUpperCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function providerJdeKey(value: string | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  const numeric = trimmed.replace(/\D/g, '');
  if (numeric) return String(Number(numeric));
  return supplierLookupKey(trimmed);
}

function cxcTaxMeta(
  record: CobranzaRecord,
  client?: Client,
): { taxRate: FinancialTaxRate; taxBaseAmount: number; taxAmount: number } {
  const rate = client?.ivaRate === 8 ? 8 : 16;
  return grossToIvaTaxMeta(record.importePendientePesos, rate);
}

function taxBreakdownFromCxp(record: CXPRecord): {
  taxRate?: FinancialTaxRate;
  taxBaseAmount?: number;
  taxAmount?: number;
} {
  const gross = positiveNumber(record.importeBrutoPesos);
  const pending = positiveNumber(record.importePendientePesos);
  const subtotal = positiveNumber(record.importeSubtotalPesos);
  const tax = positiveNumber(record.importeImpuestosPesos);
  if (pending <= 0) return {};
  if (gross <= 0 || subtotal <= 0 || tax <= 0) return grossToIvaTaxMeta(pending, 16);
  const scale = Math.min(1, pending / gross);
  const taxBaseAmount = subtotal * scale;
  const taxAmount = tax * scale;
  const taxRate = taxRateFromAmounts(taxBaseAmount, taxAmount);
  return taxRate ? { taxRate, taxBaseAmount, taxAmount } : grossToIvaTaxMeta(pending, 16);
}

function taxRateFromAmounts(base: number, taxAmount: number): FinancialTaxRate | undefined {
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(taxAmount) || taxAmount <= 0) return undefined;
  const pct = Math.round((taxAmount / base) * 100);
  if (Math.abs(pct - 16) <= 1) return 16;
  if (Math.abs(pct - 8) <= 1) return 8;
  return undefined;
}

function grossToIvaTaxMeta(
  amount: number,
  rate: 8 | 16,
): { taxRate: FinancialTaxRate; taxBaseAmount: number; taxAmount: number } {
  const taxBaseAmount = amount / (1 + rate / 100);
  return {
    taxRate: rate,
    taxBaseAmount,
    taxAmount: amount - taxBaseAmount,
  };
}

function scaleTaxMeta(
  line: Pick<RawLine, 'amount' | 'taxBaseAmount' | 'taxAmount'>,
  projectedAmount: number,
): Pick<FinancialMovement, 'taxBaseAmount' | 'taxAmount'> {
  if (line.taxBaseAmount == null || line.taxAmount == null || line.amount <= 0) return {};
  const scale = projectedAmount / line.amount;
  return {
    taxBaseAmount: line.taxBaseAmount * scale,
    taxAmount: line.taxAmount * scale,
  };
}

function positiveNumber(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function paymentPatternLabel(client: Client): string {
  if (client.paymentDayRaw) return client.paymentDayRaw;
  if (client.paymentDay.kind === 'ANY') return 'Sin patrón específico';
  if (client.paymentDay.kind === 'DOW') return `Días ${client.paymentDay.days.join(', ')}`;
  if (client.paymentDay.kind === 'DOM') return `Día ${client.paymentDay.day}`;
  if (client.paymentDay.kind === 'NTH_DOW') return `${client.paymentDay.nth} día ${client.paymentDay.day}`;
  if (client.paymentDay.kind === 'DOM_LIST') return `Días ${client.paymentDay.days.join(', ')}`;
  if (client.paymentDay.kind === 'WOM') return `Semanas ${client.paymentDay.weeks.join(', ')}`;
  return `Día ${client.paymentDay.day}`;
}
