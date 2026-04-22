/**
 * ProjectionWorkspace — módulo unificado de Proyección (antes Pronóstico + Escenarios).
 *
 * Reemplaza a Forecast.tsx y ScenariosWorkspace.tsx, que eran vistas paralelas
 * del mismo dato con solapes y huecos. Aquí todo vive junto:
 *
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │ Top bar: Escenario activo · Granularidad · [+ Escenario] [+ Prop.]  │
 *   ├──────────────────────────────────────────────────────────────────────┤
 *   │ 6 KPI cards (Ingresos · Egresos · Flujo · Caja · Cobranza · Pagos)  │
 *   ├──────────────────────────────────────────────────────────────────────┤
 *   │ Tabs: [P&L] [Flujo de Caja] [Drivers]                                │
 *   ├──────────────────┬───────────────────────────────────┬───────────────┤
 *   │ Propuestas       │  Gráfico Base vs Escenario        │  Drawer       │
 *   │ (toggles live)   │  (línea punteada + línea sólida)  │  editor de    │
 *   │ [+ crear]        ├───────────────────────────────────┤  propuesta    │
 *   │                  │  Tabla editable (doble-click)      │  (lateral)    │
 *   └──────────────────┴───────────────────────────────────┴───────────────┘
 *
 * Decisiones:
 *   - Sin "Simulación" intermedia. Escenario Base + N escenarios alternos.
 *   - Propuestas son globales y reusables; se encienden por escenario.
 *   - Overrides manuales por celda (solo en escenarios ≠ Base).
 *   - Drawer lateral derecho para crear/editar propuestas sin perder la vista.
 *   - Sin sistema de "confianza" (se removió; no agregaba suficiente valor).
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  BookmarkPlus,
  ChevronDown,
  FlaskConical,
  Lightbulb,
  Plus,
  Search,
  Trash2,
  X,
  Pencil,
  TrendingUp,
  TrendingDown,
  ArrowDownUp,
  Edit3,
} from 'lucide-react';
import {
  BASE_SCENARIO_ID,
  BASE_SCENARIO_NAME,
  CATEGORY_COLORS,
  EvaluatedCell,
  EvaluatedScenario,
  FlowConcept,
  FlowPlan,
  ForecastGranularity,
  MONTHS,
  Proposal,
  ProposalCategory,
  Scenario,
  ScenarioCellOverride,
  Simulation,
  scenarioCellKey,
} from '../types';
import { evaluateScenario } from '../domain/scenarioEngine';
import { isBaseScenario } from '../domain/proposalCompiler';
import { formatCompactNumber, formatCurrency } from '../utils/calculations';
import ProposalDrawer from './ProposalDrawer';

type ViewMode = 'pnl' | 'cashflow' | 'drivers';

interface ProjectionWorkspaceProps {
  plan: FlowPlan;
  scenarios: Scenario[];
  proposals: Proposal[];
  overrides: ScenarioCellOverride[];
  activeScenarioId: string | null;
  granularity: ForecastGranularity;
  onGranularityChange: (granularity: ForecastGranularity) => void;
  onSelectScenario: (scenarioId: string | null) => void;
  onUpdateScenario: (scenario: Scenario) => void;
  onDeleteScenario: (scenarioId: string) => void;
  onSaveAsScenario: (name: string, description: string, proposalIdsOverride?: string[]) => string;
  onOverridesChange: (overrides: ScenarioCellOverride[]) => void;
  onAddProposal: (proposal: Proposal) => void;
  onUpdateProposal: (proposal: Proposal) => void;
  onDeleteProposal: (id: string) => void;
}

const VIRTUAL_SIM: Simulation = {
  id: 'simulation-projection',
  name: 'Proyección',
  description: '',
  status: 'Pendiente',
  createdAt: '',
  updatedAt: '',
};

const CATEGORY_ORDER: ProposalCategory[] = [
  'Reducción de Costos',
  'Incremento de Ingresos',
  'Diferimiento',
  'Renegociación',
];

const VIEW_TABS: { id: ViewMode; label: string; hint: string }[] = [
  { id: 'pnl', label: 'P&L', hint: 'Ingresos y egresos por concepto' },
  { id: 'cashflow', label: 'Flujo de Caja', hint: 'Cobranza, pagos y caja final' },
  { id: 'drivers', label: 'Drivers', hint: 'Impacto por propuesta' },
];

function currentMonthIndex(planYear: number): number {
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  if (currentYear < planYear) return -1;
  if (currentYear > planYear) return 11;
  return now.getUTCMonth();
}

/** Filtra conceptos del plan por rol P&L o Cashflow. */
function filterConceptsByView(plan: FlowPlan, view: ViewMode): FlowConcept[] {
  const all = plan.concepts;
  const roots = all.filter((c) => !c.parentId);
  if (view === 'pnl') {
    return roots.filter((c) => c.conceptType === 'ingreso' || c.conceptType === 'egreso');
  }
  if (view === 'cashflow') {
    // Cashflow: todas las raíces, priorizando cobranza y pagos
    return roots;
  }
  return [];
}

/** Aplana un concepto + hijos respetando jerarquía. */
function flattenConcepts(
  concepts: FlowConcept[],
  allConcepts: FlowConcept[],
  expanded: Set<string>,
  depth: number = 0,
): { concept: FlowConcept; depth: number; hasChildren: boolean }[] {
  const out: { concept: FlowConcept; depth: number; hasChildren: boolean }[] = [];
  for (const c of concepts) {
    const children = allConcepts.filter((x) => x.parentId === c.id);
    out.push({ concept: c, depth, hasChildren: children.length > 0 });
    if (expanded.has(c.id) && children.length > 0) {
      out.push(...flattenConcepts(children, allConcepts, expanded, depth + 1));
    }
  }
  return out;
}

export default function ProjectionWorkspace({
  plan,
  scenarios,
  proposals,
  overrides,
  activeScenarioId,
  granularity,
  onGranularityChange,
  onSelectScenario,
  onUpdateScenario,
  onDeleteScenario,
  onSaveAsScenario,
  onOverridesChange,
  onAddProposal,
  onUpdateProposal,
  onDeleteProposal,
}: ProjectionWorkspaceProps) {
  // ── UI state ───────────────────────────────────────────────────────────
  const [view, setView] = useState<ViewMode>('pnl');
  const [proposalSearch, setProposalSearch] = useState('');
  const [scenarioMenuOpen, setScenarioMenuOpen] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerProposal, setDrawerProposal] = useState<Proposal | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editingCellKey, setEditingCellKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>('');

  // ── Scenario selection ────────────────────────────────────────────────
  const baseScenario = useMemo(
    () => scenarios.find((s) => isBaseScenario(s)) ?? null,
    [scenarios],
  );

  const activeScenario = useMemo(() => {
    const direct = scenarios.find((s) => s.id === activeScenarioId);
    if (direct) return direct;
    return baseScenario;
  }, [scenarios, activeScenarioId, baseScenario]);

  const isBase = activeScenario ? isBaseScenario(activeScenario) : false;

  // ── Evaluations ───────────────────────────────────────────────────────
  /** Con propuestas + overrides (la "línea azul" del escenario). */
  const activeEvaluation = useMemo<EvaluatedScenario | null>(() => {
    if (!activeScenario) return null;
    return evaluateScenario(
      plan,
      VIRTUAL_SIM,
      activeScenario,
      isBase ? [] : proposals,
      isBase ? [] : overrides,
      { granularity },
    );
  }, [activeScenario, granularity, overrides, plan, proposals, isBase]);

  /** Sin propuestas ni overrides (la "línea gris" de referencia). */
  const baseEvaluation = useMemo<EvaluatedScenario | null>(() => {
    if (!activeScenario) return null;
    return evaluateScenario(plan, VIRTUAL_SIM, activeScenario, [], [], { granularity });
  }, [activeScenario, granularity, plan]);

  // ── Proposals list ────────────────────────────────────────────────────
  const assignedProposalIds = useMemo(
    () => new Set(activeScenario?.proposalIds ?? []),
    [activeScenario],
  );

  const filteredProposals = useMemo(() => {
    const q = proposalSearch.trim().toLowerCase();
    if (!q) return proposals;
    return proposals.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q),
    );
  }, [proposalSearch, proposals]);

  const groupedProposals = useMemo(() => {
    const groups = new Map<ProposalCategory, Proposal[]>();
    CATEGORY_ORDER.forEach((cat) => groups.set(cat, []));
    filteredProposals.forEach((p) => {
      const g = groups.get(p.category);
      if (g) g.push(p);
      else groups.set(p.category, [p]);
    });
    return Array.from(groups.entries()).filter(([, items]) => items.length > 0);
  }, [filteredProposals]);

  // ── Chart data (caja final) ───────────────────────────────────────────
  const chartData = useMemo(() => {
    if (!activeEvaluation || !baseEvaluation) return [];
    const nowIdx = currentMonthIndex(plan.year);
    return activeEvaluation.months.map((m, i) => {
      const base = baseEvaluation.metrics.cajaFinal[i] ?? 0;
      const esc = activeEvaluation.metrics.cajaFinal[i] ?? 0;
      const diff = esc - base;
      return {
        month: m.label,
        base,
        escenario: esc,
        diff,
        gainBand: diff > 0 ? diff : 0,
        lossBand: diff < 0 ? -diff : 0,
        isReal: granularity === 'monthly' ? i <= nowIdx : false,
      };
    });
  }, [activeEvaluation, baseEvaluation, plan.year, granularity]);

  // ── KPIs ───────────────────────────────────────────────────────────────
  const kpis = activeEvaluation?.kpis;
  const baseKpis = baseEvaluation?.kpis;

  // ── Concepts to show in table ─────────────────────────────────────────
  const tableConcepts = useMemo(() => {
    if (view === 'drivers') return [];
    const roots = filterConceptsByView(plan, view);
    return flattenConcepts(roots, plan.concepts, expanded);
  }, [plan, view, expanded]);

  // ── Handlers ───────────────────────────────────────────────────────────
  const handleToggleProposal = (proposalId: string) => {
    if (!activeScenario || isBase) return;
    const exists = assignedProposalIds.has(proposalId);
    onUpdateScenario({
      ...activeScenario,
      proposalIds: exists
        ? activeScenario.proposalIds.filter((id) => id !== proposalId)
        : [...activeScenario.proposalIds, proposalId],
      updatedAt: new Date().toISOString(),
    });
  };

  const handleToggleExpand = (conceptId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(conceptId)) next.delete(conceptId);
      else next.add(conceptId);
      return next;
    });
  };

  const handleOpenCreateDrawer = () => {
    setDrawerProposal(null);
    setDrawerOpen(true);
  };

  const handleOpenEditDrawer = (proposal: Proposal) => {
    setDrawerProposal(proposal);
    setDrawerOpen(true);
  };

  const handleSaveProposal = (proposal: Proposal) => {
    const exists = proposals.some((p) => p.id === proposal.id);
    if (exists) {
      onUpdateProposal(proposal);
    } else {
      onAddProposal(proposal);
      // Auto-asignar al escenario activo (si no es Base)
      if (activeScenario && !isBase) {
        onUpdateScenario({
          ...activeScenario,
          proposalIds: [...activeScenario.proposalIds, proposal.id],
          updatedAt: new Date().toISOString(),
        });
      }
    }
    setDrawerOpen(false);
    setDrawerProposal(null);
  };

  const handleDeleteProposal = (id: string) => {
    onDeleteProposal(id);
    setDrawerOpen(false);
    setDrawerProposal(null);
  };

  const handleStartEditCell = (cell: EvaluatedCell) => {
    if (!cell.isEditable || isBase) return;
    setEditingCellKey(cell.key);
    setEditValue(String(Math.round(cell.finalValue)));
  };

  const handleCommitEditCell = (cell: EvaluatedCell) => {
    if (!activeScenario || isBase) return;
    const num = Number(editValue.replace(/,/g, ''));
    if (Number.isNaN(num)) {
      setEditingCellKey(null);
      return;
    }
    const newOverride: ScenarioCellOverride = {
      key: cell.key,
      scenarioId: activeScenario.id,
      conceptId: cell.conceptId,
      yearMonth: cell.yearMonth,
      baseValue: cell.baseValue,
      simulatedValue: cell.simulatedValue,
      manualValue: num,
      editedAt: new Date().toISOString(),
    };
    const next = overrides.filter((o) => o.key !== cell.key);
    // Solo guardar si difiere del simulado
    if (Math.abs(num - cell.simulatedValue) > 0.01) {
      next.push(newOverride);
    }
    onOverridesChange(next);
    setEditingCellKey(null);
  };

  const handleResetCell = (cell: EvaluatedCell) => {
    onOverridesChange(overrides.filter((o) => o.key !== cell.key));
  };

  // Auto-close menu on scenario change
  useEffect(() => {
    setScenarioMenuOpen(false);
  }, [activeScenarioId]);

  // ── Empty states ──────────────────────────────────────────────────────
  if (!activeScenario || !activeEvaluation || !baseEvaluation) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--gray-50)]">
          <FlaskConical className="h-7 w-7 text-[var(--gray-400)]" />
        </div>
        <h2 className="mt-4 text-[18px] font-semibold text-[var(--gray-950)]">
          No hay escenario activo
        </h2>
        <p className="mt-1 text-[13px] text-[var(--gray-500)]">
          Selecciona un escenario en la barra superior para comenzar.
        </p>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="relative flex flex-col gap-4">
      {/* ── TOP BAR ────────────────────────────────────────────────────── */}
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--gray-200)]/60 bg-white px-5 py-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          {/* Scenario selector */}
          <div className="relative">
            <button
              onClick={() => setScenarioMenuOpen((open) => !open)}
              className="flex items-center gap-2 rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2 text-[13px] font-medium text-[var(--gray-950)] hover:border-[var(--gray-300)]"
            >
              <span className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">
                Escenario
              </span>
              <span className="max-w-[220px] truncate">{activeScenario.name}</span>
              {isBase && (
                <span className="rounded-full bg-[var(--gray-100)] px-2 py-0.5 text-[10px] font-medium text-[var(--gray-500)]">
                  Base
                </span>
              )}
              <ChevronDown className="h-4 w-4 text-[var(--gray-400)]" />
            </button>
            {scenarioMenuOpen && (
              <div className="absolute left-0 top-full z-30 mt-1 w-72 overflow-hidden rounded-xl border border-[var(--gray-200)] bg-white shadow-lg">
                {scenarios.map((s) => {
                  const isActive = s.id === activeScenario.id;
                  const base = isBaseScenario(s);
                  return (
                    <div
                      key={s.id}
                      className={`flex items-center justify-between gap-2 px-3 py-2 text-[13px] hover:bg-[var(--gray-50)] ${
                        isActive ? 'bg-[var(--primary-muted)]' : ''
                      }`}
                    >
                      <button
                        onClick={() => {
                          onSelectScenario(s.id);
                          setScenarioMenuOpen(false);
                        }}
                        className="flex flex-1 items-center gap-2 text-left"
                      >
                        <div
                          className={`h-2 w-2 rounded-full ${
                            base ? 'bg-[var(--gray-400)]' : 'bg-[var(--primary)]'
                          }`}
                        />
                        <div className="min-w-0 flex-1">
                          <p
                            className={`truncate font-medium ${
                              isActive ? 'text-[var(--primary)]' : 'text-[var(--gray-950)]'
                            }`}
                          >
                            {s.name}
                          </p>
                          {s.description && (
                            <p className="truncate text-[11px] text-[var(--gray-400)]">
                              {s.description}
                            </p>
                          )}
                        </div>
                        <span className="text-[11px] text-[var(--gray-400)]">
                          {s.proposalIds.length} prop.
                        </span>
                      </button>
                      {!base && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`¿Eliminar escenario "${s.name}"?`)) {
                              onDeleteScenario(s.id);
                            }
                          }}
                          className="rounded p-1 text-[var(--gray-400)] hover:bg-[var(--danger)]/10 hover:text-[var(--danger)]"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Granularity */}
          <div className="flex items-center gap-0.5 rounded-xl border border-[var(--gray-200)] bg-white p-0.5">
            {(['monthly', 'weekly', 'daily'] as const).map((g) => (
              <button
                key={g}
                onClick={() => onGranularityChange(g)}
                className={`rounded-lg px-3 py-1.5 text-[12px] font-medium transition ${
                  granularity === g
                    ? 'bg-[var(--primary-muted)] text-[var(--primary)]'
                    : 'text-[var(--gray-500)] hover:bg-[var(--gray-50)]'
                }`}
              >
                {g === 'monthly' ? 'Mes' : g === 'weekly' ? 'Semana' : 'Día'}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setSaveDialogOpen(true)}
            className="flex items-center gap-1.5 rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2 text-[13px] font-medium text-[var(--gray-700)] hover:border-[var(--gray-300)]"
          >
            <BookmarkPlus className="h-4 w-4" />
            Guardar como escenario
          </button>
          <button
            onClick={handleOpenCreateDrawer}
            className="flex items-center gap-1.5 rounded-xl bg-[var(--primary)] px-3 py-2 text-[13px] font-medium text-white hover:bg-[var(--primary-hover)]"
          >
            <Plus className="h-4 w-4" />
            Nueva propuesta
          </button>
        </div>
      </header>

      {/* ── KPI CARDS ──────────────────────────────────────────────────── */}
      {kpis && baseKpis && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <KpiCard
            label="Ingresos 12m"
            value={kpis.ingresos12m}
            base={baseKpis.ingresos12m}
            positiveIsGood
          />
          <KpiCard
            label="Egresos 12m"
            value={kpis.egresos12m}
            base={baseKpis.egresos12m}
            positiveIsGood={false}
          />
          <KpiCard
            label="Flujo Neto 12m"
            value={kpis.flujoNeto12m}
            base={baseKpis.flujoNeto12m}
            positiveIsGood
          />
          <KpiCard
            label="Caja Final"
            value={kpis.cajaFinal}
            base={baseKpis.cajaFinal}
            positiveIsGood
          />
          <KpiCard
            label="Cobranza 12m"
            value={kpis.cobranza12m}
            base={baseKpis.cobranza12m}
            positiveIsGood
          />
          <KpiCard
            label="Pagos Prov. 12m"
            value={kpis.pagosProveedores12m}
            base={baseKpis.pagosProveedores12m}
            positiveIsGood={false}
          />
        </div>
      )}

      {/* ── VIEW TABS ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 border-b border-[var(--gray-200)]">
        {VIEW_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setView(t.id)}
            className={`relative px-4 py-2.5 text-[13px] font-medium transition ${
              view === t.id
                ? 'text-[var(--primary)]'
                : 'text-[var(--gray-500)] hover:text-[var(--gray-700)]'
            }`}
            title={t.hint}
          >
            {t.label}
            {view === t.id && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--primary)]" />
            )}
          </button>
        ))}
      </div>

      {/* ── MAIN GRID: sidebar + center ────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        {/* ── LEFT: Proposals sidebar ────────────────────────────────── */}
        <aside className="flex flex-col gap-2 rounded-2xl border border-[var(--gray-200)]/60 bg-white p-3 shadow-sm">
          <div className="flex items-center justify-between px-1 pb-1">
            <h3 className="text-[13px] font-semibold text-[var(--gray-950)]">Propuestas</h3>
            <span className="text-[11px] text-[var(--gray-400)]">
              {assignedProposalIds.size}/{proposals.length} activas
            </span>
          </div>

          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--gray-400)]" />
            <input
              type="text"
              value={proposalSearch}
              onChange={(e) => setProposalSearch(e.target.value)}
              placeholder="Buscar propuesta…"
              className="w-full rounded-lg border border-[var(--gray-200)] bg-[var(--gray-50)] py-1.5 pl-8 pr-2 text-[12px] outline-none focus:border-[var(--primary)]"
            />
            {proposalSearch && (
              <button
                onClick={() => setProposalSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--gray-400)] hover:text-[var(--gray-700)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {isBase && (
            <p className="rounded-lg bg-[var(--gray-50)] px-3 py-2 text-[11px] text-[var(--gray-500)]">
              El Escenario Base no admite propuestas. Crea uno nuevo para experimentar.
            </p>
          )}

          <div className="flex max-h-[560px] flex-col gap-3 overflow-y-auto pr-1">
            {groupedProposals.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-[var(--gray-200)] px-4 py-6 text-center">
                <Lightbulb className="h-5 w-5 text-[var(--gray-400)]" />
                <p className="text-[12px] text-[var(--gray-500)]">
                  {proposalSearch
                    ? 'Sin resultados'
                    : 'Aún no hay propuestas. Crea la primera.'}
                </p>
                {!proposalSearch && (
                  <button
                    onClick={handleOpenCreateDrawer}
                    className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-[12px] font-medium text-white"
                  >
                    Crear propuesta
                  </button>
                )}
              </div>
            ) : (
              groupedProposals.map(([category, items]) => (
                <div key={category} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2 px-1">
                    <div
                      className="h-2 w-2 rounded-full"
                      style={{ background: CATEGORY_COLORS[category] }}
                    />
                    <h4 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--gray-500)]">
                      {category}
                    </h4>
                    <span className="text-[10px] text-[var(--gray-400)]">({items.length})</span>
                  </div>
                  {items.map((p) => (
                    <ProposalCard
                      key={p.id}
                      proposal={p}
                      active={assignedProposalIds.has(p.id)}
                      disabled={isBase}
                      onToggle={() => handleToggleProposal(p.id)}
                      onEdit={() => handleOpenEditDrawer(p)}
                    />
                  ))}
                </div>
              ))
            )}
          </div>
        </aside>

        {/* ── CENTER: chart + table / drivers ────────────────────────── */}
        <main className="flex flex-col gap-4">
          {view === 'drivers' ? (
            <DriversPanel
              activeScenario={activeScenario}
              assignedProposalIds={assignedProposalIds}
              proposals={proposals}
              activeEvaluation={activeEvaluation}
              baseEvaluation={baseEvaluation}
              onToggle={handleToggleProposal}
              onEdit={handleOpenEditDrawer}
              isBase={isBase}
            />
          ) : (
            <>
              {/* CHART */}
              <section className="rounded-2xl border border-[var(--gray-200)]/60 bg-white p-4 shadow-sm">
                <div className="mb-2 flex items-center justify-between">
                  <div>
                    <h3 className="text-[14px] font-semibold text-[var(--gray-950)]">
                      Caja final · Base vs {activeScenario.name}
                    </h3>
                    <p className="text-[11px] text-[var(--gray-400)]">
                      Banda verde = mejora; roja = deterioro.
                    </p>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={260}>
                  <ComposedChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="pwGain" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--success)" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="var(--success)" stopOpacity={0.02} />
                      </linearGradient>
                      <linearGradient id="pwLoss" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--danger)" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="var(--danger)" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--gray-200)" />
                    <XAxis
                      dataKey="month"
                      tick={{ fill: 'var(--gray-500)', fontSize: 11 }}
                      tickLine={false}
                      axisLine={{ stroke: 'var(--gray-200)' }}
                    />
                    <YAxis
                      tick={{ fill: 'var(--gray-500)', fontSize: 11 }}
                      tickLine={false}
                      axisLine={{ stroke: 'var(--gray-200)' }}
                      tickFormatter={(v: number) => formatCompactNumber(v)}
                      width={72}
                    />
                    <Tooltip
                      formatter={(v: number) => formatCurrency(v)}
                      contentStyle={{
                        borderRadius: 12,
                        border: '1px solid var(--gray-200)',
                        fontSize: 12,
                      }}
                    />
                    <Legend verticalAlign="top" height={28} iconType="line" wrapperStyle={{ fontSize: 12 }} />
                    <Area dataKey="gainBand" stroke="none" fill="url(#pwGain)" legendType="none" isAnimationActive={false} />
                    <Area dataKey="lossBand" stroke="none" fill="url(#pwLoss)" legendType="none" isAnimationActive={false} />
                    <Line
                      type="monotone"
                      dataKey="base"
                      name={BASE_SCENARIO_NAME}
                      stroke="var(--gray-400)"
                      strokeWidth={2}
                      strokeDasharray="4 4"
                      dot={false}
                      isAnimationActive={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="escenario"
                      name={activeScenario.name}
                      stroke="var(--primary)"
                      strokeWidth={2.5}
                      dot={{ r: 3, fill: 'var(--primary)' }}
                      activeDot={{ r: 5 }}
                      isAnimationActive={false}
                    />
                    {granularity === 'monthly' && currentMonthIndex(plan.year) >= 0 && (
                      <ReferenceLine
                        x={MONTHS[currentMonthIndex(plan.year)]}
                        stroke="var(--gray-300)"
                        strokeDasharray="2 2"
                        label={{
                          value: 'Hoy',
                          position: 'insideTopRight',
                          fill: 'var(--gray-500)',
                          fontSize: 11,
                        }}
                      />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              </section>

              {/* TABLE */}
              <ConceptsTable
                evaluation={activeEvaluation}
                view={view}
                tableConcepts={tableConcepts}
                isBase={isBase}
                expanded={expanded}
                onToggleExpand={handleToggleExpand}
                editingCellKey={editingCellKey}
                editValue={editValue}
                onEditValueChange={setEditValue}
                onStartEdit={handleStartEditCell}
                onCommitEdit={handleCommitEditCell}
                onCancelEdit={() => setEditingCellKey(null)}
                onResetCell={handleResetCell}
              />
            </>
          )}
        </main>
      </div>

      {/* ── DIALOGS ──────────────────────────────────────────────────────── */}
      {saveDialogOpen && (
        <SaveScenarioDialog
          activeScenarioName={activeScenario.name}
          assignedCount={assignedProposalIds.size}
          isBase={isBase}
          onCancel={() => setSaveDialogOpen(false)}
          onSave={(name, description) => {
            const seed = isBase ? [] : [...(activeScenario.proposalIds ?? [])];
            const newId = onSaveAsScenario(name, description, seed);
            setSaveDialogOpen(false);
            onSelectScenario(newId);
          }}
        />
      )}

      {/* ── DRAWER ──────────────────────────────────────────────────────── */}
      {drawerOpen && (
        <ProposalDrawer
          plan={plan}
          proposal={drawerProposal}
          onClose={() => {
            setDrawerOpen(false);
            setDrawerProposal(null);
          }}
          onSave={handleSaveProposal}
          onDelete={drawerProposal ? () => handleDeleteProposal(drawerProposal.id) : undefined}
        />
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Sub-componentes
// ═════════════════════════════════════════════════════════════════════════════

function KpiCard({
  label,
  value,
  base,
  positiveIsGood,
}: {
  label: string;
  value: number;
  base: number;
  positiveIsGood: boolean;
}) {
  const delta = value - base;
  const deltaPct = base !== 0 ? (delta / Math.abs(base)) * 100 : null;
  const isPos = delta > 0;
  const isNeg = delta < 0;
  const good = (isPos && positiveIsGood) || (isNeg && !positiveIsGood);
  const bad = (isPos && !positiveIsGood) || (isNeg && positiveIsGood);
  const color = good
    ? 'var(--success)'
    : bad
      ? 'var(--danger)'
      : 'var(--gray-400)';

  return (
    <div className="rounded-xl border border-[var(--gray-200)]/60 bg-white p-3 shadow-sm">
      <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--gray-400)]">
        {label}
      </p>
      <p className="mt-1 text-[18px] font-semibold tabular-nums text-[var(--gray-950)]">
        {formatCompactNumber(value)}
      </p>
      {Math.abs(delta) > 0.01 && (
        <p className="mt-0.5 flex items-center gap-1 text-[11px] font-medium tabular-nums" style={{ color }}>
          {isPos ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
          {isPos ? '+' : ''}
          {formatCompactNumber(delta)}
          {deltaPct !== null && <span className="text-[var(--gray-400)]">({deltaPct.toFixed(1)}%)</span>}
        </p>
      )}
    </div>
  );
}

function ProposalCard({
  proposal,
  active,
  disabled,
  onToggle,
  onEdit,
}: {
  proposal: Proposal;
  active: boolean;
  disabled: boolean;
  onToggle: () => void;
  onEdit: () => void;
}) {
  return (
    <div
      className={`group flex items-start gap-2 rounded-xl border px-2.5 py-2 transition ${
        disabled
          ? 'cursor-not-allowed border-[var(--gray-200)]/50 bg-[var(--gray-50)]/50 opacity-60'
          : active
            ? 'border-[var(--primary)]/40 bg-[var(--primary-muted)]'
            : 'border-[var(--gray-200)]/60 bg-white hover:border-[var(--gray-300)]'
      }`}
    >
      <button
        onClick={onToggle}
        disabled={disabled}
        className="flex flex-1 items-start gap-2 text-left"
      >
        {/* Toggle indicator */}
        <div
          className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border transition ${
            active
              ? 'border-[var(--primary)] bg-[var(--primary)]'
              : 'border-[var(--gray-300)] bg-white'
          }`}
        >
          {active && <div className="h-1.5 w-1.5 rounded-sm bg-white" />}
        </div>
        <div className="min-w-0 flex-1">
          <p
            className={`truncate text-[12px] font-medium ${
              active ? 'text-[var(--primary)]' : 'text-[var(--gray-950)]'
            }`}
          >
            {proposal.name}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[11px] text-[var(--gray-400)]">
            {proposalSummary(proposal)}
          </p>
        </div>
      </button>
      <button
        onClick={onEdit}
        className="flex-shrink-0 rounded p-1 text-[var(--gray-400)] opacity-0 transition hover:bg-[var(--gray-100)] hover:text-[var(--gray-700)] group-hover:opacity-100"
        title="Editar propuesta"
      >
        <Pencil className="h-3 w-3" />
      </button>
    </div>
  );
}

function proposalSummary(p: Proposal): string {
  if (p.type === 'percent_adjustment' && p.percent !== undefined) {
    return `${p.operation === 'decrease' ? '−' : '+'}${p.percent}%`;
  }
  if ((p.type === 'amount_adjustment' || p.type === 'recurring_series') && p.amount !== undefined) {
    return `${p.operation === 'decrease' ? '−' : '+'}${formatCompactNumber(p.amount)}`;
  }
  if (p.type === 'installment_plan' && p.amount !== undefined) {
    return `${formatCompactNumber(p.amount)} en ${p.installments ?? 1} parcialidades`;
  }
  if (p.type === 'timing_shift') {
    return `${p.shiftMonths ?? 0} meses · ${Math.round((p.shiftRatio ?? 1) * 100)}%`;
  }
  if (p.type === 'pause_expense') {
    return 'Pausar 100%';
  }
  return p.description || '—';
}

function ConceptsTable({
  evaluation,
  view,
  tableConcepts,
  isBase,
  expanded,
  onToggleExpand,
  editingCellKey,
  editValue,
  onEditValueChange,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onResetCell,
}: {
  evaluation: EvaluatedScenario;
  view: ViewMode;
  tableConcepts: { concept: FlowConcept; depth: number; hasChildren: boolean }[];
  isBase: boolean;
  expanded: Set<string>;
  onToggleExpand: (id: string) => void;
  editingCellKey: string | null;
  editValue: string;
  onEditValueChange: (value: string) => void;
  onStartEdit: (cell: EvaluatedCell) => void;
  onCommitEdit: (cell: EvaluatedCell) => void;
  onCancelEdit: () => void;
  onResetCell: (cell: EvaluatedCell) => void;
}) {
  const months = evaluation.months;

  return (
    <section className="rounded-2xl border border-[var(--gray-200)]/60 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-[var(--gray-200)]/60 px-4 py-3">
        <div>
          <h3 className="text-[14px] font-semibold text-[var(--gray-950)]">
            {view === 'pnl' ? 'Estado de resultados' : 'Flujo de caja detallado'}
          </h3>
          <p className="text-[11px] text-[var(--gray-400)]">
            {isBase
              ? 'Escenario Base — solo lectura.'
              : 'Doble-click en una celda para editar manualmente. Los ajustes se guardan por escenario.'}
          </p>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-[var(--gray-200)]/60 bg-[var(--gray-50)] text-[11px] uppercase tracking-wide text-[var(--gray-500)]">
              <th className="sticky left-0 z-10 bg-[var(--gray-50)] px-4 py-2 text-left font-semibold">
                Concepto
              </th>
              {months.map((m) => (
                <th key={m.ym} className="px-3 py-2 text-right font-semibold">
                  {m.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tableConcepts.map(({ concept, depth, hasChildren }) => (
              <tr
                key={concept.id}
                className="border-b border-[var(--gray-200)]/40 hover:bg-[var(--gray-50)]/40"
              >
                <td
                  className="sticky left-0 z-10 bg-white px-4 py-2 text-[var(--gray-950)]"
                  style={{ paddingLeft: 16 + depth * 16 }}
                >
                  <div className="flex items-center gap-1.5">
                    {hasChildren ? (
                      <button
                        onClick={() => onToggleExpand(concept.id)}
                        className="flex h-4 w-4 items-center justify-center rounded text-[var(--gray-400)] hover:bg-[var(--gray-100)]"
                      >
                        <ChevronDown
                          className={`h-3 w-3 transition-transform ${
                            expanded.has(concept.id) ? '' : '-rotate-90'
                          }`}
                        />
                      </button>
                    ) : (
                      <div className="h-4 w-4" />
                    )}
                    <span
                      className={`truncate ${
                        depth === 0 ? 'font-semibold' : 'font-normal text-[var(--gray-700)]'
                      }`}
                    >
                      {concept.name}
                    </span>
                  </div>
                </td>
                {months.map((m) => {
                  const cellKey = scenarioCellKey(evaluation.scenarioId, concept.id, m.ym);
                  const cell = evaluation.cells.get(cellKey);
                  if (!cell) {
                    return (
                      <td key={m.ym} className="px-3 py-2 text-right text-[var(--gray-300)]">
                        —
                      </td>
                    );
                  }
                  const isEditing = editingCellKey === cell.key;
                  const hasProposalDelta = cell.hasProposalDelta;
                  const hasManualDelta = cell.hasManualDelta;
                  const editable = cell.isEditable && !isBase;

                  if (isEditing) {
                    return (
                      <td key={m.ym} className="px-2 py-1">
                        <input
                          autoFocus
                          type="text"
                          value={editValue}
                          onChange={(e) => onEditValueChange(e.target.value)}
                          onBlur={() => onCommitEdit(cell)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') onCommitEdit(cell);
                            else if (e.key === 'Escape') onCancelEdit();
                          }}
                          className="w-full rounded border border-[var(--primary)] bg-white px-1.5 py-0.5 text-right text-[12px] outline-none"
                        />
                      </td>
                    );
                  }

                  return (
                    <td
                      key={m.ym}
                      onDoubleClick={() => editable && onStartEdit(cell)}
                      title={
                        editable
                          ? `Base: ${formatCurrency(cell.baseValue)} · Doble-click para editar`
                          : undefined
                      }
                      className={`group relative px-3 py-2 text-right tabular-nums ${
                        editable ? 'cursor-text' : ''
                      } ${
                        hasManualDelta
                          ? 'bg-[var(--warning-muted)] font-semibold text-[var(--gray-950)]'
                          : hasProposalDelta
                            ? 'font-medium text-[var(--primary)]'
                            : 'text-[var(--gray-700)]'
                      }`}
                    >
                      {formatCompactNumber(cell.finalValue)}
                      {hasManualDelta && (
                        <button
                          onClick={() => onResetCell(cell)}
                          className="absolute right-0.5 top-0.5 hidden rounded p-0.5 text-[var(--gray-400)] hover:bg-white hover:text-[var(--gray-700)] group-hover:flex"
                          title="Descartar edición manual"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DriversPanel({
  activeScenario,
  assignedProposalIds,
  proposals,
  activeEvaluation,
  baseEvaluation,
  onToggle,
  onEdit,
  isBase,
}: {
  activeScenario: Scenario;
  assignedProposalIds: Set<string>;
  proposals: Proposal[];
  activeEvaluation: EvaluatedScenario;
  baseEvaluation: EvaluatedScenario;
  onToggle: (id: string) => void;
  onEdit: (p: Proposal) => void;
  isBase: boolean;
}) {
  // Calcular el impacto total (caja final) por cada propuesta activa
  const perProposalImpact = useMemo(() => {
    if (isBase || assignedProposalIds.size === 0) return [];
    const activeProposals = proposals.filter((p) => assignedProposalIds.has(p.id));
    return activeProposals
      .map((p) => {
        let totalDelta = 0;
        for (const cell of activeEvaluation.cells.values()) {
          const match = cell.proposalContributions.find((c) => c.proposalId === p.id);
          if (match) totalDelta += match.delta;
        }
        return { proposal: p, delta: totalDelta };
      })
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  }, [proposals, assignedProposalIds, activeEvaluation, isBase]);

  const totalCajaDelta =
    (activeEvaluation.kpis.cajaFinal ?? 0) - (baseEvaluation.kpis.cajaFinal ?? 0);

  if (isBase) {
    return (
      <div className="rounded-2xl border border-[var(--gray-200)]/60 bg-white p-8 text-center shadow-sm">
        <FlaskConical className="mx-auto h-8 w-8 text-[var(--gray-400)]" />
        <p className="mt-2 text-[13px] text-[var(--gray-500)]">
          El Escenario Base no tiene propuestas aplicadas.
        </p>
      </div>
    );
  }

  if (perProposalImpact.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-[var(--gray-200)] bg-white p-8 text-center">
        <Lightbulb className="mx-auto h-8 w-8 text-[var(--gray-400)]" />
        <p className="mt-2 text-[13px] text-[var(--gray-500)]">
          Este escenario no tiene propuestas activas.
        </p>
        <p className="mt-0.5 text-[11px] text-[var(--gray-400)]">
          Activa al menos una desde la barra lateral.
        </p>
      </div>
    );
  }

  return (
    <section className="rounded-2xl border border-[var(--gray-200)]/60 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-[14px] font-semibold text-[var(--gray-950)]">
            Impacto por propuesta
          </h3>
          <p className="text-[11px] text-[var(--gray-400)]">
            Contribución individual al cambio total en caja final.
          </p>
        </div>
        <div className="text-right">
          <p className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Δ total</p>
          <p
            className={`text-[18px] font-semibold tabular-nums ${
              totalCajaDelta >= 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]'
            }`}
          >
            {totalCajaDelta >= 0 ? '+' : ''}
            {formatCompactNumber(totalCajaDelta)}
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {perProposalImpact.map(({ proposal, delta }) => {
          const pct =
            totalCajaDelta !== 0 ? (Math.abs(delta) / Math.abs(totalCajaDelta)) * 100 : 0;
          const positive = delta > 0;
          return (
            <div
              key={proposal.id}
              className="rounded-xl border border-[var(--gray-200)]/60 bg-white p-3"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <div
                    className="h-2 w-2 flex-shrink-0 rounded-full"
                    style={{ background: CATEGORY_COLORS[proposal.category] }}
                  />
                  <p className="truncate text-[13px] font-medium text-[var(--gray-950)]">
                    {proposal.name}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <p
                    className={`text-[13px] font-semibold tabular-nums ${
                      positive ? 'text-[var(--success)]' : 'text-[var(--danger)]'
                    }`}
                  >
                    {positive ? '+' : ''}
                    {formatCompactNumber(delta)}
                  </p>
                  <button
                    onClick={() => onEdit(proposal)}
                    className="rounded p-1 text-[var(--gray-400)] hover:bg-[var(--gray-100)] hover:text-[var(--gray-700)]"
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => onToggle(proposal.id)}
                    className="rounded-lg bg-[var(--gray-100)] px-2 py-1 text-[11px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-200)]"
                  >
                    Desactivar
                  </button>
                </div>
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--gray-100)]">
                <div
                  className={`h-full ${positive ? 'bg-[var(--success)]' : 'bg-[var(--danger)]'}`}
                  style={{ width: `${Math.min(100, pct)}%` }}
                />
              </div>
              <p className="mt-1 text-[10px] text-[var(--gray-400)]">
                {pct.toFixed(1)}% del impacto total
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SaveScenarioDialog({
  activeScenarioName,
  assignedCount,
  isBase,
  onCancel,
  onSave,
}: {
  activeScenarioName: string;
  assignedCount: number;
  isBase: boolean;
  onCancel: () => void;
  onSave: (name: string, description: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const canSave = name.trim().length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-md rounded-2xl border border-[var(--gray-200)] bg-white p-5 shadow-xl">
        <h3 className="text-[16px] font-semibold text-[var(--gray-950)]">
          Guardar como escenario nuevo
        </h3>
        <p className="mt-1 text-[12px] text-[var(--gray-500)]">
          {isBase
            ? 'Clonas el Escenario Base. Empieza sin propuestas aplicadas.'
            : `Clona "${activeScenarioName}" con sus ${assignedCount} propuesta(s) activa(s).`}
        </p>
        <div className="mt-4 flex flex-col gap-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--gray-500)]">
              Nombre
            </label>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ej: Recorte agresivo, Renegociación flota…"
              className="w-full rounded-lg border border-[var(--gray-200)] bg-white px-3 py-2 text-[13px] outline-none focus:border-[var(--primary)]"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--gray-500)]">
              Descripción (opcional)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full resize-none rounded-lg border border-[var(--gray-200)] bg-white px-3 py-2 text-[13px] outline-none focus:border-[var(--primary)]"
            />
          </div>
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-[var(--gray-200)] bg-white px-3 py-2 text-[13px] font-medium text-[var(--gray-700)]"
          >
            Cancelar
          </button>
          <button
            onClick={() => canSave && onSave(name.trim(), description.trim())}
            disabled={!canSave}
            className="rounded-lg bg-[var(--primary)] px-3 py-2 text-[13px] font-medium text-white disabled:opacity-40"
          >
            Guardar escenario
          </button>
        </div>
      </div>
    </div>
  );
}
