import { describe, expect, it } from 'vitest';
import {
  createOperatingTaxDebt,
  effectiveOutstanding,
  plannedTotal,
  suggestOperatingTaxDebtPlan,
  summarizeOperatingTaxDebts,
  taxDebtsToManualExpenseEvents,
} from './operatingProjectionTaxes';

describe('operatingProjectionTaxes', () => {
  it('summarizes fiscal debt by year and scheduling gap', () => {
    const debts = [
      createOperatingTaxDebt({
        id: 'isr-2025',
        fiscalYear: 2025,
        taxType: 'ISR',
        label: 'ISR 2025',
        originalAmount: 1_000,
        paidAmount: 200,
        outstandingAmount: 800,
        dueDate: '2026-03-31',
        plannedPayments: [
          { id: 'p-1', date: '2026-04-30', amount: 300 },
        ],
      }),
      createOperatingTaxDebt({
        id: 'iva-2026',
        fiscalYear: 2026,
        taxType: 'IVA',
        label: 'IVA 2026',
        originalAmount: 500,
        paidAmount: 0,
        outstandingAmount: 500,
        dueDate: '2026-05-31',
        plannedPayments: [
          { id: 'p-2', date: '2026-04-15', amount: 200 },
        ],
      }),
    ];

    expect(summarizeOperatingTaxDebts(debts, '2026-04', '2026-04-25')).toEqual({
      totalDebt: 1_500,
      total2025: 800,
      total2026: 500,
      paid: 200,
      outstanding: 1_300,
      scheduledThisMonth: 500,
      overdue: 800,
      unscheduled: 800,
    });
  });

  it('creates a suggested weekly plan that covers the outstanding tax balance', () => {
    const debts = [
      createOperatingTaxDebt({
        id: 'convenio-2025',
        fiscalYear: 2025,
        taxType: 'Convenio',
        label: 'Convenio 2025',
        originalAmount: 1_200,
        paidAmount: 200,
        outstandingAmount: 1_000,
        dueDate: '2026-05-29',
      }),
    ];

    const planned = suggestOperatingTaxDebtPlan(debts, '2026-04-25')[0];

    expect(planned.plannedPayments.length).toBeGreaterThan(1);
    expect(planned.plannedPayments.every((payment) => payment.suggested)).toBe(true);
    expect(planned.plannedPayments[0].date).toBe('2026-04-27');
    expect(plannedTotal(planned)).toBeCloseTo(effectiveOutstanding(planned), 4);
  });

  it('converts editable planned payments into manual tax events for the projection engine', () => {
    const debts = [
      createOperatingTaxDebt({
        id: 'iva-2026',
        fiscalYear: 2026,
        taxType: 'IVA',
        label: 'IVA retenido',
        originalAmount: 500,
        outstandingAmount: 500,
        dueDate: '2026-06-30',
        plannedPayments: [
          { id: 'p-1', date: '2026-06-15', amount: 250, note: 'Pago parcial' },
          { id: 'p-2', date: '2026-06-30', amount: 0, note: 'Pateado' },
        ],
      }),
    ];

    expect(taxDebtsToManualExpenseEvents(debts)).toEqual([
      {
        id: 'p-1',
        concept: 'Impuestos',
        date: '2026-06-15',
        amount: 250,
        label: '2026 · IVA · IVA retenido',
        allowPartial: true,
      },
      {
        id: 'p-2',
        concept: 'Impuestos',
        date: '2026-06-30',
        amount: 0,
        label: '2026 · IVA · IVA retenido',
        allowPartial: true,
      },
    ]);
  });
});
