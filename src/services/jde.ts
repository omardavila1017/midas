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
  AgedBalanceRecord,
  AgedBalanceRequest,
  BankAccountStatement,
  BankStatementLine,
  BankStatementRequest,
  Company,
} from './jdeTypes';

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

/**
 * Normaliza el campo `cia` de la respuesta JDE.
 *
 * El API a veces devuelve solo el código ("00011") y a veces el código
 * concatenado con el nombre de la compañía ("00011 - SERVICIO INDUSTRIAL
 * REGIOMONTANO"). Para poder agrupar/filtrar registros por compañía, aquí
 * extraemos siempre el código puro (primeros caracteres antes de espacio
 * o guión) y hacemos pad a 5 dígitos si es numérico.
 */
function normalizeCia(v: unknown): string {
  const raw = toStr(v);
  if (!raw) return '';
  const head = raw.split(/[\s-]/)[0].trim();
  if (/^\d+$/.test(head)) return head.padStart(5, '0');
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
 * POST /JDEdwards/AntiguedadSaldos
 * Retorna todos los saldos abiertos por proveedor para la compañía indicada.
 */
export async function fetchAgedBalances(
  req: AgedBalanceRequest,
  config: JdeClientConfig = {},
): Promise<AgedBalanceRecord[]> {
  const raw = await jdeClient.post<unknown>('/AntiguedadSaldos', req, config);
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
 *   InF_ADI_1, InF_ADI_2, InF_ADI_3, Codigo_Categoria_33..38, DESC033..038
 */
function mapBankLine(raw: RawRecord): BankStatementLine {
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

  // ── Fecha ── (JDE devuelve "2026-04-17T00:00:00" → normalizamos a "2026-04-17")
  const rawFecha = toStr(
    pick(raw, ['Fecha_Estado_Cuenta', 'fechaOperacion', 'fecha_operacion', 'fecha', 'date']),
  );
  const fechaOperacion = rawFecha.includes('T') ? rawFecha.split('T')[0] : rawFecha;

  // ── Empresa ── derivada de Cuenta_Contable (BU → cia con padding)
  const ciaExplicit = toStr(pick(raw, ['cia', 'compania']));
  const cia = ciaExplicit || extractCiaFromCuentaContable(pick(raw, ['Cuenta_Contable', 'cuenta_contable']));

  // ── Banco ── nombre extraído de Nombre_cuenta_Contable + tipo de cuenta (DESC039)
  const nombreBancoRaw = toStr(
    pick(raw, ['Nombre_cuenta_Contable', 'nombreBanco', 'nombre_banco', 'bankName']),
  );
  const bankNameOnly = extractBankName(nombreBancoRaw);
  const tipoCuenta = toStr(pick(raw, ['DESC039']));
  const nombreBanco = bankNameOnly
    ? (tipoCuenta ? `${bankNameOnly} · ${tipoCuenta}` : bankNameOnly)
    : (tipoCuenta || undefined);

  // ── Cuenta bancaria ──
  const cuenta = toStr(
    pick(raw, ['Cuenta_Bancos', 'cuenta', 'numeroCuenta', 'numero_cuenta', 'account']),
  );

  // ── Concepto (parsing inteligente de InF_ADI) ──
  const concepto = parseConcepto(
    pick(raw, ['InF_ADI_1']),
    pick(raw, ['InF_ADI_2']),
  );

  // ── Referencia ──
  const referencia = toStr(
    pick(raw, ['Referencia_Cliente', 'referencia', 'folio', 'reference']),
  );

  // ── Banco ── usamos el nombre extraído como código también (no hay campo banco dedicado en JDE)
  const banco = nombreBanco || toStr(
    pick(raw, ['banco', 'codigoBanco', 'bankCode']),
  );

  // ── Moneda ── JDE no la devuelve explícitamente; inferimos de categorías si posible
  const descMoneda = toStr(pick(raw, ['DESC036', 'moneda', 'currency']));
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
    concepto,
    tipoMovimiento,
    importe: absImporte,
    saldo: undefined, // saldos se manejan a nivel de cuenta, no por línea
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
    saldoInicial: number | undefined;
    saldoFinal: number | undefined;
  }>();

  for (let i = 0; i < mappedLines.length; i++) {
    const l = mappedLines[i];
    const r = rawLines[i];
    const key = `${l.cia}::${l.cuenta}::${l.moneda}`;

    let entry = map.get(key);
    if (!entry) {
      // Tomar saldos del primer registro raw del grupo
      const si = pick(r, ['Saldo_Inicial', 'saldoInicial', 'saldo_inicial']);
      const sf = pick(r, ['Saldo_Final', 'saldoFinal', 'saldo_final']);
      entry = {
        acc: {
          cia: l.cia,
          banco: l.banco,
          nombreBanco: l.nombreBanco,
          cuenta: l.cuenta,
          moneda: l.moneda,
          fechaEstadoCuenta,
          movimientos: [],
        },
        saldoInicial: si !== undefined && si !== null ? toNum(si) : undefined,
        saldoFinal: sf !== undefined && sf !== null ? toNum(sf) : undefined,
      };
      map.set(key, entry);
    }
    entry.acc.movimientos.push(l);
  }

  // Asignar saldos y ordenar movimientos
  for (const { acc, saldoInicial, saldoFinal } of map.values()) {
    acc.saldoInicial = saldoInicial;
    acc.saldoFinal = saldoFinal;
    acc.movimientos.sort((a, b) => a.fechaOperacion.localeCompare(b.fechaOperacion));
  }

  return Array.from(map.values()).map(e => e.acc);
}

/**
 * POST /JDEdwards/Bancos
 * Retorna el estado de cuenta agrupado por cuenta bancaria.
 */
export async function fetchBankStatements(
  req: BankStatementRequest,
  config: JdeClientConfig = {},
): Promise<BankAccountStatement[]> {
  const raw = await jdeClient.post<unknown>('/Bancos', req, config);
  const list = unwrapList(raw);
  if (list.length === 0) return [];

  // El API actual de JDE Desarrollo devuelve líneas planas con
  // Saldo_Inicial/Saldo_Final repetidos por cuenta → agrupar.
  const lines = list.map(mapBankLine);
  return groupByAccount(list, lines, req.fechaEstadoCuenta);
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
 * GET /JDEdwards/Empresas
 * Retorna el catálogo de compañías disponible para el usuario autenticado.
 */
export async function fetchCompanies(config: JdeClientConfig = {}): Promise<Company[]> {
  const raw = await jdeClient.get<unknown>('/Empresas', config);
  return unwrapList(raw).map(mapCompany).filter(c => c.cia);
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
  Company,
} from './jdeTypes';
export { JdeApiError } from './jdeTypes';
