import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  Copy,
  GitCompare,
  Plus,
  Split,
  TrendingDown,
  TrendingUp,
  Wallet,
  AlertTriangle as AlertIcon,
} from 'lucide-react';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import type { CobranzaPayment, CobranzaRecord } from '../../../services/jdeTypes';
import type { RealReconciliationResult } from '../../../domain/realReconciliationEngine';
import { fmtCompact, fmtCurrency } from '../../../formatters';
import {
  applyAdjustmentsToMovements,
  applyCellOverridesToBuckets,
  calculateBaseProjection,
  effectiveAmount,
  effectiveMovementDate,
  summarizeBucketsForScenario,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type {
  CellOverride,
  FinancialAdjustment,
  FinancialMovement,
  FinancialScenario,
  ForecastRun,
  ManualPlanningEntry,
  PayrollCostRecord,
  PlanningCustomRow,
  PlanningRow,
  ProjectionGranularity,
  PurchaseReceiptRecord,
} from '../../shared-finance/types';

type ScenarioRun = ForecastRun & {
  rows: PlanningRow[];
  overrides: CellOverride[];
  supplierPlan: import('../../financial-planning/services/supplierPaymentSchedule').SupplierPaymentPlan;
};
import { CashFlowChart } from '../components/CashFlowChart';
import { MovementDrillDownDrawer } from '../components/MovementDrillDownDrawer';
import { ScenarioReadOnlyTabs } from '../components/ScenarioReadOnlyTabs';
import { ComparisonControl } from '../components/ComparisonControl';
import { DeferredMount } from '../components/DeferredMount';
import { ChartSkeleton } from '../components/SectionSkeletons';
import { cachedRun, fingerprintArray } from '../services/projectionCache';
import {
  buildFinancialProjectionSourceData,
  calculateCurrentBankCash,
  calculateInitialCash,
  tryGetCachedFinancialProjectionSourceData,
  type FinancialProjectionSourceData,
} from '../services/financialProjectionService';
import { yieldToMain } from '../services/yieldToMain';
import {
  loadManualPlanningEntries,
  saveManualPlanningEntries,
  expandManualPlanningEntriesToMovements,
} from '../../financial-planning/services/manualPlanningEntries';
import {
  loadPlanningAdjustments,
  loadPlanningScenarios,
  savePlanningAdjustments,
  savePlanningScenarios,
} from '../../financial-planning/services/financialPlanningStorage';
import { loadCellOverrides, saveCellOverrides } from '../../financial-planning/services/cellOverridesStorage';
import { loadCustomRows, saveCustomRows } from '../../financial-planning/services/customRowsStorage';
import { buildPlanningRows, conceptKeyForMovement } from '../../financial-planning/services/planningRowTaxonomy';
import { createNewDraft, duplicateDraft } from '../../financial-planning/services/scenarioDuplicate';
import { loadChangeLog, saveChangeLog } from '../../financial-planning/services/changeLogStorage';
import { newChangeLogEntry } from '../../financial-planning/services/changeLogTemplates';
import { scheduleSupplierPaymentsByScore } from '../../financial-planning/services/supplierPaymentSchedule';
import {
  createQuickMovementAdjustment,
} from '../services/projectionPredictionEngine';
import {
  buildAutomaticTaxReserveMovements,
  buildApprovedTaxPaymentMovements,
  buildTaxDashboardView,
  defaultTaxStore,
  loadTaxStore,
  TAX_STORE_CHANGED_EVENT,
  TAX_STORE_KEY,
} from '../../taxes/services/taxModuleService';
import KpiCard from '../../../components/ui/KpiCard';
import PageHeader from '../../../components/ui/PageHeader';
import DashboardLoadingShell from '../../shared-finance/components/DashboardLoadingShell';
import EmptyState from '../../shared-finance/components/EmptyState';
import { useNavigateToTab } from '../../shared-finance/components/NavigationContext';
import {
  toneByFloor,
  toneByCount,
  toneByDelta,
} from '../../shared-finance/components/tone';
import { MidasBubble, type MidasProposalSuggestion } from '../../midas-ai';
import { createFinancialAdjustment } from '../../financial-planning/services/financialPlanningService';
import { ProbabilisticRiskStrip } from '../components/ProbabilisticRiskStrip';
import { useProbabilisticForecast } from '../services/probabilisticForecastService';

interface Props {
  companyCode: string;
  bankStatements: BankAccountStatement[];
  clients: Client[];
  providers: Provider[];
  cxpRecords: CXPRecord[];
  cobranzaRecords?: CobranzaRecord[];
  cobranzaPayments?: CobranzaPayment[];
  cobranzaReconciliation?: RealReconciliationResult;
  purchaseReceipts?: PurchaseReceiptRecord[];
  payrollCosts?: PayrollCostRecord[];
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
 * Proyección Financiera — centro de escenarios predictivos y edición rápida.
 *
 * - Default activo: Aprobado (main branch).
 * - Selector: Base + Aprobado + drafts activos.
 * - Pipeline: movements ∪ manual ∪ tax → adjustments → projection → cell overrides
 *   (sincroniza con Planeación).
 * - Layout: secciones colapsables persistidas en sessionStorage.
 * - Toda mutación se persiste en los mismos storages que usa Planeación.
 *
 * Mount strategy:
 *   The canonical projection (`buildFinancialProjectionSourceData` →
 *   `computeBaseCashFlow`) is the single most expensive thing this page
 *   does — it iterates clients × months × CXP. We outer-gate the
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
      props.cobranzaRecords,
      props.cobranzaPayments,
      props.cobranzaReconciliation,
      props.purchaseReceipts,
      props.payrollCosts,
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
  //
  // Cancellation: synchronous compute can't be interrupted mid-flight, so
  // the only safe interrupt window is *before* it starts. We yield to the
  // main thread twice (rAF then MessageChannel macrotask) so any queued
  // tab-switch click is processed first. If the user navigates away during
  // that window, `cancelled` flips and we never enter the heavy block.
  useEffect(() => {
    if (cachedSource) {
      setSource(cachedSource);
      return;
    }
    let cancelled = false;
    let rafId: number | null = null;
    let timeoutId: number | null = null;

    const run = async () => {
      // Yield once more so the warm-up shell has actually painted and any
      // queued input gets processed before we lock the main thread.
      await yieldToMain();
      if (cancelled) return;
      try {
        const built = buildFinancialProjectionSourceData(cacheProbeInput);
        if (!cancelled) setSource(built);
      } catch {
        // Compute failures must not crash the dashboard — caller surfaces
        // the empty state via `source.hasData`.
      }
    };

    // Double rAF guarantees one paint of the warm-up shell first.
    rafId = window.requestAnimationFrame(() => {
      rafId = window.requestAnimationFrame(() => {
        if (cancelled) return;
        timeoutId = window.setTimeout(run, 0);
      });
    });

    return () => {
      cancelled = true;
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [cachedSource, cacheProbeInput]);

  if (!source) {
    return <ProjectionWarmupShell />;
  }

  return <ProjectionDashboardInner {...props} today={today} source={source} />;
}

/**
 * Lightweight skeleton shown for the first paint when the canonical
 * projection still needs to build. Delegates to the shared
 * DashboardLoadingShell so every dashboard warms up with the same
 * shimmer + stagger language.
 */
function ProjectionWarmupShell() {
  return (
    <DashboardLoadingShell
      kpis={4}
      showFilterBar
      showChart
      tableRows={4}
      label="Calculando proyección"
    />
  );
}

/**
 * The actual dashboard logic. Receives the resolved `source` so the body
 * never needs to deal with the warming-up state.
 */
function ProjectionDashboardInner(props: Props & { today: string; source: FinancialProjectionSourceData }) {
  const { today, source } = props;
  const goTo = useNavigateToTab();
  const yearStart = today;
  const yearEnd = useMemo(() => addUtcDays(today, 364), [today]);

  const [storedScenarios, setStoredScenarios] = useState<FinancialScenario[]>(() => loadPlanningScenarios([]));
  const [storedAdjustments, setStoredAdjustments] = useState<FinancialAdjustment[]>(() => loadPlanningAdjustments([]));
  const [manualEntries] = useState<ManualPlanningEntry[]>(() => loadManualPlanningEntries([]));
  const [cellOverrides, setCellOverrides] = useState<CellOverride[]>(() => loadCellOverrides([]));
  const [customRows, setCustomRows] = useState<PlanningCustomRow[]>(() => loadCustomRows([]));
  const [changeLog, setChangeLog] = useState(() => loadChangeLog([]));
  const [taxStore, setTaxStore] = useState(() => loadTaxStore(defaultTaxStore()));

  // Skip the first invocation of each save effect. The state was just
  // hydrated from localStorage; re-serializing the same payload on mount
  // costs main-thread time during the projection's heaviest frame. Each
  // ref starts false and flips after the first commit — the saver only
  // fires on genuine changes.
  const savedScenariosRef = useRef(false);
  const savedAdjustmentsRef = useRef(false);
  const savedManualRef = useRef(false);
  const savedOverridesRef = useRef(false);
  const savedCustomRowsRef = useRef(false);
  const savedChangeLogRef = useRef(false);
  useEffect(() => {
    if (!savedScenariosRef.current) { savedScenariosRef.current = true; return; }
    savePlanningScenarios(storedScenarios);
  }, [storedScenarios]);
  useEffect(() => {
    if (!savedAdjustmentsRef.current) { savedAdjustmentsRef.current = true; return; }
    savePlanningAdjustments(storedAdjustments);
  }, [storedAdjustments]);
  useEffect(() => {
    if (!savedManualRef.current) { savedManualRef.current = true; return; }
    saveManualPlanningEntries(manualEntries);
  }, [manualEntries]);
  useEffect(() => {
    if (!savedOverridesRef.current) { savedOverridesRef.current = true; return; }
    saveCellOverrides(cellOverrides);
  }, [cellOverrides]);
  useEffect(() => {
    if (!savedCustomRowsRef.current) { savedCustomRowsRef.current = true; return; }
    saveCustomRows(customRows);
  }, [customRows]);
  useEffect(() => {
    if (!savedChangeLogRef.current) { savedChangeLogRef.current = true; return; }
    saveChangeLog(changeLog);
  }, [changeLog]);

  useEffect(() => {
    const reloadTaxStore = () => setTaxStore(loadTaxStore(defaultTaxStore()));
    const handleStorage = (event: StorageEvent) => {
      if (event.key === TAX_STORE_KEY) reloadTaxStore();
    };
    window.addEventListener(TAX_STORE_CHANGED_EVENT, reloadTaxStore);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(TAX_STORE_CHANGED_EVENT, reloadTaxStore);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

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
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

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

  useEffect(() => {
    if (!statusMessage) return;
    const handle = window.setTimeout(() => setStatusMessage(null), 4500);
    return () => window.clearTimeout(handle);
  }, [statusMessage]);

  const initialCash = useMemo(
    () => calculateInitialCash(props.bankStatements, props.startingBalance, {
      companyCode: props.companyCode,
    }),
    [props.bankStatements, props.startingBalance, props.companyCode],
  );
  const supplierInitialCash = useMemo(
    () => calculateCurrentBankCash(props.bankStatements, props.companyCode, initialCash),
    [props.bankStatements, props.companyCode, initialCash],
  );
  const minimumCash = useMemo(() => minimumCashFor(), []);

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
    const taxKey = [
      fingerprintArray(taxStore.obligations, (o) => o.id + ':' + o.pendingAmount + ':' + o.status + ':' + o.paymentPlan.length),
      fingerprintArray(taxStore.adjustments, (a) => a.id + ':' + a.kind + ':' + a.amount + ':' + a.createdAt),
      fingerprintArray(taxStore.taxRateOverrides, (r) => r.targetType + ':' + r.targetKey + ':' + r.rate + ':' + r.updatedAt),
      taxStore.overdueBalance,
    ].join(':');
    const providerKey = fingerprintArray(props.providers, (provider) => provider.id + ':' + (provider.score ?? '') + ':' + (provider.lastUpdatedAt ?? ''));
    return [
      movementsKey,
      adjustmentsKey,
      manualKey,
      taxKey,
      providerKey,
      yearStart,
      yearEnd,
      today,
      initialCash,
      supplierInitialCash,
      minimumCash,
    ].join('|');
  }, [
    source.movements,
    storedAdjustments,
    manualEntries,
    taxStore,
    props.providers,
    yearStart,
    yearEnd,
    today,
    initialCash,
    supplierInitialCash,
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
        const manualMovements = expandManualPlanningEntriesToMovements(manualEntries, {
          scenarioId,
          startDate: yearStart,
          endDate: yearEnd,
          asOfDate: today,
        });
        const preTaxMovements = applyAdjustmentsToMovements(
          [...source.movements, ...manualMovements],
          storedAdjustments,
          scenarioId,
        );
        const taxSeedView = buildTaxDashboardView({
          clients: props.clients,
          providers: props.providers,
          assumptions: props.assumptions,
          cxpRecords: props.cxpRecords,
          purchaseReceipts: props.purchaseReceipts,
          payrollCosts: props.payrollCosts,
          cobranzaPayments: props.cobranzaPayments,
          budget: props.budget,
          companyCode: props.companyCode,
          startDate: yearStart,
          endDate: yearEnd,
          movements: preTaxMovements,
          store: taxStore,
          today,
        });
        const taxMovements = [
          ...buildApprovedTaxPaymentMovements({
            obligations: taxSeedView.obligations,
            scenarioId,
            startDate: yearStart,
            endDate: yearEnd,
            asOfDate: today,
          }),
          ...buildAutomaticTaxReserveMovements({
            obligations: taxSeedView.obligations,
            scenarioId,
            startDate: yearStart,
            endDate: yearEnd,
            asOfDate: today,
          }),
        ];
        const adjustedMovements = applyAdjustmentsToMovements(
          [...source.movements, ...manualMovements, ...taxMovements],
          storedAdjustments,
          scenarioId,
        );
        const supplierSchedule = scheduleSupplierPaymentsByScore({
          movements: adjustedMovements,
          providers: props.providers,
          startDate: today,
          endDate: yearEnd,
          initialCash: supplierInitialCash,
          minimumCash,
          scenarioId,
        });
        const rawProjection = calculateBaseProjection(supplierSchedule.movements, {
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
          summary: summarizeBucketsForScenario(buckets, rawProjection.movements, minimumCash, gran),
          rows,
          overrides: scenarioOverrides,
          supplierPlan: supplierSchedule.plan,
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
    taxStore,
    props.providers,
    yearStart,
    yearEnd,
    today,
    initialCash,
    supplierInitialCash,
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

  // Pre-warm the *other* two granularities for the active scenario in idle
  // time. We hold off until the page has been visible long enough that
  // initial compute + first interaction has settled — otherwise the
  // pre-warm tasks fight the heavy first paint and cause exactly the kind
  // of mid-load freeze that traps tab-switch clicks. 2.5 s + yields gives
  // the user a real window to navigate away cheaply.
  useEffect(() => {
    const others: ProjectionGranularity[] = ['monthly', 'weekly', 'daily']
      .filter((g): g is ProjectionGranularity => g !== deferredGranularity);
    let cancelled = false;
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    });
    const handles: Array<number | ReturnType<typeof setTimeout>> = [];
    const scheduleRun = (gran: ProjectionGranularity, delay: number) => {
      const fire = async () => {
        if (cancelled) return;
        await yieldToMain();
        if (cancelled) return;
        try { buildRun(activeScenarioId, gran); } catch { /* best-effort */ }
      };
      if (typeof ric.requestIdleCallback === 'function') {
        handles.push(ric.requestIdleCallback(fire, { timeout: delay + 2000 }));
      } else {
        handles.push(setTimeout(fire, delay));
      }
    };
    others.forEach((gran, i) => scheduleRun(gran, 2500 + i * 1500));
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
  const probabilistic = useProbabilisticForecast(activeRun, summary.minimumCashRequired);

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

  const handleCloseDrawer = useMemo(
    () => () => {
      setDrillMovement(null);
      setDrillAnchor(null);
    },
    [],
  );

  const activeScenario = scenarios.find((scenario) => scenario.id === activeScenarioId) ?? approvedScenario;

  const handleCreateDraft = useCallback((name?: string): string => {
    const { newScenario, seedEntry } = createNewDraft({
      approved: approvedScenario,
      name,
      user: 'tesoreria@senda.local',
    });
    setStoredScenarios((current) => [...current, newScenario]);
    setChangeLog((current) => [seedEntry, ...current]);
    setActiveScenarioId(newScenario.id);
    setStatusMessage(`Escenario "${newScenario.name}" creado.`);
    return newScenario.id;
  }, [approvedScenario]);

  const ensureEditableScenario = useCallback((reason: string): string => {
    const current = scenarios.find((scenario) => scenario.id === activeScenarioId) ?? approvedScenario;
    if (current.kind === 'DRAFT') return current.id;
    return handleCreateDraft(reason);
  }, [activeScenarioId, approvedScenario, handleCreateDraft, scenarios]);

  const handleDuplicateActive = useCallback(() => {
    const sourceScenario = scenarios.find((scenario) => scenario.id === activeScenarioId) ?? approvedScenario;
    const result = duplicateDraft({
      source: sourceScenario,
      approvedScenarioId: approvedScenario.id,
      allOverrides: cellOverrides,
      allCustomRows: customRows,
      changeLog,
      user: 'tesoreria@senda.local',
    });
    setStoredScenarios((current) => [...current, result.newScenario]);
    setCellOverrides(result.cellOverrides);
    setCustomRows(result.customRows);
    setChangeLog(result.changeLog);
    setActiveScenarioId(result.newScenario.id);
    setStatusMessage(`Escenario duplicado como "${result.newScenario.name}".`);
  }, [activeScenarioId, approvedScenario, cellOverrides, changeLog, customRows, scenarios]);

const commitQuickAdjustment = useCallback((movement: FinancialMovement, kind: 'SHIFT_DATE' | 'AMOUNT_OVERRIDE' | 'SPLIT_PAYMENT') => {
    if (movement.lockState === 'LOCKED') {
      setStatusMessage('Movimiento bloqueado. Crea el ajuste desde Planeación con autorización.');
      return;
    }
    const scenarioId = ensureEditableScenario('Ajuste rápido desde Proyección');
    const baseAmount = effectiveAmount(movement);
    const date = effectiveMovementDate(movement);
    const adjustment = createQuickMovementAdjustment({
      movement,
      scenarioId,
      action: kind,
      asOfDate: today,
      targetDate: kind === 'SHIFT_DATE'
        ? shiftIsoDate(date, movement.type === 'INFLOW' ? -7 : 7, today)
        : undefined,
      targetAmount: kind === 'AMOUNT_OVERRIDE'
        ? baseAmount * (movement.type === 'INFLOW' ? 1.1 : 0.9)
        : undefined,
      splitCount: 2,
    });
    setStoredAdjustments((current) => [...current, adjustment]);
    setChangeLog((current) => [
      newChangeLogEntry({
        scenarioId,
        kind: 'EDIT_CELL',
        autoDescription: `Ajuste rápido en ${movement.counterpartyName ?? movement.concept}.`,
        payload: {
          adjustmentId: adjustment.id,
          movementId: movement.id,
          action: kind,
        },
        createdBy: 'tesoreria@senda.local',
      }),
      ...current,
    ]);
    setStatusMessage('Ajuste aplicado. La proyección se recalculó.');
  }, [ensureEditableScenario, today]);

  const drawerInvoiceContext = useMemo(
    () => ({
      cxpRecords: props.cxpRecords,
      cobranzaRecords: props.cobranzaRecords ?? [],
      clients: props.clients,
      assumptions: props.assumptions,
      budget: props.budget,
    }),
    [props.cxpRecords, props.cobranzaRecords, props.clients, props.assumptions, props.budget],
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
            <button
              type="button"
              onClick={() => handleCreateDraft()}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[12px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)]"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
              Nuevo
            </button>
            <button
              type="button"
              onClick={handleDuplicateActive}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[12px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)]"
            >
              <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
              Duplicar
            </button>
          </div>
        }
      />

      {statusMessage && (
        <div className="rounded-xl border border-[var(--gray-200)] bg-white px-4 py-2 text-[12px] font-medium text-[var(--gray-700)]">
          {statusMessage}
        </div>
      )}

      <ScenarioReadOnlyTabs
        scenarios={scenarios}
        activeScenarioId={activeScenarioId}
        approvedFinalCash={baseRun.summary.finalCash}
        finalCashFor={finalCashFor}
        onSelect={setActiveScenarioId}
      />

<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <KpiCard
          label="Caja final"
          value={fmtCurrency(summary.finalCash)}
          icon={<Wallet className="w-4 h-4" strokeWidth={1.5} />}
          color={toneByFloor(summary.finalCash, summary.minimumCashRequired)}
          sublabel={`12 meses · mínimo ${fmtCompact(summary.minimumCashRequired)}`}
          onClick={() => goTo({ tab: 'financialPlanning', focus: 'caja-final' })}
          navHint="Abrir Planeación"
        />
        <KpiCard
          label="Días en déficit"
          value={String(summary.deficitDays)}
          icon={<AlertIcon className="w-4 h-4" strokeWidth={1.5} />}
          color={toneByCount(summary.deficitDays)}
          sublabel={summary.maxRiskDate ? `Máx riesgo ${summary.maxRiskDate}` : 'Sin fecha crítica'}
          onClick={() => goTo({ tab: 'financialPlanning', focus: 'deficit' })}
          navHint="Ver días en déficit"
        />
        <KpiCard
          label={`Δ vs ${comparisonLabel}`}
          value={`${finalCashDelta === 0 ? '±0' : (finalCashDelta > 0 ? '+' : '') + fmtCompact(finalCashDelta)}`}
          icon={<GitCompare className="w-4 h-4" strokeWidth={1.5} />}
          color={toneByDelta(finalCashDelta)}
          sublabel={comparisonRun ? 'Comparación activa' : 'vs Base'}
        />
      </div>

      <ProbabilisticRiskStrip
        run={probabilistic.run}
        loading={probabilistic.loading}
        error={probabilistic.error}
      />

      <DeferredMount delayMs={60} fallback={<ChartSkeleton />}>
        <CashFlowChart
          projection={activeRun}
          baseProjection={activeRun.scenarioId === baseRun.scenarioId ? undefined : baseRun}
          comparisonProjection={comparisonRun ?? undefined}
          probabilisticProjection={probabilistic.run}
          onNavigateToTax={props.onNavigateToTax}
        />
      </DeferredMount>

      <MovementDrillDownDrawer
        movement={drillMovement}
        anchor={drillAnchor}
        onClose={handleCloseDrawer}
        invoiceContext={drawerInvoiceContext}
        quickActions={drillMovement ? (
          <QuickMovementActions
            movement={drillMovement}
            isDraft={activeScenario.kind === 'DRAFT'}
            onShiftDate={() => commitQuickAdjustment(drillMovement, 'SHIFT_DATE')}
            onAmountOverride={() => commitQuickAdjustment(drillMovement, 'AMOUNT_OVERRIDE')}
            onSplit={() => commitQuickAdjustment(drillMovement, 'SPLIT_PAYMENT')}
          />
        ) : undefined}
      />

      <MidasBubble
        cia={props.companyCode}
        asOfDate={today}
        activeRun={activeRun}
        providers={props.providers}
        adjustments={storedAdjustments}
        activeScenarioId={activeScenario.id}
        activeScenarioKind={activeScenario.kind}
        onAcceptProposal={(suggestion: MidasProposalSuggestion) => {
          try {
            const targetScenarioId = ensureEditableScenario(`MIDAS · ${suggestion.draft.name}`.slice(0, 60));
            const adjustment = createFinancialAdjustment({
              name: suggestion.draft.name,
              scenarioIds: [targetScenarioId],
              type: suggestion.draft.type,
              targetType: suggestion.draft.targetType,
              targetExpression: suggestion.draft.targetExpression,
              reasonCode: suggestion.draft.reasonCode,
              justification: suggestion.draft.justification,
              deltaAmount: suggestion.draft.deltaAmount,
              deltaDays: suggestion.draft.deltaDays,
              percentageChange: suggestion.draft.percentageChange,
              adjustedValue: suggestion.draft.adjustedValue,
              createdBy: 'midas@senda.local',
            });
            setStoredAdjustments((current) => [
              ...current,
              {
                ...adjustment,
                impactSummary: {
                  cashImpact: suggestion.estimatedCashImpact,
                  deficitDaysReduced: 0,
                  riskChange: 0,
                },
              },
            ]);
            setStatusMessage(`MIDAS guardó propuesta "${adjustment.name}" como DRAFT.`);
          } catch (err) {
            alert(err instanceof Error ? err.message : 'No se pudo crear la propuesta.');
          }
        }}
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
      className="inline-flex h-10 rounded-[var(--radius)] border border-[var(--gray-200)] bg-[var(--gray-50)] p-0.5"
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
            className={`px-3 text-[12px] font-medium rounded-[var(--radius-md)] transition-colors ${active && pending ? 'animate-soft-pulse' : ''}`}
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

function QuickMovementActions({
  movement,
  isDraft,
  onShiftDate,
  onAmountOverride,
  onSplit,
}: {
  movement: FinancialMovement;
  isDraft: boolean;
  onShiftDate: () => void;
  onAmountOverride: () => void;
  onSplit: () => void;
}) {
  const locked = movement.lockState === 'LOCKED';
  if (locked) {
    return (
      <p className="text-[11px] leading-snug text-[var(--gray-500)]">
        Este movimiento está bloqueado por fuente o criticidad. No se ajusta automáticamente desde Proyección.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {!isDraft && (
        <div className="rounded-lg bg-[var(--warning-muted)] px-2 py-1.5 text-[11px] text-[var(--warning)]">
          Se creará un draft automáticamente para guardar el ajuste.
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={onShiftDate}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--gray-200)] bg-white px-2.5 text-[11px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)]"
        >
          <CalendarClock className="h-3.5 w-3.5" strokeWidth={1.75} />
          {movement.type === 'INFLOW' ? 'Adelantar 7d' : 'Diferir 7d'}
        </button>
        <button
          type="button"
          onClick={onAmountOverride}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--gray-200)] bg-white px-2.5 text-[11px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)]"
        >
          {movement.type === 'INFLOW'
            ? <TrendingUp className="h-3.5 w-3.5" strokeWidth={1.75} />
            : <TrendingDown className="h-3.5 w-3.5" strokeWidth={1.75} />}
          {movement.type === 'INFLOW' ? 'Subir 10%' : 'Bajar 10%'}
        </button>
        {movement.type === 'OUTFLOW' && (
          <button
            type="button"
            onClick={onSplit}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--gray-200)] bg-white px-2.5 text-[11px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)]"
          >
            <Split className="h-3.5 w-3.5" strokeWidth={1.75} />
            Dividir en 2
          </button>
        )}
      </div>
    </div>
  );
}

// Tone helpers moved to ../../shared-finance/components/tone.ts.

function shiftIsoDate(date: string, days: number, floorDate: string): string {
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  const shifted = parsed.toISOString().slice(0, 10);
  return days < 0 && shifted < floorDate ? floorDate : shifted;
}

function minimumCashFor(): number {
  const fallback = 20_000_000;
  return fallback;
}

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function EmptyDataState() {
  return (
    <EmptyState
      tone="warning"
      align="center"
      icon={<AlertTriangle className="h-5 w-5" strokeWidth={1.5} />}
      title="Aún no hay datos suficientes para proyectar"
      description="Necesitamos estados de cuenta bancarios y al menos uno de: catálogo de clientes, antigüedad de saldos, CXP JDE o cobranza real."
    />
  );
}
