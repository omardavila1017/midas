/**
 * Tipos de datos para los APIs de JD Edwards.
 *
 * Endpoints consumidos (api.gruposenda.com/v1/erp/tesoreria):
 *   1. POST /antiguedadsaldos  → CXP / aging buckets
 *   2. POST /bancos            → Estados de cuenta bancarios
 *   3. GET  /empresas          → Catálogo de compañías
 *
 * Los shapes normalizados están alineados con los tipos ya usados en la
 * aplicación (p.ej. CXPRecord en components/CXP.tsx) para que los datos
 * lleguen directos a los dashboards existentes sin re-mapeo.
 */

// ───────────────────────────────────────────────────────────────
// 1. Antigüedad de Saldos (CXP)
// ───────────────────────────────────────────────────────────────

/** Request body para POST /antiguedadsaldos. */
export interface AgedBalanceRequest {
  /**
   * Código de compañía JDE (p.ej. "00011"). UNA sola compañía por request.
   *
   * ⚠️ Patrones que el server rechaza (validado contra prod 2026-04-20):
   *   • Múltiples objetos `{"cia":"00011"},{"cia":"00038"}` → 400
   *   • N requests paralelos (uno por cia simultáneo)      → 500 (contención)
   *   • CSV en el valor `{"cia":"00011,00038"}`            → 500 (lo sugirió
   *     el equipo JDE como hipótesis pero no funciona en realidad)
   *
   * Único patrón que funciona: una compañía por request, secuenciales
   * (await en serie). Cada request tarda ~60s, así que para múltiples
   * compañías hay que hacer merge incremental para dar feedback al usuario.
   */
  cia: string;
}

/**
 * Registro normalizado de antigüedad de saldos.
 * Mismos campos que CXPRecord (ver components/CXP.tsx) para reusar el dashboard.
 */
export interface AgedBalanceRecord {
  cia: string;
  noProveedor: string;
  nombre: string;
  noFactura: string;
  fechaFactura: string;
  fechaVence: string;
  fechaProgramacionPago: string;
  diasVencida: number;
  importeBrutoPesos: number;
  importePendientePesos: number;
  importeSubtotalPesos: number;
  importeImpuestosPesos: number;
  importeBrutoDolares: number;
  importePendienteDolares: number;
  moneda: string;
  condPago: string;
  clasifica: string;
  clasificacionProveedor: string;
  edoPago: string;
  tipoCambio: number;
  porVencer: number;
  v1_30: number;
  v31_60: number;
  v61_90: number;
  v91_120: number;
  v121_150: number;
  v151_180: number;
  mas180: number;
}

// ───────────────────────────────────────────────────────────────
// 2. Bancos (Estado de Cuenta)
// ───────────────────────────────────────────────────────────────

export type BankStatementFormat = 'SWIFT' | 'BAI2' | 'MT940' | string;

/** Request body para POST /bancos. */
export interface BankStatementRequest {
  /** Fecha del estado de cuenta en formato ISO (YYYY-MM-DD). */
  fechaEstadoCuenta: string;
  /** Formato electrónico solicitado al banco. */
  formatoElectronico: BankStatementFormat;
}

/** Tipo de movimiento bancario. */
export type BankMovementType = 'CARGO' | 'ABONO' | string;

/**
 * Línea de estado de cuenta bancario normalizada.
 * Los campos siguen convenciones JDE en español; se marcan opcionales los
 * que pueden no venir en todos los formatos (SWIFT vs. BAI2 vs. MT940).
 */
export interface BankStatementLine {
  /** Código de la compañía dueña de la cuenta. */
  cia: string;
  /** Código del banco (catálogo JDE). */
  banco: string;
  /** Nombre legible del banco. */
  nombreBanco?: string;
  /** Número de cuenta bancaria. */
  cuenta: string;
  /** Moneda del movimiento (MXN, USD, ...). */
  moneda: string;
  /** Fecha de operación (ISO YYYY-MM-DD). */
  fechaOperacion: string;
  /** Fecha valor (ISO YYYY-MM-DD), si aplica. */
  fechaValor?: string;
  /** Referencia bancaria / folio. */
  referencia: string;
  /** Descripción / concepto del movimiento. */
  concepto: string;
  /** Tipo: CARGO (salida) o ABONO (entrada). */
  tipoMovimiento: BankMovementType;
  /** Importe positivo (el signo se deriva de tipoMovimiento). */
  importe: number;
  /** Saldo contable al cierre del movimiento, si el banco lo reporta. */
  saldo?: number;
}

/**
 * Agrupación por cuenta — útil para el dashboard de tesorería.
 * El API puede devolver líneas sueltas o un objeto agrupado; el service
 * normaliza a esta forma.
 */
export interface BankAccountStatement {
  cia: string;
  banco: string;
  nombreBanco?: string;
  cuenta: string;
  moneda: string;
  fechaEstadoCuenta: string;
  saldoInicial?: number;
  saldoFinal?: number;
  movimientos: BankStatementLine[];
}

// ───────────────────────────────────────────────────────────────
// 3. Empresas (catálogo de compañías)
// ───────────────────────────────────────────────────────────────

export interface Company {
  /** Código JDE (p.ej. "00011"). */
  cia: string;
  /** Razón social / nombre comercial. */
  nombre: string;
  /** RFC, si el API lo expone. */
  rfc?: string;
  /** Moneda base de la compañía. */
  monedaBase?: string;
  /** Si está activa para operaciones. */
  activa?: boolean;
}

// ───────────────────────────────────────────────────────────────
// Errores
// ───────────────────────────────────────────────────────────────

export class JdeApiError extends Error {
  readonly status: number;
  readonly endpoint: string;
  readonly body?: unknown;

  constructor(message: string, status: number, endpoint: string, body?: unknown) {
    super(message);
    this.name = 'JdeApiError';
    this.status = status;
    this.endpoint = endpoint;
    this.body = body;
  }
}
