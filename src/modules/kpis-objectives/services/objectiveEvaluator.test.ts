import { describe, it, expect } from 'vitest';
import { evaluateObjective, objectiveStatusBadge, type EvaluatorContext } from './objectiveEvaluator';
import type { KpiRow, Objective } from '../types';
import type { BankStatementLine, CobranzaPayment } from '../../../services/jdeTypes';

function objective(patch: Partial<Objective> = {}): Objective {
  return {
    id: 'obj-1',
    name: 'Objetivo de prueba',
    kind: 'QUALITATIVE',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

function payment(patch: Partial<CobranzaPayment> = {}): CobranzaPayment {
  return {
    idPago: 'p-1',
    cia: '00001',
    fechaCobro: '2026-03-10',
    fechaContable: '2026-03-10',
    cuentaBancaria: '0190047839',
    banco: '002',
    noRecibo: 'R-1',
    importeRecibo: 1000,
    pendienteAplicar: 0,
    noCliente: '9001',
    cliente: 'CLIENTE ALFA',
    noBatch: 'B-1',
    tipoCambio: 1,
    applications: [],
    ...patch,
  };
}

function bankLine(patch: Partial<BankStatementLine> = {}): BankStatementLine {
  return {
    cia: '00011',
    banco: '002',
    cuenta: '0190047839',
    moneda: 'MXN',
    fechaOperacion: '2026-03-10',
    referencia: 'REF',
    concepto: 'PAGO',
    tipoMovimiento: 'CARGO',
    importe: 500,
    ...patch,
  };
}

function kpiRow(patch: Partial<KpiRow> = {}): KpiRow {
  return {
    key: 'system:dso',
    source: 'system',
    label: 'DSO',
    unit: 'days',
    periodLabel: '2026',
    value: 45,
    deltaPrev: null,
    ...patch,
  };
}

function ctx(patch: Partial<EvaluatorContext> = {}): EvaluatorContext {
  return {
    bankStatements: [],
    cobranzaPayments: [],
    kpiRows: [],
    today: '2026-06-15',
    ...patch,
  };
}

describe('evaluateObjective — manual override', () => {
  it('manualStatus wins over any formula', () => {
    const result = evaluateObjective(
      objective({
        kind: 'NUMERIC_MONTHLY',
        numericConcept: 'INFLOW',
        targetYearMonth: '2026-03',
        targetAmount: 999_999,
        comparison: 'GTE',
        manualStatus: 'MET',
      }),
      ctx(),
    );
    expect(result.status).toBe('MET');
    expect(result.manualOverride).toBe(true);
  });
});

describe('evaluateObjective — NUMERIC_MONTHLY', () => {
  it('returns IN_PROGRESS with a reason when config is incomplete', () => {
    const result = evaluateObjective(
      objective({ kind: 'NUMERIC_MONTHLY', numericConcept: 'INFLOW' }),
      ctx(),
    );
    expect(result.status).toBe('IN_PROGRESS');
    expect(result.reason).toContain('Faltan datos');
  });

  it('INFLOW: sums cobranza payments of the target month and marks MET for a past month', () => {
    const result = evaluateObjective(
      objective({
        kind: 'NUMERIC_MONTHLY',
        numericConcept: 'INFLOW',
        targetYearMonth: '2026-03',
        targetAmount: 1500,
        comparison: 'GTE',
      }),
      ctx({
        cobranzaPayments: [
          payment({ importeRecibo: 1000 }),
          payment({ idPago: 'p-2', importeRecibo: 600 }),
          payment({ idPago: 'p-3', fechaCobro: '2026-04-01', fechaContable: '', importeRecibo: 999 }),
        ],
      }),
    );
    expect(result.status).toBe('MET');
    expect(result.actualValue).toBe(1600);
  });

  it('INFLOW below target on a past month is MISSED', () => {
    const result = evaluateObjective(
      objective({
        kind: 'NUMERIC_MONTHLY',
        numericConcept: 'INFLOW',
        targetYearMonth: '2026-03',
        targetAmount: 5000,
        comparison: 'GTE',
      }),
      ctx({ cobranzaPayments: [payment({ importeRecibo: 1000 })] }),
    );
    expect(result.status).toBe('MISSED');
  });

  it('a current/future month stays IN_PROGRESS even if the target is already met', () => {
    const result = evaluateObjective(
      objective({
        kind: 'NUMERIC_MONTHLY',
        numericConcept: 'INFLOW',
        targetYearMonth: '2026-06',
        targetAmount: 100,
        comparison: 'GTE',
      }),
      ctx({
        today: '2026-06-15',
        cobranzaPayments: [payment({ fechaCobro: '2026-06-10', importeRecibo: 500 })],
      }),
    );
    expect(result.status).toBe('IN_PROGRESS');
    expect(result.actualValue).toBe(500);
  });

  it('OUTFLOW: sums only CARGO bank lines of the month; LTE compares as a ceiling', () => {
    const result = evaluateObjective(
      objective({
        kind: 'NUMERIC_MONTHLY',
        numericConcept: 'OUTFLOW',
        targetYearMonth: '2026-03',
        targetAmount: 1000,
        comparison: 'LTE',
      }),
      ctx({
        bankStatements: [
          bankLine({ importe: 500 }),
          bankLine({ importe: 300 }),
          bankLine({ tipoMovimiento: 'ABONO', importe: 9_999 }),
          bankLine({ fechaOperacion: '2026-04-02', importe: 9_999 }),
        ],
      }),
    );
    expect(result.status).toBe('MET');
    expect(result.actualValue).toBe(800);
  });

  it('CASH_CLOSE: takes the latest saldo per account on or before month end and sums accounts', () => {
    const result = evaluateObjective(
      objective({
        kind: 'NUMERIC_MONTHLY',
        numericConcept: 'CASH_CLOSE',
        targetYearMonth: '2026-03',
        targetAmount: 1_000,
        comparison: 'GTE',
      }),
      ctx({
        bankStatements: [
          // Account A: two snapshots in-month; the later one must win.
          bankLine({ cuenta: 'A', fechaOperacion: '2026-03-10', saldo: 100 }),
          bankLine({ cuenta: 'A', fechaOperacion: '2026-03-30', saldo: 700 }),
          // Account B: in-month snapshot + one AFTER cutoff that must be ignored.
          bankLine({ cuenta: 'B', fechaOperacion: '2026-03-15', saldo: 500 }),
          bankLine({ cuenta: 'B', fechaOperacion: '2026-04-01', saldo: 9_999 }),
        ],
      }),
    );
    expect(result.actualValue).toBe(1_200);
    expect(result.status).toBe('MET');
  });
});

describe('evaluateObjective — KPI_THRESHOLD', () => {
  it('compares the linked KPI value against the threshold', () => {
    const met = evaluateObjective(
      objective({ kind: 'KPI_THRESHOLD', linkedKpiKey: 'system:dso', threshold: 50, comparison: 'LTE' }),
      ctx({ kpiRows: [kpiRow({ value: 45 })] }),
    );
    expect(met.status).toBe('MET');
    expect(met.actualValue).toBe(45);

    const missed = evaluateObjective(
      objective({ kind: 'KPI_THRESHOLD', linkedKpiKey: 'system:dso', threshold: 40, comparison: 'LTE' }),
      ctx({ kpiRows: [kpiRow({ value: 45 })] }),
    );
    expect(missed.status).toBe('MISSED');
  });

  it('EQ uses a small tolerance instead of strict equality', () => {
    const result = evaluateObjective(
      objective({ kind: 'KPI_THRESHOLD', linkedKpiKey: 'system:dso', threshold: 45.004, comparison: 'EQ' }),
      ctx({ kpiRows: [kpiRow({ value: 45 })] }),
    );
    expect(result.status).toBe('MET');
  });

  it('stays IN_PROGRESS when the KPI is gone or has no value', () => {
    const gone = evaluateObjective(
      objective({ kind: 'KPI_THRESHOLD', linkedKpiKey: 'system:missing', threshold: 1, comparison: 'GTE' }),
      ctx({ kpiRows: [kpiRow()] }),
    );
    expect(gone.status).toBe('IN_PROGRESS');
    expect(gone.reason).toContain('ya no existe');

    const noValue = evaluateObjective(
      objective({ kind: 'KPI_THRESHOLD', linkedKpiKey: 'system:dso', threshold: 1, comparison: 'GTE' }),
      ctx({ kpiRows: [kpiRow({ value: null })] }),
    );
    expect(noValue.status).toBe('IN_PROGRESS');
    expect(noValue.actualValue).toBeNull();
  });
});

describe('evaluateObjective — QUALITATIVE', () => {
  it('is MISSED once the due date passes without a manual MET', () => {
    const result = evaluateObjective(
      objective({ kind: 'QUALITATIVE', dueDate: '2026-06-01' }),
      ctx({ today: '2026-06-15' }),
    );
    expect(result.status).toBe('MISSED');
  });

  it('stays IN_PROGRESS before the due date or without one', () => {
    expect(
      evaluateObjective(objective({ kind: 'QUALITATIVE', dueDate: '2026-12-31' }), ctx()).status,
    ).toBe('IN_PROGRESS');
    expect(evaluateObjective(objective({ kind: 'QUALITATIVE' }), ctx()).status).toBe('IN_PROGRESS');
  });
});

describe('objectiveStatusBadge', () => {
  it('maps status to label + tone', () => {
    expect(objectiveStatusBadge('MET')).toEqual({ label: 'Cumplido', tone: 'success' });
    expect(objectiveStatusBadge('MISSED')).toEqual({ label: 'No cumplido', tone: 'danger' });
    expect(objectiveStatusBadge('IN_PROGRESS')).toEqual({ label: 'En progreso', tone: 'warning' });
  });
});
