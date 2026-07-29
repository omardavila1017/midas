import { describe, expect, it } from 'vitest';
import { SCORE_BUCKETS, SCORE_LABELS, scoreBucket } from './providerScore';

describe('SCORE_BUCKETS / SCORE_LABELS', () => {
  it('exposes the four buckets in severity order', () => {
    expect(SCORE_BUCKETS).toEqual(['CRITICO', 'ALTO', 'MEDIO', 'BAJO']);
  });

  it('maps each bucket to its business label', () => {
    expect(SCORE_LABELS.CRITICO).toBe('Operativo');
    expect(SCORE_LABELS.ALTO).toBe('Prioritario');
    expect(SCORE_LABELS.MEDIO).toBe('Negociable');
    expect(SCORE_LABELS.BAJO).toBe('Flexible');
  });
});

describe('scoreBucket', () => {
  it('defaults to BAJO for undefined input', () => {
    expect(scoreBucket(undefined)).toBe('BAJO');
  });

  it('defaults to BAJO when neither clasificacionAutomatica nor score is present', () => {
    expect(scoreBucket({})).toBe('BAJO');
  });

  it('clasificacionAutomatica wins over the numeric score', () => {
    expect(scoreBucket({ clasificacionAutomatica: 'MEDIO', score: 95 })).toBe('MEDIO');
    expect(scoreBucket({ clasificacionAutomatica: 'CRITICO', score: 0 })).toBe('CRITICO');
  });

  it('passes through each precomputed classification', () => {
    expect(scoreBucket({ clasificacionAutomatica: 'CRITICO' })).toBe('CRITICO');
    expect(scoreBucket({ clasificacionAutomatica: 'ALTO' })).toBe('ALTO');
    expect(scoreBucket({ clasificacionAutomatica: 'MEDIO' })).toBe('MEDIO');
    expect(scoreBucket({ clasificacionAutomatica: 'BAJO' })).toBe('BAJO');
  });

  it('applies the numeric thresholds at their exact boundaries', () => {
    expect(scoreBucket({ score: 100 })).toBe('CRITICO');
    expect(scoreBucket({ score: 80 })).toBe('CRITICO');
    expect(scoreBucket({ score: 79.99 })).toBe('ALTO');
    expect(scoreBucket({ score: 60 })).toBe('ALTO');
    expect(scoreBucket({ score: 59.99 })).toBe('MEDIO');
    expect(scoreBucket({ score: 40 })).toBe('MEDIO');
    expect(scoreBucket({ score: 39.99 })).toBe('BAJO');
    expect(scoreBucket({ score: 0 })).toBe('BAJO');
  });

  it('treats negative scores as BAJO', () => {
    expect(scoreBucket({ score: -10 })).toBe('BAJO');
  });

  it('rejects non-finite scores (NaN / Infinity) → BAJO', () => {
    expect(scoreBucket({ score: Number.NaN })).toBe('BAJO');
    expect(scoreBucket({ score: Number.POSITIVE_INFINITY })).toBe('BAJO');
    expect(scoreBucket({ score: Number.NEGATIVE_INFINITY })).toBe('BAJO');
  });
});
