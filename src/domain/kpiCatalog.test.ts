import { describe, expect, it } from 'vitest';
import { buildKpiCatalog, type KpiConfigOverride } from './kpiCatalog';
import { createTestPlan, createTestProposal, createTestScenario } from '../test/fixtures';

function buildInput(overrides: Partial<Parameters<typeof buildKpiCatalog>[0]> = {}): Parameters<typeof buildKpiCatalog>[0] {
  const proposal = createTestProposal();
  const scenario = createTestScenario({ simulationIds: [] });
  return {
    clients: [],
    assumptions: {
      year: 2026,
      globalCompliance: 1,
      factorajeDays: 30,
    },
    confirmedPayments: [],
    cxpRecords: [],
    bankStatements: [],
    plan: createTestPlan(),
    proposals: [proposal],
    scenarios: [scenario],
    simulations: [],
    overrides: [],
    activeProposalId: proposal.id,
    activeScenarioId: scenario.id,
    activeMonth: 0,
    customKpis: [],
    kpiConfigs: [],
    ...overrides,
  };
}

describe('kpiCatalog', () => {
  it('keeps projected cash-flow KPIs available even when collection data is missing', () => {
    const entries = buildKpiCatalog(buildInput());

    expect(entries.find((entry) => entry.id === 'cash_net_flow_projected')?.available).toBe(true);
    expect(entries.find((entry) => entry.id === 'cash_projected_ending_balance')?.available).toBe(true);
    expect(entries.find((entry) => entry.id === 'cash_collection_target')?.available).toBe(false);
  });

  it('applies persisted target, owner and semaphore configuration to managed KPIs', () => {
    const kpiConfigs: KpiConfigOverride[] = [
      {
        kpiId: 'cash_net_flow_projected',
        targetValue: 50,
        targetSource: 'manual',
        targetOwner: 'user',
        goal: 'lower',
        warningThreshold: 70,
        notes: 'Control manual de flujo.',
        updatedAt: '2026-01-15T00:00:00.000Z',
        history: [],
      },
    ];

    const entry = buildKpiCatalog(buildInput({ kpiConfigs }))
      .find((item) => item.id === 'cash_net_flow_projected');

    expect(entry?.targetValue).toBe(50);
    expect(entry?.targetOwner).toBe('user');
    expect(entry?.goal).toBe('lower');
    expect(entry?.status).toBe('warning');
    expect(entry?.manualNotes).toBe('Control manual de flujo.');
  });
});
