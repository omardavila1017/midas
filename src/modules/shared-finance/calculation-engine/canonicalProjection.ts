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
import { isNonOperatingDay } from '../../../domain/bankHolidays';
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
  isInternalCounterparty,
} from '../../../domain/netCashFlowEngine';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import { getConcursoProviderIds, isConcursoMercantil, normalizeProviderId } from '../../../domain/concursoMercantil';
import type { Client, Provider, CashFlowAssumptions } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import type { CobranzaRecord, RolRecord } from '../../../services/jdeTypes';
import { buildRolProjectedInflows, type RolProjectedInflow } from '../../../domain/rolProjectionEngine';
import { bankMovementKey } from '../../../domain/bankMovementKey';
import { todayISO } from '../../../formatters';
import { isCorningAbono } from '../../../domain/bankStatements';
import type { AbonoEnrichment, RealReconciliationResult } from '../../../domain/realReconciliationEngine';
import { enrichFromCatalog } from '../../../domain/providerCatalog';
import { classifyBankConcept } from '../../../domain/bankConceptClassifier';
import { buildCargoProviderIndex, matchCargoToProvider } from '../../../domain/cargoProviderMatch';
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
  /**
   * ROL CITI: viajes ejecutados. Los predichos (ejecutados, aún no
   * facturados) se proyectan como ingreso futuro fechado por la regla de
   * pago del catálogo. Solo afecta escenarios Aprobado/propuesta — el id
   * `rol:` y la fecha futura lo excluyen de Base por construcción.
   */
  rolRecords?: RolRecord[];
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
  cargoEnrichments?: Map<string, { status: 'MATCHED' | 'ORPHAN'; payments?: Array<{ claveProveedor?: string; nombreProveedor: string; importe: number }> }>;
  assumptions: CashFlowAssumptions;
  budget: Budget | null;
  /**
   * Override manual de caja inicial. `undefined` → se calcula como
   * Σ saldoInicial de los bankStatements provistos (calculateInitialCash).
   */
  startingBalance?: number;
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
  actualIncome?: number;
  actualExpense?: number;
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
  const { base, predictive } = computeBaseCashFlow(computeInputs);

  const monthly: CanonicalMonthlyPoint[] = base.map((m) => ({
    yearMonth: m.yearMonth,
    isHistorical: m.isHistorical,
    income: m.income,
    expense: m.expense,
    closingCash: m.closingCash,
    actualIncome: m.actualIncome,
    actualExpense: m.actualExpense,
  }));

  const movements = buildMovements({ monthly, inputs });

  const initialCash = base.length > 0
    ? base[0].closingCash - base[0].income + base[0].expense
    : (inputs.startingBalance ?? 0);

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
}

// Cubos de ingreso en la tabla de Planeación. Reglas de negocio (confirmadas
// con el usuario 2026-05-15):
//   • ROL = viajes ejecutados (cobranza/CXC JDE, real o proyectado). TODO el
//     ROL es Senda Citi → bucket "Clientes Citi".
//   • Federal = lo que el catálogo de bancos etiqueta unidadNegocio=FEDERAL
//     (ingreso real) + el modelo predictivo histórico para meses futuros.
//   • Otros ingresos = SOLO lo no reconocido.
const INCOME_SUBCAT_FEDERAL = 'Federal';
const INCOME_SUBCAT_CITI = 'Clientes Citi';

/**
 * Reglas de negocio para enrutar un cobro CXC/ROL al bucket de ingreso.
 * - Federal: SOLO Betterez/Busbud/Via (mismo cliente, varios nombres del
 *   grupo Federal — única excepción que el negocio define).
 * - Clientes Citi: TODO lo demás del catálogo, incluyendo Corning, Viajes
 *   Especiales y cualquier cliente sin match. Por petición del negocio,
 *   Viajes Especiales ya no se separa como subgrupo aparte.
 */
const FEDERAL_NAME_RE = /\b(busbud|betterez|via)\b/i;

/**
 * Si el cliente pertenece a un grupo comercial, devuelve el GRUPO PADRE como
 * counterparty. Esto colapsa las subsidiarias debajo de su padre en la tabla
 * de Planeación. Si no hay grupo, se queda con el cliente individual.
 */
function clientDisplayCounterparty(client: { id: string; name?: string; commercialGroupId?: string; commercialGroupName?: string }): { id: string; name?: string } {
  if (client.commercialGroupId && client.commercialGroupName) {
    return { id: client.commercialGroupId, name: client.commercialGroupName };
  }
  return { id: client.id, name: client.name };
}

function rolCitiSubcategoryFor(client: { name?: string; commercialGroupId?: string; commercialGroupName?: string } | null | undefined): string {
  if (!client) return INCOME_SUBCAT_CITI;
  const haystack = `${client.name ?? ''} ${client.commercialGroupName ?? ''}`;
  if (FEDERAL_NAME_RE.test(haystack)) return INCOME_SUBCAT_FEDERAL;
  return INCOME_SUBCAT_CITI;
}

function resolveInflowSubcategory(args: {
  counterpartyId?: string;
  clientById: Map<string, Client>;
  bankFallbackLabel?: string;
  businessUnitId?: string;
  /** El ingreso proviene de un viaje ejecutado (cobranza/CXC JDE). Todo el
   *  ROL es Senda Citi salvo que el cliente sea Federal (Betterez/Busbud/Via). */
  isRolCollection?: boolean;
}): string {
  // 1) Cliente del catálogo manda: Federal SOLO si name/grupo match
  //    Betterez/Busbud/Via; cualquier otro cliente del catálogo = Citi.
  if (args.counterpartyId) {
    const client = args.clientById.get(args.counterpartyId);
    if (client) {
      const haystack = `${client.name ?? ''} ${client.commercialGroupName ?? ''}`;
      if (FEDERAL_NAME_RE.test(haystack)) return INCOME_SUBCAT_FEDERAL;
      return INCOME_SUBCAT_CITI;
    }
  }
  // 2) Sin cliente identificado: el catálogo de cuentas de banco decide.
  //    SOLO las cuentas marcadas `unidadNegocio = FEDERAL` (treasury-mantenido)
  //    clasifican su ingreso como Federal. CITI / MULTICARGA / RESERVA y
  //    cualquier cuenta sin catálogo caen a Clientes Citi (regla del negocio:
  //    lo único que no es Citi es la línea Federal).
  if (args.businessUnitId && String(args.businessUnitId).toUpperCase() === 'FEDERAL') {
    return INCOME_SUBCAT_FEDERAL;
  }
  if (args.bankFallbackLabel && FEDERAL_NAME_RE.test(args.bankFallbackLabel)) {
    return INCOME_SUBCAT_FEDERAL;
  }
  // 3) Default: Clientes Citi (cobranza/CXC/ROL/ABONO de cuenta no-Federal).
  return INCOME_SUBCAT_CITI;
}

function buildMovements({ monthly, inputs }: BuildArgs): FinancialMovement[] {
  const out: FinancialMovement[] = [];
  const todayYm = toYearMonth(inputs.asOfDate);
  const monthlyByYm = new Map(monthly.map((m) => [m.yearMonth, m]));
  const inflowContext = buildInflowContext(inputs);
  // clientById debe resolver tanto por client.id (slug del catálogo) como
  // por noCliente JDE (numérico). Los ABONOs de cobranza pasan `noCliente`
  // crudo cuando el enriquecimiento no encontró el catalogClientId — sin
  // este alias, resolveInflowSubcategory caía a businessUnitId del banco
  // (Federal) en lugar de la regla del catálogo (Citi).
  const clientById = new Map<string, Client>();
  for (const c of inputs.clients) {
    clientById.set(c.id, c);
    for (const acc of c.jdeAccounts ?? []) {
      const nc = (acc?.noCliente ?? '').trim();
      if (nc && !clientById.has(nc)) clientById.set(nc, c);
    }
    // Indexar también por commercialGroupId. Cuando un movimiento se colapsa
    // al grupo padre como counterparty, `resolveInflowSubcategory` debe poder
    // resolver el grupo y aplicar las reglas (Federal vs Citi) del catálogo.
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
  // Índice para identificar CARGOs sin cruce a PagoProveedor: nombre del
  // proveedor en el concepto bancario + monto contra compras (OCs).
  const cargoProviderIndex = buildCargoProviderIndex(
    inputs.providers,
    inputs.purchaseReceipts ?? [],
  );

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
            ? bankFallbackName
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
                clientById,
                businessUnitId: catalogEnrich?.entry.unidadNegocio,
                bankFallbackLabel: !isCobranzaInflow ? bankFallbackName : undefined,
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
      const cargoSubcategory = cargoProviderHit?.providerType
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
        providerCategory: !isInflow ? (cargoProviderHit?.providerType ?? undefined) : undefined,
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
      subcategory: resolveInflowSubcategory({ counterpartyId, clientById, isRolCollection: true }),
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

  // 2) Meses futuros: SOLO datos reales de corto plazo.
  //    Inflows: CXC abierto (cobranza JDE pendiente) + ROL CITI (viajes
  //    ejecutados aún no facturados, fechados por catálogo).
  //    Outflows: CXP abierto + compras (OC con F_Recepcion+D_Credito) +
  //    nómina TRESS real (sin replicar). Sin balanceo a totales canónicos,
  //    sin proyecciones rule-based (`client:`), sin recurrentes, sin
  //    reserva de presupuesto, sin sintéticos de balance.
  const futureMonths = monthly.filter((m) => !m.isHistorical);
  const horizonYm = monthly[monthly.length - 1]?.yearMonth;
  const purchaseMovementsByYm = groupMovementsByYearMonth(buildPurchaseReceiptMovements({
    purchaseReceipts: inputs.purchaseReceipts ?? [],
    cxpRecords: inputs.cxpRecords,
    companyCode: inputs.companyCode,
    asOfDate: inputs.asOfDate,
    excludeProviderIds: concursoProviderIds,
    providers: inputs.providers,
  }));
  for (const month of futureMonths) {
    const inflowLines = collectInflowLines(month, inputs, todayYm, inflowContext);
    out.push(...emitRawLines(inflowLines, 'INFLOW', inputs.asOfDate));

    const outflowLines = collectOutflowLines(month, inputs, todayYm, undefined, horizonYm, purchaseMovementsByYm.get(month.yearMonth) ?? [], concursoProviderIds);
    out.push(...emitRawLines(outflowLines, 'OUTFLOW', inputs.asOfDate));
  }

  // 3) Mes en curso (parcial). Días pasados ya están como REAL desde el
  //    banco. Para los días que faltan: SOLO líneas reales (CXC/ROL/CXP/
  //    compras/payroll TRESS), sin rellenar al target operativo.
  const currentYm = todayYm;
  const currentHistorical = monthly.find((m) => m.isHistorical && m.yearMonth === currentYm);
  if (currentHistorical) {
    const inflowLines = collectInflowLines(currentHistorical, inputs, todayYm, inflowContext)
      .filter((line) => line.date >= inputs.asOfDate);
    out.push(...emitRawLines(inflowLines, 'INFLOW', inputs.asOfDate));

    const outflowLines = collectOutflowLines(currentHistorical, inputs, todayYm, undefined, horizonYm, purchaseMovementsByYm.get(currentYm) ?? [], concursoProviderIds)
      .filter((line) => line.date >= inputs.asOfDate);
    out.push(...emitRawLines(outflowLines, 'OUTFLOW', inputs.asOfDate));
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
  /** Líneas ROL proyectadas agrupadas por `yyyy-mm` de cobro. */
  rolInflowsByYm: Map<string, RolProjectedInflow[]>;
  /** clientId → set `yyyy-mm` de cobro cubierto por ROL (suprime `client:`). */
  rolCoverageByClientMonth: Map<string, Set<string>>;
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

  // ROL: viajes ejecutados aún no facturados → ingreso futuro real fechado
  // por la regla del catálogo. Reusa el clientLookup ya armado. Solo cruza
  // contra la cobranza de la misma empresa para no marcar como "predicho"
  // un viaje ya facturado en otra cía del cruce.
  const rol = buildRolProjectedInflows({
    rolRecords: inputs.rolRecords ?? [],
    cobranzaRecords: cxcRecords,
    clients: inputs.clients,
    assumptions: inputs.assumptions,
    asOfDate: inputs.asOfDate,
    clientLookup,
  });
  const rolInflowsByYm = new Map<string, RolProjectedInflow[]>();
  for (const inflow of rol.inflows) {
    const ym = inflow.date.slice(0, 7);
    const arr = rolInflowsByYm.get(ym);
    if (arr) arr.push(inflow);
    else rolInflowsByYm.set(ym, [inflow]);
  }
  // TODO(rol-diag): instrumentación temporal — quitar tras confirmar mapeo ROL.
  if (typeof console !== 'undefined') {
    const dates = rol.inflows.map((i) => i.date).sort();
    const gross = rol.inflows.reduce((s, i) => s + i.grossAmount, 0);
    // eslint-disable-next-line no-console
    console.info(
      `[rol-diag] rolRecords=${(inputs.rolRecords ?? []).length} → líneas rol:=${rol.inflows.length} `
      + `bruto=${Math.round(gross)} fechas ${dates[0] ?? '—'}..${dates[dates.length - 1] ?? '—'} `
      + `· sin cliente catálogo: viajes=${rol.unmatchedTrips} monto=${Math.round(rol.unmatchedAmount)} `
      + `· asOf=${inputs.asOfDate}`,
    );
  }

  return {
    cxcRecords,
    cxcCoverageByClientMonth,
    clientMatchByFactura,
    rolInflowsByYm,
    rolCoverageByClientMonth: rol.coverageByClientMonth,
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
  const lines: RawLine[] = collectCxcInflowLines(month, inputs, context);

  // ROL: viajes ejecutados aún no facturados. Monto real ejecutado, fechado
  // por la regla de pago del catálogo (overlay /cobranza). `amountLocked` →
  // no se escala al total del Dashboard (mismo trato que `cxc:`).
  for (const inflow of context.rolInflowsByYm.get(month.yearMonth) ?? []) {
    const rolSubcat = rolCitiSubcategoryFor({
      name: inflow.clientName,
      commercialGroupId: inflow.commercialGroupId,
    });
    // Si el cliente ROL tiene grupo comercial, agrupa el ROL al grupo padre.
    const rolClient = inputs.clients.find((c) => c.id === inflow.clientId);
    const rolDisplay = rolClient ? clientDisplayCounterparty(rolClient) : { id: inflow.clientId, name: inflow.clientName };
    lines.push({
      id: `rol:${inflow.clientId}:${inflow.date}`,
      amount: inflow.grossAmount,
      date: inflow.date,
      concept: `Viajes ejecutados ${inflow.clientName} (${inflow.tripCount} viaje${inflow.tripCount === 1 ? '' : 's'})`,
      category: 'AR_COLLECTION',
      subcategory: rolSubcat,
      counterpartyId: rolDisplay.id,
      counterpartyName: rolDisplay.name,
      counterpartyType: 'CUSTOMER',
      ruleApplied: `ROL CITI · ${inflow.ruleReason}`,
      sourceSystem: 'FORECAST',
      sourceObjectId: inflow.clientId,
      forecastMethod: 'RULE',
      confidenceScore: 70,
      lockState: 'RESTRICTED',
      taxTreatment: 'IVA_CAUSED',
      taxRate: 16,
      taxBaseAmount: inflow.subTotal,
      taxAmount: inflow.grossAmount - inflow.subTotal,
      comment: `Viajes ejecutados (ROL CITI) aún no facturados; ingreso proyectado por la regla de pago del catálogo. ${inflow.ruleReason}`,
      amountLocked: true,
    });
  }

  // Proyección genérica `client:` por regla de catálogo eliminada en esta
  // branch — solo aparecen ingresos reales (CXC abierto + ROL ejecutado).

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
    // Factura intercompañía (empresa propia del grupo): traspaso, no
    // cobranza real. No proyectar como entrada de caja.
    if (isInternalCounterparty(record.rfc, record.nombreCliente)) continue;
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

    const cxcSubcat = rolCitiSubcategoryFor(clientMatch?.client ?? null);
    lines.push({
      id: `cxc:${record.cia}:${record.noCliente}:${record.noFactura}`,
      amount: record.importePendientePesos,
      date: dateInfo.date,
      concept: `Factura CXC ${record.noFactura || 'sin folio'} · ${record.nombreCliente || 'Cliente sin nombre'}`,
      category: 'AR_COLLECTION',
      subcategory: cxcSubcat,
      companyId: record.cia,
      counterpartyId: clientMatch ? clientDisplayCounterparty(clientMatch.client).id : record.noCliente,
      counterpartyName: clientMatch
        ? clientDisplayCounterparty(clientMatch.client).name
        : (record.nombreCliente || undefined),
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
 * Outflows: SOLO datos reales de corto plazo — CXP abierto (JDE), compras
 * (OC con F_Recepcion+D_Credito) y nómina TRESS real. Sin proyecciones
 * por patrón ni reserva presupuestal.
 */
function collectOutflowLines(
  month: CanonicalMonthlyPoint,
  inputs: CanonicalProjectionInputs,
  todayYm: string,
  _unused?: unknown,
  _projectThrough?: string,
  /**
   * Movimientos de compras (PurchaseReceipt) ya filtrados para `month.yearMonth`.
   */
  purchaseMovementsForMonth: FinancialMovement[] = [],
  /**
   * Set de `noProveedor` (trim + upper) de proveedores en Concurso Mercantil.
   * Sus pagos viven en el módulo Concurso.
   */
  concursoProviderIds: Set<string> = new Set(),
): RawLine[] {
  const lines: RawLine[] = [];
  const providerByName = new Map(inputs.providers.map((p) => [supplierLookupKey(p.name), p]));
  const providerByJde = new Map<string, Provider>();
  for (const provider of inputs.providers) {
    const jdeKey = providerJdeKey(provider.numProveedorJDE);
    if (jdeKey) providerByJde.set(jdeKey, provider);
  }
  const filteredCxp = inputs.companyCode === 'all' || !inputs.companyCode
    ? inputs.cxpRecords
    : inputs.cxpRecords.filter((r) => r.cia === inputs.companyCode);

  // 1) CXP abierta de JDE. Si ya venció, se trae al día operativo actual
  // para que el scheduler decida si se paga hoy, se recorre o queda pendiente.
  filteredCxp.forEach((record, index) => {
    if (record.importePendientePesos <= 0) return;
    // Factura intercompañía (empresa propia del grupo): traspaso, no egreso
    // real. Espejo del filtro CXC (collectCxcInflowLines) para que un payable
    // entre empresas del grupo no infle los egresos de Planeación. CXPRecord
    // no trae RFC — se matchea por nombre/código de empresa propia.
    if (isInternalCounterparty(undefined, record.nombre)) return;
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

  // 3) Nómina TRESS REAL solamente (sin replicación a futuro en esta branch).
  for (const movement of buildPayrollCostMovements({
    payrollCosts: inputs.payrollCosts ?? [],
    companyCode: inputs.companyCode,
    asOfDate: inputs.asOfDate,
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

  // Recurrentes / `recurring-provider:` / `recurring-operating:` /
  // `budget-opex-gap:` eliminados en esta branch — sin proyección a largo
  // plazo, solo egresos reales de corto plazo (CXP, OC compras, payroll TRESS).

  return lines;
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
  const safe = cleanDate(value) ?? todayISO();
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

