import { describe, expect, it } from 'vitest';
import { buildFideicomisoMovements } from './fideicomisoMovements';
import { DINA_MONTHLY_OBLIGATION } from '../../../config/fideicomiso.config';
import type { BankAccountStatement, BankStatementLine } from '../../../services/jde';

function line(partial: Partial<BankStatementLine>): BankStatementLine {
  return {
    cia: '00011', banco: 'BANBAJIO', cuenta: 'BANBAJIO', moneda: 'MXN',
    fechaOperacion: '2026-05-10', referencia: '', concepto: '',
    tipoMovimiento: 'ABONO', importe: 0,
    ...partial,
  } as BankStatementLine;
}

function bajio(movimientos: BankStatementLine[]): BankAccountStatement {
  return {
    cia: '00011', banco: 'BANBAJIO', nombreBanco: 'BANBAJIO', cuenta: 'BANBAJIO',
    moneda: 'MXN', fechaEstadoCuenta: '2026-05-15', movimientos,
  } as BankAccountStatement;
}

const WINDOW = { scenarioId: 'approved', startDate: '2026-01-01', endDate: '2026-12-31', asOfDate: '2026-05-18' };

describe('buildFideicomisoMovements', () => {
  it('inyecta la obligación DINA mensual (día 15) como egreso DEBT locked', () => {
    const movs = buildFideicomisoMovements({ ...WINDOW, bajioStatements: [] });
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

  it('inyecta los ABONOs Corning reales de Bajío como ingreso REAL', () => {
    const stmt = bajio([
      line({ concepto: 'TRANSFERENCIA CORNING SA', importe: 5_000_000, fechaOperacion: '2026-05-10' }),
      line({ concepto: 'PAGO PROVEEDOR X', importe: 999, fechaOperacion: '2026-05-11' }), // no Corning
      line({ tipoMovimiento: 'CARGO', concepto: 'CORNING devolución', importe: 100, fechaOperacion: '2026-05-12' }), // no ABONO
    ]);
    const movs = buildFideicomisoMovements({ ...WINDOW, bajioStatements: [stmt] });
    const corning = movs.filter(m => m.subcategory === 'FIDEICOMISO_CORNING');
    expect(corning).toHaveLength(1);
    expect(corning[0].type).toBe('INFLOW');
    expect(corning[0].status).toBe('REAL');
    expect(corning[0].projectedAmount).toBe(5_000_000);
    expect(corning[0].projectedDate).toBe('2026-05-10');
  });

  it('deduplica el mismo ABONO Corning entre dos cargas de estado de cuenta', () => {
    const mov = line({ concepto: 'CORNING', importe: 3_000_000, fechaOperacion: '2026-04-09', referencia: 'R1' });
    const movs = buildFideicomisoMovements({
      ...WINDOW,
      bajioStatements: [bajio([mov]), bajio([mov])],
    });
    expect(movs.filter(m => m.subcategory === 'FIDEICOMISO_CORNING')).toHaveLength(1);
  });

  it('recorta a la ventana: Corning fuera de rango se ignora', () => {
    const stmt = bajio([
      line({ concepto: 'CORNING', importe: 1_000, fechaOperacion: '2025-12-31' }),
      line({ concepto: 'CORNING', importe: 2_000, fechaOperacion: '2026-06-01' }),
    ]);
    const movs = buildFideicomisoMovements({ ...WINDOW, bajioStatements: [stmt] });
    const corning = movs.filter(m => m.subcategory === 'FIDEICOMISO_CORNING');
    expect(corning).toHaveLength(1);
    expect(corning[0].projectedDate).toBe('2026-06-01');
  });

  it('no inyecta nada del lado base (gate del llamador) — aquí solo verifica window vacía', () => {
    const movs = buildFideicomisoMovements({ ...WINDOW, startDate: '2026-12-20', endDate: '2026-12-25', bajioStatements: [] });
    // Ningún día 15 cae en 12-20..12-25.
    expect(movs.filter(m => m.subcategory === 'FIDEICOMISO_DINA')).toHaveLength(0);
  });
});
