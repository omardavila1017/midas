import { describe, expect, it } from 'vitest';
import { selectComprasForProjection } from './comprasProjectionFilter';

// Regression guard for the user's business rule + the structural OOM fix:
// an OC whose projected payment (fechaPagoProyectada) is before today must
// NOT enter the projection. With 332k+ historical OCs this filter is what
// keeps the canonical small enough to rebuild without renderer OOM.
describe('selectComprasForProjection — drop past projected payments', () => {
  const today = '2026-05-19';

  it('drops OCs whose fechaPagoProyectada is before today', () => {
    const out = selectComprasForProjection(
      [{ fechaPagoProyectada: '2025-08-01' }, { fechaPagoProyectada: '2026-05-18' }],
      today,
    );
    expect(out).toHaveLength(0);
  });

  it('keeps OCs whose fechaPagoProyectada is today or future', () => {
    const recs = [
      { fechaPagoProyectada: '2026-05-19' },
      { fechaPagoProyectada: '2026-12-31' },
    ];
    expect(selectComprasForProjection(recs, today)).toHaveLength(2);
  });

  it('keeps OCs WITHOUT a projected payment date (PROJECTED, future by construction)', () => {
    const recs = [
      { fechaPagoProyectada: undefined },
      { fechaPagoProyectada: null },
      { fechaPagoProyectada: '' },
    ];
    expect(selectComprasForProjection(recs, today)).toHaveLength(3);
  });

  it('handles ISO datetime strings (slices to date) and mixed sets', () => {
    const recs = [
      { fechaPagoProyectada: '2025-01-01T12:00:00Z' }, // past → drop
      { fechaPagoProyectada: '2026-06-01T00:00:00Z' }, // future → keep
      { fechaPagoProyectada: undefined },               // projected → keep
      { fechaPagoProyectada: '2026-05-18' },            // past → drop
    ];
    const out = selectComprasForProjection(recs, today);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.fechaPagoProyectada)).toEqual([
      '2026-06-01T00:00:00Z',
      undefined,
    ]);
  });

  it('massively shrinks a large historical set (the OOM driver)', () => {
    // 50k past OCs + 500 future = only the 500 survive → canonical stays small.
    const big = [
      ...Array.from({ length: 50_000 }, () => ({ fechaPagoProyectada: '2024-03-01' })),
      ...Array.from({ length: 500 }, () => ({ fechaPagoProyectada: '2026-09-01' })),
    ];
    const out = selectComprasForProjection(big, today);
    expect(out).toHaveLength(500);
  });
});
