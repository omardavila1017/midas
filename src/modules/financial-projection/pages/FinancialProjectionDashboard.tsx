import { useCallback, useDeferredValue, useEffect, useMemo, useState, useTransition } from 'react';
import {
  AlertTriangle,
  Banknote,
  GitCompare,
  ShieldAlert,
  Wallet,
  AlertTriangle as AlertIcon,
} from 'lucide-react';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import { fmtCompact, fmtCurrency, fmtDate } from '../../../formatters';
import {
  applyAdjustmentsToMovements,
  applyCellOverridesToBuckets,
  buildBucketDates,
  calculateBaseProjection,
  summarizeBucketsForScenario,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type {
  CellOverride,
  FinancialAdjustment,
  FinancialMovement,
  FinancialScenario,
  ForecastRun,
  ManualPlanningEntry,
  PlanningCustomRow,
  PlanningRow,
  ProjectionAlert,
  ProjectionGranularity,
} from '../../shared-finance/types';

type ScenarioRun = ForecastRun & {
  rows: PlanningRow[];
  overrides: CellOverride[];
};
import { CashFlowChart } from '../components/CashFlowChart';
import { MovementDrillDownDrawer } from '../components/MovementDrillDownDrawer';
import { ScenarioReadOnlyTabs } from '../components/ScenarioReadOnlyTabs';
import { ComparisonControl } from '../components/ComparisonControl';
import { CollapsibleSection } from '../components/CollapsibleSection';
import { BucketDetailTable } from '../components/BucketDetailTable';
import { AlertsPanel } from '../components/AlertsPanel';
import { MovementsTable } from '../components/MovementsTable';
import { DeferredMount } from '../components/DeferredMount';
import { ChartSkeleton, TableSkeleton } from '../components/SectionSkeletons';
import { cachedRun, fingerprintArray } from '../services/projectionCache';
import {
  buildFinancialProjectionSourceData,
  calculateInitialCash,
  tryGetCachedFinancialProjectionSourceData,
  type FinancialProjectionSourceData,
} from '../services/financialProjectionService';
import {
  loadManualPlanningEntries,
  expandManualPlanningEntriesToMovements,
} from '../../financial-planning/services/manualPlanningEntries';
import {
  loadPlanningAdjustments,
  loadPlanningScenarios,
} from '../../financial-planning/services/financialPlanningStorage';
import { loadCellOverrides } from '../../financial-planning/services/cellOverridesStorage';
import { loadCustomRows } from '../../financial-planning/services/customRowsStorage';
import { buildPlanningRows, conceptKeyForMovement } from '../../financial-planning/services/planningRowTaxonomy';
import {
  buildSupplierCriticalAlerts,
  type SupplierCriticalAlert,
} from '../services/supplierCriticalAlerts';
import {
  buildApprovedTaxPaymentMovements,
  buildTaxDashboardView,
  defaultTaxStore,
  loadTaxStore,
} from '../../taxes/services/taxModuleService';
import KpiCard from '../../../components/ui/KpiCard';
import PageHeader from '../../../components/ui/PageHeader';

interface Props {
  companyCode: string;
  bankStatements: BankAccountStatement[];
  clients: Client[];
  providers: Provider[];
  cxpRecords: CXPRecord[];
  assumptions: CashFlowAssumptions;
  budget: Budget | null;
  startingBalance: number;
  onNavigateToTax?: () => void;
}

const GRANULARITY_OPTIONS: Array<{ id: ProjectionGranularity; label: string }> = [
  { id: 'monthly', label: 'Mes' },
  { id: 'weekly', label: 'Sem' },
  { id: 'daily', label: 'Día' },
];

/**
 * Proyección Financiera — visualización read-only de escenarios.
 *
 * - Default activo: Aprobado (main branch).
 * - Selector: Base + Aprobado + drafts activos.
 * - Pipeline: movements ∪ manual ∪ tax → adjustments → projection → cell overrides
 *   (sincroniza con Planeación).
 * - Layout: secciones colapsables persistidas en sessionStorage.
 * - Toda mutación se canaliza a Planeación.
 *
 * Mount strategy:
 *   The canonical projection (`buildFinancialProjectionSourceData` →
 *   `computeBaseCashFlow`) is the single most expensive thing this page
 *   does — it iterates clients × months × CXP × budget. We outer-gate the
 *   inner dashboard so the chrome (header, KPI placeholders, section
 *   shells) paints in one frame and the heavy compute lands on the next
 *   idle slot. Cache hits short-circuit the gating completely.
 */
export default function FinancialProjectionDashboard(props: Props) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const cacheProbeInput = useMemo(
    () => ({ ...props, asOfDate: today }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      props.companyCode,
      props.bankStatements,
      props.clients,
      props.providers,
      props.cxpRecords,
      props.assumptions,
      props.budget,
      props.startingBalance,
      today,
    ],
  );

  // Cheap cache hit on first render → no warm-up frame, full UI synchronously.
  const cachedSource = useMemo(
    () => tryGetCachedFinancialProjectionSourceData(cacheProbeInput),
    [cacheProbeInput],
  );

  const [source, setSource] = useState<FinancialProjectionSourceData | null>(cachedSource);

  // If we don't have the source cached, schedule the canonical build for
  // *after* the first paint so the user sees the chrome immediately.
  useEffect(() => {
    if (cachedSource) {
      setSource(cachedSource);
      return;
    }
    let cancelled = false;
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    });
    const run = () => {
      if (cancelled) return;
      const built = buildFinancialProjectionSourceData(cacheProbeInput);
      if (!cancelled) setSource(built);
    };
    if (typeof ric.requestIdleCallback === 'function') {
      const id = ric.requestIdleCallback(run, { timeout: 200 });
      return () => {
        cancelled = true;
        if (typeof ric.cancelIdleCallback === 'function') ric.cancelIdleCallback(id);
      };
    }
    const id = window.setTimeout(run, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [cachedSource, cacheProbeInput]);

  if (!source) {
    return <ProjectionWarmupShell />;
  }

  return <ProjectionDashboardInner {...props} today={today} source={source} />;
}

/**
 * Lightweight skeleton shown for the first paint when the canonical
 * projection still needs to build. Mirrors the eventual layout (header,
 * scenario tabs, KPI grid, chart card) so there's no shift.
 */
function ProjectionWarmupShell() {
  return (
    <div className="space-y-4 animate-page-in" aria-busy="true" aria-label="Calculando proyección">
      <div className="flex items-center justify-between">
        <div>
          <div className="skeleton h-4 w-44 rounded opacity-60" />
          <div className="skeleton mt-2 h-3 w-64 rounded opacity-50" />
        </div>
        <div className="skeleton h-10 w-48 rounded-xl opacity-50" />
      </div>
      <div className="rounded-2xl border border-[var(--gray-200)] bg-white px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div className="skeleton h-3 w-20 rounded opacity-50" />
          <div className="skeleton h-9 w-32 rounded-xl opacity-50" />
          <div className="skeleton h-9 w-32 rounded-xl opacity-50" />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, idx) => (
          <div key={idx} className="rounded-xl border border-[var(--gray-200)] bg-white p-4">
            <div className="skeleton h-3 w-1/2 rounded opacity-50" />
            <div className="skeleton mt-3 h-5 w-3/4 rounded opacity-60" />
            <div className="skeleton mt-2 h-3 w-2/3 rounded opacity-40" />
          </div>
        ))}
      </div>
      <div className="rounded-2xl border border-[var(--gray-200)] bg-white p-4">
        <div className="skeleton h-3 w-40 rounded opacity-50" />
        <div className="skeleton mt-3 h-[280px] w-full rounded-xl opacity-50" />
      </div>
    </div>
  );
}

/**
 * The actual dashboard logic. Receives the resolved `source` so the body
 * never needs to deal with the warming-up state.
 */
function ProjectionDashboardInner(props: Props & { today: string; source: FinancialProjectionSourceData }) {
  const { today, source } = props;
  const currentYear = useMemo(() => Number(today.slice(0, 4)), [today]);
  const yearStart = `${currentYear}-01-01`;
  const yearEnd = `${currentYear}-12-31`;

  const [storedScenarios] = useState<FinancialScenario[]>(() => loadPlanningScenarios([]));
  const [storedAdjustments] = useState<FinancialAdjustment[]>(() => loadPlanningAdjustments([]));
  const [manualEntries] = useState<ManualPlanningEntry[]>(() => loadManualPlanningEntries([]));
  const [cellOverrides] = useState<CellOverride[]>(() => loadCellOverrides([]));
  const [customRows] = useState<PlanningCustomRow[]>(() => loadCustomRows([]));
  const [taxStore] = useState(() => loadTaxStore(defaultTaxStore()));

  const sourceBaseScenario = source.scenarios.find((scenario) => scenario.kind === 'BASE') ?? source.scenarios[0];
  const baseScenario = storedScenarios.find((scenario) => scenario.kind === 'BASE' && !scenario.archivedAt) ?? sourceBaseScenario;
  const approvedScenario = storedScenarios.find((scenario) => scenario.kind === 'APPROVED' && !scenario.archivedAt)
    ?? source.scenarios.find((scenario) => scenario.kind === 'APPROVED')
    ?? baseScenario;
  const drafts = useMemo(
    () => storedScenarios.filter((scenario) => scenario.kind === 'DRAFT' && !scenario.archivedAt),
    [storedScenarios],
  );
  const scenarios = useMemo(
    () => [baseScenario, approvedScenario, ...drafts],
    [baseScenario, approvedScenario, drafts],
  );

  const [activeScenarioId, setActiveScenarioId] = useState<string>(approvedScenario.id);
  const [comparisonScenarioId, setComparisonScenarioId] = useState<string | null>(null);
  const [granularity, setGranularityState] = useState<ProjectionGranularity>('monthly');
  const [drillMovement, setDrillMovement] = useState<FinancialMovement | null>(null);
  const [drillAnchor, setDrillAnchor] = useState<DOMRect | null>(null);

  // Granularity flips run inside a transition so React keeps the previous
  // chart/tables on screen while the new data warms up — no stutter, no
  // empty frames. `useDeferredValue` is still useful for the segmented
  // control's pending hint (the displayed value lags slightly so the
  // pending state has something to show against).
  const [granularityPending, startGranularityTransition] = useTransition();
  const deferredGranularity = useDeferredValue(granularity);
  const setGranularity = useCallback((next: ProjectionGranularity) => {
    if (next === granularity) return;
    startGranularityTransition(() => setGranularityState(next));
  }, [granularity]);

  useEffect(() => {
    if (!scenarios.some((s) => s.id === activeScenarioId)) {
      setActiveScenarioId(approvedScenario.id);
    }
  }, [scenarios, activeScenarioId, approvedScenario.id]);

  useEffect(() => {
    if (comparisonScenarioId === activeScenarioId) setComparisonScenarioId(null);
  }, [comparisonScenarioId, activeScenarioId]);

  const initialCash = useMemo(
    () => calculateInitialCash(props.bankStatements, props.startingBalance),
    [props.bankStatements, props.startingBalance],
  );
  const minimumCash = useMemo(() => minimumCashFor(props), [props.budget]);

  // Pre-index storage by scenario for O(1) per-scenario lookups.
  const customRowsByScenario = useMemo(() => {
    const map = new Map<string, PlanningCustomRow[]>();
    for (const row of customRows) {
      const list = map.get(row.scenarioId);
      if (list) list.push(row);
      else map.set(row.scenarioId, [row]);
    }
    return map;
  }, [customRows]);

  const cellOverridesByScenario = useMemo(() => {
    const map = new Map<string, CellOverride[]>();
    for (const override of cellOverrides) {
      const list = map.get(override.scenarioId);
      if (list) list.push(override);
      else map.set(override.scenarioId, [override]);
    }
    return map;
  }, [cellOverrides]);

  const scenarioNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const scenario of scenarios) map.set(scenario.id, scenario.name);
    return map;
  }, [scenarios]);

  // Stable fingerprint for the inputs that *every* run shares (movements,
  // adjustments, manual entries, tax obligations). Computing this once lets
  // us key the per-scenario LRU cache without re-hashing on every render.
  const sharedInputsKey = useMemo(() => {
    const movementsKey = fingerprintArray(source.movements, (m) => m.id + ':' + (m.adjustedAmount ?? m.projectedAmount));
    const adjustmentsKey = fingerprintArray(storedAdjustments, (a) => a.id + ':' + a.status + ':' + a.createdAt);
    const manualKey = fingerprintArray(manualEntries, (m) => m.id + ':' + (m.updatedAt ?? m.createdAt ?? ''));
    const taxKey = fingerprintArray(taxStore.obligations, (o) => o.id + ':' + o.pendingAmount + ':' + o.status);
    return [
      movementsKey,
      adjustmentsKey,
      manualKey,
      taxKey,
      yearStart,
      yearEnd,
      today,
      initialCash,
      minimumCash,
    ].join('|');
  }, [
    source.movements,
    storedAdjustments,
    manualEntries,
    taxStore.obligations,
    yearStart,
    yearEnd,
    today,
    initialCash,
    minimumCash,
  ]);

  // Build a single scenario run, hitting the LRU first. Custom rows /
  // overrides are scenario-scoped so they fold into the cache key.
  const buildRun = useMemo(() => {
    return (scenarioId: string, gran: ProjectionGranularity): ScenarioRun => {
      const scenarioName = scenarioNameById.get(scenarioId) ?? scenarioId;
      const scenarioCustomRows = customRowsByScenario.get(scenarioId) ?? [];
      const scenarioOverrides = cellOverridesByScenario.get(scenarioId) ?? [];
      const customKey = fingerprintArray(scenarioCustomRows, (r) => r.id + ':' + (r.updatedAt ?? ''));
      const overrideKey = fingerprintArray(scenarioOverrides, (o) => o.conceptKey + '@' + o.bucketKey + ':' + o.value);
      const cacheKey = [
        sharedInputsKey,
        scenarioId,
        gran,
        customKey,
        overrideKey,
      ].join('||');

      return cachedRun<ScenarioRun>(cacheKey, () => {
        const taxMovements = buildApprovedTaxPaymentMovements({
          obligations: taxStore.obligations,
          scenarioId,
          startDate: yearStart,
          endDate: yearEnd,
          asOfDate: today,
        });
        const manualMovements = expandManualPlanningEntriesToMovements(manualEntries, {
          scenarioId,
          startDate: yearStart,
          endDate: yearEnd,
          asOfDate: today,
        });
        const adjustedMovements = applyAdjustmentsToMovements(
          [...source.movements, ...manualMovements, ...taxMovements],
          storedAdjustments,
          scenarioId,
        );
        const rawProjection = calculateBaseProjection(adjustedMovements, {
          startDate: yearStart,
          endDate: yearEnd,
          initialCash,
          minimumCash,
          granularity: gran,
          scenarioId,
          name: scenarioName,
        });
        const rows = buildPlanningRows({
          movements: rawProjection.movements,
          customRows: scenarioCustomRows,
          overrides: scenarioOverrides,
        });
        const buckets = applyCellOverridesToBuckets({
          buckets: rawProjection.buckets,
          overrides: scenarioOverrides,
          movements: rawProjection.movements,
          rows,
          granularity: gran,
          conceptKeyForMovement,
          asOfDate: today,
          initialCash,
        });
        return {
          ...rawProjection,
          buckets,
          summary: summarizeBucketsForScenario(buckets, rawProjection.movements, minimumCash),
          rows,
          overrides: scenarioOverrides,
        };
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sharedInputsKey,
    scenarioNameById,
    customRowsByScenario,
    cellOverridesByScenario,
    source.movements,
    storedAdjustments,
    manualEntries,
    taxStore.obligations,
    yearStart,
    yearEnd,
    today,
    initialCash,
    minimumCash,
  ]);

  // Eager runs — only the ones the visible UI actually needs to paint:
  // base (for the comparison line + tab labels), the active scenario, and
  // the comparison scenario when one is selected. Drafts get evaluated
  // lazily by `finalCashFor` so the tab strip can render without paying
  // the full pipeline up front for every draft.
  const baseRun = useMemo(
    () => buildRun(baseScenario.id, deferredGranularity),
    [buildRun, baseScenario.id, deferredGranularity],
  );
  const activeRun = useMemo(
    () => (activeScenarioId === baseScenario.id ? baseRun : buildRun(activeScenarioId, deferredGranularity)),
    [buildRun, activeScenarioId, baseScenario.id, baseRun, deferredGranularity],
  );
  const comparisonRun = useMemo(() => {
    if (!comparisonScenarioId) return null;
    if (comparisonScenarioId === baseScenario.id) return baseRun;
    if (comparisonScenarioId === activeScenarioId) return activeRun;
    return buildRun(comparisonScenarioId, deferredGranularity);
  }, [buildRun, comparisonScenarioId, baseScenario.id, baseRun, activeScenarioId, activeRun, deferredGranularity]);

  // Bucket columns for chart range info — uses the deferred granularity so
  // it stays consistent with the currently rendered runs.
  const bucketDates = useMemo(
    () => buildBucketDates(yearStart, yearEnd, deferredGranularity),
    [yearStart, yearEnd, deferredGranularity],
  );

  // Pre-warm the *other* two granularities for the active scenario in idle
  // time. Once the initial paint settles, we silently build the alternate
  // weekly/daily runs and stash them in the LRU. Result: when the user
  // actually flips the segmented control, it's a sub-millisecond cache hit
  // instead of a 50–150ms compute. Cancellation prevents wasted work if
  // the user changes scenario mid-warm.
  useEffect(() => {
    const others: ProjectionGranularity[] = ['monthly', 'weekly', 'daily']
      .filter((g): g is ProjectionGranularity => g !== deferredGranularity);
    let cancelled = false;
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    });
    const handles: Array<number | ReturnType<typeof setTimeout>> = [];
    others.forEach((gran, i) => {
      const run = () => {
        if (cancelled) return;
        try { buildRun(activeScenarioId, gran); } catch { /* swallow — pre-warm is best-effort */ }
      };
      if (typeof ric.requestIdleCallback === 'function') {
        handles.push(ric.requestIdleCallback(run, { timeout: 800 + i * 400 }));
      } else {
        handles.push(setTimeout(run, 200 + i * 200));
      }
    });
    return () => {
      cancelled = true;
      handles.forEach((h) => {
        if (typeof h === 'number' && typeof ric.cancelIdleCallback === 'function') {
          ric.cancelIdleCallback(h);
        } else if (typeof h !== 'number') {
          clearTimeout(h);
        }
      });
    };
  }, [buildRun, activeScenarioId, deferredGranularity]);

  // KPIs.
  const summary = activeRun.summary;
  const comparisonReference = comparisonRun ? comparisonRun.summary.finalCash : baseRun.summary.finalCash;
  const finalCashDelta = summary.finalCash - comparisonReference;
  const comparisonLabel = comparisonRun ? comparisonRun.name : baseRun.name;

  // Tab strip needs final-cash deltas for *every* draft. We resolve those
  // lazily through the same cache so unselected drafts only build when the
  // tab strip actually paints them, and each lookup is O(1) afterwards.
  const finalCashFor = useMemo(
    () => (scenarioId: string): number => {
      if (scenarioId === baseScenario.id) return baseRun.summary.finalCash;
      if (scenarioId === activeScenarioId) return activeRun.summary.finalCash;
      if (comparisonRun && scenarioId === comparisonRun.scenarioId) return comparisonRun.summary.finalCash;
      try {
        return buildRun(scenarioId, deferredGranularity).summary.finalCash;
      } catch {
        return 0;
      }
    },
    [buildRun, baseScenario.id, baseRun, activeScenarioId, activeRun, comparisonRun, deferredGranularity],
  );

  // Auxiliary computations.
  const taxView = useMemo(
    () => buildTaxDashboardView({
      projection: activeRun,
      store: taxStore,
      providers: props.providers,
      cxpRecords: props.cxpRecords,
      today,
    }),
    [activeRun, props.cxpRecords, props.providers, taxStore, today],
  );
  const supplierAlerts = useMemo(
    () => buildSupplierCriticalAlerts({
      providers: props.providers,
      cxpRecords: props.cxpRecords,
      movements: activeRun.movements,
      manualEntries,
      bankStatements: props.bankStatements,
      scenarioId: activeScenarioId,
      today,
    }),
    [activeRun.movements, activeScenarioId, manualEntries, props.bankStatements, props.cxpRecords, props.providers, today],
  );

  const tableMovements = useMemo(
    () => activeRun.movements
      .filter((movement) => {
        const date = movement.actualDate ?? movement.adjustedDate ?? movement.projectedDate;
        return date >= yearStart && date <= yearEnd;
      })
      .sort((a, b) => {
        const da = a.actualDate ?? a.adjustedDate ?? a.projectedDate;
        const db = b.actualDate ?? b.adjustedDate ?? b.projectedDate;
        return da.localeCompare(db);
      }),
    [activeRun.movements, yearStart, yearEnd],
  );

  const handleSelectMovement = useMemo(
    () => (movement: FinancialMovement, anchor: DOMRect) => {
      setDrillMovement(movement);
      setDrillAnchor(anchor);
    },
    [],
  );

  const handleCloseDrawer = useMemo(
    () => () => {
      setDrillMovement(null);
      setDrillAnchor(null);
    },
    [],
  );

  const drawerInvoiceContext = useMemo(
    () => ({
      cxpRecords: props.cxpRecords,
      clients: props.clients,
      assumptions: props.assumptions,
      budget: props.budget,
    }),
    [props.cxpRecords, props.clients, props.assumptions, props.budget],
  );

  if (!source.hasData) {
    return (
      <div className="space-y-5">
        <PageHeader title="Proyección Financiera" />
        <EmptyDataState />
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-page-in">
      <PageHeader
        title="Proyección Financiera"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              value={granularity}
              options={GRANULARITY_OPTIONS}
              onChange={setGranularity}
              pending={granularityPending}
            />
            <ComparisonControl
              scenarios={scenarios}
              activeScenarioId={activeScenarioId}
              comparisonScenarioId={comparisonScenarioId}
              onChange={setComparisonScenarioId}
            />
          </div>
        }
      />

      <ScenarioReadOnlyTabs
        scenarios={scenarios}
        activeScenarioId={activeScenarioId}
        approvedFinalCash={baseRun.summary.finalCash}
        finalCashFor={finalCashFor}
        onSelect={setActiveScenarioId}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="Caja final"
          value={fmtCurrency(summary.finalCash)}
          icon={<Wallet className="w-4 h-4" strokeWidth={1.5} />}
          color={tone(summary.finalCash, summary.minimumCashRequired)}
          sublabel={`${currentYear} · mínimo ${fmtCompact(summary.minimumCashRequired)}`}
        />
        <KpiCard
          label="Días en déficit"
          value={String(summary.deficitDays)}
          icon={<AlertIcon className="w-4 h-4" strokeWidth={1.5} />}
          color={summary.deficitDays > 0 ? 'var(--danger)' : 'var(--success)'}
          sublabel={summary.maxRiskDate ? `Máx riesgo ${summary.maxRiskDate}` : 'Sin fecha crítica'}
        />
        <KpiCard
          label="Crédito requerido"
          value={fmtCurrency(summary.creditRequired)}
          icon={<Banknote className="w-4 h-4" strokeWidth={1.5} />}
          color={summary.creditRequired > 0 ? 'var(--warning)' : 'var(--gray-950)'}
          sublabel={`Ingresos ${fmtCompact(summary.totalInflows)} · egresos ${fmtCompact(summary.totalOutflows)}`}
        />
        <KpiCard
          label={`Δ vs ${comparisonLabel}`}
          value={`${finalCashDelta === 0 ? '±0' : (finalCashDelta > 0 ? '+' : '') + fmtCompact(finalCashDelta)}`}
          icon={<GitCompare className="w-4 h-4" strokeWidth={1.5} />}
          color={finalCashDelta > 0 ? 'var(--success)' : finalCashDelta < 0 ? 'var(--danger)' : 'var(--gray-950)'}
          sublabel={comparisonRun ? 'Comparación activa' : 'vs Base'}
        />
      </div>

      <CollapsibleSection
        title="Trayectoria de caja"
        storageKey="proyeccion.section.trajectory"
        description="Ingresos, egresos, cierre y caja mínima a lo largo del año."
        actions={
          <span className="text-[11px] text-[var(--gray-400)] tabular-nums">
            {bucketDates.length} {bucketDates.length === 1 ? 'período' : 'períodos'} · {yearStart} → {yearEnd}
          </span>
        }
      >
        <div className="px-4 py-3">
          <DeferredMount delayMs={60} fallback={<ChartSkeleton />}>
            <CashFlowChart
              projection={activeRun}
              baseProjection={activeRun.scenarioId === baseRun.scenarioId ? undefined : baseRun}
              comparisonProjection={comparisonRun ?? undefined}
              onNavigateToTax={props.onNavigateToTax}
            />
          </DeferredMount>
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        title="Detalle por período"
        storageKey="proyeccion.section.bucket"
        description="Cada período se desglosa en conceptos de Planeación al expandir."
        count={activeRun.buckets.length}
        lazy
      >
        <DeferredMount delayMs={140} fallback={<TableSkeleton rows={6} />}>
          <BucketDetailTable
            buckets={activeRun.buckets}
            movements={activeRun.movements}
            rows={activeRun.rows}
            overrides={activeRun.overrides}
            granularity={deferredGranularity}
            comparisonBuckets={comparisonRun?.buckets}
            onSelectMovement={handleSelectMovement}
          />
        </DeferredMount>
      </CollapsibleSection>

      <CollapsibleSection
        title="Movimientos"
        storageKey="proyeccion.section.movements"
        description="Lista filtrable. Clic en una fila para ver factura y origen."
        count={tableMovements.length}
        lazy
      >
        <DeferredMount delayMs={220} fallback={<TableSkeleton rows={5} />}>
          <MovementsTable
            movements={tableMovements}
            granularity={deferredGranularity}
            today={today}
            onSelectMovement={handleSelectMovement}
          />
        </DeferredMount>
      </CollapsibleSection>

      <CollapsibleSection
        title="Proveedores críticos"
        storageKey="proyeccion.section.suppliers"
        defaultOpen={false}
        lazy
        count={supplierAlerts.length}
        badge={supplierAlerts.some((alert) => alert.severity === 'CRITICAL') ? <ShieldAlert className="h-3.5 w-3.5 text-[var(--danger)]" strokeWidth={1.5} /> : undefined}
        description="Estatus de pago consolidado: real, programado, manual o pendiente."
      >
        <SupplierAlertsList alerts={supplierAlerts} />
      </CollapsibleSection>

      <CollapsibleSection
        title="Impuestos"
        storageKey="proyeccion.section.taxes"
        defaultOpen={false}
        lazy
        description="IVA neto, ISN, IMSS y total con saldo vencido."
        actions={props.onNavigateToTax ? (
          <button
            type="button"
            onClick={props.onNavigateToTax}
            className="text-[11px] font-medium text-[var(--primary)] hover:underline"
          >
            Abrir módulo →
          </button>
        ) : undefined}
      >
        <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
          <TaxStat label="Saldo vencido" value={fmtCompact(taxView.overdueBalance)} tone="danger" />
          <TaxStat label="IVA período" value={fmtCompact(taxView.totals.ivaNet)} tone={taxView.totals.ivaNet > 0 ? 'warning' : 'neutral'} />
          <TaxStat label="ISN/IMSS" value={fmtCompact(taxView.totals.isn + taxView.totals.imss)} tone="warning" />
          <TaxStat label="Total acumulado" value={fmtCompact(taxView.totals.totalWithOverdue)} tone="danger" />
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        title="Alertas"
        storageKey="proyeccion.section.alerts"
        defaultOpen={false}
        lazy
        count={activeRun.alerts.length}
        badge={activeRun.alerts.some((alert) => alert.severity === 'CRITICAL')
          ? <span className="rounded-full bg-[var(--danger)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white">crítica</span>
          : undefined}
        description="Caja bajo mínimo, confianza baja, impuestos vencidos."
      >
        <AlertsPanel alerts={activeRun.alerts as ProjectionAlert[]} />
      </CollapsibleSection>

      <MovementDrillDownDrawer
        movement={drillMovement}
        anchor={drillAnchor}
        onClose={handleCloseDrawer}
        invoiceContext={drawerInvoiceContext}
      />
    </div>
  );
}

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  pending = false,
}: {
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (next: T) => void;
  /** Soft-pulses the active pill while a transition is computing the new view. */
  pending?: boolean;
}) {
  return (
    <div
      className="inline-flex h-10 rounded-xl border border-[var(--gray-200)] bg-[var(--gray-50)] p-0.5"
      aria-busy={pending || undefined}
    >
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            aria-pressed={active}
            className={`px-3 text-[12px] font-medium rounded-lg transition-colors ${active && pending ? 'animate-soft-pulse' : ''}`}
            style={{
              background: active ? 'white' : 'transparent',
              color: active ? 'var(--gray-950)' : 'var(--gray-500)',
              boxShadow: active ? '0 1px 2px rgba(15, 23, 42, 0.08)' : 'none',
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function SupplierAlertsList({ alerts }: { alerts: SupplierCriticalAlert[] }) {
  if (alerts.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-[12px] text-[var(--gray-400)]">
        Sin proveedores críticos pendientes.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-[var(--gray-100)]">
      {alerts.slice(0, 12).map((alert) => (
        <li key={alert.id} className="px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium text-[var(--gray-950)]">{alert.providerName}</div>
              <div className="mt-0.5 text-[11px] text-[var(--gray-400)]">
                {alert.invoiceNumber ? `Factura ${alert.invoiceNumber}` : 'Factura s/n'} · {alert.dueDate ? `vence ${fmtDate(alert.dueDate)}` : 'sin vencimiento'}
              </div>
              {alert.detail && (
                <div className="mt-1 text-[11px] text-[var(--gray-500)] leading-snug">{alert.detail}</div>
              )}
            </div>
            <div className="shrink-0 text-right">
              <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium ${supplierAlertClass(alert.severity)}`}>
                {alert.statusLabel}
              </span>
              <div className="mt-1 text-[12px] font-semibold tabular-nums text-[var(--gray-950)]">{fmtCompact(alert.pendingAmount)}</div>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function supplierAlertClass(severity: SupplierCriticalAlert['severity']): string {
  if (severity === 'CRITICAL') return 'bg-[var(--danger)]/10 text-[var(--danger)]';
  if (severity === 'WARNING') return 'bg-[var(--warning-muted)] text-[var(--warning)]';
  return 'bg-[var(--success)]/10 text-[var(--success)]';
}

function TaxStat({
  label,
  value,
  tone: statTone,
}: {
  label: string;
  value: string;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
}) {
  const toneClass = statTone === 'success'
    ? 'text-[var(--success)]'
    : statTone === 'warning'
      ? 'text-[var(--warning)]'
      : statTone === 'danger'
        ? 'text-[var(--danger)]'
        : 'text-[var(--gray-950)]';
  return (
    <div className="rounded-xl border border-[var(--gray-200)] bg-[var(--gray-50)] px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">{label}</div>
      <div className={`mt-1 text-[14px] font-semibold tabular-nums ${toneClass}`}>{value}</div>
    </div>
  );
}

function tone(value: number, minimum: number): string {
  if (value < minimum) return 'var(--danger)';
  if (value < minimum * 1.2) return 'var(--warning)';
  return 'var(--gray-950)';
}

function minimumCashFor(props: Props): number {
  const fallback = 20_000_000;
  if (!props.budget) return fallback;
  const month = new Date().getUTCMonth();
  const monthlyExpense = props.budget.expenseTotal?.[month] ?? 0;
  return monthlyExpense > 0 ? Math.round(monthlyExpense * 0.3) : fallback;
}

function EmptyDataState() {
  return (
    <div className="rounded-2xl border border-[var(--gray-200)] bg-white p-10 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--warning-muted)]">
        <AlertTriangle className="h-5 w-5" style={{ color: 'var(--warning)' }} strokeWidth={1.5} />
      </div>
      <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">
        Aún no hay datos suficientes para proyectar
      </h2>
      <p className="mx-auto mt-2 max-w-[480px] text-[12px] leading-relaxed text-[var(--gray-500)]">
        Necesitamos estados de cuenta bancarios y al menos uno de:
        catálogo de clientes, antigüedad de saldos, o presupuesto del año.
      </p>
    </div>
  );
}
