import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  MessageSquare,
  RotateCcw,
  X,
} from 'lucide-react';
import { hex } from '../theme';
import {
  BASE_SCENARIO_ID,
  BASE_SCENARIO_NAME,
  EvaluatedCell,
  FlowConcept,
  FlowPlan,
  ForecastGranularity,
  ForecastLayerMode,
  ForecastView,
  Proposal,
  ROLE_TARGET_EXPENSE,
  ROLE_TARGET_INCOME,
  ROLE_TARGET_LABELS,
  Scenario,
  ScenarioCellOverride,
  Simulation,
  scenarioCellKey,
} from '../types';
import { evaluateScenario } from '../domain/scenarioEngine';
import { isBaseScenario } from '../domain/simulationCompiler';
import { formatCompactNumber, formatCurrency } from '../utils/calculations';

interface Props {
  plan: FlowPlan;
  proposals: Proposal[];
  scenarios: Scenario[];
  simulations: Simulation[];
  activeProposalId: string | null;
  activeScenarioId: string | null;
  overrides: ScenarioCellOverride[];
  granularity?: ForecastGranularity;
  onGranularityChange?: (granularity: ForecastGranularity) => void;
  onSelectProposal: (proposalId: string) => void;
  onSelectScenario: (scenarioId: string | null) => void;
  onOverridesChange: (next: ScenarioCellOverride[]) => void;
}

function buildChildrenIndex(plan: FlowPlan): Map<string, FlowConcept[]> {
  const childrenById = new Map<string, FlowConcept[]>();
  for (const concept of plan.concepts) {
    if (!concept.parentId) continue;
    const children = childrenById.get(concept.parentId) ?? [];
    children.push(concept);
    childrenById.set(concept.parentId, children);
  }
  for (const [parentId, children] of childrenById.entries()) {
    childrenById.set(parentId, children.sort((a, b) => a.sortOrder - b.sortOrder));
  }
  return childrenById;
}

function displayValue(cell: EvaluatedCell, mode: ForecastLayerMode): number {
  switch (mode) {
    case 'base':
      return cell.baseValue;
    case 'simulated':
      return cell.simulatedValue;
    case 'manual':
      return cell.finalValue;
    case 'diff':
      return cell.finalValue - cell.baseValue;
  }
}

const VIEW_OPTIONS: { value: ForecastView; label: string }[] = [
  { value: 'pnl', label: 'P&L' },
  { value: 'cashflow', label: 'Flujo de Caja' },
  { value: 'drivers', label: 'Drivers' },
];

export default function Forecast({
  plan,
  proposals,
  scenarios,
  simulations,
  activeProposalId,
  activeScenarioId,
  overrides,
  granularity = 'monthly',
  onGranularityChange,
  onSelectProposal,
  onSelectScenario,
  onOverridesChange,
}: Props) {
  const [view, setView] = useState<ForecastView>('pnl');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ conceptId: string; yearMonth: string } | null>(null);
  const [popover, setPopover] = useState<{ conceptId: string; yearMonth: string } | null>(null);
  const [layerMode, setLayerMode] = useState<ForecastLayerMode>('manual');

  const childrenById = useMemo(() => buildChildrenIndex(plan), [plan]);
  const baseScenario = scenarios.find((scenario) => isBaseScenario(scenario)) ?? null;
  const activeProposal = proposals.find((proposal) => proposal.id === activeProposalId) ?? proposals[0] ?? null;
  const activeScenario = scenarios.find((scenario) => scenario.id === activeScenarioId)
    ?? scenarios.find((scenario) => scenario.proposalId === activeProposal?.id)
    ?? baseScenario
    ?? null;
  const effectiveProposal = activeProposal ?? {
    id: 'proposal-base',
    name: BASE_SCENARIO_NAME,
    description: 'Pronóstico original',
    status: 'Pendiente' as const,
    createdAt: '',
    updatedAt: '',
  };
  const editingAllowed = !isBaseScenario(activeScenario) && granularity === 'monthly';

  const baseEvaluation = useMemo(() => {
    if (!activeScenario) return null;
    return evaluateScenario(plan, effectiveProposal, activeScenario, [], [], { granularity });
  }, [activeScenario, effectiveProposal, granularity, plan]);

  const simulatedEvaluation = useMemo(() => {
    if (!activeScenario) return null;
    return evaluateScenario(
      plan,
      effectiveProposal,
      activeScenario,
      isBaseScenario(activeScenario) ? [] : simulations,
      [],
      { granularity },
    );
  }, [activeScenario, effectiveProposal, granularity, plan, simulations]);

  const finalEvaluation = useMemo(() => {
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

  const months = finalEvaluation?.months ?? [];
  const roots = useMemo(
    () => plan.concepts.filter((concept) => !concept.parentId).sort((a, b) => a.sortOrder - b.sortOrder),
    [plan.concepts],
  );
  const ingresosRoots = roots.filter((concept) => concept.conceptType === 'ingreso');
  const egresosRoots = roots.filter((concept) => concept.conceptType === 'egreso');
  const allRoots = roots.filter((concept) => concept.conceptType !== 'reserva');

  useEffect(() => {
    setEditing(null);
    setPopover(null);
  }, [activeScenarioId, activeProposalId, granularity, layerMode, view]);

  const viewTitle = view === 'pnl' ? 'Estado de Resultados' : view === 'cashflow' ? 'Flujo de Caja' : 'Drivers';

  if (!activeScenario || !baseEvaluation || !simulatedEvaluation || !finalEvaluation) {
    return (
      <div className="rounded-2xl border border-dashed border-[var(--gray-200)] bg-white px-6 py-20 text-center">
        <h2 className="text-[18px] font-semibold text-[var(--gray-950)]">No hay escenario activo</h2>
        <p className="mt-2 text-[13px] text-[var(--gray-400)]">
          Selecciona una simulación y un escenario en el módulo de Propuestas para habilitar el pronóstico.
        </p>
      </div>
    );
  }

  const metrics =
    layerMode === 'base'
      ? baseEvaluation.metrics
      : layerMode === 'simulated'
        ? simulatedEvaluation.metrics
        : layerMode === 'manual'
          ? finalEvaluation.metrics
          : {
              ingresos: finalEvaluation.metrics.ingresos.map((value, index) => value - (baseEvaluation.metrics.ingresos[index] ?? 0)),
              egresos: finalEvaluation.metrics.egresos.map((value, index) => value - (baseEvaluation.metrics.egresos[index] ?? 0)),
              flujoNeto: finalEvaluation.metrics.flujoNeto.map((value, index) => value - (baseEvaluation.metrics.flujoNeto[index] ?? 0)),
              cajaFinal: finalEvaluation.metrics.cajaFinal.map((value, index) => value - (baseEvaluation.metrics.cajaFinal[index] ?? 0)),
              cobranza: finalEvaluation.metrics.cobranza.map((value, index) => value - (baseEvaluation.metrics.cobranza[index] ?? 0)),
              pagosProveedores: finalEvaluation.metrics.pagosProveedores.map((value, index) => value - (baseEvaluation.metrics.pagosProveedores[index] ?? 0)),
              saldosFinales: finalEvaluation.metrics.saldosFinales.map((value, index) => value - (baseEvaluation.metrics.saldosFinales[index] ?? 0)),
            };

  const directOverrides = overrides.filter((override) => override.scenarioId === activeScenario.id);
  const directOverrideCount = directOverrides.length;
  const commentCount = directOverrides.filter((override) => override.comment).length;

  const roleRows = [
    { id: ROLE_TARGET_INCOME, label: ROLE_TARGET_LABELS[ROLE_TARGET_INCOME], category: 'ingreso' as const },
    { id: ROLE_TARGET_EXPENSE, label: ROLE_TARGET_LABELS[ROLE_TARGET_EXPENSE], category: 'egreso' as const },
  ].filter((roleRow) => {
    return months.some((month) => {
      const cell = finalEvaluation.cells.get(scenarioCellKey(activeScenario.id, roleRow.id, month.ym));
      return cell ? (cell.finalValue !== 0 || cell.simulatedValue !== 0 || cell.baseValue !== 0) : false;
    });
  });

  const handleClearScenarioOverrides = () => {
    if (!editingAllowed) return;
    onOverridesChange(overrides.filter((override) => override.scenarioId !== activeScenario.id));
  };

  const applyOverride = (conceptId: string, yearMonth: string, manualValue: number) => {
    if (!editingAllowed) return;
    const cell = finalEvaluation.cells.get(scenarioCellKey(activeScenario.id, conceptId, yearMonth));
    if (!cell || !cell.isEditable) return;
    const existing = overrides.find((override) => override.key === scenarioCellKey(activeScenario.id, conceptId, yearMonth));
    const nextKey = scenarioCellKey(activeScenario.id, conceptId, yearMonth);

    if (manualValue === cell.simulatedValue && !existing?.comment) {
      onOverridesChange(overrides.filter((override) => override.key !== nextKey));
      return;
    }

    const nextOverride: ScenarioCellOverride = {
      key: nextKey,
      scenarioId: activeScenario.id,
      conceptId,
      yearMonth,
      baseValue: cell.baseValue,
      simulatedValue: cell.simulatedValue,
      manualValue,
      comment: existing?.comment,
      editedAt: new Date().toISOString(),
    };

    onOverridesChange([...overrides.filter((override) => override.key !== nextKey), nextOverride]);
  };

  const setComment = (conceptId: string, yearMonth: string, comment: string) => {
    if (!editingAllowed) return;
    const cell = finalEvaluation.cells.get(scenarioCellKey(activeScenario.id, conceptId, yearMonth));
    if (!cell || !cell.isEditable) return;

    const existing = overrides.find((override) => override.key === scenarioCellKey(activeScenario.id, conceptId, yearMonth));
    const nextKey = scenarioCellKey(activeScenario.id, conceptId, yearMonth);

    if (!existing && !comment.trim()) return;

    if (existing) {
      const nextOverride: ScenarioCellOverride = {
        ...existing,
        baseValue: cell.baseValue,
        simulatedValue: cell.simulatedValue,
        manualValue: existing.manualValue,
        comment: comment.trim() || undefined,
        editedAt: new Date().toISOString(),
      };
      onOverridesChange([...overrides.filter((override) => override.key !== nextKey), nextOverride]);
      return;
    }

    const nextOverride: ScenarioCellOverride = {
      key: nextKey,
      scenarioId: activeScenario.id,
      conceptId,
      yearMonth,
      baseValue: cell.baseValue,
      simulatedValue: cell.simulatedValue,
      manualValue: cell.simulatedValue,
      comment: comment.trim(),
      editedAt: new Date().toISOString(),
    };
    onOverridesChange([...overrides, nextOverride]);
  };

  const restoreOverride = (conceptId: string, yearMonth: string) => {
    const key = scenarioCellKey(activeScenario.id, conceptId, yearMonth);
    onOverridesChange(overrides.filter((override) => override.key !== key));
    setPopover(null);
  };

  return (
    <div className="space-y-5" onClick={() => setPopover(null)}>
      <header className="rounded-2xl border border-[var(--gray-200)]/50 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <h1 className="text-[24px] font-semibold text-[var(--gray-950)]">{viewTitle}</h1>
            <div className="flex items-center rounded-xl bg-[var(--gray-50)] p-1">
              {VIEW_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setView(opt.value)}
                  className={`rounded-lg px-3 py-1.5 text-[12px] font-medium transition ${
                    view === opt.value
                      ? 'bg-white text-[var(--gray-950)] shadow-sm'
                      : 'text-[var(--gray-500)]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          {directOverrideCount > 0 && (
            <button
              onClick={handleClearScenarioOverrides}
              className="inline-flex items-center gap-2 rounded-full border border-[#ff9500]/40 bg-[#ff9500]/10 px-3 py-2 text-[12px] font-medium text-[#ff9500]"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Restaurar {directOverrideCount}
            </button>
          )}
        </div>
        <p className="mt-2 text-[13px] text-[var(--gray-400)]">
          Pronóstico unificado por escenario y ajustes activos. Doble clic en celdas hoja para editar manualmente.
        </p>

        <div className="mt-5 grid grid-cols-[240px,240px,minmax(0,1fr)] gap-4">
          <button
            onClick={() => onSelectScenario(BASE_SCENARIO_ID)}
            className={`rounded-xl border px-3 py-2 text-[13px] font-medium transition ${
              isBaseScenario(activeScenario)
                ? 'border-[#1d1d1f] bg-[#1d1d1f] text-white'
                : 'border-[var(--gray-200)] bg-[var(--surface-alt)] text-[var(--gray-950)]'
            }`}
          >
            {BASE_SCENARIO_NAME}
          </button>
          <select
            value={activeProposal?.id ?? ''}
            onChange={(event) => onSelectProposal(event.target.value)}
            disabled={proposals.length === 0}
            className="rounded-xl border border-[var(--gray-200)] bg-[var(--surface-alt)] px-3 py-2 text-[13px]"
          >
            {proposals.length === 0 && <option value="">Sin escenarios</option>}
            {proposals.map((proposal) => (
              <option key={proposal.id} value={proposal.id}>{proposal.name}</option>
            ))}
          </select>
          <select
            value={activeScenario.id}
            onChange={(event) => onSelectScenario(event.target.value)}
            className="rounded-xl border border-[var(--gray-200)] bg-[var(--surface-alt)] px-3 py-2 text-[13px]"
          >
            {baseScenario && (
              <option value={baseScenario.id}>{baseScenario.name}</option>
            )}
            {scenarios
              .filter((scenario) => activeProposal ? scenario.proposalId === activeProposal.id : false)
              .map((scenario) => (
                <option key={scenario.id} value={scenario.id}>{scenario.name}</option>
              ))}
          </select>
          <div className="flex items-center justify-end rounded-xl bg-[var(--gray-50)] p-1">
            {(['base', 'simulated', 'manual', 'diff'] as ForecastLayerMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => setLayerMode(mode)}
                className={`rounded-lg px-3 py-1.5 text-[12px] font-medium transition ${
                  layerMode === mode
                    ? 'bg-white text-[var(--gray-950)] shadow-sm'
                    : 'text-[var(--gray-500)]'
                }`}
              >
                {mode === 'base' ? 'Base' : mode === 'simulated' ? 'Simulado' : mode === 'manual' ? 'Manual' : 'Diff'}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-4 text-[12px] text-[var(--gray-400)]">
          <LegendDot color="bg-[#d2d2d7]" label="Base" />
          <LegendDot color="bg-[var(--primary)]" label="Impactada por ajuste" />
          <LegendDot color="bg-[#ff9500]" label={`Ajuste manual${directOverrideCount > 0 ? ` (${directOverrideCount})` : ''}`} />
          <span className="inline-flex items-center gap-1.5">
            <MessageSquare className="w-3.5 h-3.5 text-[var(--primary)]" />
            Comentarios{commentCount > 0 ? ` (${commentCount})` : ''}
          </span>
          {isBaseScenario(activeScenario) && (
            <span className="rounded-full bg-[var(--gray-50)] px-2.5 py-1 text-[11px] text-[var(--gray-500)]">
              Solo lectura: el Base no admite edición manual
            </span>
          )}
          {granularity !== 'monthly' && (
            <span className="rounded-full bg-[var(--gray-50)] px-2.5 py-1 text-[11px] text-[var(--gray-500)]">
              Los ajustes manuales se editan en vista mensual y se reflejan en el resto de vistas.
            </span>
          )}
        </div>
      </header>

      <div className="grid grid-cols-6 gap-4">
        <KpiCard label="Ingresos" value={metrics.ingresos.reduce((sum, value) => sum + value, 0)} tone="pos" />
        <KpiCard label="Egresos" value={metrics.egresos.reduce((sum, value) => sum + value, 0)} tone="neg" />
        <KpiCard label="Flujo Neto" value={metrics.flujoNeto.reduce((sum, value) => sum + value, 0)} tone="neutral" />
        <KpiCard label="Caja Final" value={metrics.cajaFinal[metrics.cajaFinal.length - 1] ?? 0} tone="cash" />
        <KpiCard label="Cobranza" value={metrics.cobranza.reduce((sum, value) => sum + value, 0)} tone="pos" />
        <KpiCard label="Pagos Prov." value={metrics.pagosProveedores.reduce((sum, value) => sum + value, 0)} tone="neg" />
      </div>

      <section className="rounded-2xl border border-[var(--gray-200)]/50 bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-[13px]">
            <thead className="border-b border-[#e8e8ed] bg-[var(--surface-alt)]">
              <tr>
                <th className="sticky left-0 min-w-[240px] bg-[var(--surface-alt)] px-4 py-2.5 text-left font-medium text-[var(--gray-400)]">Concepto</th>
                {months.map((month) => (
                  <th key={month.ym} className="px-3 py-2.5 text-right font-medium text-[var(--gray-400)]">{month.label}</th>
                ))}
                <th className="bg-[var(--gray-50)] px-4 py-2.5 text-right font-medium text-[var(--gray-400)]">Total</th>
              </tr>
            </thead>
            <tbody>
              {view === 'drivers' ? (
                <>
                  {allRoots.map((root) => (
                    <ConceptRow
                      key={root.id}
                      concept={root}
                      depth={0}
                      activeScenario={activeScenario}
                      evaluation={finalEvaluation}
                      months={months}
                      childrenById={childrenById}
                      expanded={expanded}
                      onToggle={(conceptId) => toggleExpanded(setExpanded, conceptId)}
                      layerMode={layerMode}
                      editing={editing}
                      setEditing={setEditing}
                      popover={popover}
                      setPopover={setPopover}
                      editingAllowed={editingAllowed}
                      applyOverride={applyOverride}
                      restoreOverride={restoreOverride}
                      setComment={setComment}
                    />
                  ))}
                </>
              ) : (
                <>
                  <CategoryHeader label={view === 'pnl' ? 'Ingresos' : 'Entradas'} colSpan={months.length + 1} />
                  {ingresosRoots.map((root) => (
                    <ConceptRow
                      key={root.id}
                      concept={root}
                      depth={0}
                      activeScenario={activeScenario}
                      evaluation={finalEvaluation}
                      months={months}
                      childrenById={childrenById}
                      expanded={expanded}
                      onToggle={(conceptId) => toggleExpanded(setExpanded, conceptId)}
                      layerMode={layerMode}
                      editing={editing}
                      setEditing={setEditing}
                      popover={popover}
                      setPopover={setPopover}
                      editingAllowed={editingAllowed}
                      applyOverride={applyOverride}
                      restoreOverride={restoreOverride}
                      setComment={setComment}
                    />
                  ))}
                  {roleRows.filter((row) => row.category === 'ingreso').map((row) => (
                    <RoleRow
                      key={row.id}
                      rowId={row.id}
                      label={row.label}
                      activeScenario={activeScenario}
                      evaluation={finalEvaluation}
                      months={months}
                      layerMode={layerMode}
                    />
                  ))}
                  <MetricTotalRow
                    label={view === 'pnl' ? 'Total Ingresos' : 'Total Entradas'}
                    values={metrics.ingresos}
                    tone="pos"
                  />

                  <CategoryHeader label={view === 'pnl' ? 'Egresos' : 'Salidas'} colSpan={months.length + 1} />
                  {egresosRoots.map((root) => (
                    <ConceptRow
                      key={root.id}
                      concept={root}
                      depth={0}
                      activeScenario={activeScenario}
                      evaluation={finalEvaluation}
                      months={months}
                      childrenById={childrenById}
                      expanded={expanded}
                      onToggle={(conceptId) => toggleExpanded(setExpanded, conceptId)}
                      layerMode={layerMode}
                      editing={editing}
                      setEditing={setEditing}
                      popover={popover}
                      setPopover={setPopover}
                      editingAllowed={editingAllowed}
                      applyOverride={applyOverride}
                      restoreOverride={restoreOverride}
                      setComment={setComment}
                    />
                  ))}
                  {roleRows.filter((row) => row.category === 'egreso').map((row) => (
                    <RoleRow
                      key={row.id}
                      rowId={row.id}
                      label={row.label}
                      activeScenario={activeScenario}
                      evaluation={finalEvaluation}
                      months={months}
                      layerMode={layerMode}
                    />
                  ))}
                  <MetricTotalRow
                    label={view === 'pnl' ? 'Total Egresos' : 'Total Salidas'}
                    values={metrics.egresos}
                    tone="neg"
                  />
                  <MetricTotalRow
                    label={view === 'pnl' ? 'Utilidad Neta' : 'Flujo Neto'}
                    values={metrics.flujoNeto}
                    tone="neutral"
                  />
                </>
              )}
            </tbody>
            {view === 'cashflow' && (
              <tfoot className="border-t-2 border-[#1d1d1f]/10 bg-[var(--surface-alt)]">
                <tr>
                  <td className="sticky left-0 bg-[var(--surface-alt)] px-4 py-2.5 font-semibold text-[var(--gray-950)]">Caja inicial</td>
                  {months.map((month, index) => (
                    <td key={month.ym} className="px-3 py-2.5 text-right tabular-nums text-[var(--gray-500)]">
                      {layerMode === 'diff'
                        ? formatCompactNumber(index === 0 ? 0 : metrics.cajaFinal[index - 1] ?? 0)
                        : formatCompactNumber(index === 0 ? plan.cajaInicial : metrics.cajaFinal[index - 1] ?? 0)}
                    </td>
                  ))}
                  <td className="bg-[var(--gray-50)] px-4 py-2.5 text-right tabular-nums text-[var(--gray-500)]">
                    {layerMode === 'diff' ? '0' : formatCompactNumber(plan.cajaInicial)}
                  </td>
                </tr>
                <tr>
                  <td className="sticky left-0 bg-[var(--surface-alt)] px-4 py-2.5 font-semibold text-[var(--gray-950)]">Caja al cierre</td>
                  {metrics.cajaFinal.map((value, index) => (
                    <td key={`${months[index]?.ym ?? index}-cash`} className={`px-3 py-2.5 text-right tabular-nums font-semibold ${value < 0 ? 'text-[var(--danger)]' : 'text-[var(--gray-950)]'}`}>
                      {layerMode === 'diff' && value > 0 ? '+' : ''}{formatCompactNumber(value)}
                    </td>
                  ))}
                  <td className={`bg-[var(--gray-50)] px-4 py-2.5 text-right tabular-nums font-semibold ${(metrics.cajaFinal[metrics.cajaFinal.length - 1] ?? 0) < 0 ? 'text-[var(--danger)]' : 'text-[var(--gray-950)]'}`}>
                    {(layerMode === 'diff' && (metrics.cajaFinal[metrics.cajaFinal.length - 1] ?? 0) > 0) ? '+' : ''}
                    {formatCompactNumber(metrics.cajaFinal[metrics.cajaFinal.length - 1] ?? 0)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </section>
    </div>
  );
}

function toggleExpanded(
  setExpanded: Dispatch<SetStateAction<Set<string>>>,
  conceptId: string,
) {
  setExpanded((current) => {
    const next = new Set(current);
    if (next.has(conceptId)) next.delete(conceptId);
    else next.add(conceptId);
    return next;
  });
}

function CategoryHeader({ label, colSpan }: { label: string; colSpan: number }) {
  return (
    <tr className="border-t border-[var(--gray-200)] bg-[var(--surface-alt)]/70">
      <td className="sticky left-0 bg-[var(--surface-alt)]/70 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--gray-400)]">
        {label}
      </td>
      <td colSpan={colSpan} />
    </tr>
  );
}

function RoleRow({
  rowId,
  label,
  activeScenario,
  evaluation,
  months,
  layerMode,
}: {
  rowId: string;
  label: string;
  activeScenario: Scenario;
  evaluation: ReturnType<typeof evaluateScenario>;
  months: ReturnType<typeof evaluateScenario>['months'];
  layerMode: ForecastLayerMode;
}) {
  const total = months.reduce((sum, month) => {
    const cell = evaluation.cells.get(scenarioCellKey(activeScenario.id, rowId, month.ym));
    return sum + (cell ? displayValue(cell, layerMode) : 0);
  }, 0);

  return (
    <tr className="border-t border-[var(--gray-200)]/30 bg-[var(--gray-50)]/50">
      <td className="sticky left-0 bg-[var(--gray-50)]/50 px-4 py-2 text-[var(--gray-950)]">{label}</td>
      {months.map((month) => {
        const cell = evaluation.cells.get(scenarioCellKey(activeScenario.id, rowId, month.ym));
        const value = cell ? displayValue(cell, layerMode) : 0;
        return (
          <td key={month.ym} className="px-3 py-2 text-right tabular-nums text-[var(--primary)]">
            {value === 0 ? '—' : `${layerMode === 'diff' && value > 0 ? '+' : ''}${formatCompactNumber(value)}`}
          </td>
        );
      })}
      <td className="bg-[var(--gray-50)] px-4 py-2 text-right tabular-nums text-[var(--primary)]">
        {total === 0 ? '—' : `${layerMode === 'diff' && total > 0 ? '+' : ''}${formatCompactNumber(total)}`}
      </td>
    </tr>
  );
}

interface RowProps {
  concept: FlowConcept;
  depth: number;
  activeScenario: Scenario;
  evaluation: ReturnType<typeof evaluateScenario>;
  months: ReturnType<typeof evaluateScenario>['months'];
  childrenById: Map<string, FlowConcept[]>;
  expanded: Set<string>;
  onToggle: (conceptId: string) => void;
  layerMode: ForecastLayerMode;
  editing: { conceptId: string; yearMonth: string } | null;
  setEditing: (editing: { conceptId: string; yearMonth: string } | null) => void;
  popover: { conceptId: string; yearMonth: string } | null;
  setPopover: (popover: { conceptId: string; yearMonth: string } | null) => void;
  editingAllowed: boolean;
  applyOverride: (conceptId: string, yearMonth: string, manualValue: number) => void;
  restoreOverride: (conceptId: string, yearMonth: string) => void;
  setComment: (conceptId: string, yearMonth: string, comment: string) => void;
}

function ConceptRow({
  concept,
  depth,
  activeScenario,
  evaluation,
  months,
  childrenById,
  expanded,
  onToggle,
  layerMode,
  editing,
  setEditing,
  popover,
  setPopover,
  editingAllowed,
  applyOverride,
  restoreOverride,
  setComment,
}: RowProps) {
  const children = childrenById.get(concept.id) ?? [];
  const hasChildren = children.length > 0;
  const isOpen = expanded.has(concept.id);
  const total = months.reduce((sum, month) => {
    const cell = evaluation.cells.get(scenarioCellKey(activeScenario.id, concept.id, month.ym));
    return sum + (cell ? displayValue(cell, layerMode) : 0);
  }, 0);

  return (
    <>
      <tr className="border-t border-[var(--gray-200)]/30 hover:bg-[var(--gray-50)]/60">
        <td className="sticky left-0 bg-white px-4 py-2" style={{ paddingLeft: 16 + depth * 16 }}>
          <div className="flex items-center gap-1.5">
            {hasChildren ? (
              <button onClick={() => onToggle(concept.id)} className="rounded p-0.5 hover:bg-[var(--gray-100)]">
                {isOpen ? (
                  <ChevronDown className="w-3.5 h-3.5 text-[var(--gray-400)]" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-[var(--gray-400)]" />
                )}
              </button>
            ) : (
              <span className="w-4" />
            )}
            <span className="text-[var(--gray-950)]">{concept.name}</span>
          </div>
        </td>
        {months.map((month) => {
          const cell = evaluation.cells.get(scenarioCellKey(activeScenario.id, concept.id, month.ym));
          if (!cell) return <td key={month.ym} />;
          return (
            <EditableCell
              key={month.ym}
              cell={cell}
              label={concept.name}
              editingAllowed={editingAllowed}
              layerMode={layerMode}
              editing={editing}
              setEditing={setEditing}
              popover={popover}
              setPopover={setPopover}
              applyOverride={applyOverride}
              restoreOverride={restoreOverride}
              setComment={setComment}
            />
          );
        })}
        <td className="bg-[var(--gray-50)] px-4 py-2 text-right tabular-nums font-medium">
          {total === 0 ? '—' : `${layerMode === 'diff' && total > 0 ? '+' : ''}${formatCompactNumber(total)}`}
        </td>
      </tr>
      {isOpen && children.map((child) => (
        <ConceptRow
          key={child.id}
          concept={child}
          depth={depth + 1}
          activeScenario={activeScenario}
          evaluation={evaluation}
          months={months}
          childrenById={childrenById}
          expanded={expanded}
          onToggle={onToggle}
          layerMode={layerMode}
          editing={editing}
          setEditing={setEditing}
          popover={popover}
          setPopover={setPopover}
          editingAllowed={editingAllowed}
          applyOverride={applyOverride}
          restoreOverride={restoreOverride}
          setComment={setComment}
        />
      ))}
    </>
  );
}

function EditableCell({
  cell,
  label,
  editingAllowed,
  layerMode,
  editing,
  setEditing,
  popover,
  setPopover,
  applyOverride,
  restoreOverride,
  setComment,
}: {
  cell: EvaluatedCell;
  label: string;
  editingAllowed: boolean;
  layerMode: ForecastLayerMode;
  editing: { conceptId: string; yearMonth: string } | null;
  setEditing: (editing: { conceptId: string; yearMonth: string } | null) => void;
  popover: { conceptId: string; yearMonth: string } | null;
  setPopover: (popover: { conceptId: string; yearMonth: string } | null) => void;
  applyOverride: (conceptId: string, yearMonth: string, manualValue: number) => void;
  restoreOverride: (conceptId: string, yearMonth: string) => void;
  setComment: (conceptId: string, yearMonth: string, comment: string) => void;
}) {
  const isEditing = editing?.conceptId === cell.conceptId && editing.yearMonth === cell.yearMonth;
  const isPopoverOpen = popover?.conceptId === cell.conceptId && popover.yearMonth === cell.yearMonth;
  const [draft, setDraft] = useState(String(cell.finalValue));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isEditing) return;
    setDraft(String(cell.finalValue));
    setTimeout(() => inputRef.current?.select(), 0);
  }, [cell.finalValue, isEditing]);

  const value = displayValue(cell, layerMode);
  const colorClass = cell.hasManualDelta
    ? 'bg-[#ff9500]/10 text-[#ff9500]'
    : cell.hasSimulationDelta
      ? 'bg-[var(--primary)]/8 text-[var(--primary)]'
      : 'text-[var(--gray-950)]';

  const commit = () => {
    const cleaned = draft.replace(/[^0-9.\-]/g, '');
    const nextValue = Number(cleaned);
    if (!Number.isNaN(nextValue)) {
      applyOverride(cell.conceptId, cell.yearMonth, nextValue);
    }
    setEditing(null);
  };

  return (
    <td
      className={`relative cursor-cell px-3 py-2 text-right tabular-nums ${colorClass}`}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (!cell.isEditable || !editingAllowed) return;
        setEditing({ conceptId: cell.conceptId, yearMonth: cell.yearMonth });
      }}
      onClick={(event) => {
        event.stopPropagation();
        setPopover(isPopoverOpen ? null : { conceptId: cell.conceptId, yearMonth: cell.yearMonth });
      }}
    >
      {isEditing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
            if (event.key === 'Escape') setEditing(null);
          }}
          className="w-full rounded border border-[#0071e3] bg-white px-1 py-0.5 text-right outline-none"
        />
      ) : (
        <>
          <span className="inline-flex items-center justify-end gap-1">
            {(cell.hasManualDelta || cell.hasSimulationDelta) && (
              <span className={`h-1.5 w-1.5 rounded-full ${cell.hasManualDelta ? 'bg-[#ff9500]' : 'bg-[var(--primary)]'}`} />
            )}
            {cell.comment && <MessageSquare className="w-3 h-3 text-[var(--primary)]" />}
            <span>{value === 0 ? '—' : `${layerMode === 'diff' && value > 0 ? '+' : ''}${formatCompactNumber(value)}`}</span>
          </span>
          {isPopoverOpen && (
            <CellPopover
              cell={cell}
              label={label}
              editingAllowed={editingAllowed}
              onClose={() => setPopover(null)}
              onEdit={() => {
                setPopover(null);
                if (cell.isEditable && editingAllowed) setEditing({ conceptId: cell.conceptId, yearMonth: cell.yearMonth });
              }}
              onRestore={() => restoreOverride(cell.conceptId, cell.yearMonth)}
              onSetComment={(comment) => setComment(cell.conceptId, cell.yearMonth, comment)}
            />
          )}
        </>
      )}
    </td>
  );
}

function CellPopover({
  cell,
  label,
  editingAllowed,
  onClose,
  onEdit,
  onRestore,
  onSetComment,
}: {
  cell: EvaluatedCell;
  label: string;
  editingAllowed: boolean;
  onClose: () => void;
  onEdit: () => void;
  onRestore: () => void;
  onSetComment: (comment: string) => void;
}) {
  const [commentDraft, setCommentDraft] = useState(cell.comment ?? '');
  const totalProposalDelta = cell.simulationContributions.reduce((sum, contribution) => sum + contribution.delta, 0);
  const finalDelta = cell.finalValue - cell.baseValue;

  return (
    <div
      className="absolute right-0 top-full z-50 mt-1 w-80 rounded-xl border border-[var(--gray-200)] bg-white p-3 text-left shadow-xl"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">{cell.periodLabel}</div>
          <div className="text-[10px] text-[var(--gray-400)]">
            {cell.periodStartDate === cell.periodEndDate
              ? cell.periodStartDate
              : `${cell.periodStartDate} → ${cell.periodEndDate}`}
          </div>
          <div className="text-[13px] font-medium text-[var(--gray-950)]">{label}</div>
        </div>
        <button onClick={onClose} className="text-[var(--gray-400)] hover:text-[var(--gray-950)]">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="space-y-1.5 text-[12px]">
        <PopoverRow label="Valor base" value={cell.baseValue} />
        <PopoverRow label="Delta propuestas" value={totalProposalDelta} accent="sim" />
        <PopoverRow label="Valor simulado" value={cell.simulatedValue} />
        <PopoverRow label="Delta manual" value={cell.manualDelta} accent="manual" />
        <PopoverRow label="Valor final" value={cell.finalValue} accent="final" />
        <PopoverRow label="Δ vs base" value={finalDelta} accent="delta" />
      </div>

      {cell.simulationContributions.length > 0 && (
        <div className="mt-3 rounded-lg bg-[var(--gray-50)] p-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--gray-400)]">Propuestas aplicadas</p>
          <div className="mt-2 space-y-1 text-[11px]">
            {cell.simulationContributions.map((contribution) => (
              <div key={contribution.simulationId} className="flex items-center justify-between gap-3">
                <span className="text-[var(--gray-500)]">{contribution.simulationName}</span>
                <span className={contribution.delta >= 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]'}>
                  {contribution.delta > 0 ? '+' : ''}{formatCompactNumber(contribution.delta)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {cell.isEditable && editingAllowed && (
        <div className="mt-3">
          <label className="mb-1 block text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Comentario</label>
          <textarea
            value={commentDraft}
            onChange={(event) => setCommentDraft(event.target.value)}
            onBlur={() => onSetComment(commentDraft)}
            rows={2}
            className="w-full resize-none rounded-lg border border-[var(--gray-200)] px-2 py-1.5 text-[12px] outline-none focus:border-[#0071e3]"
            placeholder="Nota o explicación..."
          />
        </div>
      )}

      <div className="mt-3 flex gap-2">
        {cell.isEditable && editingAllowed && (
          <button
            onClick={onEdit}
            className="flex-1 rounded-lg bg-[var(--primary)] px-3 py-2 text-[12px] font-medium text-white"
          >
            Editar
          </button>
        )}
        {cell.isOverridden && (
          <button
            onClick={onRestore}
            className="inline-flex items-center gap-1 rounded-lg border border-[var(--gray-200)] px-3 py-2 text-[12px] text-[var(--gray-500)]"
          >
            <RotateCcw className="w-3 h-3" />
            Restaurar
          </button>
        )}
      </div>
    </div>
  );
}

function PopoverRow({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: 'sim' | 'manual' | 'final' | 'delta';
}) {
  const colorClass =
    accent === 'sim' ? 'text-[var(--primary)]' :
    accent === 'manual' ? 'text-[#ff9500]' :
    accent === 'delta' ? (value >= 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]') :
    accent === 'final' ? 'text-[var(--gray-950)] font-semibold' :
    'text-[var(--gray-950)]';

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[var(--gray-400)]">{label}</span>
      <span className={`font-mono ${colorClass}`}>{value > 0 && accent === 'delta' ? '+' : ''}{formatCompactNumber(value)}</span>
    </div>
  );
}

function MetricTotalRow({
  label,
  values,
  tone,
}: {
  label: string;
  values: number[];
  tone: 'pos' | 'neg' | 'neutral';
}) {
  const total = values.reduce((sum, value) => sum + value, 0);
  const colorClass =
    tone === 'pos' ? 'text-[var(--success)]' :
    tone === 'neg' ? 'text-[var(--danger)]' :
    'text-[var(--gray-950)]';

  return (
    <tr className="border-t border-[var(--gray-200)]">
      <td className={`sticky left-0 bg-white px-4 py-2.5 font-semibold ${colorClass}`}>{label}</td>
      {values.map((value, index) => (
        <td key={`${label}-${index}`} className={`px-3 py-2.5 text-right tabular-nums font-semibold ${colorClass}`}>
          {value === 0 ? '—' : formatCompactNumber(value)}
        </td>
      ))}
      <td className={`bg-[var(--gray-50)] px-4 py-2.5 text-right tabular-nums font-semibold ${colorClass}`}>
        {total === 0 ? '—' : formatCompactNumber(total)}
      </td>
    </tr>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${color}`} />
      {label}
    </span>
  );
}

function KpiCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'pos' | 'neg' | 'neutral' | 'cash';
}) {
  const colorClass =
    tone === 'pos' ? 'text-[var(--success)]' :
    tone === 'neg' ? 'text-[var(--danger)]' :
    tone === 'cash' ? 'text-[var(--primary)]' :
    'text-[var(--gray-950)]';

  return (
    <div className="rounded-2xl border border-[var(--gray-200)]/50 bg-white p-4 shadow-sm">
      <p className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">{label}</p>
      <p className={`mt-2 text-[22px] font-semibold ${colorClass}`}>{formatCurrency(value)}</p>
    </div>
  );
}
