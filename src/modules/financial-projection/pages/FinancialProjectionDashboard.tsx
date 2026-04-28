import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, RotateCcw } from 'lucide-react';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import { fmtCompact } from '../../../formatters';
import {
  calculateBaseProjection,
  calculateScenarioProjection,
  compareProjectionVsScenario,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type { FinancialAdjustment, FinancialMovement, ProjectionGranularity } from '../../shared-finance/types';
import { ProjectionKpiCards } from '../components/ProjectionKpiCards';
import { CashFlowChart } from '../components/CashFlowChart';
import { ProjectionTable, type ProjectionTableFilters } from '../components/ProjectionTable';
import { MovementDrillDownDrawer } from '../components/MovementDrillDownDrawer';
import { CustomerCollectionPanel, SupplierRiskPanel, TaxPlanningPanel } from '../components/FinanceContextPanels';
import { buildFinancialProjectionSourceData, calculateInitialCash } from '../services/financialProjectionService';
import { AdjustmentEditorModal } from '../../financial-planning/components/AdjustmentEditorModal';
import {
  loadPlanningAdjustments,
  loadPlanningScenarios,
  savePlanningAdjustments,
} from '../../financial-planning/services/financialPlanningStorage';

interface Props {
  companyCode: string;
  bankStatements: BankAccountStatement[];
  clients: Client[];
  providers: Provider[];
  cxpRecords: CXPRecord[];
  assumptions: CashFlowAssumptions;
  budget: Budget | null;
  startingBalance: number;
}

const DEFAULT_FILTERS: ProjectionTableFilters = {
  search: '',
  type: 'ALL',
  category: 'ALL',
  status: 'ALL',
  confidence: 'ALL',
};

export default function FinancialProjectionDashboard(props: Props) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [granularity, setGranularity] = useState<ProjectionGranularity>('daily');
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(() => shift(today, 90));
  const [minimumCash, setMinimumCash] = useState(20_000_000);
  const [filters, setFilters] = useState<ProjectionTableFilters>(DEFAULT_FILTERS);
  const [selectedMovement, setSelectedMovement] = useState<FinancialMovement | null>(null);
  const [adjustmentMovement, setAdjustmentMovement] = useState<FinancialMovement | null>(null);

  const source = useMemo(
    () => buildFinancialProjectionSourceData({ ...props, asOfDate: today }),
    [props, today],
  );
  const [adjustments, setAdjustments] = useState<FinancialAdjustment[]>(() => loadPlanningAdjustments(source.adjustments));
  const scenarios = useMemo(() => loadPlanningScenarios(source.scenarios), [source.scenarios]);
  const baseScenario = scenarios.find((scenario) => scenario.isBase) ?? source.scenarios[0];
  const firstPlanningScenario = scenarios.find((scenario) => !scenario.isBase);

  useEffect(() => {
    savePlanningAdjustments(adjustments);
  }, [adjustments]);

  const baseProjection = useMemo(
    () => calculateBaseProjection(source.movements, {
      startDate,
      endDate,
      initialCash: calculateInitialCash(props.bankStatements, props.startingBalance),
      minimumCash,
      granularity,
      scenarioId: baseScenario.id,
      name: baseScenario.name,
    }),
    [baseScenario.id, baseScenario.name, endDate, granularity, minimumCash, props.bankStatements, props.startingBalance, source.movements, startDate],
  );

  const previewProjection = useMemo(() => {
    if (!firstPlanningScenario) return baseProjection;
    return calculateScenarioProjection(baseProjection, firstPlanningScenario, adjustments, { granularity });
  }, [adjustments, baseProjection, firstPlanningScenario, granularity]);

  const comparison = firstPlanningScenario
    ? compareProjectionVsScenario(baseProjection, previewProjection)
    : undefined;

  const tableMovements = useMemo(
    () => previewProjection.movements.filter((movement) => {
      const date = movement.actualDate ?? movement.adjustedDate ?? movement.projectedDate;
      return date >= startDate && date <= endDate;
    }),
    [endDate, previewProjection.movements, startDate],
  );

  const handleSaveAdjustment = (adjustment: FinancialAdjustment) => {
    setAdjustments((current) => [adjustment, ...current.filter((item) => item.id !== adjustment.id)]);
  };

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.05em] text-white/70">FP&A · Proyección</div>
          <h1 className="mt-1 text-[22px] font-semibold text-white">Proyección Financiera</h1>
          <p className="mt-1 max-w-[780px] text-[13px] text-white/75">
            Calcula lo que probablemente ocurrirá: base real, forecast automático, confianza y drill down. Los cambios manuales se registran como ajustes de escenario.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DateField label="Inicio" value={startDate} onChange={setStartDate} />
          <DateField label="Fin" value={endDate} onChange={setEndDate} />
          <label className="flex h-10 items-center gap-2 rounded-lg border border-white/15 bg-white/8 px-3 text-[12px] text-white">
            Mínimo
            <input
              type="number"
              value={minimumCash}
              onChange={(event) => setMinimumCash(Number(event.target.value) || 0)}
              className="h-7 w-[120px] rounded-md border border-white/15 bg-white px-2 text-right text-[12px] text-[var(--gray-950)]"
            />
          </label>
        </div>
      </header>

      <section className="rounded-xl border border-[var(--border)] bg-white p-3 shadow-[var(--shadow-card)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {(['daily', 'weekly', 'monthly'] as ProjectionGranularity[]).map((option) => (
              <button
                key={option}
                onClick={() => setGranularity(option)}
                className={`h-8 rounded-lg border px-3 text-[12px] font-medium ${granularity === option ? 'border-[var(--primary)] bg-[var(--primary)] text-white' : 'border-[var(--border)] bg-white text-[var(--gray-700)] hover:bg-[var(--surface-alt)]'}`}
              >
                {option === 'daily' ? 'Diaria' : option === 'weekly' ? 'Semanal' : 'Mensual'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 text-[12px] text-[var(--gray-500)]">
            <CalendarDays className="h-4 w-4" strokeWidth={1.5} />
            {previewProjection.buckets.length} buckets · ingresos {fmtCompact(previewProjection.summary.totalInflows)} · egresos {fmtCompact(previewProjection.summary.totalOutflows)}
          </div>
        </div>
      </section>

      <ProjectionKpiCards projection={previewProjection} comparison={comparison} />
      <CashFlowChart projection={previewProjection} baseProjection={previewProjection.scenarioId === baseProjection.scenarioId ? undefined : baseProjection} />

      <div className="grid gap-4 xl:grid-cols-3">
        <CustomerCollectionPanel customers={source.customers} />
        <SupplierRiskPanel suppliers={source.suppliers} />
        <TaxPlanningPanel taxes={source.taxes} />
      </div>

      <ProjectionTable
        movements={tableMovements}
        filters={filters}
        onFiltersChange={setFilters}
        onSelectMovement={setSelectedMovement}
        onAdjustMovement={setAdjustmentMovement}
      />

      <MovementDrillDownDrawer movement={selectedMovement} onClose={() => setSelectedMovement(null)} />
      <AdjustmentEditorModal
        movement={adjustmentMovement}
        scenarios={scenarios}
        defaultScenarioId={firstPlanningScenario?.id}
        onClose={() => setAdjustmentMovement(null)}
        onSave={handleSaveAdjustment}
      />

      <button
        onClick={() => {
          setFilters(DEFAULT_FILTERS);
          setGranularity('daily');
          setStartDate(today);
          setEndDate(shift(today, 90));
        }}
        className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/15 bg-white/8 px-3 text-[12px] font-medium text-white hover:bg-white/12"
      >
        <RotateCcw className="h-4 w-4" strokeWidth={1.5} />
        Restaurar vista
      </button>
    </div>
  );
}

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="flex h-10 items-center gap-2 rounded-lg border border-white/15 bg-white/8 px-3 text-[12px] text-white">
      {label}
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-7 rounded-md border border-white/15 bg-white px-2 text-[12px] text-[var(--gray-950)]"
      />
    </label>
  );
}

function shift(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}
