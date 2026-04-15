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
 * Calculate simulated cash flow given base data and selected proposals.
 * Uses baseCaja directly + cumulative impact so the simulated line always
 * equals baseCaja + accumulated proposal effects (no drift from rounding).
 */
export function simulateCashFlow(
  baseCajaMonthly: number[],
  baseVariacionMonthly: number[],
  cajaInicial: number,
  selectedProposals: Proposal[],
): {
  simulatedCaja: number[];
  simulatedVariacion: number[];
  totalImpact: number[];
  cumulativeImpact: number[];
} {
  const totalImpact: number[] = Array(12).fill(0);

  for (const proposal of selectedProposals) {
    if (!proposal.monthlyImpact) continue;
    for (let m = 0; m < 12; m++) {
      totalImpact[m] += proposal.monthlyImpact[m] ?? 0;
    }
  }

  // Cumulative impact — each month's benefit carries forward
  const cumulativeImpact: number[] = [];
  cumulativeImpact[0] = totalImpact[0];
  for (let m = 1; m < 12; m++) {
    cumulativeImpact[m] = cumulativeImpact[m - 1] + totalImpact[m];
  }

  const simulatedVariacion: number[] = [];
  const simulatedCaja: number[] = [];
  for (let m = 0; m < 12; m++) {
    simulatedVariacion[m] = (baseVariacionMonthly[m] ?? 0) + totalImpact[m];
    simulatedCaja[m] = (baseCajaMonthly[m] ?? 0) + cumulativeImpact[m];
  }

  return { simulatedCaja, simulatedVariacion, totalImpact, cumulativeImpact };
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
