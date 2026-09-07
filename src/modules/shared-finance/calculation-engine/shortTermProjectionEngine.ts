// ─────────────────────────────────────────────────────────────────────────
// shortTermProjectionEngine — MOTOR 2 (Proyección de corto plazo, > hoy).
// Emite SOLO datos reales de corto plazo, cada uno fechado por SU regla:
//   • Cobranza/CXC abierto + ROL CITI (viaje ejecutado aún no facturado) +
//     Viajes Especiales — ingresos.
//   • CXP abierto + compras (OC `F_Recepcion`+`D_Credito`) + nómina TRESS
//     real — egresos.
// Sin balanceo a totales canónicos, sin proyecciones rule-based genéricas
// (`client:`), sin recurrentes, sin reserva de presupuesto, sin sintéticos.
// NO corre el prorrateo Citi — lo hace el orquestador (`canonicalProjection`).
// ─────────────────────────────────────────────────────────────────────────

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
import { isInternalCounterparty, isInternalProviderClassification } from '../../../domain/netCashFlowEngine';
import { getConcursoProviderIds, isConcursoMercantil, normalizeProviderId } from '../../../domain/concursoMercantil';
import type { Client, Provider } from '../../../domain/types';
import type { CobranzaRecord, ViajeEspecialRecord } from '../../../services/jdeTypes';
import type { CXPRecord } from '../../../domain/persistence';
import { buildViajesEspecialesCobranzaCross, buildViajesEspecialesFacturaKeys } from '../../../domain/viajesEspecialesCobranzaMatch';
import { normFactura } from '../../../domain/rolCobranzaMatch';
// Overlay de recibos — MISMA aritmética que el calendario de Cobranza,
// incluido el pozo por folio. No la reimplementes: `/cobranza` reporta un
// `Importe_Pendiente` inflado porque no aplica los cobros que
// `/cobranzaindicadores` sí registra.
import {
  buildReceiptSurplusByFolio,
  consumeReceiptSurplus,
  receiptOverlayKey,
} from '../../../domain/cobranzaReceiptsOverlay';
import { buildRolProjectedInflows, type RolProjectedInflow } from '../../../domain/rolProjectionEngine';
import { todayISO } from '../../../formatters';
import { enrichFromCatalog } from '../../../domain/providerCatalog';
import { calculateConfidenceBand } from './financialProjectionEngine';
import type {
  FinancialMovement,
  FinancialMovementCategory,
  FinancialTaxRate,
} from '../types';
import {
  buildPayrollCostMovements,
  buildPurchaseReceiptMovements,
  normalizeJde,
} from '../sourceRecords';
import {
  cleanDate,
  clientDisplayCounterparty,
  cxcFacturaKey,
  filterCobranzaByCompany,
  INCOME_SUBCAT_CITI,
  INCOME_SUBCAT_VIAJES_ESPECIALES,
  usableJdeProviderCategory,
  type BuildArgs,
  type CanonicalMonthlyPoint,
  type CanonicalProjectionInputs,
} from './canonicalProjectionShared';
import {
  buildProviderPayClassOverlay,
  rawPayClass,
  type PayClassPair,
} from './providerPayClassOverlay';

const DAY_MS = 86_400_000;

/**
 * MOTOR 2 — Proyección de corto plazo (> hoy). Emite SOLO datos reales de
 * corto plazo, cada uno fechado por SU regla. Sin balanceo a totales
 * canónicos, sin proyecciones rule-based genéricas (`client:`), sin
 * recurrentes, sin reserva de presupuesto, sin sintéticos. NO corre el
 * prorrateo Citi — lo hace el orquestador.
 */
export function buildShortTermProjectionMovements({ monthly, inputs }: BuildArgs): FinancialMovement[] {
  const out: FinancialMovement[] = [];
  const todayYm = toYearMonth(inputs.asOfDate);
  const inflowContext = buildInflowContext(inputs);
  // Proveedores en Concurso Mercantil: cualquier proveedor con AL MENOS una
  // factura ≤ CONCURSO_MERCANTIL_CUTOFF (deuda congelada). Sus pagos viven en
  // el módulo Concurso; aquí se excluyen para que su deuda fresca no entre dos
  // veces al flujo. Set indexado por noProveedor (trim + upper) — misma
  // normalización que `normalizeProviderId`.
  const concursoProviderIds = getConcursoProviderIds(inputs.cxpRecords);

  // 2) Meses futuros: SOLO datos reales de corto plazo.
  //    Inflows: CXC abierto (cobranza JDE pendiente) + ROL CITI (viajes
  //    ejecutados aún no facturados, fechados por catálogo).
  //    Outflows: CXP abierto + compras (OC con F_Recepcion+D_Credito) +
  //    nómina TRESS real (sin replicar). Sin balanceo a totales canónicos,
  //    sin proyecciones rule-based (`client:`), sin recurrentes, sin
  //    reserva de presupuesto, sin sintéticos de balance.
  const futureMonths = monthly.filter((m) => !m.isHistorical);
  const horizonYm = monthly[monthly.length - 1]?.yearMonth;
  // Clasificación de pago CRUDA por proveedor, tomada de los pagos que ya
  // cruzaron banco. Es la única fuente que trae el par completo; CXP y las OCs
  // la heredan de aquí para que un proveedor no cambie de grupo al pasar del
  // histórico al futuro. Se construye UNA vez (recorrerla por mes sería O(meses
  // × cargos)).
  // Se llavea con `normalizeJde` (no con el `providerJdeKey` local): es el
  // MISMO normalizador que usa `buildPurchaseReceiptMovements` para las OCs, así
  // que el overlay no puede quedar inerte por una divergencia de llave.
  const payClassByProvider = buildProviderPayClassOverlay(inputs.cargoEnrichments, normalizeJde);
  const purchaseMovementsByYm = groupMovementsByYearMonth(buildPurchaseReceiptMovements({
    purchaseReceipts: inputs.purchaseReceipts ?? [],
    cxpRecords: inputs.cxpRecords,
    companyCode: inputs.companyCode,
    asOfDate: inputs.asOfDate,
    excludeProviderIds: concursoProviderIds,
    paidPurchaseOrderKeys: inputs.paidPurchaseOrderKeys,
    providers: inputs.providers,
    payClassByProvider,
  }));
  for (const month of futureMonths) {
    const inflowLines = collectInflowLines(month, inputs, todayYm, inflowContext);
    out.push(...emitRawLines(inflowLines, 'INFLOW', inputs.asOfDate));

    const outflowLines = collectOutflowLines(month, inputs, todayYm, undefined, horizonYm, purchaseMovementsByYm.get(month.yearMonth) ?? [], concursoProviderIds, payClassByProvider);
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

    const outflowLines = collectOutflowLines(currentHistorical, inputs, todayYm, undefined, horizonYm, purchaseMovementsByYm.get(currentYm) ?? [], concursoProviderIds, payClassByProvider)
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
    payClass: line.payClass,
    payClassFinanciera: line.payClassFinanciera,
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
  payClass?: string;
  payClassFinanciera?: string;
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
  /**
   * `${cia}::${noFactura}` de facturas que pertenecen a viajes especiales.
   * Cuando una línea cxc: tiene su factura en este set, se reetiqueta
   * subcategory='Viajes Especiales' y el id pasa a `cxc:especial:`.
   */
  viajesEspFacturaKeys: Set<string>;
  /**
   * Viajes facturados con factura que cobranza JDE aún no expone. Se
   * agrupan por `yyyy-mm` del cobro proyectado (Fecha_Factura + Dias_Credito)
   * para emitir movimientos sintéticos `cxc:especial:` en `collectInflowLines`.
   */
  viajesEspUnmatchedByYm: Map<string, ViajeEspecialRecord[]>;
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
  // Viajes Especiales: cruce factura/UUID vs cobranza. Unmatched (factura
  // emitida pero cobranza aún no la tiene) se proyectan más abajo como
  // `cxc:especial:` con Fecha_Factura + Dias_Credito del API. Matched solo
  // sirve para re-etiquetar el cxc: existente con subcategory Viajes Especiales.
  const viajesRecords = (inputs.viajesEspecialesRecords ?? []).filter((v) =>
    inputs.companyCode === 'all' || !inputs.companyCode || v.cia === inputs.companyCode,
  );
  const viajesCross = buildViajesEspecialesCobranzaCross(viajesRecords, cxcRecords);
  const viajesEspFacturaKeys = buildViajesEspecialesFacturaKeys(viajesRecords);
  const viajesEspUnmatchedByYm = new Map<string, ViajeEspecialRecord[]>();
  for (const v of [...viajesCross.unmatched, ...viajesCross.withoutInvoice]) {
    const projectedDate = projectViajeEspecialDate(v, inputs.asOfDate);
    if (!projectedDate) continue;
    const ym = projectedDate.slice(0, 7);
    const arr = viajesEspUnmatchedByYm.get(ym);
    if (arr) arr.push(v);
    else viajesEspUnmatchedByYm.set(ym, [v]);
  }
  // Gateada a DEV: corre en el hot path del worker de proyección (cada run),
  // así que en producción no debe emitir ruido por-cómputo.
  if (import.meta.env.DEV && typeof console !== 'undefined' && viajesRecords.length > 0) {
    // eslint-disable-next-line no-console
    console.info(
      `[viajes-esp-diag] viajes=${viajesRecords.length} matched=${viajesCross.matched.length} `
      + `unmatched=${viajesCross.unmatched.length} sinFactura=${viajesCross.withoutInvoice.length} `
      + `· líneas cxc:especial: proyectadas=${Array.from(viajesEspUnmatchedByYm.values()).reduce((s, a) => s + a.length, 0)}`,
    );
    if (viajesCross.unmatched.length > 0) {
      // Contrato confirmado por negocio (2026-07-05): Factura_JDE usa el MISMO
      // consecutivo que cobranza.noFactura — el cruce debe dar ~100%. Un
      // unmatched persistente (con la ventana de cobranza cargada) es defecto
      // de datos a reportar a JDE.
      // eslint-disable-next-line no-console
      console.warn(
        `[viajes-esp-diag] ${viajesCross.unmatched.length} viajes FACTURADOS sin match en cobranza `
        + `(contrato: mismo consecutivo → esperado ~0). Folios: `
        + viajesCross.unmatched.slice(0, 10).map((v) => `${v.cia}:${v.facturaJDE}`).join(', ')
        + (viajesCross.unmatched.length > 10 ? ` … (+${viajesCross.unmatched.length - 10})` : ''),
      );
    }
  }

  return {
    cxcRecords,
    cxcCoverageByClientMonth,
    clientMatchByFactura,
    rolInflowsByYm,
    rolCoverageByClientMonth: rol.coverageByClientMonth,
    viajesEspFacturaKeys,
    viajesEspUnmatchedByYm,
  };
}

/**
 * Fecha de cobro proyectada para un Viaje Especial sin match en cobranza.
 * Usa Fecha_Factura + Dias_Credito (regla del API, no del catálogo).
 * Si no hay Fecha_Factura, cae a fSalidaPrimera (fecha del servicio).
 * Si ya venció (< asOfDate) se reagenda al siguiente día operativo.
 */
function projectViajeEspecialDate(
  viaje: ViajeEspecialRecord,
  asOfDate: string,
): string | null {
  const base = viaje.fechaFactura || viaje.fSalidaPrimera;
  if (!base) return null;
  const credit = Number.isFinite(viaje.diasCredito) && viaje.diasCredito > 0
    ? viaje.diasCredito
    : 30;
  const start = new Date(base + 'T00:00:00Z');
  if (Number.isNaN(start.getTime())) return null;
  start.setUTCDate(start.getUTCDate() + credit);
  const projected = start.toISOString().slice(0, 10);
  // Si ya venció, jala al siguiente día desde asOf (mismo trato que cxc:).
  if (projected < asOfDate) {
    const next = new Date(asOfDate + 'T00:00:00Z');
    next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString().slice(0, 10);
  }
  return projected;
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
  // Pozo de recibos COMPARTIDO por las dos capas de ingreso por factura (CXC
  // de /cobranza y el sintético de Viajes Especiales): el recibo es del folio,
  // no de la fuente que lo reporta, así que un pozo por capa podría descontar
  // el MISMO cobro dos veces si un folio apareciera en ambas. Se construye
  // sobre `context.cxcRecords` COMPLETO (antes del dedup por folio) y se agota
  // en orden — primero CXC, que es la fuente más autoritativa.
  const receiptSurplusByFolio = buildReceiptPool(inputs, context);
  const lines: RawLine[] = collectCxcInflowLines(month, inputs, context, receiptSurplusByFolio);

  // ROL: viajes ejecutados aún no facturados. Monto real ejecutado, fechado
  // por la regla de pago del catálogo (overlay /cobranza). `amountLocked` →
  // no se escala al total del Dashboard (mismo trato que `cxc:`).
  for (const inflow of context.rolInflowsByYm.get(month.yearMonth) ?? []) {
    // ROL proyectado siempre cae a Citi. Federal sólo aplica a ABONOs reales
    // no ligados a cliente/factura que caen en cuenta Federal.
    const rolSubcat = INCOME_SUBCAT_CITI;
    // Si el cliente ROL tiene grupo comercial, agrupa el ROL al grupo padre.
    const rolClient = inputs.clients.find((c) => c.id === inflow.clientId);
    const rolDisplay = rolClient ? clientDisplayCounterparty(rolClient) : { id: inflow.clientId, name: inflow.clientName };
    lines.push({
      id: `rol:${inflow.cia}:${inflow.clientId}:${inflow.date}`,
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

  // Viajes Especiales sin match en cobranza: proyectar el cobro con
  // Fecha_Factura + Dias_Credito DEL API (regla por viaje, no por catálogo).
  // Si una factura aparece después en cobranza, el cruce en el siguiente
  // boot moverá ese viaje a `matched` y aquí dejará de emitirse — el cxc:
  // de cobranza lo cubrirá (reetiquetado como Viajes Especiales).
  for (const viaje of context.viajesEspUnmatchedByYm.get(month.yearMonth) ?? []) {
    const projectedDate = projectViajeEspecialDate(viaje, inputs.asOfDate);
    if (!projectedDate || projectedDate.slice(0, 7) !== month.yearMonth) continue;
    const subTotal = viaje.totalNegociado;
    const brutoViaje = subTotal * 1.16;
    // MISMA regla que el CXC de /cobranza: si `/cobranzaindicadores` ya reporta
    // cobrado el folio de este viaje, no se proyecta como entrada futura. El
    // sintético existe justamente porque la factura NO está en /cobranza, así
    // que `cobradaBancoKeys` y el pozo de esa fuente no lo cubren; sin esto, un
    // viaje ya cobrado seguía proyectándose. Sólo a la baja — nunca suma.
    const ajusteViaje = consumeReceiptSurplus(
      receiptSurplusByFolio,
      receiptOverlayKey(viaje.cia, viaje.facturaJDE),
      brutoViaje,
    );
    const grossAmount = brutoViaje - ajusteViaje;
    if (grossAmount <= 0) continue;
    const facturaLabel = viaje.facturaJDE || `K_Renta ${viaje.kRenta}`;
    lines.push({
      id: `cxc:especial:viaje:${viaje.cia}:${viaje.kRenta}`,
      amount: grossAmount,
      date: projectedDate,
      concept: `Viaje especial ${facturaLabel} · ${viaje.dCliente || 'Cliente sin nombre'}`,
      category: 'AR_COLLECTION',
      subcategory: INCOME_SUBCAT_VIAJES_ESPECIALES,
      companyId: viaje.cia,
      counterpartyId: viaje.claveJDE || String(viaje.kCliente),
      counterpartyName: viaje.dCliente || undefined,
      counterpartyType: 'CUSTOMER',
      ruleApplied: viaje.fechaFactura
        ? `Viajes Especiales · Fecha_Factura + ${viaje.diasCredito || 30}d crédito`
        : `Viajes Especiales · viaje + ${viaje.diasCredito || 30}d crédito`,
      sourceSystem: 'JDE',
      sourceObjectId: viaje.facturaJDE || String(viaje.kRenta),
      issueDate: viaje.fechaFactura,
      forecastMethod: 'RULE',
      confidenceScore: viaje.facturaJDE ? 78 : 64,
      lockState: 'RESTRICTED',
      taxTreatment: 'IVA_CAUSED',
      taxRate: 16,
      // El IVA sigue al importe REALMENTE proyectado (mismo criterio que
      // `cxcTaxMeta` con `amountOverride`): si se desglosara sobre el bruto,
      // un viaje ya cobrado en parte seguiría aportando IVA de más al causado.
      // Sin ajuste se conserva `subTotal` tal cual — byte-idéntico, sin ruido
      // de punto flotante por dividir y multiplicar por 1.16.
      taxBaseAmount: ajusteViaje > 0 ? grossAmount / 1.16 : subTotal,
      taxAmount: ajusteViaje > 0 ? grossAmount - grossAmount / 1.16 : grossAmount - subTotal,
      comment: `Viaje especial reportado por API ${viaje.facturaJDE ? 'con factura' : 'sin factura'} y aún no presente en cobranza JDE. Crédito y fecha provienen del API de Viajes Especiales.${
        ajusteViaje > 0
          ? ` Saldo ajustado: /cobranzaindicadores reporta cobro de la factura ${viaje.facturaJDE} que /cobranza aún no refleja.`
          : ''
      }`,
      amountLocked: true,
    });
  }

  return lines;
}

/**
 * Excedente del recibo por folio, listo para consumirse. Se calcula sobre el
 * set COMPLETO de líneas de `/cobranza` (la Σ de `bruto − pendiente` tiene que
 * abarcar TODAS las líneas del folio, porque el recibo es del folio entero);
 * calcularlo sobre el set dedupeado subestimaría lo ya aplicado y el excedente
 * saldría inflado → descontaría de más.
 */
function buildReceiptPool(
  inputs: CanonicalProjectionInputs,
  context: InflowContext,
): Map<string, number> {
  return inputs.cobranzaAppliedByFactura
    ? buildReceiptSurplusByFolio(context.cxcRecords, inputs.cobranzaAppliedByFactura)
    : new Map<string, number>();
}

function collectCxcInflowLines(
  month: CanonicalMonthlyPoint,
  inputs: CanonicalProjectionInputs,
  context: InflowContext,
  receiptSurplusByFolio: Map<string, number>,
): RawLine[] {
  if (context.cxcRecords.length === 0) return [];
  const lines: RawLine[] = [];
  const seen = new Set<string>();
  // Facturas que el reconciliation engine ya cruzó al céntimo con un
  // ABONO bancario: el dinero ya está en los movimientos históricos del
  // banco. Si las re-proyectamos, queda doblada. Sólo las descartamos
  // cuando el cruce fue automático (status='cobrada-banco'); facturas en
  // revisión manual o sin cruce siguen como pendiente proyectada.
  const cobradaBancoKeys = inputs.cobradaBancoKeys ?? new Set<string>();
  // Overlay de recibos: `/cobranza` no aplica los cobros que
  // `/cobranzaindicadores` sí registra, así que su `Importe_Pendiente` viene
  // inflado ($345.3M medidos el 2026-09-07; $310.5M de la cía 00011, donde el
  // cruce bancario por factura no funciona y `cobradaBancoKeys` no alcanza).
  // Sólo corrige a la BAJA — ver `cobranzaReceiptsOverlay`.
  //

  for (const record of context.cxcRecords) {
    if (record.importePendientePesos <= 0) continue;
    // Factura intercompañía (empresa propia del grupo): traspaso, no
    // cobranza real. No proyectar como entrada de caja.
    if (isInternalCounterparty(record.rfc, record.nombreCliente)) continue;
    const key = cxcFacturaKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    if (cobradaBancoKeys.has(key)) continue;

    // Saldo EFECTIVO: se consume del pozo del folio lo que `/cobranza` aún no
    // reconoce, acotado al saldo vivo de esta línea. Una factura que Indicadores
    // reporta cobrada por completo sale de la proyección; una parcialmente
    // cobrada proyecta sólo su residuo.
    const ajustePorRecibo = consumeReceiptSurplus(
      receiptSurplusByFolio,
      receiptOverlayKey(record.cia, record.noFactura),
      record.importePendientePesos,
    );
    const pendienteEfectivo = record.importePendientePesos - ajustePorRecibo;
    if (pendienteEfectivo <= 0) continue;

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

    const taxMeta = cxcTaxMeta(record, clientMatch?.client, pendienteEfectivo);
    const confidenceScore = clientMatch
      ? Math.round(Math.min(92, 72 + clientMatch.confidence * 18))
      : 62;
    const dateReason = resolved
      ? resolved.reason
      : record.fechaVence
        ? 'Sin regla confiable; se usa vencimiento JDE.'
        : 'Sin regla confiable; se usa fecha de factura JDE.';

    // CXC proyectado: Citi por defecto, Viajes Especiales si la factura está
    // en el set de viajes especiales (cruce factura/UUID vs API).
    // normFactura: MISMA normalización que buildViajesEspecialesFacturaKeys —
    // un folio con espacios/guiones distintos debe re-etiquetar igual.
    const isViajeEspecialCxc = context.viajesEspFacturaKeys.has(
      `${record.cia}::${normFactura(record.noFactura)}`,
    );
    const cxcSubcat = isViajeEspecialCxc
      ? INCOME_SUBCAT_VIAJES_ESPECIALES
      : INCOME_SUBCAT_CITI;
    const cxcIdPrefix = isViajeEspecialCxc ? 'cxc:especial' : 'cxc';
    lines.push({
      id: `${cxcIdPrefix}:${record.cia}:${record.noCliente}:${record.noFactura}`,
      amount: pendienteEfectivo,
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
        // Confiesa el ajuste: el drilldown pinta el `importePendientePesos`
        // CRUDO del registro, así que sin esta línea el usuario ve un saldo
        // mayor que el importe proyectado y nada que lo explique. Espejo del
        // `statusLabel` que el calendario de Cobranza ya emite.
        ajustePorRecibo > 0
          ? `Saldo ajustado: /cobranzaindicadores reporta cobro que /cobranza aún no aplica (${Math.round(record.importePendientePesos).toLocaleString('es-MX')} → ${Math.round(pendienteEfectivo).toLocaleString('es-MX')}).`
          : '',
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
  /**
   * Overlay `claveProveedor → par de clasificación de pago CRUDA`, derivado de
   * los pagos ya ejecutados. `/antiguedadsaldos` no manda
   * `Clasificacion_Proveedor_Financiera`, así que sin esto el mismo proveedor
   * se agrupa distinto en el pasado que en el futuro (ver
   * `providerPayClassOverlay.ts`).
   */
  payClassByProvider: Map<string, PayClassPair> = new Map(),
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
    // no trae RFC — se matchea por nombre/código de empresa propia y, como
    // señal independiente, por la clasificación JDE "Filiales"/intercompañía
    // (el nombre puede llegar truncado o sin razón social).
    if (
      isInternalCounterparty(undefined, record.nombre)
      || isInternalProviderClassification(record.clasificacionProveedor)
      || isInternalProviderClassification(record.clasifica)
    ) return;
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
    const providerType = usableJdeProviderCategory(
      provider?.type,
      catalog.providerType,
      record.clasificacionProveedor,
      record.clasifica,
    ) || 'Sin clasificar';
    // Clasificación de pago CRUDA. `/antiguedadsaldos` sólo manda
    // `Clasificacion_Proveedor`; la financiera se hereda del overlay de pagos
    // ejecutados. Si el proveedor nunca se ha pagado, el par queda incompleto y
    // se muestra como tal — nunca se inventa.
    const overlayPayClass = payClassByProvider.get(normalizeJde(record.noProveedor));
    const payClass = rawPayClass(record.clasificacionProveedor || record.clasifica)
      ?? overlayPayClass?.payClass;
    const payClassFinanciera = overlayPayClass?.payClassFinanciera;
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
      payClass,
      payClassFinanciera,
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
      payClass: movement.payClass,
      payClassFinanciera: movement.payClassFinanciera,
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

// ── Helpers ──────────────────────────────────────────────────────────────

function addCoveredMonth(map: Map<string, Set<string>>, clientId: string, yearMonth: string): void {
  const set = map.get(clientId) ?? new Set<string>();
  set.add(yearMonth);
  map.set(clientId, set);
}

/**
 * Trae una factura CXC abierta a la ventana de proyección. Una fecha de cobro
 * estrictamente futura (> hoy) se respeta tal cual. Si la fecha esperada ya
 * pasó o cae HOY (≤ hoy), el cobro no se pierde: se reagenda al SIGUIENTE día
 * operativo después de hoy (saltando fines de semana y festivos bancarios).
 *
 * Espejo del payable (`moveOpenPayableIntoProjection`), pero con el corte en
 * `> asOfDate` y objetivo hoy+1: un cobro esperado para hoy se empuja a mañana
 * (el dinero aún no entró), mientras que un pago que vence hoy sí puede
 * liquidarse hoy mismo.
 */
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

/**
 * Trae una CXP vencida a la ventana de proyección. Un pago cuya fecha
 * programada/vencimiento es HOY o futura (≥ hoy) se respeta. Si ya venció
 * (< hoy) se reagenda al PRIMER día operativo a partir de hoy (hoy mismo si es
 * hábil) para que el scheduler decida si se paga, se recorre o queda pendiente.
 *
 * Diferencia con el receivable: el corte es `< asOfDate` (un pago que vence hoy
 * todavía puede liquidarse hoy) y el objetivo es hoy, no hoy+1.
 */
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

/**
 * Normaliza el nombre de un proveedor a una llave estable para emparejar el
 * registro JDE con el proveedor del catálogo: mayúsculas, sin acentos, sin
 * puntuación y con espacios colapsados. Así "Pemex, S.A." y "PEMEX SA" caen en
 * la misma llave.
 */
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

/**
 * Desglosa el saldo pendiente de una factura CXC en base gravable + IVA,
 * eligiendo la tasa 8% (región fronteriza) o 16% según el cliente del catálogo.
 */
function cxcTaxMeta(
  record: CobranzaRecord,
  client?: Client,
  // Saldo efectivo tras el overlay de recibos. El IVA debe desglosarse sobre
  // el importe que REALMENTE se proyecta; si no, una factura ya cobrada
  // según Indicadores seguiría aportando su IVA completo al causado FORECAST.
  amountOverride?: number,
): { taxRate: FinancialTaxRate; taxBaseAmount: number; taxAmount: number } {
  const rate = client?.ivaRate === 8 ? 8 : 16;
  const amount = amountOverride ?? record.importePendientePesos;
  return grossToIvaTaxMeta(amount, rate);
}

/**
 * Desglosa el IVA acreditable de una CXP. Prefiere los importes que JDE ya
 * reporta (subtotal + impuestos) escalados al saldo pendiente cuando la factura
 * está parcialmente pagada. Si JDE no trae esos campos o la tasa inferida no es
 * 8%/16%, cae a asumir 16% de IVA sobre el pendiente.
 */
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

/**
 * Infiere la tasa de IVA (8% o 16%) a partir de la base y el impuesto, con ±1
 * punto de tolerancia para redondeos. Devuelve undefined si no encaja en
 * ninguna de las dos tasas conocidas.
 */
function taxRateFromAmounts(base: number, taxAmount: number): FinancialTaxRate | undefined {
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(taxAmount) || taxAmount <= 0) return undefined;
  const pct = Math.round((taxAmount / base) * 100);
  if (Math.abs(pct - 16) <= 1) return 16;
  if (Math.abs(pct - 8) <= 1) return 8;
  return undefined;
}

/**
 * Parte un monto BRUTO (IVA incluido) en su base gravable y el IVA, a la tasa
 * dada. Es la inversa de "base × (1 + tasa)": base = bruto / (1 + tasa).
 */
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

/**
 * Reescala la base y el IVA de una línea cuando el monto proyectado difiere del
 * monto base (proporción lineal). Mantiene coherente el desglose fiscal si el
 * motor ajustó el monto de la línea antes de emitir el movimiento.
 */
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
