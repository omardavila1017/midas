import { useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { hex } from '../theme';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Columns2,
  FlaskConical,
} from 'lucide-react';
import {
  BASE_SCENARIO_ID,
  BASE_SCENARIO_NAME,
  CATEGORY_COLORS,
  FlowPlan,
  ForecastGranularity,
  Proposal,
  Scenario,
  ScenarioCellOverride,
  Simulation,
} from '../types';
import {
  compareScenarioEvaluations,
  evaluateScenario,
  resolveConceptLabel,
} from '../domain/scenarioEngine';
import { isBaseScenario } from '../domain/simulationCompiler';
import { formatCompactNumber, formatCurrency } from '../utils/calculations';

interface SimulatorProps {
  plan: FlowPlan;
  proposals: Proposal[];
  scenarios: Scenario[];
  simulations: Simulation[];
  overrides: ScenarioCellOverride[];
  activeProposalId: string | null;
  activeScenarioId: string | null;
  granularity?: ForecastGranularity;
  onGranularityChange?: (granularity: ForecastGranularity) => void;
  onSelectProposal: (proposalId: string) => void;
  onSelectScenario: (scenarioId: string | null) => void;
  onUpdateScenario: (scenario: Scenario) => void;
}

const KPI_CONFIG = [
  { key: 'ingresos12m', label: 'Ingresos 12m', color: 'text-[var(--primary)]' },
  { key: 'egresos12m', label: 'Egresos 12m', color: 'text-[var(--danger)]' },
  { key: 'flujoNeto12m', label: 'Flujo Neto', color: 'text-[var(--success)]' },
  { key: 'cajaFinal', label: 'Caja Final', color: 'text-[var(--gray-950)]' },
  { key: 'cajaMinima', label: 'Caja Mínima', color: 'text-[var(--chart-4)]' },
  { key: 'cobranza12m', label: 'Cobranza', color: 'text-[var(--primary)]' },
  { key: 'pagosProveedores12m', label: 'Pagos Proveedores', color: 'text-[var(--warning)]' },
] as const;

const VIRTUAL_BASE_PROPOSAL: Proposal = {
  id: 'proposal-base',
  name: BASE_SCENARIO_NAME,
  description: 'Pronóstico original',
  status: 'Pendiente',
  createdAt: '',
  updatedAt: '',
};

export default function Simulator({
  plan,
  proposals,
  scenarios,
  simulations,
  overrides,
  activeProposalId,
  activeScenarioId,
  granularity = 'monthly',
  onGranularityChange,
  onSelectProposal,
  onSelectScenario,
  onUpdateScenario,
}: SimulatorProps) {
  const [simulationSearch, setSimulationSearch] = useState('');
  const [compareScenarioIds, setCompareScenarioIds] = useState<string[]>([]);
  const [treeOpen, setTreeOpen] = useState<Set<string>>(() => new Set(proposals.map((proposal) => proposal.id)));
  const baseScenario = scenarios.find((scenario) => isBaseScenario(scenario)) ?? null;

  const activeProposal = proposals.find((proposal) => proposal.id === activeProposalId) ?? proposals[0] ?? null;
  const activeScenario = scenarios.find((scenario) => scenario.id === activeScenarioId)
    ?? scenarios.find((scenario) => scenario.proposalId === activeProposal?.id)
    ?? baseScenario
    ?? null;
  const effectiveProposal = isBaseScenario(activeScenario) ? VIRTUAL_BASE_PROPOSAL : (activeProposal ?? VIRTUAL_BASE_PROPOSAL);

  const activeEvaluation = useMemo(() => {
    if (!activeScenario) return null;
    return evaluateScenario(
      plan,
      effectiveProposal,
      activeScenario,
      isBaseScenario(activeScenario) ? [] : simulations,
      isBaseScenario(activeScenario) ? [] : overrides,
      { granularity },
    );
  }, [activeScenario, effectiveProposal, granularity, overrides, plan, simulations]);

  const baseEvaluation = useMemo(() => {
    if (!activeScenario) return null;
    return evaluateScenario(plan, effectiveProposal, activeScenario, [], [], { granularity });
  }, [activeScenario, effectiveProposal, granularity, plan]);

  const filteredSimulations = useMemo(() => {
    const query = simulationSearch.trim().toLowerCase();
    if (!query) return simulations;
    return simulations.filter((simulation) =>
      simulation.name.toLowerCase().includes(query) ||
      simulation.description.toLowerCase().includes(query),
    );
  }, [simulationSearch, simulations]);

  const assignedSimulationIds = new Set(activeScenario?.simulationIds ?? []);
  const chartData = useMemo(() => {
    if (!activeEvaluation || !baseEvaluation) return [];
    return activeEvaluation.months.map((month, index) => ({
      month: month.label,
      base: baseEvaluation.metrics.cajaFinal[index] ?? 0,
      escenario: activeEvaluation.metrics.cajaFinal[index] ?? 0,
      diff: (activeEvaluation.metrics.cajaFinal[index] ?? 0) - (baseEvaluation.metrics.cajaFinal[index] ?? 0),
    }));
  }, [activeEvaluation, baseEvaluation]);

  const metricRows = useMemo(() => {
    if (!activeEvaluation || !baseEvaluation) return [];
    return activeEvaluation.months.map((month, index) => ({
      month: month.label,
      ingresos: activeEvaluation.metrics.ingresos[index] ?? 0,
      egresos: activeEvaluation.metrics.egresos[index] ?? 0,
      flujoNeto: activeEvaluation.metrics.flujoNeto[index] ?? 0,
      cajaFinal: activeEvaluation.metrics.cajaFinal[index] ?? 0,
      cobranza: activeEvaluation.metrics.cobranza[index] ?? 0,
      pagosProveedores: activeEvaluation.metrics.pagosProveedores[index] ?? 0,
      deltaCaja: (activeEvaluation.metrics.cajaFinal[index] ?? 0) - (baseEvaluation.metrics.cajaFinal[index] ?? 0),
    }));
  }, [activeEvaluation, baseEvaluation]);

  const compareEvaluations = useMemo(() => {
    if (!activeEvaluation) return [];
    return compareScenarioIds
      .map((scenarioId) => {
        const scenario = scenarios.find((candidate) => candidate.id === scenarioId);
        if (!scenario) return null;
        const proposal = proposals.find((candidate) => candidate.id === scenario.proposalId)
          ?? VIRTUAL_BASE_PROPOSAL;
        const evaluation = evaluateScenario(plan, proposal, scenario, simulations, overrides, { granularity });
        const diff = compareScenarioEvaluations(evaluation, activeEvaluation);
        return { proposal, scenario, evaluation, diff };
      })
      .filter(Boolean) as Array<{
        proposal: Proposal;
        scenario: Scenario;
        evaluation: NonNullable<typeof activeEvaluation>;
        diff: ReturnType<typeof compareScenarioEvaluations>;
      }>;
  }, [activeEvaluation, compareScenarioIds, granularity, overrides, plan, proposals, scenarios, simulations]);

  const toggleSimulationAssignment = (simulationId: string) => {
    if (!activeScenario || isBaseScenario(activeScenario)) return;
    const exists = assignedSimulationIds.has(simulationId);
    onUpdateScenario({
      ...activeScenario,
      simulationIds: exists
        ? activeScenario.simulationIds.filter((id) => id !== simulationId)
        : [...activeScenario.simulationIds, simulationId],
      updatedAt: new Date().toISOString(),
    });
  };

  const toggleCompareScenario = (scenarioId: string) => {
    setCompareScenarioIds((current) => {
      if (current.includes(scenarioId)) {
        return current.filter((item) => item !== scenarioId);
      }
      if (current.length >= 2) return current;
      return [...current, scenarioId];
    });
  };

  const toggleTree = (proposalId: string) => {
    setTreeOpen((current) => {
      const next = new Set(current);
      if (next.has(proposalId)) next.delete(proposalId);
      else next.add(proposalId);
      return next;
    });
  };

  if (!activeScenario || !activeEvaluation || !baseEvaluation) {
    return (
      <div className="rounded-2xl border border-dashed border-[var(--gray-200)] bg-white px-6 py-20 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--gray-50)]">
          <FlaskConical className="w-5 h-5 text-[var(--gray-400)]" />
        </div>
        <h2 className="text-[18px] font-semibold text-[var(--gray-950)]">No hay escenario activo</h2>
        <p className="mt-2 text-[13px] text-[var(--gray-400)]">
          Crea una simulación y al menos un escenario en la pestaña de Propuestas.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[280px,minmax(0,1fr),360px] gap-5 min-h-[calc(100vh-180px)]">
      <aside className="rounded-2xl border border-[var(--gray-200)]/50 bg-white p-4 shadow-sm space-y-3">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Árbol de trabajo</p>
          <h2 className="mt-1 text-[16px] font-semibold text-[var(--gray-950)]">Simulaciones y escenarios</h2>
        </div>
        <div className="space-y-2">
          {baseScenario && (
            <button
              onClick={() => onSelectScenario(baseScenario.id)}
              className={`w-full rounded-xl border px-3 py-3 text-left transition ${
                activeScenario.id === baseScenario.id
                  ? 'border-[var(--card-foreground)] bg-[var(--card-foreground)] text-white'
                  : 'border-[var(--gray-200)]/50 bg-[var(--surface-alt)] hover:bg-white'
              }`}
            >
              <p className="text-[13px] font-semibold">{BASE_SCENARIO_NAME}</p>
              <p className={`mt-1 text-[11px] ${activeScenario.id === baseScenario.id ? 'text-white/75' : 'text-[var(--gray-400)]'}`}>
                Pronóstico original siempre visible y sin cambios.
              </p>
            </button>
          )}
          {proposals.map((proposal) => {
            const isOpen = treeOpen.has(proposal.id);
            const proposalScenarios = scenarios.filter((scenario) => scenario.proposalId === proposal.id);
            return (
              <div key={proposal.id} className="rounded-xl border border-[var(--gray-200)]/50 bg-[var(--surface-alt)]">
                <button
                  onClick={() => {
                    toggleTree(proposal.id);
                    onSelectProposal(proposal.id);
                  }}
                  className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left"
                >
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-[var(--gray-950)] truncate">{proposal.name}</p>
                    <p className="text-[11px] text-[var(--gray-400)]">{proposalScenarios.length} escenarios</p>
                  </div>
                  {isOpen ? (
                    <ChevronDown className="w-4 h-4 text-[var(--gray-400)]" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-[var(--gray-400)]" />
                  )}
                </button>
                {isOpen && (
                  <div className="border-t border-[var(--gray-200)]/40 px-2 py-2 space-y-1">
                    {proposalScenarios.map((scenario) => {
                      const isActive = scenario.id === activeScenario.id;
                      return (
                        <button
                          key={scenario.id}
                          onClick={() => {
                            onSelectProposal(proposal.id);
                            onSelectScenario(scenario.id);
                          }}
                          className={`w-full rounded-lg px-3 py-2 text-left transition ${
                            isActive
                              ? 'bg-[var(--success-muted)] text-[var(--success)]'
                              : 'text-[var(--gray-500)] hover:bg-white hover:text-[var(--gray-950)]'
                          }`}
                        >
                          <p className="text-[12px] font-medium">{scenario.name}</p>
                          <p className="text-[10px]">{scenario.simulationIds.length} propuestas</p>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      <main className="space-y-5">
        <header className="rounded-2xl border border-[var(--gray-200)]/50 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-6">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Workbench activo</p>
              <h1 className="mt-1 text-[24px] font-semibold text-[var(--gray-950)]">{activeScenario.name}</h1>
              <p className="mt-1 text-[13px] text-[var(--gray-400)]">
                {isBaseScenario(activeScenario)
                  ? 'Pronóstico original sin propuestas aplicadas.'
                  : `Simulación ${effectiveProposal.name} · ${Math.round(activeScenario.probability * 100)}% probabilidad · ${activeScenario.horizonMonths} meses`}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-between rounded-xl border border-[var(--gray-200)] bg-[var(--surface-alt)] p-1">
                {(['monthly', 'weekly', 'daily'] as ForecastGranularity[]).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => onGranularityChange?.(mode)}
                    className={`rounded-lg px-3 py-1.5 text-[12px] font-medium transition ${
                      granularity === mode
                        ? 'bg-white text-[var(--gray-950)] shadow-sm'
                        : 'text-[var(--gray-500)]'
                    }`}
                  >
                    {mode === 'monthly' ? 'Mes' : mode === 'weekly' ? 'Semana' : 'Día'}
                  </button>
                ))}
              </div>
              <div className="rounded-xl bg-[var(--gray-50)] px-3 py-2 text-right">
                <p className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Cambios detectados</p>
                <p className="mt-1 text-[20px] font-semibold text-[var(--gray-950)]">{activeEvaluation.changedKeys.size}</p>
              </div>
            </div>
          </div>
        </header>

        <div className="grid grid-cols-4 gap-4">
          {KPI_CONFIG.map((kpi) => (
            <div key={kpi.key} className="rounded-2xl border border-[var(--gray-200)]/50 bg-white p-4 shadow-sm">
              <p className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">{kpi.label}</p>
              <p className={`mt-2 text-[22px] font-semibold ${kpi.color}`}>
                {formatCurrency(activeEvaluation.kpis[kpi.key])}
              </p>
              <p className="mt-1 text-[11px] text-[var(--gray-400)]">
                Base: {formatCurrency(baseEvaluation.kpis[kpi.key])}
              </p>
            </div>
          ))}
        </div>

        <section className="rounded-2xl border border-[var(--gray-200)]/50 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">Caja base vs escenario</h2>
              <p className="text-[12px] text-[var(--gray-400)]">
                Cada cambio en propuestas y celdas recalcula el flujo completo en vista {granularity === 'monthly' ? 'mensual' : granularity === 'weekly' ? 'semanal' : 'diaria'}.
              </p>
            </div>
            <div className="rounded-full bg-[var(--gray-50)] px-3 py-1 text-[12px] text-[var(--gray-500)]">
              {isBaseScenario(activeScenario) ? 'Escenario fijo' : `${activeScenario.simulationIds.length} propuestas activas`}
            </div>
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={chartData}>
              <defs />
              <CartesianGrid stroke="var(--gray-100)" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: 'var(--gray-400)', fontSize: 11 }} tickLine={false} axisLine={{ stroke: 'var(--gray-100)' }} minTickGap={24} />
              <YAxis tick={{ fill: 'var(--gray-400)', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(value) => formatCompactNumber(value)} />
              <Tooltip
                formatter={(value: number) => formatCurrency(value)}
                contentStyle={{ borderRadius: 16, borderColor: 'var(--gray-200)' }}
              />
              <Area type="monotone" dataKey="base" stroke="var(--gray-300)" strokeWidth={1.5} fill="none" name="Base" />
              <Area type="monotone" dataKey="escenario" stroke="var(--primary)" strokeWidth={1.5} fill="none" name="Escenario" />
            </AreaChart>
          </ResponsiveContainer>
        </section>

        <section className="rounded-2xl border border-[var(--gray-200)]/50 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">Detalle del flujo</h2>
              <p className="text-[12px] text-[var(--gray-400)]">
                Impacto unificado en ingresos, egresos, cobranza, pagos y saldos finales por {granularity === 'monthly' ? 'mes' : granularity === 'weekly' ? 'semana' : 'día'}.
              </p>
            </div>
            <div className="inline-flex items-center gap-2 rounded-full bg-[var(--gray-50)] px-3 py-1 text-[12px] text-[var(--gray-500)]">
              <Columns2 className="w-3.5 h-3.5" />
              {activeEvaluation.months.length} columnas
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-[12px]">
              <thead>
                <tr className="border-b border-[var(--gray-100)] bg-[var(--surface-alt)]">
                  <th className="sticky left-0 min-w-[170px] bg-[var(--surface-alt)] px-4 py-2.5 text-left font-medium text-[var(--gray-400)]">Métrica</th>
                  {metricRows.map((row) => (
                    <th key={row.month} className="px-2 py-2.5 text-right font-medium text-[var(--gray-400)]">{row.month}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <MetricTableRow label="Ingresos" values={metricRows.map((row) => row.ingresos)} tone="pos" />
                <MetricTableRow label="Egresos" values={metricRows.map((row) => row.egresos)} tone="neg" />
                <MetricTableRow label="Flujo Neto" values={metricRows.map((row) => row.flujoNeto)} tone="neutral" />
                <MetricTableRow label="Cobranza" values={metricRows.map((row) => row.cobranza)} tone="pos" />
                <MetricTableRow label="Pagos Proveedores" values={metricRows.map((row) => row.pagosProveedores)} tone="neg" />
                <MetricTableRow label="Caja Final" values={metricRows.map((row) => row.cajaFinal)} tone="emphasis" />
                <MetricTableRow label="Δ Caja vs Base" values={metricRows.map((row) => row.deltaCaja)} tone="diff" />
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-2xl border border-[var(--gray-200)]/50 bg-white p-5 shadow-sm space-y-4">
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">Comparar escenarios</h2>
            <p className="text-[12px] text-[var(--gray-400)]">Selecciona hasta 2 escenarios adicionales para ver cuál mejora más el resultado financiero.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {scenarios
              .filter((scenario) => scenario.id !== activeScenario.id)
              .map((scenario) => {
                const proposal = proposals.find((item) => item.id === scenario.proposalId);
                const selected = compareScenarioIds.includes(scenario.id);
                return (
                  <button
                    key={scenario.id}
                    onClick={() => toggleCompareScenario(scenario.id)}
                    className={`rounded-xl border px-3 py-3 text-left transition ${
                      selected
                        ? 'border-[var(--primary)] bg-[var(--primary-muted)]'
                        : 'border-[var(--gray-200)]/50 bg-[var(--surface-alt)]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-[13px] font-semibold text-[var(--gray-950)]">{scenario.name}</p>
                        <p className="text-[11px] text-[var(--gray-400)]">{proposal?.name ?? BASE_SCENARIO_NAME}</p>
                      </div>
                      <span className={`flex h-5 w-5 items-center justify-center rounded-md border ${
                        selected ? 'border-[var(--primary)] bg-[var(--primary)] text-white' : 'border-[var(--gray-200)]'
                      }`}>
                        <Check className="w-3.5 h-3.5" />
                      </span>
                    </div>
                  </button>
                );
              })}
          </div>

          {compareEvaluations.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-[12px]">
                <thead>
                  <tr className="border-b border-[var(--gray-100)] bg-[var(--surface-alt)]">
                    <th className="px-4 py-2.5 text-left font-medium text-[var(--gray-400)]">KPI</th>
                    <th className="px-4 py-2.5 text-right font-medium text-[var(--gray-400)]">{activeScenario.name}</th>
                    {compareEvaluations.map(({ scenario }) => (
                      <th key={scenario.id} className="px-4 py-2.5 text-right font-medium text-[var(--gray-400)]">
                        {scenario.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {KPI_CONFIG.map((kpi) => (
                    <tr key={kpi.key} className="border-b border-[var(--gray-50)]">
                      <td className="px-4 py-3 font-medium text-[var(--gray-950)]">{kpi.label}</td>
                      <td className="px-4 py-3 text-right font-mono text-[var(--gray-950)]">
                        {formatCurrency(activeEvaluation.kpis[kpi.key])}
                      </td>
                      {compareEvaluations.map(({ scenario, evaluation, diff }) => (
                        <td key={scenario.id} className="px-4 py-3 text-right font-mono">
                          <div className="text-[var(--gray-950)]">{formatCurrency(evaluation.kpis[kpi.key])}</div>
                          <div className={(diff.kpiDiff[kpi.key] ?? 0) >= 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]'}>
                            {(diff.kpiDiff[kpi.key] ?? 0) >= 0 ? '+' : ''}{formatCurrency(diff.kpiDiff[kpi.key] ?? 0)}
                          </div>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      <aside className="rounded-2xl border border-[var(--gray-200)]/50 bg-white p-4 shadow-sm space-y-3">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Biblioteca</p>
          <h2 className="mt-1 text-[16px] font-semibold text-[var(--gray-950)]">Propuestas activables</h2>
        </div>
        <input
          value={simulationSearch}
          onChange={(event) => setSimulationSearch(event.target.value)}
          placeholder="Buscar propuesta..."
          className="w-full rounded-xl border border-[var(--gray-200)] bg-[var(--surface-alt)] px-3 py-2.5 text-[13px]"
        />
        <div className="space-y-2 max-h-[calc(100vh-260px)] overflow-y-auto pr-1">
          {filteredSimulations.map((simulation) => {
            const assigned = assignedSimulationIds.has(simulation.id);
            const effect = simulation.effects[0];
            return (
              <button
                key={simulation.id}
                onClick={() => toggleSimulationAssignment(simulation.id)}
                className={`w-full rounded-xl border px-3 py-3 text-left transition ${
                  assigned
                    ? 'border-[var(--primary)] bg-[var(--primary-muted)]'
                    : 'border-[var(--gray-200)]/50 bg-[var(--surface-alt)] hover:bg-white'
                }`}
                disabled={isBaseScenario(activeScenario)}
              >
                <div className="flex items-start gap-3">
                  <span className={`mt-0.5 flex h-5 w-5 items-center justify-center rounded-md border ${
                    assigned ? 'border-[var(--primary)] bg-[var(--primary)] text-white' : 'border-[var(--gray-200)] bg-white text-transparent'
                  }`}>
                    <Check className="w-3.5 h-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <div
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: CATEGORY_COLORS[simulation.category] }}
                      />
                      <p className="truncate text-[13px] font-semibold text-[var(--gray-950)]">{simulation.name}</p>
                    </div>
                    <p className="mt-1 text-[11px] text-[var(--gray-400)] line-clamp-2">{simulation.description || 'Sin descripción'}</p>
                    <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-[var(--gray-500)]">
                      <span className="rounded-full border border-[var(--gray-200)]/60 bg-white px-2 py-0.5">{simulation.category}</span>
                      {effect && (
                        <>
                          <span className="rounded-full border border-[var(--gray-200)]/60 bg-white px-2 py-0.5">
                            {resolveConceptLabel(plan, effect.conceptId)}
                          </span>
                          <span className="rounded-full border border-[var(--gray-200)]/60 bg-white px-2 py-0.5">
                            {effect.mode === 'percent' ? `${(effect.value * 100).toFixed(0)}%` : effect.value}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </aside>
    </div>
  );
}

function MetricTableRow({
  label,
  values,
  tone,
}: {
  label: string;
  values: number[];
  tone: 'pos' | 'neg' | 'neutral' | 'emphasis' | 'diff';
}) {
  const colorClass =
    tone === 'pos' ? 'text-[var(--success)]' :
    tone === 'neg' ? 'text-[var(--danger)]' :
    tone === 'emphasis' ? 'text-[var(--gray-950)] font-semibold' :
    tone === 'diff' ? 'text-[var(--primary)]' :
    'text-[var(--gray-500)]';

  return (
    <tr className="border-b border-[var(--gray-50)]">
      <td className="sticky left-0 bg-white px-4 py-3 font-medium text-[var(--gray-950)]">{label}</td>
      {values.map((value, index) => (
        <td key={`${label}-${index}`} className={`px-2 py-3 text-right font-mono ${colorClass}`}>
          {tone === 'diff' && value > 0 ? '+' : ''}{formatCurrency(value)}
        </td>
      ))}
    </tr>
  );
}
