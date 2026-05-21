/**
 * Single source of truth for the provider catalog score → bucket → label
 * mapping. Used by the Catálogo de Proveedores view and the CXP module so
 * both show the same business classification (Operativo / Prioritario /
 * Negociable / Flexible).
 */

export type ScoreBucket = 'CRITICO' | 'ALTO' | 'MEDIO' | 'BAJO';

export const SCORE_BUCKETS: ScoreBucket[] = ['CRITICO', 'ALTO', 'MEDIO', 'BAJO'];

export const SCORE_LABELS: Record<ScoreBucket, string> = {
  CRITICO: 'Operativo',
  ALTO: 'Prioritario',
  MEDIO: 'Negociable',
  BAJO: 'Flexible',
};

/**
 * Resolve the score bucket. The catalog's precomputed `clasificacionAutomatica`
 * wins when present; otherwise fall back to the numeric score thresholds
 * (≥80 CRITICO, 60–79 ALTO, 40–59 MEDIO, <40 BAJO). Defaults to BAJO.
 */
export function scoreBucket(
  input: { clasificacionAutomatica?: ScoreBucket; score?: number } | undefined,
): ScoreBucket {
  if (!input) return 'BAJO';
  if (input.clasificacionAutomatica) return input.clasificacionAutomatica;
  const s = input.score;
  if (typeof s === 'number' && Number.isFinite(s)) {
    if (s >= 80) return 'CRITICO';
    if (s >= 60) return 'ALTO';
    if (s >= 40) return 'MEDIO';
  }
  return 'BAJO';
}
