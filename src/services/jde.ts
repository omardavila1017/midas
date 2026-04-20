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
    cia:                     toStr(pick(raw, ['cia', 'compania', 'company'])),
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

function mapBankLine(raw: RawRecord): BankStatementLine {
  const importeRaw = toNum(pick(raw, ['importe', 'monto', 'amount']));
  const tipo = toStr(pick(raw, ['tipoMovimiento', 'tipo_movimiento', 'tipo', 'dc'])).toUpperCase();
  // Algunos formatos reportan importe firmado (negativo = cargo); normalizamos:
  const absImporte = Math.abs(importeRaw);
  const tipoMovimiento =
    tipo === 'CARGO' || tipo === 'C' || tipo === 'D' || importeRaw < 0 ? 'CARGO' :
    tipo === 'ABONO' || tipo === 'A' || tipo === 'CR' || importeRaw > 0 ? 'ABONO' :
    tipo || 'ABONO';

  return {
    cia:            toStr(pick(raw, ['cia', 'compania'])),
    banco:          toStr(pick(raw, ['banco', 'codigoBanco', 'bankCode'])),
    nombreBanco:    toStr(pick(raw, ['nombreBanco', 'nombre_banco', 'bankName'])) || undefined,
    cuenta:         toStr(pick(raw, ['cuenta', 'numeroCuenta', 'numero_cuenta', 'account'])),
    moneda:         toStr(pick(raw, ['moneda', 'currency'])) || 'MXN',
    fechaOperacion: toStr(pick(raw, ['fechaOperacion', 'fecha_operacion', 'fecha', 'date'])),
    fechaValor:     toStr(pick(raw, ['fechaValor', 'fecha_valor', 'valueDate'])) || undefined,
    referencia:     toStr(pick(raw, ['referencia', 'folio', 'reference'])),
    concepto:       toStr(pick(raw, ['concepto', 'descripcion', 'description'])),
    tipoMovimiento,
    importe:        absImporte,
    saldo:          pick(raw, ['saldo', 'balance']) !== undefined
                      ? toNum(pick(raw, ['saldo', 'balance']))
                      : undefined,
  };
}

/** Agrupa líneas por (cia, banco, cuenta) si el API las entrega planas. */
function groupByAccount(lines: BankStatementLine[], fechaEstadoCuenta: string): BankAccountStatement[] {
  const map = new Map<string, BankAccountStatement>();
  for (const l of lines) {
    const key = `${l.cia}::${l.banco}::${l.cuenta}::${l.moneda}`;
    let acc = map.get(key);
    if (!acc) {
      acc = {
        cia: l.cia,
        banco: l.banco,
        nombreBanco: l.nombreBanco,
        cuenta: l.cuenta,
        moneda: l.moneda,
        fechaEstadoCuenta,
        movimientos: [],
      };
      map.set(key, acc);
    }
    acc.movimientos.push(l);
  }
  // Saldo final = último saldo reportado; inicial = primero
  for (const acc of map.values()) {
    acc.movimientos.sort((a, b) => a.fechaOperacion.localeCompare(b.fechaOperacion));
    const first = acc.movimientos[0];
    const last = acc.movimientos[acc.movimientos.length - 1];
    if (first?.saldo !== undefined) {
      const delta = first.tipoMovimiento === 'CARGO' ? first.importe : -first.importe;
      acc.saldoInicial = first.saldo + delta;
    }
    if (last?.saldo !== undefined) acc.saldoFinal = last.saldo;
  }
  return Array.from(map.values());
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

  // El API puede entregar: (a) líneas planas, (b) cuentas con movimientos anidados.
  const list = unwrapList(raw);
  if (list.length === 0) return [];

  const first = list[0];
  const hasNestedMovs = Array.isArray((first as RawRecord).movimientos)
    || Array.isArray((first as RawRecord).movements)
    || Array.isArray((first as RawRecord).lines);

  if (hasNestedMovs) {
    return list.map((raw): BankAccountStatement => {
      const movsRaw = (pick(raw, ['movimientos', 'movements', 'lines']) as RawRecord[] | undefined) ?? [];
      return {
        cia:               toStr(pick(raw, ['cia', 'compania'])),
        banco:             toStr(pick(raw, ['banco', 'codigoBanco'])),
        nombreBanco:       toStr(pick(raw, ['nombreBanco', 'nombre_banco'])) || undefined,
        cuenta:            toStr(pick(raw, ['cuenta', 'numeroCuenta'])),
        moneda:            toStr(pick(raw, ['moneda'])) || 'MXN',
        fechaEstadoCuenta: toStr(pick(raw, ['fechaEstadoCuenta', 'fecha_estado_cuenta'])) || req.fechaEstadoCuenta,
        saldoInicial:      pick(raw, ['saldoInicial', 'saldo_inicial']) !== undefined
                             ? toNum(pick(raw, ['saldoInicial', 'saldo_inicial'])) : undefined,
        saldoFinal:        pick(raw, ['saldoFinal', 'saldo_final']) !== undefined
                             ? toNum(pick(raw, ['saldoFinal', 'saldo_final'])) : undefined,
        movimientos:       movsRaw.map(mapBankLine),
      };
    });
  }

  // Líneas planas → agrupar
  const lines = list.map(mapBankLine);
  return groupByAccount(lines, req.fechaEstadoCuenta);
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
