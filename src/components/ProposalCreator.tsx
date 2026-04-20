import { type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  Check,
  CopyPlus,
  FlaskConical,
  FolderTree,
  Layers,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  CATEGORY_COLORS,
  FlowPlan,
  MONTHS,
  Proposal,
  ROLE_TARGET_LABELS,
  Scenario,
  Simulation,
  SimulationCategory,
} from '../types';
import { getSimulationTargetOptions } from '../domain/scenarioEngine';

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
  targetId: string;
  mode: 'absolute' | 'percent';
  value: number;
  monthOffsets: number[];
}

const SIMULATION_CATEGORIES: SimulationCategory[] = [
  'Incremento de Ingresos',
  'Reducción de Costos',
  'Diferimiento',
  'Renegociación',
];

const PROPOSAL_STATUSES: Proposal['status'][] = [
  'Pendiente',
  'En proceso',
  'Aprobada',
  'Descartada',
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
    name: 'Escenario Base',
    description: '',
    probability: 100,
    startYearMonth: `${plan.year}-01`,
    horizonMonths: 12,
  };
}

function simulationDefaults(plan: FlowPlan): SimulationFormState {
  const targetOptions = getSimulationTargetOptions(plan);
  return {
    name: '',
    description: '',
    category: 'Incremento de Ingresos',
    targetId: targetOptions[0]?.id ?? '',
    mode: 'absolute',
    value: 0,
    monthOffsets: Array.from({ length: 12 }, (_, index) => index),
  };
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
  const [proposalForm, setProposalForm] = useState<ProposalFormState>(proposalDefaults);
  const [scenarioForm, setScenarioForm] = useState<ScenarioFormState>(() => scenarioDefaults(plan));
  const [simulationForm, setSimulationForm] = useState<SimulationFormState>(() => simulationDefaults(plan));
  const [editingProposalId, setEditingProposalId] = useState<string | null>(null);
  const [editingScenarioId, setEditingScenarioId] = useState<string | null>(null);
  const [editingSimulationId, setEditingSimulationId] = useState<string | null>(null);
  const [showProposalForm, setShowProposalForm] = useState(false);
  const [showScenarioForm, setShowScenarioForm] = useState(false);
  const [showSimulationForm, setShowSimulationForm] = useState(false);
  const [simulationSearch, setSimulationSearch] = useState('');

  useEffect(() => {
    setScenarioForm((current) => ({
      ...current,
      startYearMonth: current.startYearMonth || `${plan.year}-01`,
    }));
  }, [plan.year]);

  const targetOptions = useMemo(() => getSimulationTargetOptions(plan), [plan]);
  const activeProposal = proposals.find((proposal) => proposal.id === activeProposalId) ?? null;
  const proposalScenarios = scenarios
    .filter((scenario) => scenario.proposalId === activeProposalId)
    .sort((a, b) => a.name.localeCompare(b.name));
  const activeScenario = proposalScenarios.find((scenario) => scenario.id === activeScenarioId)
    ?? proposalScenarios[0]
    ?? null;
  const assignedSimulationIds = new Set(activeScenario?.simulationIds ?? []);

  const filteredSimulations = useMemo(() => {
    const query = simulationSearch.trim().toLowerCase();
    if (!query) return simulations;
    return simulations.filter((simulation) =>
      simulation.name.toLowerCase().includes(query) ||
      simulation.description.toLowerCase().includes(query),
    );
  }, [simulationSearch, simulations]);

  const proposalCount = proposals.length;
  const scenarioCount = scenarios.length;
  const simulationCount = simulations.length;

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
      const defaultScenarioId = `scenario-${Date.now()}-base`;
      onAdd({
        id: proposalId,
        name: proposalForm.name.trim(),
        description: proposalForm.description.trim(),
        status: proposalForm.status,
        activeScenarioId: defaultScenarioId,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      onAddScenario({
        id: defaultScenarioId,
        proposalId,
        name: 'Escenario Base',
        description: 'Escenario inicial generado al crear la propuesta.',
        probability: 1,
        startYearMonth: `${plan.year}-01`,
        horizonMonths: 12,
        simulationIds: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      onSelectProposal(proposalId);
    }

    setProposalForm(proposalDefaults());
    setShowProposalForm(false);
    setEditingProposalId(null);
  };

  const openNewScenario = () => {
    setEditingScenarioId(null);
    setScenarioForm({
      ...scenarioDefaults(plan),
      name: proposalScenarios.length === 0 ? 'Escenario Base' : `Escenario ${proposalScenarios.length + 1}`,
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
      if (!existing) return;
      onUpdateScenario({
        ...existing,
        name: scenarioForm.name.trim(),
        description: scenarioForm.description.trim(),
        probability: scenarioForm.probability / 100,
        startYearMonth: scenarioForm.startYearMonth,
        horizonMonths: scenarioForm.horizonMonths,
        updatedAt: timestamp,
      });
      onSelectScenario(existing.id);
    } else {
      const scenarioId = `scenario-${Date.now()}`;
      onAddScenario({
        id: scenarioId,
        proposalId: activeProposal.id,
        name: scenarioForm.name.trim(),
        description: scenarioForm.description.trim(),
        probability: scenarioForm.probability / 100,
        startYearMonth: scenarioForm.startYearMonth,
        horizonMonths: scenarioForm.horizonMonths,
        simulationIds: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      onSelectScenario(scenarioId);
    }

    setScenarioForm(scenarioDefaults(plan));
    setEditingScenarioId(null);
    setShowScenarioForm(false);
  };

  const openNewSimulation = () => {
    setEditingSimulationId(null);
    setSimulationForm(simulationDefaults(plan));
    setShowSimulationForm(true);
  };

  const openEditSimulation = (simulation: Simulation) => {
    const effect = simulation.effects[0];
    setEditingSimulationId(simulation.id);
    setSimulationForm({
      name: simulation.name,
      description: simulation.description,
      category: simulation.category,
      targetId: effect?.conceptId ?? targetOptions[0]?.id ?? '',
      mode: effect?.mode ?? 'absolute',
      value: effect?.value ?? 0,
      monthOffsets: effect?.monthOffsets?.length ? effect.monthOffsets : Array.from({ length: 12 }, (_, index) => index),
    });
    setShowSimulationForm(true);
  };

  const saveSimulation = () => {
    if (!simulationForm.name.trim() || !simulationForm.targetId) return;
    const timestamp = now();
    const simulationId = editingSimulationId ?? `simulation-${Date.now()}`;
    const nextSimulation: Simulation = {
      id: simulationId,
      name: simulationForm.name.trim(),
      description: simulationForm.description.trim(),
      category: simulationForm.category,
      effects: [
        {
          id: `${simulationId}-effect-0`,
          type: 'concept_delta',
          conceptId: simulationForm.targetId,
          monthOffsets: [...simulationForm.monthOffsets].sort((a, b) => a - b),
          mode: simulationForm.mode,
          value: simulationForm.value,
        },
      ],
      createdAt: editingSimulationId
        ? simulations.find((simulation) => simulation.id === editingSimulationId)?.createdAt ?? timestamp
        : timestamp,
      updatedAt: timestamp,
    };

    if (editingSimulationId) onUpdateSimulation(nextSimulation);
    else onAddSimulation(nextSimulation);

    setSimulationForm(simulationDefaults(plan));
    setEditingSimulationId(null);
    setShowSimulationForm(false);
  };

  const toggleSimulationAssignment = (simulationId: string) => {
    if (!activeScenario) return;
    const exists = assignedSimulationIds.has(simulationId);
    onUpdateScenario({
      ...activeScenario,
      simulationIds: exists
        ? activeScenario.simulationIds.filter((id) => id !== simulationId)
        : [...activeScenario.simulationIds, simulationId],
      updatedAt: now(),
    });
  };

  const toggleMonthOffset = (monthIndex: number) => {
    setSimulationForm((current) => {
      const exists = current.monthOffsets.includes(monthIndex);
      return {
        ...current,
        monthOffsets: exists
          ? current.monthOffsets.filter((value) => value !== monthIndex)
          : [...current.monthOffsets, monthIndex].sort((a, b) => a - b),
      };
    });
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-4">
        <SummaryCard
          title="Propuestas"
          value={proposalCount}
          subtitle="Contenedores activos"
          icon={<FolderTree className="w-4 h-4 text-[#0071e3]" />}
        />
        <SummaryCard
          title="Escenarios"
          value={scenarioCount}
          subtitle="Variantes persistidas"
          icon={<Layers className="w-4 h-4 text-[#34c759]" />}
        />
        <SummaryCard
          title="Simulaciones"
          value={simulationCount}
          subtitle="Biblioteca reusable"
          icon={<FlaskConical className="w-4 h-4 text-[#af52de]" />}
        />
      </div>

      <div className="grid grid-cols-[300px,minmax(0,1fr),380px] gap-5">
        <section className="bg-white border border-[#d2d2d7]/50 rounded-2xl p-4 space-y-3 shadow-sm">
          <PanelHeader
            title="Propuestas"
            subtitle="Selecciona una propuesta para editar sus escenarios."
            actionLabel="Nueva"
            onAction={openNewProposal}
          />
          {showProposalForm && (
            <div className="rounded-xl border border-[#d2d2d7]/50 bg-[#fbfbfd] p-3 space-y-3">
              <input
                value={proposalForm.name}
                onChange={(event) => setProposalForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Nombre de la propuesta"
                className="w-full rounded-lg border border-[#d2d2d7] bg-white px-3 py-2 text-[13px]"
              />
              <textarea
                value={proposalForm.description}
                onChange={(event) => setProposalForm((current) => ({ ...current, description: event.target.value }))}
                placeholder="Objetivo, alcance, notas..."
                rows={3}
                className="w-full rounded-lg border border-[#d2d2d7] bg-white px-3 py-2 text-[13px] resize-none"
              />
              <select
                value={proposalForm.status}
                onChange={(event) => setProposalForm((current) => ({ ...current, status: event.target.value as Proposal['status'] }))}
                className="w-full rounded-lg border border-[#d2d2d7] bg-white px-3 py-2 text-[13px]"
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
              <EmptyBlock title="Sin propuestas" description="Crea la primera propuesta para habilitar escenarios y simulaciones." />
            )}
            {proposals.map((proposal) => {
              const isActive = proposal.id === activeProposal?.id;
              const proposalScenarioCount = scenarios.filter((scenario) => scenario.proposalId === proposal.id).length;
              return (
                <button
                  key={proposal.id}
                  onClick={() => onSelectProposal(proposal.id)}
                  className={`w-full rounded-xl border px-3 py-3 text-left transition ${
                    isActive
                      ? 'border-[#0071e3] bg-[#e8f4fd]'
                      : 'border-[#d2d2d7]/50 bg-[#fbfbfd] hover:border-[#0071e3]/40 hover:bg-white'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold text-[#1d1d1f] truncate">{proposal.name}</p>
                      <p className="text-[11px] text-[#86868b] mt-1 line-clamp-2">{proposal.description || 'Sin descripción'}</p>
                      <div className="flex items-center gap-2 mt-2 text-[11px] text-[#6e6e73]">
                        <span>{proposalScenarioCount} escenario{proposalScenarioCount === 1 ? '' : 's'}</span>
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

        <section className="bg-white border border-[#d2d2d7]/50 rounded-2xl p-4 space-y-3 shadow-sm">
          <PanelHeader
            title="Escenarios"
            subtitle={activeProposal ? `Propuesta activa: ${activeProposal.name}` : 'Selecciona una propuesta.'}
            actionLabel="Nuevo"
            onAction={activeProposal ? openNewScenario : undefined}
          />
          {showScenarioForm && activeProposal && (
            <div className="rounded-xl border border-[#d2d2d7]/50 bg-[#fbfbfd] p-3 space-y-3">
              <input
                value={scenarioForm.name}
                onChange={(event) => setScenarioForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Nombre del escenario"
                className="w-full rounded-lg border border-[#d2d2d7] bg-white px-3 py-2 text-[13px]"
              />
              <textarea
                value={scenarioForm.description}
                onChange={(event) => setScenarioForm((current) => ({ ...current, description: event.target.value }))}
                placeholder="Hipótesis principales del escenario..."
                rows={3}
                className="w-full rounded-lg border border-[#d2d2d7] bg-white px-3 py-2 text-[13px] resize-none"
              />
              <div className="grid grid-cols-3 gap-3">
                <label className="space-y-1">
                  <span className="text-[11px] text-[#86868b]">Probabilidad</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={scenarioForm.probability}
                    onChange={(event) => setScenarioForm((current) => ({ ...current, probability: Number(event.target.value) || 0 }))}
                    className="w-full rounded-lg border border-[#d2d2d7] bg-white px-3 py-2 text-[13px]"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-[#86868b]">Inicio</span>
                  <input
                    type="month"
                    value={scenarioForm.startYearMonth}
                    onChange={(event) => setScenarioForm((current) => ({ ...current, startYearMonth: event.target.value }))}
                    className="w-full rounded-lg border border-[#d2d2d7] bg-white px-3 py-2 text-[13px]"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-[#86868b]">Horizonte</span>
                  <input
                    type="number"
                    min={1}
                    max={24}
                    value={scenarioForm.horizonMonths}
                    onChange={(event) => setScenarioForm((current) => ({ ...current, horizonMonths: Number(event.target.value) || 12 }))}
                    className="w-full rounded-lg border border-[#d2d2d7] bg-white px-3 py-2 text-[13px]"
                  />
                </label>
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
            <EmptyBlock title="Selecciona una propuesta" description="Los escenarios viven dentro de una propuesta activa." />
          )}
          {activeProposal && proposalScenarios.length === 0 && (
            <EmptyBlock title="Sin escenarios" description="Crea el primer escenario para empezar a asignar simulaciones." />
          )}
          <div className="space-y-2">
            {proposalScenarios.map((scenario) => {
              const isActive = scenario.id === activeScenario?.id;
              return (
                <button
                  key={scenario.id}
                  onClick={() => onSelectScenario(scenario.id)}
                  className={`w-full rounded-xl border px-3 py-3 text-left transition ${
                    isActive
                      ? 'border-[#34c759] bg-[#e8faf0]'
                      : 'border-[#d2d2d7]/50 bg-[#fbfbfd] hover:border-[#34c759]/40 hover:bg-white'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-[13px] font-semibold text-[#1d1d1f] truncate">{scenario.name}</p>
                        {isActive && (
                          <span className="rounded-full bg-[#34c759]/15 px-2 py-0.5 text-[10px] font-medium text-[#248a3d]">
                            Activo
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-[#86868b] mt-1 line-clamp-2">{scenario.description || 'Sin descripción'}</p>
                      <div className="flex items-center gap-2 mt-2 text-[11px] text-[#6e6e73]">
                        <span>{Math.round(scenario.probability * 100)}%</span>
                        <span>•</span>
                        <span>{scenario.horizonMonths} meses</span>
                        <span>•</span>
                        <span>{scenario.simulationIds.length} simulaciones</span>
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

        <section className="bg-white border border-[#d2d2d7]/50 rounded-2xl p-4 space-y-3 shadow-sm">
          <PanelHeader
            title="Biblioteca de Simulaciones"
            subtitle={activeScenario ? `Asignando al escenario: ${activeScenario.name}` : 'Selecciona un escenario para asignar simulaciones.'}
            actionLabel="Nueva"
            onAction={openNewSimulation}
          />
          <input
            value={simulationSearch}
            onChange={(event) => setSimulationSearch(event.target.value)}
            placeholder="Buscar simulación..."
            className="w-full rounded-xl border border-[#d2d2d7] bg-[#fbfbfd] px-3 py-2.5 text-[13px]"
          />
          {showSimulationForm && (
            <div className="rounded-xl border border-[#d2d2d7]/50 bg-[#fbfbfd] p-3 space-y-3">
              <input
                value={simulationForm.name}
                onChange={(event) => setSimulationForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Nombre de la simulación"
                className="w-full rounded-lg border border-[#d2d2d7] bg-white px-3 py-2 text-[13px]"
              />
              <textarea
                value={simulationForm.description}
                onChange={(event) => setSimulationForm((current) => ({ ...current, description: event.target.value }))}
                placeholder="Qué cambia y por qué"
                rows={3}
                className="w-full rounded-lg border border-[#d2d2d7] bg-white px-3 py-2 text-[13px] resize-none"
              />
              <div className="grid grid-cols-2 gap-3">
                <select
                  value={simulationForm.category}
                  onChange={(event) => setSimulationForm((current) => ({ ...current, category: event.target.value as SimulationCategory }))}
                  className="rounded-lg border border-[#d2d2d7] bg-white px-3 py-2 text-[13px]"
                >
                  {SIMULATION_CATEGORIES.map((category) => (
                    <option key={category} value={category}>{category}</option>
                  ))}
                </select>
                <select
                  value={simulationForm.targetId}
                  onChange={(event) => setSimulationForm((current) => ({ ...current, targetId: event.target.value }))}
                  className="rounded-lg border border-[#d2d2d7] bg-white px-3 py-2 text-[13px]"
                >
                  {targetOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.group === 'roles' ? `General · ${option.label}` : option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <select
                  value={simulationForm.mode}
                  onChange={(event) => setSimulationForm((current) => ({ ...current, mode: event.target.value as 'absolute' | 'percent' }))}
                  className="rounded-lg border border-[#d2d2d7] bg-white px-3 py-2 text-[13px]"
                >
                  <option value="absolute">Valor absoluto</option>
                  <option value="percent">Porcentaje</option>
                </select>
                <input
                  type="number"
                  step={simulationForm.mode === 'percent' ? 0.01 : 0.1}
                  value={simulationForm.value}
                  onChange={(event) => setSimulationForm((current) => ({ ...current, value: Number(event.target.value) || 0 }))}
                  className="rounded-lg border border-[#d2d2d7] bg-white px-3 py-2 text-[13px]"
                  placeholder={simulationForm.mode === 'percent' ? '0.10' : '10'}
                />
              </div>
              <div className="space-y-2">
                <p className="text-[11px] font-medium uppercase tracking-wide text-[#86868b]">Meses afectados</p>
                <div className="flex flex-wrap gap-2">
                  {MONTHS.map((month, index) => {
                    const selected = simulationForm.monthOffsets.includes(index);
                    return (
                      <button
                        key={month}
                        onClick={() => toggleMonthOffset(index)}
                        className={`rounded-full px-3 py-1 text-[11px] font-medium transition ${
                          selected
                            ? 'bg-[#0071e3] text-white'
                            : 'bg-white border border-[#d2d2d7] text-[#6e6e73]'
                        }`}
                      >
                        {month}
                      </button>
                    );
                  })}
                </div>
              </div>
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
          <div className="space-y-2 max-h-[640px] overflow-y-auto pr-1">
            {filteredSimulations.length === 0 && (
              <EmptyBlock title="Sin simulaciones" description="Crea simulaciones reutilizables y asígnalas a cualquier escenario." />
            )}
            {filteredSimulations.map((simulation) => {
              const effect = simulation.effects[0];
              const assigned = assignedSimulationIds.has(simulation.id);
              return (
                <div
                  key={simulation.id}
                  className={`rounded-xl border px-3 py-3 transition ${
                    assigned
                      ? 'border-[#0071e3]/30 bg-[#e8f4fd]/60'
                      : 'border-[#d2d2d7]/50 bg-[#fbfbfd]'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <button
                      onClick={() => toggleSimulationAssignment(simulation.id)}
                      disabled={!activeScenario}
                      className={`mt-0.5 flex h-5 w-5 items-center justify-center rounded-md border transition ${
                        assigned
                          ? 'border-[#0071e3] bg-[#0071e3] text-white'
                          : 'border-[#d2d2d7] bg-white text-transparent'
                      } ${!activeScenario ? 'cursor-not-allowed opacity-50' : ''}`}
                      title={activeScenario ? 'Asignar / quitar del escenario activo' : 'Selecciona un escenario'}
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <div
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: CATEGORY_COLORS[simulation.category] }}
                        />
                        <p className="text-[13px] font-semibold text-[#1d1d1f] truncate">{simulation.name}</p>
                      </div>
                      <p className="text-[11px] text-[#86868b] mt-1 line-clamp-2">{simulation.description || 'Sin descripción'}</p>
                      <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-[#6e6e73]">
                        <span className="rounded-full bg-white px-2 py-0.5 border border-[#d2d2d7]/70">
                          {simulation.category}
                        </span>
                        <span className="rounded-full bg-white px-2 py-0.5 border border-[#d2d2d7]/70">
                          {effect ? (ROLE_TARGET_LABELS[effect.conceptId] ?? targetOptions.find((option) => option.id === effect.conceptId)?.label ?? effect.conceptId) : 'Sin target'}
                        </span>
                        <span className="rounded-full bg-white px-2 py-0.5 border border-[#d2d2d7]/70">
                          {effect?.mode === 'percent' ? `${(effect.value * 100).toFixed(0)}%` : effect?.value}
                        </span>
                        <span className="rounded-full bg-white px-2 py-0.5 border border-[#d2d2d7]/70">
                          {effect?.monthOffsets.length ?? 0} meses
                        </span>
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

function SummaryCard({
  title,
  value,
  subtitle,
  icon,
}: {
  title: string;
  value: number;
  subtitle: string;
  icon: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-[#d2d2d7]/50 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-[#86868b]">{title}</p>
          <p className="mt-1 text-[26px] font-semibold text-[#1d1d1f]">{value}</p>
          <p className="text-[12px] text-[#86868b]">{subtitle}</p>
        </div>
        <div className="rounded-xl bg-[#f5f5f7] p-2.5">{icon}</div>
      </div>
    </div>
  );
}

function PanelHeader({
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
        <p className="text-[12px] text-[#86868b] mt-1">{subtitle}</p>
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
        className="rounded-lg border border-[#d2d2d7] bg-white px-3 py-1.5 text-[12px] text-[#6e6e73]"
      >
        Cancelar
      </button>
      <button
        onClick={onSave}
        className="rounded-lg bg-[#1d1d1f] px-3 py-1.5 text-[12px] font-medium text-white"
      >
        Guardar
      </button>
    </div>
  );
}

function EmptyBlock({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-xl border border-dashed border-[#d2d2d7] bg-[#fbfbfd] px-4 py-8 text-center">
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-2xl bg-white border border-[#d2d2d7]/60">
        <CopyPlus className="w-4 h-4 text-[#86868b]" />
      </div>
      <p className="text-[13px] font-medium text-[#1d1d1f]">{title}</p>
      <p className="mt-1 text-[12px] text-[#86868b]">{description}</p>
    </div>
  );
}
