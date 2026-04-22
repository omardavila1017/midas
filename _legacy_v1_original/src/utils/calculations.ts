import { Proposal } from '../types';

/**
 * Calculate monthly impact array and annual total for a proposal.
 * monthlyAmount is the estimated monthly impact in $M.
 * probability weights the impact.
 * distribution controls which months get the impact.
 */
export function calculateProposalImpact(
  monthlyAmount: number,
  probability: number,
  startMonth: number, // 1-12
  distribution: 'Mensual' | 'Semestral' | 'Único',
): { monthlyImpact: number[]; annualImpact: number } {
  const monthlyImpact: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const startIndex = Math.max(0, Math.min(11, startMonth - 1));
  const impact = monthlyAmount * probability;

  if (distribution === 'Mensual') {
    for (let m = startIndex; m < 12; m++) {
      monthlyImpact[m] = impact;
    }
  } else if (distribution === 'Semestral') {
    monthlyImpact[startIndex] = impact;
    const secondIndex = startIndex + 6;
    if (secondIndex < 12) {
      monthlyImpact[secondIndex] = impact;
    }
  } else if (distribution === 'Único') {
    monthlyImpact[startIndex] = impact;
  }

  const annualImpact = monthlyImpact.reduce((sum, val) => sum + val, 0);
  return { monthlyImpact, annualImpact };
}

/**
 * Calculate simulated cash flow given base data and selected proposals
 */
export function simulateCashFlow(
  baseCajaMonthly: number[],
  baseVariacionMonthly: number[],
  cajaInicial: number,
  selectedProposals: Proposal[],
): { simulatedCaja: number[]; simulatedVariacion: number[]; totalImpact: number[] } {
  const totalImpact: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

  for (const proposal of selectedProposals) {
    for (let m = 0; m < 12; m++) {
      totalImpact[m] += proposal.monthlyImpact[m] ?? 0;
    }
  }

  const simulatedVariacion: number[] = [];
  for (let m = 0; m < 12; m++) {
    simulatedVariacion[m] = (baseVariacionMonthly[m] ?? 0) + totalImpact[m];
  }

  const simulatedCaja: number[] = [];
  simulatedCaja[0] = cajaInicial + simulatedVariacion[0];
  for (let m = 1; m < 12; m++) {
    simulatedCaja[m] = simulatedCaja[m - 1] + simulatedVariacion[m];
  }

  return { simulatedCaja, simulatedVariacion, totalImpact };
}

/**
 * Format number as currency string.
 * Values are in millions (e.g. 253 = $253M MXN).
 */
export function formatCurrency(value: number): string {
  const sign = value < 0 ? '-' : '';
  const absValue = Math.abs(value);
  return `${sign}$${absValue.toFixed(2)} M`;
}
