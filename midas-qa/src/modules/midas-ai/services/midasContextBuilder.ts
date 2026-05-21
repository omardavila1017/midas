import type { Provider } from '../../../domain/types';
import type {
  FinancialAdjustment,
  FinancialMovement,
  ForecastRun,
} from '../../shared-finance/types';
import type { MidasContext, MidasSupplierContext } from '../types';

const MAX_UPCOMING_MOVEMENTS = 60;
const MAX_SUPPLIERS = 50;

export interface BuildMidasContextInput {
  cia: string;
  asOfDate: string;
  activeRun: ForecastRun;
  providers: Provider[];
  adjustments: FinancialAdjustment[];
  activeScenarioId: string;
  activeScenarioKind: string;
}

export function buildMidasContext(input: BuildMidasContextInput): MidasContext {
  const upcoming = input.activeRun.movements
    .filter((m) => (m.adjustedDate ?? m.projectedDate) >= input.asOfDate)
    .sort((a, b) => (a.adjustedDate ?? a.projectedDate).localeCompare(b.adjustedDate ?? b.projectedDate))
    .slice(0, MAX_UPCOMING_MOVEMENTS)
    .map((m) => ({
      id: m.id,
      concept: m.concept,
      type: m.type,
      category: m.category,
      projectedAmount: m.adjustedAmount ?? m.projectedAmount,
      projectedDate: m.adjustedDate ?? m.projectedDate,
      counterpartyName: m.counterpartyName,
      counterpartyId: m.counterpartyId,
    }));

  const suppliers = buildSuppliers(input.providers, input.activeRun.movements);

  return {
    cia: input.cia,
    asOfDate: input.asOfDate,
    forecastSummary: input.activeRun.summary,
    upcomingMovements: upcoming,
    suppliers,
    existingAdjustmentsCount: input.adjustments.filter((a) => a.scenarioIds.includes(input.activeScenarioId)).length,
    activeScenarioId: input.activeScenarioId,
    activeScenarioKind: input.activeScenarioKind,
  };
}

function buildSuppliers(providers: Provider[], movements: FinancialMovement[]): MidasSupplierContext[] {
  const pendingByProvider = new Map<string, number>();
  for (const m of movements) {
    if (m.type !== 'OUTFLOW') continue;
    const id = m.counterpartyId ?? m.counterpartyName;
    if (!id) continue;
    pendingByProvider.set(id, (pendingByProvider.get(id) ?? 0) + Math.abs(m.adjustedAmount ?? m.projectedAmount));
  }

  return providers
    .map<MidasSupplierContext>((p) => ({
      id: p.id,
      name: p.name,
      risk: p.clasificacionAlberto ?? p.clasificacionAutomatica ?? p.risk ?? 'SIN_CLASIFICAR',
      flexibility: p.flexibility ?? 'sin_clasificar',
      pendingAmount: pendingByProvider.get(p.id) ?? pendingByProvider.get(p.name) ?? 0,
    }))
    .filter((s) => s.pendingAmount > 0)
    .sort((a, b) => b.pendingAmount - a.pendingAmount)
    .slice(0, MAX_SUPPLIERS);
}
