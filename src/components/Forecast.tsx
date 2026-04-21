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
  ForecastConfidenceBasis,
  ForecastConfidenceOverride,
  FlowPlan,
  ForecastGranularity,
  ForecastLayerMode,
  ForecastView,
  Simulation,
  ROLE_TARGET_EXPENSE,
  ROLE_TARGET_INCOME,
  ROLE_TARGET_LABELS,
  Scenario,
  ScenarioCellOverride,
  Proposal,
  scenarioCellKey,
} from '../types';
import { evaluateScenario } from '../domain/scenarioEngine';
import { isBaseScenario } from '../domain/proposalCompiler';
import { formatCompactNumber, formatCurrency } from '../utils/calculations';
import type { CXPRecord } from '../domain/persistence';

interface Props {
  plan: FlowPlan;
  simulations: Simulation[];
  scenarios: Scenario[];
  proposals: Proposal[];
  activeSimulationId: string | null;
  activeScenarioId: string | null;
  overrides: ScenarioCellOverride[];
  confidenceOverrides?: ForecastConfidenceOverride[];
  granularity?: ForecastGranularity;
  cxpRecords?: CXPRecord[];
  cxpLoadedCias?: Record<string, string>;
  onGranularityChange?: (granularity: ForecastGranularity) => void;
  onSelectScenario: (scenarioId: string | null) => void;
  onOverridesChange: (next: ScenarioCellOverride[]) => void;
  onConfidenceOverridesChange?: (next: ForecastConfidenceOverride[]) => void;
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

function parseCxpDate(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const iso = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!slash) return null;
  const month = Number(slash[1]);
  const day = Number(slash[2]);
  const year = Number(slash[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function coefficientOfVariation(values: number[]): number {
  const positives = values.filter((value) => Math.abs(value) > 0);
  if (positives.length < 2) return 0;
  const avg = positives.reduce((sum, value) => sum + Math.abs(value), 0) / positives.length;
  if (avg === 0) return 0;
  const variance = positives.reduce((sum, value) => sum + Math.pow(Math.abs(value) - avg, 2), 0) / positives.length;
  return Math.sqrt(variance) / avg;
}

function daysSinceIso(value: string | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.floor((Date.now() - time) / (24 * 60 * 60 * 1000)));
}

function buildTaxProjection(cxpRecords: CXPRecord[], months: { ym: string }[]): number[] {
  const byYm = new Map<string, number>();
  cxpRecords.forEach((record) => {
    if (record.importeImpuestosPesos <= 0) return;
    const status = record.edoPago.toUpperCase();
    const paid = record.importePendientePesos <= 0 || status.includes('PAG') || status.includes('LIQ');
    if (paid) return;
    const date = parseCxpDate(record.fechaProgramacionPago) ?? parseCxpDate(record.fechaVence) ?? parseCxpDate(record.fechaFactura);
    if (!date) return;
    const ym = date.slice(0, 7);
    byYm.set(ym, (byYm.get(ym) ?? 0) + record.importeImpuestosPesos);
  });
  return months.map((month) => byYm.get(month.ym) ?? 0);
}

function buildCxpMonthlySeries(cxpRecords: CXPRecord[]): number[] {
  const values = Array(12).fill(0) as number[];
  cxpRecords.forEach((record) => {
    const date = parseCxpDate(record.fechaProgramacionPago) ?? parseCxpDate(record.fechaVence) ?? parseCxpDate(record.fechaFactura);
    if (!date) return;
    const monthIndex = Number(date.slice(5, 7)) - 1;
    if (monthIndex >= 0 && monthIndex < 12) values[monthIndex] += record.importePendientePesos;
  });
  return values;
}

type ForecastConfidenceLevel = 'Alto' | 'Medio' | 'Bajo';

const CONFIDENCE_BASIS_LABELS: Record<ForecastConfidenceBasis, string> = {
  system_calculation: 'Cálculo del sistema',
  manual_calculation: 'Cálculo manual',
  human_criteria: 'Criterio humano',
  mixed: 'Cálculo + criterio',
};

const EDITABLE_CONFIDENCE_BASIS: ForecastConfidenceBasis[] = [
  'manual_calculation',
  'human_criteria',
  'mixed',
];

function clampConfidenceScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function confidenceLevelFromScore(score: number): ForecastConfidenceLevel {
  return score >= 75 ? 'Alto' : score >= 50 ? 'Medio' : 'Bajo';
}

function confidenceTone(level: ForecastConfidenceLevel): string {
  if (level === 'Alto') return 'text-[var(--success)] bg-[var(--success-muted)]';
  if (level === 'Medio') return 'text-[var(--warning)] bg-[var(--warning-muted)]';
  return 'text-[var(--danger)] bg-[var(--danger-muted)]';
}

function computeForecastConfidence({
  plan,
  evaluation,
  cxpRecords,
  cxpLoadedCias,
  overrides,
  scenarioId,
}: {
  plan: FlowPlan;
  evaluation: ReturnType<typeof evaluateScenario>;
  cxpRecords: CXPRecord[];
  cxpLoadedCias: Record<string, string>;
  overrides: ScenarioCellOverride[];
  scenarioId: string;
}): { level: ForecastConfidenceLevel; score: number; reasons: string[] } {
  let score = 100;
  const reasons: string[] = [];
  const hasForecastAccuracyHistory = false;

  reasons.push('Estimacion heuristica local; no es backtesting estadistico.');

  const nonZeroMonths = plan.concepts.reduce((count, concept) => (
    count + concept.monthlyData.filter((value) => Math.abs(value) > 0).length
  ), 0);
  if (nonZeroMonths < plan.concepts.length * 4) {
    score -= 18;
    reasons.push('Hay pocos datos historicos mensuales en el plan.');
  } else {
    reasons.push('El plan tiene suficiente distribucion mensual para proyectar.');
  }

  const syncAges = Object.values(cxpLoadedCias).map(daysSinceIso).filter((value): value is number => value !== null);
  const maxSyncAge = syncAges.length > 0 ? Math.max(...syncAges) : null;
  if (maxSyncAge === null) {
    score -= 14;
    reasons.push('CXP no tiene una sincronizacion fechada; aumenta dependencia manual.');
  } else if (maxSyncAge > 30) {
    score -= 18;
    reasons.push(`CXP tiene hasta ${maxSyncAge} dias sin actualizarse.`);
  } else if (maxSyncAge > 7) {
    score -= 8;
    reasons.push(`CXP tiene ${maxSyncAge} dias desde la ultima actualizacion.`);
  }

  const collectionVariation = coefficientOfVariation(evaluation.metrics.cobranza);
  if (collectionVariation > 0.65) {
    score -= 14;
    reasons.push('La cobranza proyectada es muy variable entre periodos.');
  }

  const paymentVariation = coefficientOfVariation(buildCxpMonthlySeries(cxpRecords));
  if (paymentVariation > 0.75) {
    score -= 12;
    reasons.push('El comportamiento de pagos CXP es variable por vencimiento/monto.');
  }

  const scenarioOverrides = overrides.filter((override) => override.scenarioId === scenarioId);
  if (scenarioOverrides.length > 10) {
    score -= 10;
    reasons.push('El escenario depende de varios ajustes manuales.');
  }

  if (cxpRecords.length === 0) {
    score -= 12;
    reasons.push('No hay CXP cargadas para validar egresos e impuestos.');
  }

  if (!hasForecastAccuracyHistory) {
    score = Math.min(score - 20, 70);
    reasons.push('Sin historico de exactitud, el nivel se limita a Medio.');
  }

  const boundedScore = clampConfidenceScore(score);
  return {
    score: boundedScore,
    level: confidenceLevelFromScore(boundedScore),
    reasons: reasons.slice(0, 4),
  };
}

const VIEW_OPTIONS: { value: ForecastView; label: string }[] = [
  { value: 'pnl', label: 'P&L' },
  { value: 'cashflow', label: 'Flujo de Caja' },
  { value: 'drivers', label: 'Drivers' },
];

const STICKY_CONCEPT_WIDTH = 'w-[240px] min-w-[240px] max-w-[240px]';
const STICKY_CONCEPT_SHADOW = 'border-r border-[var(--gray-100)] shadow-[10px_0_14px_-14px_rgba(15,23,42,0.22)]';
const STICKY_CONCEPT_HEADER = `sticky left-0 z-30 ${STICKY_CONCEPT_WIDTH} bg-[var(--surface-alt)] ${STICKY_CONCEPT_SHADOW}`;
const STICKY_CONCEPT_CELL = `sticky left-0 z-10 overflow-hidden ${STICKY_CONCEPT_WIDTH} ${STICKY_CONCEPT_SHADOW}`;

export default function Forecast({
  plan,
  simulations,
  scenarios,
  proposals,
  activeSimulationId,
  activeScenarioId,
  overrides,
  confidenceOverrides = [],
  granularity = 'monthly',
  cxpRecords = [],
  cxpLoadedCias = {},
  onGranularityChange,
  onSelectScenario,
  onOverridesChange,
  onConfidenceOverridesChange,
}: Props) {
  const [view, setView] = useState<ForecastView>('pnl');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ conceptId: string; yearMonth: string } | null>(null);
  const [popover, setPopover] = useState<{ conceptId: string; yearMonth: string } | null>(null);
  const [layerMode, setLayerMode] = useState<ForecastLayerMode>('manual');

  const childrenById = useMemo(() => buildChildrenIndex(plan), [plan]);
  const baseScenario = scenarios.find((scenario) => isBaseScenario(scenario)) ?? null;
  const editableScenarios = scenarios.filter((scenario) => !isBaseScenario(scenario));
  const activeSimulation = simulations.find((simulation) => simulation.id === activeSimulationId) ?? simulations[0] ?? null;
  const activeScenario = scenarios.find((scenario) => scenario.id === activeScenarioId)
    ?? scenarios.find((scenario) => scenario.simulationId === activeSimulation?.id)
    ?? baseScenario
    ?? null;
  const effectiveSimulation = activeSimulation ?? {
    id: 'simulation-base',
    name: BASE_SCENARIO_NAME,
    description: 'Pronóstico original',
    status: 'Pendiente' as const,
    createdAt: '',
    updatedAt: '',
  };
  const editingAllowed = !isBaseScenario(activeScenario) && granularity === 'monthly';

  const baseEvaluation = useMemo(() => {
    if (layerMode !== 'base' && layerMode !== 'diff') return null;
    if (!activeScenario) return null;
    return evaluateScenario(plan, effectiveSimulation, activeScenario, [], [], { granularity });
  }, [activeScenario, effectiveSimulation, granularity, layerMode, plan]);

  const simulatedEvaluation = useMemo(() => {
    if (layerMode !== 'simulated') return null;
    if (!activeScenario) return null;
    return evaluateScenario(
      plan,
      effectiveSimulation,
      activeScenario,
      isBaseScenario(activeScenario) ? [] : proposals,
      [],
      { granularity },
    );
  }, [activeScenario, effectiveSimulation, granularity, layerMode, plan, proposals]);

  const finalEvaluation = useMemo(() => {
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
  }, [activeScenarioId, activeSimulationId, granularity, layerMode, view]);

  const viewTitle = view === 'pnl' ? 'Estado de Resultados' : view === 'cashflow' ? 'Flujo de Caja' : 'Drivers';
  const taxProjection = useMemo(
    () => buildTaxProjection(cxpRecords, months),
    [cxpRecords, months],
  );
  const confidence = useMemo(() => {
    if (!activeScenario || !finalEvaluation) return null;
    return computeForecastConfidence({
      plan,
      evaluation: finalEvaluation,
      cxpRecords,
      cxpLoadedCias,
      overrides,
      scenarioId: activeScenario.id,
    });
  }, [activeScenario, cxpLoadedCias, cxpRecords, finalEvaluation, overrides, plan]);
  const confidenceOverride = useMemo(
    () => activeScenario
      ? confidenceOverrides.find((override) => override.scenarioId === activeScenario.id) ?? null
      : null,
    [activeScenario, confidenceOverrides],
  );
  const effectiveConfidence = useMemo(() => {
    if (!confidence) return null;
    const score = confidenceOverride
      ? clampConfidenceScore(confidenceOverride.score)
      : confidence.score;
    return {
      ...confidence,
      score,
      level: confidenceLevelFromScore(score),
      basis: confidenceOverride?.basis ?? 'system_calculation',
      comment: confidenceOverride?.comment,
      isManual: Boolean(confidenceOverride),
    };
  }, [confidence, confidenceOverride]);

  if (!activeScenario || !finalEvaluation) {
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
    layerMode === 'base' && baseEvaluation
      ? baseEvaluation.metrics
      : layerMode === 'simulated' && simulatedEvaluation
        ? simulatedEvaluation.metrics
        : layerMode === 'diff' && baseEvaluation
          ? {
              ingresos: finalEvaluation.metrics.ingresos.map((value, index) => value - (baseEvaluation.metrics.ingresos[index] ?? 0)),
              egresos: finalEvaluation.metrics.egresos.map((value, index) => value - (baseEvaluation.metrics.egresos[index] ?? 0)),
              flujoNeto: finalEvaluation.metrics.flujoNeto.map((value, index) => value - (baseEvaluation.metrics.flujoNeto[index] ?? 0)),
              cajaFinal: finalEvaluation.metrics.cajaFinal.map((value, index) => value - (baseEvaluation.metrics.cajaFinal[index] ?? 0)),
              cobranza: finalEvaluation.metrics.cobranza.map((value, index) => value - (baseEvaluation.metrics.cobranza[index] ?? 0)),
              pagosProveedores: finalEvaluation.metrics.pagosProveedores.map((value, index) => value - (baseEvaluation.metrics.pagosProveedores[index] ?? 0)),
              saldosFinales: finalEvaluation.metrics.saldosFinales.map((value, index) => value - (baseEvaluation.metrics.saldosFinales[index] ?? 0)),
            }
          : finalEvaluation.metrics;

  const directOverrides = overrides.filter((override) => override.scenarioId === activeScenario.id);
  const directOverrideCount = directOverrides.length;
  const commentCount = directOverrides.filter((override) => override.comment).length;
  const totalProjectedTaxes = taxProjection.reduce((sum, value) => sum + value, 0);
  const flowAfterTaxes = metrics.flujoNeto.map((value, index) => value - (taxProjection[index] ?? 0));
  let cumulativeTax = 0;
  const cashAfterTaxes = metrics.cajaFinal.map((value, index) => {
    cumulativeTax += taxProjection[index] ?? 0;
    return value - cumulativeTax;
  });

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

  const updateConfidenceOverride = (patch: Partial<ForecastConfidenceOverride>) => {
    if (!confidence || !onConfidenceOverridesChange) return;
    const nextScore = clampConfidenceScore(patch.score ?? confidenceOverride?.score ?? confidence.score);
    const nextBasis = patch.basis ?? (
      confidenceOverride?.basis && confidenceOverride.basis !== 'system_calculation'
        ? confidenceOverride.basis
        : 'mixed'
    );
    const nextComment = patch.comment !== undefined
      ? patch.comment
      : confidenceOverride?.comment;
    const nextOverride: ForecastConfidenceOverride = {
      scenarioId: activeScenario.id,
      score: nextScore,
      basis: nextBasis,
      comment: nextComment && nextComment.trim().length > 0 ? nextComment : undefined,
      editedAt: new Date().toISOString(),
    };

    onConfidenceOverridesChange([
      ...confidenceOverrides.filter((override) => override.scenarioId !== activeScenario.id),
      nextOverride,
    ]);
  };

  const restoreConfidenceCalculation = () => {
    if (!onConfidenceOverridesChange) return;
    onConfidenceOverridesChange(
      confidenceOverrides.filter((override) => override.scenarioId !== activeScenario.id),
    );
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
          <div className="flex items-center gap-2">
            {effectiveConfidence && (
              <div
                className={`rounded-full px-3 py-2 text-[12px] font-medium ${confidenceTone(effectiveConfidence.level)}`}
                title={`${CONFIDENCE_BASIS_LABELS[effectiveConfidence.basis]}. Base calculada: ${confidence?.score ?? 0}%.`}
              >
                Confianza {effectiveConfidence.level} · {effectiveConfidence.score}%
                <span className="ml-1 opacity-75">
                  {effectiveConfidence.isManual ? 'Manual' : 'Auto'}
                </span>
              </div>
            )}
            {directOverrideCount > 0 && (
              <button
                onClick={handleClearScenarioOverrides}
                className="inline-flex items-center gap-2 rounded-full border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2 text-[12px] font-medium text-[var(--warning)]"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Restaurar {directOverrideCount}
              </button>
            )}
          </div>
        </div>
        <p className="mt-2 text-[13px] text-[var(--gray-400)]">
          Pronóstico unificado por escenario y ajustes activos. Doble clic en celdas hoja para editar manualmente.
        </p>

        <div className="mt-5 grid grid-cols-[200px,minmax(0,1fr),auto] gap-4">
          <button
            onClick={() => onSelectScenario(BASE_SCENARIO_ID)}
            className={`rounded-xl border px-3 py-2 text-[13px] font-medium transition ${
              isBaseScenario(activeScenario)
                ? 'border-[var(--card-foreground)] bg-[var(--card-foreground)] text-white'
                : 'border-[var(--gray-200)] bg-[var(--surface-alt)] text-[var(--gray-950)]'
            }`}
          >
            {BASE_SCENARIO_NAME}
          </button>
          <select
            value={activeScenario.id}
            onChange={(event) => onSelectScenario(event.target.value)}
            className="rounded-xl border border-[var(--gray-200)] bg-[var(--surface-alt)] px-3 py-2 text-[13px]"
          >
            {baseScenario && (
              <option value={baseScenario.id}>{baseScenario.name}</option>
            )}
            {editableScenarios.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>{scenario.name}</option>
            ))}
          </select>
          <div className="flex items-center gap-2 justify-end">
            <div className="flex items-center rounded-xl bg-[var(--gray-50)] p-1">
              {(['monthly', 'weekly', 'daily'] as ForecastGranularity[]).map((g) => (
                <button
                  key={g}
                  onClick={() => onGranularityChange?.(g)}
                  className={`rounded-lg px-3 py-1.5 text-[12px] font-medium transition ${
                    granularity === g
                      ? 'bg-white text-[var(--gray-950)] shadow-sm'
                      : 'text-[var(--gray-500)]'
                  }`}
                >
                  {g === 'monthly' ? 'Mes' : g === 'weekly' ? 'Semana' : 'Día'}
                </button>
              ))}
            </div>
            <div className="flex items-center rounded-xl bg-[var(--gray-50)] p-1">
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
        </div>

        {confidence && effectiveConfidence && (
          <div className="mt-4 rounded-xl border border-[var(--gray-100)] bg-[var(--surface-alt)] p-3">
            <div className="grid grid-cols-[minmax(0,1fr),120px,180px,auto] items-end gap-3">
              <div className="min-w-0">
                <p className="text-[12px] font-semibold uppercase tracking-wide text-[var(--gray-400)]">Confianza</p>
                <p className="mt-1 truncate text-[13px] text-[var(--gray-600)]">
                  Automático: {confidence.score}% · {confidence.level}
                </p>
              </div>
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium text-[var(--gray-400)]">Porcentaje</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={effectiveConfidence.score}
                  disabled={!onConfidenceOverridesChange}
                  onChange={(event) => updateConfidenceOverride({ score: Number(event.target.value) })}
                  className="h-10 w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 text-right text-[13px] font-semibold text-[var(--gray-950)] disabled:opacity-60"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium text-[var(--gray-400)]">Base</span>
                <select
                  value={confidenceOverride?.basis && confidenceOverride.basis !== 'system_calculation'
                    ? confidenceOverride.basis
                    : 'mixed'}
                  disabled={!onConfidenceOverridesChange}
                  onChange={(event) => updateConfidenceOverride({ basis: event.target.value as ForecastConfidenceBasis })}
                  className="h-10 w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[13px] text-[var(--gray-950)] disabled:opacity-60"
                >
                  {EDITABLE_CONFIDENCE_BASIS.map((basis) => (
                    <option key={basis} value={basis}>{CONFIDENCE_BASIS_LABELS[basis]}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={!confidenceOverride || !onConfidenceOverridesChange}
                onClick={restoreConfidenceCalculation}
                className="h-10 rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[12px] font-medium text-[var(--gray-500)] transition enabled:hover:text-[var(--gray-950)] disabled:opacity-45"
              >
                Usar cálculo
              </button>
            </div>
            <textarea
              value={effectiveConfidence.comment ?? ''}
              disabled={!onConfidenceOverridesChange}
              onChange={(event) => updateConfidenceOverride({ comment: event.target.value })}
              placeholder="Motivo del porcentaje de confianza"
              rows={2}
              className="mt-3 w-full resize-none rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2 text-[13px] text-[var(--gray-950)] placeholder:text-[var(--gray-300)] disabled:opacity-60"
            />
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-4 text-[12px] text-[var(--gray-400)]">
          <LegendDot color="bg-[var(--gray-200)]" label="Base" />
          <LegendDot color="bg-[var(--primary)]" label="Impactada por ajuste" />
          <LegendDot color="bg-[var(--warning)]" label={`Ajuste manual${directOverrideCount > 0 ? ` (${directOverrideCount})` : ''}`} />
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
        <div className="mt-3 flex flex-wrap gap-2">
          {(confidenceOverride
            ? [`Editado: ${CONFIDENCE_BASIS_LABELS[confidenceOverride.basis]}`, ...(confidence?.reasons ?? [])]
            : confidence?.reasons ?? []
          ).map((reason) => (
            <span key={reason} className="rounded-full bg-[var(--gray-50)] px-2.5 py-1 text-[11px] text-[var(--gray-500)]">
              {reason}
            </span>
          ))}
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

      {totalProjectedTaxes > 0 && (
        <div className="rounded-2xl border border-[var(--warning)]/20 bg-[var(--warning-muted)]/45 p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[12px] font-semibold uppercase tracking-wide text-[var(--warning)]">Impuestos integrados desde CXP</p>
              <p className="mt-1 text-[13px] text-[var(--gray-500)]">
                Se agregan como salida fiscal pendiente para leer el flujo despues de impuestos.
              </p>
            </div>
            <div className="text-right">
              <p className="text-[22px] font-semibold text-[var(--danger)]">{formatCurrency(-totalProjectedTaxes)}</p>
              <p className="text-[11px] text-[var(--gray-500)]">Efecto acumulado en efectivo</p>
            </div>
          </div>
        </div>
      )}

      <section className="rounded-2xl border border-[var(--gray-200)]/50 bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-[13px]">
            <thead className="border-b border-[var(--gray-100)] bg-[var(--surface-alt)]">
              <tr>
                <th className={`${STICKY_CONCEPT_HEADER} px-4 py-2.5 text-left font-medium text-[var(--gray-400)]`}>Concepto</th>
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
                  {view === 'cashflow' && totalProjectedTaxes > 0 && (
                    <>
                      <MetricTotalRow
                        label="Impuestos programados CXP"
                        values={taxProjection.map((value) => -value)}
                        tone="neg"
                      />
                      <MetricTotalRow
                        label="Flujo despues de impuestos"
                        values={flowAfterTaxes}
                        tone="neutral"
                      />
                    </>
                  )}
                </>
              )}
            </tbody>
            {view === 'cashflow' && (
              <tfoot className="border-t-2 border-[var(--card-foreground)]/10 bg-[var(--surface-alt)]">
                <tr>
                  <td className={`${STICKY_CONCEPT_CELL} bg-[var(--surface-alt)] px-4 py-2.5 font-semibold text-[var(--gray-950)]`}>Caja inicial</td>
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
                  <td className={`${STICKY_CONCEPT_CELL} bg-[var(--surface-alt)] px-4 py-2.5 font-semibold text-[var(--gray-950)]`}>Caja al cierre</td>
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
                {totalProjectedTaxes > 0 && (
                  <tr>
                    <td className={`${STICKY_CONCEPT_CELL} bg-[var(--surface-alt)] px-4 py-2.5 font-semibold text-[var(--warning)]`}>Caja cierre despues de impuestos</td>
                    {cashAfterTaxes.map((value, index) => (
                      <td key={`${months[index]?.ym ?? index}-cash-tax`} className={`px-3 py-2.5 text-right tabular-nums font-semibold ${value < 0 ? 'text-[var(--danger)]' : 'text-[var(--warning)]'}`}>
                        {formatCompactNumber(value)}
                      </td>
                    ))}
                    <td className={`bg-[var(--gray-50)] px-4 py-2.5 text-right tabular-nums font-semibold ${(cashAfterTaxes[cashAfterTaxes.length - 1] ?? 0) < 0 ? 'text-[var(--danger)]' : 'text-[var(--warning)]'}`}>
                      {formatCompactNumber(cashAfterTaxes[cashAfterTaxes.length - 1] ?? 0)}
                    </td>
                  </tr>
                )}
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
    <tr className="border-t border-[var(--gray-200)] bg-[var(--surface-alt)]">
      <td className={`${STICKY_CONCEPT_CELL} bg-[var(--surface-alt)] px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--gray-400)]`}>
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
    <tr className="border-t border-[var(--gray-200)]/30 bg-[var(--gray-50)]">
      <td className={`${STICKY_CONCEPT_CELL} bg-[var(--gray-50)] px-4 py-2 text-[var(--gray-950)]`}>{label}</td>
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
        <td className={`${STICKY_CONCEPT_CELL} bg-white px-4 py-2`} style={{ paddingLeft: 16 + depth * 16 }}>
          <div className="flex min-w-0 items-center gap-1.5">
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
            <span className="truncate text-[var(--gray-950)]" title={concept.name}>{concept.name}</span>
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
    ? 'bg-[var(--warning)]/10 text-[var(--warning)]'
    : cell.hasProposalDelta
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
          className="w-full rounded border border-[var(--primary)] bg-white px-1 py-0.5 text-right outline-none"
        />
      ) : (
        <>
          <span className="inline-flex items-center justify-end gap-1">
            {(cell.hasManualDelta || cell.hasProposalDelta) && (
              <span className={`h-1.5 w-1.5 rounded-full ${cell.hasManualDelta ? 'bg-[var(--warning)]' : 'bg-[var(--primary)]'}`} />
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
  const totalSimulationDelta = cell.proposalContributions.reduce((sum, contribution) => sum + contribution.delta, 0);
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
        <PopoverRow label="Delta propuestas" value={totalSimulationDelta} accent="sim" />
        <PopoverRow label="Valor simulado" value={cell.simulatedValue} />
        <PopoverRow label="Delta manual" value={cell.manualDelta} accent="manual" />
        <PopoverRow label="Valor final" value={cell.finalValue} accent="final" />
        <PopoverRow label="Δ vs base" value={finalDelta} accent="delta" />
      </div>

      {cell.proposalContributions.length > 0 && (
        <div className="mt-3 rounded-lg bg-[var(--gray-50)] p-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--gray-400)]">Propuestas aplicadas</p>
          <div className="mt-2 space-y-1 text-[11px]">
            {cell.proposalContributions.map((contribution) => (
              <div key={contribution.proposalId} className="flex items-center justify-between gap-3">
                <span className="text-[var(--gray-500)]">{contribution.proposalName}</span>
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
            className="w-full resize-none rounded-lg border border-[var(--gray-200)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--primary)]"
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
    accent === 'manual' ? 'text-[var(--warning)]' :
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
      <td className={`${STICKY_CONCEPT_CELL} bg-white px-4 py-2.5 font-semibold ${colorClass}`}>{label}</td>
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
