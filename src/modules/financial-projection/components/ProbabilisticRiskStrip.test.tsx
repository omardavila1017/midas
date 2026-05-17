import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ProbabilisticForecastRun } from '../../shared-finance/types';
import { ProbabilisticRiskStrip } from './ProbabilisticRiskStrip';

describe('ProbabilisticRiskStrip', () => {
  it('renders statistical risk indicators when a probabilistic run exists', () => {
    render(<ProbabilisticRiskStrip run={run()} loading={false} error={null} />);

    expect(screen.getByText('Riesgo estadístico')).toBeTruthy();
    expect(screen.getByText('Prob. déficit')).toBeTruthy();
    expect(screen.getByText('Crédito P90')).toBeTruthy();
    expect(screen.getByText(/ARIMA/)).toBeTruthy();
  });
});

function run(): ProbabilisticForecastRun {
  return {
    id: 'prob-1',
    baseForecastId: 'forecast-1',
    scenarioId: 'base',
    granularity: 'daily',
    startDate: '2026-05-12',
    endDate: '2027-05-11',
    generatedAt: '2026-05-12T00:00:00.000Z',
    simulations: 1200,
    buckets: [],
    summary: {
      probabilityOfDeficit: 0.2,
      probabilityBelowMinimumCash: 0.35,
      expectedCreditRequired: 400_000,
      p90CreditRequired: 900_000,
      maxRiskDate: '2026-08-12',
      confidence: 'HIGH',
    },
    diagnostics: {
      modelKind: 'ARIMA',
      confidence: 'HIGH',
      sampleSize: 180,
      inflowVolatility: 0.1,
      outflowVolatility: 0.12,
      netResidualStd: 15_000,
      autocorrelation: 0.2,
    },
  };
}
