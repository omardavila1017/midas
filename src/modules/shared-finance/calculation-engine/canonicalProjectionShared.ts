// ─────────────────────────────────────────────────────────────────────────
// canonicalProjectionShared — tipos públicos del motor canónico + constantes
// de clasificación + helpers transversales usados por MOTOR 1
// (`historicalReconciledEngine`), MOTOR 2 (`shortTermProjectionEngine`) y el
// orquestador (`canonicalProjection`). No emite `FinancialMovement[]` por sí
// mismo — sólo provee los tipos y las piezas reutilizables. Sin dependencias
// circulares: este módulo NO importa de los motores ni del orquestador.
// ─────────────────────────────────────────────────────────────────────────

import type { BuildPredictiveResult } from '../../../domain/predictive';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { Client, Provider, CashFlowAssumptions } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import type { CobranzaRecord, RolRecord, ViajeEspecialRecord } from '../../../services/jdeTypes';
import { VIAJES_ESPECIALES_GROUP_ID } from '../../../domain/viajesEspecialesCatalog';
import { isPersonName } from '../../../domain/personNameHeuristic';
import type { BankInflowEnrichment } from '../../../domain/auxiliarProjectionAdapter';
import type { AuxiliarReconLine, ReconciledMonthTotals } from '../../../domain/auxiliarReconciliationEngine';
import type {
  FinancialMovement,
  PayrollCostRecord,
  PurchaseReceiptRecord,
} from '../types';

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
  /**
   * Viajes Especiales (API srv-desarrollo:95/ViajesEspeciales/Servicios).
   * Cada row trae Factura_JDE + Fecha_Factura + Dias_Credito propios. Se usa
   * para:
   *   1) Re-etiquetar facturas CXC que pertenecen a viajes especiales con
   *      subcategory='Viajes Especiales' (en vez del default 'Clientes Citi').
   *   2) Proyectar viajes facturados que aún no aparecen en cobranza JDE
   *      como `cxc:especial:` con Fecha_Factura + Dias_Credito del API.
   * Como cxc:, sólo afecta escenarios Aprobado/propuesta — Base filtra ids
   * que no estén en su allowlist de short-term API real.
   */
  viajesEspecialesRecords?: ViajeEspecialRecord[];
  purchaseReceipts?: PurchaseReceiptRecord[];
  payrollCosts?: PayrollCostRecord[];
  /**
   * `${cia}::${noFactura}` de facturas de cobranza ya confirmadas contra el
   * banco (derivado de AuxiliarContable vía `adaptAuxiliarForProjection`).
   * Estas facturas NO se re-proyectan como cobro pendiente — el dinero ya
   * está en los movimientos bancarios históricos. Sin esto la suma anual
   * queda doblada.
   */
  cobradaBancoKeys?: Set<string>;
  /**
   * Enriquecimiento de movimientos bancarios ABONO con su factura/cliente
   * (derivado de AuxiliarContable). Reclasifica ingresos históricos por
   * cliente en vez de dejarlos bajo "Transferencias".
   */
  abonoEnrichments?: BankInflowEnrichment[];
  /**
   * Set de `${cia}::${noFactura}::${noProveedor}` de CXPs marcadas PAID por
   * PagoProveedor. Espejo egreso de cobranzaReconciliation: estas facturas
   * NO se proyectan como egreso futuro — el cargo bancario real ya
   * descontó el dinero. Si está PARTIAL, se proyecta el residuo.
   */
  paidCxpKeys?: Set<string>;
  /**
   * Set de `${cia}::${noOrdenCompra}` de OCs cuya salida ya cruzó banco vía
   * AuxiliarContable. La proyección de compras (purchase receipts) las
   * descarta como egreso futuro — el dinero ya salió aunque CXP ya cerró el
   * saldo. Cierra el gap: sin esto, OC pagada cuyo CXP fue purgado del JDE
   * abierto se re-proyectaba indefinidamente.
   */
  paidPurchaseOrderKeys?: Set<string>;
  /**
   * Mapa `bankMovementKey(line)` → enriquecimiento PagoProveedor. Cuando un
   * CARGO histórico empata con un pago a proveedor, se reclasifica como
   * AP_PAYMENT con el nombre del proveedor — en vez de caer al cubo
   * genérico "Otros Egresos". Mismo patrón que `abonoEnrichments` para
   * cobranza (ingresos).
   */
  cargoEnrichments?: Map<string, { status: 'MATCHED' | 'ORPHAN'; payments?: Array<{
    claveProveedor?: string;
    nombreProveedor: string;
    clasificacionProveedor?: string;
    clasificacionProveedorFinanciera?: string;
    importe: number;
  }> }>;
  /**
   * Líneas del libro mayor JDE (AuxiliarContable) con su estado de
   * conciliación bancaria. Cuando un mes histórico (cia, ym) NO está cubierto
   * por estados de cuenta bancarios cargados, las líneas GL son la verdad
   * realizada — se emiten como movimientos sintéticos `auxiliar-historic:*`
   * para que Planeación muestre el flujo histórico incluso sin banco.
   * Espejo egreso de `cobranza-historic:*` (que sólo cubre ingresos vía
   * cobranza JDE). Líneas caja/interno se omiten.
   */
  auxiliarReconLines?: AuxiliarReconLine[];
  /**
   * MOTOR 1: ingreso/egreso reconciliado Auxiliar Contable × Bancos por
   * (cía, `yyyy-mm`). Cuando se provee, los brutos históricos REPORTADOS
   * (`monthly[].income/expense`) se re-sourcean a esta verdad contable; la
   * caja sigue anclada al banco. Ausente → brutos = Σ ABONO/CARGO bancario.
   */
  reconciledByCompanyMonth?: Map<string, ReconciledMonthTotals>;
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

/** Argumentos comunes a ambos motores: la trayectoria mensual canónica + los inputs. */
export interface BuildArgs {
  monthly: CanonicalMonthlyPoint[];
  inputs: CanonicalProjectionInputs;
}

// Cubos de ingreso en la tabla de Planeación. Reglas de negocio (confirmadas
// con el usuario 2026-05-15):
//   • ROL = viajes ejecutados (cobranza/CXC JDE, real o proyectado). TODO el
//     ROL es Senda Citi → bucket "Clientes Citi".
//   • Cobranza/CXC/ROL con cliente/factura = Citi, aunque el ABONO haya caído
//     en una cuenta bancaria Federal. La cuenta queda como metadato.
//   • Federal = ABONOs reales no ligados a cobranza/cliente que el catálogo
//     de bancos etiqueta unidadNegocio=FEDERAL.
//   • Otros ingresos = SOLO lo no reconocido.
const INCOME_SUBCAT_FEDERAL = 'Federal';
export const INCOME_SUBCAT_CITI = 'Clientes Citi';
export const INCOME_SUBCAT_VIAJES_ESPECIALES = 'Viajes Especiales';

/**
 * Reglas de negocio para enrutar un cobro al bucket de ingreso.
 * - Viajes Especiales: ABONO en cuenta del catálogo con
 *   `subRole === 'viajes_especiales'` (cuenta TRANSPORTES TAMAULIPAS
 *   "678 38444"). Domina sobre `unidadNegocio = FEDERAL` de esa misma
 *   cuenta — el subRole es más específico.
 * - Clientes Citi: cobranza/CXC/ROL con cliente/factura; también ABONOs a
 *   cuentas no-Federal o sin match.
 * - Federal: ABONOs reales NO ligados a cobranza/cliente que aterrizan en
 *   cuentas del catálogo con `unidadNegocio === 'FEDERAL'`.
 */
const VIAJES_ESPECIALES_SUBROLE = 'viajes_especiales';

/** subRole del catálogo de las cuentas concentradoras de clientes comerciales Citi. */
export const CITI_CLIENT_SUBROLE = 'clientes_citi';

/**
 * Si el cliente pertenece a un grupo comercial, devuelve el GRUPO PADRE como
 * counterparty. Esto colapsa las subsidiarias debajo de su padre en la tabla
 * de Planeación. Si no hay grupo, se queda con el cliente individual.
 */
export function clientDisplayCounterparty(client: { id: string; name?: string; commercialGroupId?: string; commercialGroupName?: string }): { id: string; name?: string } {
  if (client.commercialGroupId && client.commercialGroupName) {
    return { id: client.commercialGroupId, name: client.commercialGroupName };
  }
  return { id: client.id, name: client.name };
}

export function resolveInflowSubcategory(args: {
  counterpartyId?: string;
  /** Nombre del counterparty (cliente o concepto). Se usa como fallback de
   *  clasificación Viajes Especiales por heurística de nombre persona cuando
   *  el catálogo aún no promovió al cliente al grupo. */
  counterpartyName?: string;
  clientById: Map<string, Client>;
  businessUnitId?: string;
  /** `subRole` del catálogo de cuentas bancarias (`viajes_especiales`,
   *  `nomina_operadores`, etc.). Cuando vale `viajes_especiales` el ABONO
   *  va al bucket Viajes Especiales aunque `unidadNegocio` sea FEDERAL —
   *  el subRole es más específico. */
  bankSubRole?: string | null;
  /** El ingreso proviene de un viaje ejecutado (cobranza/CXC JDE). Marca
   *  informativa; ROL nunca se clasifica como Federal por sí solo. */
  isRolCollection?: boolean;
}): string {
  // 1) subRole `viajes_especiales` manda sobre cualquier otra señal.
  if (args.bankSubRole === VIAJES_ESPECIALES_SUBROLE) {
    return INCOME_SUBCAT_VIAJES_ESPECIALES;
  }
  // 2) Cliente del grupo Viajes Especiales (catálogo, auto-poblado desde el
  //    API de Viajes Especiales o por isPersonName en AppCore). Manda sobre
  //    Federal por cuenta — un ABONO de un cliente VE que cae en una cuenta
  //    unidadNegocio=FEDERAL sigue siendo VE, no Federal.
  if (args.counterpartyId) {
    const client = args.clientById.get(args.counterpartyId);
    if (client?.commercialGroupId === VIAJES_ESPECIALES_GROUP_ID) {
      return INCOME_SUBCAT_VIAJES_ESPECIALES;
    }
  }
  // 3) Fallback por NOMBRE: nombre de persona física → Viajes Especiales.
  //    Cubre el caso "cliente auto-creado del API JDE pero aún no promovido
  //    al grupo del catálogo" (auto-poblado del API VE no corrió, o cliente
  //    venía de un static catalog con id no-`auto-*`). Solo aplica cuando
  //    SÍ existe match a cobranza (counterpartyId presente) — sin eso
  //    `counterpartyName` puede ser el banco genérico y daría falsos positivos.
  if (args.counterpartyId && args.counterpartyName && isPersonName(args.counterpartyName)) {
    return INCOME_SUBCAT_VIAJES_ESPECIALES;
  }
  // 4) Cobranza/CXC/ROL con cliente/factura manda como Citi. La cuenta
  //    bancaria se conserva en `businessUnitId`, pero no reclasifica a
  //    Federal un ingreso comercial de Citi.
  if (args.isRolCollection) {
    return INCOME_SUBCAT_CITI;
  }
  // 5) Federal SOLO para ABONOs reales no ligados a cobranza/cliente que
  //    caen en una cuenta Federal del catálogo.
  if (args.businessUnitId && String(args.businessUnitId).toUpperCase() === 'FEDERAL') {
    return INCOME_SUBCAT_FEDERAL;
  }
  // 6) Default: Clientes Citi (ABONO no-Federal o sin match).
  return INCOME_SUBCAT_CITI;
}

// ── Helpers transversales ─────────────────────────────────────────────────

export function cleanDate(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined;
}

export function filterCobranzaByCompany(records: CobranzaRecord[], companyCode: string): CobranzaRecord[] {
  if (companyCode === 'all' || !companyCode) return records;
  return records.filter((record) => record.cia === companyCode);
}

export function cxcFacturaKey(record: CobranzaRecord): string {
  return `${record.cia}::${record.noFactura}`;
}

export function usableJdeProviderCategory(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    const normalized = normalizeJdeProviderCategory(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function normalizeJdeProviderCategory(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\s+/g, ' ');
  if (!trimmed) return undefined;
  const withoutPrefix = trimmed.replace(/^\d{2,4}\s*-\s*/, '').trim();
  if (!withoutPrefix) return undefined;
  if (/^POR\s*CLASIFICAR$/i.test(withoutPrefix)) return undefined;
  if (/^SIN\s*(CLASIFICAR|CATEGOR[IÍ]A)$/i.test(withoutPrefix)) return undefined;
  if (/^N\/?A$/i.test(withoutPrefix)) return undefined;
  return withoutPrefix;
}
