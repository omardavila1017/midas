import { useMemo, useState } from 'react';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
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
  Minus,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import {
  BASE_SCENARIO_ID,
  BASE_SCENARIO_NAME,
  CATEGORY_COLORS,
  FlowPlan,
  ForecastGranularity,
  Simulation,
  Scenario,
  ScenarioCellOverride,
  Proposal,
} from '../types';
import {
  compareScenarioEvaluations,
  evaluateScenario,
  resolveConceptLabel,
} from '../domain/scenarioEngine';
import { isBaseScenario } from '../domain/proposalCompiler';
import { formatCompactNumber, formatCurrency } from '../utils/calculations';

interface SimulatorProps {
  plan: FlowPlan;
  simulations: Simulation[];
  scenarios: Scenario[];
  proposals: Proposal[];
  overrides: ScenarioCellOverride[];
  activeSimulationId: string | null;
  activeScenarioId: string | null;
  granularity?: ForecastGranularity;
  onGranularityChange?: (granularity: ForecastGranularity) => void;
  onSelectSimulation: (simulationId: string) => void;
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

const DELTA_KPIS = [
  { key: 'flujoNeto12m', label: 'Flujo Neto 12m', betterIs: 'higher' as const },
  { key: 'cajaFinal', label: 'Caja Final', betterIs: 'higher' as const },
  { key: 'ingresos12m', label: 'Ingresos 12m', betterIs: 'higher' as const },
  { key: 'egresos12m', label: 'Egresos 12m', betterIs: 'lower' as const },
] as const;

const VIRTUAL_BASE_PROPOSAL: Simulation = {
  id: 'simulation-base',
  name: BASE_SCENARIO_NAME,
  description: 'Pronóstico original',
  status: 'Pendiente',
  createdAt: '',
  updatedAt: '',
};

export default function Simulator({
  plan,
  simulations,
  scenarios,
  proposals,
  overrides,
  activeSimulationId,
  activeScenarioId,
  granularity = 'monthly',
  onGranularityChange,
  onSelectSimulation,
  onSelectScenario,
  onUpdateScenario,
}: SimulatorProps) {
  const [proposalSearch, setProposalSearch] = useState('');
  const [compareScenarioIds, setCompareScenarioIds] = useState<string[]>([]);
  const [treeOpen, setTreeOpen] = useState<Set<string>>(() => new Set(simulations.map((simulation) => simulation.id)));
  const baseScenario = scenarios.find((scenario) => isBaseScenario(scenario)) ?? null;

  const activeSimulation = simulations.find((simulation) => simulation.id === activeSimulationId) ?? simulations[0] ?? null;
  const activeScenario = scenarios.find((scenario) => scenario.id === activeScenarioId)
    ?? scenarios.find((scenario) => scenario.simulationId === activeSimulation?.id)
    ?? baseScenario
    ?? null;
  const effectiveSimulation = isBaseScenario(activeScenario) ? VIRTUAL_BASE_PROPOSAL : (activeSimulation ?? VIRTUAL_BASE_PROPOSAL);

  const activeEvaluation = useMemo(() => {
    if (!activeScenario) return null;
    return evaluateScenario(
      plan,
      effectiveSimulation,
      activeScenario,
      isBaseScenario(activeScenario) ? [] : proposals,
      isBaseScenario(activeScenario) ? [] : overrides,
      { granularity },
    );
  }, [activeScenario, effectiveSimulation, granularity, overrides, plan, proposals]);

  const baseEvaluation = useMemo(() => {
    if (!activeScenario) return null;
    return evaluateScenario(plan, effectiveSimulation, activeScenario, [], [], { granularity });
  }, [activeScenario, effectiveSimulation, granularity, plan]);

  const filteredProposals = useMemo(() => {
    const query = proposalSearch.trim().toLowerCase();
    if (!query) return proposals;
    return proposals.filter((proposal) =>
      proposal.name.toLowerCase().includes(query) ||
      proposal.description.toLowerCase().includes(query),
    );
  }, [proposalSearch, proposals]);

  const assignedProposalIds = new Set(activeScenario?.proposalIds ?? []);
  const chartData = useMemo(() => {
    if (!activeEvaluation || !baseEvaluation) return [];
    return activeEvaluation.months.map((month, index) => {
      const base = baseEvaluation.metrics.cajaFinal[index] ?? 0;
      const escenario = activeEvaluation.metrics.cajaFinal[index] ?? 0;
      const diff = escenario - base;
      const lower = Math.min(base, escenario);
      const absDiff = Math.abs(diff);
      return {
        month: month.label,
        base,
        escenario,
        diff,
        lower,
        gainBand: diff > 0 ? absDiff : 0,
        lossBand: diff < 0 ? absDiff : 0,
      };
    });
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
        const simulation = simulations.find((candidate) => candidate.id === scenario.simulationId)
          ?? VIRTUAL_BASE_PROPOSAL;
        const evaluation = evaluateScenario(plan, simulation, scenario, proposals, overrides, { granularity });
        const diff = compareScenarioEvaluations(evaluation, activeEvaluation);
        return { simulation, scenario, evaluation, diff };
      })
      .filter(Boolean) as Array<{
        simulation: Simulation;
        scenario: Scenario;
        evaluation: NonNullable<typeof activeEvaluation>;
        diff: ReturnType<typeof compareScenarioEvaluations>;
      }>;
  }, [activeEvaluation, compareScenarioIds, granularity, overrides, plan, simulations, scenarios, proposals]);

  const toggleProposalAssignment = (proposalId: string) => {
    if (!activeScenario || isBaseScenario(activeScenario)) return;
    const exists = assignedProposalIds.has(proposalId);
    onUpdateScenario({
      ...activeScenario,
      proposalIds: exists
        ? activeScenario.proposalIds.filter((id) => id !== proposalId)
        : [...activeScenario.proposalIds, proposalId],
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

  const toggleTree = (simulationId: string) => {
    setTreeOpen((current) => {
      const next = new Set(current);
      if (next.has(simulationId)) next.delete(simulationId);
      else next.add(simulationId);
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
          {simulations.map((simulation) => {
            const isOpen = treeOpen.has(simulation.id);
            const simulationScenarios = scenarios.filter((scenario) => scenario.simulationId === simulation.id);
            return (
              <div key={simulation.id} className="rounded-xl border border-[var(--gray-200)]/50 bg-[var(--surface-alt)]">
                <button
                  onClick={() => {
                    toggleTree(simulation.id);
                    onSelectSimulation(simulation.id);
                  }}
                  className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left"
                >
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-[var(--gray-950)] truncate">{simulation.name}</p>
                    <p className="text-[11px] text-[var(--gray-400)]">{simulationScenarios.length} escenarios</p>
                  </div>
                  {isOpen ? (
                    <ChevronDown className="w-4 h-4 text-[var(--gray-400)]" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-[var(--gray-400)]" />
                  )}
                </button>
                {isOpen && (
                  <div className="border-t border-[var(--gray-200)]/40 px-2 py-2 space-y-1">
                    {simulationScenarios.map((scenario) => {
                      const isActive = scenario.id === activeScenario.id;
                      return (
                        <button
                          key={scenario.id}
                          onClick={() => {
                            onSelectSimulation(simulation.id);
                            onSelectScenario(scenario.id);
                          }}
                          className={`w-full rounded-lg px-3 py-2 text-left transition ${
                            isActive
                              ? 'bg-[var(--success-muted)] text-[var(--success)]'
                              : 'text-[var(--gray-500)] hover:bg-white hover:text-[var(--gray-950)]'
                          }`}
                        >
                          <p className="text-[12px] font-medium">{scenario.name}</p>
                          <p className="text-[10px]">{scenario.proposalIds.length} propuestas</p>
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
                  : `Simulación ${effectiveSimulation.name} · ${Math.round(activeScenario.probability * 100)}% probabilidad · ${activeScenario.horizonMonths} meses`}
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
              <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">Línea de tiempo · Base vs Escenario</h2>
              <p className="text-[12px] text-[var(--gray-400)]">
                La banda coloreada muestra la diferencia entre el {BASE_SCENARIO_NAME} y <span className="font-medium text-[var(--gray-500)]">{activeScenario.name}</span> en vista {granularity === 'monthly' ? 'mensual' : granularity === 'weekly' ? 'semanal' : 'diaria'}.
              </p>
            </div>
            <div className="rounded-full bg-[var(--gray-50)] px-3 py-1 text-[12px] text-[var(--gray-500)]">
              {isBaseScenario(activeScenario) ? 'Escenario fijo' : `${activeScenario.proposalIds.length} propuestas activas`}
            </div>
          </div>

          {!isBaseScenario(activeScenario) && (
            <div className="mb-5 grid grid-cols-4 gap-3">
              {DELTA_KPIS.map((kpi) => (
                <DeltaChip
                  key={kpi.key}
                  label={kpi.label}
                  base={baseEvaluation.kpis[kpi.key]}
                  scenario={activeEvaluation.kpis[kpi.key]}
                  betterIs={kpi.betterIs}
                />
              ))}
            </div>
          )}

          <ResponsiveContainer width="100%" height={340}>
            <ComposedChart data={chartData} margin={{ top: 12, right: 16, left: 0, bottom: 0 }} stackOffset="none">
              <defs>
                <linearGradient id="gradGain" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--success)" stopOpacity={0.55} />
                  <stop offset="100%" stopColor="var(--success)" stopOpacity={0.08} />
                </linearGradient>
                <linearGradient id="gradLoss" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--danger)" stopOpacity={0.08} />
                  <stop offset="100%" stopColor="var(--danger)" stopOpacity={0.55} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--gray-100)" vertical={false} />
              <XAxis
                dataKey="month"
                tick={{ fill: 'var(--gray-400)', fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: 'var(--gray-100)' }}
                minTickGap={24}
              />
              <YAxis
                tick={{ fill: 'var(--gray-400)', fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(value) => formatCompactNumber(value)}
                width={72}
              />
              <Tooltip
                content={<TimelineTooltip />}
                cursor={{ stroke: 'var(--gray-300)', strokeWidth: 1, strokeDasharray: '4 4' }}
              />
              <Legend
                wrapperStyle={{ fontSize: 12, paddingTop: 10 }}
                iconType="circle"
                iconSize={8}
                payload={[
                  { value: 'Base', type: 'circle', color: 'var(--gray-400)', id: 'base' },
                  { value: 'Escenario', type: 'circle', color: 'var(--primary)', id: 'escenario' },
                  { value: 'Mejora vs Base', type: 'square', color: 'var(--success)', id: 'gain' },
                  { value: 'Deterioro vs Base', type: 'square', color: 'var(--danger)', id: 'loss' },
                ]}
              />
              <ReferenceLine y={0} stroke="var(--gray-200)" strokeDasharray="3 3" />

              {/* Invisible baseline the bands stack on top of */}
              <Area
                type="monotone"
                dataKey="lower"
                stackId="band"
                stroke="none"
                fill="transparent"
                isAnimationActive={false}
                legendType="none"
              />
              {/* Gain band: visible only where scenario > base */}
              <Area
                type="monotone"
                dataKey="gainBand"
                stackId="band"
                stroke="none"
                fill="url(#gradGain)"
                name="Mejora"
                isAnimationActive={false}
                legendType="none"
              />
              {/* Loss band: visible only where scenario < base */}
              <Area
                type="monotone"
                dataKey="lossBand"
                stackId="band"
                stroke="none"
                fill="url(#gradLoss)"
                name="Deterioro"
                isAnimationActive={false}
                legendType="none"
              />

              <Line
                type="monotone"
                dataKey="base"
                stroke="var(--gray-400)"
                strokeWidth={2}
                strokeDasharray="5 4"
                dot={false}
                activeDot={{ r: 4, fill: 'var(--gray-400)', stroke: 'white', strokeWidth: 2 }}
                name="Base"
                legendType="none"
              />
              <Line
                type="monotone"
                dataKey="escenario"
                stroke="var(--primary)"
                strokeWidth={2.5}
                dot={false}
                activeDot={{ r: 5, fill: 'var(--primary)', stroke: 'white', strokeWidth: 2 }}
                name="Escenario"
                legendType="none"
              />
            </ComposedChart>
          </ResponsiveContainer>

          {!isBaseScenario(activeScenario) && (
            <div className="mt-5 rounded-xl bg-[var(--surface-alt)] p-4">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <h3 className="text-[13px] font-semibold text-[var(--gray-950)]">Diferencia por {granularity === 'monthly' ? 'mes' : granularity === 'weekly' ? 'semana' : 'día'}</h3>
                  <p className="text-[11px] text-[var(--gray-400)]">Δ Caja final generada por las propuestas aplicadas.</p>
                </div>
                <div className="flex items-center gap-3 text-[11px] text-[var(--gray-500)]">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-[var(--success)]" /> Mejora
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-[var(--danger)]" /> Deterioro
                  </span>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="var(--gray-100)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fill: 'var(--gray-400)', fontSize: 11 }} tickLine={false} axisLine={{ stroke: 'var(--gray-100)' }} minTickGap={24} />
                  <YAxis tick={{ fill: 'var(--gray-400)', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(value) => formatCompactNumber(value)} width={72} />
                  <Tooltip
                    formatter={(value: number) => formatCurrency(value)}
                    labelFormatter={(label) => `${label} — Δ vs Base`}
                    contentStyle={{ borderRadius: 12, borderColor: 'var(--gray-200)', fontSize: 12, boxShadow: '0 8px 25px -5px rgba(0,0,0,0.08)' }}
                    cursor={{ fill: 'var(--gray-100)', opacity: 0.5 }}
                  />
                  <ReferenceLine y={0} stroke="var(--gray-300)" />
                  <Bar dataKey="diff" name="Δ Caja" radius={[4, 4, 0, 0]}>
                    {chartData.map((entry, index) => (
                      <Cell
                        key={`diff-${index}`}
                        fill={entry.diff >= 0 ? 'var(--success)' : 'var(--danger)'}
                        fillOpacity={Math.abs(entry.diff) < 0.01 ? 0.2 : 0.85}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
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
                const simulation = simulations.find((item) => item.id === scenario.simulationId);
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
                        <p className="text-[11px] text-[var(--gray-400)]">{simulation?.name ?? BASE_SCENARIO_NAME}</p>
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
          value={proposalSearch}
          onChange={(event) => setProposalSearch(event.target.value)}
          placeholder="Buscar propuesta..."
          className="w-full rounded-xl border border-[var(--gray-200)] bg-[var(--surface-alt)] px-3 py-2.5 text-[13px]"
        />
        <div className="space-y-2 max-h-[calc(100vh-260px)] overflow-y-auto pr-1">
          {filteredProposals.map((proposal) => {
            const assigned = assignedProposalIds.has(proposal.id);
            const effect = proposal.effects[0];
            return (
              <button
                key={proposal.id}
                onClick={() => toggleProposalAssignment(proposal.id)}
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
                        style={{ backgroundColor: CATEGORY_COLORS[proposal.category] }}
                      />
                      <p className="truncate text-[13px] font-semibold text-[var(--gray-950)]">{proposal.name}</p>
                    </div>
                    <p className="mt-1 text-[11px] text-[var(--gray-400)] line-clamp-2">{proposal.description || 'Sin descripción'}</p>
                    <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-[var(--gray-500)]">
                      <span className="rounded-full border border-[var(--gray-200)]/60 bg-white px-2 py-0.5">{proposal.category}</span>
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

function DeltaChip({
  label,
  base,
  scenario,
  betterIs,
}: {
  label: string;
  base: number;
  scenario: number;
  betterIs: 'higher' | 'lower';
}) {
  const delta = scenario - base;
  const deltaPct = base !== 0 ? (delta / Math.abs(base)) * 100 : 0;
  const isNeutral = Math.abs(delta) < 0.01;
  const isImprovement = betterIs === 'higher' ? delta > 0 : delta < 0;
  const tone = isNeutral ? 'neutral' : isImprovement ? 'good' : 'bad';
  const classes = {
    good: { bg: 'bg-[var(--success-muted)]', border: 'border-[var(--success)]/20', text: 'text-[var(--success)]', Icon: TrendingUp },
    bad: { bg: 'bg-[var(--danger-muted)]', border: 'border-[var(--danger)]/20', text: 'text-[var(--danger)]', Icon: TrendingDown },
    neutral: { bg: 'bg-[var(--gray-50)]', border: 'border-[var(--gray-200)]/60', text: 'text-[var(--gray-500)]', Icon: Minus },
  }[tone];
  const Icon = classes.Icon;
  const sign = delta > 0 ? '+' : '';

  return (
    <div className={`rounded-xl border ${classes.border} ${classes.bg} px-3 py-3`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--gray-400)]">{label}</p>
        <span className={`flex h-6 w-6 items-center justify-center rounded-full bg-white shadow-sm ${classes.text}`}>
          <Icon className="w-3.5 h-3.5" />
        </span>
      </div>
      <p className={`mt-2 text-[18px] font-semibold ${classes.text}`}>
        {isNeutral ? '—' : `${sign}${formatCurrency(delta)}`}
      </p>
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-[var(--gray-400)]">
        <span>Base {formatCompactNumber(base)}</span>
        {!isNeutral && (
          <span className={`font-medium ${classes.text}`}>{sign}{deltaPct.toFixed(1)}%</span>
        )}
      </div>
    </div>
  );
}

function TimelineTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ payload: { base: number; escenario: number; diff: number } }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;
  const diffColor = row.diff > 0 ? 'var(--success)' : row.diff < 0 ? 'var(--danger)' : 'var(--gray-500)';
  const sign = row.diff > 0 ? '+' : '';
  return (
    <div className="rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[12px] shadow-[0_8px_25px_-5px_rgba(0,0,0,0.08)]">
      <p className="mb-1.5 font-semibold text-[var(--gray-950)]">{label}</p>
      <div className="grid grid-cols-[auto,1fr] items-center gap-x-3 gap-y-1 font-mono">
        <span className="inline-flex items-center gap-1.5 text-[var(--gray-500)]">
          <span className="h-2 w-2 rounded-full bg-[var(--gray-400)]" /> Base
        </span>
        <span className="text-right text-[var(--gray-950)]">{formatCurrency(row.base)}</span>
        <span className="inline-flex items-center gap-1.5 text-[var(--gray-500)]">
          <span className="h-2 w-2 rounded-full bg-[var(--primary)]" /> Escenario
        </span>
        <span className="text-right text-[var(--gray-950)]">{formatCurrency(row.escenario)}</span>
        <span className="col-span-2 border-t border-[var(--gray-100)] pt-1.5 text-[var(--gray-400)]">
          <div className="flex items-center justify-between">
            <span>Diferencia</span>
            <span className="font-semibold" style={{ color: diffColor }}>{sign}{formatCurrency(row.diff)}</span>
          </div>
        </span>
      </div>
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
