import { describe, expect, it } from 'vitest';
import { buildFideicomisoMovements } from './fideicomisoMovements';
import { DINA_MONTHLY_OBLIGATION } from '../../../config/fideicomiso.config';

const WINDOW = { scenarioId: 'approved', startDate: '2026-01-01', endDate: '2026-12-31', asOfDate: '2026-05-18' };

describe('buildFideicomisoMovements', () => {
  it('inyecta la obligación DINA mensual (día 15) como egreso DEBT locked', () => {
    const movs = buildFideicomisoMovements(WINDOW);
    const dina = movs.filter(m => m.subcategory === 'FIDEICOMISO_DINA');
    expect(dina).toHaveLength(12); // ene–dic
    for (const m of dina) {
      expect(m.type).toBe('OUTFLOW');
      expect(m.category).toBe('DEBT');
      expect(m.lockState).toBe('LOCKED');
      expect(m.projectedAmount).toBe(DINA_MONTHLY_OBLIGATION);
      expect(m.projectedDate.endsWith('-15')).toBe(true);
    }
    expect(dina[0].projectedDate).toBe('2026-01-15');
    expect(dina[11].projectedDate).toBe('2026-12-15');
  });

  it('clampea el día 15 a fin de mes y recorta a la ventana', () => {
    const movs = buildFideicomisoMovements({ ...WINDOW, startDate: '2026-12-20', endDate: '2026-12-25' });
    // Ningún día 15 cae en 12-20..12-25.
    expect(movs.filter(m => m.subcategory === 'FIDEICOMISO_DINA')).toHaveLength(0);
  });

  // ── El ingreso Corning NO se re-inyecta: MOTOR 1 ya lo emite ──────────────
  //
  // `bajioStatements` es un SUBCONJUNTO de `accountableBankStatements`, así que
  // cada ABONO Corning ya sale como línea `bank:` INFLOW real de MOTOR 1.
  // Emitirlo también aquí lo contaba DOS VECES en todo escenario no-Base (el
  // recorte `>= currentMonthStart` de scenarioForecastRun deja pasar el mes en
  // curso, y un ABONO observado siempre es pasado). La otra mitad de esta
  // invariante —que MOTOR 1 efectivamente lo emite— vive pineada en
  // `historicalReconciledEngine.test.ts`; las dos deben moverse juntas.
  it('NO emite ingreso Corning: es un hecho bancario que ya cubre MOTOR 1', () => {
    const movs = buildFideicomisoMovements(WINDOW);
    expect(movs.some(m => m.id.startsWith('fideicomiso-corning:'))).toBe(false);
    expect(movs.every(m => m.type === 'OUTFLOW')).toBe(true);
  });
});
