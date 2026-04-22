import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Coins,
  FlaskConical,
  Pause,
  Pencil,
  Plus,
  TrendingUp,
  Trash2,
  Clock,
  X,
} from 'lucide-react';
import {
  FlowPlan,
  PROPOSAL_CATEGORY_DESCRIPTIONS,
  PROPOSAL_CATEGORY_LABELS,
  PROPOSAL_FREQUENCY_LABELS,
  Proposal,
  ProposalCategory,
  ProposalFrequency,
  Scenario,
  ScenarioCellOverride,
  Simulation,
  SimulationStatus,
} from '../types';
import { buildProposalEffects } from '../domain/proposalCompiler';
import { formatCurrency } from '../utils/calculations';

/**
 * ScenarioWorkbench — UI principal de Simulaciones → Escenarios → Propuestas.
 *
 * Terminología del usuario:
 *   Simulación  = contenedor de análisis  (interno: Simulation)
 *   Escenario   = grupo de propuestas     (interno: Scenario)
 *   Propuesta   = ajuste financiero       (interno: Proposal)
 *
 * Esta vista está construida sobre el modelo v4:
 *   - No existe un "Escenario Base" persistido; cuando el usuario no ha
 *     seleccionado nada, se muestra el pronóstico original.
 *   - Las propuestas tienen solo 4 categorías y un set mínimo de campos.
 *   - El formulario de creación/edición de Propuesta es un panel inline
 *     que se expande debajo del botón "Nueva propuesta".
 */

interface Props {
  plan: FlowPlan;
  simulations: Simulation[];
  scenarios: Scenario[];
  proposals: Proposal[];
  overrides: ScenarioCellOverride[];
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

/* ═══════════════════════════════════════════════════════════════
   UTILIDADES
   ═══════════════════════════════════════════════════════════════ */

const SIMULATION_STATUSES: SimulationStatus[] = ['Pendiente', 'En proceso', 'Aprobada', 'Descartada'];

const FREQUENCIES: ProposalFrequency[] = [
  'once',
  'monthly',
  'bimonthly',
  'quarterly',
  'semiannual',
  'annual',
];

const CATEGORY_META: Record<ProposalCategory, { icon: typeof Coins; color: string }> = {
  ahorro: { icon: Coins, color: 'var(--primary)' },
  aumento_ingresos: { icon: TrendingUp, color: 'var(--success)' },
  pausar_gasto: { icon: Pause, color: 'var(--warning)' },
  timing_shift: { icon: Clock, color: 'var(--chart-4)' },
};

function nowIso(): string {
  return new Date().toISOString();
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function firstDayOfYear(plan: FlowPlan): string {
  return `${plan.year}-01-01`;
}

function lastDayOfYear(plan: FlowPlan): string {
  return `${plan.year}-12-31`;
}

/* ═══════════════════════════════════════════════════════════════
   FORMULARIO DE PROPUESTA
   ═══════════════════════════════════════════════════════════════ */

interface ProposalFormState {
  category: ProposalCategory;
  name: string;
  description: string;
  amount: string;
  frequency: ProposalFrequency;
  startDate: string;
  endDate: string;
  shiftMonths: string;
}

function emptyProposalForm(plan: FlowPlan): ProposalFormState {
  return {
    category: 'ahorro',
    name: '',
    description: '',
    amount: '',
    frequency: 'once',
    startDate: firstDayOfYear(plan),
    endDate: lastDayOfYear(plan),
    shiftMonths: '1',
  };
}

function proposalToForm(proposal: Proposal, plan: FlowPlan): ProposalFormState {
  return {
    category: proposal.category,
    name: proposal.name,
    description: proposal.description ?? '',
    amount: proposal.category === 'pausar_gasto' ? '' : String(proposal.amount ?? 0),
    frequency: proposal.frequency ?? 'once',
    startDate: proposal.startDate || firstDayOfYear(plan),
    endDate: proposal.endDate ?? proposal.startDate ?? lastDayOfYear(plan),
    shiftMonths: String(proposal.shiftMonths ?? 1),
  };
}

function buildProposalFromForm(
  form: ProposalFormState,
  plan: FlowPlan,
  existing?: Proposal,
): Proposal | { error: string } {
  const name = form.name.trim();
  if (!name) return { error: 'Agrega un título para la propuesta.' };

  const startDate = form.startDate || firstDayOfYear(plan);
  const endDate = form.endDate || startDate;
  if (endDate < startDate) {
    return { error: 'La fecha final no puede ser anterior a la inicial.' };
  }

  const amount = form.category === 'pausar_gasto'
    ? 0
    : Math.max(0, Number(form.amount) || 0);

  if (form.category !== 'pausar_gasto' && amount <= 0) {
    return { error: 'Ingresa un monto positivo.' };
  }

  const shiftMonths = form.category === 'timing_shift'
    ? Number(form.shiftMonths) || 1
    : undefined;

  const base: Proposal = {
    id: existing?.id ?? generateId('proposal'),
    name,
    description: form.description.trim() || undefined,
    category: form.category,
    amount,
    frequency: form.frequency,
    startDate,
    endDate: form.frequency === 'once' ? undefined : endDate,
    shiftMonths,
    effects: [],
    createdAt: existing?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
  };

  base.effects = buildProposalEffects(plan, base);
  return base;
}

/* ═══════════════════════════════════════════════════════════════
   COMPONENTE PRINCIPAL
   ═══════════════════════════════════════════════════════════════ */

export default function ScenarioWorkbench({
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
}: Props) {
  /* ── Resolución de selección ── */
  const activeSimulation = simulations.find((simulation) => simulation.id === activeSimulationId) ?? null;
  const activeScenario = activeScenarioId
    ? scenarios.find((scenario) => scenario.id === activeScenarioId) ?? null
    : null;

  /* ── Estado de formularios ── */
  const [proposalFormOpen, setProposalFormOpen] = useState(false);
  const [editingProposalId, setEditingProposalId] = useState<string | null>(null);
  const [proposalForm, setProposalForm] = useState<ProposalFormState>(() => emptyProposalForm(plan));
  const [proposalFormError, setProposalFormError] = useState<string | null>(null);

  const [scenarioEditorOpen, setScenarioEditorOpen] = useState(false);
  const [scenarioDraft, setScenarioDraft] = useState<{ id: string | null; name: string; description: string }>({
    id: null,
    name: '',
    description: '',
  });

  const [simulationEditorOpen, setSimulationEditorOpen] = useState(false);
  const [simulationDraft, setSimulationDraft] = useState<{
    id: string | null;
    name: string;
    description: string;
    status: SimulationStatus;
  }>({ id: null, name: '', description: '', status: 'Pendiente' });

  /* Cuando cambia el plan (año distinto), re-inicializamos fechas por defecto */
  useEffect(() => {
    setProposalForm((current) => ({
      ...current,
      startDate: current.startDate || firstDayOfYear(plan),
      endDate: current.endDate || lastDayOfYear(plan),
    }));
  }, [plan.year]);

  /* ── Handlers de propuestas ── */
  const openNewProposal = () => {
    setEditingProposalId(null);
    setProposalForm(emptyProposalForm(plan));
    setProposalFormError(null);
    setProposalFormOpen(true);
  };

  const openEditProposal = (proposal: Proposal) => {
    setEditingProposalId(proposal.id);
    setProposalForm(proposalToForm(proposal, plan));
    setProposalFormError(null);
    setProposalFormOpen(true);
  };

  const closeProposalForm = () => {
    setProposalFormOpen(false);
    setEditingProposalId(null);
    setProposalFormError(null);
  };

  const saveProposal = () => {
    const existing = editingProposalId ? proposals.find((p) => p.id === editingProposalId) ?? undefined : undefined;
    const result = buildProposalFromForm(proposalForm, plan, existing);
    if ('error' in result) {
      setProposalFormError(result.error);
      return;
    }

    if (existing) {
      onUpdateProposal(result);
    } else {
      onAddProposal(result);
      // Si hay escenario activo, la propuesta se asigna automáticamente.
      if (activeScenario && !activeScenario.proposalIds.includes(result.id)) {
        onUpdateScenario({
          ...activeScenario,
          proposalIds: [...activeScenario.proposalIds, result.id],
          updatedAt: nowIso(),
        });
      }
    }

    closeProposalForm();
  };

  const toggleProposalInScenario = (proposal: Proposal) => {
    if (!activeScenario) return;
    const currentIds = activeScenario.proposalIds;
    const isActive = currentIds.includes(proposal.id);
    const nextIds = isActive
      ? currentIds.filter((id) => id !== proposal.id)
      : [...currentIds, proposal.id];
    onUpdateScenario({
      ...activeScenario,
      proposalIds: nextIds,
      updatedAt: nowIso(),
    });
  };

  /* ── Handlers de escenarios ── */
  const openNewScenario = () => {
    setScenarioDraft({ id: null, name: '', description: '' });
    setScenarioEditorOpen(true);
  };

  const openEditScenario = (scenario: Scenario) => {
    setScenarioDraft({ id: scenario.id, name: scenario.name, description: scenario.description });
    setScenarioEditorOpen(true);
  };

  const saveScenario = () => {
    const name = scenarioDraft.name.trim();
    if (!name) return;
    if (scenarioDraft.id) {
      const existing = scenarios.find((s) => s.id === scenarioDraft.id);
      if (!existing) return;
      onUpdateScenario({
        ...existing,
        name,
        description: scenarioDraft.description.trim(),
        updatedAt: nowIso(),
      });
    } else {
      const simulationId = activeSimulationId ?? simulations[0]?.id ?? null;
      const newScenario: Scenario = {
        id: generateId('scenario'),
        simulationId,
        name,
        description: scenarioDraft.description.trim(),
        probability: 1,
        startYearMonth: `${plan.year}-01`,
        horizonMonths: 12,
        proposalIds: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      onAddScenario(newScenario);
      onSelectScenario(newScenario.id);
    }
    setScenarioEditorOpen(false);
  };

  /* ── Handlers de simulaciones ── */
  const openNewSimulation = () => {
    setSimulationDraft({ id: null, name: '', description: '', status: 'Pendiente' });
    setSimulationEditorOpen(true);
  };

  const openEditSimulation = (simulation: Simulation) => {
    setSimulationDraft({
      id: simulation.id,
      name: simulation.name,
      description: simulation.description,
      status: simulation.status,
    });
    setSimulationEditorOpen(true);
  };

  const saveSimulation = () => {
    const name = simulationDraft.name.trim();
    if (!name) return;
    if (simulationDraft.id) {
      const existing = simulations.find((s) => s.id === simulationDraft.id);
      if (!existing) return;
      onUpdate({
        ...existing,
        name,
        description: simulationDraft.description.trim(),
        status: simulationDraft.status,
        updatedAt: nowIso(),
      });
    } else {
      const newSimulation: Simulation = {
        id: generateId('simulation'),
        name,
        description: simulationDraft.description.trim(),
        status: simulationDraft.status,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      onAdd(newSimulation);
      onSelectSimulation(newSimulation.id);
    }
    setSimulationEditorOpen(false);
  };

  /* ── Derivados de UI ── */
  const visibleScenarios = useMemo(() => {
    if (!activeSimulation) return scenarios;
    return scenarios.filter((scenario) => scenario.simulationId === activeSimulation.id);
  }, [scenarios, activeSimulation]);

  const activeProposals = useMemo(() => {
    if (!activeScenario) return [];
    return proposals.filter((proposal) => activeScenario.proposalIds.includes(proposal.id));
  }, [proposals, activeScenario]);

  const totalImpact = useMemo(() => {
    let income = 0;
    let expense = 0;
    for (const proposal of activeProposals) {
      if (proposal.category === 'aumento_ingresos') income += proposal.amount;
      else if (proposal.category === 'ahorro') expense += proposal.amount;
    }
    return { income, expense };
  }, [activeProposals]);

  /* ═══════════════════════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════════════════════ */

  return (
    <div className="space-y-6">
      {/* Encabezado */}
      <header className="rounded-[28px] border border-[var(--gray-200)]/60 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-[var(--primary-muted)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--primary)]">
              <FlaskConical className="h-3.5 w-3.5" />
              Taller de escenarios
            </div>
            <h1 className="mt-3 text-[26px] font-semibold tracking-tight text-[var(--gray-950)]">
              Simulaciones, escenarios y propuestas
            </h1>
            <p className="mt-1 max-w-2xl text-[13px] leading-6 text-[var(--gray-500)]">
              Una <strong>Simulación</strong> agrupa análisis. Dentro puedes crear <strong>Escenarios</strong> (combinaciones)
              y asignarles <strong>Propuestas</strong> (ajustes concretos).
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={openNewSimulation}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--gray-200)] bg-white px-4 text-[13px] font-medium text-[var(--gray-950)] transition hover:bg-[var(--gray-50)]"
            >
              <Plus className="h-4 w-4" />
              Nueva simulación
            </button>
            <button
              onClick={openNewScenario}
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-[var(--primary)] px-4 text-[13px] font-medium text-white transition hover:bg-[var(--primary-hover)]"
            >
              <Plus className="h-4 w-4" />
              Nuevo escenario
            </button>
          </div>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* Columna izquierda: Simulaciones + Escenarios */}
        <aside className="space-y-4">
          <section className="rounded-2xl border border-[var(--gray-200)]/60 bg-white p-4 shadow-sm">
            <header className="flex items-center justify-between">
              <h2 className="text-[13px] font-semibold uppercase tracking-wider text-[var(--gray-500)]">
                Simulaciones
              </h2>
              <span className="rounded-full bg-[var(--gray-50)] px-2 py-0.5 text-[11px] font-medium text-[var(--gray-500)]">
                {simulations.length}
              </span>
            </header>
            {simulations.length === 0 ? (
              <p className="mt-3 text-[12px] leading-5 text-[var(--gray-400)]">
                Aún no hay simulaciones. Crea una para empezar.
              </p>
            ) : (
              <ul className="mt-3 space-y-1">
                {simulations.map((simulation) => {
                  const isActive = simulation.id === activeSimulationId;
                  return (
                    <li key={simulation.id}>
                      <div
                        className={`group flex items-center gap-2 rounded-xl px-3 py-2 transition ${
                          isActive
                            ? 'bg-[var(--primary-muted)] text-[var(--primary)]'
                            : 'hover:bg-[var(--gray-50)] text-[var(--gray-950)]'
                        }`}
                      >
                        <button
                          onClick={() => onSelectSimulation(simulation.id)}
                          className="flex-1 min-w-0 text-left"
                        >
                          <p className="truncate text-[13px] font-medium">{simulation.name}</p>
                          <p className="truncate text-[11px] text-[var(--gray-400)]">{simulation.status}</p>
                        </button>
                        <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                          <button
                            onClick={() => openEditSimulation(simulation)}
                            className="rounded p-1 text-[var(--gray-400)] hover:bg-white hover:text-[var(--gray-700)]"
                            title="Editar"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            onClick={() => {
                              if (confirm(`¿Eliminar la simulación "${simulation.name}"?`)) onDelete(simulation.id);
                            }}
                            className="rounded p-1 text-[var(--gray-400)] hover:bg-white hover:text-[var(--danger)]"
                            title="Eliminar"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="rounded-2xl border border-[var(--gray-200)]/60 bg-white p-4 shadow-sm">
            <header className="flex items-center justify-between">
              <h2 className="text-[13px] font-semibold uppercase tracking-wider text-[var(--gray-500)]">
                Escenarios
              </h2>
              <span className="rounded-full bg-[var(--gray-50)] px-2 py-0.5 text-[11px] font-medium text-[var(--gray-500)]">
                {visibleScenarios.length}
              </span>
            </header>
            <button
              onClick={() => onSelectScenario(null)}
              className={`mt-3 flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left transition ${
                !activeScenario
                  ? 'border-[var(--card-foreground)] bg-[var(--card-foreground)] text-white'
                  : 'border-[var(--gray-200)] bg-[var(--surface-alt)] text-[var(--gray-950)] hover:bg-white'
              }`}
            >
              <div>
                <p className="text-[13px] font-semibold">Pronóstico original</p>
                <p className={`text-[11px] ${!activeScenario ? 'text-white/70' : 'text-[var(--gray-400)]'}`}>
                  Plan sin propuestas aplicadas
                </p>
              </div>
              {!activeScenario && <Check className="h-4 w-4" />}
            </button>
            {visibleScenarios.length === 0 ? (
              <p className="mt-3 text-[12px] leading-5 text-[var(--gray-400)]">
                Aún no hay escenarios en esta simulación.
              </p>
            ) : (
              <ul className="mt-3 space-y-1">
                {visibleScenarios.map((scenario) => {
                  const isActive = scenario.id === activeScenarioId;
                  const proposalCount = scenario.proposalIds.length;
                  return (
                    <li key={scenario.id}>
                      <div
                        className={`group flex items-center gap-2 rounded-xl px-3 py-2 transition ${
                          isActive
                            ? 'bg-[var(--primary)] text-white'
                            : 'hover:bg-[var(--gray-50)] text-[var(--gray-950)]'
                        }`}
                      >
                        <button
                          onClick={() => onSelectScenario(scenario.id)}
                          className="flex-1 min-w-0 text-left"
                        >
                          <p className="truncate text-[13px] font-medium">{scenario.name}</p>
                          <p className={`truncate text-[11px] ${isActive ? 'text-white/70' : 'text-[var(--gray-400)]'}`}>
                            {proposalCount} propuesta{proposalCount === 1 ? '' : 's'}
                          </p>
                        </button>
                        <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                          <button
                            onClick={() => openEditScenario(scenario)}
                            className={`rounded p-1 ${isActive ? 'text-white/80 hover:bg-white/10' : 'text-[var(--gray-400)] hover:bg-white hover:text-[var(--gray-700)]'}`}
                            title="Editar"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            onClick={() => {
                              if (confirm(`¿Eliminar el escenario "${scenario.name}"?`)) onDeleteScenario(scenario.id);
                            }}
                            className={`rounded p-1 ${isActive ? 'text-white/80 hover:bg-white/10' : 'text-[var(--gray-400)] hover:bg-white hover:text-[var(--danger)]'}`}
                            title="Eliminar"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </aside>

        {/* Columna derecha: escenario activo y sus propuestas */}
        <main className="space-y-5">
          {activeScenario ? (
            <>
              <section className="rounded-2xl border border-[var(--gray-200)]/60 bg-white p-5 shadow-sm">
                <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                  <div>
                    <h2 className="text-[20px] font-semibold text-[var(--gray-950)]">{activeScenario.name}</h2>
                    {activeScenario.description && (
                      <p className="mt-1 max-w-2xl text-[13px] leading-6 text-[var(--gray-500)]">
                        {activeScenario.description}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-4 text-right">
                    <div>
                      <p className="text-[11px] uppercase tracking-wider text-[var(--gray-400)]">Ingresos</p>
                      <p className="text-[16px] font-semibold text-[var(--success)]">
                        +{formatCurrency(totalImpact.income)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-wider text-[var(--gray-400)]">Ahorro</p>
                      <p className="text-[16px] font-semibold text-[var(--primary)]">
                        −{formatCurrency(totalImpact.expense)}
                      </p>
                    </div>
                  </div>
                </div>
              </section>

              {/* Sección de Propuestas + Panel inline */}
              <section className="rounded-2xl border border-[var(--gray-200)]/60 bg-white p-5 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-[16px] font-semibold text-[var(--gray-950)]">Propuestas del escenario</h3>
                    <p className="mt-0.5 text-[12px] text-[var(--gray-400)]">
                      Activa/desactiva propuestas de la biblioteca o crea una nueva.
                    </p>
                  </div>
                  <button
                    onClick={proposalFormOpen && !editingProposalId ? closeProposalForm : openNewProposal}
                    className={`inline-flex h-9 items-center gap-2 rounded-xl px-3 text-[12px] font-medium transition ${
                      proposalFormOpen && !editingProposalId
                        ? 'border border-[var(--gray-200)] bg-white text-[var(--gray-950)] hover:bg-[var(--gray-50)]'
                        : 'bg-[var(--primary)] text-white hover:bg-[var(--primary-hover)]'
                    }`}
                  >
                    {proposalFormOpen && !editingProposalId ? (
                      <>
                        <X className="h-3.5 w-3.5" />
                        Cancelar
                      </>
                    ) : (
                      <>
                        <Plus className="h-3.5 w-3.5" />
                        Nueva propuesta
                      </>
                    )}
                  </button>
                </div>

                {/* Panel inline expandible del formulario */}
                {proposalFormOpen && (
                  <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--primary)]/20 bg-[var(--primary-muted)]/30 transition-all">
                    <ProposalForm
                      form={proposalForm}
                      onChange={setProposalForm}
                      onCancel={closeProposalForm}
                      onSave={saveProposal}
                      error={proposalFormError}
                      isEditing={Boolean(editingProposalId)}
                    />
                  </div>
                )}

                {/* Lista de propuestas */}
                <div className="mt-4 space-y-2">
                  {proposals.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-[var(--gray-200)] bg-[var(--surface-alt)] px-6 py-10 text-center">
                      <p className="text-[13px] font-medium text-[var(--gray-950)]">Sin propuestas todavía</p>
                      <p className="mt-1 text-[12px] text-[var(--gray-400)]">
                        Crea tu primera propuesta para empezar a comparar escenarios.
                      </p>
                    </div>
                  ) : (
                    proposals
                      .slice()
                      .sort((a, b) => a.name.localeCompare(b.name, 'es'))
                      .map((proposal) => {
                        const isActive = activeScenario.proposalIds.includes(proposal.id);
                        const meta = CATEGORY_META[proposal.category];
                        const Icon = meta.icon;
                        return (
                          <div
                            key={proposal.id}
                            className={`group flex items-start gap-3 rounded-2xl border p-3 transition ${
                              isActive
                                ? 'border-[var(--primary)]/30 bg-[var(--primary-muted)]/40'
                                : 'border-[var(--gray-200)] bg-white hover:bg-[var(--gray-50)]'
                            }`}
                          >
                            <button
                              onClick={() => toggleProposalInScenario(proposal)}
                              className={`mt-1 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md border transition ${
                                isActive
                                  ? 'border-[var(--primary)] bg-[var(--primary)]'
                                  : 'border-[var(--gray-300)] bg-white hover:border-[var(--primary)]'
                              }`}
                              title={isActive ? 'Quitar del escenario' : 'Asignar al escenario'}
                            >
                              {isActive && <Check className="h-3.5 w-3.5 text-white" strokeWidth={2.5} />}
                            </button>
                            <div
                              className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg"
                              style={{ background: `${meta.color}15`, color: meta.color }}
                            >
                              <Icon className="h-4 w-4" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <p className="truncate text-[13px] font-semibold text-[var(--gray-950)]">
                                  {proposal.name}
                                </p>
                                <span
                                  className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                                  style={{ background: `${meta.color}15`, color: meta.color }}
                                >
                                  {PROPOSAL_CATEGORY_LABELS[proposal.category]}
                                </span>
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--gray-500)]">
                                {proposal.category !== 'pausar_gasto' && (
                                  <span>{formatCurrency(proposal.amount)}</span>
                                )}
                                <span>{PROPOSAL_FREQUENCY_LABELS[proposal.frequency]}</span>
                                <span>
                                  {proposal.startDate}
                                  {proposal.endDate && proposal.endDate !== proposal.startDate
                                    ? ` → ${proposal.endDate}`
                                    : ''}
                                </span>
                                {proposal.category === 'timing_shift' && proposal.shiftMonths !== undefined && (
                                  <span>{proposal.shiftMonths > 0 ? `+${proposal.shiftMonths}` : proposal.shiftMonths} mes{Math.abs(proposal.shiftMonths) === 1 ? '' : 'es'}</span>
                                )}
                              </div>
                              {proposal.description && (
                                <p className="mt-1 line-clamp-2 text-[12px] text-[var(--gray-500)]">
                                  {proposal.description}
                                </p>
                              )}
                            </div>
                            <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                              <button
                                onClick={() => openEditProposal(proposal)}
                                className="rounded p-1.5 text-[var(--gray-400)] hover:bg-white hover:text-[var(--gray-700)]"
                                title="Editar propuesta"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => {
                                  if (confirm(`¿Eliminar la propuesta "${proposal.name}"?`)) onDeleteProposal(proposal.id);
                                }}
                                className="rounded p-1.5 text-[var(--gray-400)] hover:bg-white hover:text-[var(--danger)]"
                                title="Eliminar propuesta"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        );
                      })
                  )}
                </div>
              </section>
            </>
          ) : (
            <section className="rounded-2xl border border-dashed border-[var(--gray-200)] bg-white px-6 py-20 text-center">
              <h2 className="text-[18px] font-semibold text-[var(--gray-950)]">Pronóstico original</h2>
              <p className="mt-2 max-w-lg mx-auto text-[13px] leading-6 text-[var(--gray-500)]">
                Este es el plan base sin ninguna propuesta aplicada. Selecciona un escenario de la izquierda para ver
                sus propuestas y su impacto, o crea uno nuevo.
              </p>
              <button
                onClick={openNewScenario}
                className="mt-5 inline-flex h-10 items-center gap-2 rounded-xl bg-[var(--primary)] px-4 text-[13px] font-medium text-white transition hover:bg-[var(--primary-hover)]"
              >
                <Plus className="h-4 w-4" />
                Crear escenario
              </button>
            </section>
          )}
        </main>
      </div>

      {/* Modal: editor de Escenario (solo nombre + descripción) */}
      {scenarioEditorOpen && (
        <Modal onClose={() => setScenarioEditorOpen(false)}>
          <h2 className="text-[18px] font-semibold text-[var(--gray-950)]">
            {scenarioDraft.id ? 'Editar escenario' : 'Nuevo escenario'}
          </h2>
          <div className="mt-4 space-y-3">
            <Field label="Nombre">
              <input
                autoFocus
                value={scenarioDraft.name}
                onChange={(e) => setScenarioDraft((s) => ({ ...s, name: e.target.value }))}
                placeholder="Ej. Conservador Q3"
                className="input w-full"
              />
            </Field>
            <Field label="Descripción">
              <textarea
                value={scenarioDraft.description}
                onChange={(e) => setScenarioDraft((s) => ({ ...s, description: e.target.value }))}
                rows={3}
                placeholder="Contexto breve del escenario"
                className="input w-full resize-none"
              />
            </Field>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={() => setScenarioEditorOpen(false)}
              className="h-10 rounded-xl border border-[var(--gray-200)] bg-white px-4 text-[13px] text-[var(--gray-950)] hover:bg-[var(--gray-50)]"
            >
              Cancelar
            </button>
            <button
              onClick={saveScenario}
              disabled={!scenarioDraft.name.trim()}
              className="h-10 rounded-xl bg-[var(--primary)] px-4 text-[13px] font-medium text-white hover:bg-[var(--primary-hover)] disabled:opacity-40"
            >
              Guardar
            </button>
          </div>
        </Modal>
      )}

      {/* Modal: editor de Simulación */}
      {simulationEditorOpen && (
        <Modal onClose={() => setSimulationEditorOpen(false)}>
          <h2 className="text-[18px] font-semibold text-[var(--gray-950)]">
            {simulationDraft.id ? 'Editar simulación' : 'Nueva simulación'}
          </h2>
          <div className="mt-4 space-y-3">
            <Field label="Nombre">
              <input
                autoFocus
                value={simulationDraft.name}
                onChange={(e) => setSimulationDraft((s) => ({ ...s, name: e.target.value }))}
                placeholder="Ej. Análisis Q3 2026"
                className="input w-full"
              />
            </Field>
            <Field label="Descripción">
              <textarea
                value={simulationDraft.description}
                onChange={(e) => setSimulationDraft((s) => ({ ...s, description: e.target.value }))}
                rows={3}
                placeholder="¿Qué preguntas quieres contestar con esta simulación?"
                className="input w-full resize-none"
              />
            </Field>
            <Field label="Estado">
              <select
                value={simulationDraft.status}
                onChange={(e) => setSimulationDraft((s) => ({ ...s, status: e.target.value as SimulationStatus }))}
                className="input w-full"
              >
                {SIMULATION_STATUSES.map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
            </Field>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={() => setSimulationEditorOpen(false)}
              className="h-10 rounded-xl border border-[var(--gray-200)] bg-white px-4 text-[13px] text-[var(--gray-950)] hover:bg-[var(--gray-50)]"
            >
              Cancelar
            </button>
            <button
              onClick={saveSimulation}
              disabled={!simulationDraft.name.trim()}
              className="h-10 rounded-xl bg-[var(--primary)] px-4 text-[13px] font-medium text-white hover:bg-[var(--primary-hover)] disabled:opacity-40"
            >
              Guardar
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   FORMULARIO INLINE DE PROPUESTA
   ═══════════════════════════════════════════════════════════════ */

function ProposalForm({
  form,
  onChange,
  onCancel,
  onSave,
  error,
  isEditing,
}: {
  form: ProposalFormState;
  onChange: (next: ProposalFormState | ((prev: ProposalFormState) => ProposalFormState)) => void;
  onCancel: () => void;
  onSave: () => void;
  error: string | null;
  isEditing: boolean;
}) {
  const categories: ProposalCategory[] = ['ahorro', 'aumento_ingresos', 'pausar_gasto', 'timing_shift'];
  const showAmount = form.category !== 'pausar_gasto';
  const showShift = form.category === 'timing_shift';
  const showDateRange = form.frequency !== 'once' || form.category === 'pausar_gasto';

  return (
    <div className="p-5">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-[14px] font-semibold text-[var(--gray-950)]">
            {isEditing ? 'Editar propuesta' : 'Nueva propuesta'}
          </h4>
          <p className="mt-0.5 text-[11px] text-[var(--gray-500)]">
            Primero elige qué tipo de ajuste quieres hacer.
          </p>
        </div>
      </div>

      {/* Paso 1: Categoría */}
      <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {categories.map((category) => {
          const meta = CATEGORY_META[category];
          const Icon = meta.icon;
          const selected = form.category === category;
          return (
            <button
              key={category}
              onClick={() => onChange((prev) => ({ ...prev, category }))}
              className={`group rounded-xl border p-3 text-left transition ${
                selected
                  ? 'border-transparent shadow-sm'
                  : 'border-[var(--gray-200)] bg-white hover:bg-[var(--gray-50)]'
              }`}
              style={selected ? { background: `${meta.color}15`, borderColor: `${meta.color}60` } : undefined}
            >
              <div
                className="flex h-9 w-9 items-center justify-center rounded-lg"
                style={{ background: `${meta.color}20`, color: meta.color }}
              >
                <Icon className="h-5 w-5" />
              </div>
              <p className="mt-2 text-[13px] font-semibold text-[var(--gray-950)]">
                {PROPOSAL_CATEGORY_LABELS[category]}
              </p>
              <p className="mt-1 text-[11px] leading-4 text-[var(--gray-500)]">
                {PROPOSAL_CATEGORY_DESCRIPTIONS[category]}
              </p>
            </button>
          );
        })}
      </div>

      {/* Paso 2: Datos básicos */}
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <Field label="Título">
          <input
            autoFocus
            value={form.name}
            onChange={(e) => onChange((prev) => ({ ...prev, name: e.target.value }))}
            placeholder="Ej. Reducir gasto en combustible"
            className="input w-full"
          />
        </Field>
        <Field label="Frecuencia">
          <select
            value={form.frequency}
            onChange={(e) => onChange((prev) => ({ ...prev, frequency: e.target.value as ProposalFrequency }))}
            className="input w-full"
          >
            {FREQUENCIES.map((frequency) => (
              <option key={frequency} value={frequency}>{PROPOSAL_FREQUENCY_LABELS[frequency]}</option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Descripción (opcional)" className="mt-3">
        <textarea
          value={form.description}
          onChange={(e) => onChange((prev) => ({ ...prev, description: e.target.value }))}
          rows={2}
          placeholder="Contexto adicional para tu equipo"
          className="input w-full resize-none"
        />
      </Field>

      {/* Paso 3: Monto + timing */}
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        {showAmount && (
          <Field label="Monto">
            <div className="flex items-center rounded-xl border border-[var(--gray-200)] bg-white">
              <span className="px-3 text-[13px] text-[var(--gray-400)]">$</span>
              <input
                type="number"
                min={0}
                step="any"
                value={form.amount}
                onChange={(e) => onChange((prev) => ({ ...prev, amount: e.target.value }))}
                placeholder="0"
                className="h-10 w-full rounded-r-xl border-0 bg-transparent px-0 text-[13px] outline-none"
              />
            </div>
          </Field>
        )}

        <Field label="Fecha inicial">
          <input
            type="date"
            value={form.startDate}
            onChange={(e) => onChange((prev) => ({ ...prev, startDate: e.target.value }))}
            className="input w-full"
          />
        </Field>

        {showDateRange && (
          <Field label="Fecha final">
            <input
              type="date"
              value={form.endDate}
              min={form.startDate}
              onChange={(e) => onChange((prev) => ({ ...prev, endDate: e.target.value }))}
              className="input w-full"
            />
          </Field>
        )}

        {showShift && (
          <Field label="Meses a mover">
            <input
              type="number"
              step="1"
              value={form.shiftMonths}
              onChange={(e) => onChange((prev) => ({ ...prev, shiftMonths: e.target.value }))}
              className="input w-full"
            />
          </Field>
        )}
      </div>

      {error && (
        <p className="mt-3 rounded-xl bg-[var(--danger)]/10 px-3 py-2 text-[12px] text-[var(--danger)]">{error}</p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="h-10 rounded-xl border border-[var(--gray-200)] bg-white px-4 text-[13px] text-[var(--gray-950)] hover:bg-[var(--gray-50)]"
        >
          Cancelar
        </button>
        <button
          onClick={onSave}
          className="h-10 rounded-xl bg-[var(--primary)] px-4 text-[13px] font-medium text-white hover:bg-[var(--primary-hover)]"
        >
          {isEditing ? 'Guardar cambios' : 'Crear propuesta'}
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   HELPERS DE UI
   ═══════════════════════════════════════════════════════════════ */

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className ?? ''}`}>
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-[var(--gray-400)]">
        {label}
      </span>
      {children}
    </label>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="float-right rounded-lg p-1 text-[var(--gray-400)] hover:bg-[var(--gray-100)] hover:text-[var(--gray-950)]"
        >
          <X className="h-4 w-4" />
        </button>
        {children}
      </div>
    </div>
  );
}

/* Dummy: ChevronDown / ChevronRight imports no se usan en esta versión, los
   mantengo exportados por si los necesita otro archivo. */
void ChevronDown;
void ChevronRight;
