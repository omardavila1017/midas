import { FlowConcept, FlowPlan } from '../types';
import { apiConfig } from '../config/api.config';

const MONTHLY_INCOME = [
  18500000, 19100000, 20400000, 19800000, 21100000, 21800000,
  22600000, 22300000, 23100000, 23800000, 24400000, 25200000,
];

const MONTHLY_EXPENSES = [
  17200000, 17900000, 18700000, 18500000, 19600000, 20300000,
  20900000, 21100000, 21600000, 22400000, 22800000, 23400000,
];

function weekDatesForYear(year: number): string[] {
  const dates: string[] = [];
  const cursor = new Date(Date.UTC(year, 0, 1));
  while (cursor.getUTCDay() !== 1) cursor.setUTCDate(cursor.getUTCDate() + 1);
  while (cursor.getUTCFullYear() <= year && dates.length < 53) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return dates;
}

function spreadMonthlyToWeeks(monthly: number[], year: number, weeks: string[]): number[] {
  const counts = new Array(12).fill(0);
  weeks.forEach((date) => {
    counts[new Date(`${date}T00:00:00Z`).getUTCMonth()] += 1;
  });

  return weeks.map((date) => {
    const month = new Date(`${date}T00:00:00Z`).getUTCMonth();
    return monthly[month] / Math.max(1, counts[month]);
  });
}

function concept(
  id: string,
  name: string,
  conceptType: FlowConcept['conceptType'],
  monthlyData: number[],
  year: number,
  weekDates: string[],
  sortOrder: number,
  parentId: string | null = null,
): FlowConcept {
  return {
    id,
    excelRow: sortOrder,
    name,
    parentId,
    responsible: 'Tesorería',
    conceptType,
    sortOrder,
    monthlyData,
    weeklyData: spreadMonthlyToWeeks(monthlyData, year, weekDates),
  };
}

function mockPlan(): FlowPlan {
  const year = new Date().getFullYear();
  const weekDates = weekDatesForYear(year);
  const netFlow = MONTHLY_INCOME.map((value, index) => value - MONTHLY_EXPENSES[index]);
  const cajaInicial = 8200000;
  let runningCash = cajaInicial;
  const endingCash = netFlow.map((value) => {
    runningCash += value;
    return runningCash;
  });

  const concepts = [
    concept('ingresos', 'Ingresos', 'ingreso', MONTHLY_INCOME, year, weekDates, 7),
    concept('cobranza-clientes', 'Cobranza clientes', 'ingreso', MONTHLY_INCOME, year, weekDates, 8, 'ingresos'),
    concept('egresos', 'Egresos', 'egreso', MONTHLY_EXPENSES, year, weekDates, 20),
    concept('pagos-proveedores', 'Pagos proveedores', 'egreso', MONTHLY_EXPENSES, year, weekDates, 21, 'egresos'),
    concept('variacion-caja', 'Variación en Caja', 'resumen', netFlow, year, weekDates, 90),
    concept('caja-final', 'Caja Final', 'reserva', endingCash, year, weekDates, 91),
  ];

  return {
    name: 'Flujo consolidado Atlas',
    year,
    cajaInicial,
    concepts,
    weekDates,
  };
}

export async function fetchCashFlowPlan(): Promise<FlowPlan> {
  if (!apiConfig.cognos.baseUrl) return mockPlan();

  try {
    const response = await fetch(`${apiConfig.cognos.baseUrl}/reports/flowsense/cash-flow-plan`, {
      headers: {
        Authorization: `Bearer ${apiConfig.cognos.authValue}`,
        Accept: 'application/json',
        'X-Cognos-Namespace': apiConfig.cognos.namespace,
      },
    });
    if (!response.ok) return mockPlan();
    return (await response.json()) as FlowPlan;
  } catch {
    return mockPlan();
  }
}
