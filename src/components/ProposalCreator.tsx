import { type ReactNode, useEffect, useMemo, useState } from 'react';
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
import { hex } from '../theme';
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
import { resolveConceptLabel } from '../domain/scenarioEngine';

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
  startDate: string;
  endDate: string;
  startPrecision: 'day' | 'week' | 'month';
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
    startDate: `${plan.year}-01-01`,
    endDate: `${plan.year}-12-31`,
    startPrecision: 'month',
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

function snapToMonday(dateIso: string): string {
  const d = new Date(`${dateIso}T12:00:00Z`);
  const day = d.getUTCDay(); // 0=Sun
  const offset = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function firstOfMonth(dateIso: string): string {
  return `${dateIso.slice(0, 7)}-01`;
}

function parseCustomAllocation(input: string): number[] | undefined {
  const values = input
    .split(',')
    .map((chunk) => Number(chunk.trim()))
    .filter((value) => !Number.isNaN(value) && value > 0);
  return values.length > 0 ? values : undefined;
}

function formatYearMonthLabel(yearMonth: string): string {
  const [yearRaw, monthRaw] = yearMonth.split('-');
  const year = Number(yearRaw);
  const monthIndex = Math.max(0, Math.min(11, (Number(monthRaw) || 1) - 1));
  return `${MONTHS[monthIndex]} ${String(year).slice(2)}`;
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

function resolveSimulationTargetIds(simulation: Partial<Simulation>): string[] {
  const defaultTarget =
    simulation.category && simulation.category !== 'Incremento de Ingresos'
      ? ROLE_TARGET_EXPENSE
      : ROLE_TARGET_INCOME;
  return Array.isArray(simulation.targetIds) && simulation.targetIds.length > 0
    ? simulation.targetIds
    : [defaultTarget];
}

interface DynamicTargetOption {
  id: string;
  label: string;
}

interface DynamicTargetConfig {
  label: string;
  helper: string;
  options: DynamicTargetOption[];
  defaultTargetIds: string[];
}

function buildLeafConceptOptions(
  plan: FlowPlan,
  conceptType: 'ingreso' | 'egreso',
): DynamicTargetOption[] {
  const parentIds = new Set(
    plan.concepts
      .map((concept) => concept.parentId)
      .filter((value): value is string => Boolean(value)),
  );

  return plan.concepts
    .filter((concept) =>
      concept.conceptType === conceptType &&
      !parentIds.has(concept.id),
    )
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((concept) => ({
      id: concept.id,
      label: concept.name,
    }));
}

function buildDynamicTargetConfig(
  plan: FlowPlan,
  form: Pick<SimulationFormState, 'type' | 'category'>,
): DynamicTargetConfig {
  const incomeOptions: DynamicTargetOption[] = [
    { id: ROLE_TARGET_INCOME, label: 'Todos los ingresos' },
    ...buildLeafConceptOptions(plan, 'ingreso'),
  ];
  const expenseOptions: DynamicTargetOption[] = [
    { id: ROLE_TARGET_EXPENSE, label: 'Todos los gastos' },
    ...buildLeafConceptOptions(plan, 'egreso'),
  ];
  const collectionOptions: DynamicTargetOption[] = [
    { id: ROLE_TARGET_COLLECTIONS, label: 'Toda la cobranza' },
    ...buildLeafConceptOptions(plan, 'ingreso'),
  ];
  const paymentOptions: DynamicTargetOption[] = [
    { id: ROLE_TARGET_PROVIDER_PAYMENTS, label: 'Todos los pagos a proveedores' },
    ...buildLeafConceptOptions(plan, 'egreso'),
  ];
  const mixedOptions = [...incomeOptions, ...expenseOptions];

  if (form.type === 'pause_expense') {
    return {
      label: '¿Qué gastos quieres pausar?',
      helper: 'Selecciona uno o varios rubros de gasto que quieres detener temporalmente.',
      options: expenseOptions,
      defaultTargetIds: [ROLE_TARGET_EXPENSE],
    };
  }

  if (form.type === 'timing_shift') {
    if (form.category === 'Incremento de Ingresos') {
      return {
        label: '¿Qué cobranza quieres mover?',
        helper: 'Úsalo para adelantar o atrasar cobros de uno o varios ingresos.',
        options: collectionOptions,
        defaultTargetIds: [ROLE_TARGET_COLLECTIONS],
      };
    }

    if (form.category === 'Reducción de Costos') {
      return {
        label: '¿Qué pagos quieres mover?',
        helper: 'Úsalo para adelantar o diferir pagos a proveedores o gastos específicos.',
        options: paymentOptions,
        defaultTargetIds: [ROLE_TARGET_PROVIDER_PAYMENTS],
      };
    }

    return {
      label: '¿Qué flujo quieres mover?',
      helper: 'Selecciona si vas a mover cobranza, pagos o conceptos específicos.',
      options: [...collectionOptions, ...paymentOptions],
      defaultTargetIds: [ROLE_TARGET_COLLECTIONS],
    };
  }

  if (form.type === 'installment_plan') {
    if (form.category === 'Incremento de Ingresos') {
      return {
        label: '¿Qué ingresos quieres cobrar en parcialidades?',
        helper: 'Selecciona uno o varios ingresos y reparte el monto en varios cobros.',
        options: incomeOptions,
        defaultTargetIds: [ROLE_TARGET_INCOME],
      };
    }

    return {
      label: '¿Qué gastos quieres pagar en parcialidades?',
      helper: 'Selecciona uno o varios gastos y reparte el monto en varios pagos.',
      options: expenseOptions,
      defaultTargetIds: [ROLE_TARGET_EXPENSE],
    };
  }

  if (form.category === 'Incremento de Ingresos') {
    return {
      label: '¿Qué tipos de ingreso quieres ajustar?',
      helper: 'Puedes seleccionar un ingreso específico o aplicar el ajuste a todos los ingresos.',
      options: incomeOptions,
      defaultTargetIds: [ROLE_TARGET_INCOME],
    };
  }

  if (form.category === 'Reducción de Costos') {
    return {
      label: '¿Qué tipos de gasto quieres ajustar?',
      helper: 'Puedes seleccionar un gasto específico o aplicar el ajuste a todos los gastos.',
      options: expenseOptions,
      defaultTargetIds: [ROLE_TARGET_EXPENSE],
    };
  }

  return {
    label: '¿Qué conceptos quieres ajustar?',
    helper: 'Selecciona uno o varios conceptos sobre los que quieras aplicar la propuesta.',
    options: mixedOptions,
    defaultTargetIds: [ROLE_TARGET_INCOME],
  };
}

function buildSimulationFromForm(
  plan: FlowPlan,
  form: SimulationFormState,
  existing?: Simulation,
): Simulation {
  const timestamp = now();
  const simulationId = existing?.id ?? `simulation-${Date.now()}`;
  const startDate = form.startDate;
  const safeEndDate = form.endDate < startDate ? startDate : form.endDate;
  const simulation: Simulation = {
    id: simulationId,
    name: form.name.trim(),
    description: form.description.trim(),
    category: form.category,
    type: form.type,
    targetIds: form.targetIds,
    startYearMonth: yearMonthFromDate(startDate),
    endYearMonth: yearMonthFromDate(safeEndDate),
    startDate,
    endDate: safeEndDate,
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
  const dynamicTargetConfig = useMemo(
    () => buildDynamicTargetConfig(plan, simulationForm),
    [plan, simulationForm.type, simulationForm.category],
  );
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
  const proposalPreview = useMemo(() => {
    const targetLabel = simulationForm.targetIds
      .slice(0, 2)
      .map((id) => resolveConceptLabel(plan, id))
      .join(', ');
    const targetSuffix = simulationForm.targetIds.length > 2 ? ' y más' : '';

    if (simulationForm.type === 'percent_adjustment') {
      return `${simulationForm.operation === 'decrease' ? 'Reducir' : 'Incrementar'} ${targetLabel || 'los conceptos elegidos'}${targetSuffix} en ${simulationForm.percent}% desde ${formatDateLabel(simulationForm.startDate)} hasta ${formatDateLabel(simulationForm.endDate)}.`;
    }

    if (simulationForm.type === 'amount_adjustment') {
      return `${simulationForm.operation === 'decrease' ? 'Reducir' : 'Agregar'} ${simulationForm.amount} a ${targetLabel || 'los conceptos elegidos'}${targetSuffix} con frecuencia ${FREQUENCIES.find((item) => item.value === simulationForm.frequency)?.label.toLowerCase() ?? 'mensual'}.`;
    }

    if (simulationForm.type === 'recurring_series') {
      return `Crear un flujo recurrente de ${simulationForm.amount} sobre ${targetLabel || 'los conceptos elegidos'}${targetSuffix} desde ${formatDateLabel(simulationForm.startDate)}.`;
    }

    if (simulationForm.type === 'installment_plan') {
      return `Distribuir ${simulationForm.amount} en ${simulationForm.installments} parcialidades para ${targetLabel || 'los conceptos elegidos'}${targetSuffix}.`;
    }

    if (simulationForm.type === 'timing_shift') {
      return `Mover ${simulationForm.shiftRatio}% del flujo de ${targetLabel || 'los conceptos elegidos'}${targetSuffix} ${simulationForm.shiftMonths >= 0 ? `${simulationForm.shiftMonths} meses hacia adelante` : `${Math.abs(simulationForm.shiftMonths)} meses hacia atrás`}.`;
    }

    return `Pausar ${targetLabel || 'los conceptos elegidos'}${targetSuffix} desde ${formatDateLabel(simulationForm.startDate)} hasta ${formatDateLabel(simulationForm.endDate)}.`;
  }, [plan, simulationForm]);

  useEffect(() => {
    const allowedTargetIds = new Set(dynamicTargetConfig.options.map((option) => option.id));
    setSimulationForm((current) => {
      const nextTargetIds = current.targetIds.filter((targetId) => allowedTargetIds.has(targetId));
      const resolvedTargetIds = nextTargetIds.length > 0
        ? nextTargetIds
        : dynamicTargetConfig.defaultTargetIds;

      if (
        resolvedTargetIds.length === current.targetIds.length &&
        resolvedTargetIds.every((targetId, index) => targetId === current.targetIds[index])
      ) {
        return current;
      }

      return {
        ...current,
        targetIds: resolvedTargetIds,
      };
    });
  }, [dynamicTargetConfig]);

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
      startDate: simulation.startDate ?? `${simulation.startYearMonth ?? `${plan.year}-01`}-01`,
      endDate: simulation.endDate ?? endOfMonthFromDate(`${simulation.endYearMonth ?? simulation.startYearMonth ?? `${plan.year}-12`}-01`),
      startPrecision: 'month',
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
      const allowedTargetIds = new Set(dynamicTargetConfig.options.map((option) => option.id));
      if (!allowedTargetIds.has(targetId)) return current;

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
      <div className="rounded-2xl border border-[var(--gray-200)]/50 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-6">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Cómo funciona</p>
            <h1 className="mt-1 text-[24px] font-semibold text-[var(--gray-950)]">Simular decisiones sin perder el pronóstico original</h1>
            <p className="mt-2 max-w-[880px] text-[13px] text-[var(--gray-500)]">
              Siempre existe un <strong>Escenario Base</strong>. Desde ahí creas una <strong>simulación</strong>, dentro de esa simulación
              guardas uno o varios <strong>escenarios</strong>, y a cada escenario le asignas <strong>propuestas</strong> que actúan como ajustes financieros.
              Cada cambio recalcula el forecast y siempre se compara contra el Base.
            </p>
          </div>
          <div className="rounded-2xl bg-[var(--gray-50)] p-3">
            <Sparkles className="w-5 h-5 text-[var(--primary)]" />
          </div>
        </div>

        <div className="mt-5 grid grid-cols-4 gap-3">
          <StepCard index="1" title="Ver Base" description="El pronóstico original siempre está visible y no se borra." />
          <StepCard index="2" title="Crear Simulación" description="Define el contenedor donde vas a guardar y correr distintos escenarios." />
          <StepCard index="3" title="Crear Escenario" description="Agrupa varias propuestas financieras en una hipótesis guardada." />
          <StepCard index="4" title="Agregar Propuestas" description="Activa ajustes reutilizables y compara el impacto contra Base." />
        </div>
      </div>

      <div className="rounded-2xl border border-[#d2d2d7]/50 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-3 gap-3">
          <ContextPill
            step="Paso 1"
            title="Simulación"
            value={activeProposal?.name ?? 'Elige o crea una simulación'}
            helper="Es el contenedor donde guardas el análisis."
          />
          <ContextPill
            step="Paso 2"
            title="Escenario"
            value={activeScenario && !isBaseScenario(activeScenario) ? activeScenario.name : 'Elige o crea un escenario'}
            helper="Cada escenario junta propuestas distintas."
          />
          <ContextPill
            step="Paso 3"
            title="Propuestas"
            value={isBaseScenario(activeScenario) ? '0 propuestas activas' : `${assignedSimulationIds.size} propuestas activas`}
            helper="Marca las propuestas que quieres aplicar."
          />
        </div>
      </div>

      <div className="grid grid-cols-[300px,minmax(0,1fr),420px] gap-5">
        <section className="rounded-2xl border border-[var(--gray-200)]/50 bg-white p-4 shadow-sm space-y-3">
          <SectionHeader
            stepLabel="Paso 1"
            title="Base y Simulaciones"
            subtitle="El Escenario Base se mantiene fijo. Las simulaciones agrupan escenarios."
            actionLabel="Nueva simulación"
            onAction={openNewProposal}
          />

          <button
            onClick={() => onSelectScenario(BASE_SCENARIO_ID)}
            className={`w-full rounded-2xl border px-4 py-4 text-left transition ${
              activeScenario?.id === BASE_SCENARIO_ID
                ? 'border-[#1d1d1f] bg-[#1d1d1f] text-white'
                : 'border-[var(--gray-200)]/60 bg-[var(--surface-alt)] hover:bg-white'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[13px] font-semibold">{BASE_SCENARIO_NAME}</p>
                <p className={`mt-1 text-[11px] ${activeScenario?.id === BASE_SCENARIO_ID ? 'text-white/75' : 'text-[var(--gray-400)]'}`}>
                  Pronóstico original sin propuestas aplicadas ni overrides. Punto de comparación permanente.
                </p>
              </div>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                activeScenario?.id === BASE_SCENARIO_ID
                  ? 'bg-white/15 text-white'
                  : 'bg-[var(--gray-50)] text-[var(--gray-500)]'
              }`}>
                Fijo
              </span>
            </div>
          </button>

          {showProposalForm && (
            <div className="rounded-2xl border border-[var(--gray-200)]/60 bg-[var(--surface-alt)] p-3 space-y-3">
              <input
                value={proposalForm.name}
                onChange={(event) => setProposalForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Nombre de la simulación"
                className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
              />
              <textarea
                value={proposalForm.description}
                onChange={(event) => setProposalForm((current) => ({ ...current, description: event.target.value }))}
                rows={3}
                placeholder="Qué iniciativa o análisis quieres correr"
                className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px] resize-none"
              />
              <select
                value={proposalForm.status}
                onChange={(event) => setProposalForm((current) => ({ ...current, status: event.target.value as Proposal['status'] }))}
                className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
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
                title="Sin simulaciones aún"
                description="Empieza creando una simulación para abrir escenarios y correr propuestas."
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
                      ? 'border-[var(--primary)] bg-[var(--primary-muted)]'
                      : 'border-[var(--gray-200)]/50 bg-[var(--surface-alt)] hover:bg-white'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold text-[var(--gray-950)]">{proposal.name}</p>
                      <p className="mt-1 line-clamp-2 text-[11px] text-[var(--gray-400)]">{proposal.description || 'Sin descripción'}</p>
                      <div className="mt-2 flex items-center gap-2 text-[11px] text-[var(--gray-500)]">
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
                        className="rounded-lg p-1.5 text-[var(--gray-400)] hover:bg-white hover:text-[var(--gray-950)]"
                        title="Editar simulación"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          onDelete(proposal.id);
                        }}
                        className="rounded-lg p-1.5 text-[var(--gray-400)] hover:bg-white hover:text-[#ff3b30]"
                        title="Eliminar simulación"
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

        <section className="rounded-2xl border border-[var(--gray-200)]/50 bg-white p-4 shadow-sm space-y-3">
          <SectionHeader
            stepLabel="Paso 2"
            title="Escenarios"
            subtitle={activeProposal ? `Simulación activa: ${activeProposal.name}` : 'Selecciona una simulación para trabajar escenarios.'}
            actionLabel={activeProposal ? 'Nuevo escenario' : undefined}
            onAction={activeProposal ? () => openNewScenario() : undefined}
          />

          {activeProposal && (
            <div className="grid grid-cols-4 gap-2">
              {SCENARIO_PRESETS.map((preset) => (
                <button
                  key={preset}
                  onClick={() => openNewScenario(preset)}
                  className="rounded-xl border border-[var(--gray-200)]/60 bg-[var(--surface-alt)] px-3 py-2 text-[12px] font-medium text-[var(--gray-500)] hover:bg-white hover:text-[var(--gray-950)]"
                >
                  {preset}
                </button>
              ))}
            </div>
          )}

          {showScenarioForm && activeProposal && (
            <div className="rounded-2xl border border-[var(--gray-200)]/60 bg-[var(--surface-alt)] p-3 space-y-3">
              <input
                value={scenarioForm.name}
                onChange={(event) => setScenarioForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Nombre del escenario"
                className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
              />
              <textarea
                value={scenarioForm.description}
                onChange={(event) => setScenarioForm((current) => ({ ...current, description: event.target.value }))}
                rows={3}
                placeholder="Hipótesis del escenario"
                className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px] resize-none"
              />
              <div className="grid grid-cols-3 gap-3">
                <Field label="Probabilidad">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={scenarioForm.probability}
                    onChange={(event) => setScenarioForm((current) => ({ ...current, probability: Number(event.target.value) || 0 }))}
                    className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                  />
                </Field>
                <Field label="Inicio">
                  <input
                    type="month"
                    value={scenarioForm.startYearMonth}
                    onChange={(event) => setScenarioForm((current) => ({ ...current, startYearMonth: event.target.value }))}
                    className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                  />
                </Field>
                <Field label="Horizonte">
                  <input
                    type="number"
                    min={1}
                    max={24}
                    value={scenarioForm.horizonMonths}
                    onChange={(event) => setScenarioForm((current) => ({ ...current, horizonMonths: Number(event.target.value) || 12 }))}
                    className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
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
              title="Primero elige una simulación"
              description="Cada simulación puede tener escenarios conservador, realista, optimista o personalizado."
            />
          )}

          {activeProposal && proposalScenarios.length === 0 && !showScenarioForm && (
            <EmptyState
              title="Sin escenarios"
              description="Crea el primer escenario para probar distintas combinaciones de propuestas dentro de esta simulación."
            />
          )}

          <div className="space-y-2">
            {proposalScenarios.map((scenario) => {
              const selected = activeScenario?.id === scenario.id;
              const appliedProposalNames = scenario.simulationIds
                .map((simulationId) => simulations.find((simulation) => simulation.id === simulationId)?.name)
                .filter(Boolean) as string[];
              return (
                <button
                  key={scenario.id}
                  onClick={() => onSelectScenario(scenario.id)}
                  className={`w-full rounded-xl border px-3 py-3 text-left transition ${
                    selected
                      ? 'border-[var(--success)] bg-[var(--success)]/10'
                      : 'border-[var(--gray-200)]/50 bg-[var(--surface-alt)] hover:bg-white'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-[13px] font-semibold text-[var(--gray-950)]">{scenario.name}</p>
                        {selected && (
                          <span className="rounded-full bg-[var(--success)]/15 px-2 py-0.5 text-[10px] font-medium text-[#248a3d]">Activo</span>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11px] text-[var(--gray-400)]">{scenario.description || 'Sin descripción'}</p>
                      <div className="mt-2 flex items-center gap-2 text-[11px] text-[var(--gray-500)]">
                        <span>{Math.round(scenario.probability * 100)}%</span>
                        <span>•</span>
                        <span>{scenario.simulationIds.length} propuestas activas</span>
                        <span>•</span>
                        <span>{scenario.horizonMonths} meses</span>
                      </div>
                      {appliedProposalNames.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-[#6e6e73]">
                          {appliedProposalNames.slice(0, 2).map((name) => (
                            <Badge key={name}>{name}</Badge>
                          ))}
                          {appliedProposalNames.length > 2 && (
                            <Badge>+{appliedProposalNames.length - 2} más</Badge>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          openEditScenario(scenario);
                        }}
                        className="rounded-lg p-1.5 text-[var(--gray-400)] hover:bg-white hover:text-[var(--gray-950)]"
                        title="Editar escenario"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          onDeleteScenario(scenario.id);
                        }}
                        className="rounded-lg p-1.5 text-[var(--gray-400)] hover:bg-white hover:text-[#ff3b30]"
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

        <section className="rounded-2xl border border-[var(--gray-200)]/50 bg-white p-4 shadow-sm space-y-3">
          <SectionHeader
            stepLabel="Paso 3"
            title="Biblioteca de Propuestas"
            subtitle={isBaseScenario(activeScenario)
              ? 'Selecciona un escenario para activar propuestas.'
              : `Escenario activo: ${activeScenario?.name ?? '—'} · Si editas una propuesta, se actualiza en todos los escenarios donde esté asignada.`}
            actionLabel="Nueva propuesta"
            onAction={openNewSimulation}
          />

          <input
            value={simulationSearch}
            onChange={(event) => setSimulationSearch(event.target.value)}
            placeholder="Buscar propuesta..."
            className="w-full rounded-xl border border-[var(--gray-200)] bg-[var(--surface-alt)] px-3 py-2.5 text-[13px]"
          />

          {showSimulationForm && (
            <div className="rounded-2xl border border-[var(--gray-200)]/60 bg-[var(--surface-alt)] p-3 space-y-3">
              <input
                value={simulationForm.name}
                onChange={(event) => setSimulationForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Nombre de la propuesta"
                className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
              />
              <textarea
                value={simulationForm.description}
                onChange={(event) => setSimulationForm((current) => ({ ...current, description: event.target.value }))}
                rows={3}
                placeholder="Describe el ajuste financiero"
                className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px] resize-none"
              />

              <div className="grid grid-cols-2 gap-3">
                <Field label="Tipo de propuesta">
                  <select
                    value={simulationForm.type}
                    onChange={(event) => setSimulationForm((current) => ({ ...current, type: event.target.value as SimulationType }))}
                    className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
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
                    className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                  >
                    {SIMULATION_CATEGORIES.map((category) => (
                      <option key={category} value={category}>{category}</option>
                    ))}
                  </select>
                </Field>
              </div>

              {simulationTypeMeta && (
                <div className="rounded-xl bg-white p-3 text-[12px] text-[var(--gray-500)]">
                  <p className="font-medium text-[var(--gray-950)]">{simulationTypeMeta.label}</p>
                  <p className="mt-1">{simulationTypeMeta.description}</p>
                </div>
              )}

              <div className="rounded-xl border border-[#0071e3]/15 bg-[#e8f4fd]/65 p-3">
                <p className="text-[11px] font-medium uppercase tracking-wide text-[#0071e3]">Vista rápida</p>
                <p className="mt-1 text-[13px] text-[#1d1d1f]">{proposalPreview}</p>
              </div>

              {!['timing_shift', 'pause_expense'].includes(simulationForm.type) && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Operación">
                    <select
                      value={simulationForm.operation}
                      onChange={(event) => setSimulationForm((current) => ({ ...current, operation: event.target.value as SimulationOperation }))}
                      className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
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
                      className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
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
                      className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                    />
                  </Field>
                  <Field label="% del flujo a mover">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={simulationForm.shiftRatio}
                      onChange={(event) => setSimulationForm((current) => ({ ...current, shiftRatio: Number(event.target.value) || 0 }))}
                      className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
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
                        className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                      />
                    </Field>
                    <Field label="Parcialidades">
                      <input
                        type="number"
                        min={2}
                        max={24}
                        value={simulationForm.installments}
                        onChange={(event) => setSimulationForm((current) => ({ ...current, installments: Number(event.target.value) || 2 }))}
                        className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                      />
                    </Field>
                  </div>
                  <Field label="Porcentajes personalizados (opcional)">
                    <input
                      value={simulationForm.customAllocationText}
                      onChange={(event) => setSimulationForm((current) => ({ ...current, customAllocationText: event.target.value }))}
                      placeholder="Ej. 25, 25, 25, 25"
                      className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                    />
                  </Field>
                </div>
              )}

              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-medium text-[var(--gray-500)]">Precisión de inicio:</span>
                  <div className="flex items-center rounded-xl bg-[var(--gray-50)] p-0.5 gap-0.5">
                    {(['day', 'week', 'month'] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setSimulationForm((current) => {
                          let newStart = current.startDate;
                          if (p === 'week') newStart = snapToMonday(current.startDate);
                          if (p === 'month') newStart = firstOfMonth(current.startDate);
                          return { ...current, startPrecision: p, startDate: newStart };
                        })}
                        className={`rounded-lg px-3 py-1 text-[11px] font-medium transition ${
                          simulationForm.startPrecision === p
                            ? 'bg-white text-[var(--gray-950)] shadow-sm'
                            : 'text-[var(--gray-500)]'
                        }`}
                      >
                        {p === 'day' ? 'Día' : p === 'week' ? 'Semana' : 'Mes'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <Field label={simulationForm.startPrecision === 'day' ? 'Inicia el día' : simulationForm.startPrecision === 'week' ? 'Inicia la semana del' : 'Inicia en el mes'}>
                    {simulationForm.startPrecision === 'month' ? (
                      <input
                        type="month"
                        value={simulationForm.startDate.slice(0, 7)}
                        onChange={(event) => {
                          const newStart = firstOfMonth(event.target.value + '-01');
                          setSimulationForm((current) => ({
                            ...current,
                            startDate: newStart,
                            endDate: current.endDate < newStart ? newStart : current.endDate,
                          }));
                        }}
                        className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                      />
                    ) : (
                      <input
                        type="date"
                        value={simulationForm.startDate}
                        onChange={(event) => {
                          let newStart = event.target.value;
                          if (simulationForm.startPrecision === 'week') newStart = snapToMonday(newStart);
                          setSimulationForm((current) => ({
                            ...current,
                            startDate: newStart,
                            endDate: current.endDate < newStart ? newStart : current.endDate,
                          }));
                        }}
                        className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                      />
                    )}
                  </Field>
                  <Field label="Termina en">
                    <input
                      type="date"
                      value={simulationForm.endDate}
                      min={simulationForm.startDate}
                      onChange={(event) => setSimulationForm((current) => ({ ...current, endDate: event.target.value }))}
                      className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                    />
                  </Field>
                  <Field label="Frecuencia">
                    <select
                      value={simulationForm.frequency}
                      onChange={(event) => setSimulationForm((current) => ({ ...current, frequency: event.target.value as SimulationFrequency }))}
                      className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                    >
                      {FREQUENCIES.map((frequency) => (
                        <option key={frequency.value} value={frequency.value}>{frequency.label}</option>
                      ))}
                    </select>
                  </Field>
                </div>
                {simulationForm.startPrecision === 'week' && (
                  <p className="text-[11px] text-[var(--gray-400)]">
                    La propuesta empieza el lunes {simulationForm.startDate}. Selecciona cualquier día y se ajusta automáticamente al inicio de esa semana.
                  </p>
                )}
              </div>

              <Field label="Forma de cobro / pago (opcional)">
                <input
                  value={simulationForm.paymentLabel}
                  onChange={(event) => setSimulationForm((current) => ({ ...current, paymentLabel: event.target.value }))}
                  placeholder="Ej. 4 pagos mensuales, anticipo 30%, contraentrega..."
                  className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                />
              </Field>

              <Field label={dynamicTargetConfig.label}>
                <div className="space-y-2">
                  <p className="text-[12px] text-[var(--gray-500)]">{dynamicTargetConfig.helper}</p>
                  <div className="flex flex-wrap gap-2 rounded-xl border border-[var(--gray-200)] bg-white p-2">
                    {dynamicTargetConfig.options.map((target) => {
                      const selected = simulationForm.targetIds.includes(target.id);
                      return (
                        <button
                          key={target.id}
                          onClick={() => toggleTarget(target.id)}
                          className={`rounded-full px-3 py-1.5 text-[11px] font-medium transition ${
                            selected
                              ? 'bg-[var(--primary)] text-white'
                              : 'bg-[var(--gray-50)] text-[var(--gray-500)]'
                          }`}
                        >
                          {target.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </Field>

              <Field label="Comentarios o justificación">
                <textarea
                  value={simulationForm.comments}
                  onChange={(event) => setSimulationForm((current) => ({ ...current, comments: event.target.value }))}
                  rows={3}
                  placeholder="Contexto, riesgos, supuestos..."
                  className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px] resize-none"
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
                title="Sin propuestas"
                description="Crea ajustes reutilizables como aumento de ventas, retraso en cobranza o cobro en parcialidades."
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
                      ? 'border-[var(--primary)]/30 bg-[var(--primary-muted)]/70'
                      : 'border-[var(--gray-200)]/50 bg-[var(--surface-alt)]'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <button
                      onClick={() => toggleSimulationAssignment(simulation.id)}
                      disabled={isBaseScenario(activeScenario)}
                      className={`mt-0.5 flex h-5 w-5 items-center justify-center rounded-md border transition ${
                        selected
                          ? 'border-[var(--primary)] bg-[var(--primary)] text-white'
                          : 'border-[var(--gray-200)] bg-white text-transparent'
                      } ${isBaseScenario(activeScenario) ? 'cursor-not-allowed opacity-50' : ''}`}
                      title={isBaseScenario(activeScenario) ? 'Selecciona un escenario para asignar propuestas' : 'Activar / desactivar propuesta'}
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: CATEGORY_COLORS[simulation.category] }} />
                        <p className="truncate text-[13px] font-semibold text-[var(--gray-950)]">{simulation.name}</p>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11px] text-[var(--gray-400)]">{simulation.description || 'Sin descripción'}</p>
                      <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-[var(--gray-500)]">
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
                        className="rounded-lg p-1.5 text-[var(--gray-400)] hover:bg-white hover:text-[var(--gray-950)]"
                        title="Editar propuesta"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => onDeleteSimulation(simulation.id)}
                        className="rounded-lg p-1.5 text-[var(--gray-400)] hover:bg-white hover:text-[#ff3b30]"
                        title="Eliminar propuesta"
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
    <div className="rounded-2xl border border-[var(--gray-200)]/50 bg-[var(--surface-alt)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="rounded-full bg-white px-2 py-1 text-[11px] font-semibold text-[var(--primary)]">{index}</span>
        <ArrowRight className="w-4 h-4 text-[#c7c7cc]" />
      </div>
      <p className="text-[13px] font-semibold text-[var(--gray-950)]">{title}</p>
      <p className="mt-1 text-[12px] text-[var(--gray-500)]">{description}</p>
    </div>
  );
}

function SectionHeader({
  stepLabel,
  title,
  subtitle,
  actionLabel,
  onAction,
}: {
  stepLabel?: string;
  title: string;
  subtitle: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        {stepLabel && (
          <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--primary)]">{stepLabel}</p>
        )}
        <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">{title}</h2>
        <p className="mt-1 text-[12px] text-[var(--gray-400)]">{subtitle}</p>
      </div>
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          className="inline-flex items-center gap-1 rounded-full bg-[var(--primary)] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[var(--primary-hover)]"
        >
          <Plus className="w-3.5 h-3.5" />
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function ContextPill({
  step,
  title,
  value,
  helper,
}: {
  step: string;
  title: string;
  value: string;
  helper: string;
}) {
  return (
    <div className="rounded-2xl border border-[#d2d2d7]/50 bg-[#fbfbfd] p-3">
      <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-[#0071e3]">{step}</p>
      <p className="mt-1 text-[12px] font-medium text-[#6e6e73]">{title}</p>
      <p className="mt-2 text-[14px] font-semibold text-[#1d1d1f]">{value}</p>
      <p className="mt-1 text-[11px] text-[#86868b]">{helper}</p>
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
      <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--gray-400)]">{label}</span>
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
        className="rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2 text-[12px] text-[var(--gray-500)]"
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
    <div className="rounded-2xl border border-dashed border-[var(--gray-200)] bg-[var(--surface-alt)] px-4 py-8 text-center">
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-2xl bg-white border border-[var(--gray-200)]/60">
        <CopyPlus className="w-4 h-4 text-[var(--gray-400)]" />
      </div>
      <p className="text-[13px] font-medium text-[var(--gray-950)]">{title}</p>
      <p className="mt-1 text-[12px] text-[var(--gray-400)]">{description}</p>
    </div>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-[var(--gray-200)]/60 bg-white px-2 py-0.5">
      {children}
    </span>
  );
}
