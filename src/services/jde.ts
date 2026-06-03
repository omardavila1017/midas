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
  fetchRangeWithChunkedDailyCache,
  fetchRangeWithMonthlyCache,
  hasDailyCached,
  getDailyCachedAsync,
  setDailyCached,
  primeDailyCache,
} from './dailyApiCache';
import { apiConfig } from '../config/api.config';
import { findBankAccountByCuenta } from '../domain/bankAccountsCatalog';
import { canonicalBankAccountNumber } from '../domain/bankStatements';
import { todayISO } from '../formatters';
import { matchesExclusionIdentity } from '../domain/companyExclusion';
import { isAuxiliarAllowlistedCia, AUX_IVA_PARAMS } from '../domain/auxiliarReconciliationConfig';
import { discoverIvaObjetosByKind } from '../domain/ivaLedger';
import { isNonOperatingDay } from '../domain/bankHolidays';

/**
 * Drop globally-excluded rows (empresa 33 / multicarga) at the JDE normalize
 * layer. Blanket — no date boundary. Single source of truth lives in
 * companyExclusion.ts; do NOT re-apply downstream (canonicalProjection).
 */
function dropExcludedByCia<T extends { cia: string }>(rows: T[]): T[] {
  return rows.filter(r => !matchesExclusionIdentity({ cia: r.cia }));
}
import { JdeApiError } from './jdeTypes';
import type {
  AgedBalanceRecord,
  AgedBalanceRequest,
  AuxiliarContableRecord,
  AuxiliarContableRequest,
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
  RolRecord,
  RolRequest,
  ViajeEspecialRecord,
  ViajeEspecialRequest,
} from './jdeTypes';
import type {
  PayrollCashTreatment,
  PayrollCostRecord,
} from '../modules/shared-finance/types';

// ───────────────────────────────────────────────────────────────
// Helpers de normalización
// ───────────────────────────────────────────────────────────────

type RawRecord = Record<string, unknown>;
type AuxObjetoRange = { ini: string; fin: string };

export const AUX_IVA_LEDGER_VERSION = 'iva-ledger-v3';

const LONG_RUNNING_TIMEOUT_MS = 240_000;
const LONG_RUNNING_RETRIES = 1;
const inFlightJdeCalls = new Map<string, Promise<unknown>>();

function stableStringify(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
  } catch {
    return String(value);
  }
}

function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlightJdeCalls.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = run().finally(() => {
    if (inFlightJdeCalls.get(key) === promise) inFlightJdeCalls.delete(key);
  });
  inFlightJdeCalls.set(key, promise);
  return promise;
}

function withLongRunningDefaults(config: JdeClientConfig = {}): JdeClientConfig {
  return {
    ...config,
    timeoutMs: config.timeoutMs ?? LONG_RUNNING_TIMEOUT_MS,
    retries: config.retries ?? LONG_RUNNING_RETRIES,
  };
}

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

/**
 * Strip in-place todos los campos del raw que no estén en la whitelist
 * (case-insensitive). Reduce huella de memoria transitoria al parsear
 * payloads grandes (auxiliar contable trae ~40 campos por línea; el mapper
 * solo consume ~25). Es defensivo, no cambia el contrato — fields ELIMINAR
 * de la tabla quedan documentados aquí.
 *
 * Mutación in-place (delete) para evitar reasignar 100k+ objetos cuando el
 * raw ya está en heap por JSON.parse. Trade-off conocido: dispara
 * polimorfismo de hidden class en V8, pero para arrays que se mapean una sola
 * vez y se descartan, el costo es menor que reallocar.
 *
 * Mantener cada `KEPT_*_FIELDS` set en sync con los aliases que el mapper
 * correspondiente pasa a `pick()`. Si agregas un alias nuevo al mapper sin
 * actualizar el set, ese campo llegará como `undefined` al mapper.
 */
function stripToWhitelist(row: RawRecord, allowedLower: ReadonlySet<string>): RawRecord {
  for (const key of Object.keys(row)) {
    if (!allowedLower.has(key.toLowerCase())) {
      delete row[key];
    }
  }
  return row;
}

function stripAllToWhitelist(rows: RawRecord[], allowedLower: ReadonlySet<string>): RawRecord[] {
  for (const row of rows) stripToWhitelist(row, allowedLower);
  return rows;
}

function splitIntoFixedDayWindows(from: string, to: string, windowDays: number): Array<{ from: string; to: string }> {
  const windows: Array<{ from: string; to: string }> = [];
  const start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end || windowDays < 1) return windows;

  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  while (cursor <= end) {
    const winEnd = new Date(cursor);
    winEnd.setUTCDate(winEnd.getUTCDate() + windowDays - 1);
    const boundedEnd = winEnd <= end ? winEnd : end;
    windows.push({
      from: cursor.toISOString().slice(0, 10),
      to: boundedEnd.toISOString().slice(0, 10),
    });
    cursor = new Date(boundedEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return windows;
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
 * POST /JDEdwards/antiguedadsaldos
 * Retorna todos los saldos abiertos por proveedor para la compañía indicada.
 */
export async function fetchAgedBalances(
  req: AgedBalanceRequest,
  config: JdeClientConfig = {},
): Promise<AgedBalanceRecord[]> {
  const raw = await jdeClient.post<unknown>('/antiguedadsaldos', req, config);
  return dropExcludedByCia(unwrapList(raw).map(mapAgedBalance));
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
 * Forma canónica del identificador de cuenta (solo dígitos). Delega en el
 * normalizador de dominio para que mapeo (aquí) y consumo (Bancos.tsx)
 * compartan exactamente la misma lógica.
 */
function normalizeBankAccountNumber(raw: unknown): string {
  return canonicalBankAccountNumber(toStr(raw));
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
  // El API entrega la cuenta etiquetada ("BANAMEX - 7014 4758151") y a veces
  // sólo en Nombre_cuenta_Contable cuando Cuenta_Bancos viene vacío.
  // Canonizamos a dígitos para que el display sea limpio y el cruce con el
  // catálogo funcione.
  const cuenta = bankIsBajio
    ? 'BANBAJIO'
    : normalizeBankAccountNumber(cuentaBancos || fallbackCuenta || nombreCuentaContable);

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
 * Una fila de "saldo-snapshot": el API de /bancos a veces devuelve un registro
 * con Saldo_Inicial/Saldo_Final pero sin transacción real (Importe 0, sin
 * gsaid/referencia/concepto/recibo/código). NO es un movimiento — si se empuja
 * a `movimientos` produce la fila fantasma de +$0.00 y el "1 mov." espurio.
 */
function isBalanceOnlyLine(l: BankStatementLine): boolean {
  return (
    l.importe === 0 &&
    !l.gsaid &&
    !l.referencia &&
    !l.concepto &&
    !l.noRecibo &&
    !l.codigoTransaccionBanco
  );
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
    // Las filas de saldo-snapshot crean/actualizan la cuenta (saldos abajo)
    // pero NO se listan como movimiento.
    if (!isBalanceOnlyLine(l)) entry.acc.movimientos.push(l);

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
 * POST /JDEdwards/bancos
 * Retorna el estado de cuenta agrupado por cuenta bancaria.
 */
export async function fetchBankStatements(
  req: BankStatementRequest,
  config: JdeClientConfig = {},
): Promise<BankAccountStatement[]> {
  return singleFlight(
    `bancos:${stableStringify(req)}:${stableStringify(config)}`,
    async () => {
  // Días pasados → daily-cache IDB. El prime de boot dispara 6 paralelas
  // (`today + 5 días atrás`) como fallback por si hoy no tiene datos; sin
  // este check los 5 días pasados, ya hidratados en IDB por sesiones
  // anteriores, repegan al API en cada reload. La cache key es la misma
  // que usa `fetchBankStatementsRange` (`banks.${formato}`), así que ambos
  // path comparten el almacenamiento.
  const cacheApiKey = `banks.${req.formatoElectronico}`;
  const today = todayISO();
  const isPast = req.fechaEstadoCuenta < today;
  if (isPast) {
    await primeDailyCache();
    if (hasDailyCached(cacheApiKey, req.fechaEstadoCuenta)) {
      const cached = await getDailyCachedAsync<BankAccountStatement>(
        cacheApiKey,
        req.fechaEstadoCuenta,
      );
      if (cached !== null) return cached;
    }
  }

  const raw = await jdeClient.post<unknown>('/bancos', req, config);
  const list = unwrapList(raw);
  if (list.length === 0) {
    if (isPast) setDailyCached(cacheApiKey, req.fechaEstadoCuenta, []);
    return [];
  }

  // El API actual de JDE Desarrollo devuelve líneas planas con
  // Saldo_Inicial/Saldo_Final repetidos por cuenta → agrupar.
  // Antes de agrupar, dropear líneas de compañías/unidades excluidas
  // globalmente (empresa 33, multicarga) — blanket, sin corte de fecha:
  // el histórico también se excluye (ver companyExclusion.ts).
  const lines = list.map(mapBankLine);
  const keptRaw: RawRecord[] = [];
  const keptLines: BankStatementLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const unidadNegocio = findBankAccountByCuenta(ln.cuenta)?.unidadNegocio ?? null;
    if (matchesExclusionIdentity({ cia: ln.cia, unidadNegocio })) continue;
    keptRaw.push(list[i]);
    keptLines.push(ln);
  }
  const grouped = groupByAccount(keptRaw, keptLines, req.fechaEstadoCuenta);
  if (isPast) setDailyCached(cacheApiKey, req.fechaEstadoCuenta, grouped);
  return grouped;
    },
  );
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
  // Per-day /bancos es una foto chica — debe responder en segundos. Forzamos
  // timeout 30s + 0 retries internos del jdeClient: este worker ya reintenta
  // vía MAX_ATTEMPTS con su propio backoff. Sin esto el retry queda anidado
  // (3 worker × 3 jdeClient × 120s ≈ 18min por UN día colgado → barra atorada
  // en "730/731"). El caller puede override vía options.config.
  const config: JdeClientConfig = {
    timeoutMs: 30_000,
    retries: 0,
    ...(options.config ?? {}),
  };

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
  const today = todayISO();
  const results: BankAccountStatement[][] = new Array(dates.length);
  const needsFetch: number[] = [];
  // Membership es sync (keyIndex). El payload vive en IDB → leerlo es async;
  // los hits se resuelven en paralelo (pool acotado) para no congelar el boot
  // ni reintroducir la fuga de heap del antiguo memoryIndex de payloads.
  const cachedIdx: number[] = [];
  for (let i = 0; i < dates.length; i++) {
    if (dates[i] < today && hasDailyCached(cacheApiKey, dates[i])) {
      cachedIdx.push(i);
    } else {
      needsFetch.push(i);
    }
  }
  // eslint-disable-next-line no-console
  console.info(
    `[banks-range trace] from=${from} to=${to} days=${dates.length} cached=${cachedIdx.length} needsFetch=${needsFetch.length}`,
  );
  {
    let rc = 0;
    const READ_CONCURRENCY = 8;
    const reader = async () => {
      while (true) {
        const slot = rc++;
        if (slot >= cachedIdx.length) return;
        const idx = cachedIdx[slot];
        const cached = await getDailyCachedAsync<BankAccountStatement>(
          cacheApiKey,
          dates[idx],
        );
        if (cached !== null) {
          results[idx] = cached;
        } else {
          // Carrera con un prune/delete: re-fetch ese día.
          needsFetch.push(idx);
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.max(1, Math.min(READ_CONCURRENCY, cachedIdx.length)) },
        reader,
      ),
    );
  }
  // Trace: cuántos días de cache produjeron datos reales (>0 statements).
  let postReadNonEmpty = 0;
  let postReadTotalMovs = 0;
  for (let i = 0; i < dates.length; i++) {
    const r = results[i];
    if (r && r.length > 0) {
      postReadNonEmpty++;
      for (const s of r) postReadTotalMovs += s.movimientos.length;
    }
  }
  // eslint-disable-next-line no-console
  console.info(
    `[banks-range trace] post-read · ${postReadNonEmpty} días con data del cache · ${postReadTotalMovs} movs en cache · needsFetch ahora=${needsFetch.length}`,
  );
  let done = dates.length - needsFetch.length;

  let cursor = 0;

  // Throttle del callback de progreso. Si el caller persiste estado de React
  // en cada update, cientos de callbacks producen renders innecesarios.
  const PROGRESS_THROTTLE_MS = 200;
  let lastProgressEmit = 0;
  const emitProgress = (force = false) => {
    if (!options.onProgress) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (force || done === dates.length || now - lastProgressEmit >= PROGRESS_THROTTLE_MS) {
      lastProgressEmit = now;
      options.onProgress(done, dates.length);
    }
  };
  emitProgress(true);

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
      emitProgress();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, needsFetch.length || 1) }, worker),
  );
  // Forzar el último emit para que el caller siempre vea done == total.
  emitProgress(true);
  // Trace: cuántos días totales tienen data después de live fetches.
  let postFetchNonEmpty = 0;
  let postFetchTotalMovs = 0;
  for (let i = 0; i < dates.length; i++) {
    const r = results[i];
    if (r && r.length > 0) {
      postFetchNonEmpty++;
      for (const s of r) postFetchTotalMovs += s.movimientos.length;
    }
  }
  // eslint-disable-next-line no-console
  console.info(
    `[banks-range trace] post-fetch · ${postFetchNonEmpty} días con data total · ${postFetchTotalMovs} movs total`,
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
 * GET /JDEdwards/empresas
 * Retorna el catálogo de compañías disponible para el usuario autenticado.
 */
export async function fetchCompanies(config: JdeClientConfig = {}): Promise<Company[]> {
  return singleFlight(`empresas:${stableStringify(config)}`, async () => {
  const raw = await jdeClient.get<unknown>('/empresas', config);
  return unwrapList(raw).map(mapCompany).filter(c => c.cia);
  });
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
/**
 * Whitelist de campos consumidos por mapCobranza. Mantener en sync con los
 * aliases del mapper. JDE entrega ~30 campos por factura; con 10k+ facturas
 * abiertas el stripping ahorra heap transitorio durante el parse.
 */
const KEPT_COBRANZA_FIELDS = new Set<string>([
  'cia', 'compania', 'company',
  'nocliente', 'no_cliente', 'nocte', 'cliente', 'customerno', 'customer',
  'nombrecliente', 'nombre_cliente', 'nombre', 'razonsocial', 'razon_social', 'customername',
  'rfc',
  'nofactura', 'no_factura', 'factura', 'invoice', 'invoiceno',
  'fechafactura', 'fecha_factura', 'fechaemision', 'fecha_emision',
  'fechavence', 'fecha_vence', 'fechavencimiento', 'fecha_vencimiento', 'duedate',
  'fechacobro', 'fecha_cobro', 'fecha_pago', 'fechaprogramacioncobro',
  'fechaprogcobro', 'fechacobrado',
  'fechacontable', 'fecha_contable',
  'diasvencida', 'dias_vencida', 'diasvencido', 'dias_vencido',
  'dias_fecha_vencimiento_vs_fecha_pago',
  'importebrutopesos', 'importe_bruto_pesos', 'importebruto',
  'importe_factura', 'monto', 'amount',
  'importependientepesos', 'importe_pendiente_pesos', 'importependiente',
  'importe_pendiente', 'saldopendiente', 'saldo_pendiente',
  'importebrutodolares', 'importe_bruto_dolares',
  'importependientedolares', 'importe_pendiente_dolares',
  'moneda', 'currency',
  'condpago', 'cond_pago', 'condicionpago',
  'estatus', 'estado', 'edocobro', 'edo_cobro', 'status',
  'tipocambio', 'tipo_cambio', 'tc',
  'tasafiscal', 'tasa_fiscal',
  'subtotal', 'sub_total',
  'importeiva', 'importe_iva',
  'importeretencion', 'importe_retencion',
  'uuidfiscal', 'uuid_fiscal',
  'diascredito', 'dias_credito',
  'noclientepadre', 'no_cliente_padre',
  'nombreclientepadre', 'nombre_cliente_padre',
  'diapagoclave', 'clavediapagocc13', 'clave_dia_pago_cc13',
  'diapagonombre', 'nombrediapagocc13', 'nombre_dia_pago_cc13',
  'frecuenciafacturacionclave', 'clavefrecuenciafacturacioncc17', 'clave_frecuencia_facturacion_cc17',
  'frecuenciafacturacionnombre', 'nombrefrecuenciafacturacioncc17', 'nombre_frecuencia_facturacion_cc17',
  'norecibosepagofactura', 'no_recibo_se_pago_factura',
]);

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

  // ── Días de crédito numéricos ── (campo nuevo 2026-05-14)
  // El API trae "Dias_Credito" como string padded ("30 ", "1  "); convertimos
  // a number. Si no parsea, undefined (cae a fallback de client.creditDays
  // catálogo). Mantener condPago para compatibilidad histórica.
  const diasCreditoRaw = pick(raw, ['diasCredito', 'dias_credito', 'Dias_Credito']);
  const diasCreditoNum = diasCreditoRaw == null ? undefined : toNum(diasCreditoRaw);
  const diasCredito = diasCreditoNum && Number.isFinite(diasCreditoNum) && diasCreditoNum > 0
    ? Math.round(diasCreditoNum)
    : undefined;

  // ── Cliente padre (grupo comercial JDE) ── (campo nuevo 2026-05-14)
  // Autoridad sobre commercialGroupName del catálogo cuando viene poblado.
  const noClientePadreRaw = toStr(pick(raw, ['noClientePadre', 'no_cliente_padre', 'No_Cliente_Padre']));
  const noClientePadre = noClientePadreRaw && noClientePadreRaw !== '0' ? noClientePadreRaw : undefined;
  const nombreClientePadre = toStr(pick(raw, ['nombreClientePadre', 'nombre_cliente_padre', 'Nombre_Cliente_Padre'])) || undefined;

  // ── Día de pago preferido (CC13) ── (campo nuevo 2026-05-14)
  // Regla del cliente: "paga los viernes". Útil para snap-to-day en proyección.
  const diaPagoClave = toStr(pick(raw, ['diaPagoClave', 'claveDiaPagoCc13', 'clave_dia_pago_cc13', 'Clave_Dia_Pago_CC13'])) || undefined;
  const diaPagoNombre = toStr(pick(raw, ['diaPagoNombre', 'nombreDiaPagoCc13', 'nombre_dia_pago_cc13', 'Nombre_Dia_Pago_CC13'])) || undefined;

  // ── Frecuencia de facturación (CC17) ── (campo nuevo 2026-05-19)
  // Cadencia con que el cliente factura (MENSUAL/SEMANAL/QUINCENAL). Autoridad
  // JDE sobre Client.frequency del catálogo estático.
  const frecuenciaFacturacionClave = toStr(pick(raw, ['frecuenciaFacturacionClave', 'claveFrecuenciaFacturacionCc17', 'clave_frecuencia_facturacion_cc17', 'Clave_Frecuencia_Facturacion_CC17'])) || undefined;
  const frecuenciaFacturacionNombre = toStr(pick(raw, ['frecuenciaFacturacionNombre', 'nombreFrecuenciaFacturacionCc17', 'nombre_frecuencia_facturacion_cc17', 'Nombre_Frecuencia_Facturacion_CC17'])) || undefined;

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
    claveDiaPagoCc13:        diaPagoClave ?? '',
    nombreDiaPagoCc13:       diaPagoNombre ?? '',
    noReciboSePagoFactura:   toStr(pick(raw, [
      'noReciboSePagoFactura',
      'No_recibo_Se_Pago_Factura',
      'No_Recibo_Se_Pago_Factura',
      'no_recibo_se_pago_factura',
    ])),
    noClientePadre,
    nombreClientePadre,
    diasCredito,
    diaPagoClave,
    diaPagoNombre,
    frecuenciaFacturacionClave,
    frecuenciaFacturacionNombre,
    // INTENCIONALMENTE NO persistimos `raw` aquí: con 10k+ facturas y ~30
    // campos cada una, el JSON.stringify del store excedía el quota de
    // 5 MB de localStorage y la app crasheaba al intentar guardar. Si se
    // necesita inspeccionar el raw para debug, se puede activar bajo flag
    // dev (env VITE_COBRANZA_KEEP_RAW=1) o leerlo desde el log
    // `[cobranza] sample raw record` en la consola.
  };
}

/**
 * POST /JDEdwards/cobranza
 *
 * Retorna las facturas de cobranza (CXC) abiertas/históricas para la
 * compañía indicada en el rango de fechas dado.
 *
 * Body de ejemplo:
 *   { "cia": "00011,", "fechaInicial": "2024-01-01", "fechaFinal": "2026-04-29" }
 *
 * IMPORTANTE — coma trailing en `cia`:
 *   El equipo JDE compartió el body con la cia terminando en coma. No es
 *   un typo: replicamos exactamente ese formato porque al menos un usuario
 *   reportó respuesta vacía cuando se enviaba "00011" sin coma. Por
 *   seguridad, si el caller manda la cia sin coma, se la agregamos aquí.
 *
 * IMPORTANTE — `fechaInicial` no puede ser `null`:
 *   Aunque el body de ejemplo que compartió el equipo JDE el 2026-05-01
 *   incluía `"fechaInicial": null`, ese formato regresa SIEMPRE `data: []`
 *   (validado contra api.gruposenda.com el 2026-05-03 sobre las 29 cías
 *   del catálogo). Hay que mandar una fecha ISO `YYYY-MM-DD`. El caller
 *   en App.tsx ya pasa `hoy - 365 días` y eso es lo que la app usa hoy.
 *   Si en el futuro el equipo libera el modo "histórico completo", revisar
 *   este comentario.
 *
 * Notas:
 *   • Como /antiguedadsaldos, una compañía por request. Para múltiples
 *     compañías llamar en serie y mergear.
 *   • El browser llama a `/api/jde`; Atlas/backend o el proxy de Vite local
 *     inyectan el token server-side.
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
  const list = stripAllToWhitelist(unwrapList(raw), KEPT_COBRANZA_FIELDS);

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

  return dropExcludedByCia(list.map(mapCobranza));
}

// ───────────────────────────────────────────────────────────────
// 5. Indicadores de Cobranza (recibos / aplicaciones)
// ───────────────────────────────────────────────────────────────

/**
 * Whitelist de campos consumidos por mapCobranzaPaymentApplication +
 * mapCobranzaPaymentHeader. Mantener en sync con los aliases de ambos
 * mappers. `Tipo_Cliente` está en la respuesta pero no se usa (cero refs);
 * `Importe_Pte_Factura` se eliminó del tipo el 2026-05-24 (se mapeaba pero
 * jamás se leía en producción) — ambos quedan fuera del whitelist.
 *
 * Nota: las llaves del API vienen con espacios (`Id Pago`, `No Factura`) y
 * separadores variables; `pick()` normaliza por lowercase. Aquí guardamos
 * `id pago` con espacio explícito porque `stripToWhitelist` compara por
 * lowercase exacto del key recibido.
 */
const KEPT_INDICADORES_FIELDS = new Set<string>([
  'id pago', 'id_pago', 'idpago',
  'cia', 'compania',
  'no recibo', 'no_recibo', 'norecibo',
  'fecha cobro', 'fecha_cobro', 'fechacobro',
  'fecha contable', 'fecha_contable', 'fechacontable',
  'cta bancaria', 'cta_bancaria', 'cuenta bancaria', 'cuenta_bancaria', 'cuentabancaria',
  'banco',
  'importe recibo', 'importe_recibo', 'importerecibo',
  'pendiente de aplicar', 'pendiente_de_aplicar', 'pendienteaplicar',
  'no cliente', 'no_cliente', 'nocliente',
  'cliente',
  'no batch', 'no_batch', 'nobatch',
  'tipo cambio', 'tipo_cambio', 'tipocambio',
  'fecha aplicacion', 'fecha_aplicacion', 'fechaaplicacion',
  'tipo docto', 'tipo_docto', 'tipodocto',
  'no factura', 'no_factura', 'nofactura', 'factura',
  'fecha factura', 'fecha_factura', 'fechafactura',
  'fecha vencimiento', 'fecha_vencimiento', 'fechavencimiento',
  'dias antiguedad fafv', 'dias_antiguedad_fafv', 'diasantiguedadfafv',
  'importe cobrado', 'importe_cobrado', 'importecobrado',
  'importe original factura', 'importe_original_factura', 'importeoriginalfactura',
  'tasa iva', 'tasa_iva', 'tasaiva',
  'importe iva factura original', 'importe_iva_factura_original', 'importeivafacturaoriginal',
]);

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
    .filter(payment => payment.fechaCobro && payment.cuentaBancaria && payment.importeRecibo > 0 && !matchesExclusionIdentity({ cia: payment.cia }))
    .sort((a, b) => a.fechaCobro.localeCompare(b.fechaCobro) || a.idPago.localeCompare(b.idPago));
}

/**
 * POST /cobranzaindicadores vía el proxy JDE estándar.
 *
 * Reporte de pagos/recibos y aplicaciones de cobranza. Liberado en producción
 * el 2026-05-07 en `api.gruposenda.com/JDEdwards/cobranzaindicadores`,
 * por lo que ya usa el mismo cliente, token y proxy que el resto de las APIs
 * JDE — sin upstream separado ni headers de auth custom. La respuesta plana
 * se normaliza a un pago por `Id Pago`, con sus facturas aplicadas anidadas.
 */
export async function fetchIndicadoresCobranza(
  req: CobranzaPaymentRequest,
  config: JdeClientConfig = {},
): Promise<CobranzaPayment[]> {
  const raw = await jdeClient.post<unknown>('/cobranzaindicadores', req, withLongRunningDefaults(config));
  const rows = stripAllToWhitelist(unwrapList(raw), KEPT_INDICADORES_FIELDS);
  return normalizeCobranzaPayments(rows, req.cia);
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

/**
 * Whitelist de campos consumidos por mapCompras. Mantener en sync con los
 * aliases del mapper. `Tipo_Cliente` aparece en la respuesta de /compras pero
 * NO se usa (cero refs en código) — se descarta aquí explícitamente.
 */
const KEPT_COMPRAS_FIELDS = new Set<string>([
  'compañia', 'compania', 'cia', 'company',
  'c_proveedor', 'noproveedor',
  'n_proveedor', 'nombreproveedor',
  'n_orden', 'noorden',
  't_orden', 'tipoorden',
  'd_t_orden', 'desctipoorden',
  'l_orden', 'lineaorden',
  'c_producto', 'noproducto',
  'd_producto', 'descproducto',
  'concepto',
  'cantidad',
  'precio_u', 'preciounitario',
  'precio_t', 'importetotal', 'importe',
  't_moneda', 'moneda', 'currency',
  'tipo_cambio', 'tipocambio',
  'f_orden', 'f_pedido', 'fechapedido',
  'f_recepcion', 'f_recepción', 'fecharecepcion',
  'f_cancelada', 'fechacancelada',
  'd_credito', 'diascredito',
  'n_factura', 'nofactura',
  'centro_costos', 'centrocostos',
  'categoria',
  'desc_categoria', 'desccategoria',
  'familia',
  'desc_familia', 'descfamilia',
  'subfamilia', 'sub_familia',
  'desc_subfamilia', 'desc_sub_familia', 'descsubfamilia',
  'edo_sig', 'estadosiguiente',
  'tasa_fiscal', 'tasafiscal',
]);

function mapCompras(raw: RawRecord): ComprasRecord {
  // El nuevo servicio (dev 2026-05-19) manda la fecha de pedido como
  // `F_Orden`; el anterior usaba `F_Pedido`. Aceptamos ambos para no perder
  // el dato en silencio durante la transición dev→prod.
  const fechaPedido = trimIsoDate(pick(raw, ['F_Orden', 'F_Pedido', 'f_orden', 'f_pedido', 'fechaPedido']));
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
 * POST /JDEdwards/compras
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
  const rows = stripAllToWhitelist(unwrapList(raw), KEPT_COMPRAS_FIELDS);
  return dropExcludedByCia(rows.map(mapCompras));
}

/**
 * Fetch órdenes de compra de UNA compañía pidiendo MES POR MES con cache por
 * mes calendario.
 *
 * Antes pedíamos 1 día/request → en un backfill de 365 días ~80% devolvía
 * `data: []` (fines de semana, festivos, baja densidad de OCs por día) y el
 * boot quemaba miles de round-trips vacíos. Mensual recorta el tráfico ~30×
 * y mantiene el cache estable (key = `M:compras.{cia}.{YYYY-MM}`).
 *
 * Reglas del helper:
 *   • Meses pasados se sirven del cache (un request por mes la primera vez).
 *   • El mes actual SIEMPRE re-fetch (datos siguen llegando).
 *   • La API recibe ventanas de mes completo `[firstOfMonth, lastOfMonth]`,
 *     o `[firstOfMonth, today]` para el mes en curso — nunca fechas futuras.
 *
 * Deduplica por `(cia, noOrden, lineaOrden)` para tolerar registros repetidos
 * entre meses contiguos o reentregas del API.
 *
 * @param cia    Código de compañía JDE (p.ej. "00011").
 * @param from   YYYY-MM-DD inclusive (cualquier día del primer mes).
 * @param to     YYYY-MM-DD inclusive (cualquier día del último mes).
 * @param options Concurrencia (default 4), callback de progreso, config JDE.
 */
export async function fetchComprasRange(
  cia: string,
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
  // cubre el flakeo upstream sin perder meses enteros.
  const MAX_ATTEMPTS = 3;
  const fetchMonthWithRetry = async (
    monthFrom: string,
    monthTo: string,
  ): Promise<ComprasRecord[]> => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await fetchCompras(
          { cia, fechaInicial: monthFrom, fechaFinal: monthTo },
          config,
        );
      } catch (err) {
        lastErr = err;
        if (attempt === MAX_ATTEMPTS) break;
        const delayMs = 500 * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastErr;
  };

  const all = await fetchRangeWithMonthlyCache<ComprasRecord>('compras', {
    from,
    to,
    cia,
    fetchMonth: fetchMonthWithRetry,
    onProgress: options.onProgress,
    concurrency: options.concurrency ?? 4,
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
 * Parsea una fecha JDE en formato dd/mm/yyyy (p.ej. "13/04/2026") a
 * YYYY-MM-DD. Tolera años de 2 dígitos y entradas ya ISO. Devuelve '' para
 * valores vacíos o fechas centinela ("1899-..." / "0001-...").
 */
function parseDmyDate(v: unknown): string {
  const s = toStr(v);
  if (!s) return '';
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) {
    const iso = trimIsoDate(v);
    return isSentinelJdeDate(iso) ? '' : iso;
  }
  const day = m[1].padStart(2, '0');
  const month = m[2].padStart(2, '0');
  const year = m[3].length === 2 ? `20${m[3]}` : m[3].padStart(4, '0');
  const iso = `${year}-${month}-${day}`;
  return isSentinelJdeDate(iso) ? '' : iso;
}

/**
 * Whitelist de campos consumidos por mapAuxiliarContable. Mantener en sync
 * con los aliases del mapper. La respuesta JDE trae ~40 campos por línea;
 * stripping in-place reduce huella de heap durante el parse de batches grandes
 * (el reconciliador histórico procesa ~2 años × ~100k líneas por cía).
 *
 * Documentación de descartes en CLAUDE.md (tabla 2026-05-24): Unidad_Negocios,
 * Nivel_Cuenta, periodo, ano, Sublibro*, No_direccion, Presupuesto, contaAF,
 * activo, no_unidad, Unidades, originador/Ultimo_Modifica_Batch,
 * Fecha_*_Batch, Hora_Modifica, Ubicación/Almacen/AlmaFilial, Orden_Venta,
 * Tipo_OV, Refacturacion, CodigoCategoria* y CC_Centro_Costos_46/47.
 */
const KEPT_AUXILIAR_FIELDS = new Set<string>([
  'cia', 'compañia', 'compania', 'company',
  'cuenta', 'cuentacontable',
  'idcuenta', 'id_cuenta',
  'cuenta_objeto', 'cuentaobjeto',
  'nombre_cta', 'nombrecuenta',
  'cuenta_banco', 'cuentabanco',
  'tipo_docto', 'tipodocto',
  'no_docto', 'nodocto',
  'no_factura', 'nofactura',
  'no_orden_compra', 'noordencompra',
  'fecha_contable_ddmmaa', 'fecha_contable', 'fechacontable',
  'tipo_libro', 'tipolibro',
  'no_batch', 'nobatch',
  'tipo_batch', 'tipobatch',
  'estatus_conciliado', 'estatusconciliado',
  'importe',
  'moneda', 'currency',
  'tipo_cambio', 'tipocambio',
  'posteo',
  'reversa',
  'concepto',
  'explicacion', 'explicación',
  'nombre',
  'tipo_pago', 'tipopago',
  'no_pago', 'nopago',
  'fecha_pago_ddmmaa', 'fecha_pago', 'fechapago',
  'documento_original', 'documentooriginal',
  'importe_original', 'importeoriginal',
]);

function mapAuxiliarContable(raw: RawRecord): AuxiliarContableRecord {
  return {
    cia:               normalizeCia(pick(raw, ['Cia', 'cia', 'Compañia', 'Compania', 'compania', 'company'])),
    cuentaContable:    toStr(pick(raw, ['Cuenta', 'cuenta', 'cuentaContable'])),
    idCuenta:          toStr(pick(raw, ['IdCuenta', 'idCuenta', 'id_cuenta'])),
    cuentaObjeto:      toStr(pick(raw, ['Cuenta_Objeto', 'cuenta_objeto', 'cuentaObjeto'])),
    nombreCuenta:      toStr(pick(raw, ['Nombre_Cta', 'nombre_cta', 'nombreCuenta'])),
    cuentaBanco:       toStr(pick(raw, ['Cuenta_Banco', 'cuenta_banco', 'cuentaBanco'])),
    tipoDocto:         toStr(pick(raw, ['Tipo_Docto', 'tipo_docto', 'tipoDocto'])),
    noDocto:           toNum(pick(raw, ['No_Docto', 'no_docto', 'noDocto'])),
    noFactura:         toStr(pick(raw, ['No_Factura', 'no_factura', 'noFactura'])),
    noOrdenCompra:     toStr(pick(raw, ['No_Orden_Compra', 'no_orden_compra', 'noOrdenCompra'])),
    fechaContable:     parseDmyDate(pick(raw, ['Fecha_Contable_ddmmaa', 'fecha_contable_ddmmaa', 'Fecha_Contable', 'fechaContable'])),
    tipoLibro:         toStr(pick(raw, ['Tipo_Libro', 'tipo_libro', 'tipoLibro'])),
    noBatch:           toNum(pick(raw, ['No_Batch', 'no_batch', 'noBatch'])),
    tipoBatch:         toStr(pick(raw, ['Tipo_Batch', 'tipo_batch', 'tipoBatch'])),
    estatusConciliado: toStr(pick(raw, ['Estatus_conciliado', 'estatus_conciliado', 'estatusConciliado'])),
    importe:           toNum(pick(raw, ['Importe', 'importe'])),
    moneda:            toStr(pick(raw, ['Moneda', 'moneda', 'currency'])) || 'MXP',
    tipoCambio:        toNum(pick(raw, ['Tipo_Cambio', 'tipo_cambio', 'tipoCambio'])),
    posteo:            toStr(pick(raw, ['Posteo', 'posteo'])),
    reversa:           toStr(pick(raw, ['Reversa', 'reversa'])),
    concepto:          toStr(pick(raw, ['concepto', 'Concepto'])),
    explicacion:       toStr(pick(raw, ['explicacion', 'Explicacion', 'explicación'])),
    nombre:            toStr(pick(raw, ['Nombre', 'nombre'])),
    tipoPago:          toStr(pick(raw, ['tipo_pago', 'Tipo_Pago', 'tipoPago'])),
    noPago:            toStr(pick(raw, ['no_pago', 'No_Pago', 'noPago'])),
    fechaPago:         parseDmyDate(pick(raw, ['Fecha_pago_ddmmaa', 'fecha_pago_ddmmaa', 'Fecha_Pago', 'fechaPago'])),
    documentoOriginal: toStr(pick(raw, ['documento_Original', 'documento_original', 'documentoOriginal'])),
    importeOriginal:   toNum(pick(raw, ['Importe_Original', 'importe_original', 'importeOriginal'])),
  };
}

/**
 * POST /JDEdwards/AuxiliarContable — UNA compañía por request.
 *
 * Devuelve el libro mayor JDE posteado contra las cuentas del rango de
 * objeto contable indicado. Para rangos de fecha amplios usar
 * `fetchAuxiliarContableRange`.
 */
export async function fetchAuxiliarContable(
  req: AuxiliarContableRequest,
  config: JdeClientConfig = {},
): Promise<AuxiliarContableRecord[]> {
  // Allowlist explícita — solo 6 cías. Bloqueamos cualquier otra ANTES de
  // pegarle al API. Cía 33 (multicarga) se incluye explícitamente aquí pese
  // a estar en la exclusión global; por eso NO usamos `dropExcludedByCia`
  // downstream — el filtro de allowlist ya es el gate canónico para auxiliar.
  if (!isAuxiliarAllowlistedCia(req.cia)) return [];
  // El path debe ir en PascalCase exacto: el endpoint JDE está registrado
  // como /JDEdwards/AuxiliarContable y responde 404 a `/auxiliarcontable`.
  const raw = await jdeClient.post<unknown>('/AuxiliarContable', req, config);
  const rows = stripAllToWhitelist(unwrapList(raw), KEPT_AUXILIAR_FIELDS);
  return rows.map(mapAuxiliarContable);
}

/**
 * Fetch del auxiliar contable de UNA compañía pidiendo DÍA POR DÍA con cache
 * por día calendario (mismo patrón que el loader de estados de cuenta).
 *
 * El API rebota con rangos de mes — solo procesa un día por request, así que
 * `fechaInicial === fechaFinal` en cada llamada. Días pasados se sirven del
 * cache IDB (`auxiliarcontable.{cia}.{YYYY-MM-DD}`); el primer backfill es
 * pesado pero queda cacheado.
 *
 * `params` (tl/nr/objetos) son constantes fijas — viven en
 * `domain/auxiliarReconciliationConfig.ts`. El API tampoco acepta un rango de
 * objeto (`objIni` debe igualar `objFin`): se hace UNA request por objeto
 * (Caja 1010 + Bancos 1020) y se mergea.
 *
 * Deduplica por `(cia, idCuenta, noDocto, tipoDocto)`.
 */
export async function fetchAuxiliarContableRange(
  cia: string,
  from: string,
  to: string,
  params: { tl: string; nr: number; objetos: readonly { ini: string; fin: string }[] },
  options: {
    concurrency?: number;
    onProgress?: (done: number, total: number) => void;
    /**
     * Llamado por CADA día con records — cache hits y fetches frescos.
     * Permite al caller persistir incrementalmente sin esperar a que la cía
     * complete sus ~520 días.
     */
    onDay?: (records: AuxiliarContableRecord[]) => void;
    config?: JdeClientConfig;
    /**
     * Namespace del cache diario IDB. Default `'auxiliarcontable'` (conciliación
     * banco↔ERP). El fetch de IVA usa uno distinto para no contaminar ese cache
     * con un set de objetos contables diferente.
     */
    cacheNamespace?: string;
  } = {},
): Promise<AuxiliarContableRecord[]> {
  const config = options.config ?? {};
  const cacheNamespace = options.cacheNamespace ?? 'auxiliarcontable';

  // Piso duro: nunca pedir auxiliar contable < 2025-01-01 (decisión
  // 2026-05-25). 2024 queda descartado por completo aún si el caller pasa
  // un `from` más viejo.
  const AUX_HARD_FLOOR = '2025-01-01';
  if (from < AUX_HARD_FLOOR) from = AUX_HARD_FLOOR;
  if (to < AUX_HARD_FLOOR) return [];

  const MAX_ATTEMPTS = 3;
  // 7 días por chunk (decisión 2026-05-26 #2). Antes 1 día: cada cía YTD
  // pegaba ~146 requests JDE serializados — 3-4h por boot. Con timeout JDE
  // subido a 240s y fallback per-día explícito abajo, 7d es seguro: chunks
  // pesados que rebotan se reintentan UNO POR UNO sin envenenar el cache.
  // Costo: ~125 reqs/cia para YTD vs 146 (mejora ~7x), tiempo ~20-30 min
  // por boot cold vs 3-4h. El daily-cache IDB seguía siendo per-día (split
  // dentro de `fetchRangeWithChunkedDailyCache`).
  const AUX_CHUNK_DAYS = 7;
  const fetchChunkOnce = (
    chunkFrom: string,
    chunkTo: string,
  ): Promise<AuxiliarContableRecord[]> =>
    Promise.all(
      params.objetos.map((rango) =>
        fetchAuxiliarContable(
          {
            cia,
            fechaInicial: chunkFrom,
            fechaFinal: chunkTo,
            tl: params.tl,
            nr: params.nr,
            objIni: rango.ini,
            objFin: rango.fin,
          },
          config,
        ),
      ),
    ).then((perObjeto) => perObjeto.flat());

  const fetchChunkWithRetry = async (
    chunkFrom: string,
    chunkTo: string,
  ): Promise<AuxiliarContableRecord[]> => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Una request por rango de objeto contable × ventana de 3 días.
        // API acepta objIni≠objFin Y rangos de fecha amplios. El cache se
        // llena per-día (splittea por fechaContable dentro de
        // `fetchRangeWithChunkedDailyCache`) — días no-operativos quedan
        // cacheados como `[]` sin disparar request extra.
        return await fetchChunkOnce(chunkFrom, chunkTo);
      } catch (err) {
        lastErr = err;
        if (attempt === MAX_ATTEMPTS) break;
        const delayMs = 500 * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    // Fallback per-día: chunks de 3 días pueden tronar por timeout o por
    // payload pesado en ventanas con mucho movimiento. Reintentamos UNO POR
    // UNO los días del chunk — payload más chico = respuesta más rápida,
    // menos chance de timeout. Días que igual fallen quedan vacíos y NO se
    // cachean (no envenenan); reintenta en boot siguiente.
    // eslint-disable-next-line no-console
    console.warn(`[auxiliarcontable] ${cia} chunk ${chunkFrom}..${chunkTo} falló 3x · fallback per-día`);
    const days: string[] = [];
    {
      const start = new Date(chunkFrom + 'T00:00:00Z');
      const end = new Date(chunkTo + 'T00:00:00Z');
      for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        days.push(d.toISOString().slice(0, 10));
      }
    }
    const perDay: AuxiliarContableRecord[][] = [];
    let perDaySuccess = 0;
    for (const day of days) {
      try {
        perDay.push(await fetchChunkOnce(day, day));
        perDaySuccess++;
      } catch (dayErr) {
        // eslint-disable-next-line no-console
        console.warn(`[auxiliarcontable] ${cia} día ${day} falló: ${dayErr instanceof Error ? dayErr.message : String(dayErr)}`);
        perDay.push([]);
      }
    }
    if (perDaySuccess === 0) throw lastErr;
    return perDay.flat();
  };

  const all = await fetchRangeWithChunkedDailyCache<AuxiliarContableRecord>(
    cacheNamespace,
    {
      from,
      to,
      cia,
      chunkSize: AUX_CHUNK_DAYS,
      fetchChunk: fetchChunkWithRetry,
      dateOf: (r) => r.fechaContable,
      onProgress: options.onProgress,
      onDay: options.onDay,
      concurrency: options.concurrency ?? 4,
    },
  );

  const seen = new Set<string>();
  const merged: AuxiliarContableRecord[] = [];
  for (const rec of all) {
    const key = `${rec.cia}::${rec.idCuenta}::${rec.noDocto}::${rec.tipoDocto}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(rec);
  }
  return merged;
}

function rangeKey(range: AuxObjetoRange): string {
  return `${range.ini.trim()}-${range.fin.trim()}`;
}

function rangeSide(range: AuxObjetoRange): 'creditable' | 'caused' | 'other' {
  const ini = Number.parseInt(range.ini, 10);
  const fin = Number.parseInt(range.fin, 10);
  if (!Number.isFinite(ini) || !Number.isFinite(fin)) return 'other';
  if (fin < 2000) return 'creditable';
  if (ini >= 2000 && fin < 3000) return 'caused';
  return 'other';
}

function sortObjetoRanges(ranges: AuxObjetoRange[]): AuxObjetoRange[] {
  return [...ranges].sort((a, b) =>
    a.ini.localeCompare(b.ini) || a.fin.localeCompare(b.fin),
  );
}

function uniqueObjetoRanges(ranges: AuxObjetoRange[]): AuxObjetoRange[] {
  const out = new Map<string, AuxObjetoRange>();
  for (const range of ranges) {
    const clean = { ini: range.ini.trim(), fin: range.fin.trim() };
    if (!clean.ini || !clean.fin) continue;
    out.set(rangeKey(clean), clean);
  }
  return sortObjetoRanges(Array.from(out.values()));
}

function ivaCacheNamespace(ranges: readonly AuxObjetoRange[]): string {
  const fingerprint = uniqueObjetoRanges([...ranges])
    .map(rangeKey)
    .join('_')
    .replace(/[^A-Za-z0-9_-]+/g, '_');
  return `auxiliarcontable-iva-${AUX_IVA_LEDGER_VERSION}:${fingerprint || 'none'}`;
}

function selectIvaFullObjetoRanges(
  discoverySample: AuxiliarContableRecord[],
  discoveryObjetos: readonly AuxObjetoRange[] = AUX_IVA_PARAMS.discoveryObjetos,
): AuxObjetoRange[] {
  const discovered = discoverIvaObjetosByKind(discoverySample);
  const exact: AuxObjetoRange[] = [
    ...Array.from(discovered.creditable).map((obj) => ({ ini: obj, fin: obj })),
    ...Array.from(discovered.caused).map((obj) => ({ ini: obj, fin: obj })),
    ...Array.from(discovered.withheld).map((obj) => ({ ini: obj, fin: obj })),
  ];
  const hasCreditable = discovered.creditable.size > 0;
  const hasCaused = discovered.caused.size > 0;
  const activeCandidates = discoveryObjetos.filter((range) => rangeSide(range) === 'creditable');
  const passiveCandidates = discoveryObjetos.filter((range) => rangeSide(range) === 'caused');
  const otherCandidates = discoveryObjetos.filter((range) => rangeSide(range) === 'other');

  if (!hasCreditable) exact.push(...activeCandidates);
  if (!hasCaused) exact.push(...passiveCandidates);
  if (!hasCreditable && !hasCaused) exact.push(...otherCandidates);

  return uniqueObjetoRanges(exact.length > 0 ? exact : [...discoveryObjetos]);
}

/**
 * Fetch de las cuentas de IVA del libro mayor para alimentar el cálculo fiscal
 * REAL (acreditable + causado) sin estimar. Descubrimiento en dos fases:
 *
 *   Fase A (discovery): un mes reciente sobre los rangos candidato
 *     (`AUX_IVA_PARAMS.discoveryObjetos`). Se identifican por nombre los objetos
 *     contables que son IVA (`discoverIvaObjetos` → `classifyIvaAccount`).
 *   Fase B (full): el rango histórico completo SOLO de esos objetos exactos
 *     (rango angosto → rápido, no revive el timeout del rango completo).
 *
 * Cache separado del de la conciliación: discovery/full usan namespaces v2
 * parametrizados por objetos contables. NO toca `AUX_RECON_PARAMS` (1010-1020).
 *
 * Falla suave: si discovery no encuentra cuentas de IVA, usa los rangos
 * candidato directo para la fase B (el diagnóstico revelará si hay que ajustar
 * `VITE_AUX_IVA_OBJETOS`).
 */
export async function fetchAuxiliarContableIvaRange(
  cia: string,
  from: string,
  to: string,
  options: {
    /** Inicio de la ventana de discovery (default: primer día del mes de `to`). */
    discoveryFrom?: string;
    onDay?: (records: AuxiliarContableRecord[]) => void;
    config?: JdeClientConfig;
  } = {},
): Promise<AuxiliarContableRecord[]> {
  const { config, onDay } = options;
  const discoveryFrom = options.discoveryFrom ?? `${to.slice(0, 7)}-01`;
  const discoveryNamespace = ivaCacheNamespace(AUX_IVA_PARAMS.discoveryObjetos);

  // Fase A — discovery acotado a un mes sobre rangos candidato.
  const discoverySample = await fetchAuxiliarContableRange(
    cia,
    discoveryFrom,
    to,
    { tl: AUX_IVA_PARAMS.tl, nr: AUX_IVA_PARAMS.nr, objetos: AUX_IVA_PARAMS.discoveryObjetos },
    { config, cacheNamespace: `${discoveryNamespace}:discovery` },
  );

  const objetos = selectIvaFullObjetoRanges(discoverySample, AUX_IVA_PARAMS.discoveryObjetos);
  const cacheNamespace = ivaCacheNamespace(objetos);

  // Fase B — rango completo solo de los objetos de IVA descubiertos.
  return fetchAuxiliarContableRange(
    cia,
    from,
    to,
    { tl: AUX_IVA_PARAMS.tl, nr: AUX_IVA_PARAMS.nr, objetos },
    { config, onDay, cacheNamespace },
  );
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
  const windows = splitIntoMonthlyWindows(from, to);
  if (windows.length === 0) return [];

  options.onProgress?.(0, windows.length);
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const results: CobranzaPayment[][] = new Array(windows.length);
  const failedWindows: string[] = [];
  let cursor = 0;
  let completed = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const slot = cursor++;
      if (slot >= windows.length) return;
      const w = windows[slot];
      try {
        results[slot] = await fetchIndicadoresCobranza(
          { cia, fechaInicial: w.from, fechaFinal: w.to },
          config,
        );
      } catch (err) {
        failedWindows.push(`${w.from}..${w.to}`);
        // eslint-disable-next-line no-console
        console.warn(
          `[cobranzaindicadores] ${cia} ventana ${w.from}..${w.to} falló: ${err instanceof Error ? err.message : String(err)}`,
        );
        results[slot] = [];
      } finally {
        completed += 1;
        options.onProgress?.(completed, windows.length);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, windows.length) }, worker),
  );

  if (failedWindows.length === windows.length) {
    throw new JdeApiError(
      `JDE /cobranzaindicadores no respondió para ${cia} en ninguna ventana mensual`,
      504,
      '/cobranzaindicadores',
      { cia, from, to, failedWindows },
    );
  }

  if (failedWindows.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[cobranzaindicadores] ${cia} completó parcial: ${windows.length - failedWindows.length}/${windows.length} ventanas`,
    );
  }

  const byId = new Map<string, CobranzaPayment>();
  for (const payment of results.flat()) {
    byId.set(payment.idPago, payment);
  }
  return Array.from(byId.values()).sort((a, b) => a.fechaCobro.localeCompare(b.fechaCobro) || a.idPago.localeCompare(b.idPago));
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
  // TRESS prod usa "Obligación Empresa" para todo lo que el empleador entera
  // al SAT/IMSS/INFONAVIT — IMSS patronal, RCV, INFONAVIT, ISR retenido,
  // provisión ISN, etc. + algunos informativos exentos. El default es
  // EMPLOYER_TAX; `refineCashTreatment` separa los informativos (EXENTO,
  // GRAVADO, PROVISION) y el ISR retenido (WITHHOLDING_PAYABLE).
  'obligacion empresa': 'EMPLOYER_TAX',
  'obligación empresa': 'EMPLOYER_TAX',
  // "Prestación" en TRESS son mayoritariamente vales de despensa (no cash al
  // empleado en FechaPago, salen por monedero electrónico). Default NON_CASH
  // y `refineCashTreatment` promueve a CASH_OUT los pagos reales: indemnización,
  // gratificación por separación, prima de antigüedad.
  'prestacion': 'NON_CASH',
  'prestación': 'NON_CASH',
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

/**
 * Whitelist de campos consumidos por mapNominaRow. Mantener en sync con los
 * aliases del mapper.
 *
 * IMPORTANTE — desviación de la tabla 2026-05-24: la tabla del usuario marcó
 * `TipoNomina` y `TipoConcepto` como ELIMINAR contando 4-6 refs cruda. Pero
 * el campo mapeado (`payrollType` / `conceptType`) tiene ~20+ refs en
 * payrollModuleService (huella dedup `year|month|cia|payrollType`,
 * refinement IMSS/ISR, dashboard), sourceRecords (id movement, ruleApplied,
 * filtro DEDUCCION) y PayrollDashboard (filtro UI). Removerlos rompería el
 * dashboard y la clasificación fina de IMSS/ISR/préstamos. Se conservan.
 */
const KEPT_NOMINA_FIELDS = new Set<string>([
  'idempresa', 'id_empresa', 'cia', 'compania',
  'empresa', 'nombreempresa', 'razonsocial',
  'monto', 'importe', 'amount',
  'periodo', 'numperiodo',
  'mes',
  'idconcepto', 'id_concepto',
  'concepto', 'nombreconcepto',
  'tiponomina', 'tipo_nomina',
  'tipoconcepto', 'tipo_concepto',
  'fechainical', 'fechainicial', 'fecha_inicial',
  'fechafinal', 'fecha_final',
  'fechapago', 'fecha_pago',
  'anio', 'year',
  'mes_num', 'nummes', 'monthnumber',
]);

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
 * 12 requests, una por mes.
 *
 * Sanity-check retry: AWS API Gateway puede truncar responses >1MB (ver
 * vite.config.ts:26), produciendo payloads que solo traen Percepciones (sin
 * Deducciones ni Aportaciones). Detectamos esa firma y reintentamos hasta
 * MAX_NOMINA_PARTIAL_RETRIES veces. Si tras los retries el response sigue
 * sospechoso, devolvemos lo que llegó (best-effort) — el caller decide si
 * mergea o no. Lanzar aquí dejaba al usuario con "Sin datos" hasta que
 * pulsara refresh manual.
 */
const MAX_NOMINA_PARTIAL_RETRIES = 2;

// Fan-out fallback cuando el wildcard (idEmpresa=99) se trunca >1MB. El
// contrato (jdeTypes NominaRequest) define idEmpresa como enum chico; 33
// Multicarga la app la excluye en bloque (companyExclusion / dropExcludedByCia),
// así que 99 menos 33 == unión de estas 4 — trocear aquí no pierde data y cada
// pieza es ~1/4 del payload, debajo del cap del gateway.
const NOMINA_FANOUT_EMPRESAS = [1, 11, 17, 42];
// Segundo nivel de troceo si una sola empresa-mes aún rebasa 1MB (meses
// bimodales gordos): 1 Semana/Operadores | 3 Quincena/Ejecutivos.
const NOMINA_FANOUT_TIPOS = [1, 3];

function isNominaResponseSuspect(records: PayrollCostRecord[]): boolean {
  if (records.length === 0) return false; // empty es legítimo
  // Firma 1: truncamiento total — la response solo trajo Percepciones (ningún
  // DEDUCTION ni EMPLOYER_TAX).
  if (
    !records.some(
      r => r.cashTreatment === 'DEDUCTION' || r.cashTreatment === 'EMPLOYER_TAX',
    )
  ) {
    return true;
  }
  // Firma 2: quincena suelta — trae deducciones pero el ratio
  // dedCount/cashCount es anormalmente bajo. Una nómina completa tiene ≥1
  // DEDUCTION/WITHHOLDING por cada CASH_OUT (mínimo IMSS empleado + ISR), así
  // que ratio < 0.3 casi nunca es legítimo y delata un mes truncado a media
  // nómina. Sin baseline cross-mes aquí (fetch de un solo mes), el ratio es el
  // único signal self-contained; mismo umbral que `findSuspectMonths`.
  let cashCount = 0;
  let dedCount = 0;
  for (const r of records) {
    if (r.cashTreatment === 'CASH_OUT') cashCount += 1;
    else if (r.cashTreatment === 'DEDUCTION' || r.cashTreatment === 'WITHHOLDING_PAYABLE') {
      dedCount += 1;
    }
  }
  return cashCount > 0 && dedCount / cashCount < 0.3;
}

// Firma de truncamiento específica de las APORTACIONES: la response trae
// percepciones (y puede traer deducciones) pero NINGÚN `EMPLOYER_TAX`. El
// gateway corta el payload >1MB justo en el bloque de Obligación Empresa, así
// que la nómina llega "completa" salvo las aportaciones patronales → la UI
// muestra Aportaciones = $0. `isNominaResponseSuspect` (Firma 1) NO la detecta
// porque su `.some(DEDUCTION || EMPLOYER_TAX)` se satisface con solo tener
// deducciones. Sin este signal el fan-out por tipoNómina nunca disparaba para
// ese caso. Nota: en la capa de fetch el `cashTreatment` aún es el crudo del
// mapper (`EMPLOYER_TAX` = Obligación Empresa); `refineBatch` corre después.
function nominaLacksEmployerTax(records: PayrollCostRecord[]): boolean {
  if (records.length === 0) return false; // empty es legítimo
  if (!records.some(r => r.cashTreatment === 'CASH_OUT')) return false;
  return !records.some(r => r.cashTreatment === 'EMPLOYER_TAX');
}

export async function fetchNomina(
  req: NominaRequest,
  config: JdeClientConfig = {},
): Promise<PayrollCostRecord[]> {
  return singleFlight(
    `nomina:${stableStringify(req)}:${stableStringify(config)}`,
    async () => {
  const merged: JdeClientConfig = {
    baseUrl: apiConfig.tress.baseUrl,
    ...config,
  };
  const fetchOne = async (r: NominaRequest): Promise<PayrollCostRecord[]> => {
    const raw = await jdeClient.post<unknown>('/Nomina', r, merged);
    const rows = stripAllToWhitelist(unwrapList(raw), KEPT_NOMINA_FIELDS);
    return dropExcludedByCia(rows.map(mapNominaRow));
  };

  const fetchWithRetry = async (r: NominaRequest): Promise<PayrollCostRecord[]> => {
    let recs: PayrollCostRecord[] = [];
    for (let attempt = 0; attempt <= MAX_NOMINA_PARTIAL_RETRIES; attempt++) {
      recs = await fetchOne(r);
      if (!isNominaResponseSuspect(recs)) return recs;
      if (attempt < MAX_NOMINA_PARTIAL_RETRIES) {
        console.warn(
          `[fetchNomina] response sospechoso (${recs.length} records, solo Percepciones) para ${JSON.stringify(r)} — retry ${attempt + 1}/${MAX_NOMINA_PARTIAL_RETRIES}`,
        );
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
    return recs; // best-effort tras retries
  };

  // Caller pidió UNA empresa específica (filtro UI): su payload es chico por
  // definición → fetch único con retry, sin fan-out.
  if (req.idEmpresa !== 99) return fetchWithRetry(req);

  // Wildcard "Todas" (boot + filtro "Todas"): trocear PROACTIVAMENTE por
  // empresa. El wildcard idEmpresa=99 trunca >1MB y deja empresas enteras
  // (p.ej. SIR) solo con Percepciones; como el agregado igual trae
  // deducciones de OTRAS empresas, un fan-out reactivo (mirando el agregado)
  // nunca lo detectaba → SIR quedaba en $0. Pedir cada empresa por separado
  // mantiene cada response <1MB. 99 == unión de [1,11,17,42] (33 Multicarga
  // ya excluida por dropExcludedByCia) → sin pérdida. Particiones disjuntas
  // por empresa/tipo → concat sin dedupe. Vive en la capa de red: el boot
  // sigue haciendo UN solo setNominaRecords (coalescing intacto).
  const fanout: PayrollCostRecord[] = [];
  for (const idEmpresa of NOMINA_FANOUT_EMPRESAS) {
    let empRecords = await fetchWithRetry({ ...req, idEmpresa });
    // Segundo troceo por tipoNómina cuando la empresa-mes aún rebasa 1MB.
    // Dispara por la firma de truncamiento general (`isNominaResponseSuspect`)
    // O por la firma específica de aportaciones faltantes
    // (`nominaLacksEmployerTax`): el corte del gateway puede dejar la nómina
    // entera salvo el bloque EMPLOYER_TAX, que la firma general no detecta.
    // Acotado a 2 sub-requests; si tras el troceo siguen faltando aportaciones
    // (mes en curso aún sin calcular en TRESS), devolvemos best-effort sin loop.
    if (
      req.tipoNomina === 99 &&
      (isNominaResponseSuspect(empRecords) || nominaLacksEmployerTax(empRecords))
    ) {
      const byTipo: PayrollCostRecord[] = [];
      for (const tipoNomina of NOMINA_FANOUT_TIPOS) {
        byTipo.push(...(await fetchWithRetry({ ...req, idEmpresa, tipoNomina })));
      }
      empRecords = byTipo;
    }
    fanout.push(...empRecords);
  }
  // Red de seguridad: fan-out totalmente vacío (TRESS caído) → último intento
  // wildcard antes de devolver vacío.
  if (fanout.length === 0) {
    console.error(
      `[fetchNomina] fan-out vacío para ${JSON.stringify(req)} — último intento wildcard`,
    );
    return fetchWithRetry(req);
  }
  return fanout;
    },
  );
}

// Exporta helpers internos para que los unit tests puedan ejercitarlos sin
// montar un mock del cliente HTTP.
export const __internal = {
  mapCobranza,
  mapNominaRow,
  inferCashTreatment,
  normalizeBankAccountNumber,
  selectIvaFullObjetoRanges,
  ivaCacheNamespace,
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

/**
 * Whitelist de campos consumidos por mapPagoProveedor. `Importe_Pago_Dolares`
 * se removió del tipo el 2026-05-24 (cero refs en producción, siempre 0 en
 * MXP) — queda fuera del whitelist y del mapper.
 */
const KEPT_PAGOPROVEEDOR_FIELDS = new Set<string>([
  'tipo_pago', 'tipopago',
  'no_pago', 'nopago',
  'no_cia', 'nocia', 'cia', 'compania',
  'nombre_cia', 'nombrecia',
  'cuenta_bancaria', 'cuentabancaria',
  'cuenta_banco', 'cuentabanco',
  'fecha_pago', 'fechapago',
  'importe_pago_pesos', 'importepesos',
  'moneda', 'currency',
  'batch_pago', 'batchpago',
  'clave_proveedor', 'claveproveedor',
  'rfc_proveedor', 'rfcproveedor',
  'nombre_proveedor', 'nombreproveedor',
  'tipo_busqueda', 'tipobusqueda',
  'clasificacion_proveedor', 'clasificacionproveedor',
  'clasificacion_proveedor_financiera', 'clasificacionproveedorfinanciera',
  'comentario_pago', 'comentariopago',
]);

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
 * POST /JDEdwards/pagoproveedor
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
  const rows = stripAllToWhitelist(unwrapList(raw), KEPT_PAGOPROVEEDOR_FIELDS);
  return dropExcludedByCia(rows.map(mapPagoProveedor));
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
    // Bancos no emiten CARGOs a proveedor en fines de semana / festivos —
    // mismo razonamiento que AuxiliarContable. Saltar evita 0-yield round-trips.
    const d = new Date(day + 'T00:00:00Z');
    if (!Number.isNaN(d.getTime()) && isNonOperatingDay(d)) return [];

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
    concurrency: options.concurrency ?? 10,
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

// ───────────────────────────────────────────────────────────────
// 9. ROL Diario (CITI — viajes ejecutados)
// ───────────────────────────────────────────────────────────────

/**
 * Calcula la fecha del lunes ISO de la semana indicada. Se usa para inferir
 * la fecha de despacho del viaje hasta que el API CITI exponga un campo de
 * fecha exacta.
 *
 * ISO 8601: la semana 1 contiene el primer jueves del año (equivalente: la
 * semana que contiene el 4 de enero).
 */
function isoWeekMonday(year: number, week: number): string {
  if (!Number.isFinite(year) || !Number.isFinite(week) || week < 1 || week > 53) return '';
  const jan4 = new Date(Date.UTC(year, 0, 4));
  // En JS: domingo=0; ISO: domingo=7.
  const jan4Dow = jan4.getUTCDay() || 7;
  // Lunes de la semana 1: 4-enero menos (jan4Dow - 1) días.
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Dow - 1));
  const target = new Date(week1Monday);
  target.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return target.toISOString().slice(0, 10);
}

function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    return t === 'true' || t === '1' || t === 'si' || t === 'sí';
  }
  return false;
}

function mapRol(raw: RawRecord): RolRecord {
  const anio = toNum(pick(raw, ['anio', 'Anio', 'año', 'Ano', 'year']));
  const semana = toNum(pick(raw, ['semana', 'Semana', 'week']));
  const fechaViaje = isoWeekMonday(anio, semana);

  return {
    cia:             normalizeCia(pick(raw, ['cia', 'Cia', 'compania', 'company'])),
    empresa:         toStr(pick(raw, ['empresa', 'D_Empresa', 'd_empresa'])),
    kCliente:        toNum(pick(raw, ['kCliente', 'K_Cliente', 'k_cliente'])),
    cCliente:        toStr(pick(raw, ['cCliente', 'C_Cliente', 'c_cliente'])),
    dCliente:        toStr(pick(raw, ['dCliente', 'D_Cliente', 'd_cliente'])),
    rfc:             toStr(pick(raw, ['rfc', 'RFC'])),
    claveJDE:        toStr(pick(raw, ['claveJDE', 'Clave_JDE', 'clave_jde'])),
    facturacionTipo: toStr(pick(raw, ['facturacionTipo', 'D_Facturacion_Tipo', 'd_facturacion_tipo'])),
    iva:             toNum(pick(raw, ['iva', 'IVA'])),
    tipoViaje:       toStr(pick(raw, ['tipoViaje', 'D_Tipo_Viaje', 'd_tipo_viaje'])),
    ruta:            toStr(pick(raw, ['ruta', 'D_Ruta', 'd_ruta'])),
    costoRuta:       toNum(pick(raw, ['costoRuta', 'Costo_Ruta', 'costo_ruta'])),
    viajes:          toNum(pick(raw, ['viajes', 'Viajes'])),
    subTotal:        toNum(pick(raw, ['subTotal', 'SubTotal', 'sub_total'])),
    despachado:      toBool(pick(raw, ['despachado', 'B_Despachado', 'b_despachado'])),
    efectuado:       toBool(pick(raw, ['efectuado', 'B_Efectuado', 'b_efectuado'])),
    anio,
    semana,
    fechaViaje,
    factura:         toStr(pick(raw, ['factura', 'Factura'])) || undefined,
    uuidFiscal:      toStr(pick(raw, ['uuidFiscal', 'UUID_Fiscal', 'uuid_fiscal'])) || undefined,
    plazaCiti:       toStr(pick(raw, ['plazaCiti', 'Plaza_CITI', 'plaza_citi'])) || undefined,
  };
}

let rolShapeLogged = false;

/**
 * POST /citi/roldiario
 *
 * Retorna viajes ejecutados del rango indicado. Endpoint productivo Senda
 * Citi (campos B_Despachado/B_Efectuado/Factura/UUID_Fiscal). El body usa
 * los nombres de campo confirmados por CITI (`f_Inicio`, `f_Final`,
 * `k_Servidor`) — ver `RolRequest`. La consulta es lenta (~20s+).
 */
export async function fetchRol(
  req: RolRequest,
  config: JdeClientConfig = {},
): Promise<RolRecord[]> {
  const merged = withLongRunningDefaults({
    baseUrl: apiConfig.citi.baseUrl,
    authValue: apiConfig.citi.authValue || undefined,
    // El endpoint /citi/roldiario es notablemente lento. fetchRolRange ya
    // trocea por mes, pero un mes pesado puede acercarse al techo global de
    // 120s. Subimos el timeout SOLO para roldiario (5 min) — no toca el
    // default global de jdeClient ni el resto de endpoints.
    timeoutMs: 300_000,
    ...config,
  });
  let raw: unknown;
  try {
    raw = await jdeClient.post<unknown>('/roldiario', req, merged);
  } catch (err) {
    // El endpoint CITI es nuevo (2026-05-14); si el body que mandamos no
    // empata con lo que espera, log el detalle del error para diagnosticar
    // sin tener que rebootar la app.
    // eslint-disable-next-line no-console
    console.warn(`[rol] fetch error: ${err instanceof Error ? err.message : String(err)} · body sent: ${JSON.stringify(req)}`);
    if (err instanceof JdeApiError) {
      // eslint-disable-next-line no-console
      console.warn(`[rol] server response body: ${typeof err.body === 'string' ? err.body : JSON.stringify(err.body)}`);
    }
    throw err;
  }
  const list = unwrapList(raw);

  if (typeof window !== 'undefined' && !rolShapeLogged) {
    rolShapeLogged = true;
    // eslint-disable-next-line no-console
    console.info(`[rol] ${list.length} registros entre ${req.f_Inicio} y ${req.f_Final} (k_Servidor=${req.k_Servidor ?? -1})`);
    if (list.length > 0) {
      // eslint-disable-next-line no-console
      console.info('[rol] sample raw record:', list[0]);
      // eslint-disable-next-line no-console
      console.info('[rol] sample mapped record:', mapRol(list[0]));
    } else {
      // eslint-disable-next-line no-console
      console.warn('[rol] respuesta VACÍA. Posibles causas: (1) endpoint sin permisos, (2) rango sin viajes, (3) body rechazado.');
    }
  }

  return dropExcludedByCia(list.map(mapRol));
}

/** Parte [from..to] (YYYY-MM-DD, inclusive) en ventanas por mes calendario. */
function splitIntoMonthlyWindows(from: string, to: string): Array<{ from: string; to: string }> {
  const windows: Array<{ from: string; to: string }> = [];
  const start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return windows;
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  while (cursor <= end) {
    // Último día del mes de `cursor` (día 0 del mes siguiente).
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    const winEnd = monthEnd <= end ? monthEnd : end;
    windows.push({ from: cursor.toISOString().slice(0, 10), to: winEnd.toISOString().slice(0, 10) });
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return windows;
}

/**
 * Wrapper para histórico del ROL diario. Dedup por
 * (cia, kCliente, anio, semana, ruta, tipoViaje) para tolerar duplicados.
 *
 * El endpoint /citi/roldiario es lento; un solo request del año entero rebasa
 * el timeout del cliente/proxy y al colgarse retiene un slot del semáforo
 * global. Por eso troceamos por día y corremos con concurrencia baja.
 * Una ventana que falla se trata como 0 viajes — no aborta el rango completo.
 */
export async function fetchRolRange(
  fechaInicial: string,
  fechaFinal: string,
  options: {
    kServidor?: number;
    concurrency?: number;
    onProgress?: (done: number, total: number) => void;
    /**
     * Llamado cada que UNA ventana diaria termina con éxito y trae al menos
     * un registro. Permite al caller persistir incrementalmente en lugar de
     * esperar al `Promise.all` final (que toma horas para un año completo).
     * Si el caller recarga la página antes de que termine, las ventanas ya
     * persistidas se conservan.
     */
    onPartialBatch?: (records: RolRecord[]) => void;
    config?: JdeClientConfig;
  } = {},
): Promise<RolRecord[]> {
  const kServidor = options.kServidor ?? -1;
  const config = options.config ?? {};
  const windows = splitIntoFixedDayWindows(fechaInicial, fechaFinal, 1);
  if (windows.length === 0) return [];

  options.onProgress?.(0, windows.length);
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const results: RolRecord[][] = new Array(windows.length);
  const failedWindows: string[] = [];
  let cursor = 0;
  let completed = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const slot = cursor++;
      if (slot >= windows.length) return;
      const w = windows[slot];
      try {
        results[slot] = await fetchRol(
          { f_Inicio: w.from, f_Final: w.to, k_Servidor: kServidor },
          config,
        );
        if (results[slot].length > 0) {
          try { options.onPartialBatch?.(results[slot]); } catch { /* swallow — caller bug */ }
        }
      } catch (err) {
        failedWindows.push(`${w.from}..${w.to}`);
        // eslint-disable-next-line no-console
        console.warn(`[rol] ventana ${w.from}..${w.to} falló: ${err instanceof Error ? err.message : String(err)}`);
        results[slot] = [];
      } finally {
        completed += 1;
        options.onProgress?.(completed, windows.length);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, windows.length) }, worker),
  );

  if (failedWindows.length === windows.length) {
    throw new JdeApiError(
      `CITI /roldiario no respondió en ninguna ventana diaria`,
      504,
      '/roldiario',
      { fechaInicial, fechaFinal, failedWindows },
    );
  }

  if (failedWindows.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[rol] completó parcial: ${windows.length - failedWindows.length}/${windows.length} ventanas`);
  }

  const seen = new Set<string>();
  const merged: RolRecord[] = [];
  for (const rec of results.flat()) {
    const key = `${rec.cia}::${rec.kCliente}::${rec.anio}::${rec.semana}::${rec.ruta}::${rec.tipoViaje}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(rec);
  }
  return merged;
}

// ───────────────────────────────────────────────────────────────
// 10. Viajes Especiales
// ───────────────────────────────────────────────────────────────

/**
 * Convierte `"2026-04-09T09:00:00"` → `"2026-04-09"`. Tolera valores ya
 * normalizados o vacíos.
 */
function toIsoDate(v: unknown): string | undefined {
  const s = toStr(v).trim();
  if (!s) return undefined;
  return s.slice(0, 10);
}

function mapViajeEspecial(raw: RawRecord): ViajeEspecialRecord {
  // Fallbacks por si el API sirve `Factura_JDE`/`UUID` con espacios trailing
  // (visto en el sample). normalizamos trim + upper para que el cruce con
  // cobranza no falle por whitespace.
  const facturaRaw = toStr(pick(raw, ['Factura_JDE', 'factura_jde', 'facturaJDE']));
  const uuidRaw = toStr(pick(raw, ['UUID', 'uuid', 'uuidFiscal', 'UUID_Fiscal']));
  return {
    cia:               normalizeCia(pick(raw, ['Clave_JDE_Empresa', 'clave_jde_empresa', 'cia'])),
    empresaCodigo:     toStr(pick(raw, ['K_Empresa', 'k_empresa', 'empresaCodigo'])),
    kRenta:            toNum(pick(raw, ['K_Renta', 'k_renta', 'kRenta'])),
    kCliente:          toNum(pick(raw, ['K_Cliente', 'k_cliente', 'kCliente'])),
    dCliente:          toStr(pick(raw, ['D_Cliente', 'd_cliente', 'dCliente'])).trim(),
    rfc:               toStr(pick(raw, ['Rrc_Cliente', 'rfc_cliente', 'RFC', 'rfc'])).trim(),
    claveJDE:          toStr(pick(raw, ['Clave_JDE', 'clave_jde', 'claveJDE'])).trim(),
    totalNegociado:    toNum(pick(raw, ['Total_Negociado', 'total_negociado', 'totalNegociado'])),
    diasCredito:       toNum(pick(raw, ['Dias_Credito', 'dias_credito', 'diasCredito'])),
    facturaJDE:        facturaRaw ? facturaRaw.trim().toUpperCase() : undefined,
    uuidFiscal:        uuidRaw ? uuidRaw.trim().toUpperCase() : undefined,
    fSalidaPrimera:    toIsoDate(pick(raw, ['f_salida_primera', 'fSalidaPrimera', 'F_Salida_Primera'])),
    fRegresoUltima:    toIsoDate(pick(raw, ['f_Regreso_ultima', 'fRegresoUltima', 'F_Regreso_Ultima'])),
    fechaFactura:      toIsoDate(pick(raw, ['Fecha_Factura', 'fecha_factura', 'fechaFactura'])),
    numeroBatch:       toStr(pick(raw, ['numeroBatch', 'numero_batch', 'Numero_Batch'])) || undefined,
    referenciaDeposito: toStr(pick(raw, ['Referencia_Deposito', 'referencia_deposito', 'referenciaDeposito'])) || undefined,
  };
}

let viajesEspShapeLogged = false;

/**
 * POST {viajesEspeciales}/Servicios — viajes especiales del rango.
 *
 * Endpoint dev `http://srv-desarrollo:95/ViajesEspeciales/Servicios` (proxy
 * `/api/viajes-especiales`). Acepta solo `f_Inicio` / `f_Final`. Trae cia
 * por row vía `Clave_JDE_Empresa`.
 */
export async function fetchViajesEspeciales(
  req: ViajeEspecialRequest,
  config: JdeClientConfig = {},
): Promise<ViajeEspecialRecord[]> {
  const merged = withLongRunningDefaults({
    baseUrl: apiConfig.viajesEspeciales.baseUrl,
    authValue: apiConfig.viajesEspeciales.authValue || undefined,
    timeoutMs: 300_000,
    ...config,
  });
  let raw: unknown;
  try {
    raw = await jdeClient.post<unknown>('/Servicios', req, merged);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[viajes-esp] fetch error: ${err instanceof Error ? err.message : String(err)} · body sent: ${JSON.stringify(req)}`);
    if (err instanceof JdeApiError) {
      // eslint-disable-next-line no-console
      console.warn(`[viajes-esp] server response body: ${typeof err.body === 'string' ? err.body : JSON.stringify(err.body)}`);
    }
    throw err;
  }
  const list = unwrapList(raw);

  if (typeof window !== 'undefined' && !viajesEspShapeLogged) {
    viajesEspShapeLogged = true;
    // eslint-disable-next-line no-console
    console.info(`[viajes-esp] ${list.length} registros entre ${req.f_Inicio} y ${req.f_Final}`);
    if (list.length > 0) {
      // eslint-disable-next-line no-console
      console.info('[viajes-esp] sample raw:', list[0]);
      // eslint-disable-next-line no-console
      console.info('[viajes-esp] sample mapped:', mapViajeEspecial(list[0]));
    }
  }

  return dropExcludedByCia(list.map(mapViajeEspecial));
}

/**
 * Wrapper rango. Dedup por `K_Renta` (id único del viaje). Trocea **por día**
 * porque el endpoint `/Servicios` devuelve 500 ante rangos de varios días
 * (p.ej. un mes completo `2026-01-01..2026-01-31`); solo tolera consultas de
 * un único día. Concurrencia baja para no saturar el servidor de desarrollo.
 */
export async function fetchViajesEspecialesRange(
  fechaInicial: string,
  fechaFinal: string,
  options: {
    concurrency?: number;
    onProgress?: (done: number, total: number) => void;
    onPartialBatch?: (records: ViajeEspecialRecord[]) => void;
    config?: JdeClientConfig;
  } = {},
): Promise<ViajeEspecialRecord[]> {
  const config = options.config ?? {};
  const windows = splitIntoFixedDayWindows(fechaInicial, fechaFinal, 1);
  if (windows.length === 0) return [];

  options.onProgress?.(0, windows.length);
  // Día por ventana ⇒ muchas más ventanas que antes (≈365/año), pero cada
  // request es ligero; subimos la concurrencia por defecto para compensar.
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const results: ViajeEspecialRecord[][] = new Array(windows.length);
  const failedWindows: string[] = [];
  let cursor = 0;
  let completed = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const slot = cursor++;
      if (slot >= windows.length) return;
      const w = windows[slot];
      try {
        results[slot] = await fetchViajesEspeciales(
          { f_Inicio: w.from, f_Final: w.to },
          config,
        );
        if (results[slot].length > 0) {
          try { options.onPartialBatch?.(results[slot]); } catch { /* swallow */ }
        }
      } catch (err) {
        failedWindows.push(`${w.from}..${w.to}`);
        // eslint-disable-next-line no-console
        console.warn(`[viajes-esp] ventana ${w.from}..${w.to} falló: ${err instanceof Error ? err.message : String(err)}`);
        results[slot] = [];
      } finally {
        completed += 1;
        options.onProgress?.(completed, windows.length);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, windows.length) }, worker),
  );

  if (failedWindows.length === windows.length) {
    throw new JdeApiError(
      `Viajes Especiales no respondió en ninguna ventana`,
      504,
      '/Servicios',
      { fechaInicial, fechaFinal, failedWindows },
    );
  }

  // Dedup por K_Renta (id único). Si el mismo viaje aparece en dos
  // ventanas (no debería pasar pero defensa) gana el primero.
  const seen = new Set<number>();
  const merged: ViajeEspecialRecord[] = [];
  for (const rec of results.flat()) {
    if (seen.has(rec.kRenta)) continue;
    seen.add(rec.kRenta);
    merged.push(rec);
  }
  return merged;
}

// Re-exports convenientes
export type {
  AgedBalanceRecord,
  AgedBalanceRequest,
  AuxiliarContableRecord,
  AuxiliarContableRequest,
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
  RolRecord,
  RolRequest,
  ViajeEspecialRecord,
  ViajeEspecialRequest,
} from './jdeTypes';
export { JdeApiError } from './jdeTypes';
