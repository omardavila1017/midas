import { type ReactNode, useMemo, useState } from 'react';
import {
  ArrowRight,
  Check,
  CopyPlus,
  FolderTree,
  FlaskConical,
  Layers,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  BASE_SCENARIO_ID,
  BASE_SCENARIO_NAME,
  CATEGORY_COLORS,
  FlowPlan,
  MONTHS,
  Proposal,
  ROLE_TARGET_EXPENSE,
  ROLE_TARGET_INCOME,
  Scenario,
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
import { getSimulationTargetOptions, resolveConceptLabel } from '../domain/scenarioEngine';

interface ProposalCreatorProps {
  plan: FlowPlan;
  proposals: Proposal[];
  scenarios: Scenario[];
  simulations: Simulation[];
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

interface ProposalFormState {
  name: string;
  description: string;
  status: Proposal['status'];
}

interface ScenarioFormState {
  name: string;
  description: string;
  probability: number;
  startYearMonth: string;
  horizonMonths: number;
}

interface SimulationFormState {
  name: string;
  description: string;
  category: SimulationCategory;
  type: SimulationType;
  operation: SimulationOperation;
  targetIds: string[];
  startYearMonth: string;
  endYearMonth: string;
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

const PROPOSAL_STATUSES: Proposal['status'][] = ['Pendiente', 'En proceso', 'Aprobada', 'Descartada'];
const SCENARIO_PRESETS = ['Conservador', 'Realista', 'Optimista', 'Personalizado'];
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
const SIMULATION_TYPES: {
  value: SimulationType;
  label: string;
  description: string;
}[] = [
  {
    value: 'percent_adjustment',
    label: 'Ajuste porcentual',
    description: 'Aumenta o reduce ingresos, gastos, cobranza o pagos por un porcentaje.',
  },
  {
    value: 'amount_adjustment',
    label: 'Ajuste por monto',
    description: 'Agrega o quita un monto puntual o repetido a los conceptos elegidos.',
  },
  {
    value: 'recurring_series',
    label: 'Ingreso / gasto recurrente',
    description: 'Crea flujos mensuales, bimestrales o trimestrales durante un periodo.',
  },
  {
    value: 'installment_plan',
    label: 'Cobro / pago en parcialidades',
    description: 'Distribuye un monto total en 2, 3, 4 o más parcialidades.',
  },
  {
    value: 'timing_shift',
    label: 'Atrasar / adelantar',
    description: 'Mueve cobros o pagos existentes hacia adelante o hacia atrás en el calendario.',
  },
  {
    value: 'pause_expense',
    label: 'Pausar o eliminar gasto',
    description: 'Aplica una reducción del 100% al gasto seleccionado durante el periodo.',
  },
];

function now(): string {
  return new Date().toISOString();
}

function proposalDefaults(): ProposalFormState {
  return {
    name: '',
    description: '',
    status: 'Pendiente',
  };
}

function scenarioDefaults(plan: FlowPlan): ScenarioFormState {
  return {
    name: 'Conservador',
    description: '',
    probability: 100,
    startYearMonth: `${plan.year}-01`,
    horizonMonths: 12,
  };
}

function simulationDefaults(plan: FlowPlan): SimulationFormState {
  return {
    name: '',
    description: '',
    category: 'Incremento de Ingresos',
    type: 'percent_adjustment',
    operation: 'increase',
    targetIds: [ROLE_TARGET_INCOME],
    startYearMonth: `${plan.year}-01`,
    endYearMonth: `${plan.year}-12`,
    frequency: 'monthly',
    amount: 0,
    percent: 10,
    installments: 4,
    customAllocationText: '',
    shiftMonths: 1,
    shiftRatio: 100,
    paymentLabel: '',
    comments: '',
  };
}

function parseCustomAllocation(input: string): number[] | undefined {
  const values = input
    .split(',')
    .map((chunk) => Number(chunk.trim()))
    .filter((value) => !Number.isNaN(value) && value > 0);
  return values.length > 0 ? values : undefined;
}

function resolveSimulationTargetIds(simulation: Partial<Simulation>): string[] {
  const defaultTarget =
    simulation.category && simulation.category !== 'Incremento de Ingresos'
      ? ROLE_TARGET_EXPENSE
      : ROLE_TARGET_INCOME;
  return Array.isArray(simulation.targetIds) && simulation.targetIds.length > 0
    ? simulation.targetIds
    : [defaultTarget];
}

function buildSimulationFromForm(
  plan: FlowPlan,
  form: SimulationFormState,
  existing?: Simulation,
): Simulation {
  const timestamp = now();
  const simulationId = existing?.id ?? `simulation-${Date.now()}`;
  const simulation: Simulation = {
    id: simulationId,
    name: form.name.trim(),
    description: form.description.trim(),
    category: form.category,
    type: form.type,
    targetIds: form.targetIds,
    startYearMonth: form.startYearMonth,
    endYearMonth: form.type === 'installment_plan' || form.type === 'timing_shift' || form.type === 'pause_expense'
      ? form.endYearMonth
      : form.endYearMonth,
    frequency: form.type === 'timing_shift'
      ? 'monthly'
      : form.type === 'pause_expense'
        ? 'monthly'
        : form.frequency,
    operation: form.type === 'pause_expense' ? 'decrease' : form.operation,
    amount: form.type === 'percent_adjustment' || form.type === 'pause_expense' || form.type === 'timing_shift'
      ? undefined
      : form.amount,
    percent: form.type === 'percent_adjustment' ? form.percent / 100 : undefined,
    installments: form.type === 'installment_plan' ? form.installments : undefined,
    customAllocation: form.type === 'installment_plan'
      ? parseCustomAllocation(form.customAllocationText)
      : undefined,
    shiftMonths: form.type === 'timing_shift' ? form.shiftMonths : undefined,
    shiftRatio: form.type === 'timing_shift' ? form.shiftRatio / 100 : undefined,
    paymentLabel: form.paymentLabel.trim() || undefined,
    comments: form.comments.trim() || undefined,
    effects: [],
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };

  simulation.effects = buildSimulationEffects(plan, simulation);
  return simulation;
}

export default function ProposalCreator({
  plan,
  proposals,
  scenarios,
  simulations,
  activeProposalId,
  activeScenarioId,
  onSelectProposal,
  onSelectScenario,
  onAdd,
  onUpdate,
  onDelete,
  onAddScenario,
  onUpdateScenario,
  onDeleteScenario,
  onAddSimulation,
  onUpdateSimulation,
  onDeleteSimulation,
}: ProposalCreatorProps) {
  const [showProposalForm, setShowProposalForm] = useState(false);
  const [showScenarioForm, setShowScenarioForm] = useState(false);
  const [showSimulationForm, setShowSimulationForm] = useState(false);
  const [editingProposalId, setEditingProposalId] = useState<string | null>(null);
  const [editingScenarioId, setEditingScenarioId] = useState<string | null>(null);
  const [editingSimulationId, setEditingSimulationId] = useState<string | null>(null);
  const [proposalForm, setProposalForm] = useState<ProposalFormState>(proposalDefaults);
  const [scenarioForm, setScenarioForm] = useState<ScenarioFormState>(() => scenarioDefaults(plan));
  const [simulationForm, setSimulationForm] = useState<SimulationFormState>(() => simulationDefaults(plan));
  const [simulationSearch, setSimulationSearch] = useState('');

  const baseScenario = scenarios.find((scenario) => isBaseScenario(scenario)) ?? null;
  const activeProposal = proposals.find((proposal) => proposal.id === activeProposalId) ?? null;
  const activeScenario = scenarios.find((scenario) => scenario.id === activeScenarioId) ?? baseScenario ?? null;
  const proposalScenarios = scenarios
    .filter((scenario) => !isBaseScenario(scenario) && scenario.proposalId === activeProposalId)
    .sort((a, b) => a.name.localeCompare(b.name));
  const assignedSimulationIds = new Set(activeScenario?.simulationIds ?? []);
  const targetOptions = useMemo(() => getSimulationTargetOptions(plan), [plan]);
  const simulationTypeMeta = SIMULATION_TYPES.find((item) => item.value === simulationForm.type);

  const filteredSimulations = useMemo(() => {
    const query = simulationSearch.trim().toLowerCase();
    if (!query) return simulations;
    return simulations.filter((simulation) =>
      simulation.name.toLowerCase().includes(query) ||
      simulation.description.toLowerCase().includes(query) ||
      simulation.comments?.toLowerCase().includes(query),
    );
  }, [simulationSearch, simulations]);

  const openNewProposal = () => {
    setEditingProposalId(null);
    setProposalForm(proposalDefaults());
    setShowProposalForm(true);
  };

  const openEditProposal = (proposal: Proposal) => {
    setEditingProposalId(proposal.id);
    setProposalForm({
      name: proposal.name,
      description: proposal.description,
      status: proposal.status,
    });
    setShowProposalForm(true);
  };

  const saveProposal = () => {
    if (!proposalForm.name.trim()) return;
    const timestamp = now();

    if (editingProposalId) {
      const existing = proposals.find((proposal) => proposal.id === editingProposalId);
      if (!existing) return;
      onUpdate({
        ...existing,
        name: proposalForm.name.trim(),
        description: proposalForm.description.trim(),
        status: proposalForm.status,
        updatedAt: timestamp,
      });
      onSelectProposal(existing.id);
    } else {
      const proposalId = `proposal-${Date.now()}`;
      onAdd({
        id: proposalId,
        name: proposalForm.name.trim(),
        description: proposalForm.description.trim(),
        status: proposalForm.status,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      onSelectProposal(proposalId);
    }

    setShowProposalForm(false);
    setEditingProposalId(null);
    setProposalForm(proposalDefaults());
  };

  const openNewScenario = (preset?: string) => {
    setEditingScenarioId(null);
    setScenarioForm({
      ...scenarioDefaults(plan),
      name: preset ?? `Escenario ${proposalScenarios.length + 1}`,
    });
    setShowScenarioForm(true);
  };

  const openEditScenario = (scenario: Scenario) => {
    setEditingScenarioId(scenario.id);
    setScenarioForm({
      name: scenario.name,
      description: scenario.description,
      probability: Math.round(scenario.probability * 100),
      startYearMonth: scenario.startYearMonth,
      horizonMonths: scenario.horizonMonths,
    });
    setShowScenarioForm(true);
  };

  const saveScenario = () => {
    if (!activeProposal || !scenarioForm.name.trim()) return;
    const timestamp = now();

    if (editingScenarioId) {
      const existing = scenarios.find((scenario) => scenario.id === editingScenarioId);
      if (!existing || isBaseScenario(existing)) return;
      const updated: Scenario = {
        ...existing,
        name: scenarioForm.name.trim(),
        description: scenarioForm.description.trim(),
        probability: scenarioForm.probability / 100,
        startYearMonth: scenarioForm.startYearMonth,
        horizonMonths: scenarioForm.horizonMonths,
        updatedAt: timestamp,
      };
      onUpdateScenario(updated);
      onUpdate(cloneProposalWithActiveScenario(activeProposal, updated.id));
      onSelectScenario(updated.id);
    } else {
      const scenarioId = `scenario-${Date.now()}`;
      const created: Scenario = {
        id: scenarioId,
        proposalId: activeProposal.id,
        kind: 'proposal',
        name: scenarioForm.name.trim(),
        description: scenarioForm.description.trim(),
        probability: scenarioForm.probability / 100,
        startYearMonth: scenarioForm.startYearMonth,
        horizonMonths: scenarioForm.horizonMonths,
        simulationIds: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      onAddScenario(created);
      onUpdate(cloneProposalWithActiveScenario(activeProposal, created.id));
      onSelectScenario(scenarioId);
    }

    setShowScenarioForm(false);
    setEditingScenarioId(null);
    setScenarioForm(scenarioDefaults(plan));
  };

  const openNewSimulation = () => {
    setEditingSimulationId(null);
    setSimulationForm(simulationDefaults(plan));
    setShowSimulationForm(true);
  };

  const openEditSimulation = (simulation: Simulation) => {
    const targetIds = resolveSimulationTargetIds(simulation);
    setEditingSimulationId(simulation.id);
    setSimulationForm({
      name: simulation.name,
      description: simulation.description,
      category: simulation.category ?? 'Incremento de Ingresos',
      type: simulation.type ?? 'amount_adjustment',
      operation: simulation.operation ?? 'increase',
      targetIds,
      startYearMonth: simulation.startYearMonth ?? `${plan.year}-01`,
      endYearMonth: simulation.endYearMonth ?? simulation.startYearMonth ?? `${plan.year}-12`,
      frequency: simulation.frequency ?? 'monthly',
      amount: simulation.amount ?? 0,
      percent: Math.abs((simulation.percent ?? 0) * 100),
      installments: simulation.installments ?? 4,
      customAllocationText: simulation.customAllocation?.join(', ') ?? '',
      shiftMonths: simulation.shiftMonths ?? 1,
      shiftRatio: Math.round((simulation.shiftRatio ?? 1) * 100),
      paymentLabel: simulation.paymentLabel ?? '',
      comments: simulation.comments ?? '',
    });
    setShowSimulationForm(true);
  };

  const saveSimulation = () => {
    if (!simulationForm.name.trim() || simulationForm.targetIds.length === 0) return;
    const existing = editingSimulationId
      ? simulations.find((simulation) => simulation.id === editingSimulationId)
      : undefined;
    const simulation = buildSimulationFromForm(plan, simulationForm, existing);
    if (existing) onUpdateSimulation(simulation);
    else onAddSimulation(simulation);
    setShowSimulationForm(false);
    setEditingSimulationId(null);
    setSimulationForm(simulationDefaults(plan));
  };

  const toggleTarget = (targetId: string) => {
    setSimulationForm((current) => {
      const exists = current.targetIds.includes(targetId);
      return {
        ...current,
        targetIds: exists
          ? current.targetIds.filter((item) => item !== targetId)
          : [...current.targetIds, targetId],
      };
    });
  };

  const toggleSimulationAssignment = (simulationId: string) => {
    if (!activeScenario || isBaseScenario(activeScenario)) return;
    const exists = assignedSimulationIds.has(simulationId);
    const nextScenario: Scenario = {
      ...activeScenario,
      simulationIds: exists
        ? activeScenario.simulationIds.filter((id) => id !== simulationId)
        : [...activeScenario.simulationIds, simulationId],
      updatedAt: now(),
    };
    onUpdateScenario(nextScenario);
  };

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-[#d2d2d7]/50 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-6">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-[#86868b]">Cómo funciona</p>
            <h1 className="mt-1 text-[24px] font-semibold text-[#1d1d1f]">Simular decisiones sin perder el pronóstico original</h1>
            <p className="mt-2 max-w-[880px] text-[13px] text-[#6e6e73]">
              Siempre existe un <strong>Escenario Base</strong>. Desde ahí creas una propuesta, dentro de la propuesta un escenario,
              y dentro del escenario activas simulaciones. Cada cambio recalcula el forecast y siempre se compara contra el Base.
            </p>
          </div>
          <div className="rounded-2xl bg-[#f5f5f7] p-3">
            <Sparkles className="w-5 h-5 text-[#0071e3]" />
          </div>
        </div>

        <div className="mt-5 grid grid-cols-4 gap-3">
          <StepCard index="1" title="Ver Base" description="El pronóstico original siempre está visible y no se borra." />
          <StepCard index="2" title="Crear Propuesta" description="Agrupa una decisión financiera: ventas, gastos, equipos, pagos." />
          <StepCard index="3" title="Crear Escenario" description="Prueba variantes conservadoras, realistas, optimistas o personalizadas." />
          <StepCard index="4" title="Agregar Simulaciones" description="Activa reglas de negocio y compara el impacto contra Base." />
        </div>
      </div>

      <div className="grid grid-cols-[300px,minmax(0,1fr),420px] gap-5">
        <section className="rounded-2xl border border-[#d2d2d7]/50 bg-white p-4 shadow-sm space-y-3">
          <SectionHeader
            title="Base y Propuestas"
            subtitle="El Escenario Base se mantiene fijo. Las propuestas cuelgan aparte."
            actionLabel="Nueva propuesta"
            onAction={openNewProposal}
          />

          <button
            onClick={() => onSelectScenario(BASE_SCENARIO_ID)}
            className={`w-full rounded-2xl border px-4 py-4 text-left transition ${
              activeScenario?.id === BASE_SCENARIO_ID
                ? 'border-[#1d1d1f] bg-[#1d1d1f] text-white'
                : 'border-[#d2d2d7]/60 bg-[#fbfbfd] hover:bg-white'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[13px] font-semibold">{BASE_SCENARIO_NAME}</p>
                <p className={`mt-1 text-[11px] ${activeScenario?.id === BASE_SCENARIO_ID ? 'text-white/75' : 'text-[#86868b]'}`}>
                  Pronóstico original sin simulaciones ni overrides. Punto de comparación permanente.
                </p>
              </div>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                activeScenario?.id === BASE_SCENARIO_ID
                  ? 'bg-white/15 text-white'
                  : 'bg-[#f5f5f7] text-[#6e6e73]'
              }`}>
                Fijo
              </span>
            </div>
          </button>

          {showProposalForm && (
            <div className="rounded-2xl border border-[#d2d2d7]/60 bg-[#fbfbfd] p-3 space-y-3">
              <input
                value={proposalForm.name}
                onChange={(event) => setProposalForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Nombre de la propuesta"
                className="w-full rounded-xl border border-[#d2d2d7] bg-white px-3 py-2.5 text-[13px]"
              />
              <textarea
                value={proposalForm.description}
                onChange={(event) => setProposalForm((current) => ({ ...current, description: event.target.value }))}
                rows={3}
                placeholder="Qué decisión se quiere analizar"
                className="w-full rounded-xl border border-[#d2d2d7] bg-white px-3 py-2.5 text-[13px] resize-none"
              />
              <select
                value={proposalForm.status}
                onChange={(event) => setProposalForm((current) => ({ ...current, status: event.target.value as Proposal['status'] }))}
                className="w-full rounded-xl border border-[#d2d2d7] bg-white px-3 py-2.5 text-[13px]"
              >
                {PROPOSAL_STATUSES.map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
              <InlineActions
                onCancel={() => {
                  setShowProposalForm(false);
                  setEditingProposalId(null);
                  setProposalForm(proposalDefaults());
                }}
                onSave={saveProposal}
              />
            </div>
          )}

          <div className="space-y-2">
            {proposals.length === 0 && (
              <EmptyState
                title="Sin propuestas aún"
                description="Empieza creando una propuesta para abrir escenarios y simulaciones."
              />
            )}
            {proposals.map((proposal) => {
              const proposalScenarioCount = scenarios.filter((scenario) => scenario.proposalId === proposal.id).length;
              const selected = activeProposal?.id === proposal.id;
              return (
                <button
                  key={proposal.id}
                  onClick={() => onSelectProposal(proposal.id)}
                  className={`w-full rounded-xl border px-3 py-3 text-left transition ${
                    selected
                      ? 'border-[#0071e3] bg-[#e8f4fd]'
                      : 'border-[#d2d2d7]/50 bg-[#fbfbfd] hover:bg-white'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold text-[#1d1d1f]">{proposal.name}</p>
                      <p className="mt-1 line-clamp-2 text-[11px] text-[#86868b]">{proposal.description || 'Sin descripción'}</p>
                      <div className="mt-2 flex items-center gap-2 text-[11px] text-[#6e6e73]">
                        <span>{proposalScenarioCount} escenarios</span>
                        <span>•</span>
                        <span>{proposal.status}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          openEditProposal(proposal);
                        }}
                        className="rounded-lg p-1.5 text-[#86868b] hover:bg-white hover:text-[#1d1d1f]"
                        title="Editar propuesta"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          onDelete(proposal.id);
                        }}
                        className="rounded-lg p-1.5 text-[#86868b] hover:bg-white hover:text-[#ff3b30]"
                        title="Eliminar propuesta"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="rounded-2xl border border-[#d2d2d7]/50 bg-white p-4 shadow-sm space-y-3">
          <SectionHeader
            title="Escenarios"
            subtitle={activeProposal ? `Propuesta activa: ${activeProposal.name}` : 'Selecciona una propuesta para trabajar escenarios.'}
            actionLabel={activeProposal ? 'Nuevo escenario' : undefined}
            onAction={activeProposal ? () => openNewScenario() : undefined}
          />

          {activeProposal && (
            <div className="grid grid-cols-4 gap-2">
              {SCENARIO_PRESETS.map((preset) => (
                <button
                  key={preset}
                  onClick={() => openNewScenario(preset)}
                  className="rounded-xl border border-[#d2d2d7]/60 bg-[#fbfbfd] px-3 py-2 text-[12px] font-medium text-[#6e6e73] hover:bg-white hover:text-[#1d1d1f]"
                >
                  {preset}
                </button>
              ))}
            </div>
          )}

          {showScenarioForm && activeProposal && (
            <div className="rounded-2xl border border-[#d2d2d7]/60 bg-[#fbfbfd] p-3 space-y-3">
              <input
                value={scenarioForm.name}
                onChange={(event) => setScenarioForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Nombre del escenario"
                className="w-full rounded-xl border border-[#d2d2d7] bg-white px-3 py-2.5 text-[13px]"
              />
              <textarea
                value={scenarioForm.description}
                onChange={(event) => setScenarioForm((current) => ({ ...current, description: event.target.value }))}
                rows={3}
                placeholder="Hipótesis del escenario"
                className="w-full rounded-xl border border-[#d2d2d7] bg-white px-3 py-2.5 text-[13px] resize-none"
              />
              <div className="grid grid-cols-3 gap-3">
                <Field label="Probabilidad">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={scenarioForm.probability}
                    onChange={(event) => setScenarioForm((current) => ({ ...current, probability: Number(event.target.value) || 0 }))}
                    className="w-full rounded-xl border border-[#d2d2d7] bg-white px-3 py-2.5 text-[13px]"
                  />
                </Field>
                <Field label="Inicio">
                  <input
                    type="month"
                    value={scenarioForm.startYearMonth}
                    onChange={(event) => setScenarioForm((current) => ({ ...current, startYearMonth: event.target.value }))}
                    className="w-full rounded-xl border border-[#d2d2d7] bg-white px-3 py-2.5 text-[13px]"
                  />
                </Field>
                <Field label="Horizonte">
                  <input
                    type="number"
                    min={1}
                    max={24}
                    value={scenarioForm.horizonMonths}
                    onChange={(event) => setScenarioForm((current) => ({ ...current, horizonMonths: Number(event.target.value) || 12 }))}
                    className="w-full rounded-xl border border-[#d2d2d7] bg-white px-3 py-2.5 text-[13px]"
                  />
                </Field>
              </div>
              <InlineActions
                onCancel={() => {
                  setShowScenarioForm(false);
                  setEditingScenarioId(null);
                  setScenarioForm(scenarioDefaults(plan));
                }}
                onSave={saveScenario}
              />
            </div>
          )}

          {!activeProposal && (
            <EmptyState
              title="Primero elige una propuesta"
              description="Cada propuesta puede tener escenarios conservador, realista, optimista o personalizado."
            />
          )}

          {activeProposal && proposalScenarios.length === 0 && !showScenarioForm && (
            <EmptyState
              title="Sin escenarios"
              description="Crea el primer escenario para probar decisiones financieras sobre esta propuesta."
            />
          )}

          <div className="space-y-2">
            {proposalScenarios.map((scenario) => {
              const selected = activeScenario?.id === scenario.id;
              return (
                <button
                  key={scenario.id}
                  onClick={() => onSelectScenario(scenario.id)}
                  className={`w-full rounded-xl border px-3 py-3 text-left transition ${
                    selected
                      ? 'border-[#34c759] bg-[#e8faf0]'
                      : 'border-[#d2d2d7]/50 bg-[#fbfbfd] hover:bg-white'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-[13px] font-semibold text-[#1d1d1f]">{scenario.name}</p>
                        {selected && (
                          <span className="rounded-full bg-[#34c759]/15 px-2 py-0.5 text-[10px] font-medium text-[#248a3d]">Activo</span>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11px] text-[#86868b]">{scenario.description || 'Sin descripción'}</p>
                      <div className="mt-2 flex items-center gap-2 text-[11px] text-[#6e6e73]">
                        <span>{Math.round(scenario.probability * 100)}%</span>
                        <span>•</span>
                        <span>{scenario.simulationIds.length} simulaciones activas</span>
                        <span>•</span>
                        <span>{scenario.horizonMonths} meses</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          openEditScenario(scenario);
                        }}
                        className="rounded-lg p-1.5 text-[#86868b] hover:bg-white hover:text-[#1d1d1f]"
                        title="Editar escenario"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          onDeleteScenario(scenario.id);
                        }}
                        className="rounded-lg p-1.5 text-[#86868b] hover:bg-white hover:text-[#ff3b30]"
                        title="Eliminar escenario"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="rounded-2xl border border-[#d2d2d7]/50 bg-white p-4 shadow-sm space-y-3">
          <SectionHeader
            title="Biblioteca de Simulaciones"
            subtitle={isBaseScenario(activeScenario)
              ? 'Selecciona un escenario de propuesta para activar simulaciones.'
              : `Escenario activo: ${activeScenario?.name ?? '—'}`}
            actionLabel="Nueva simulación"
            onAction={openNewSimulation}
          />

          <input
            value={simulationSearch}
            onChange={(event) => setSimulationSearch(event.target.value)}
            placeholder="Buscar simulación..."
            className="w-full rounded-xl border border-[#d2d2d7] bg-[#fbfbfd] px-3 py-2.5 text-[13px]"
          />

          {showSimulationForm && (
            <div className="rounded-2xl border border-[#d2d2d7]/60 bg-[#fbfbfd] p-3 space-y-3">
              <input
                value={simulationForm.name}
                onChange={(event) => setSimulationForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Nombre de la simulación"
                className="w-full rounded-xl border border-[#d2d2d7] bg-white px-3 py-2.5 text-[13px]"
              />
              <textarea
                value={simulationForm.description}
                onChange={(event) => setSimulationForm((current) => ({ ...current, description: event.target.value }))}
                rows={3}
                placeholder="Describe la decisión financiera"
                className="w-full rounded-xl border border-[#d2d2d7] bg-white px-3 py-2.5 text-[13px] resize-none"
              />

              <div className="grid grid-cols-2 gap-3">
                <Field label="Tipo de simulación">
                  <select
                    value={simulationForm.type}
                    onChange={(event) => setSimulationForm((current) => ({ ...current, type: event.target.value as SimulationType }))}
                    className="w-full rounded-xl border border-[#d2d2d7] bg-white px-3 py-2.5 text-[13px]"
                  >
                    {SIMULATION_TYPES.map((item) => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Categoría">
                  <select
                    value={simulationForm.category}
                    onChange={(event) => setSimulationForm((current) => ({ ...current, category: event.target.value as SimulationCategory }))}
                    className="w-full rounded-xl border border-[#d2d2d7] bg-white px-3 py-2.5 text-[13px]"
                  >
                    {SIMULATION_CATEGORIES.map((category) => (
                      <option key={category} value={category}>{category}</option>
                    ))}
                  </select>
                </Field>
              </div>

              {simulationTypeMeta && (
                <div className="rounded-xl bg-white p-3 text-[12px] text-[#6e6e73]">
                  <p className="font-medium text-[#1d1d1f]">{simulationTypeMeta.label}</p>
                  <p className="mt-1">{simulationTypeMeta.description}</p>
                </div>
              )}

              {!['timing_shift', 'pause_expense'].includes(simulationForm.type) && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Operación">
                    <select
                      value={simulationForm.operation}
                      onChange={(event) => setSimulationForm((current) => ({ ...current, operation: event.target.value as SimulationOperation }))}
                      className="w-full rounded-xl border border-[#d2d2d7] bg-white px-3 py-2.5 text-[13px]"
                    >
                      <option value="increase">Incrementar / Agregar</option>
                      <option value="decrease">Reducir / Quitar</option>
                    </select>
                  </Field>
                  <Field label={simulationForm.type === 'percent_adjustment' ? 'Porcentaje' : 'Monto'}>
                    <input
                      type="number"
                      step={simulationForm.type === 'percent_adjustment' ? 1 : 0.01}
                      value={simulationForm.type === 'percent_adjustment' ? simulationForm.percent : simulationForm.amount}
                      onChange={(event) => setSimulationForm((current) => (
                        simulationForm.type === 'percent_adjustment'
                          ? { ...current, percent: Number(event.target.value) || 0 }
                          : { ...current, amount: Number(event.target.value) || 0 }
                      ))}
                      className="w-full rounded-xl border border-[#d2d2d7] bg-white px-3 py-2.5 text-[13px]"
                    />
                  </Field>
                </div>
              )}

              {simulationForm.type === 'timing_shift' && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Mover meses">
                    <input
                      type="number"
                      min={-12}
                      max={12}
                      value={simulationForm.shiftMonths}
                      onChange={(event) => setSimulationForm((current) => ({ ...current, shiftMonths: Number(event.target.value) || 0 }))}
                      className="w-full rounded-xl border border-[#d2d2d7] bg-white px-3 py-2.5 text-[13px]"
                    />
                  </Field>
                  <Field label="% del flujo a mover">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={simulationForm.shiftRatio}
                      onChange={(event) => setSimulationForm((current) => ({ ...current, shiftRatio: Number(event.target.value) || 0 }))}
                      className="w-full rounded-xl border border-[#d2d2d7] bg-white px-3 py-2.5 text-[13px]"
                    />
                  </Field>
                </div>
              )}

              {simulationForm.type === 'installment_plan' && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Monto total">
                      <input
                        type="number"
                        step={0.01}
                        value={simulationForm.amount}
                        onChange={(event) => setSimulationForm((current) => ({ ...current, amount: Number(event.target.value) || 0 }))}
                        className="w-full rounded-xl border border-[#d2d2d7] bg-white px-3 py-2.5 text-[13px]"
                      />
                    </Field>
                    <Field label="Parcialidades">
                      <input
                        type="number"
                        min={2}
                        max={24}
                        value={simulationForm.installments}
                        onChange={(event) => setSimulationForm((current) => ({ ...current, installments: Number(event.target.value) || 2 }))}
                        className="w-full rounded-xl border border-[#d2d2d7] bg-white px-3 py-2.5 text-[13px]"
                      />
                    </Field>
                  </div>
                  <Field label="Porcentajes personalizados (opcional)">
                    <input
                      value={simulationForm.customAllocationText}
                      onChange={(event) => setSimulationForm((current) => ({ ...current, customAllocationText: event.target.value }))}
                      placeholder="Ej. 25, 25, 25, 25"
                      className="w-full rounded-xl border border-[#d2d2d7] bg-white px-3 py-2.5 text-[13px]"
                    />
                  </Field>
                </div>
              )}

              {simulationForm.type !== 'pause_expense' && (
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Inicio">
                    <input
                      type="month"
                      value={simulationForm.startYearMonth}
                      onChange={(event) => setSimulationForm((current) => ({ ...current, startYearMonth: event.target.value }))}
                      className="w-full rounded-xl border border-[#d2d2d7] bg-white px-3 py-2.5 text-[13px]"
                    />
                  </Field>
                  <Field label="Fin">
                    <input
                      type="month"
                      value={simulationForm.endYearMonth}
                      onChange={(event) => setSimulationForm((current) => ({ ...current, endYearMonth: event.target.value }))}
                      className="w-full rounded-xl border border-[#d2d2d7] bg-white px-3 py-2.5 text-[13px]"
                    />
                  </Field>
                  <Field label="Frecuencia">
                    <select
                      value={simulationForm.frequency}
                      onChange={(event) => setSimulationForm((current) => ({ ...current, frequency: event.target.value as SimulationFrequency }))}
                      className="w-full rounded-xl border border-[#d2d2d7] bg-white px-3 py-2.5 text-[13px]"
                    >
                      {FREQUENCIES.map((frequency) => (
                        <option key={frequency.value} value={frequency.value}>{frequency.label}</option>
                      ))}
                    </select>
                  </Field>
                </div>
              )}

              <Field label="Forma de cobro / pago (opcional)">
                <input
                  value={simulationForm.paymentLabel}
                  onChange={(event) => setSimulationForm((current) => ({ ...current, paymentLabel: event.target.value }))}
                  placeholder="Ej. 4 pagos mensuales, anticipo 30%, contraentrega..."
                  className="w-full rounded-xl border border-[#d2d2d7] bg-white px-3 py-2.5 text-[13px]"
                />
              </Field>

              <Field label="Categorías o conceptos afectados">
                <div className="flex flex-wrap gap-2 rounded-xl border border-[#d2d2d7] bg-white p-2">
                  {targetOptions.map((target) => {
                    const selected = simulationForm.targetIds.includes(target.id);
                    return (
                      <button
                        key={target.id}
                        onClick={() => toggleTarget(target.id)}
                        className={`rounded-full px-3 py-1.5 text-[11px] font-medium transition ${
                          selected
                            ? 'bg-[#0071e3] text-white'
                            : 'bg-[#f5f5f7] text-[#6e6e73]'
                        }`}
                      >
                        {target.label}
                      </button>
                    );
                  })}
                </div>
              </Field>

              <Field label="Comentarios o justificación">
                <textarea
                  value={simulationForm.comments}
                  onChange={(event) => setSimulationForm((current) => ({ ...current, comments: event.target.value }))}
                  rows={3}
                  placeholder="Contexto, riesgos, supuestos..."
                  className="w-full rounded-xl border border-[#d2d2d7] bg-white px-3 py-2.5 text-[13px] resize-none"
                />
              </Field>

              <InlineActions
                onCancel={() => {
                  setShowSimulationForm(false);
                  setEditingSimulationId(null);
                  setSimulationForm(simulationDefaults(plan));
                }}
                onSave={saveSimulation}
              />
            </div>
          )}

          <div className="space-y-2 max-h-[760px] overflow-y-auto pr-1">
            {filteredSimulations.length === 0 && (
              <EmptyState
                title="Sin simulaciones"
                description="Crea reglas reutilizables como aumento de ventas, retraso en cobranza o cobro en parcialidades."
              />
            )}

            {filteredSimulations.map((simulation) => {
              const selected = assignedSimulationIds.has(simulation.id);
              const targetIds = resolveSimulationTargetIds(simulation);
              const targetLabel = targetIds
                .slice(0, 2)
                .map((id) => resolveConceptLabel(plan, id))
                .join(', ');
              return (
                <div
                  key={simulation.id}
                  className={`rounded-xl border px-3 py-3 transition ${
                    selected
                      ? 'border-[#0071e3]/30 bg-[#e8f4fd]/70'
                      : 'border-[#d2d2d7]/50 bg-[#fbfbfd]'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <button
                      onClick={() => toggleSimulationAssignment(simulation.id)}
                      disabled={isBaseScenario(activeScenario)}
                      className={`mt-0.5 flex h-5 w-5 items-center justify-center rounded-md border transition ${
                        selected
                          ? 'border-[#0071e3] bg-[#0071e3] text-white'
                          : 'border-[#d2d2d7] bg-white text-transparent'
                      } ${isBaseScenario(activeScenario) ? 'cursor-not-allowed opacity-50' : ''}`}
                      title={isBaseScenario(activeScenario) ? 'Selecciona un escenario de propuesta' : 'Activar / desactivar simulación'}
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: CATEGORY_COLORS[simulation.category] }} />
                        <p className="truncate text-[13px] font-semibold text-[#1d1d1f]">{simulation.name}</p>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11px] text-[#86868b]">{simulation.description || 'Sin descripción'}</p>
                      <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-[#6e6e73]">
                        <Badge>{SIMULATION_TYPES.find((item) => item.value === simulation.type)?.label ?? 'Simulación'}</Badge>
                        <Badge>{simulation.operation === 'decrease' ? 'Reducir' : 'Incrementar'}</Badge>
                        <Badge>{targetLabel}{targetIds.length > 2 ? ' +' : ''}</Badge>
                        {simulation.percent !== undefined && <Badge>{Math.round(Math.abs(simulation.percent) * 100)}%</Badge>}
                        {simulation.amount !== undefined && <Badge>{simulation.amount}</Badge>}
                        {simulation.installments && <Badge>{simulation.installments} parcialidades</Badge>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => openEditSimulation(simulation)}
                        className="rounded-lg p-1.5 text-[#86868b] hover:bg-white hover:text-[#1d1d1f]"
                        title="Editar simulación"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => onDeleteSimulation(simulation.id)}
                        className="rounded-lg p-1.5 text-[#86868b] hover:bg-white hover:text-[#ff3b30]"
                        title="Eliminar simulación"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

function StepCard({
  index,
  title,
  description,
}: {
  index: string;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-2xl border border-[#d2d2d7]/50 bg-[#fbfbfd] p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="rounded-full bg-white px-2 py-1 text-[11px] font-semibold text-[#0071e3]">{index}</span>
        <ArrowRight className="w-4 h-4 text-[#c7c7cc]" />
      </div>
      <p className="text-[13px] font-semibold text-[#1d1d1f]">{title}</p>
      <p className="mt-1 text-[12px] text-[#6e6e73]">{description}</p>
    </div>
  );
}

function SectionHeader({
  title,
  subtitle,
  actionLabel,
  onAction,
}: {
  title: string;
  subtitle: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h2 className="text-[15px] font-semibold text-[#1d1d1f]">{title}</h2>
        <p className="mt-1 text-[12px] text-[#86868b]">{subtitle}</p>
      </div>
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          className="inline-flex items-center gap-1 rounded-full bg-[#0071e3] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#0077ed]"
        >
          <Plus className="w-3.5 h-3.5" />
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-[#86868b]">{label}</span>
      {children}
    </label>
  );
}

function InlineActions({
  onCancel,
  onSave,
}: {
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-2">
      <button
        onClick={onCancel}
        className="rounded-xl border border-[#d2d2d7] bg-white px-3 py-2 text-[12px] text-[#6e6e73]"
      >
        Cancelar
      </button>
      <button
        onClick={onSave}
        className="rounded-xl bg-[#1d1d1f] px-3 py-2 text-[12px] font-medium text-white"
      >
        Guardar
      </button>
    </div>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-[#d2d2d7] bg-[#fbfbfd] px-4 py-8 text-center">
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-2xl bg-white border border-[#d2d2d7]/60">
        <CopyPlus className="w-4 h-4 text-[#86868b]" />
      </div>
      <p className="text-[13px] font-medium text-[#1d1d1f]">{title}</p>
      <p className="mt-1 text-[12px] text-[#86868b]">{description}</p>
    </div>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-[#d2d2d7]/60 bg-white px-2 py-0.5">
      {children}
    </span>
  );
}
