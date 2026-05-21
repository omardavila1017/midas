import { describe, it, expect } from 'vitest';
import {
  buildConvenioSchedule,
  resolveConvenioPaymentDate,
} from './convenioConcursal';
import {
  CONVENIO_QUARTERS,
  CONVENIO_TOTALS,
  toConvenioMxn,
} from '../modules/concurso-mercantil/data/convenioSchedule';
import { reconcileConvenioPayments } from './convenioReconciliationEngine';
import type { BankAccountStatement } from '../services/jdeTypes';

describe('convenio schedule', () => {
  it('has 29 quarters from Oct-2022 to Oct-2029', () => {
    expect(CONVENIO_QUARTERS).toHaveLength(29);
    expect(CONVENIO_QUARTERS[0]).toMatchObject({ year: 2022, monthIndex: 10 });
    expect(CONVENIO_QUARTERS[28]).toMatchObject({ year: 2029, monthIndex: 10 });
  });

  it('scales miles → MXN at the chokepoint', () => {
    expect(toConvenioMxn(CONVENIO_TOTALS.saldoConvenio)).toBeCloseTo(3_635_935_406.145, 0);
  });

  it('sum of quarter interés+capital ties to CONVENIO_TOTALS (±0.5%)', () => {
    const s = buildConvenioSchedule('2030-01-01'); // todo histórico
    const expected = toConvenioMxn(
      CONVENIO_TOTALS.sumInteres + CONVENIO_TOTALS.sumCapital,
    );
    expect(s.totals.totalMxn).toBeCloseTo(expected, 0);
    expect(s.future).toHaveLength(0);
    expect(s.elapsed).toHaveLength(29);
  });

  it('splits elapsed vs future at asOfDate', () => {
    const s = buildConvenioSchedule('2026-05-15');
    expect(s.elapsed.length + s.future.length).toBe(29);
    // Oct-2022 … Abr-2026 ya vencieron; Jul-2026 en adelante es futuro.
    expect(s.elapsed.every((q) => q.scheduledDateIso <= '2026-05-15')).toBe(true);
    expect(s.future.every((q) => q.scheduledDateIso > '2026-05-15')).toBe(true);
    expect(s.future[0]).toMatchObject({ year: 2026, monthIndex: 7 });
  });

  it('rolls the last natural day forward over weekends', () => {
    // 2025-05-31 is a Saturday → expect forward roll to next business day.
    const r = resolveConvenioPaymentDate(2025, 5);
    expect(r.naturalDateIso).toBe('2025-05-31');
    expect(r.scheduledDateIso > r.naturalDateIso).toBe(true);
    expect(r.rolledDays).toBeGreaterThan(0);
  });
});

describe('convenio reconciliation', () => {
  it('marks elapsed quarters as sin-datos-banco when no statements', () => {
    const r = reconcileConvenioPayments([], '2026-05-15');
    expect(r.summary.elapsedCount).toBeGreaterThan(0);
    expect(r.summary.noBankDataCount).toBe(r.summary.elapsedCount);
    expect(r.matches.every((m) => m.status === 'sin-datos-banco')).toBe(true);
  });

  it('matches a quarter when a bank CARGO equals the scheduled total', () => {
    const sched = buildConvenioSchedule('2026-05-15');
    const q = sched.elapsed[sched.elapsed.length - 1]; // último vencido
    const stmt: BankAccountStatement = {
      cia: '001',
      banco: 'BANAMEX',
      cuenta: '123',
      moneda: 'MXN',
      fechaEstadoCuenta: q.scheduledDateIso,
      movimientos: [
        {
          cia: '001',
          banco: 'BANAMEX',
          cuenta: '123',
          moneda: 'MXN',
          fechaOperacion: q.scheduledDateIso,
          referencia: 'CONV',
          concepto: 'PAGO CONVENIO CONCURSAL',
          tipoMovimiento: 'CARGO',
          importe: q.totalMxn,
        },
      ],
    };
    const r = reconcileConvenioPayments([stmt], '2026-05-15');
    const match = r.matches.find((m) => m.key === q.key);
    expect(match?.status).toBe('matched');
    expect(match?.matchTier).toBe('exact');
    expect(match?.matchedAmountMxn).toBeCloseTo(q.totalMxn, 0);
  });
});
