/**
 * Servicios JD Edwards — punto de entrada único.
 *
 * Cada función encapsula un endpoint y normaliza la respuesta a los tipos
 * domésticos definidos en jdeTypes.ts. Los mappers son tolerantes a
 * variaciones de naming (snake_case, camelCase, PascalCase) porque el API
 * está en desarrollo y los nombres exactos de campos pueden ajustarse.
 *
 * Uso:
 *   import { fetchAgedBalances, fetchBankStatements, fetchCompanies } from '@/services/jde';
 *
 *   const saldos = await fetchAgedBalances({ cia: '00011' });
 *   const edoCta = await fetchBankStatements({ fechaEstadoCuenta: '2026-04-16', formatoElectronico: 'SWIFT' });
 *   const empresas = await fetchCompanies();
 */

import { jdeClient, JdeClientConfig } from './jdeClient';
import {
  fetchRangeWithDailyCache,
  getDailyCached,
  setDailyCached,
  primeDailyCache,
} from './dailyApiCache';
import { apiConfig } from '../config/api.config';
import {
  AgedBalanceRecord,
  AgedBalanceRequest,
  BankAccountStatement,
  BankStatementLine,
  BankStatementRequest,
  BankStatementFormat,
  CobranzaPayment,
  CobranzaPaymentApplication,
  CobranzaPaymentRequest,
  CobranzaRecord,
  CobranzaRequest,
  ComprasRecord,
  ComprasRequest,
  Company,
  NominaRequest,
  PagoProveedorRecord,
  PagoProveedorRequest,
} from './jdeTypes';
import type {
  PayrollCashTreatment,
  PayrollCostRecord,
} from '../modules/shared-finance/types';

// ───────────────────────────────────────────────────────────────
// Helpers de normalización
// ───────────────────────────────────────────────────────────────

type RawRecord = Record<string, unknown>;

/** Busca una clave por varios alias (case-insensitive, snake/camel). */
function pick(obj: RawRecord, aliases: string[]): unknown {
  const keys = Object.keys(obj);
  for (const alias of aliases) {
    const a = alias.toLowerCase();
    const found = keys.find(k => k.toLowerCase() === a);
    if (found !== undefined) return obj[found];
  }
  return undefined;
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function trimIsoDate(v: unknown): string {
  const s = toStr(v);
  if (!s) return '';
  return s.length >= 10 ? s.slice(0, 10) : s;
}

/**
 * Normaliza un valor de `No_Recibo` a la llave de cruce canónica:
 *   1. Descarta cualquier caracter que no sea dígito (espacios, guiones,
 *      prefijos tipo "RI -", etc.).
 *   2. Si quedan más de 8 dígitos, conserva solo los últimos 8.
 *
 * Contexto: el API de Bancos JDE devuelve `No_Recibo` con dígitos extra al
 * frente (tipo de documento, padding contable, batch, etc.) que no aparecen
 * en la columna `No_Recibo` de `cobranzaindicadores`. Para cruzar ambos
 * lados con confianza, normalizamos a "los últimos 8 dígitos". Cuando el
 * valor ya tiene 8 o menos dígitos (caso cobranzaindicadores típico) la
 * función es idempotente y solo limpia separadores.
 */
function extractReciboKey(value: unknown): string {
  const digits = toStr(value).replace(/\D/g, '');
  if (!digits) return '';
  return digits.length > 8 ? digits.slice(-8) : digits;
}

export function normalizeInvoiceRef(value: unknown): string {
  return toStr(value)
    .toUpperCase()
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, '');
}

/**
 * Normaliza el campo `cia` de la respuesta JDE.
 *
 * El API regresa la cia en varias formas según el endpoint:
 *   - "00011"                                  → /empresas, /antiguedadsaldos
 *   - "00011 - SERVICIO INDUSTRIAL REGIOMONTANO"→ /antiguedadsaldos en algunos casos
 *   - "00011,"                                  → /cobranza (la coma proviene del
 *                                                request body que el equipo JDE
 *                                                comparte como ejemplo y aparece
 *                                                eco en algunas respuestas).
 *
 * Para poder agrupar/filtrar registros por compañía hay que reducir todos
 * estos a un código canónico de 5 dígitos. Estrategia:
 *   1. Tomar la PRIMERA secuencia de dígitos consecutivos de la cadena.
 *      Esto cubre los tres casos sin bifurcarnos por cada formato.
 *   2. Pad a 5 dígitos.
 *   3. Si no hay dígitos (raro, p.ej. cia="MX"), devolver el head limpio.
 */
function normalizeCia(v: unknown): string {
  const raw = toStr(v);
  if (!raw) return '';
  const digitMatch = raw.match(/\d+/);
  if (digitMatch) return digitMatch[0].padStart(5, '0');
  // Sin dígitos: caer al patrón antiguo (split por espacio/guion/coma).
  const head = raw.split(/[\s\-,]/)[0].trim();
  return head;
}

/** Desenvuelve respuestas tipo { data: [...] } o { result: [...] } o arreglo directo. */
function unwrapList(raw: unknown): RawRecord[] {
  if (Array.isArray(raw)) return raw as RawRecord[];
  if (raw && typeof raw === 'object') {
    const obj = raw as RawRecord;
    for (const key of ['data', 'result', 'results', 'records', 'items', 'rows']) {
      const v = obj[key];
      if (Array.isArray(v)) return v as RawRecord[];
    }
  }
  return [];
}

// ───────────────────────────────────────────────────────────────
// 1. Antigüedad de Saldos
// ───────────────────────────────────────────────────────────────

function mapAgedBalance(raw: RawRecord): AgedBalanceRecord {
  return {
    cia:                     normalizeCia(pick(raw, ['cia', 'compania', 'company'])),
    noProveedor:             toStr(pick(raw, ['noProveedor', 'no_prov', 'no_proveedor', 'proveedor'])),
    nombre:                  toStr(pick(raw, ['nombre', 'nombreProveedor', 'razonSocial'])),
    noFactura:               toStr(pick(raw, ['noFactura', 'no_factura', 'factura'])),
    fechaFactura:            toStr(pick(raw, ['fechaFactura', 'fecha_factura'])),
    fechaVence:              toStr(pick(raw, ['fechaVence', 'fecha_vence', 'fechaVencimiento'])),
    fechaProgramacionPago:   toStr(pick(raw, ['fechaProgramacionPago', 'fecha_programacion_pago', 'fechaProgPago'])),
    diasVencida:             toNum(pick(raw, ['diasVencida', 'dias_vencida', 'diasVencido'])),
    importeBrutoPesos:       toNum(pick(raw, ['importeBrutoPesos', 'importe_bruto_pesos'])),
    importePendientePesos:   toNum(pick(raw, ['importePendientePesos', 'importe_pendiente_pesos'])),
    importeSubtotalPesos:    toNum(pick(raw, ['importeSubtotalPesos', 'importe_subtotal_pesos'])),
    importeImpuestosPesos:   toNum(pick(raw, ['importeImpuestosPesos', 'importe_impuestos_pesos'])),
    importeBrutoDolares:     toNum(pick(raw, ['importeBrutoDolares', 'importe_bruto_dolares'])),
    importePendienteDolares: toNum(pick(raw, ['importePendienteDolares', 'importe_pendiente_dolares'])),
    moneda:                  toStr(pick(raw, ['moneda', 'currency'])),
    condPago:                toStr(pick(raw, ['condPago', 'cond_pago', 'condicionPago'])),
    clasifica:               toStr(pick(raw, ['clasifica', 'clasificacion'])),
    clasificacionProveedor:  toStr(pick(raw, ['clasificacionProveedor', 'clasificacion_proveedor'])),
    edoPago:                 toStr(pick(raw, ['edoPago', 'edo_pago', 'estadoPago'])),
    tipoCambio:              toNum(pick(raw, ['tipoCambio', 'tipo_cambio', 'tc'])),
    porVencer:               toNum(pick(raw, ['porVencer', 'por_vencer'])),
    v1_30:                   toNum(pick(raw, ['v1_30', 'v_1_30', 'v0130'])),
    v31_60:                  toNum(pick(raw, ['v31_60', 'v_31_60', 'v3160'])),
    v61_90:                  toNum(pick(raw, ['v61_90', 'v_61_90', 'v6190'])),
    v91_120:                 toNum(pick(raw, ['v91_120', 'v_91_120', 'v91120'])),
    v121_150:                toNum(pick(raw, ['v121_150', 'v_121_150', 'v121150'])),
    v151_180:                toNum(pick(raw, ['v151_180', 'v_151_180', 'v151180'])),
    mas180:                  toNum(pick(raw, ['mas180', 'mas_180', 'masDe180'])),
  };
}

/**
 * POST /v1/erp/tesoreria/antiguedadsaldos
 * Retorna todos los saldos abiertos por proveedor para la compañía indicada.
 */
export async function fetchAgedBalances(
  req: AgedBalanceRequest,
  config: JdeClientConfig = {},
): Promise<AgedBalanceRecord[]> {
  const raw = await jdeClient.post<unknown>('/antiguedadsaldos', req, config);
  return unwrapList(raw).map(mapAgedBalance);
}

// ───────────────────────────────────────────────────────────────
// 2. Bancos — Estado de Cuenta
// ───────────────────────────────────────────────────────────────

/**
 * Extrae el código de compañía JDE a partir del campo Cuenta_Contable.
 *
 * Formato típico de JDE: "BU.Object.Subsidiary" → e.g. "38.1020.0011305"
 * La Business Unit (BU) mapea al código de compañía con padding:
 *   BU "38" → cia "00038",  BU "11" → cia "00011"
 *
 * Si Cuenta_Contable es null (como en TMPB) retorna "".
 */
function extractCiaFromCuentaContable(cuentaContable: unknown): string {
  const raw = toStr(cuentaContable);
  if (!raw) return '';
  const dotIdx = raw.indexOf('.');
  const bu = dotIdx > 0 ? raw.slice(0, dotIdx) : raw;
  const buNum = parseInt(bu, 10);
  if (!Number.isFinite(buNum) || buNum <= 0) return '';
  return String(buNum).padStart(5, '0');
}

/**
 * Extrae el nombre del banco del campo Nombre_cuenta_Contable.
 * Ejemplos:
 *   "BANAMEX  877732401"        → "BANAMEX"
 *   "BANAMEX - 7014 350840"     → "BANAMEX"
 *   "BANORTE 0123456789"        → "BANORTE"
 */
function extractBankName(raw: unknown): string {
  const s = toStr(raw);
  if (!s) return '';
  // Tomar solo la parte alfabética inicial (el nombre del banco)
  const match = s.match(/^([A-Za-zÁÉÍÓÚáéíóúÑñ]+(?:\s+[A-Za-zÁÉÍÓÚáéíóúÑñ]+)*)/);
  return match ? match[1].trim() : s;
}

/**
 * Parsea el concepto/descripción de los campos InF_ADI de JDE.
 *
 * InF_ADI_1 formato típico:  "322?00PAGO A TERCEROS?20/EI/TR"
 *   → extraemos "PAGO A TERCEROS"
 *
 * InF_ADI_2 formato típico:  "P589  00877732401 a 7013870885 1 SERVICIOS T DE N?21  Pago de SERVICIOS T DE N 170405"
 *   → usamos como detalle si InF_ADI_1 no tiene concepto claro
 */
function parseConcepto(inf1: unknown, inf2: unknown): string {
  const s1 = toStr(inf1);
  const s2 = toStr(inf2);

  // Intentar extraer de InF_ADI_1: buscar texto entre ?00 y ?
  if (s1) {
    const match = s1.match(/\?00([^?]+)/);
    if (match) return match[1].trim();
    // Formato TMPB: "Hora_carga: 10 - Linea: 0000001" → no es útil, usar s2
    if (!s1.startsWith('Hora_carga')) return s1;
  }

  // Fallback a InF_ADI_2 (limpiar)
  if (s2) return s2.replace(/\?[0-9]+\s*/g, ' ').trim();

  return '';
}

/**
 * Mapea un registro plano del API de Bancos a nuestro tipo interno.
 *
 * Campos reales del API JDE (desarrollo actual):
 *   Tipo_Estado_Cuenta, gsaid, Fecha_Estado_Cuenta, Cuenta_Bancos,
 *   Cuenta_Contable, Nombre_cuenta_Contable, Saldo_Inicial, Saldo_Final,
 *   tipo_Cuenta_Bancos, DESC039, Importe, Codigo_Transaccion_banco,
 *   Tipo_Movimiento ("DEBITO"/"CREDITO"), Referencia_Cliente,
 *   No_Recibo, InF_ADI_1, InF_ADI_2, InF_ADI_3,
 *   Codigo_Categoria_33..38, DESC033..038
 */
function mapBankLine(raw: RawRecord): BankStatementLine {
  const gsaid = toStr(pick(raw, ['gsaid', 'GSAID']));
  const cuentaContable = toStr(pick(raw, ['Cuenta_Contable', 'cuenta_contable']));
  const cuentaBancos = toStr(pick(raw, ['Cuenta_Bancos', 'cuenta_bancos']));
  const nombreCuentaContable = toStr(pick(raw, ['Nombre_cuenta_Contable', 'nombre_cuenta_contable']));
  const fechaEstadoCuentaRaw = trimIsoDate(pick(raw, ['Fecha_Estado_Cuenta', 'fecha_estado_cuenta']));
  const tipoCuentaBancos = toStr(pick(raw, ['tipo_Cuenta_Bancos', 'Tipo_Cuenta_Bancos', 'tipoCuentaBancos']));
  const desc039 = toStr(pick(raw, ['DESC039', 'desc039']));
  const desc036 = toStr(pick(raw, ['DESC036', 'desc036', 'moneda', 'currency']));
  const codigoTransaccionBanco = toStr(pick(raw, ['Codigo_Transaccion_banco', 'codigo_transaccion_banco']));
  const referenciaCliente = toStr(pick(raw, ['Referencia_Cliente', 'referencia_cliente']));
  // No_Recibo viene del API de Bancos con dígitos extra al inicio; nos
  // quedamos con los últimos 8 dígitos para cruzar 1:1 con la columna
  // `No_Recibo` de cobranzaindicadores.
  const noRecibo = extractReciboKey(pick(raw, ['No_Recibo', 'No Recibo', 'noRecibo', 'no_recibo']));
  const infAdi1 = toStr(pick(raw, ['InF_ADI_1', 'INF_ADI_1', 'infAdi1']));
  const infAdi2 = toStr(pick(raw, ['InF_ADI_2', 'INF_ADI_2', 'infAdi2']));
  const infAdi3 = toStr(pick(raw, ['InF_ADI_3', 'INF_ADI_3', 'infAdi3']));

  // ── Importe ──
  const importeRaw = toNum(
    pick(raw, ['Importe', 'importe', 'monto', 'amount']),
  );
  const absImporte = Math.abs(importeRaw);

  // ── Tipo de movimiento ──
  const tipo = toStr(
    pick(raw, ['Tipo_Movimiento', 'tipoMovimiento', 'tipo_movimiento', 'tipo', 'dc']),
  ).toUpperCase();
  const tipoMovimiento =
    tipo === 'DEBITO'  || tipo === 'CARGO' || tipo === 'C' || tipo === 'D' || importeRaw < 0
      ? 'CARGO' :
    tipo === 'CREDITO' || tipo === 'ABONO' || tipo === 'A' || tipo === 'CR' || importeRaw > 0
      ? 'ABONO' :
    tipo || 'ABONO';

  // ── Fecha ── prioridad: fechaOperacion real > Fecha_Estado_Cuenta (la de la request)
  // La API de producción (api.gruposenda.com) regresa fechaOperacion por línea
  // cuando existe. Solo cuando no hay campo dedicado caemos al statement date.
  // Normalizamos ISO "2026-04-17T00:00:00" → "2026-04-17".
  const rawFecha = toStr(
    pick(raw, [
      'fechaOperacion', 'fecha_operacion', 'FechaOperacion', 'Fecha_Operacion',
      'fechaMovimiento', 'Fecha_Movimiento', 'fecha_movimiento',
      'fecha', 'date',
      'Fecha_Estado_Cuenta',
    ]),
  );
  const fechaOperacion = rawFecha.includes('T') ? rawFecha.split('T')[0] : rawFecha;

  // ── Empresa ── derivada de Cuenta_Contable (BU → cia con padding)
  const ciaExplicit = toStr(pick(raw, ['cia', 'compania']));
  const cia = ciaExplicit ? normalizeCia(ciaExplicit) : extractCiaFromCuentaContable(cuentaContable);

  // ── Banco ── nombre extraído de Nombre_cuenta_Contable.
  // Antes concatenábamos `· ${desc039}` (e.g. "BANORTE · Pagadora") pero eso
  // fragmenta el mismo banco en grupos distintos cuando tiene cuentas de
  // varios tipos. Hoy `nombreBanco` es solo el banco; el tipo de cuenta
  // (`desc039` / `tipoCuentaBancos`) queda disponible en la cuenta para que
  // la UI lo muestre en la fila individual.
  const nombreBancoRaw = toStr(
    nombreCuentaContable || pick(raw, ['nombreBanco', 'nombre_banco', 'bankName']),
  );
  const bankNameOnly = extractBankName(nombreBancoRaw);
  const nombreBanco = bankNameOnly || desc039 || undefined;

  // ── Cuenta bancaria ──
  // Para la mayoría de bancos (Banamex, Santander, etc.) `Cuenta_Bancos` viene
  // estable por cuenta real. Para BANBAJIO el API devuelve un `Cuenta_Bancos`
  // distinto en cada línea (es el folio SPEI / clave de rastreo del recibo),
  // lo que rompe el agrupamiento y produce "74 cuentas" cuando en realidad
  // es 1 cuenta con 74 movimientos. Como Cuenta_Contable también viene vacío
  // para Bajío, forzamos un cuenta-sentinela "BANBAJIO" para que todas las
  // líneas colapsen al mismo (cia, cuenta, moneda) en groupByAccount, y
  // groupByAccount suma los saldos por cuentaBancos único (ver allí).
  const bankIsBajio =
    /BAJIO|BAJÍO/i.test(toStr(nombreCuentaContable)) ||
    /BAJIO|BAJÍO/i.test(toStr(nombreBancoRaw));
  const fallbackCuenta = toStr(pick(raw, ['cuenta', 'numeroCuenta', 'numero_cuenta', 'account']));
  const cuenta = bankIsBajio
    ? 'BANBAJIO'
    : toStr(cuentaBancos || fallbackCuenta);

  // ── Concepto (parsing inteligente de InF_ADI) ──
  const concepto = parseConcepto(
    infAdi1,
    infAdi2,
  );

  // ── Referencia ──
  const referencia = toStr(
    referenciaCliente || pick(raw, ['referencia', 'folio', 'reference']),
  );

  // ── Banco ── usamos el nombre extraído como código también (no hay campo banco dedicado en JDE)
  const banco = nombreBanco || toStr(
    pick(raw, ['banco', 'codigoBanco', 'bankCode']),
  );

  // ── Moneda ── JDE no la devuelve explícitamente; inferimos de categorías si posible
  const descMoneda = desc036;
  const moneda = descMoneda.includes('M.N.') || descMoneda.includes('MXN') ? 'MXN'
    : descMoneda.includes('USD') || descMoneda.includes('DLS') || descMoneda.includes('Dólar') ? 'USD'
    : descMoneda || 'MXN';

  return {
    cia,
    banco,
    nombreBanco,
    cuenta,
    moneda,
    fechaOperacion,
    fechaValor: undefined,
    referencia,
    noRecibo,
    concepto,
    tipoMovimiento,
    importe: absImporte,
    saldo: undefined, // saldos se manejan a nivel de cuenta, no por línea
    gsaid,
    cuentaContable,
    cuentaBancos,
    nombreCuentaContable,
    fechaEstadoCuenta: fechaEstadoCuentaRaw,
    tipoCuentaBancos,
    desc039,
    desc036,
    codigoTransaccionBanco,
    referenciaCliente,
    infAdi1,
    infAdi2,
    infAdi3,
  };
}

/**
 * Agrupa líneas planas por cuenta bancaria y asigna saldos.
 *
 * El API de JDE devuelve Saldo_Inicial y Saldo_Final como campos repetidos
 * en cada línea de la misma cuenta. Los tomamos del primer registro raw
 * de cada grupo.
 */
function groupByAccount(
  rawLines: RawRecord[],
  mappedLines: BankStatementLine[],
  fechaEstadoCuenta: string,
): BankAccountStatement[] {
  const map = new Map<string, {
    acc: BankAccountStatement;
    saldoInicial: number;
    saldoFinal: number;
    // Flags separados: una línea que trae Saldo_Inicial pero no Saldo_Final
    // antes guardaba `saldoFinal = 0` (default) y el UI `saldoFinal ?? saldoInicial`
    // resolvía a 0 — borrando el saldo real. Cuentas afectadas: BANBAJIO
    // (centinela colapsado) y cualquier Santander/Banamex con Saldo_Final null
    // en el último día consultado.
    saldoInicialSeen: boolean;
    saldoFinalSeen: boolean;
    /**
     * Sub-cuentas únicas dentro del grupo. Para la mayoría de bancos esto
     * tiene 1 elemento (cada cuenta real = un Cuenta_Bancos estable). Para
     * Bajío colapsamos N líneas en una cuenta sentinela, así que aquí se
     * acumulan los Cuenta_Bancos / saldos por sub-cuenta original.
     */
    sources: Map<string, { saldoInicial?: number; saldoFinal?: number }>;
  }>();

  for (let i = 0; i < mappedLines.length; i++) {
    const l = mappedLines[i];
    const r = rawLines[i];
    const key = `${l.cia}::${l.cuenta}::${l.moneda}`;

    let entry = map.get(key);
    if (!entry) {
      entry = {
        acc: {
          cia: l.cia,
          banco: l.banco,
          nombreBanco: l.nombreBanco,
          cuenta: l.cuenta,
          moneda: l.moneda,
          fechaEstadoCuenta,
          cuentaContable: l.cuentaContable,
          cuentaBancos: l.cuentaBancos,
          nombreCuentaContable: l.nombreCuentaContable,
          tipoCuentaBancos: l.tipoCuentaBancos,
          desc039: l.desc039,
          desc036: l.desc036,
          movimientos: [],
        },
        saldoInicial: 0,
        saldoFinal: 0,
        saldoInicialSeen: false,
        saldoFinalSeen: false,
        sources: new Map(),
      };
      map.set(key, entry);
    }
    entry.acc.movimientos.push(l);

    // Sumar saldos por sub-cuenta única: para Bajío esto suma 74 saldos
    // distintos en una sola "cuenta"; para Banamex (mismo Cuenta_Bancos en
    // todas las líneas) sigue siendo el valor único de esa cuenta.
    const sourceKey = toStr(pick(r, ['Cuenta_Bancos', 'cuenta_bancos']))
      || toStr(pick(r, ['gsaid', 'GSAID']))
      || String(i);
    if (!entry.sources.has(sourceKey)) {
      const si = pick(r, ['Saldo_Inicial', 'saldoInicial', 'saldo_inicial']);
      const sf = pick(r, ['Saldo_Final', 'saldoFinal', 'saldo_final']);
      const siNum = si !== undefined && si !== null ? toNum(si) : undefined;
      const sfNum = sf !== undefined && sf !== null ? toNum(sf) : undefined;
      entry.sources.set(sourceKey, { saldoInicial: siNum, saldoFinal: sfNum });
      if (siNum !== undefined) { entry.saldoInicial += siNum; entry.saldoInicialSeen = true; }
      if (sfNum !== undefined) { entry.saldoFinal += sfNum; entry.saldoFinalSeen = true; }
    }
  }

  for (const { acc, saldoInicial, saldoFinal, saldoInicialSeen, saldoFinalSeen } of map.values()) {
    acc.saldoInicial = saldoInicialSeen ? saldoInicial : undefined;
    acc.saldoFinal = saldoFinalSeen ? saldoFinal : undefined;
    acc.movimientos.sort((a, b) => a.fechaOperacion.localeCompare(b.fechaOperacion));
  }

  return Array.from(map.values()).map(e => e.acc);
}

/**
 * POST /v1/erp/tesoreria/bancos
 * Retorna el estado de cuenta agrupado por cuenta bancaria.
 */
export async function fetchBankStatements(
  req: BankStatementRequest,
  config: JdeClientConfig = {},
): Promise<BankAccountStatement[]> {
  const raw = await jdeClient.post<unknown>('/bancos', req, config);
  const list = unwrapList(raw);
  if (list.length === 0) return [];

  // El API actual de JDE Desarrollo devuelve líneas planas con
  // Saldo_Inicial/Saldo_Final repetidos por cuenta → agrupar.
  const lines = list.map(mapBankLine);
  return groupByAccount(list, lines, req.fechaEstadoCuenta);
}

/**
 * Fetch bank statements for a date range and merge by account.
 *
 * Context: /bancos solo acepta una `fechaEstadoCuenta` por request —
 * es una "foto" diaria. Para reconstruir el histórico (flujo de efectivo año
 * a la fecha, conciliación por semana, etc.) hay que llamar el endpoint día
 * por día y concatenar. Esta función lo hace con concurrencia controlada y
 * deduplica movimientos por (fechaOperacion, referencia, importe, tipo,
 * concepto) para tolerar solapes entre fechas contiguas.
 *
 * Comportamiento de saldos al mergear:
 *   - `saldoInicial` = saldo inicial del día más antiguo que respondió.
 *   - `saldoFinal`   = saldo final del día más reciente que respondió.
 *   - `fechaEstadoCuenta` = el día más reciente del rango con datos.
 *
 * Errores por día son silenciados (cada día se trata como 0 movimientos)
 * para no abortar el rango entero si un solo día falla — el caller puede
 * detectar fallos totales viendo si el array devuelto está vacío.
 *
 * @param from   Fecha inicial inclusive (YYYY-MM-DD).
 * @param to     Fecha final inclusive (YYYY-MM-DD).
 * @param formato Formato electrónico (default SWIFT).
 * @param options Concurrencia, callback de progreso, config JDE.
 * @returns Un BankAccountStatement[] — un elemento por (cia, cuenta, moneda)
 *          — con `movimientos` cubriendo todo el rango.
 */
export async function fetchBankStatementsRange(
  from: string,
  to: string,
  formato: BankStatementFormat = 'SWIFT',
  options: {
    concurrency?: number;
    onProgress?: (done: number, total: number) => void;
    config?: JdeClientConfig;
  } = {},
): Promise<BankAccountStatement[]> {
  const concurrency = Math.max(1, options.concurrency ?? 6);
  const config = options.config ?? {};

  // Build the list of dates [from..to] inclusive.
  const dates: string[] = [];
  const start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) {
    return [];
  }
  for (
    const d = new Date(start);
    d <= end;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    dates.push(d.toISOString().slice(0, 10));
  }

  // Parallel fetch with a simple worker pool, gated por cache por día.
  // El cache (en IDB, ver dailyApiCache.ts) sirve días pasados sin tocar la
  // red. "Hoy" siempre se re-fetch. Días que no estaban en cache se guardan
  // al regresar.
  // Cada día puede fallar por timeout transitorio del proxy serverless o
  // por contención del API JDE (devuelve 500 cuando se le encima la cola).
  // Reintentamos hasta 2 veces con backoff antes de aceptar 0 movimientos.
  await primeDailyCache();
  const cacheApiKey = `banks.${formato}`;
  const today = new Date().toISOString().slice(0, 10);
  const results: BankAccountStatement[][] = new Array(dates.length);
  const needsFetch: number[] = [];
  for (let i = 0; i < dates.length; i++) {
    if (dates[i] < today) {
      const cached = getDailyCached<BankAccountStatement>(cacheApiKey, dates[i]);
      if (cached !== null) {
        results[i] = cached;
        continue;
      }
    }
    needsFetch.push(i);
  }
  let done = dates.length - needsFetch.length;
  options.onProgress?.(done, dates.length);

  let cursor = 0;
  const MAX_ATTEMPTS = 3;
  const worker = async () => {
    while (true) {
      const slot = cursor++;
      if (slot >= needsFetch.length) return;
      const idx = needsFetch[slot];
      let attempt = 0;
      let dayResult: BankAccountStatement[] = [];
      let succeeded = false;
      while (attempt < MAX_ATTEMPTS) {
        try {
          dayResult = await fetchBankStatements(
            { fechaEstadoCuenta: dates[idx], formatoElectronico: formato },
            config,
          );
          succeeded = true;
          break;
        } catch {
          attempt++;
          if (attempt >= MAX_ATTEMPTS) {
            dayResult = [];
            break;
          }
          // Backoff con jitter para no estampar al upstream cuando un batch
          // entero de días concurrentes falla a la vez.
          const delay = 400 * attempt + Math.floor(Math.random() * 300);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      results[idx] = dayResult;
      if (succeeded) {
        setDailyCached(cacheApiKey, dates[idx], dayResult);
      }
      done++;
      options.onProgress?.(done, dates.length);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, needsFetch.length || 1) }, worker),
  );

  // Merge by (cia, cuenta, moneda).
  const merged = new Map<string, BankAccountStatement>();
  const seen = new Map<string, Set<string>>();
  const firstDate = new Map<string, string>();
  const lastDate = new Map<string, string>();

  for (let i = 0; i < dates.length; i++) {
    const dayStatements = results[i] || [];
    for (const s of dayStatements) {
      const key = `${s.cia}::${s.cuenta}::${s.moneda}`;
      let acc = merged.get(key);
      if (!acc) {
        acc = {
          cia: s.cia,
          banco: s.banco,
          nombreBanco: s.nombreBanco,
          cuenta: s.cuenta,
          moneda: s.moneda,
          fechaEstadoCuenta: s.fechaEstadoCuenta,
          saldoInicial: s.saldoInicial,
          saldoFinal: s.saldoFinal,
          cuentaContable: s.cuentaContable,
          cuentaBancos: s.cuentaBancos,
          nombreCuentaContable: s.nombreCuentaContable,
          tipoCuentaBancos: s.tipoCuentaBancos,
          desc039: s.desc039,
          desc036: s.desc036,
          movimientos: [],
        };
        merged.set(key, acc);
        seen.set(key, new Set());
        firstDate.set(key, s.fechaEstadoCuenta);
        lastDate.set(key, s.fechaEstadoCuenta);
      }

      // Track earliest/latest response dates per account.
      if (s.fechaEstadoCuenta < (firstDate.get(key) ?? s.fechaEstadoCuenta)) {
        firstDate.set(key, s.fechaEstadoCuenta);
        if (s.saldoInicial !== undefined) acc.saldoInicial = s.saldoInicial;
      }
      if (s.fechaEstadoCuenta >= (lastDate.get(key) ?? s.fechaEstadoCuenta)) {
        lastDate.set(key, s.fechaEstadoCuenta);
        acc.fechaEstadoCuenta = s.fechaEstadoCuenta;
        if (s.saldoFinal !== undefined) acc.saldoFinal = s.saldoFinal;
        // Keep the most recent human-readable bank label too.
        if (s.nombreBanco) acc.nombreBanco = s.nombreBanco;
        if (s.cuentaContable) acc.cuentaContable = s.cuentaContable;
        if (s.cuentaBancos) acc.cuentaBancos = s.cuentaBancos;
        if (s.nombreCuentaContable) acc.nombreCuentaContable = s.nombreCuentaContable;
        if (s.tipoCuentaBancos) acc.tipoCuentaBancos = s.tipoCuentaBancos;
        if (s.desc039) acc.desc039 = s.desc039;
        if (s.desc036) acc.desc036 = s.desc036;
      }

      const seenSet = seen.get(key)!;
      for (const mov of s.movimientos) {
        const mk = `${mov.fechaOperacion}|${mov.referencia}|${mov.tipoMovimiento}|${mov.importe}|${mov.concepto}`;
        if (seenSet.has(mk)) continue;
        seenSet.add(mk);
        acc.movimientos.push(mov);
      }
    }
  }

  // Sort movimientos within each account chronologically.
  for (const acc of merged.values()) {
    acc.movimientos.sort((a, b) => a.fechaOperacion.localeCompare(b.fechaOperacion));
  }

  return Array.from(merged.values());
}

// ───────────────────────────────────────────────────────────────
// 3. Empresas
// ───────────────────────────────────────────────────────────────

function mapCompany(raw: RawRecord): Company {
  const activaRaw = pick(raw, ['activa', 'activo', 'active', 'enabled']);
  return {
    cia:        toStr(pick(raw, ['cia', 'codigo', 'code', 'compania'])),
    nombre:     toStr(pick(raw, ['nombre', 'razonSocial', 'razon_social', 'name'])),
    rfc:        toStr(pick(raw, ['rfc', 'taxId', 'tax_id'])) || undefined,
    monedaBase: toStr(pick(raw, ['monedaBase', 'moneda_base', 'moneda', 'currency'])) || undefined,
    activa:     activaRaw === undefined ? undefined
                : activaRaw === true || activaRaw === 'S' || activaRaw === 'SI' || activaRaw === 1
                  ? true : activaRaw === false || activaRaw === 'N' || activaRaw === 'NO' || activaRaw === 0
                    ? false : undefined,
  };
}

/**
 * GET /v1/erp/tesoreria/empresas
 * Retorna el catálogo de compañías disponible para el usuario autenticado.
 */
export async function fetchCompanies(config: JdeClientConfig = {}): Promise<Company[]> {
  const raw = await jdeClient.get<unknown>('/empresas', config);
  return unwrapList(raw).map(mapCompany).filter(c => c.cia);
}

// ───────────────────────────────────────────────────────────────
// 4. Cobranza (CXC)
// ───────────────────────────────────────────────────────────────

/**
 * Mapper de un registro CXC del API JDE de Cobranza.
 *
 * Shape real de la respuesta productiva (validado 2026-05-03 con un dump
 * compartido por el equipo de tesorería):
 *
 *   {
 *     "Cia": "00001",
 *     "No_Cliente": 99999988,                               // number
 *     "Nombre_Cliente": "RITA PRADO VAZQUEZ           ",    // padded con espacios
 *     "RFC": "PAVR7405221A9       ",
 *     "Factura": "RI-85022",
 *     "Dias_Credito": "1  ",
 *     "Fecha_Factura": "2025-05-05T00:00:00",
 *     "Fecha_Vencimiento": "2025-05-06T00:00:00",
 *     "Fecha_Pago": "2025-05-12T00:00:00",                 // ← cobrada efectiva
 *     "Fecha_Contable": "2025-05-05T00:00:00",
 *     "Dias_Fecha_Vencimiento_vs_Fecha_Pago": 6,           // solo cuando ya cobrada
 *     "TasaFiscal": "EXTO           ",
 *     "SubTotal": 1155.44,
 *     "Importe_IVA": 0,
 *     "Importe_RETENCION": 0,
 *     "Importe_Factura": 1155.44,                           // ← gross (Sub + IVA − RET)
 *     "Importe_Pendiente": 0,                                // ← saldo abierto
 *     "UUID_Fiscal": "..."
 *   }
 *
 * Notas operativas:
 *   - El API NO devuelve `moneda` ni `tipoCambio` — todos los importes son
 *     MXN según el equipo. Asumimos default MXN; si en el futuro liberan
 *     facturas USD, agregamos el alias.
 *   - El API NO devuelve un `estatus` textual, pero se puede derivar:
 *     pendiente > 0 → "PENDIENTE", pendiente == 0 + Fecha_Pago set →
 *     "COBRADA", caso raro pendiente==0 sin Fecha_Pago → "CANCELADA".
 *   - `Dias_Fecha_Vencimiento_vs_Fecha_Pago` solo está poblado cuando la
 *     factura ya fue cobrada en JDE. Para facturas pendientes computamos
 *     `today − fechaVencimiento` localmente.
 */
function mapCobranza(raw: RawRecord): CobranzaRecord {
  // ── Importes ── el campo "Importe_Factura" es el gross final (subtotal +
  // IVA − retenciones). Es lo que se compara contra el ABONO bancario
  // cuando la factura está pagada al 100%. Mantenemos también pendiente
  // como saldo abierto.
  const importeBrutoPesos = toNum(
    pick(raw, [
      'importeBrutoPesos', 'importe_bruto_pesos', 'importeBruto',
      'importe_factura', 'Importe_Factura', // ← shape real del API
      'monto', 'amount',
    ]),
  );
  const importePendientePesos = toNum(
    pick(raw, [
      'importePendientePesos', 'importe_pendiente_pesos', 'importePendiente',
      'importe_pendiente', 'Importe_Pendiente', // ← shape real del API
      'saldoPendiente', 'saldo_pendiente',
    ]),
  );

  // ── Fechas ──
  // El API devuelve ISO con time ("2025-05-12T00:00:00"). Recortamos a
  // YYYY-MM-DD porque el resto del app trabaja con day-precision y
  // appendear "T12:00:00Z" sobre una cadena que YA tiene una T producía
  // un Date inválido (NaN) que rompía ventanas de fecha en el motor de
  // cruce.
  const fechaFactura = trimIsoDate(pick(raw, ['fechaFactura', 'fecha_factura', 'Fecha_Factura', 'fechaEmision', 'fecha_emision']));
  const fechaVence = trimIsoDate(pick(raw, ['fechaVence', 'fecha_vence', 'fechaVencimiento', 'fecha_vencimiento', 'Fecha_Vencimiento', 'dueDate']));
  // Fecha de pago efectiva — JDE la llama Fecha_Pago. Para nosotros es el
  // ancla de cruce más tight (±5 días) cuando la factura ya está cobrada.
  const fechaCobro = trimIsoDate(pick(raw, [
    'fechaCobro', 'fecha_cobro',
    'fecha_pago', 'Fecha_Pago', // ← shape real del API
    'fechaProgramacionCobro', 'fechaProgCobro', 'fechaCobrado',
  ]));
  const fechaContable = trimIsoDate(pick(raw, ['fechaContable', 'fecha_contable', 'Fecha_Contable']));

  // ── Días vencida ──
  // El API regresa `Dias_Fecha_Vencimiento_vs_Fecha_Pago` solo cuando la
  // factura ya fue cobrada (=positivo si se pagó tarde). Para facturas
  // pendientes ese campo es null y debemos computar `today − fechaVence`
  // localmente para que el aging por buckets funcione.
  const diasVencidaApi = toNum(
    pick(raw, [
      'diasVencida', 'dias_vencida', 'diasVencido', 'dias_vencido',
      'dias_fecha_vencimiento_vs_fecha_pago', 'Dias_Fecha_Vencimiento_vs_Fecha_Pago',
    ]),
  );
  let diasVencida = diasVencidaApi;
  if (importePendientePesos > 0 && fechaVence) {
    // factura pendiente: días vencida = hoy − fechaVencimiento
    const hoy = new Date();
    const venc = new Date(fechaVence);
    if (!Number.isNaN(venc.getTime())) {
      const ms = hoy.getTime() - venc.getTime();
      diasVencida = Math.max(0, Math.round(ms / 86_400_000));
    }
  } else if (importePendientePesos === 0 && diasVencidaApi <= 0) {
    // factura cobrada a tiempo: el campo del API es 0 o negativo, dejarlo así.
    diasVencida = diasVencidaApi;
  }

  // ── Estatus derivado ──
  const estatusApi = toStr(pick(raw, ['estatus', 'estado', 'edoCobro', 'edo_cobro', 'status']));
  const estatus = estatusApi
    || (importePendientePesos > 0
      ? 'PENDIENTE'
      : fechaCobro
        ? 'COBRADA'
        : 'CANCELADA');

  // ── Moneda ── el API actual no la devuelve; default MXN.
  const moneda = toStr(pick(raw, ['moneda', 'currency'])) || 'MXN';

  // ── Condición de pago ──
  // El API la trae como "Dias_Credito" (string con padding tipo "30 ").
  // toStr ya hace trim. Si no viene, dejamos vacío.
  const condPago = toStr(pick(raw, ['condPago', 'cond_pago', 'condicionPago', 'dias_credito', 'Dias_Credito']));

  return {
    cia:                     normalizeCia(pick(raw, ['cia', 'compania', 'company', 'Cia'])),
    noCliente:               toStr(pick(raw, ['noCliente', 'no_cliente', 'No_Cliente', 'noCte', 'cliente', 'customerNo', 'customer'])),
    nombreCliente:           toStr(pick(raw, ['nombreCliente', 'nombre_cliente', 'Nombre_Cliente', 'nombre', 'razonSocial', 'razon_social', 'customerName'])),
    rfc:                     toStr(pick(raw, ['rfc', 'RFC'])),
    noFactura:               toStr(pick(raw, ['noFactura', 'no_factura', 'factura', 'Factura', 'invoice', 'invoiceNo'])),
    fechaFactura,
    fechaVence,
    fechaCobro,
    fechaContable,
    diasVencida,
    importeBrutoPesos,
    importePendientePesos,
    importeBrutoDolares:     toNum(pick(raw, ['importeBrutoDolares', 'importe_bruto_dolares'])),
    importePendienteDolares: toNum(pick(raw, ['importePendienteDolares', 'importe_pendiente_dolares'])),
    moneda,
    condPago,
    estatus,
    tipoCambio:              toNum(pick(raw, ['tipoCambio', 'tipo_cambio', 'tc'])),
    tasaFiscal:              toStr(pick(raw, ['tasaFiscal', 'TasaFiscal', 'tasa_fiscal'])),
    subTotal:                toNum(pick(raw, ['subTotal', 'SubTotal', 'sub_total'])),
    importeIVA:              toNum(pick(raw, ['importeIVA', 'Importe_IVA', 'importe_iva'])),
    importeRetencion:        toNum(pick(raw, ['importeRetencion', 'Importe_RETENCION', 'importe_retencion'])),
    uuidFiscal:              toStr(pick(raw, ['uuidFiscal', 'UUID_Fiscal', 'uuid_fiscal'])),
    // INTENCIONALMENTE NO persistimos `raw` aquí: con 10k+ facturas y ~30
    // campos cada una, el JSON.stringify del store excedía el quota de
    // 5 MB de localStorage y la app crasheaba al intentar guardar. Si se
    // necesita inspeccionar el raw para debug, se puede activar bajo flag
    // dev (env VITE_COBRANZA_KEEP_RAW=1) o leerlo desde el log
    // `[cobranza] sample raw record` en la consola.
  };
}

/**
 * POST /v1/erp/tesoreria/cobranza
 *
 * Retorna las facturas de cobranza (CXC) abiertas/históricas para la
 * compañía indicada en el rango de fechas dado.
 *
 * Body de ejemplo (compartido por el equipo JDE el 2026-05-01):
 *   { "cia": "00011,", "fechaInicial": null, "fechaFinal": "2026-04-29" }
 *
 * IMPORTANTE — coma trailing en `cia`:
 *   El equipo JDE compartió el body con la cia terminando en coma. No es
 *   un typo: replicamos exactamente ese formato porque al menos un usuario
 *   reportó respuesta vacía cuando se enviaba "00011" sin coma. Por
 *   seguridad, si el caller manda la cia sin coma, se la agregamos aquí.
 *
 * Notas:
 *   • Como /antiguedadsaldos, una compañía por request. Para múltiples
 *     compañías llamar en serie y mergear.
 *   • `fechaInicial: null` trae todo el histórico hasta `fechaFinal`.
 *   • Token leído de `VITE_JDE_TOKEN` (queda embebido en el bundle al
 *     correr en localhost).
 */
export async function fetchCobranza(
  req: CobranzaRequest,
  config: JdeClientConfig = {},
): Promise<CobranzaRecord[]> {
  // Forzar la coma trailing en cia para mimetizar exactamente el body que
  // JDE compartió. El normalizer del response (`normalizeCia`) ya extrae
  // dígitos sin importar puntuación, así que no contamina los registros
  // mapeados.
  const ciaWithComma = req.cia.endsWith(',') ? req.cia : `${req.cia},`;
  const body: CobranzaRequest = { ...req, cia: ciaWithComma };

  const raw = await jdeClient.post<unknown>('/cobranza', body, config);
  const list = unwrapList(raw);

  // Log de diagnóstico — la primera vez que esta función responde con N
  // registros, mostramos el primero en la consola para que el equipo pueda
  // validar el shape contra el mapper. No es ruido permanente: solo se
  // imprime una vez por sesión gracias al flag global.
  if (typeof window !== 'undefined' && !cobranzaShapeLogged) {
    cobranzaShapeLogged = true;
    // eslint-disable-next-line no-console
    console.info(
      `[cobranza] ${list.length} registros para cia=${ciaWithComma} entre ${req.fechaInicial ?? '∞'} y ${req.fechaFinal}`,
    );
    if (list.length > 0) {
      // eslint-disable-next-line no-console
      console.info('[cobranza] sample raw record:', list[0]);
      // eslint-disable-next-line no-console
      console.info('[cobranza] sample mapped record:', mapCobranza(list[0]));
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        '[cobranza] respuesta VACÍA. Posibles causas: (1) sin permisos del token para esta cia, (2) sin facturas en el rango, (3) body no aceptado por JDE.',
      );
    }
  }

  return list.map(mapCobranza);
}

// ───────────────────────────────────────────────────────────────
// 5. Indicadores de Cobranza (recibos / aplicaciones)
// ───────────────────────────────────────────────────────────────

function mapCobranzaPaymentApplication(raw: RawRecord, idPago: string, cia: string): CobranzaPaymentApplication | null {
  const noFactura = toStr(pick(raw, [
    'No Factura', 'No_Factura', 'noFactura', 'no_factura', 'factura',
  ]));
  if (!noFactura) return null;

  return {
    idPago,
    cia,
    fechaAplicacion: trimIsoDate(pick(raw, ['Fecha aplicacion', 'Fecha_aplicacion', 'fechaAplicacion', 'fecha_aplicacion'])),
    noCliente: toStr(pick(raw, ['No Cliente', 'No_Cliente', 'noCliente', 'no_cliente'])),
    cliente: toStr(pick(raw, ['Cliente', 'cliente'])),
    tipoDocto: toStr(pick(raw, ['Tipo Docto', 'Tipo_Docto', 'tipoDocto', 'tipo_docto'])),
    noFactura,
    noFacturaNormalizada: normalizeInvoiceRef(noFactura),
    fechaFactura: trimIsoDate(pick(raw, ['Fecha Factura', 'Fecha_Factura', 'fechaFactura', 'fecha_factura'])),
    fechaVencimiento: trimIsoDate(pick(raw, ['Fecha vencimiento', 'Fecha_Vencimiento', 'fechaVencimiento', 'fecha_vencimiento'])),
    diasAntiguedadFafv: toNum(pick(raw, ['Dias Antiguedad FAFV', 'Dias_Antiguedad_FAFV', 'diasAntiguedadFafv'])),
    importeCobrado: toNum(pick(raw, ['Importe Cobrado', 'Importe_Cobrado', 'importeCobrado', 'importe_cobrado'])),
    importeOriginalFactura: toNum(pick(raw, ['Importe Original Factura', 'Importe_Original_Factura', 'importeOriginalFactura'])),
    importePteFactura: toNum(pick(raw, ['Importe Pte Factura', 'Importe_Pte_Factura', 'importePteFactura'])),
    tasaIva: toStr(pick(raw, ['tasa iva', 'tasa_iva', 'tasaIva', 'Tasa_IVA'])),
    importeIvaFacturaOriginal: toNum(pick(raw, [
      'Importe Iva Factura original',
      'Importe_Iva_Factura_original',
      'importeIvaFacturaOriginal',
      'importe_iva_factura_original',
    ])),
  };
}

function mapCobranzaPaymentHeader(rows: RawRecord[], idPago: string, ciaFallback: string): CobranzaPayment {
  const header = rows.reduce((best, row) => {
    const current = toNum(pick(row, ['Importe Recibo', 'Importe_Recibo', 'importeRecibo', 'importe_recibo']));
    const previous = toNum(pick(best, ['Importe Recibo', 'Importe_Recibo', 'importeRecibo', 'importe_recibo']));
    return current > previous ? row : best;
  }, rows[0]);
  const cia = normalizeCia(pick(header, ['CIA', 'Cia', 'cia', 'compania'])) || ciaFallback;

  return {
    idPago,
    cia,
    fechaCobro: trimIsoDate(pick(header, ['Fecha Cobro', 'Fecha_Cobro', 'fechaCobro', 'fecha_cobro'])),
    fechaContable: trimIsoDate(pick(header, ['Fecha Contable', 'Fecha_Contable', 'fechaContable', 'fecha_contable'])),
    cuentaBancaria: toStr(pick(header, ['cta bancaria', 'cta_bancaria', 'cuentaBancaria', 'cuenta_bancaria'])),
    banco: toStr(pick(header, ['Banco', 'banco'])),
    // Cruzamos por `No_Recibo` contra el banco; normalizamos al mismo
    // formato (solo dígitos, últimos 8) para que ambos lados produzcan la
    // misma llave aún si cobranzaindicadores trae prefijos tipo "RI - ".
    noRecibo: extractReciboKey(pick(header, ['No Recibo', 'No_Recibo', 'noRecibo', 'no_recibo'])),
    importeRecibo: toNum(pick(header, ['Importe Recibo', 'Importe_Recibo', 'importeRecibo', 'importe_recibo'])),
    pendienteAplicar: toNum(pick(header, ['Pendiente de Aplicar', 'Pendiente_de_Aplicar', 'pendienteAplicar'])),
    noCliente: toStr(pick(header, ['No Cliente', 'No_Cliente', 'noCliente', 'no_cliente'])),
    cliente: toStr(pick(header, ['Cliente', 'cliente'])),
    noBatch: toStr(pick(header, ['no batch', 'no_batch', 'noBatch', 'No_Batch'])),
    tipoCambio: toNum(pick(header, ['tipo cambio', 'tipo_cambio', 'tipoCambio'])),
    applications: rows
      .map(row => mapCobranzaPaymentApplication(row, idPago, cia))
      .filter((app): app is CobranzaPaymentApplication => app !== null),
  };
}

export function normalizeCobranzaPayments(rows: Record<string, unknown>[], ciaFallback = ''): CobranzaPayment[] {
  const groups = new Map<string, RawRecord[]>();
  for (const row of rows) {
    const idPago = toStr(pick(row, ['Id Pago', 'Id_Pago', 'idPago', 'id_pago']));
    if (!idPago) continue;
    const list = groups.get(idPago) ?? [];
    list.push(row);
    groups.set(idPago, list);
  }

  return Array.from(groups.entries())
    .map(([idPago, group]) => mapCobranzaPaymentHeader(group, idPago, ciaFallback))
    .filter(payment => payment.fechaCobro && payment.cuentaBancaria && payment.importeRecibo > 0)
    .sort((a, b) => a.fechaCobro.localeCompare(b.fechaCobro) || a.idPago.localeCompare(b.idPago));
}

/**
 * POST /cobranzaindicadores vía el proxy JDE estándar.
 *
 * Reporte de pagos/recibos y aplicaciones de cobranza. Liberado en producción
 * el 2026-05-07 en `api.gruposenda.com/v1/erp/tesoreria/cobranzaindicadores`,
 * por lo que ya usa el mismo cliente, token y proxy que el resto de las APIs
 * JDE — sin upstream separado ni headers de auth custom. La respuesta plana
 * se normaliza a un pago por `Id Pago`, con sus facturas aplicadas anidadas.
 */
export async function fetchIndicadoresCobranza(
  req: CobranzaPaymentRequest,
  config: JdeClientConfig = {},
): Promise<CobranzaPayment[]> {
  const raw = await jdeClient.post<unknown>('/cobranzaindicadores', req, config);
  return normalizeCobranzaPayments(unwrapList(raw), req.cia);
}

// ───────────────────────────────────────────────────────────────
// 6. Compras (Órdenes de Compra)
// ───────────────────────────────────────────────────────────────

/**
 * JDE marca fechas "vacías" como 1899-12-31. Para F_Recepcion eso significa
 * "OC todavía no recibida"; para F_Cancelada significa "no cancelada".
 * Tratamos ese centinela como ausencia.
 */
function isSentinelJdeDate(iso: string): boolean {
  if (!iso) return true;
  return iso.startsWith('1899-') || iso.startsWith('0001-');
}

/** Suma N días a un YYYY-MM-DD; devuelve '' si la entrada no es parseable. */
function addDaysIso(iso: string, days: number): string {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + (Number.isFinite(days) ? Math.floor(days) : 0));
  return d.toISOString().slice(0, 10);
}

function mapCompras(raw: RawRecord): ComprasRecord {
  const fechaPedido = trimIsoDate(pick(raw, ['F_Pedido', 'f_pedido', 'fechaPedido']));
  const fechaRecepcionRaw = trimIsoDate(pick(raw, ['F_Recepcion', 'F_Recepción', 'f_recepcion', 'fechaRecepcion']));
  const fechaRecepcion = isSentinelJdeDate(fechaRecepcionRaw) ? '' : fechaRecepcionRaw;
  const fechaCanceladaRaw = trimIsoDate(pick(raw, ['F_Cancelada', 'f_cancelada', 'fechaCancelada']));
  const cancelada = !isSentinelJdeDate(fechaCanceladaRaw);
  const noFactura = toStr(pick(raw, ['N_Factura', 'n_factura', 'noFactura']));
  const facturada = noFactura.length > 0;
  const diasCredito = toNum(pick(raw, ['D_Credito', 'd_credito', 'diasCredito']));
  const fechaPagoProyectada = fechaRecepcion ? addDaysIso(fechaRecepcion, diasCredito) : '';

  return {
    cia:               normalizeCia(pick(raw, ['Compañia', 'Compania', 'compania', 'cia', 'company'])),
    noProveedor:       toStr(pick(raw, ['C_Proveedor', 'c_proveedor', 'noProveedor'])),
    nombreProveedor:   toStr(pick(raw, ['N_Proveedor', 'n_proveedor', 'nombreProveedor'])),
    noOrden:           toStr(pick(raw, ['N_Orden', 'n_orden', 'noOrden'])),
    tipoOrden:         toStr(pick(raw, ['T_Orden', 't_orden', 'tipoOrden'])),
    descTipoOrden:     toStr(pick(raw, ['D_T_Orden', 'd_t_orden', 'descTipoOrden'])),
    lineaOrden:        toNum(pick(raw, ['L_Orden', 'l_orden', 'lineaOrden'])),
    noProducto:        toStr(pick(raw, ['C_Producto', 'c_producto', 'noProducto'])),
    descProducto:      toStr(pick(raw, ['D_Producto', 'd_producto', 'descProducto'])),
    concepto:          toStr(pick(raw, ['Concepto', 'concepto'])),
    cantidad:          toNum(pick(raw, ['Cantidad', 'cantidad'])),
    precioUnitario:    toNum(pick(raw, ['Precio_U', 'precio_u', 'precioUnitario'])),
    importeTotal:      toNum(pick(raw, ['Precio_T', 'precio_t', 'importeTotal', 'importe'])),
    moneda:            toStr(pick(raw, ['T_Moneda', 't_moneda', 'moneda', 'currency'])) || 'MXP',
    tipoCambio:        toNum(pick(raw, ['Tipo_Cambio', 'tipo_cambio', 'tipoCambio'])) || 1,
    fechaPedido,
    fechaRecepcion,
    diasCredito,
    fechaPagoProyectada,
    noFactura,
    centroCostos:      toStr(pick(raw, ['Centro_Costos', 'centro_costos', 'centroCostos'])),
    categoria:         toStr(pick(raw, ['Categoria', 'categoria'])),
    descCategoria:     toStr(pick(raw, ['Desc_Categoria', 'desc_categoria', 'descCategoria'])),
    familia:           toStr(pick(raw, ['Familia', 'familia'])),
    descFamilia:       toStr(pick(raw, ['Desc_Familia', 'desc_familia', 'descFamilia'])),
    subFamilia:        toStr(pick(raw, ['SubFamilia', 'sub_familia', 'subFamilia'])),
    descSubFamilia:    toStr(pick(raw, ['Desc_SubFamilia', 'desc_sub_familia', 'descSubFamilia'])),
    estadoSiguiente:   toStr(pick(raw, ['Edo_Sig', 'edo_sig', 'estadoSiguiente'])),
    tasaFiscal:        toStr(pick(raw, ['Tasa_Fiscal', 'tasa_fiscal', 'tasaFiscal'])),
    cancelada,
    facturada,
  };
}

/**
 * POST /v1/erp/tesoreria/compras
 *
 * Devuelve las órdenes de compra del rango indicado. JDE solo procesa hasta
 * 30 días por request — para rangos mayores usar `fetchComprasRange`.
 *
 * El payload trae ~40 campos por OC; consumimos todos pero solo proyectamos
 * egreso a corto plazo con un subset (ver `ComprasRecord`).
 */
export async function fetchCompras(
  req: ComprasRequest,
  config: JdeClientConfig = {},
): Promise<ComprasRecord[]> {
  const raw = await jdeClient.post<unknown>('/compras', req, config);
  return unwrapList(raw).map(mapCompras);
}

/**
 * Fetch órdenes de compra en bloques de 1 día con cache por día en localStorage.
 *
 * JDE limita /compras a rangos pequeños; usamos 1 día por request para poder
 * cachear cada día individualmente bajo `midas.daily.compras.__all__.{YYYY-MM-DD}`.
 * Días pasados se sirven del cache sin pegar al endpoint. "Hoy" siempre se
 * re-fetch (los datos del día cambian intradía).
 *
 * Deduplica por `(cia, noOrden, lineaOrden)` para tolerar registros repetidos
 * entre días contiguos (raro, pero el chunker viejo de 30 días lo manejaba y
 * lo mantenemos por seguridad).
 *
 * @param from   YYYY-MM-DD inclusive.
 * @param to     YYYY-MM-DD inclusive.
 * @param options Concurrencia (default 3), callback de progreso, config JDE.
 */
export async function fetchComprasRange(
  from: string,
  to: string,
  options: {
    concurrency?: number;
    onProgress?: (done: number, total: number) => void;
    config?: JdeClientConfig;
  } = {},
): Promise<ComprasRecord[]> {
  const config = options.config ?? {};

  // JDE /compras devuelve 500 intermitente. Reintentar con backoff exponencial
  // cubre el flakeo upstream sin perder días enteros.
  const MAX_ATTEMPTS = 3;
  const fetchDayWithRetry = async (day: string): Promise<ComprasRecord[]> => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await fetchCompras({ fechaInicial: day, fechaFinal: day }, config);
      } catch (err) {
        lastErr = err;
        if (attempt === MAX_ATTEMPTS) break;
        const delayMs = 500 * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastErr;
  };

  const all = await fetchRangeWithDailyCache<ComprasRecord>('compras', {
    from,
    to,
    fetchDay: fetchDayWithRetry,
    onProgress: options.onProgress,
    concurrency: options.concurrency ?? 3,
  });

  const seen = new Set<string>();
  const merged: ComprasRecord[] = [];
  for (const rec of all) {
    const key = `${rec.cia}::${rec.noOrden}::${rec.lineaOrden}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(rec);
  }
  return merged;
}

/**
 * Fetch cobranza (CXC) para una cía en rango de fechas — snapshot único.
 *
 * El endpoint /cobranza con `fechaInicial=null, fechaFinal=today` devuelve TODAS
 * las facturas abiertas/históricas para la cía. Por eso una sola llamada por cía
 * basta y NO conviene chunkear por día (sería 365 requests por cía).
 *
 * El cache vive en `MidasStore.cobranzaRecords` (localStorage) + TTL por cia en
 * `cobranzaLoadedCias`. Adicionalmente persistimos un snapshot en IDB para que
 * el siguiente boot tenga los datos sin esperar a la red mientras el TTL fresh
 * sea válido.
 */
export async function fetchCobranzaRange(
  cia: string,
  from: string,
  to: string,
  options: {
    concurrency?: number;
    onProgress?: (done: number, total: number) => void;
    config?: JdeClientConfig;
  } = {},
): Promise<CobranzaRecord[]> {
  const config = options.config ?? {};
  options.onProgress?.(0, 1);
  // Una sola llamada por cía con el rango completo. El upstream regresa TODAS
  // las facturas abiertas/históricas — chunkear por día explotaría a 365 calls
  // por cía sin ganancia de cache (los registros del mismo día rara vez se
  // repiten en queries posteriores).
  const records = await fetchCobranza({ cia, fechaInicial: from, fechaFinal: to }, config);
  options.onProgress?.(1, 1);
  return records;
}

/**
 * Fetch indicadores de cobranza (recibos/pagos) para una cía — snapshot único.
 *
 * Mismo razonamiento que fetchCobranzaRange: una llamada por cía cubre todo.
 * El cache vive en MidasStore.cobranzaPayments + cobranzaPaymentsLoadedCias.
 */
export async function fetchIndicadoresCobranzaRange(
  cia: string,
  from: string,
  to: string,
  options: {
    concurrency?: number;
    onProgress?: (done: number, total: number) => void;
    config?: JdeClientConfig;
  } = {},
): Promise<CobranzaPayment[]> {
  const config = options.config ?? {};
  options.onProgress?.(0, 1);
  const records = await fetchIndicadoresCobranza({ cia, fechaInicial: from, fechaFinal: to }, config);
  options.onProgress?.(1, 1);
  return records;
}

// Flag para que el log de shape solo aparezca una vez por sesión.
let cobranzaShapeLogged = false;

// ───────────────────────────────────────────────────────────────
// 6. Nómina (TRESS)
// ───────────────────────────────────────────────────────────────

/**
 * Mapping naive (basado solo en `TipoConcepto`) hacia `PayrollCashTreatment`.
 *
 * Esta es la primera capa de clasificación que aplica el mapper. Una segunda
 * capa más fina vive en `payrollModuleService` (PR2) y refina por
 * `Concepto`/`IDConcepto` para separar:
 *   - Deducción ISR / IMSS empleado → WITHHOLDING_PAYABLE (lo entera la
 *     empresa al SAT/IMSS en la fecha de entero, no el día de la nómina).
 *   - Deducción préstamo / pensión alimenticia → DEDUCTION (resta del neto
 *     que recibe el empleado en FechaPago).
 *   - Vales / provisiones registradas como percepción pero no efectivo →
 *     NON_CASH.
 *
 * Por defecto el mapper asigna el tratamiento más conservador para que el
 * flujo de efectivo no se subestime mientras la tabla fina no esté cargada.
 */
const TIPO_CONCEPTO_TO_CASH_TREATMENT: Record<string, PayrollCashTreatment> = {
  'percepcion': 'CASH_OUT',
  'percepción': 'CASH_OUT',
  'deduccion': 'DEDUCTION',
  'deducción': 'DEDUCTION',
  'aportacion': 'EMPLOYER_TAX',
  'aportación': 'EMPLOYER_TAX',
  'patronal': 'EMPLOYER_TAX',
  'informativo': 'NON_CASH',
};

function inferCashTreatment(tipoConcepto: string): PayrollCashTreatment {
  const key = tipoConcepto.trim().toLowerCase();
  if (!key) return 'NON_CASH';
  const direct = TIPO_CONCEPTO_TO_CASH_TREATMENT[key];
  if (direct) return direct;
  // Substring match para tolerar variantes ("Aportación Patronal", "Deducción Empleado", etc.).
  for (const token of Object.keys(TIPO_CONCEPTO_TO_CASH_TREATMENT)) {
    if (key.includes(token)) return TIPO_CONCEPTO_TO_CASH_TREATMENT[token];
  }
  return 'NON_CASH';
}

function mapNominaRow(raw: RawRecord): PayrollCostRecord {
  const idEmpresaRaw = pick(raw, ['IDEmpresa', 'idEmpresa', 'id_empresa', 'cia', 'compania']);
  const empresa = toStr(pick(raw, ['Empresa', 'empresa', 'nombreEmpresa', 'razonSocial']));
  const monto = toNum(pick(raw, ['Monto', 'monto', 'importe', 'amount']));
  const periodo = pick(raw, ['Periodo', 'periodo', 'numPeriodo']);
  const mes = toStr(pick(raw, ['Mes', 'mes']));
  const idConcepto = pick(raw, ['IDConcepto', 'idConcepto', 'id_concepto']);
  const concepto = toStr(pick(raw, ['Concepto', 'concepto', 'nombreConcepto']));
  const tipoNomina = toStr(pick(raw, ['TipoNomina', 'tipoNomina', 'tipo_nomina']));
  const tipoConcepto = toStr(pick(raw, ['TipoConcepto', 'tipoConcepto', 'tipo_concepto']));

  // Aliases defensivos para el typo `Fechainical` en producción.
  const fechaInicial = trimIsoDate(
    pick(raw, ['Fechainical', 'fechainical', 'FechaInicial', 'fechaInicial', 'fecha_inicial']),
  );
  const fechaFinal = trimIsoDate(pick(raw, ['FechaFinal', 'fechaFinal', 'fecha_final']));
  const fechaPago = trimIsoDate(pick(raw, ['FechaPago', 'fechaPago', 'fecha_pago']));

  // Año/mes derivados de la fecha de pago (la fuente más confiable para
  // alinear el evento de cash con el calendario fiscal). Si falta, intentamos
  // parsear desde el body de la request via campos auxiliares.
  let year = 0;
  let month = 0;
  if (fechaPago) {
    const parts = fechaPago.split('-');
    year = toNum(parts[0]);
    month = toNum(parts[1]);
  }
  if (!year) year = toNum(pick(raw, ['anio', 'Anio', 'year']));
  if (!month) month = toNum(pick(raw, ['mes_num', 'numMes', 'monthNumber']));

  return {
    // `cia` se normaliza al mismo padding de 5 dígitos que usan CXP/bancos
    // para garantizar joins por compañía a nivel store.
    cia: normalizeCia(idEmpresaRaw),
    empresaNomina: empresa,
    year,
    month,
    paymentDate: fechaPago,
    periodStartDate: fechaInicial || undefined,
    periodEndDate: fechaFinal || undefined,
    payrollPeriod: typeof periodo === 'number' ? periodo : toStr(periodo) || mes,
    payrollType: tipoNomina,
    conceptId: typeof idConcepto === 'number' ? idConcepto : toStr(idConcepto),
    conceptName: concepto,
    conceptType: tipoConcepto,
    cashTreatment: inferCashTreatment(tipoConcepto),
    amount: monto,
  };
}

/**
 * POST /nomina (TRESS) — devuelve registros normalizados a `PayrollCostRecord`.
 *
 * Nota sobre `idEmpresa=99` y `tipoNomina=99`: ambos valores funcionan como
 * comodín ("Todas") según el contrato del API. Para backfill anual basta con
 * 12 requests, una por mes. Cada request puede tardar parecido a los
 * endpoints de tesorería (varios segundos a >1min) — el cliente comparte el
 * timeout de 180s configurado en `jdeClient.ts`.
 */
export async function fetchNomina(
  req: NominaRequest,
  config: JdeClientConfig = {},
): Promise<PayrollCostRecord[]> {
  const merged: JdeClientConfig = {
    baseUrl: apiConfig.tress.baseUrl,
    ...config,
  };
  const raw = await jdeClient.post<unknown>('/nomina', req, merged);
  return unwrapList(raw).map(mapNominaRow);
}

// Exporta helpers internos para que los unit tests puedan ejercitarlos sin
// montar un mock del cliente HTTP.
export const __internal = {
  mapNominaRow,
  inferCashTreatment,
};

// ───────────────────────────────────────────────────────────────
// 8. PagoProveedor (pagos ejecutados — espejo egreso de cobranza)
// ───────────────────────────────────────────────────────────────

/**
 * Normaliza fecha JDE en formato "DD-MM-YYYY" a "YYYY-MM-DD".
 *
 * Solo este endpoint usa día-primero; los demás devuelven ISO con timestamp.
 * Si no matchea el formato esperado, intenta `trimIsoDate` como fallback
 * (cubre el caso raro de que JDE cambie a ISO en una versión futura).
 */
function trimDmyDate(v: unknown): string {
  const s = toStr(v);
  if (!s) return '';
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return trimIsoDate(v);
}

function mapPagoProveedor(raw: RawRecord): PagoProveedorRecord {
  return {
    tipoPago:                          toStr(pick(raw, ['tipo_pago', 'tipoPago', 'TipoPago'])),
    noPago:                            toStr(pick(raw, ['no_pago', 'noPago', 'NoPago'])),
    cia:                               normalizeCia(pick(raw, ['No_Cia', 'no_cia', 'noCia', 'cia', 'compania'])),
    nombreCia:                         toStr(pick(raw, ['Nombre_Cia', 'nombre_cia', 'nombreCia'])),
    cuentaBancaria:                    toStr(pick(raw, ['Cuenta_Bancaria', 'cuenta_bancaria', 'cuentaBancaria'])),
    cuentaBanco:                       toStr(pick(raw, ['Cuenta_Banco', 'cuenta_banco', 'cuentaBanco'])),
    fechaPago:                         trimDmyDate(pick(raw, ['Fecha_Pago', 'fecha_pago', 'fechaPago'])),
    importePesos:                      toNum(pick(raw, ['Importe_Pago_Pesos', 'importe_pago_pesos', 'importePesos'])),
    importeDolares:                    toNum(pick(raw, ['Importe_Pago_Dolares', 'importe_pago_dolares', 'importeDolares'])),
    moneda:                            toStr(pick(raw, ['Moneda', 'moneda', 'currency'])) || 'MXP',
    batchPago:                         toStr(pick(raw, ['Batch_pago', 'batch_pago', 'batchPago'])),
    claveProveedor:                    toStr(pick(raw, ['Clave_Proveedor', 'clave_proveedor', 'claveProveedor'])),
    rfcProveedor:                      toStr(pick(raw, ['RFC_Proveedor', 'rfc_proveedor', 'rfcProveedor'])),
    nombreProveedor:                   toStr(pick(raw, ['Nombre_Proveedor', 'nombre_proveedor', 'nombreProveedor'])),
    tipoBusqueda:                      toStr(pick(raw, ['Tipo_busqueda', 'tipo_busqueda', 'tipoBusqueda'])),
    clasificacionProveedor:            toStr(pick(raw, ['Clasificacion_proveedor', 'clasificacion_proveedor', 'clasificacionProveedor'])),
    clasificacionProveedorFinanciera:  toStr(pick(raw, ['clasificacion_Proveedor_Financiera', 'Clasificacion_Proveedor_Financiera', 'clasificacionProveedorFinanciera'])),
    comentarioPago:                    toStr(pick(raw, ['Comentario_Pago', 'comentario_pago', 'comentarioPago'])),
  };
}

/**
 * POST /v1/erp/tesoreria/pagoproveedor
 *
 * Devuelve los pagos ejecutados a proveedores en el rango. Es el espejo
 * egreso de /cobranza (cobros ejecutados). Sin chunking forzado upstream
 * pero para rangos amplios usar `fetchPagoProveedorRange` con cache diario.
 */
export async function fetchPagoProveedor(
  req: PagoProveedorRequest,
  config: JdeClientConfig = {},
): Promise<PagoProveedorRecord[]> {
  const raw = await jdeClient.post<unknown>('/pagoproveedor', req, config);
  return unwrapList(raw).map(mapPagoProveedor);
}

/**
 * Fetch pagos a proveedor en bloques de 1 día con cache por día.
 *
 * Mismo patrón que /cobranza y /compras: cada día se cachea bajo
 * `midas.daily.pagoproveedor.__all__.{YYYY-MM-DD}`. Días pasados se sirven
 * del cache; "hoy" siempre se re-fetch (los datos del día cambian intradía).
 *
 * Deduplica por `(cia, noPago)` para tolerar registros repetidos.
 *
 * @param from   YYYY-MM-DD inclusive.
 * @param to     YYYY-MM-DD inclusive.
 */
export async function fetchPagoProveedorRange(
  from: string,
  to: string,
  options: {
    concurrency?: number;
    onProgress?: (done: number, total: number) => void;
    config?: JdeClientConfig;
  } = {},
): Promise<PagoProveedorRecord[]> {
  const config = options.config ?? {};

  const MAX_ATTEMPTS = 3;
  const fetchDayWithRetry = async (day: string): Promise<PagoProveedorRecord[]> => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await fetchPagoProveedor({ fechaInicial: day, fechaFinal: day }, config);
      } catch (err) {
        lastErr = err;
        if (attempt === MAX_ATTEMPTS) break;
        const delayMs = 500 * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastErr;
  };

  const all = await fetchRangeWithDailyCache<PagoProveedorRecord>('pagoproveedor', {
    from,
    to,
    fetchDay: fetchDayWithRetry,
    onProgress: options.onProgress,
    concurrency: options.concurrency ?? 3,
  });

  const seen = new Set<string>();
  const merged: PagoProveedorRecord[] = [];
  for (const rec of all) {
    const key = `${rec.cia}::${rec.noPago}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(rec);
  }
  return merged;
}

// Re-exports convenientes
export type {
  AgedBalanceRecord,
  AgedBalanceRequest,
  BankAccountStatement,
  BankStatementLine,
  BankStatementRequest,
  BankStatementFormat,
  BankMovementType,
  CobranzaPayment,
  CobranzaPaymentApplication,
  CobranzaPaymentRequest,
  CobranzaRecord,
  CobranzaRequest,
  ComprasRecord,
  ComprasRequest,
  Company,
  NominaRequest,
  NominaRawRecord,
  PagoProveedorRecord,
  PagoProveedorRequest,
} from './jdeTypes';
export { JdeApiError } from './jdeTypes';
