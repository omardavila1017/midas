/**
 * IVA real desde el libro mayor JDE (`/JDEdwards/AuxiliarContable`).
 *
 * En la contabilidad MX el IVA acreditable es una cuenta de activo propia y el
 * IVA trasladado/causado una cuenta de pasivo propia. Sumar el movimiento
 * mensual de esas cuentas = el IVA real del periodo, SIN estimar (a diferencia
 * del pipeline de `taxModuleService`, que infiere tasas e importes de CXP/OC).
 *
 * Este módulo NO pega al API — recibe los `AuxiliarContableRecord[]` que el
 * boot ya descargó (ver `fetchAuxiliarContableIvaRange` en `services/jde.ts`)
 * y los agrega por periodo. La descarga vive en un fetch separado con su propio
 * cache; NO se toca el rango 1010-1020 de la conciliación banco↔ERP.
 *
 * Supuestos que se confirman en runtime contra datos reales (ver
 * `window.__midas__.ivaLedger`):
 *   1. Qué objetos contables son IVA — se auto-descubren por `nombreCuenta`.
 *   2. El signo de `importe` por lado — se expone el bruto firmado para auditar.
 */
import type { AuxiliarContableRecord } from '../services/jdeTypes';

export type IvaAccountKind = 'creditable' | 'caused' | 'withheld' | 'other';

export interface IvaLedgerAccount {
  cia: string;
  cuentaObjeto: string;
  nombreCuenta: string;
  kind: IvaAccountKind;
  rate: 8 | 16 | undefined;
  /** Suma firmada de `importe` (auditoría de signo). */
  signedTotal: number;
  lineCount: number;
}

export interface IvaLedgerLine {
  movementId: string;
  date: string;
  period: string;
  cia: string;
  cuentaObjeto: string;
  nombreCuenta: string;
  kind: IvaAccountKind;
  rate: 8 | 16 | undefined;
  /** Importe firmado tal cual lo manda JDE. */
  signedAmount: number;
  /** Magnitud del IVA (|importe|) — lo que entra al acumulador. */
  amount: number;
}

export interface IvaLedgerPeriod {
  period: string;
  /** IVA acreditable (impuesto, no base) del periodo. */
  creditable: number;
  /** IVA causado/trasladado (impuesto, no base) del periodo. */
  caused: number;
  creditableLines: IvaLedgerLine[];
  causedLines: IvaLedgerLine[];
}

const normalize = (value: string | undefined): string =>
  (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const hasAny = (value: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => value.includes(pattern));

/**
 * Clasifica una cuenta contable por su nombre. Patrones tolerantes a
 * acentos/espacios. Ajustar aquí si el diagnóstico revela nombres distintos.
 */
export function classifyIvaAccount(nombreCuenta: string | undefined): IvaAccountKind {
  const name = normalize(nombreCuenta);
  const compact = name.replace(/\s+/g, '');
  const mentionsIva = compact.includes('IVA')
    || name.includes('IMPUESTO AL VALOR AGREGADO')
    || name.includes('IMP AL VALOR AGREGADO');
  if (!mentionsIva) return 'other';
  // Retenido (IVA retenido a terceros) no es acreditable ni causado normal.
  if (name.includes('RETEN')) return 'withheld';
  // Acreditable: IVA sobre compras/gastos (a favor).
  if (
    hasAny(name, [
      'ACREDITABLE',
      'POR ACREDITAR',
      'ACREDITAR',
      'PAGADO',
      'PENDIENTE DE PAGO',
    ])
  ) {
    return 'creditable';
  }
  // Causado/Trasladado: IVA sobre ventas (a cargo).
  if (
    hasAny(name, [
      'TRASLAD',
      'CAUSADO',
      'POR PAGAR',
      'POR ENTERAR',
      'ENTERAR',
      'COBRADO',
      'COBRAR',
      'POR COBRAR',
      'PENDIENTE DE COBRO',
      'DEVENGADO',
    ])
  ) {
    return 'caused';
  }
  return 'other';
}

/** Detecta tasa (8|16) embebida en el nombre de la cuenta, si la hay. */
export function rateFromAccountName(nombreCuenta: string | undefined): 8 | 16 | undefined {
  const name = normalize(nombreCuenta);
  if (/\b16\b/.test(name) || name.includes('16%')) return 16;
  if (/\b8\b/.test(name) || name.includes('8%')) return 8;
  return undefined;
}

/** Objetos contables (Cuenta_Objeto) cuyo nombre clasifica como IVA. */
export function discoverIvaObjetos(records: AuxiliarContableRecord[]): Set<string> {
  const objetos = new Set<string>();
  for (const rec of records) {
    const kind = classifyIvaAccount(rec.nombreCuenta);
    if (kind === 'creditable' || kind === 'caused' || kind === 'withheld') {
      const obj = rec.cuentaObjeto?.trim();
      if (obj) objetos.add(obj);
    }
  }
  return objetos;
}

/** Objetos contables descubiertos, separados por lado fiscal. */
export function discoverIvaObjetosByKind(records: AuxiliarContableRecord[]): Record<IvaAccountKind, Set<string>> {
  const out: Record<IvaAccountKind, Set<string>> = {
    creditable: new Set<string>(),
    caused: new Set<string>(),
    withheld: new Set<string>(),
    other: new Set<string>(),
  };
  for (const rec of records) {
    const obj = rec.cuentaObjeto?.trim();
    if (!obj) continue;
    out[classifyIvaAccount(rec.nombreCuenta)].add(obj);
  }
  return out;
}

/** Resumen por cuenta (para el diagnóstico `window.__midas__.ivaLedger`). */
export function summarizeIvaAccounts(records: AuxiliarContableRecord[]): IvaLedgerAccount[] {
  const byKey = new Map<string, IvaLedgerAccount>();
  for (const rec of records) {
    const kind = classifyIvaAccount(rec.nombreCuenta);
    if (kind === 'other') continue;
    const cuentaObjeto = rec.cuentaObjeto?.trim() ?? '';
    const key = `${rec.cia}::${cuentaObjeto}::${normalize(rec.nombreCuenta)}`;
    const amount = Number.isFinite(rec.importe) ? rec.importe : 0;
    const existing = byKey.get(key);
    if (existing) {
      existing.signedTotal += amount;
      existing.lineCount += 1;
    } else {
      byKey.set(key, {
        cia: rec.cia,
        cuentaObjeto,
        nombreCuenta: rec.nombreCuenta?.trim() ?? '',
        kind,
        rate: rateFromAccountName(rec.nombreCuenta),
        signedTotal: amount,
        lineCount: 1,
      });
    }
  }
  return Array.from(byKey.values()).sort((a, b) =>
    a.cia.localeCompare(b.cia) || a.cuentaObjeto.localeCompare(b.cuentaObjeto),
  );
}

export function groupIvaAccountsByKind(accounts: IvaLedgerAccount[]): Record<IvaAccountKind, IvaLedgerAccount[]> {
  return {
    creditable: accounts.filter((account) => account.kind === 'creditable'),
    caused: accounts.filter((account) => account.kind === 'caused'),
    withheld: accounts.filter((account) => account.kind === 'withheld'),
    other: accounts.filter((account) => account.kind === 'other'),
  };
}

export function missingIvaKindsByCia(accounts: IvaLedgerAccount[]): Record<string, Array<'creditable' | 'caused'>> {
  const byCia = new Map<string, Set<IvaAccountKind>>();
  for (const account of accounts) {
    const bucket = byCia.get(account.cia) ?? new Set<IvaAccountKind>();
    bucket.add(account.kind);
    byCia.set(account.cia, bucket);
  }
  const out: Record<string, Array<'creditable' | 'caused'>> = {};
  for (const [cia, kinds] of byCia) {
    const missing: Array<'creditable' | 'caused'> = [];
    if (!kinds.has('creditable')) missing.push('creditable');
    if (!kinds.has('caused')) missing.push('caused');
    if (missing.length > 0) out[cia] = missing;
  }
  return out;
}

/**
 * Agrega IVA acreditable y causado por periodo (YYYY-MM) desde el libro mayor.
 *
 * El `importe` del ledger ES el monto del impuesto (no la base). Se suma el
 * neto firmado por periodo/lado y se reporta su magnitud (|neto|): las
 * declaraciones de IVA son positivas y los reversos del propio mes ya están
 * netos. El signo crudo queda en las líneas para auditoría.
 */
export function buildIvaLedgerByPeriod(
  records: AuxiliarContableRecord[],
  opts: { companyCode?: string; startDate?: string; endDate?: string } = {},
): Map<string, IvaLedgerPeriod> {
  const { companyCode, startDate, endDate } = opts;
  const creditableNet = new Map<string, number>();
  const causedNet = new Map<string, number>();
  const creditableLines = new Map<string, IvaLedgerLine[]>();
  const causedLines = new Map<string, IvaLedgerLine[]>();

  for (const rec of records) {
    if (companyCode && companyCode !== 'all' && rec.cia !== companyCode) continue;
    const date = rec.fechaContable;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (startDate && date < startDate) continue;
    if (endDate && date > endDate) continue;

    const kind = classifyIvaAccount(rec.nombreCuenta);
    if (kind !== 'creditable' && kind !== 'caused') continue;

    const signed = Number.isFinite(rec.importe) ? rec.importe : 0;
    if (signed === 0) continue;
    const period = date.slice(0, 7);

    const line: IvaLedgerLine = {
      movementId: `iva-ledger:${rec.cia}:${rec.idCuenta}:${rec.tipoDocto}:${rec.noDocto}`,
      date,
      period,
      cia: rec.cia,
      cuentaObjeto: rec.cuentaObjeto?.trim() ?? '',
      nombreCuenta: rec.nombreCuenta?.trim() ?? '',
      kind,
      rate: rateFromAccountName(rec.nombreCuenta),
      signedAmount: signed,
      amount: Math.abs(signed),
    };

    if (kind === 'creditable') {
      creditableNet.set(period, (creditableNet.get(period) ?? 0) + signed);
      const bucket = creditableLines.get(period) ?? [];
      bucket.push(line);
      creditableLines.set(period, bucket);
    } else {
      causedNet.set(period, (causedNet.get(period) ?? 0) + signed);
      const bucket = causedLines.get(period) ?? [];
      bucket.push(line);
      causedLines.set(period, bucket);
    }
  }

  const periods = new Set<string>([...creditableNet.keys(), ...causedNet.keys()]);
  const out = new Map<string, IvaLedgerPeriod>();
  for (const period of periods) {
    out.set(period, {
      period,
      creditable: Math.abs(creditableNet.get(period) ?? 0),
      caused: Math.abs(causedNet.get(period) ?? 0),
      creditableLines: creditableLines.get(period) ?? [],
      causedLines: causedLines.get(period) ?? [],
    });
  }
  return out;
}

/** True si hay al menos una cuenta de IVA acreditable/causado detectable. */
export function hasIvaLedgerCoverage(records: AuxiliarContableRecord[] | undefined): boolean {
  if (!records || records.length === 0) return false;
  for (const rec of records) {
    const kind = classifyIvaAccount(rec.nombreCuenta);
    if (kind === 'creditable' || kind === 'caused') return true;
  }
  return false;
}
