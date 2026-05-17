/**
 * Lead-time histogram from historical Compras.
 *
 * Para proyectar pagos de OCs aún no recibidas necesitamos estimar
 * `fechaRecepcion ≈ fechaPedido + leadTime`. El leadTime se calcula del
 * histórico: por cada OC con `fechaPedido` y `fechaRecepcion` válidas,
 * el delta en días.
 *
 * Jerarquía de fallback (más específico → más general):
 *   1. cia + subFamilia
 *   2. cia + familia
 *   3. subFamilia (cualquier cia)
 *   4. familia (cualquier cia)
 *   5. categoria
 *   6. default global (DEFAULT_LEAD_TIME_DAYS)
 *
 * Outliers: descartamos deltas negativos y > 180 días (capturas malas o
 * OCs históricas que se cierran tarde).
 */

import type { ComprasRecord } from '../services/jdeTypes';

export const DEFAULT_LEAD_TIME_DAYS = 21;
const MAX_LEAD_TIME_DAYS = 180;
const MIN_SAMPLE_SIZE = 3;

export interface LeadTimeBucket {
  avgDays: number;
  medianDays: number;
  sampleSize: number;
}

export interface LeadTimeStats {
  byCiaSubfamilia: Map<string, LeadTimeBucket>;
  byCiaFamilia: Map<string, LeadTimeBucket>;
  bySubfamilia: Map<string, LeadTimeBucket>;
  byFamilia: Map<string, LeadTimeBucket>;
  byCategoria: Map<string, LeadTimeBucket>;
  global: LeadTimeBucket | null;
}

function daysBetween(a: string, b: string): number {
  const t1 = new Date(`${a}T00:00:00.000Z`).getTime();
  const t2 = new Date(`${b}T00:00:00.000Z`).getTime();
  return (t2 - t1) / 86_400_000;
}

function bucketStats(deltas: number[]): LeadTimeBucket | null {
  if (deltas.length < MIN_SAMPLE_SIZE) return null;
  const sorted = [...deltas].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, d) => acc + d, 0);
  const avg = sum / sorted.length;
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[(sorted.length - 1) / 2];
  return {
    avgDays: Math.round(avg),
    medianDays: Math.round(median),
    sampleSize: sorted.length,
  };
}

function pushBucket(map: Map<string, number[]>, key: string, delta: number) {
  if (!key) return;
  const arr = map.get(key);
  if (arr) arr.push(delta);
  else map.set(key, [delta]);
}

function freezeBuckets(map: Map<string, number[]>): Map<string, LeadTimeBucket> {
  const out = new Map<string, LeadTimeBucket>();
  for (const [key, deltas] of map) {
    const stats = bucketStats(deltas);
    if (stats) out.set(key, stats);
  }
  return out;
}

export function computeLeadTimeStats(records: ComprasRecord[]): LeadTimeStats {
  const ciaSubfam = new Map<string, number[]>();
  const ciaFam = new Map<string, number[]>();
  const subfam = new Map<string, number[]>();
  const fam = new Map<string, number[]>();
  const cat = new Map<string, number[]>();
  const all: number[] = [];

  for (const r of records) {
    if (r.cancelada) continue;
    if (!r.fechaPedido || !r.fechaRecepcion) continue;
    const delta = daysBetween(r.fechaPedido, r.fechaRecepcion);
    if (!Number.isFinite(delta)) continue;
    if (delta < 0 || delta > MAX_LEAD_TIME_DAYS) continue;

    const cia = r.cia || '';
    const f = (r.familia || '').trim();
    const sf = (r.subFamilia || '').trim();
    const c = (r.categoria || '').trim();

    if (cia && sf) pushBucket(ciaSubfam, `${cia}|${sf}`, delta);
    if (cia && f) pushBucket(ciaFam, `${cia}|${f}`, delta);
    if (sf) pushBucket(subfam, sf, delta);
    if (f) pushBucket(fam, f, delta);
    if (c) pushBucket(cat, c, delta);
    all.push(delta);
  }

  return {
    byCiaSubfamilia: freezeBuckets(ciaSubfam),
    byCiaFamilia: freezeBuckets(ciaFam),
    bySubfamilia: freezeBuckets(subfam),
    byFamilia: freezeBuckets(fam),
    byCategoria: freezeBuckets(cat),
    global: bucketStats(all),
  };
}

export function leadTimeFor(
  stats: LeadTimeStats,
  context: { cia?: string; familia?: string; subFamilia?: string; categoria?: string },
): { days: number; source: 'cia-subfamilia' | 'cia-familia' | 'subfamilia' | 'familia' | 'categoria' | 'global' | 'default' } {
  const cia = (context.cia || '').trim();
  const sf = (context.subFamilia || '').trim();
  const f = (context.familia || '').trim();
  const c = (context.categoria || '').trim();

  if (cia && sf) {
    const hit = stats.byCiaSubfamilia.get(`${cia}|${sf}`);
    if (hit) return { days: hit.medianDays, source: 'cia-subfamilia' };
  }
  if (cia && f) {
    const hit = stats.byCiaFamilia.get(`${cia}|${f}`);
    if (hit) return { days: hit.medianDays, source: 'cia-familia' };
  }
  if (sf) {
    const hit = stats.bySubfamilia.get(sf);
    if (hit) return { days: hit.medianDays, source: 'subfamilia' };
  }
  if (f) {
    const hit = stats.byFamilia.get(f);
    if (hit) return { days: hit.medianDays, source: 'familia' };
  }
  if (c) {
    const hit = stats.byCategoria.get(c);
    if (hit) return { days: hit.medianDays, source: 'categoria' };
  }
  if (stats.global) {
    return { days: stats.global.medianDays, source: 'global' };
  }
  return { days: DEFAULT_LEAD_TIME_DAYS, source: 'default' };
}
