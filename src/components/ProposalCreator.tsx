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
  Simulation,
  ROLE_TARGET_COLLECTIONS,
  ROLE_TARGET_EXPENSE,
  ROLE_TARGET_INCOME,
  ROLE_TARGET_PROVIDER_PAYMENTS,
  Scenario,
  Proposal,
  ProposalCategory,
  ProposalFrequency,
  ProposalOperation,
  ProposalType,
} from '../types';
import {
  buildProposalEffects,
  cloneSimulationWithActiveScenario,
  isBaseScenario,
} from '../domain/proposalCompiler';
import { resolveConceptLabel } from '../domain/scenarioEngine';

interface ProposalCreatorProps {
  plan: FlowPlan;
  simulations: Simulation[];
  scenarios: Scenario[];
  proposals: Proposal[];
  activeSimulationId: string | null;
  activeScenarioId: string | null;
  onSelectSimulation: (simulationId: string) => void;
  onSelectScenario: (scenarioId: string | null) => void;
  onAdd: (simulation: Simulation) => void;
  onUpdate: (simulation: Simulation) => void;
  onDelete: (simulationId: string) => void;
  onAddScenario: (scenario: Scenario) => void;
  onUpdateScenario: (scenario: Scenario) => void;
  onDeleteScenario: (scenarioId: string) => void;
  onAddProposal: (proposal: Proposal) => void;
  onUpdateProposal: (proposal: Proposal) => void;
  onDeleteProposal: (proposalId: string) => void;
}

interface SimulationFormState {
  name: string;
  description: string;
  status: Simulation['status'];
}

interface ScenarioFormState {
  name: string;
  description: string;
  probability: number;
  startYearMonth: string;
  horizonMonths: number;
}

interface ProposalFormState {
  name: string;
  description: string;
  category: ProposalCategory;
  type: ProposalType;
  operation: ProposalOperation;
  targetIds: string[];
  startDate: string;
  endDate: string;
  startPrecision: 'day' | 'week' | 'month';
  frequency: ProposalFrequency;
  amount: number;
  percent: number;
  installments: number;
  customAllocationText: string;
  shiftMonths: number;
  shiftRatio: number;
  paymentLabel: string;
  comments: string;
}

const PROPOSAL_STATUSES: Simulation['status'][] = ['Pendiente', 'En proceso', 'Aprobada', 'Descartada'];
const SCENARIO_PRESETS = ['Conservador', 'Realista', 'Optimista', 'Personalizado'];
const SIMULATION_CATEGORIES: ProposalCategory[] = [
  'Incremento de Ingresos',
  'Reducción de Costos',
  'Diferimiento',
  'Renegociación',
];
const FREQUENCIES: { value: ProposalFrequency; label: string }[] = [
  { value: 'once', label: 'Única vez' },
  { value: 'monthly', label: 'Mensual' },
  { value: 'bimonthly', label: 'Bimestral' },
  { value: 'quarterly', label: 'Trimestral' },
  { value: 'semiannual', label: 'Semestral' },
  { value: 'annual', label: 'Anual' },
];
const SIMULATION_TYPES: {
  value: ProposalType;
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

function simulationDefaults(): SimulationFormState {
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

function proposalDefaults(plan: FlowPlan): ProposalFormState {
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

function resolveProposalTargetIds(proposal: Partial<Proposal>): string[] {
  const defaultTarget =
    proposal.category && proposal.category !== 'Incremento de Ingresos'
      ? ROLE_TARGET_EXPENSE
      : ROLE_TARGET_INCOME;
  return Array.isArray(proposal.targetIds) && proposal.targetIds.length > 0
    ? proposal.targetIds
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
  form: Pick<ProposalFormState, 'type' | 'category'>,
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

function buildProposalFromForm(
  plan: FlowPlan,
  form: ProposalFormState,
  existing?: Proposal,
): Proposal {
  const timestamp = now();
  const proposalId = existing?.id ?? `proposal-${Date.now()}`;
  const startDate = form.startDate;
  const safeEndDate = form.endDate < startDate ? startDate : form.endDate;
  const proposal: Proposal = {
    id: proposalId,
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

  proposal.effects = buildProposalEffects(plan, proposal);
  return proposal;
}

export default function ProposalCreator({
  plan,
  simulations,
  scenarios,
  proposals,
  activeSimulationId,
  activeScenarioId,
  onSelectSimulation,
  onSelectScenario,
  onAdd,
  onUpdate,
  onDelete,
  onAddScenario,
  onUpdateScenario,
  onDeleteScenario,
  onAddProposal,
  onUpdateProposal,
  onDeleteProposal,
}: ProposalCreatorProps) {
  const [showSimulationForm, setShowSimulationForm] = useState(false);
  const [showScenarioForm, setShowScenarioForm] = useState(false);
  const [showProposalForm, setShowProposalForm] = useState(false);
  const [editingSimulationId, setEditingSimulationId] = useState<string | null>(null);
  const [editingScenarioId, setEditingScenarioId] = useState<string | null>(null);
  const [editingProposalId, setEditingProposalId] = useState<string | null>(null);
  const [simulationForm, setSimulationForm] = useState<SimulationFormState>(simulationDefaults);
  const [scenarioForm, setScenarioForm] = useState<ScenarioFormState>(() => scenarioDefaults(plan));
  const [proposalForm, setProposalForm] = useState<ProposalFormState>(() => proposalDefaults(plan));
  const [proposalSearch, setProposalSearch] = useState('');

  const baseScenario = scenarios.find((scenario) => isBaseScenario(scenario)) ?? null;
  const activeSimulation = simulations.find((simulation) => simulation.id === activeSimulationId) ?? null;
  const activeScenario = scenarios.find((scenario) => scenario.id === activeScenarioId) ?? baseScenario ?? null;
  const simulationScenarios = scenarios
    .filter((scenario) => !isBaseScenario(scenario) && scenario.simulationId === activeSimulationId)
    .sort((a, b) => a.name.localeCompare(b.name));
  const assignedProposalIds = new Set(activeScenario?.proposalIds ?? []);
  const dynamicTargetConfig = useMemo(
    () => buildDynamicTargetConfig(plan, proposalForm),
    [plan, proposalForm.type, proposalForm.category],
  );
  const proposalTypeMeta = SIMULATION_TYPES.find((item) => item.value === proposalForm.type);

  const filteredProposals = useMemo(() => {
    const query = proposalSearch.trim().toLowerCase();
    if (!query) return proposals;
    return proposals.filter((proposal) =>
      proposal.name.toLowerCase().includes(query) ||
      proposal.description.toLowerCase().includes(query) ||
      proposal.comments?.toLowerCase().includes(query),
    );
  }, [proposalSearch, proposals]);
  const simulationPreview = useMemo(() => {
    const targetLabel = proposalForm.targetIds
      .slice(0, 2)
      .map((id) => resolveConceptLabel(plan, id))
      .join(', ');
    const targetSuffix = proposalForm.targetIds.length > 2 ? ' y más' : '';

    if (proposalForm.type === 'percent_adjustment') {
      return `${proposalForm.operation === 'decrease' ? 'Reducir' : 'Incrementar'} ${targetLabel || 'los conceptos elegidos'}${targetSuffix} en ${proposalForm.percent}% desde ${formatDateLabel(proposalForm.startDate)} hasta ${formatDateLabel(proposalForm.endDate)}.`;
    }

    if (proposalForm.type === 'amount_adjustment') {
      return `${proposalForm.operation === 'decrease' ? 'Reducir' : 'Agregar'} ${proposalForm.amount} a ${targetLabel || 'los conceptos elegidos'}${targetSuffix} con frecuencia ${FREQUENCIES.find((item) => item.value === proposalForm.frequency)?.label.toLowerCase() ?? 'mensual'}.`;
    }

    if (proposalForm.type === 'recurring_series') {
      return `Crear un flujo recurrente de ${proposalForm.amount} sobre ${targetLabel || 'los conceptos elegidos'}${targetSuffix} desde ${formatDateLabel(proposalForm.startDate)}.`;
    }

    if (proposalForm.type === 'installment_plan') {
      return `Distribuir ${proposalForm.amount} en ${proposalForm.installments} parcialidades para ${targetLabel || 'los conceptos elegidos'}${targetSuffix}.`;
    }

    if (proposalForm.type === 'timing_shift') {
      return `Mover ${proposalForm.shiftRatio}% del flujo de ${targetLabel || 'los conceptos elegidos'}${targetSuffix} ${proposalForm.shiftMonths >= 0 ? `${proposalForm.shiftMonths} meses hacia adelante` : `${Math.abs(proposalForm.shiftMonths)} meses hacia atrás`}.`;
    }

    return `Pausar ${targetLabel || 'los conceptos elegidos'}${targetSuffix} desde ${formatDateLabel(proposalForm.startDate)} hasta ${formatDateLabel(proposalForm.endDate)}.`;
  }, [plan, proposalForm]);

  useEffect(() => {
    const allowedTargetIds = new Set(dynamicTargetConfig.options.map((option) => option.id));
    setProposalForm((current) => {
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

  const openNewSimulation = () => {
    setEditingSimulationId(null);
    setSimulationForm(simulationDefaults());
    setShowSimulationForm(true);
  };

  const openEditSimulation = (simulation: Simulation) => {
    setEditingSimulationId(simulation.id);
    setSimulationForm({
      name: simulation.name,
      description: simulation.description,
      status: simulation.status,
    });
    setShowSimulationForm(true);
  };

  const saveSimulation = () => {
    if (!simulationForm.name.trim()) return;
    const timestamp = now();

    if (editingSimulationId) {
      const existing = simulations.find((simulation) => simulation.id === editingSimulationId);
      if (!existing) return;
      onUpdate({
        ...existing,
        name: simulationForm.name.trim(),
        description: simulationForm.description.trim(),
        status: simulationForm.status,
        updatedAt: timestamp,
      });
      onSelectSimulation(existing.id);
    } else {
      const simulationId = `simulation-${Date.now()}`;
      onAdd({
        id: simulationId,
        name: simulationForm.name.trim(),
        description: simulationForm.description.trim(),
        status: simulationForm.status,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      onSelectSimulation(simulationId);
    }

    setShowSimulationForm(false);
    setEditingSimulationId(null);
    setSimulationForm(simulationDefaults());
  };

  const openNewScenario = (preset?: string) => {
    setEditingScenarioId(null);
    setScenarioForm({
      ...scenarioDefaults(plan),
      name: preset ?? `Escenario ${simulationScenarios.length + 1}`,
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
    if (!activeSimulation || !scenarioForm.name.trim()) return;
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
      onUpdate(cloneSimulationWithActiveScenario(activeSimulation, updated.id));
      onSelectScenario(updated.id);
    } else {
      const scenarioId = `scenario-${Date.now()}`;
      const created: Scenario = {
        id: scenarioId,
        simulationId: activeSimulation.id,
        kind: 'simulation',
        name: scenarioForm.name.trim(),
        description: scenarioForm.description.trim(),
        probability: scenarioForm.probability / 100,
        startYearMonth: scenarioForm.startYearMonth,
        horizonMonths: scenarioForm.horizonMonths,
        proposalIds: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      onAddScenario(created);
      onUpdate(cloneSimulationWithActiveScenario(activeSimulation, created.id));
      onSelectScenario(scenarioId);
    }

    setShowScenarioForm(false);
    setEditingScenarioId(null);
    setScenarioForm(scenarioDefaults(plan));
  };

  const openNewProposal = () => {
    setEditingProposalId(null);
    setProposalForm(proposalDefaults(plan));
    setShowProposalForm(true);
  };

  const openEditProposal = (proposal: Proposal) => {
    const targetIds = resolveProposalTargetIds(proposal);
    setEditingProposalId(proposal.id);
    setProposalForm({
      name: proposal.name,
      description: proposal.description,
      category: proposal.category ?? 'Incremento de Ingresos',
      type: proposal.type ?? 'amount_adjustment',
      operation: proposal.operation ?? 'increase',
      targetIds,
      startDate: proposal.startDate ?? `${proposal.startYearMonth ?? `${plan.year}-01`}-01`,
      endDate: proposal.endDate ?? endOfMonthFromDate(`${proposal.endYearMonth ?? proposal.startYearMonth ?? `${plan.year}-12`}-01`),
      startPrecision: 'month',
      frequency: proposal.frequency ?? 'monthly',
      amount: proposal.amount ?? 0,
      percent: Math.abs((proposal.percent ?? 0) * 100),
      installments: proposal.installments ?? 4,
      customAllocationText: proposal.customAllocation?.join(', ') ?? '',
      shiftMonths: proposal.shiftMonths ?? 1,
      shiftRatio: Math.round((proposal.shiftRatio ?? 1) * 100),
      paymentLabel: proposal.paymentLabel ?? '',
      comments: proposal.comments ?? '',
    });
    setShowProposalForm(true);
  };

  const saveProposal = () => {
    if (!proposalForm.name.trim() || proposalForm.targetIds.length === 0) return;
    const existing = editingProposalId
      ? proposals.find((proposal) => proposal.id === editingProposalId)
      : undefined;
    const proposal = buildProposalFromForm(plan, proposalForm, existing);
    if (existing) onUpdateProposal(proposal);
    else onAddProposal(proposal);
    setShowProposalForm(false);
    setEditingProposalId(null);
    setProposalForm(proposalDefaults(plan));
  };

  const toggleTarget = (targetId: string) => {
    setProposalForm((current) => {
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

  const toggleProposalAssignment = (proposalId: string) => {
    if (!activeScenario || isBaseScenario(activeScenario)) return;
    const exists = assignedProposalIds.has(proposalId);
    const nextScenario: Scenario = {
      ...activeScenario,
      proposalIds: exists
        ? activeScenario.proposalIds.filter((id) => id !== proposalId)
        : [...activeScenario.proposalIds, proposalId],
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

      <div className="rounded-2xl border border-[var(--gray-200)]/50 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-3 gap-3">
          <ContextPill
            step="Paso 1"
            title="Simulación"
            value={activeSimulation?.name ?? 'Elige o crea una simulación'}
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
            value={isBaseScenario(activeScenario) ? '0 propuestas activas' : `${assignedProposalIds.size} propuestas activas`}
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
            onAction={openNewSimulation}
          />

          <button
            onClick={() => onSelectScenario(BASE_SCENARIO_ID)}
            className={`w-full rounded-2xl border px-4 py-4 text-left transition ${
              activeScenario?.id === BASE_SCENARIO_ID
                ? 'border-[var(--card-foreground)] bg-[var(--card-foreground)] text-white'
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

          {showSimulationForm && (
            <div className="rounded-2xl border border-[var(--gray-200)]/60 bg-[var(--surface-alt)] p-3 space-y-3">
              <input
                value={simulationForm.name}
                onChange={(event) => setSimulationForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Nombre de la simulación"
                className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
              />
              <textarea
                value={simulationForm.description}
                onChange={(event) => setSimulationForm((current) => ({ ...current, description: event.target.value }))}
                rows={3}
                placeholder="Qué iniciativa o análisis quieres correr"
                className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px] resize-none"
              />
              <select
                value={simulationForm.status}
                onChange={(event) => setSimulationForm((current) => ({ ...current, status: event.target.value as Simulation['status'] }))}
                className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
              >
                {PROPOSAL_STATUSES.map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
              <InlineActions
                onCancel={() => {
                  setShowSimulationForm(false);
                  setEditingSimulationId(null);
                  setSimulationForm(simulationDefaults());
                }}
                onSave={saveSimulation}
              />
            </div>
          )}

          <div className="space-y-2">
            {simulations.length === 0 && (
              <EmptyState
                title="Sin simulaciones aún"
                description="Empieza creando una simulación para abrir escenarios y correr propuestas."
              />
            )}
            {simulations.map((simulation) => {
              const simulationScenarioCount = scenarios.filter((scenario) => scenario.simulationId === simulation.id).length;
              const selected = activeSimulation?.id === simulation.id;
              return (
                <button
                  key={simulation.id}
                  onClick={() => onSelectSimulation(simulation.id)}
                  className={`w-full rounded-xl border px-3 py-3 text-left transition ${
                    selected
                      ? 'border-[var(--primary)] bg-[var(--primary-muted)]'
                      : 'border-[var(--gray-200)]/50 bg-[var(--surface-alt)] hover:bg-white'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold text-[var(--gray-950)]">{simulation.name}</p>
                      <p className="mt-1 line-clamp-2 text-[11px] text-[var(--gray-400)]">{simulation.description || 'Sin descripción'}</p>
                      <div className="mt-2 flex items-center gap-2 text-[11px] text-[var(--gray-500)]">
                        <span>{simulationScenarioCount} escenarios</span>
                        <span>•</span>
                        <span>{simulation.status}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          openEditSimulation(simulation);
                        }}
                        className="rounded-lg p-1.5 text-[var(--gray-400)] hover:bg-white hover:text-[var(--gray-950)]"
                        title="Editar simulación"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          onDelete(simulation.id);
                        }}
                        className="rounded-lg p-1.5 text-[var(--gray-400)] hover:bg-white hover:text-[var(--danger)]"
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
            subtitle={activeSimulation ? `Simulación activa: ${activeSimulation.name}` : 'Selecciona una simulación para trabajar escenarios.'}
            actionLabel={activeSimulation ? 'Nuevo escenario' : undefined}
            onAction={activeSimulation ? () => openNewScenario() : undefined}
          />

          {activeSimulation && (
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

          {showScenarioForm && activeSimulation && (
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

          {!activeSimulation && (
            <EmptyState
              title="Primero elige una simulación"
              description="Cada simulación puede tener escenarios conservador, realista, optimista o personalizado."
            />
          )}

          {activeSimulation && simulationScenarios.length === 0 && !showScenarioForm && (
            <EmptyState
              title="Sin escenarios"
              description="Crea el primer escenario para probar distintas combinaciones de propuestas dentro de esta simulación."
            />
          )}

          <div className="space-y-2">
            {simulationScenarios.map((scenario) => {
              const selected = activeScenario?.id === scenario.id;
              const appliedSimulationNames = scenario.proposalIds
                .map((proposalId) => proposals.find((proposal) => proposal.id === proposalId)?.name)
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
                          <span className="rounded-full bg-[var(--success)]/15 px-2 py-0.5 text-[10px] font-medium text-[var(--success)]">Activo</span>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11px] text-[var(--gray-400)]">{scenario.description || 'Sin descripción'}</p>
                      <div className="mt-2 flex items-center gap-2 text-[11px] text-[var(--gray-500)]">
                        <span>{Math.round(scenario.probability * 100)}%</span>
                        <span>•</span>
                        <span>{scenario.proposalIds.length} propuestas activas</span>
                        <span>•</span>
                        <span>{scenario.horizonMonths} meses</span>
                      </div>
                      {appliedSimulationNames.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-[var(--gray-400)]">
                          {appliedSimulationNames.slice(0, 2).map((name) => (
                            <Badge key={name}>{name}</Badge>
                          ))}
                          {appliedSimulationNames.length > 2 && (
                            <Badge>+{appliedSimulationNames.length - 2} más</Badge>
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
                        className="rounded-lg p-1.5 text-[var(--gray-400)] hover:bg-white hover:text-[var(--danger)]"
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
            onAction={openNewProposal}
          />

          <input
            value={proposalSearch}
            onChange={(event) => setProposalSearch(event.target.value)}
            placeholder="Buscar propuesta..."
            className="w-full rounded-xl border border-[var(--gray-200)] bg-[var(--surface-alt)] px-3 py-2.5 text-[13px]"
          />

          {showProposalForm && (
            <div className="rounded-2xl border border-[var(--gray-200)]/60 bg-[var(--surface-alt)] p-3 space-y-3">
              <input
                value={proposalForm.name}
                onChange={(event) => setProposalForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Nombre de la propuesta"
                className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
              />
              <textarea
                value={proposalForm.description}
                onChange={(event) => setProposalForm((current) => ({ ...current, description: event.target.value }))}
                rows={3}
                placeholder="Describe el ajuste financiero"
                className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px] resize-none"
              />

              <div className="grid grid-cols-2 gap-3">
                <Field label="Tipo de propuesta">
                  <select
                    value={proposalForm.type}
                    onChange={(event) => setProposalForm((current) => ({ ...current, type: event.target.value as ProposalType }))}
                    className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                  >
                    {SIMULATION_TYPES.map((item) => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Categoría">
                  <select
                    value={proposalForm.category}
                    onChange={(event) => setProposalForm((current) => ({ ...current, category: event.target.value as ProposalCategory }))}
                    className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                  >
                    {SIMULATION_CATEGORIES.map((category) => (
                      <option key={category} value={category}>{category}</option>
                    ))}
                  </select>
                </Field>
              </div>

              {proposalTypeMeta && (
                <div className="rounded-xl bg-white p-3 text-[12px] text-[var(--gray-500)]">
                  <p className="font-medium text-[var(--gray-950)]">{proposalTypeMeta.label}</p>
                  <p className="mt-1">{proposalTypeMeta.description}</p>
                </div>
              )}

              <div className="rounded-xl border border-[var(--primary)]/15 bg-[var(--primary-muted)]/65 p-3">
                <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--primary)]">Vista rápida</p>
                <p className="mt-1 text-[13px] text-[var(--card-foreground)]">{simulationPreview}</p>
              </div>

              {!['timing_shift', 'pause_expense'].includes(proposalForm.type) && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Operación">
                    <select
                      value={proposalForm.operation}
                      onChange={(event) => setProposalForm((current) => ({ ...current, operation: event.target.value as ProposalOperation }))}
                      className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                    >
                      <option value="increase">Incrementar / Agregar</option>
                      <option value="decrease">Reducir / Quitar</option>
                    </select>
                  </Field>
                  <Field label={proposalForm.type === 'percent_adjustment' ? 'Porcentaje' : 'Monto'}>
                    <input
                      type="number"
                      step={proposalForm.type === 'percent_adjustment' ? 1 : 0.01}
                      value={proposalForm.type === 'percent_adjustment' ? proposalForm.percent : proposalForm.amount}
                      onChange={(event) => setProposalForm((current) => (
                        proposalForm.type === 'percent_adjustment'
                          ? { ...current, percent: Number(event.target.value) || 0 }
                          : { ...current, amount: Number(event.target.value) || 0 }
                      ))}
                      className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                    />
                  </Field>
                </div>
              )}

              {proposalForm.type === 'timing_shift' && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Mover meses">
                    <input
                      type="number"
                      min={-12}
                      max={12}
                      value={proposalForm.shiftMonths}
                      onChange={(event) => setProposalForm((current) => ({ ...current, shiftMonths: Number(event.target.value) || 0 }))}
                      className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                    />
                  </Field>
                  <Field label="% del flujo a mover">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={proposalForm.shiftRatio}
                      onChange={(event) => setProposalForm((current) => ({ ...current, shiftRatio: Number(event.target.value) || 0 }))}
                      className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                    />
                  </Field>
                </div>
              )}

              {proposalForm.type === 'installment_plan' && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Monto total">
                      <input
                        type="number"
                        step={0.01}
                        value={proposalForm.amount}
                        onChange={(event) => setProposalForm((current) => ({ ...current, amount: Number(event.target.value) || 0 }))}
                        className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                      />
                    </Field>
                    <Field label="Parcialidades">
                      <input
                        type="number"
                        min={2}
                        max={24}
                        value={proposalForm.installments}
                        onChange={(event) => setProposalForm((current) => ({ ...current, installments: Number(event.target.value) || 2 }))}
                        className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                      />
                    </Field>
                  </div>
                  <Field label="Porcentajes personalizados (opcional)">
                    <input
                      value={proposalForm.customAllocationText}
                      onChange={(event) => setProposalForm((current) => ({ ...current, customAllocationText: event.target.value }))}
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
                        onClick={() => setProposalForm((current) => {
                          let newStart = current.startDate;
                          if (p === 'week') newStart = snapToMonday(current.startDate);
                          if (p === 'month') newStart = firstOfMonth(current.startDate);
                          return { ...current, startPrecision: p, startDate: newStart };
                        })}
                        className={`rounded-lg px-3 py-1 text-[11px] font-medium transition ${
                          proposalForm.startPrecision === p
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
                  <Field label={proposalForm.startPrecision === 'day' ? 'Inicia el día' : proposalForm.startPrecision === 'week' ? 'Inicia la semana del' : 'Inicia en el mes'}>
                    {proposalForm.startPrecision === 'month' ? (
                      <input
                        type="month"
                        value={proposalForm.startDate.slice(0, 7)}
                        onChange={(event) => {
                          const newStart = firstOfMonth(event.target.value + '-01');
                          setProposalForm((current) => ({
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
                        value={proposalForm.startDate}
                        onChange={(event) => {
                          let newStart = event.target.value;
                          if (proposalForm.startPrecision === 'week') newStart = snapToMonday(newStart);
                          setProposalForm((current) => ({
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
                      value={proposalForm.endDate}
                      min={proposalForm.startDate}
                      onChange={(event) => setProposalForm((current) => ({ ...current, endDate: event.target.value }))}
                      className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                    />
                  </Field>
                  <Field label="Frecuencia">
                    <select
                      value={proposalForm.frequency}
                      onChange={(event) => setProposalForm((current) => ({ ...current, frequency: event.target.value as ProposalFrequency }))}
                      className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                    >
                      {FREQUENCIES.map((frequency) => (
                        <option key={frequency.value} value={frequency.value}>{frequency.label}</option>
                      ))}
                    </select>
                  </Field>
                </div>
                {proposalForm.startPrecision === 'week' && (
                  <p className="text-[11px] text-[var(--gray-400)]">
                    La propuesta empieza el lunes {proposalForm.startDate}. Selecciona cualquier día y se ajusta automáticamente al inicio de esa semana.
                  </p>
                )}
              </div>

              <Field label="Forma de cobro / pago (opcional)">
                <input
                  value={proposalForm.paymentLabel}
                  onChange={(event) => setProposalForm((current) => ({ ...current, paymentLabel: event.target.value }))}
                  placeholder="Ej. 4 pagos mensuales, anticipo 30%, contraentrega..."
                  className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px]"
                />
              </Field>

              <Field label={dynamicTargetConfig.label}>
                <div className="space-y-2">
                  <p className="text-[12px] text-[var(--gray-500)]">{dynamicTargetConfig.helper}</p>
                  <div className="flex flex-wrap gap-2 rounded-xl border border-[var(--gray-200)] bg-white p-2">
                    {dynamicTargetConfig.options.map((target) => {
                      const selected = proposalForm.targetIds.includes(target.id);
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
                  value={proposalForm.comments}
                  onChange={(event) => setProposalForm((current) => ({ ...current, comments: event.target.value }))}
                  rows={3}
                  placeholder="Contexto, riesgos, supuestos..."
                  className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px] resize-none"
                />
              </Field>

              <InlineActions
                onCancel={() => {
                  setShowProposalForm(false);
                  setEditingProposalId(null);
                  setProposalForm(proposalDefaults(plan));
                }}
                onSave={saveProposal}
              />
            </div>
          )}

          <div className="space-y-2 max-h-[760px] overflow-y-auto pr-1">
            {filteredProposals.length === 0 && (
              <EmptyState
                title="Sin propuestas"
                description="Crea ajustes reutilizables como aumento de ventas, retraso en cobranza o cobro en parcialidades."
              />
            )}

            {filteredProposals.map((proposal) => {
              const selected = assignedProposalIds.has(proposal.id);
              const targetIds = resolveProposalTargetIds(proposal);
              const targetLabel = targetIds
                .slice(0, 2)
                .map((id) => resolveConceptLabel(plan, id))
                .join(', ');
              return (
                <div
                  key={proposal.id}
                  className={`rounded-xl border px-3 py-3 transition ${
                    selected
                      ? 'border-[var(--primary)]/30 bg-[var(--primary-muted)]/70'
                      : 'border-[var(--gray-200)]/50 bg-[var(--surface-alt)]'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <button
                      onClick={() => toggleProposalAssignment(proposal.id)}
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
                        <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: CATEGORY_COLORS[proposal.category] }} />
                        <p className="truncate text-[13px] font-semibold text-[var(--gray-950)]">{proposal.name}</p>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11px] text-[var(--gray-400)]">{proposal.description || 'Sin descripción'}</p>
                      <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-[var(--gray-500)]">
                        <Badge>{SIMULATION_TYPES.find((item) => item.value === proposal.type)?.label ?? 'Simulación'}</Badge>
                        <Badge>{proposal.operation === 'decrease' ? 'Reducir' : 'Incrementar'}</Badge>
                        <Badge>{targetLabel}{targetIds.length > 2 ? ' +' : ''}</Badge>
                        {proposal.percent !== undefined && <Badge>{Math.round(Math.abs(proposal.percent) * 100)}%</Badge>}
                        {proposal.amount !== undefined && <Badge>{proposal.amount}</Badge>}
                        {proposal.installments && <Badge>{proposal.installments} parcialidades</Badge>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => openEditProposal(proposal)}
                        className="rounded-lg p-1.5 text-[var(--gray-400)] hover:bg-white hover:text-[var(--gray-950)]"
                        title="Editar propuesta"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => onDeleteProposal(proposal.id)}
                        className="rounded-lg p-1.5 text-[var(--gray-400)] hover:bg-white hover:text-[var(--danger)]"
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
        <ArrowRight className="w-4 h-4 text-[var(--gray-300)]" />
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
    <div className="rounded-2xl border border-[var(--gray-200)]/50 bg-[var(--surface-alt)] p-3">
      <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--primary)]">{step}</p>
      <p className="mt-1 text-[12px] font-medium text-[var(--gray-400)]">{title}</p>
      <p className="mt-2 text-[14px] font-semibold text-[var(--card-foreground)]">{value}</p>
      <p className="mt-1 text-[11px] text-[var(--gray-400)]">{helper}</p>
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
        className="rounded-xl bg-[var(--card-foreground)] px-3 py-2 text-[12px] font-medium text-white"
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
