import { type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Check,
  FlaskConical,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import {
  BASE_SCENARIO_ID,
  BASE_SCENARIO_NAME,
  CATEGORY_COLORS,
  FlowPlan,
  MONTHS,
  Proposal,
  ROLE_TARGET_COLLECTIONS,
  ROLE_TARGET_EXPENSE,
  ROLE_TARGET_INCOME,
  ROLE_TARGET_PROVIDER_PAYMENTS,
  Scenario,
  ScenarioCellOverride,
  Simulation,
  SimulationCategory,
  SimulationFrequency,
  SimulationOperation,
  SimulationType,
} from '../types';
import {
  buildSimulationEffects,
  cloneProposalWithActiveScenario,
  isBaseScenario,
} from '../domain/simulationCompiler';
import {
  evaluateScenario,
  resolveConceptLabel,
} from '../domain/scenarioEngine';
import { formatCompactNumber, formatCurrency } from '../utils/calculations';

/* ─── Props ─── */

interface Props {
  plan: FlowPlan;
  proposals: Proposal[];
  scenarios: Scenario[];
  simulations: Simulation[];
  overrides: ScenarioCellOverride[];
  activeProposalId: string | null;
  activeScenarioId: string | null;
  onSelectProposal: (proposalId: string) => void;
  onSelectScenario: (scenarioId: string | null) => void;
  onAdd: (proposal: Proposal) => void;
  onUpdate: (proposal: Proposal) => void;
  onDelete: (proposalId: string) => void;
  onAddScenario: (scenario: Scenario) => void;
  onUpdateScenario: (scenario: Scenario) => void;
  onDeleteScenario: (scenarioId: string) => void;
  onAddSimulation: (simulation: Simulation) => void;
  onUpdateSimulation: (simulation: Simulation) => void;
  onDeleteSimulation: (simulationId: string) => void;
}

/* ─── Constants ─── */

const SIMULATION_CATEGORIES: SimulationCategory[] = [
  'Incremento de Ingresos',
  'Reducción de Costos',
  'Diferimiento',
  'Renegociación',
];

const FREQUENCIES: { value: SimulationFrequency; label: string }[] = [
  { value: 'once', label: 'Única vez' },
  { value: 'monthly', label: 'Mensual' },
  { value: 'bimonthly', label: 'Bimestral' },
  { value: 'quarterly', label: 'Trimestral' },
  { value: 'semiannual', label: 'Semestral' },
  { value: 'annual', label: 'Anual' },
];

const SIMULATION_TYPES: { value: SimulationType; label: string; description: string }[] = [
  { value: 'percent_adjustment', label: 'Ajuste porcentual', description: 'Aumenta o reduce por un porcentaje.' },
  { value: 'amount_adjustment', label: 'Ajuste por monto', description: 'Agrega o quita un monto puntual o repetido.' },
  { value: 'recurring_series', label: 'Ingreso / gasto recurrente', description: 'Crea flujos recurrentes durante un periodo.' },
  { value: 'installment_plan', label: 'Cobro / pago en parcialidades', description: 'Distribuye un monto en parcialidades.' },
  { value: 'timing_shift', label: 'Atrasar / adelantar', description: 'Mueve cobros o pagos en el calendario.' },
  { value: 'pause_expense', label: 'Pausar gasto', description: 'Reduce al 100% un gasto durante el periodo.' },
];

const KPI_CONFIG = [
  { key: 'ingresos12m', label: 'Ingresos 12m', color: 'text-[var(--primary)]' },
  { key: 'egresos12m', label: 'Egresos 12m', color: 'text-[var(--danger)]' },
  { key: 'flujoNeto12m', label: 'Flujo Neto', color: 'text-[var(--success)]' },
  { key: 'cajaFinal', label: 'Caja Final', color: 'text-[var(--gray-950)]' },
] as const;

/* ─── Helpers ─── */

function now(): string { return new Date().toISOString(); }

function formatYearMonthLabel(ym: string): string {
  const [y, m] = ym.split('-');
  return `${MONTHS[Math.max(0, Math.min(11, (Number(m) || 1) - 1))]} ${String(y).slice(2)}`;
}

function formatDateLabel(date: string): string {
  if (!date) return 'sin fecha';
  const [yearRaw, monthRaw, dayRaw] = date.split('-');
  const year = Number(yearRaw);
  const monthIndex = Math.max(0, Math.min(11, (Number(monthRaw) || 1) - 1));
  const day = Number(dayRaw) || 1;
  return `${day} ${MONTHS[monthIndex]} ${String(year).slice(2)}`;
}

function yearMonthFromDate(date: string): string {
  return date.slice(0, 7);
}

function endOfMonthFromDate(date: string): string {
  const yearMonth = yearMonthFromDate(date);
  const [yearRaw, monthRaw] = yearMonth.split('-');
  const year = Number(yearRaw);
  const monthIndex = Math.max(0, Math.min(11, (Number(monthRaw) || 1) - 1));
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return `${yearMonth}-${String(lastDay).padStart(2, '0')}`;
}

function firstOfMonth(date: string): string {
  return `${yearMonthFromDate(date)}-01`;
}

function snapToMonday(date: string): string {
  const current = new Date(`${date}T12:00:00Z`);
  const weekday = current.getUTCDay();
  const offset = weekday === 0 ? -6 : 1 - weekday;
  current.setUTCDate(current.getUTCDate() + offset);
  return current.toISOString().slice(0, 10);
}

function inferStartPrecision(simulation: Simulation): 'day' | 'week' | 'month' {
  const startDate = simulation.startDate ?? `${simulation.startYearMonth ?? `${new Date().getFullYear()}-01`}-01`;
  if (startDate.endsWith('-01')) return 'month';
  if (snapToMonday(startDate) === startDate) return 'week';
  return 'day';
}

function formatSimulationWindow(simulation: Simulation): string {
  const startYearMonth = simulation.startYearMonth ?? yearMonthFromDate(simulation.startDate ?? `${new Date().getFullYear()}-01-01`);
  const endYearMonth = simulation.endYearMonth ?? startYearMonth;
  const startDate = simulation.startDate ?? `${startYearMonth}-01`;
  const endDate = simulation.endDate ?? endOfMonthFromDate(`${endYearMonth}-01`);

  if (startDate.endsWith('-01') && endOfMonthFromDate(endDate) === endDate) {
    if (startYearMonth === endYearMonth) return formatYearMonthLabel(startYearMonth);
    return `${formatYearMonthLabel(startYearMonth)} → ${formatYearMonthLabel(endYearMonth)}`;
  }

  if (startDate === endDate) return formatDateLabel(startDate);
  return `${formatDateLabel(startDate)} → ${formatDateLabel(endDate)}`;
}

function parseCustomAllocation(input: string): number[] | undefined {
  const values = input.split(',').map(c => Number(c.trim())).filter(v => !isNaN(v) && v > 0);
  return values.length > 0 ? values : undefined;
}

interface DynamicTargetOption { id: string; label: string }

function buildLeafConceptOptions(plan: FlowPlan, type: 'ingreso' | 'egreso'): DynamicTargetOption[] {
  const parentIds = new Set(plan.concepts.map(c => c.parentId).filter(Boolean) as string[]);
  return plan.concepts
    .filter(c => c.conceptType === type && !parentIds.has(c.id))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(c => ({ id: c.id, label: c.name }));
}

function getTargetOptions(plan: FlowPlan, category: SimulationCategory, type: SimulationType) {
  const incomeOpts: DynamicTargetOption[] = [{ id: ROLE_TARGET_INCOME, label: 'Todos los ingresos' }, ...buildLeafConceptOptions(plan, 'ingreso')];
  const expenseOpts: DynamicTargetOption[] = [{ id: ROLE_TARGET_EXPENSE, label: 'Todos los gastos' }, ...buildLeafConceptOptions(plan, 'egreso')];
  const collectionOpts: DynamicTargetOption[] = [{ id: ROLE_TARGET_COLLECTIONS, label: 'Toda la cobranza' }, ...buildLeafConceptOptions(plan, 'ingreso')];
  const paymentOpts: DynamicTargetOption[] = [{ id: ROLE_TARGET_PROVIDER_PAYMENTS, label: 'Todos los pagos' }, ...buildLeafConceptOptions(plan, 'egreso')];

  if (type === 'pause_expense') return { options: expenseOpts, defaults: [ROLE_TARGET_EXPENSE] };
  if (type === 'timing_shift') {
    if (category === 'Incremento de Ingresos') return { options: collectionOpts, defaults: [ROLE_TARGET_COLLECTIONS] };
    if (category === 'Reducción de Costos') return { options: paymentOpts, defaults: [ROLE_TARGET_PROVIDER_PAYMENTS] };
    return { options: [...collectionOpts, ...paymentOpts], defaults: [ROLE_TARGET_COLLECTIONS] };
  }
  if (type === 'installment_plan') {
    if (category === 'Incremento de Ingresos') return { options: incomeOpts, defaults: [ROLE_TARGET_INCOME] };
    return { options: expenseOpts, defaults: [ROLE_TARGET_EXPENSE] };
  }
  if (category === 'Incremento de Ingresos') return { options: incomeOpts, defaults: [ROLE_TARGET_INCOME] };
  if (category === 'Reducción de Costos') return { options: expenseOpts, defaults: [ROLE_TARGET_EXPENSE] };
  return { options: [...incomeOpts, ...expenseOpts], defaults: [ROLE_TARGET_INCOME] };
}

/* ─── Form state ─── */

interface AdjustmentForm {
  name: string;
  description: string;
  category: SimulationCategory;
  type: SimulationType;
  operation: SimulationOperation;
  targetIds: string[];
  startDate: string;
  endDate: string;
  startPrecision: 'day' | 'week' | 'month';
  assignedScenarioIds: string[];
  frequency: SimulationFrequency;
  amount: number;
  percent: number;
  installments: number;
  customAllocationText: string;
  shiftMonths: number;
  shiftRatio: number;
  paymentLabel: string;
  comments: string;
}

function defaultAdjustmentForm(plan: FlowPlan, assignedScenarioIds: string[] = []): AdjustmentForm {
  return {
    name: '', description: '',
    category: 'Incremento de Ingresos',
    type: 'percent_adjustment',
    operation: 'increase',
    targetIds: [ROLE_TARGET_INCOME],
    startDate: `${plan.year}-01-01`,
    endDate: `${plan.year}-12-31`,
    startPrecision: 'month',
    assignedScenarioIds,
    frequency: 'monthly',
    amount: 0, percent: 10, installments: 4,
    customAllocationText: '', shiftMonths: 1, shiftRatio: 100,
    paymentLabel: '', comments: '',
  };
}

function buildSimulationFromForm(plan: FlowPlan, form: AdjustmentForm, existing?: Simulation): Simulation {
  const ts = now();
  const startDate = form.startDate;
  const safeEndDate = form.endDate < startDate ? startDate : form.endDate;
  const sim: Simulation = {
    id: existing?.id ?? `simulation-${Date.now()}`,
    name: form.name.trim(),
    description: form.description.trim(),
    category: form.category,
    type: form.type,
    targetIds: form.targetIds,
    startYearMonth: yearMonthFromDate(startDate),
    endYearMonth: yearMonthFromDate(safeEndDate),
    startDate,
    endDate: safeEndDate,
    frequency: form.type === 'timing_shift' || form.type === 'pause_expense' ? 'monthly' : form.frequency,
    operation: form.type === 'pause_expense' ? 'decrease' : form.operation,
    amount: form.type === 'percent_adjustment' || form.type === 'pause_expense' || form.type === 'timing_shift' ? undefined : form.amount,
    percent: form.type === 'percent_adjustment' ? form.percent / 100 : undefined,
    installments: form.type === 'installment_plan' ? form.installments : undefined,
    customAllocation: form.type === 'installment_plan' ? parseCustomAllocation(form.customAllocationText) : undefined,
    shiftMonths: form.type === 'timing_shift' ? form.shiftMonths : undefined,
    shiftRatio: form.type === 'timing_shift' ? form.shiftRatio / 100 : undefined,
    paymentLabel: form.paymentLabel.trim() || undefined,
    comments: form.comments.trim() || undefined,
    effects: [],
    createdAt: existing?.createdAt ?? ts,
    updatedAt: ts,
  };
  sim.effects = buildSimulationEffects(plan, sim);
  return sim;
}

/* ─── Virtual base proposal ─── */

const VIRTUAL_BASE: Proposal = {
  id: 'proposal-base', name: BASE_SCENARIO_NAME, description: 'Pronóstico original',
  status: 'Pendiente', createdAt: '', updatedAt: '',
};

/* ═══════════════════════════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════════════════════════ */

export default function ScenarioWorkbench({
  plan, proposals, scenarios, simulations, overrides,
  activeProposalId, activeScenarioId,
  onSelectProposal, onSelectScenario,
  onAdd, onUpdate, onDelete,
  onAddScenario, onUpdateScenario, onDeleteScenario,
  onAddSimulation, onUpdateSimulation, onDeleteSimulation,
}: Props) {
  /* ── Resolved selections ── */
  const baseScenario = scenarios.find(s => isBaseScenario(s)) ?? null;
  const activeProposal = proposals.find(p => p.id === activeProposalId) ?? null;
  const activeScenario = scenarios.find(s => s.id === activeScenarioId) ?? baseScenario ?? null;
  const effectiveProposal = isBaseScenario(activeScenario) ? VIRTUAL_BASE : (activeProposal ?? VIRTUAL_BASE);
  const editableScenarios = useMemo(
    () => scenarios.filter((scenario) => !isBaseScenario(scenario)),
    [scenarios],
  );
  const scenarioLabelsById = useMemo(() => new Map(
    editableScenarios.map((scenario) => {
      const proposalName = proposals.find((proposal) => proposal.id === scenario.proposalId)?.name?.trim() ?? '';
      const label = proposalName && proposalName !== scenario.name
        ? `${proposalName} · ${scenario.name}`
        : scenario.name;
      return [scenario.id, label];
    }),
  ), [editableScenarios, proposals]);

  // For each proposal, get the first (auto) scenario
  const scenarioForProposal = (proposalId: string) =>
    scenarios.find(s => s.proposalId === proposalId && !isBaseScenario(s));

  /* ── Evaluations ── */
  const baseEvaluation = useMemo(() => {
    if (!activeScenario) return null;
    return evaluateScenario(plan, effectiveProposal, activeScenario, [], []);
  }, [activeScenario, effectiveProposal, plan]);

  const activeEvaluation = useMemo(() => {
    if (!activeScenario) return null;
    return evaluateScenario(
      plan, effectiveProposal, activeScenario,
      isBaseScenario(activeScenario) ? [] : simulations,
      isBaseScenario(activeScenario) ? [] : overrides,
    );
  }, [activeScenario, effectiveProposal, overrides, plan, simulations]);

  const chartData = useMemo(() => {
    if (!activeEvaluation || !baseEvaluation) return [];
    return activeEvaluation.months.map((m, i) => ({
      month: m.label,
      base: baseEvaluation.metrics.cajaFinal[i] ?? 0,
      escenario: activeEvaluation.metrics.cajaFinal[i] ?? 0,
    }));
  }, [activeEvaluation, baseEvaluation]);

  /* ── Adjustment panel state ── */
  const [panelOpen, setPanelOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<AdjustmentForm>(() => defaultAdjustmentForm(plan));
  const [newScenarioName, setNewScenarioName] = useState('');
  const [showNewScenario, setShowNewScenario] = useState(false);

  const assignedIds = new Set(activeScenario?.simulationIds ?? []);
  const assignedSimulations = simulations.filter(s => assignedIds.has(s.id));

  const targetConfig = useMemo(
    () => getTargetOptions(plan, form.category, form.type),
    [plan, form.category, form.type],
  );

  // Sync target IDs when category/type changes
  useEffect(() => {
    const allowed = new Set(targetConfig.options.map(o => o.id));
    setForm(prev => {
      const next = prev.targetIds.filter(id => allowed.has(id));
      const resolved = next.length > 0 ? next : targetConfig.defaults;
      if (resolved.length === prev.targetIds.length && resolved.every((id, i) => id === prev.targetIds[i])) return prev;
      return { ...prev, targetIds: resolved };
    });
  }, [targetConfig]);

  const resolveAssignedScenarioIds = (simulationId: string): string[] => (
    editableScenarios
      .filter((scenario) => scenario.simulationIds.includes(simulationId))
      .map((scenario) => scenario.id)
  );

  const syncSimulationAssignments = (simulationId: string, nextScenarioIds: string[]) => {
    const selectedIds = new Set(nextScenarioIds);

    editableScenarios.forEach((scenario) => {
      const exists = scenario.simulationIds.includes(simulationId);
      const shouldExist = selectedIds.has(scenario.id);
      if (exists === shouldExist) return;

      onUpdateScenario({
        ...scenario,
        simulationIds: shouldExist
          ? [...new Set([...scenario.simulationIds, simulationId])]
          : scenario.simulationIds.filter((id) => id !== simulationId),
        updatedAt: now(),
      });
    });
  };

  /* ── Handlers ── */

  const createScenario = () => {
    const name = newScenarioName.trim();
    if (!name) return;
    const ts = now();
    const proposalId = `proposal-${Date.now()}`;
    const scenarioId = `scenario-${Date.now()}`;

    onAdd({
      id: proposalId, name, description: '',
      status: 'Pendiente', createdAt: ts, updatedAt: ts,
    });
    onAddScenario({
      id: scenarioId, proposalId, kind: 'proposal',
      name, description: '', probability: 1,
      startYearMonth: `${plan.year}-01`, horizonMonths: 12,
      simulationIds: [], createdAt: ts, updatedAt: ts,
    });
    onSelectProposal(proposalId);
    onSelectScenario(scenarioId);
    setNewScenarioName('');
    setShowNewScenario(false);
  };

  const deleteScenarioFull = (proposalId: string) => {
    onDelete(proposalId);
  };

  const selectScenarioByProposal = (proposalId: string) => {
    onSelectProposal(proposalId);
    const sc = scenarioForProposal(proposalId);
    if (sc) onSelectScenario(sc.id);
  };

  const openNewAdjustment = () => {
    setEditingId(null);
    setForm(defaultAdjustmentForm(
      plan,
      activeScenario && !isBaseScenario(activeScenario) ? [activeScenario.id] : [],
    ));
    setPanelOpen(true);
  };

  const openEditAdjustment = (sim: Simulation) => {
    setEditingId(sim.id);
    setForm({
      name: sim.name, description: sim.description,
      category: sim.category ?? 'Incremento de Ingresos',
      type: sim.type ?? 'amount_adjustment',
      operation: sim.operation ?? 'increase',
      targetIds: sim.targetIds?.length ? sim.targetIds : [ROLE_TARGET_INCOME],
      startDate: sim.startDate ?? `${sim.startYearMonth ?? `${plan.year}-01`}-01`,
      endDate: sim.endDate ?? endOfMonthFromDate(`${sim.endYearMonth ?? sim.startYearMonth ?? `${plan.year}-12`}-01`),
      startPrecision: inferStartPrecision(sim),
      assignedScenarioIds: resolveAssignedScenarioIds(sim.id),
      frequency: sim.frequency ?? 'monthly',
      amount: sim.amount ?? 0,
      percent: Math.abs((sim.percent ?? 0) * 100),
      installments: sim.installments ?? 4,
      customAllocationText: sim.customAllocation?.join(', ') ?? '',
      shiftMonths: sim.shiftMonths ?? 1,
      shiftRatio: Math.round((sim.shiftRatio ?? 1) * 100),
      paymentLabel: sim.paymentLabel ?? '',
      comments: sim.comments ?? '',
    });
    setPanelOpen(true);
  };

  const saveAdjustment = () => {
    if (!form.name.trim() || form.targetIds.length === 0 || form.assignedScenarioIds.length === 0) return;
    const existing = editingId ? simulations.find(s => s.id === editingId) : undefined;
    const sim = buildSimulationFromForm(plan, form, existing);

    if (existing) {
      onUpdateSimulation(sim);
    } else {
      onAddSimulation(sim);
    }
    syncSimulationAssignments(sim.id, form.assignedScenarioIds);
    setPanelOpen(false);
    setEditingId(null);
  };

  const removeAdjustmentFromScenario = (simId: string) => {
    if (!activeScenario || isBaseScenario(activeScenario)) return;
    onUpdateScenario({
      ...activeScenario,
      simulationIds: activeScenario.simulationIds.filter(id => id !== simId),
      updatedAt: now(),
    });
  };

  const deleteAdjustment = (simId: string) => {
    onDeleteSimulation(simId);
  };

  const toggleTarget = (id: string) => {
    setForm(prev => ({
      ...prev,
      targetIds: prev.targetIds.includes(id)
        ? prev.targetIds.filter(t => t !== id)
        : [...prev.targetIds, id],
    }));
  };

  const toggleAssignedScenario = (scenarioId: string) => {
    setForm((prev) => ({
      ...prev,
      assignedScenarioIds: prev.assignedScenarioIds.includes(scenarioId)
        ? prev.assignedScenarioIds.filter((id) => id !== scenarioId)
        : [...prev.assignedScenarioIds, scenarioId],
    }));
  };

  const isBase = isBaseScenario(activeScenario);

  /* ═══ RENDER ═══ */

  return (
    <div className="space-y-5 relative">

      {/* ─── Scenario selector strip ─── */}
      <div className="rounded-2xl border border-[var(--gray-200)]/50 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-4 mb-3">
          <div>
            <h1 className="text-[20px] font-semibold text-[var(--gray-950)]">Escenarios</h1>
            <p className="text-[13px] text-[var(--gray-400)]">
              Crea escenarios financieros con ajustes y compáralos contra el Base.
            </p>
          </div>
          <button
            onClick={() => setShowNewScenario(true)}
            className="inline-flex items-center gap-1.5 rounded-full bg-[var(--primary)] px-4 py-2 text-[13px] font-medium text-white hover:bg-[var(--primary-hover)] transition"
          >
            <Plus className="w-4 h-4" /> Nuevo escenario
          </button>
        </div>

        {showNewScenario && (
          <div className="flex items-center gap-3 mb-3 rounded-xl border border-[var(--gray-200)] bg-[var(--surface-alt)] p-3">
            <input
              value={newScenarioName}
              onChange={e => setNewScenarioName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') createScenario(); if (e.key === 'Escape') setShowNewScenario(false); }}
              placeholder="Nombre del escenario"
              className="flex-1 rounded-lg border border-[var(--gray-200)] bg-white px-3 py-2 text-[13px] outline-none focus:border-[var(--primary)]"
              autoFocus
            />
            <button onClick={createScenario} className="rounded-lg bg-[#1d1d1f] px-4 py-2 text-[12px] font-medium text-white">Crear</button>
            <button onClick={() => setShowNewScenario(false)} className="rounded-lg border border-[var(--gray-200)] px-3 py-2 text-[12px] text-[var(--gray-500)]">Cancelar</button>
          </div>
        )}

        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {/* Base pill */}
          <button
            onClick={() => onSelectScenario(BASE_SCENARIO_ID)}
            className={`flex-shrink-0 rounded-xl border px-4 py-3 text-left transition min-w-[180px] ${
              isBase
                ? 'border-[#1d1d1f] bg-[#1d1d1f] text-white'
                : 'border-[var(--gray-200)]/60 bg-[var(--surface-alt)] hover:bg-white'
            }`}
          >
            <p className="text-[13px] font-semibold">{BASE_SCENARIO_NAME}</p>
            <p className={`text-[11px] mt-0.5 ${isBase ? 'text-white/70' : 'text-[var(--gray-400)]'}`}>Pronóstico original</p>
          </button>

          {/* Scenario pills */}
          {proposals.map(proposal => {
            const sc = scenarioForProposal(proposal.id);
            const adjustCount = sc?.simulationIds.length ?? 0;
            const selected = activeProposal?.id === proposal.id && !isBase;
            return (
              <button
                key={proposal.id}
                onClick={() => selectScenarioByProposal(proposal.id)}
                className={`flex-shrink-0 rounded-xl border px-4 py-3 text-left transition min-w-[180px] group ${
                  selected
                    ? 'border-[var(--primary)] bg-[var(--primary-muted)]'
                    : 'border-[var(--gray-200)]/60 bg-[var(--surface-alt)] hover:bg-white'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-[var(--gray-950)] truncate">{proposal.name}</p>
                    <p className="text-[11px] text-[var(--gray-400)] mt-0.5">{adjustCount} ajustes</p>
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); deleteScenarioFull(proposal.id); }}
                    className="opacity-0 group-hover:opacity-100 rounded-lg p-1 text-[var(--gray-400)] hover:text-[#ff3b30] hover:bg-white transition"
                    title="Eliminar escenario"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── KPI cards ─── */}
      {activeEvaluation && baseEvaluation && (
        <div className="grid grid-cols-4 gap-4">
          {KPI_CONFIG.map(kpi => {
            const val = activeEvaluation.kpis[kpi.key];
            const baseVal = baseEvaluation.kpis[kpi.key];
            const diff = val - baseVal;
            return (
              <div key={kpi.key} className="rounded-2xl border border-[var(--gray-200)]/50 bg-white p-4 shadow-sm">
                <p className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">{kpi.label}</p>
                <p className={`mt-2 text-[22px] font-semibold ${kpi.color}`}>{formatCurrency(val)}</p>
                <div className="mt-1 flex items-center gap-2 text-[11px]">
                  <span className="text-[var(--gray-400)]">Base: {formatCurrency(baseVal)}</span>
                  {diff !== 0 && (
                    <span className={diff > 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]'}>
                      {diff > 0 ? '+' : ''}{formatCurrency(diff)}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ─── Chart: Base vs Escenario ─── */}
      {chartData.length > 0 && !isBase && (
        <section className="rounded-2xl border border-[var(--gray-200)]/50 bg-white p-5 shadow-sm">
          <h2 className="text-[15px] font-semibold text-[var(--gray-950)] mb-1">Caja: Base vs {activeProposal?.name ?? 'Escenario'}</h2>
          <p className="text-[12px] text-[var(--gray-400)] mb-4">Impacto acumulado de los ajustes en la caja mensual.</p>
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="wb-base" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--gray-300)" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="var(--gray-300)" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="wb-scenario" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.18} />
                  <stop offset="95%" stopColor="var(--primary)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#e8e8ed" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: 'var(--gray-400)', fontSize: 11 }} tickLine={false} axisLine={{ stroke: 'var(--gray-100)' }} />
              <YAxis tick={{ fill: 'var(--gray-400)', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={v => formatCompactNumber(v)} />
              <Tooltip formatter={(v: number) => formatCurrency(v)} contentStyle={{ borderRadius: 16, borderColor: 'var(--gray-200)' }} />
              <Area type="monotone" dataKey="base" stroke="var(--gray-300)" strokeWidth={2} fill="url(#wb-base)" name="Base" />
              <Area type="monotone" dataKey="escenario" stroke="var(--primary)" strokeWidth={2.5} fill="url(#wb-scenario)" name="Escenario" />
            </AreaChart>
          </ResponsiveContainer>
        </section>
      )}

      {/* ─── Adjustments section ─── */}
      <section className="rounded-2xl border border-[var(--gray-200)]/50 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-4 mb-4">
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">
              {isBase ? 'Ajustes' : `Ajustes de "${activeProposal?.name ?? 'Escenario'}"`}
            </h2>
            <p className="text-[12px] text-[var(--gray-400)]">
              {isBase
                ? 'Selecciona un escenario para ver y editar sus ajustes financieros.'
                : 'Cada ajuste modifica el pronóstico. Puedes reutilizarlo en varios escenarios y definir si arranca por mes, semana o día.'}
            </p>
          </div>
          {!isBase && (
            <button
              onClick={openNewAdjustment}
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--primary)] px-4 py-2 text-[13px] font-medium text-white hover:bg-[var(--primary-hover)] transition"
            >
              <Plus className="w-4 h-4" /> Agregar ajuste
            </button>
          )}
        </div>

        {isBase && (
          <div className="rounded-2xl border border-dashed border-[var(--gray-200)] bg-[var(--surface-alt)] px-6 py-12 text-center">
            <FlaskConical className="w-6 h-6 mx-auto mb-3 text-[var(--gray-400)]" />
            <p className="text-[13px] font-medium text-[var(--gray-950)]">Escenario Base seleccionado</p>
            <p className="text-[12px] text-[var(--gray-400)] mt-1">
              El Base es el pronóstico original sin cambios. Crea o selecciona un escenario para agregar ajustes.
            </p>
          </div>
        )}

        {!isBase && assignedSimulations.length === 0 && (
          <div className="rounded-2xl border border-dashed border-[var(--gray-200)] bg-[var(--surface-alt)] px-6 py-12 text-center">
            <FlaskConical className="w-6 h-6 mx-auto mb-3 text-[var(--gray-400)]" />
            <p className="text-[13px] font-medium text-[var(--gray-950)]">Sin ajustes todavía</p>
            <p className="text-[12px] text-[var(--gray-400)] mt-1">
              Agrega tu primer ajuste: incremento de ventas, reducción de costos, diferimiento, etc.
            </p>
          </div>
        )}

        {!isBase && assignedSimulations.length > 0 && (
          <div className="space-y-2">
            {assignedSimulations.map(sim => {
              const targetLabel = sim.targetIds?.slice(0, 2).map(id => resolveConceptLabel(plan, id)).join(', ') ?? '';
              const typeMeta = SIMULATION_TYPES.find(t => t.value === sim.type);
              const assignedScenarioLabels = resolveAssignedScenarioIds(sim.id)
                .map((scenarioId) => scenarioLabelsById.get(scenarioId) ?? scenarioId);
              return (
                <div key={sim.id} className="flex items-center gap-4 rounded-xl border border-[var(--gray-200)]/50 bg-[var(--surface-alt)] px-4 py-3 group">
                  <div className="h-3 w-3 rounded-full flex-shrink-0" style={{ backgroundColor: CATEGORY_COLORS[sim.category] }} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-[var(--gray-950)] truncate">{sim.name}</p>
                    <div className="flex flex-wrap items-center gap-2 mt-1">
                      <Badge>{typeMeta?.label ?? sim.type}</Badge>
                      <Badge>{sim.operation === 'decrease' ? 'Reducir' : 'Incrementar'}</Badge>
                      <Badge>{targetLabel}{(sim.targetIds?.length ?? 0) > 2 ? ' +' : ''}</Badge>
                      {sim.percent != null && <Badge>{Math.round(Math.abs(sim.percent) * 100)}%</Badge>}
                      {sim.amount != null && <Badge>${sim.amount.toLocaleString()}</Badge>}
                      <Badge>{formatSimulationWindow(sim)}</Badge>
                      {assignedScenarioLabels.length > 1 && (
                        <Badge>{`Compartido en ${assignedScenarioLabels.length} escenarios`}</Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                    <button onClick={() => openEditAdjustment(sim)} className="rounded-lg p-1.5 text-[var(--gray-400)] hover:bg-white hover:text-[var(--gray-950)]" title="Editar">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => removeAdjustmentFromScenario(sim.id)} className="rounded-lg p-1.5 text-[var(--gray-400)] hover:bg-white hover:text-[#ff3b30]" title="Quitar del escenario">
                      <X className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => deleteAdjustment(sim.id)} className="rounded-lg p-1.5 text-[var(--gray-400)] hover:bg-white hover:text-[#ff3b30]" title="Eliminar permanentemente de todos los escenarios">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ─── Monthly detail table ─── */}
      {activeEvaluation && baseEvaluation && !isBase && (
        <section className="rounded-2xl border border-[var(--gray-200)]/50 bg-white p-5 shadow-sm">
          <h2 className="text-[15px] font-semibold text-[var(--gray-950)] mb-1">Detalle mensual</h2>
          <p className="text-[12px] text-[var(--gray-400)] mb-4">Impacto de los ajustes en métricas clave por mes.</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-[12px]">
              <thead>
                <tr className="border-b border-[var(--gray-100)] bg-[var(--surface-alt)]">
                  <th className="sticky left-0 min-w-[150px] bg-[var(--surface-alt)] px-4 py-2.5 text-left font-medium text-[var(--gray-400)]">Métrica</th>
                  {activeEvaluation.months.map(m => (
                    <th key={m.ym} className="px-2 py-2.5 text-right font-medium text-[var(--gray-400)]">{m.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <MetricRow label="Ingresos" values={activeEvaluation.metrics.ingresos} tone="pos" />
                <MetricRow label="Egresos" values={activeEvaluation.metrics.egresos} tone="neg" />
                <MetricRow label="Flujo Neto" values={activeEvaluation.metrics.flujoNeto} tone="neutral" />
                <MetricRow label="Caja Final" values={activeEvaluation.metrics.cajaFinal} tone="emphasis" />
                <MetricRow
                  label="Δ vs Base"
                  values={activeEvaluation.metrics.cajaFinal.map((v, i) => v - (baseEvaluation.metrics.cajaFinal[i] ?? 0))}
                  tone="diff"
                />
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ═══ SLIDE-OVER PANEL: Create / Edit Adjustment ═══ */}
      {panelOpen && (
        <div className="fixed inset-0 z-50 flex justify-end" onClick={() => setPanelOpen(false)}>
          <div className="absolute inset-0 bg-black/20" />
          <div
            className="relative w-full max-w-[540px] bg-white shadow-2xl overflow-y-auto animate-slide-in-right"
            onClick={e => e.stopPropagation()}
          >
            <div className="sticky top-0 z-10 bg-white border-b border-[var(--gray-100)] px-6 py-4 flex items-center justify-between">
              <h2 className="text-[17px] font-semibold text-[var(--gray-950)]">
                {editingId ? 'Editar ajuste' : 'Nuevo ajuste'}
              </h2>
              <button onClick={() => setPanelOpen(false)} className="rounded-lg p-1.5 text-[var(--gray-400)] hover:bg-[var(--gray-100)]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-6 py-5 space-y-5">
              {/* Name */}
              <Field label="Nombre">
                <input
                  value={form.name}
                  onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="Ej. Incremento ventas Q2"
                  className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px] outline-none focus:border-[var(--primary)]"
                  autoFocus
                />
              </Field>

              {/* Type + Category */}
              <div className="grid grid-cols-2 gap-4">
                <Field label="Tipo de ajuste">
                  <select
                    value={form.type}
                    onChange={e => setForm(p => ({ ...p, type: e.target.value as SimulationType }))}
                    className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                  >
                    {SIMULATION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </Field>
                <Field label="Categoría">
                  <select
                    value={form.category}
                    onChange={e => setForm(p => ({ ...p, category: e.target.value as SimulationCategory }))}
                    className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                  >
                    {SIMULATION_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </Field>
              </div>

              {/* Type description */}
              {(() => {
                const meta = SIMULATION_TYPES.find(t => t.value === form.type);
                return meta ? (
                  <div className="rounded-xl bg-[var(--surface-alt)] p-3 text-[12px] text-[var(--gray-500)]">
                    {meta.description}
                  </div>
                ) : null;
              })()}

              {/* Operation + Value */}
              {!['timing_shift', 'pause_expense'].includes(form.type) && (
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Operación">
                    <select
                      value={form.operation}
                      onChange={e => setForm(p => ({ ...p, operation: e.target.value as SimulationOperation }))}
                      className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                    >
                      <option value="increase">Incrementar</option>
                      <option value="decrease">Reducir</option>
                    </select>
                  </Field>
                  <Field label={form.type === 'percent_adjustment' ? 'Porcentaje' : 'Monto'}>
                    <input
                      type="number"
                      step={form.type === 'percent_adjustment' ? 1 : 0.01}
                      value={form.type === 'percent_adjustment' ? form.percent : form.amount}
                      onChange={e => setForm(p =>
                        form.type === 'percent_adjustment'
                          ? { ...p, percent: Number(e.target.value) || 0 }
                          : { ...p, amount: Number(e.target.value) || 0 }
                      )}
                      className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                    />
                  </Field>
                </div>
              )}

              {/* Timing shift fields */}
              {form.type === 'timing_shift' && (
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Mover meses">
                    <input type="number" min={-12} max={12} value={form.shiftMonths}
                      onChange={e => setForm(p => ({ ...p, shiftMonths: Number(e.target.value) || 0 }))}
                      className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                    />
                  </Field>
                  <Field label="% del flujo a mover">
                    <input type="number" min={0} max={100} value={form.shiftRatio}
                      onChange={e => setForm(p => ({ ...p, shiftRatio: Number(e.target.value) || 0 }))}
                      className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                    />
                  </Field>
                </div>
              )}

              {/* Installment fields */}
              {form.type === 'installment_plan' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Monto total">
                      <input type="number" step={0.01} value={form.amount}
                        onChange={e => setForm(p => ({ ...p, amount: Number(e.target.value) || 0 }))}
                        className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                      />
                    </Field>
                    <Field label="Parcialidades">
                      <input type="number" min={2} max={24} value={form.installments}
                        onChange={e => setForm(p => ({ ...p, installments: Number(e.target.value) || 2 }))}
                        className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                      />
                    </Field>
                  </div>
                  <Field label="Distribución personalizada (opcional)">
                    <input value={form.customAllocationText}
                      onChange={e => setForm(p => ({ ...p, customAllocationText: e.target.value }))}
                      placeholder="Ej. 25, 25, 25, 25"
                      className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                    />
                  </Field>
                </div>
              )}

              {/* Period + Frequency */}
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-medium text-[var(--gray-500)]">Precisión de inicio:</span>
                  <div className="flex items-center rounded-xl bg-[var(--gray-50)] p-0.5 gap-0.5">
                    {(['day', 'week', 'month'] as const).map((precision) => (
                      <button
                        key={precision}
                        type="button"
                        onClick={() => setForm((current) => {
                          let newStart = current.startDate;
                          if (precision === 'week') newStart = snapToMonday(current.startDate);
                          if (precision === 'month') newStart = firstOfMonth(current.startDate);
                          return {
                            ...current,
                            startPrecision: precision,
                            startDate: newStart,
                            endDate: current.endDate < newStart ? newStart : current.endDate,
                          };
                        })}
                        className={`rounded-lg px-3 py-1 text-[11px] font-medium transition ${
                          form.startPrecision === precision
                            ? 'bg-white text-[var(--gray-950)] shadow-sm'
                            : 'text-[var(--gray-500)]'
                        }`}
                      >
                        {precision === 'day' ? 'Día' : precision === 'week' ? 'Semana' : 'Mes'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <Field label={form.startPrecision === 'day' ? 'Inicia el día' : form.startPrecision === 'week' ? 'Inicia la semana del' : 'Inicia en el mes'}>
                    {form.startPrecision === 'month' ? (
                      <input
                        type="month"
                        value={form.startDate.slice(0, 7)}
                        onChange={(event) => {
                          const nextStart = firstOfMonth(`${event.target.value}-01`);
                          setForm((current) => ({
                            ...current,
                            startDate: nextStart,
                            endDate: current.endDate < nextStart ? nextStart : current.endDate,
                          }));
                        }}
                        className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                      />
                    ) : (
                      <input
                        type="date"
                        value={form.startDate}
                        onChange={(event) => {
                          let nextStart = event.target.value;
                          if (form.startPrecision === 'week') nextStart = snapToMonday(nextStart);
                          setForm((current) => ({
                            ...current,
                            startDate: nextStart,
                            endDate: current.endDate < nextStart ? nextStart : current.endDate,
                          }));
                        }}
                        className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                      />
                    )}
                  </Field>
                  <Field label="Termina en">
                    <input
                      type="date"
                      value={form.endDate}
                      min={form.startDate}
                      onChange={(event) => setForm((current) => ({ ...current, endDate: event.target.value }))}
                      className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                    />
                  </Field>
                  <Field label="Frecuencia">
                    <select
                      value={form.frequency}
                      disabled={form.type === 'timing_shift' || form.type === 'pause_expense'}
                      onChange={(event) => setForm((current) => ({ ...current, frequency: event.target.value as SimulationFrequency }))}
                      className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px] disabled:bg-[var(--surface-alt)] disabled:text-[var(--gray-400)]"
                    >
                      {FREQUENCIES.map((frequency) => <option key={frequency.value} value={frequency.value}>{frequency.label}</option>)}
                    </select>
                  </Field>
                </div>
                {form.startPrecision === 'week' && (
                  <p className="text-[11px] text-[var(--gray-400)]">
                    El ajuste empieza el lunes {form.startDate}. Si eliges cualquier otro día se ajusta al inicio de esa semana.
                  </p>
                )}
              </div>

              {/* Scenario assignments */}
              <Field label="¿En qué escenarios aplica?">
                <div className="space-y-2">
                  <p className="text-[12px] text-[var(--gray-500)]">
                    Selecciona uno o varios escenarios para reutilizar este ajuste sin duplicarlo.
                  </p>
                  <div className="flex flex-wrap gap-2 rounded-xl border border-[var(--gray-200)] bg-[var(--surface-alt)] p-3">
                    {editableScenarios.map((scenario) => {
                      const selected = form.assignedScenarioIds.includes(scenario.id);
                      const label = scenarioLabelsById.get(scenario.id) ?? scenario.name;
                      return (
                        <button
                          key={scenario.id}
                          type="button"
                          onClick={() => toggleAssignedScenario(scenario.id)}
                          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium transition ${
                            selected
                              ? 'bg-[var(--primary)] text-white'
                              : 'bg-white text-[var(--gray-500)] border border-[var(--gray-200)]'
                          }`}
                        >
                          {selected && <Check className="w-3.5 h-3.5" />}
                          <span>{label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </Field>

              {/* Targets */}
              <Field label="¿A qué conceptos aplica?">
                <div className="flex flex-wrap gap-2 rounded-xl border border-[var(--gray-200)] bg-[var(--surface-alt)] p-3">
                  {targetConfig.options.map(opt => {
                    const selected = form.targetIds.includes(opt.id);
                    return (
                      <button
                        key={opt.id}
                        onClick={() => toggleTarget(opt.id)}
                        className={`rounded-full px-3 py-1.5 text-[11px] font-medium transition ${
                          selected
                            ? 'bg-[var(--primary)] text-white'
                            : 'bg-white text-[var(--gray-500)] border border-[var(--gray-200)]'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </Field>

              {/* Description */}
              <Field label="Descripción (opcional)">
                <textarea
                  value={form.description}
                  onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                  rows={2}
                  placeholder="Contexto, riesgos, supuestos..."
                  className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px] resize-none"
                />
              </Field>

              {/* Comments */}
              <Field label="Comentarios (opcional)">
                <textarea
                  value={form.comments}
                  onChange={e => setForm(p => ({ ...p, comments: e.target.value }))}
                  rows={2}
                  placeholder="Notas adicionales..."
                  className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px] resize-none"
                />
              </Field>
            </div>

            {/* Sticky save bar */}
            <div className="sticky bottom-0 bg-white border-t border-[var(--gray-100)] px-6 py-4 flex items-center justify-end gap-3">
              <button onClick={() => setPanelOpen(false)} className="rounded-xl border border-[var(--gray-200)] px-4 py-2.5 text-[13px] text-[var(--gray-500)]">
                Cancelar
              </button>
              <button
                onClick={saveAdjustment}
                disabled={!form.name.trim() || form.targetIds.length === 0 || form.assignedScenarioIds.length === 0}
                className="rounded-xl bg-[#1d1d1f] px-5 py-2.5 text-[13px] font-medium text-white disabled:opacity-40"
              >
                {editingId ? 'Guardar cambios' : 'Agregar ajuste'}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes slide-in-right {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        .animate-slide-in-right {
          animation: slide-in-right 0.25s ease-out;
        }
      `}</style>
    </div>
  );
}

/* ─── Small components ─── */

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-[var(--gray-200)]/60 bg-white px-2 py-0.5 text-[11px] text-[var(--gray-500)]">
      {children}
    </span>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--gray-400)]">{label}</span>
      {children}
    </label>
  );
}

function MetricRow({ label, values, tone }: { label: string; values: number[]; tone: 'pos' | 'neg' | 'neutral' | 'emphasis' | 'diff' }) {
  const color =
    tone === 'pos' ? 'text-[var(--success)]' :
    tone === 'neg' ? 'text-[var(--danger)]' :
    tone === 'emphasis' ? 'text-[var(--gray-950)] font-semibold' :
    tone === 'diff' ? 'text-[var(--primary)]' :
    'text-[var(--gray-500)]';

  return (
    <tr className="border-b border-[#f5f5f7]">
      <td className="sticky left-0 bg-white px-4 py-3 font-medium text-[var(--gray-950)]">{label}</td>
      {values.map((v, i) => (
        <td key={`${label}-${i}`} className={`px-2 py-3 text-right font-mono ${color}`}>
          {tone === 'diff' && v > 0 ? '+' : ''}{formatCurrency(v)}
        </td>
      ))}
    </tr>
  );
}
