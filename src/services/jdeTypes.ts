/**
 * Tipos de datos para los APIs de JD Edwards.
 *
 * Endpoints consumidos (api.gruposenda.com/JDEdwards):
 *   1. POST /antiguedadsaldos  → CXP / aging buckets
 *   2. POST /bancos            → Estados de cuenta bancarios
 *   3. GET  /empresas          → Catálogo de compañías
 *   4. POST /cobranza          → Cobranza (CXC) por compañía y rango
 *   5. POST /indicadorescobranza → Pagos/recibos y aplicaciones CXC
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
  /** No. de recibo JDE reportado por bancos, si viene en el API. */
  noRecibo?: string;
  /** Descripción / concepto del movimiento. */
  concepto: string;
  /** Tipo: CARGO (salida) o ABONO (entrada). */
  tipoMovimiento: BankMovementType;
  /** Importe positivo (el signo se deriva de tipoMovimiento). */
  importe: number;
  /** Saldo contable al cierre del movimiento, si el banco lo reporta. */
  saldo?: number;
  /** Identificador raw del estado/movimiento en JDE. */
  gsaid?: string;
  /** Cuenta contable JDE, p.ej. "11.1020.0011302"; llave para IndicadoresCobranza. */
  cuentaContable?: string;
  /** Cuenta bancaria raw de JDE antes de trim/normalización. */
  cuentaBancos?: string;
  /** Nombre raw de la cuenta contable de JDE. */
  nombreCuentaContable?: string;
  /** Fecha raw de estado de cuenta que devuelve JDE. */
  fechaEstadoCuenta?: string;
  /** Tipo raw de cuenta bancaria. */
  tipoCuentaBancos?: string;
  /** Descripción de tipo/cuenta bancaria. */
  desc039?: string;
  /** Descripción de moneda/categoría 36. */
  desc036?: string;
  /** Código de transacción bancaria raw. */
  codigoTransaccionBanco?: string;
  /** Referencia de cliente raw. */
  referenciaCliente?: string;
  /** Campos adicionales raw de JDE usados para trazabilidad y conciliación. */
  infAdi1?: string;
  infAdi2?: string;
  infAdi3?: string;
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
  cuentaContable?: string;
  cuentaBancos?: string;
  nombreCuentaContable?: string;
  tipoCuentaBancos?: string;
  desc039?: string;
  desc036?: string;
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
// 4. Cobranza (CXC)
// ───────────────────────────────────────────────────────────────

/**
 * Request body para POST /cobranza.
 *
 * El equipo JDE liberó este endpoint en producción (2026-05-01). Body de
 * referencia compartido por ellos:
 *   {
 *     "cia": "00011,",          // código de compañía (acepta trailing coma)
 *     "fechaInicial": null,      // null = sin límite inferior
 *     "fechaFinal": "2026-04-29" // ISO YYYY-MM-DD
 *   }
 *
 * Notas:
 *   • `fechaInicial` puede ser null para traer todo el histórico hasta la
 *     fecha final (mismo patrón que /antiguedadsaldos).
 *   • Como en /antiguedadsaldos, una compañía por request — para múltiples
 *     companias hay que llamar secuencial y mergear.
 */
export interface CobranzaRequest {
  /** Código de compañía JDE (p.ej. "00011"). */
  cia: string;
  /** Fecha inicial inclusive (YYYY-MM-DD) o null para sin límite inferior. */
  fechaInicial: string | null;
  /** Fecha final inclusive (YYYY-MM-DD). */
  fechaFinal: string;
}

/**
 * Registro normalizado de cobranza (CXC).
 *
 * Forma tolerante: el API está recién liberado y los nombres exactos de
 * campos pueden variar. El mapper en jde.ts intenta varios alias y deja
 * los campos como strings/números seguros. Conserva además el raw record
 * para poder inspeccionar campos no mapeados desde la UI durante el
 * shakedown.
 */
export interface CobranzaRecord {
  cia: string;
  noCliente: string;
  nombreCliente: string;
  rfc?: string;
  noFactura: string;
  fechaFactura: string;
  fechaVence: string;
  fechaCobro: string;
  fechaContable?: string;
  diasVencida: number;
  importeBrutoPesos: number;
  importePendientePesos: number;
  importeBrutoDolares: number;
  importePendienteDolares: number;
  moneda: string;
  condPago: string;
  estatus: string;
  tipoCambio: number;
  tasaFiscal?: string;
  subTotal?: number;
  importeIVA?: number;
  importeRetencion?: number;
  uuidFiscal?: string;
  /** Día de pago CC13 expuesto por /cobranza, p.ej. "LUN". */
  claveDiaPagoCc13?: string;
  /** Nombre del día de pago CC13, p.ej. "LUNES". */
  nombreDiaPagoCc13?: string;
  /** Recibo JDE que pagó la factura; llave fuerte para cruce con /bancos No_Recibo. */
  noReciboSePagoFactura?: string;
  /**
   * Grupo comercial autoridad JDE. Cuando varias razones sociales pertenecen
   * al mismo conglomerado JDE las consolida bajo un mismo No_Cliente_Padre.
   * Campo agregado al endpoint de cobranza el 2026-05-14.
   *
   * Edge case: `49080179` "Resto Clientes" es un bucket genérico JDE que NO
   * representa un grupo real — son clientes huérfanos sin padre asignado.
   * El grouping engine debe tratarlo como "individual" no como grupo.
   */
  noClientePadre?: string;
  /** Razón social comercial del padre (autoridad de UI). Trim aplicado. */
  nombreClientePadre?: string;
  /**
   * Días de crédito contractuales según JDE (numérico). Campo agregado al
   * endpoint el 2026-05-14. Reemplaza el string `condPago` para reglas de
   * pago — `condPago` sigue presente para compatibilidad.
   */
  diasCredito?: number;
  /** Clave del día de pago preferido (CC13 catálogo JDE), p.ej. "027". */
  diaPagoClave?: string;
  /** Nombre del día de pago preferido, p.ej. "Viernes". Trim aplicado. */
  diaPagoNombre?: string;
  /**
   * Clave de la frecuencia de facturación (CC17 catálogo JDE), p.ej. "3".
   * Campo agregado al endpoint el 2026-05-19.
   */
  frecuenciaFacturacionClave?: string;
  /**
   * Nombre de la frecuencia de facturación, p.ej. "MENSUAL" / "SEMANAL" /
   * "QUINCENAL". Trim aplicado. Es la cadencia con que el cliente factura;
   * cuando viene poblada es autoridad JDE sobre `Client.frequency` del
   * catálogo estático (mismo patrón que `diasCredito` / `diaPagoNombre`).
   * Campo agregado al endpoint el 2026-05-19.
   */
  frecuenciaFacturacionNombre?: string;
}

// ───────────────────────────────────────────────────────────────
// 5. Indicadores de Cobranza (recibos / aplicaciones)
// ───────────────────────────────────────────────────────────────

export interface CobranzaPaymentRequest {
  cia: string;
  fechaInicial: string | null;
  fechaFinal: string;
}

export interface CobranzaPaymentApplication {
  idPago: string;
  cia: string;
  fechaAplicacion: string;
  noCliente: string;
  cliente: string;
  tipoDocto: string;
  noFactura: string;
  noFacturaNormalizada: string;
  fechaFactura: string;
  fechaVencimiento: string;
  diasAntiguedadFafv: number;
  importeCobrado: number;
  importeOriginalFactura: number;
  tasaIva: string;
  importeIvaFacturaOriginal: number;
}

export interface CobranzaPayment {
  idPago: string;
  cia: string;
  fechaCobro: string;
  fechaContable: string;
  cuentaBancaria: string;
  banco: string;
  noRecibo: string;
  importeRecibo: number;
  pendienteAplicar: number;
  noCliente: string;
  cliente: string;
  noBatch: string;
  tipoCambio: number;
  applications: CobranzaPaymentApplication[];
}

// ───────────────────────────────────────────────────────────────
// 6. Compras (Órdenes de Compra)
// ───────────────────────────────────────────────────────────────

/**
 * Request body para POST /JDEdwards/compras.
 *
 * Endpoint liberado a producción el 2026-05-08 por el equipo JDE.
 *
 * Restricción documentada por JDE: el endpoint solo procesa rangos de hasta
 * 30 días por request. Para periodos mayores, partir en bloques y mergear
 * (ver `fetchComprasRange` en jde.ts).
 *
 * Cambio JDE 2026-05-19 (dev): el body ahora exige `cia` — hay que consultar
 * UNA compañía por request (mismo patrón que /antiguedadsaldos y /cobranza).
 * Antes el endpoint era global (todas las cías en una respuesta). El día que
 * esto pase a producción, omitir `cia` deja al módulo sin datos.
 *
 * El payload de respuesta trae ~40 campos por OC. Tras revisión del equipo
 * de tesorería (2026-05-12) consumimos todos los campos pero solo usamos
 * un subset para proyectar egreso a corto plazo:
 *   - núcleo: C_Proveedor, N_Proveedor, Precio_T, F_Recepcion, D_Credito
 *   - filtros: N_Orden, N_Factura, F_Cancelada, Compañia
 *   - agrupación/UI: T_Moneda, Tipo_Cambio, Categoria/Familia, Centro_Costos
 */
export interface ComprasRequest {
  /** Código de compañía JDE (p.ej. "00011"). UNA compañía por request. */
  cia: string;
  /** Fecha inicial inclusive (YYYY-MM-DD). */
  fechaInicial: string;
  /** Fecha final inclusive (YYYY-MM-DD). Máx 30 días respecto a fechaInicial. */
  fechaFinal: string;
}

/**
 * Registro normalizado de una orden de compra (OC).
 *
 * `fechaPagoProyectada` se computa local: si hay F_Recepcion válida →
 * `F_Recepcion + D_Credito días`. Si F_Recepcion = "1899-12-31" → '' y la OC
 * cae en el bucket "Pendiente recepción" en la UI (no se cuenta en cash flow
 * proyectado hasta que se reciba).
 *
 * `cancelada` y `facturada` son flags derivados:
 *   - cancelada: F_Cancelada ≠ 1899-12-31.
 *   - facturada: N_Factura no vacío (CXP / módulo Facturas la cubrirá).
 */
export interface ComprasRecord {
  /** Compañía JDE normalizada a 5 dígitos (p.ej. "00001"). */
  cia: string;
  /** Código numérico de proveedor (C_Proveedor). */
  noProveedor: string;
  /** Nombre del proveedor (N_Proveedor, trim). */
  nombreProveedor: string;
  /** Número de orden de compra (N_Orden). */
  noOrden: string;
  /** Tipo de orden raw (T_Orden). */
  tipoOrden: string;
  /** Descripción del tipo de orden (D_T_Orden, trim). */
  descTipoOrden: string;
  /** Línea de la orden (L_Orden) — para distinguir OCs multi-producto. */
  lineaOrden: number;
  /** Producto (C_Producto, trim). */
  noProducto: string;
  /** Descripción del producto (D_Producto, trim). */
  descProducto: string;
  /** Concepto raw de la OC (trim). */
  concepto: string;
  /** Cantidad ordenada. */
  cantidad: number;
  /** Precio unitario. */
  precioUnitario: number;
  /** Importe total (Precio_T) — base del egreso proyectado. */
  importeTotal: number;
  /** Moneda (T_Moneda). MXP / USD / etc. */
  moneda: string;
  /** Tipo de cambio (1 cuando moneda = MXP). */
  tipoCambio: number;
  /** Fecha de pedido (F_Pedido, YYYY-MM-DD). */
  fechaPedido: string;
  /**
   * Fecha de recepción (F_Recepcion, YYYY-MM-DD). Vacía si la OC aún no se
   * ha recibido (JDE manda "1899-12-31" para "no recibida").
   */
  fechaRecepcion: string;
  /** Días de crédito (D_Credito). */
  diasCredito: number;
  /**
   * Fecha proyectada de pago = fechaRecepcion + diasCredito. Vacía si la OC
   * aún no se ha recibido.
   */
  fechaPagoProyectada: string;
  /** Número de factura asociada (vacío si la OC aún no se ha facturado). */
  noFactura: string;
  /** Centro de costos (trim). */
  centroCostos: string;
  /** Categoría / Desc_Categoria. */
  categoria: string;
  descCategoria: string;
  /** Familia / Desc_Familia. */
  familia: string;
  descFamilia: string;
  /** SubFamilia / Desc_SubFamilia. */
  subFamilia: string;
  descSubFamilia: string;
  /** Estado workflow siguiente (Edo_Sig). 380 = recibido facturado, etc. */
  estadoSiguiente: string;
  /** Tasa fiscal raw (IVA16, etc.). */
  tasaFiscal: string;
  /** Flag derivado: F_Cancelada ≠ 1899-12-31. */
  cancelada: boolean;
  /** Flag derivado: N_Factura no vacío. */
  facturada: boolean;
}

// ───────────────────────────────────────────────────────────────
// 6b. Auxiliar Contable (libro mayor JDE por cuenta de banco/caja)
// ───────────────────────────────────────────────────────────────

/**
 * Request body para POST /JDEdwards/AuxiliarContable. UNA compañía por
 * request (como /compras, /cobranza). Devuelve el libro mayor de JDE
 * posteado contra las cuentas del rango de objeto contable indicado.
 *
 * Para la conciliación histórica banco↔ERP se usa `tl="AA"` (libro mayor
 * real), `objIni="1010"`/`objFin="1020"` (Caja + Bancos). Esas constantes
 * viven en `domain/auxiliarReconciliationConfig.ts`.
 */
export interface AuxiliarContableRequest {
  /** Código de compañía JDE (p.ej. "00042"). */
  cia: string;
  /** Fecha inicial inclusive (YYYY-MM-DD). */
  fechaInicial: string;
  /** Fecha final inclusive (YYYY-MM-DD). */
  fechaFinal: string;
  /** Tipo de libro JDE. "AA" = libro mayor real. */
  tl: string;
  /** Parámetro numérico del API (valor documentado: 999). */
  nr: number;
  /** Objeto contable inicial del rango (p.ej. "1010"). */
  objIni: string;
  /** Objeto contable final del rango (p.ej. "1020"). */
  objFin: string;
}

/**
 * Registro normalizado de una línea del libro mayor JDE posteada contra
 * una cuenta de banco/caja. Cada línea es trazable a su documento fuente:
 * `noFactura` (cobranza/CXC), `noOrdenCompra` (compras), `tipoPago`+`noPago`
 * (pago a proveedor). `estatusConciliado="R"` = JDE ya la concilió.
 *
 * `flujo` se deriva localmente del signo de `importe` (ver `deriveFlujo` en
 * auxiliarReconciliationEngine.ts — chokepoint único).
 */
export interface AuxiliarContableRecord {
  /** Compañía JDE normalizada a 5 dígitos. */
  cia: string;
  /** Cuenta contable completa (Cuenta, trim — p.ej. "42.1020.0010409"). */
  cuentaContable: string;
  /** Id de cuenta (IdCuenta). */
  idCuenta: string;
  /** Objeto contable (Cuenta_Objeto, trim — "1010" caja | "1020" bancos). */
  cuentaObjeto: string;
  /** Nombre de la cuenta contable (Nombre_Cta, trim). */
  nombreCuenta: string;
  /** Número de cuenta bancaria (Cuenta_Banco, trim) — enlaza con /bancos. */
  cuentaBanco: string;
  /** Tipo de documento JDE (Tipo_Docto, trim). */
  tipoDocto: string;
  /** Número de documento (No_Docto). */
  noDocto: number;
  /** Número de factura asociada (No_Factura, trim). */
  noFactura: string;
  /** Número de orden de compra asociada (No_Orden_Compra, trim). */
  noOrdenCompra: string;
  /** Fecha contable normalizada a YYYY-MM-DD (de Fecha_Contable_ddmmaa). */
  fechaContable: string;
  /** Tipo de libro (Tipo_Libro — "AA"). */
  tipoLibro: string;
  /** Número de batch (No_Batch). */
  noBatch: number;
  /** Tipo de batch (Tipo_Batch, trim). */
  tipoBatch: string;
  /** Estatus de conciliación JDE (Estatus_conciliado — "R" = conciliado). */
  estatusConciliado: string;
  /** Importe del asiento. El signo codifica dirección (ver deriveFlujo). */
  importe: number;
  /** Moneda (Moneda — "MXP" / "USD"). */
  moneda: string;
  /** Tipo de cambio (Tipo_Cambio). */
  tipoCambio: number;
  /** Estado de posteo (Posteo — "P" = posteado). */
  posteo: string;
  /** Marca de reversa (Reversa, trim). */
  reversa: string;
  /** Concepto raw del asiento (trim). */
  concepto: string;
  /** Explicación del asiento (explicacion, trim). */
  explicacion: string;
  /** Nombre de la contraparte (Nombre, trim). */
  nombre: string;
  /** Tipo de pago (tipo_pago, trim) — junto con noPago enlaza a pagoProveedor. */
  tipoPago: string;
  /** Número de pago (no_pago, trim). */
  noPago: string;
  /** Fecha de pago normalizada a YYYY-MM-DD (de Fecha_pago_ddmmaa). */
  fechaPago: string;
  /** Documento original (documento_Original, trim). */
  documentoOriginal: string;
  /** Importe original del documento (Importe_Original). */
  importeOriginal: number;
}

// ───────────────────────────────────────────────────────────────
// 7. Nómina (TRESS — namespace upstream /v1/erp/tress)
// ───────────────────────────────────────────────────────────────

/**
 * Request body para POST /nomina (TRESS).
 *
 * Documentación de equipo JDE/TRESS (2026-05-12):
 *   - `idEmpresa`: 1 Federal | 11 SIR | 17 SIT | 33 Multicarga | 42 TICH | 99 Todas
 *   - `tipoNomina`: 1 Semana y Operadores | 3 Quincena y Ejecutivos | 99 Todas
 *
 * Una request por (idEmpresa, tipoNomina, anio, mes). 99 funciona como
 * comodín en idEmpresa y tipoNomina, así que para backfill anual basta con
 * 12 requests (uno por mes) con `idEmpresa=99, tipoNomina=99`.
 */
export interface NominaRequest {
  idEmpresa: number;
  tipoNomina: number;
  anio: number;
  mes: number;
}

/**
 * Shape crudo devuelto por TRESS. Los campos vienen en PascalCase y existe
 * un typo conocido en `Fechainical` (sic, con `i` minúscula en el medio).
 * El mapper en jde.ts es tolerante a variantes via `pick()`.
 */
export interface NominaRawRecord {
  IDEmpresa: number;
  Empresa: string;
  Monto: number;
  Periodo: number;
  Mes: string;
  IDConcepto: number;
  Concepto: string;
  TipoNomina: string;
  TipoConcepto: string;
  /** Typo en el API productivo (debería ser FechaInicial). */
  Fechainical?: string;
  FechaInicial?: string;
  FechaFinal: string;
  FechaPago: string;
}

// ───────────────────────────────────────────────────────────────
// 8. PagoProveedor (Pagos ejecutados — espejo egreso de Cobranza)
// ───────────────────────────────────────────────────────────────

/**
 * Request body para POST /JDEdwards/pagoproveedor.
 *
 * Endpoint productivo publicado por el equipo JDE: devuelve los pagos
 * EFECTIVAMENTE ejecutados a proveedores en el rango indicado. Es el
 * espejo egreso de /cobranza (que trae los cobros ejecutados).
 *
 * A diferencia de /compras (límite 30 días) el endpoint acepta rangos
 * amplios sin chunking forzado. Para volúmenes grandes usar el helper
 * `fetchPagoProveedorRange` que cachea por día.
 */
export interface PagoProveedorRequest {
  /** Fecha inicial inclusive (YYYY-MM-DD). */
  fechaInicial: string;
  /** Fecha final inclusive (YYYY-MM-DD). */
  fechaFinal: string;
}

/**
 * Registro normalizado de un pago a proveedor.
 *
 * Notas de formato JDE crudo:
 *   - `Fecha_Pago` viene como "DD-MM-YYYY" (Mexicano), NO ISO. El mapper
 *     normaliza a "YYYY-MM-DD".
 *   - `Cuenta_Bancaria` es texto descriptivo (p.ej. "38.1020.0010405 -
 *     BANAMEX - 7013 8708851"). El número crudo para cruce con el módulo
 *     Bancos viene en `Cuenta_Banco` (p.ej. "70138708851").
 *   - `Comentario_Pago` suele referenciar el folio CXP (p.ej.
 *     "FL CXP-VALE21829") — utilizable para matching factura por texto.
 *   - `Clasificacion_Proveedor_Financiera` viene como "220 - Por
 *     Clasificar" — preservamos la cadena cruda para semaforización.
 *   - `Tipo_busqueda` distingue proveedores normales de empleados
 *     ("Employees" para reembolsos/nómina/vales). Útil para excluir o
 *     resaltar pagos no-comerciales.
 *
 * Conexiones downstream:
 *   - CXP: match por `claveProveedor` + texto `comentarioPago` (folio).
 *   - Compras (OC): vía CXP (el comentario referencia CXP, no OC).
 *   - Bancos: match por `cuentaBanco` + `fechaPago` + `importePesos`
 *     contra `BankStatementLine.tipoMovimiento='CARGO'`.
 */
export interface PagoProveedorRecord {
  /** Tipo de pago (PT/PE/etc.). */
  tipoPago: string;
  /** ID único del pago (no_pago). */
  noPago: string;
  /** Compañía normalizada a 5 dígitos. */
  cia: string;
  /** Nombre de la compañía (trim). */
  nombreCia: string;
  /** Texto descriptivo de cuenta bancaria. */
  cuentaBancaria: string;
  /** Número de cuenta crudo (para cruce con módulo Bancos). */
  cuentaBanco: string;
  /** Fecha del pago en formato YYYY-MM-DD (normalizado desde DD-MM-YYYY). */
  fechaPago: string;
  /** Importe pagado en pesos. */
  importePesos: number;
  /** Moneda (MXP/USD). */
  moneda: string;
  /** ID de batch JDE que agrupó este pago. */
  batchPago: string;
  /** Código numérico de proveedor (Clave_Proveedor). */
  claveProveedor: string;
  /** RFC del proveedor (trim). */
  rfcProveedor: string;
  /** Nombre del proveedor (trim). */
  nombreProveedor: string;
  /** Tipo de búsqueda JDE — "Employees" para reembolsos/nómina. */
  tipoBusqueda: string;
  /** Clasificación textual (Nóminas / Reembolsos / etc.). */
  clasificacionProveedor: string;
  /** Clasificación financiera con código (p.ej. "220 - Por Clasificar"). */
  clasificacionProveedorFinanciera: string;
  /** Comentario libre — usualmente referencia folio CXP. */
  comentarioPago: string;
}

// ───────────────────────────────────────────────────────────────
// 9. ROL Diario (CITI — viajes ejecutados)
// ───────────────────────────────────────────────────────────────

/**
 * Request body para POST /citi/roldiario.
 *
 * Endpoint productivo Senda Citi (campos `B_Despachado`, `B_Efectuado`,
 * `Factura`, `UUID_Fiscal`). Sirve para proyectar ingresos a corto plazo:
 * viaje ejecutado + Dias_Credito del cliente + día pago preferido = fecha
 * esperada de cash-in. Cuando la cobranza emite la factura matching (por
 * `Factura` o `UUID_Fiscal`) el ROL transiciona de "predicho" a "facturado".
 *
 * Contrato confirmado por el equipo CITI (2026-05-15): el endpoint espera
 * `f_Inicio`, `f_Final` y `k_Servidor`. Mandar otros nombres de campo hace
 * que el endpoint pase una fecha vacía a SQL y truene con "SqlDateTime
 * overflow" — por eso los nombres importan.
 */
export interface RolRequest {
  /** Fecha inicial inclusive (YYYY-MM-DD). */
  f_Inicio: string;
  /** Fecha final inclusive (YYYY-MM-DD). */
  f_Final: string;
  /** Servidor CITI; -1 = todos los servidores. */
  k_Servidor?: number;
}

/**
 * Registro normalizado de un viaje ejecutado del ROL diario CITI.
 *
 * Shape crudo del API (campos relevantes 2026-05-14):
 *   {
 *     "K_Cliente": 125,
 *     "C_Cliente": "ABB MEXICO",
 *     "D_Cliente": "ABB MEXICO S.A. DE C.V.",
 *     "RFC": "AME920102SS4",
 *     "Clave_JDE": "40317168",                    // = noCliente en cobranza
 *     "D_Facturacion_Tipo": "MENSUAL",            // ciclo facturación
 *     "D_Empresa": "SERVICIO INDUSTRIAL ...",     // razón social Senda
 *     "IVA": 16.0,
 *     "D_Tipo_Viaje": "SENCILL",
 *     "D_Ruta": "BECARIOS A-CARR. 57",
 *     "Costo_Ruta": 997,
 *     "Viajes": 4,
 *     "SubTotal": 3988,
 *     "B_Despachado": true,                       // viaje despachado
 *     "B_Efectuado": true,                        // viaje efectuado
 *     "Anio": 2026,
 *     "Semana": 12,                               // ISO week
 *     "Factura": "RI-305405",                     // populated when invoiced
 *     "UUID_Fiscal": "6D19051B-D7E0-...",
 *     "Plaza_CITI": "SIP"
 *   }
 *
 * Notas operativas:
 *   - El API NO trae fecha exacta del viaje (solo Anio + Semana). Para
 *     proyección asumimos lunes ISO de esa semana como fecha despacho. Cuando
 *     el equipo CITI publique el campo fecha exacta agregar `fechaViaje`
 *     mapeando ese campo en lugar de derivarlo localmente.
 *   - `factura` vacío → viaje aún no facturado (predicho).
 *   - `factura` poblado → buscar en cobranza por `noFactura` o `uuidFiscal`
 *     para encontrar la factura emitida correspondiente.
 */
export interface RolRecord {
  /** Compañía Senda Citi normalizada a 5 dígitos. */
  cia: string;
  /** Razón social Senda (D_Empresa). */
  empresa: string;
  /** Clave numérica del cliente CITI (K_Cliente). */
  kCliente: number;
  /** Código corto del cliente (C_Cliente, p.ej. "ABB MEXICO"). */
  cCliente: string;
  /** Razón social del cliente (D_Cliente). */
  dCliente: string;
  /** RFC del cliente, trim. */
  rfc: string;
  /** Clave JDE del cliente = noCliente en cobranza. Llave de cruce. */
  claveJDE: string;
  /** Tipo de facturación del cliente (MENSUAL / SEMANAL / QUINCENAL). */
  facturacionTipo: string;
  /** Tasa IVA aplicada al viaje. */
  iva: number;
  /** Tipo de viaje (SENCILL, REDONDO, etc.). */
  tipoViaje: string;
  /** Descripción de la ruta. */
  ruta: string;
  /** Costo unitario por viaje. */
  costoRuta: number;
  /** Cantidad de viajes ejecutados. */
  viajes: number;
  /** Subtotal sin IVA = costoRuta × viajes. */
  subTotal: number;
  /** Flag: viaje despachado. */
  despachado: boolean;
  /** Flag: viaje efectuado (clave para predicción ingreso). */
  efectuado: boolean;
  /** Año ISO del viaje. */
  anio: number;
  /** Semana ISO del viaje (1-53). */
  semana: number;
  /**
   * Fecha asumida del viaje = lunes ISO de (anio, semana). Computada local
   * porque el API aún no trae fecha exacta. TODO: cuando el equipo CITI
   * publique el campo de fecha exacta, mapear desde ahí en lugar de derivar.
   */
  fechaViaje: string;
  /** Número de factura emitida (vacío hasta que cobranza factura el viaje). */
  factura?: string;
  /** UUID fiscal de la factura, trim. */
  uuidFiscal?: string;
  /** Plaza CITI (p.ej. "SIP" para Servicio Industrial Potosino). */
  plazaCiti?: string;
}

// ───────────────────────────────────────────────────────────────
// Viajes Especiales
// ───────────────────────────────────────────────────────────────

/**
 * Request body para POST {viajesEspeciales}/Servicios.
 *
 * Endpoint dev `http://srv-desarrollo:95/ViajesEspeciales/Servicios`. Acepta
 * solo el rango — NO requiere k_Servidor ni cia (la respuesta trae la cia
 * por row vía `K_Empresa` / `Clave_JDE_Empresa`).
 */
export interface ViajeEspecialRequest {
  /** Fecha inicial inclusive (YYYY-MM-DD). */
  f_Inicio: string;
  /** Fecha final inclusive (YYYY-MM-DD). */
  f_Final: string;
}

/**
 * Registro normalizado de un viaje especial.
 *
 * Shape crudo del API (2026-05-26):
 *   {
 *     "K_Renta": 722862,
 *     "f_salida_primera": "2026-04-09T09:00:00",
 *     "f_Regreso_ultima": "2026-04-09T13:30:00",
 *     "K_Cliente": 27756,
 *     "D_Cliente": "INSTITUTO TECNOLOGICO ...",
 *     "Rrc_Cliente": "ITE 430714KI0",                 // RFC
 *     "Clave_JDE": "1270361",                         // = noCliente en cobranza
 *     "K_Empresa": "SIRS2",                           // razón social Senda
 *     "Clave_JDE_Empresa": "11",                      // cia JDE
 *     "Total_Negociado": 1951.21,                     // subtotal sin IVA
 *     "Dias_Credito": 30,                             // crédito por viaje (no por cliente)
 *     "Factura_JDE": "RI-305588",
 *     "UUID": "58D6899F-...",
 *     "Fecha_Factura": "2026-04-13T13:40:00",
 *     "numeroBatch": "31751093",
 *     "Referencia_Deposito": "01012703615"
 *   }
 *
 * Notas operativas:
 *   - El crédito vive POR VIAJE (`Dias_Credito`), no por catálogo del
 *     cliente. La proyección debe usarlo en lugar de la regla del catálogo.
 *   - `Factura_JDE`/`UUID` permiten cruzar contra cobranza JDE igual que ROL.
 *   - `K_Cliente` (clave CITI) y `Clave_JDE` (clave JDE) ambas viven en el
 *     row. Cruce con catálogo: `Clave_JDE` empata con `Client.jdeAccounts[].noCliente`.
 */
export interface ViajeEspecialRecord {
  /** Compañía JDE normalizada (Clave_JDE_Empresa). */
  cia: string;
  /** Razón social corta Senda (K_Empresa, p.ej. "SIRS2"). */
  empresaCodigo: string;
  /** Clave de la renta CITI (K_Renta) — id único del viaje. */
  kRenta: number;
  /** Clave CITI del cliente (K_Cliente, numérico). */
  kCliente: number;
  /** Razón social del cliente (D_Cliente). */
  dCliente: string;
  /** RFC del cliente, trim. */
  rfc: string;
  /** Clave JDE del cliente — llave de cruce con cobranza/CXC (= noCliente). */
  claveJDE: string;
  /** Importe negociado SIN IVA (Total_Negociado). */
  totalNegociado: number;
  /** Días de crédito acordados POR VIAJE. */
  diasCredito: number;
  /** Folio de factura JDE (`RI-XXXXXX`). Vacío hasta que se facture. */
  facturaJDE?: string;
  /** UUID fiscal SAT, trim. */
  uuidFiscal?: string;
  /** Fecha de salida del primer servicio (YYYY-MM-DD). */
  fSalidaPrimera?: string;
  /** Fecha de regreso del último servicio (YYYY-MM-DD). */
  fRegresoUltima?: string;
  /** Fecha de emisión de la factura (YYYY-MM-DD). */
  fechaFactura?: string;
  /** Número de batch JDE. */
  numeroBatch?: string;
  /** Referencia de depósito (línea de captura). */
  referenciaDeposito?: string;
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
