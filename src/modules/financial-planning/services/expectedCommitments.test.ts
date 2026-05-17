import { describe, expect, it } from 'vitest';
import { parseExpectedCommitmentsPaste } from './expectedCommitments';

describe('expectedCommitments', () => {
  it('parses Excel-style pasted commitments with headers', () => {
    const result = parseExpectedCommitmentsPaste([
      'Concepto\tCategoría\tMonto\tFecha\tRecurrencia\tCompañía',
      'Nómina semanal\tNómina\t$1,250,000.00\t22/05/2026\tSemanal\t00001',
      'Compra unidades\tCAPEX\t2.500.000,50\t2026-06-15\tUna vez\t00002',
    ].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.drafts).toEqual([
      {
        name: 'Nómina semanal',
        category: 'PAYROLL',
        amount: 1250000,
        startDate: '2026-05-22',
        recurrence: 'WEEKLY',
        companyId: '00001',
      },
      {
        name: 'Compra unidades',
        category: 'CAPEX',
        amount: 2500000.5,
        startDate: '2026-06-15',
        recurrence: 'ONE_TIME',
        companyId: '00002',
      },
    ]);
  });

  it('reports invalid rows without blocking valid rows', () => {
    const result = parseExpectedCommitmentsPaste([
      'Pago energía\tOPEX\t90000\t2026-05-30\tMensual\t00001',
      'Sin monto\tOtro\t\t2026-05-30\tMensual\t00001',
    ].join('\n'));

    expect(result.drafts).toHaveLength(1);
    expect(result.errors).toEqual(['Fila 2: revisa monto.']);
  });
});
