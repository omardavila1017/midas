// ─────────────────────────────────────────────────────────────────────────
// expensePerProvider — proyección de egresos por proveedor.
//
// Usa el catálogo de proveedores (Provider) + CXP (/AntiguedadSaldos) +
// CARGOs bancarios históricos para estimar, por proveedor y por mes, qué
// vamos a pagar. Respeta:
//   - paymentPeriod del proveedor (días de crédito pactados)
//   - flexibility (inamovible vs. flexible vs. revisar)
//   - CXP abierto (importe pendiente + fechaProgramacionPago)
//   - CARGOs históricos: frecuencia y monto típico mensual
//
// Una vez por proveedor calculamos:
//   activeMonths     — en cuántos de los últimos N meses hubo pago
//   monthlyAvg       — promedio mensual sobre meses activos
//   typicalPayDay    — día del mes típico (mediana de fechaOperacion de CARGOs)
//
// Un proveedor es "recurrente" si pagó en ≥50% de los meses recientes.
// Para cada mes futuro:
//   - Si hay CXP abierto del proveedor con fechaProgramacionPago en ese mes
//     → usamos ese importe (autoridad operativa).
//   - Si el proveedor es recurrente y no hay CXP para ese mes → usamos el
//     promedio mensual como proyección.
// ─────────────────────────────────────────────────────────────────────────

import type { Provider } from './types';
import type { AgedBalanceRecord, BankAccountStatement } from '../services/jdeTypes';
import type { Flexibility } from './providerCatalog';
import { addMonths, compareYearMonth, toYearMonth } from './cashFlowEngine';
import {
  isInternalTransfer,
  buildOwnAccountsIndex,
  buildOwnAccountDetector,
} from './netCashFlowEngine';

// ── Helpers de normalización ─────────────────────────────────────────────

/** Normaliza un nombre / concepto para comparar: uppercase, sin dobles espacios. */
function norm(s: string | null | undefined): string {
  return (s ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

/** Convierte paymentPeriod ("30 días") a número de días. */
export function paymentPeriodDays(p: Provider['paymentPeriod']): number {
  if (p === 'Contado') return 0;
  const match = /(\d+)/.exec(p);
  return match ? Number(match[1]) : 30;
}

// ── Índice de proveedores para match por nombre ──────────────────────────

export interface ProviderIndex {
  byName: Map<string, Provider>;
  /** Lista ordenada por longitud desc. para buscar substring más largo primero. */
  sortedByLen: Array<{ norm: string; provider: Provider }>;
}

export function buildProviderIndex(providers: Provider[]): ProviderIndex {
  const byName = new Map<string, Provider>();
  const arr: Array<{ norm: string; provider: Provider }> = [];
  for (const p of providers) {
    const n = norm(p.name);
    if (!n) continue;
    byName.set(n, p);
    arr.push({ norm: n, provider: p });
  }
  arr.sort((a, b) => b.norm.length - a.norm.length);
  return { byName, sortedByLen: arr };
}

/**
 * Matchea un concepto bancario a un proveedor del catálogo. Estrategia:
 *   1. Match exacto por nombre normalizado.
 *   2. Substring más largo contenido en el concepto.
 *   3. null si no hay nada razonable.
 *
 * No hacemos fuzzy para evitar falsos positivos — si no hay match claro
 * cae a "Otros".
 */
export function matchConceptToProvider(
  concepto: string,
  index: ProviderIndex,
): Provider | null {
  const c = norm(concepto);
  if (!c) return null;
  const exact = index.byName.get(c);
  if (exact) return exact;
  // Substring más largo. Umbral mínimo de 4 chars para no matchear "S.A."
  for (const entry of index.sortedByLen) {
    if (entry.norm.length < 4) break;
    if (c.includes(entry.norm)) return entry.provider;
  }
  return null;
}

/** Matchea un CXPRecord/aged por `nombre` directo (caso sencillo). */
export function matchAgedToProvider(
  record: { nombre?: string; noProveedor?: string },
  index: ProviderIndex,
): Provider | null {
  return matchConceptToProvider(record.nombre ?? '', index);
}

// ── Historial bancario por proveedor ─────────────────────────────────────

export interface ProviderBankPattern {
  provider: Provider;
  activeMonths: number;
  monthsInWindow: number;
  monthlyAvg: number;
  /**
   * Promedio por mes calendario (índice 0=enero, 11=diciembre) calculado
   * sobre TODA la historia bancaria. Permite estacionalidad: meses con
   * más historia de pago al proveedor proyectan más. Si un slot es 0,
   * significa que NO hay historial para ese mes calendario y se debe
   * usar `monthlyAvg` como fallback.
   */
  monthlyAvgByCalendarMonth: number[];
  lastPaid: string | null; // yearMonth del último pago
  typicalPayDay: number;   // 1..31 (mediana)
  isRecurring: boolean;
}

function operationalMonthlyFloor(provider: Provider | undefined): number {
  if (!provider) return 0;
  if (provider.clasificacionAutomatica !== 'CRITICO') return 0;
  const amount = provider.gastoMinimoMensual ?? 0;
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

/**
 * Para cada proveedor del catálogo, calcula su patrón de pago histórico
 * agregando los CARGOs cuyos conceptos hagan match con su nombre. Excluye
 * el mes en curso (parcial).
 */
export function buildProviderBankPatterns(
  providers: Provider[],
  bankStatements: BankAccountStatement[],
  today: string,
  lookbackMonths = 6,
): Map<string, ProviderBankPattern> {
  const index = buildProviderIndex(providers);
  const currentYm = toYearMonth(today);

  // Traspasos internos entre cuentas propias no son pagos a proveedores —
  // excluirlos evita inflar el patrón mensual y que un proveedor con nombre
  // parecido a una empresa del grupo capture esos cargos por error.
  const ownAccountDetector = buildOwnAccountDetector(
    buildOwnAccountsIndex(bankStatements),
  );

  // provider.id → yearMonth → { amount, days: [dayOfMonth] }
  const perProvider = new Map<string, Map<string, { amount: number; days: number[] }>>();

  for (const acc of bankStatements) {
    for (const mov of acc.movimientos) {
      if (mov.tipoMovimiento !== 'CARGO') continue;
      if (isInternalTransfer(mov, ownAccountDetector)) continue;
      if (isNoisyBankExpenseConcept(mov.concepto ?? '')) continue;
      const ym = (mov.fechaOperacion ?? '').slice(0, 7);
      if (ym.length !== 7) continue;
      if (compareYearMonth(ym, currentYm) >= 0) continue;
      const prov = matchConceptToProvider(mov.concepto ?? '', index);
      if (!prov) continue;
      const dom = Number((mov.fechaOperacion ?? '').slice(8, 10)) || 15;
      let monthly = perProvider.get(prov.id);
      if (!monthly) { monthly = new Map(); perProvider.set(prov.id, monthly); }
      const bucket = monthly.get(ym) ?? { amount: 0, days: [] };
      bucket.amount += Math.abs(mov.importe ?? 0);
      bucket.days.push(dom);
      monthly.set(ym, bucket);
    }
  }

  // Ventana de `lookbackMonths` meses calendario anteriores al mes en curso.
  // Usar meses fijos (en vez de meses con actividad) evita que un proveedor
  // con un solo pago en un mes lejano se vea como "recurrente" por 1/1.
  const recentMonths: string[] = [];
  let cursor = addMonths(currentYm, -lookbackMonths);
  while (compareYearMonth(cursor, currentYm) < 0) {
    recentMonths.push(cursor);
    cursor = addMonths(cursor, 1);
  }
  const monthsInWindow = recentMonths.length;

  const patterns = new Map<string, ProviderBankPattern>();
  for (const [provId, monthly] of perProvider) {
    const provider = providers.find((p) => p.id === provId);
    if (!provider) continue;
    const active = recentMonths.filter((ym) => (monthly.get(ym)?.amount ?? 0) > 0);
    const activeMonths = active.length;
    if (activeMonths === 0) continue;
    const totalInWindow = active.reduce((s, ym) => s + (monthly.get(ym)?.amount ?? 0), 0);
    const monthlyAvg = totalInWindow / activeMonths;
    const allDays: number[] = [];
    for (const ym of active) allDays.push(...(monthly.get(ym)?.days ?? []));
    allDays.sort((a, b) => a - b);
    const typicalPayDay = allDays.length > 0 ? allDays[Math.floor(allDays.length / 2)] : 15;
    const lastPaid = Array.from(monthly.keys()).sort().slice(-1)[0] ?? null;
    const isRecurring = monthsInWindow > 0 && activeMonths / monthsInWindow >= 0.5;

    // Estacionalidad por mes calendario: usa TODA la historia disponible,
    // no sólo la ventana de recurrencia. Acumula pagos por mes calendario
    // y promedia por número de años observados en ese mes. Sin esto, la
    // proyección de egreso era plana mes-a-mes (mismo monthlyAvg cada mes
    // futuro), perdiendo aguinaldo / refrendos / pagos anuales.
    const monthlyAvgByCalendarMonth: number[] = new Array(12).fill(0);
    const yearsByCalendarMonth: Array<Set<string>> = Array.from({ length: 12 }, () => new Set());
    for (const [ym, bucket] of monthly) {
      const yearStr = ym.slice(0, 4);
      const monthIdx = Number(ym.slice(5, 7)) - 1;
      if (monthIdx < 0 || monthIdx > 11) continue;
      monthlyAvgByCalendarMonth[monthIdx] += bucket.amount;
      yearsByCalendarMonth[monthIdx].add(yearStr);
    }
    for (let i = 0; i < 12; i++) {
      const yearCount = yearsByCalendarMonth[i].size;
      if (yearCount > 0) monthlyAvgByCalendarMonth[i] /= yearCount;
    }

    patterns.set(provId, {
      provider,
      activeMonths,
      monthsInWindow,
      monthlyAvg,
      monthlyAvgByCalendarMonth,
      lastPaid,
      typicalPayDay,
      isRecurring,
    });
  }
  return patterns;
}

export function isNoisyBankExpenseConcept(concepto: string): boolean {
  const normalized = norm(concepto);
  if (!normalized) return false;
  const compact = normalized.replace(/[^A-Z0-9]/g, '');
  if (/\bPAGO\s+(?:A\s+)?TARJETA\b/.test(normalized)) return true;
  if (/\bTARJ(?:ETA)?\.?\s*NO\b/.test(normalized) || compact.startsWith('TARJNO')) return true;
  if (normalized.includes('TRANS INTERBANCARIA') || normalized.includes('TRANS. INTERBANCARIA')) return true;
  if (normalized.includes('TRANSF A LA CUENTA') || normalized.includes('TRANSF. A LA CUENTA')) return true;
  if (normalized.includes('TRASPASO') || normalized.includes('TRANSFERENCIA ENTRE CUENTAS')) return true;
  return false;
}

// ── Egresos por proveedor-mes ────────────────────────────────────────────

export interface ProviderMonthLine {
  providerId: string;
  providerName: string;
  providerCategory?: string;
  flexibility: Flexibility;
  paymentPeriod: Provider['paymentPeriod'];
  typicalPayDay?: number;
  score?: number;
  ivaRate?: Provider['ivaRate'];
  amount: number;
  source: 'scheduled' | 'recurring' | 'mixed';
  /** Detalle de cómo se compuso el amount — útil para tooltip. */
  parts: { scheduled: number; recurring: number };
}

export interface PerProviderMonth {
  yearMonth: string;
  lines: ProviderMonthLine[];
  scheduledTotal: number;
  recurringTotal: number;
  total: number;
}

/**
 * Construye la proyección de egresos por proveedor-mes dentro del rango
 * [fromYm, toYm]. Lo que ya está programado en /AntiguedadSaldos manda;
 * el recurrente se usa sólo para meses/proveedores sin CXP.
 */
export function projectExpenseByProvider(params: {
  providers: Provider[];
  aged: AgedBalanceRecord[];
  bankStatements: BankAccountStatement[];
  today: string;
  fromYm: string;
  toYm: string;
}): PerProviderMonth[] {
  const { providers, aged, bankStatements, today, fromYm, toYm } = params;
  const index = buildProviderIndex(providers);
  const patterns = buildProviderBankPatterns(providers, bankStatements, today);

  // aged → yearMonth → providerId → amount (agrupa records sin match en "__unmatched__").
  const agedBuckets = new Map<string, Map<string, { name: string; flex: Flexibility; period: Provider['paymentPeriod']; amount: number }>>();
  for (const r of aged) {
    const ym = (r.fechaProgramacionPago ?? '').slice(0, 7);
    if (ym.length !== 7) continue;
    const amt = r.importePendientePesos ?? 0;
    if (amt <= 0) continue;
    const matched = matchAgedToProvider(r, index);
    const key = matched?.id ?? `__un::${norm(r.nombre)}`;
    const name = matched?.name ?? (r.nombre || 'Proveedor s/n').trim();
    const flex = matched?.flexibility ?? 'unknown';
    const period = matched?.paymentPeriod ?? '30 días';
    let byProv = agedBuckets.get(ym);
    if (!byProv) { byProv = new Map(); agedBuckets.set(ym, byProv); }
    const prev = byProv.get(key) ?? { name, flex, period, amount: 0 };
    prev.amount += amt;
    byProv.set(key, prev);
  }

  const out: PerProviderMonth[] = [];
  let cursor = fromYm;
  while (compareYearMonth(cursor, toYm) <= 0) {
    const monthIdx = Number(cursor.slice(5, 7)) - 1;
    // Blend 50/50 entre promedio plano y el mes calendario observado:
    // si el slot calendario es 0 (sin historia), regresa al promedio plano.
    const seasonalAmountFor = (pat: ProviderBankPattern): number => {
      const seasonal = pat.monthlyAvgByCalendarMonth[monthIdx] || 0;
      if (seasonal <= 0) return pat.monthlyAvg;
      return 0.5 * pat.monthlyAvg + 0.5 * seasonal;
    };
    const lines: ProviderMonthLine[] = [];
    const agedForMonth = agedBuckets.get(cursor) ?? new Map();
    const coveredProviderIds = new Set<string>();

    // 1. Proveedores con CXP abierto este mes.
    for (const [key, bucket] of agedForMonth) {
      const matchedProvider = providers.find((p) => p.id === key);
      const minMonthly = operationalMonthlyFloor(matchedProvider);
      const line: ProviderMonthLine = {
        providerId: key,
        providerName: bucket.name,
        providerCategory: matchedProvider?.type,
        flexibility: bucket.flex,
        paymentPeriod: bucket.period,
        typicalPayDay: 15,
        score: matchedProvider?.score,
        ivaRate: matchedProvider?.ivaRate,
        amount: bucket.amount,
        source: 'scheduled',
        parts: { scheduled: bucket.amount, recurring: 0 },
      };
      // Si además es recurrente y el promedio mensual (estacional) es mayor,
      // subimos al avg (puede haber facturas por llegar que aún no entraron a CXP).
      const pat = patterns.get(key);
      if (pat && pat.isRecurring) {
        const seasonalAvg = seasonalAmountFor(pat);
        if (seasonalAvg > bucket.amount) {
          line.amount = seasonalAvg;
          line.source = 'mixed';
          line.parts.recurring = seasonalAvg - bucket.amount;
          line.typicalPayDay = pat.typicalPayDay;
          line.score = pat.provider.score;
          line.ivaRate = pat.provider.ivaRate;
        }
      }
      if (minMonthly > line.amount) {
        line.source = 'mixed';
        line.parts.recurring += minMonthly - line.amount;
        line.amount = minMonthly;
      }
      lines.push(line);
      coveredProviderIds.add(key);
    }

    // 2. Proveedores recurrentes sin CXP para este mes.
    for (const [provId, pat] of patterns) {
      if (!pat.isRecurring) continue;
      if (coveredProviderIds.has(provId)) continue;
      const minMonthly = operationalMonthlyFloor(pat.provider);
      const amount = Math.max(seasonalAmountFor(pat), minMonthly);
      lines.push({
        providerId: provId,
        providerName: pat.provider.name,
        providerCategory: pat.provider.type,
        flexibility: pat.provider.flexibility ?? 'unknown',
        paymentPeriod: pat.provider.paymentPeriod,
        typicalPayDay: pat.typicalPayDay,
        score: pat.provider.score,
        ivaRate: pat.provider.ivaRate,
        amount,
        source: 'recurring',
        parts: { scheduled: 0, recurring: amount },
      });
      coveredProviderIds.add(provId);
    }

    // 3. Piso operativo del catálogo para proveedores críticos sin CXP ni
    // patrón bancario suficiente. Esto hace visible el gasto mínimo como
    // egreso proyectado real, no sólo como indicador amarillo.
    for (const provider of providers) {
      if (coveredProviderIds.has(provider.id)) continue;
      const minMonthly = operationalMonthlyFloor(provider);
      if (minMonthly <= 0) continue;
      lines.push({
        providerId: provider.id,
        providerName: provider.name,
        providerCategory: provider.type,
        flexibility: provider.flexibility ?? 'unknown',
        paymentPeriod: provider.paymentPeriod,
        typicalPayDay: 15,
        score: provider.score,
        ivaRate: provider.ivaRate,
        amount: minMonthly,
        source: 'recurring',
        parts: { scheduled: 0, recurring: minMonthly },
      });
      coveredProviderIds.add(provider.id);
    }

    lines.sort((a, b) => b.amount - a.amount);
    const scheduledTotal = lines.reduce((s, l) => s + l.parts.scheduled, 0);
    const recurringTotal = lines.reduce((s, l) => s + l.parts.recurring, 0);
    const total = lines.reduce((s, l) => s + l.amount, 0);
    out.push({ yearMonth: cursor, lines, scheduledTotal, recurringTotal, total });
    cursor = addMonths(cursor, 1);
  }
  return out;
}
