import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from 'react';
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
import type { CobranzaPayment, CobranzaRecord, RolRecord } from '../../../services/jdeTypes';
import type { RealReconciliationResult } from '../../../domain/realReconciliationEngine';
import { fmtCompact, fmtCurrency, todayISO } from '../../../formatters';
import { effectiveAmount, effectiveMovementDate } from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type {
  CellOverride,
  FinancialAdjustment,
  FinancialMovement,
  FinancialScenario,
  ManualPlanningEntry,
  PayrollCostRecord,
  PlanningCustomRow,
  ProjectionGranularity,
  PurchaseReceiptRecord,
} from '../../shared-finance/types';
import { CashFlowChart } from '../components/CashFlowChart';
import {
  CobranzaKpiCard,
  MinimumExpenseKpi,
  computeRunYtd,
} from '../components/MergedDashboardKpis';
import { computeMinimumOperatingExpense } from '../../../domain/minimumOperatingExpense';
import { MovementDrillDownDrawer } from '../components/MovementDrillDownDrawer';
import { ScenarioComparisonBar } from '../components/ScenarioComparisonBar';
import { DeferredMount } from '../components/DeferredMount';
import { ChartSkeleton } from '../components/SectionSkeletons';
import { clearProjectionRunCache, fingerprintArray, primeProjectionRunCache } from '../services/projectionCache';
import { projectionWindowFor } from '../services/projectionWindow';
import { signalProjectionFirstPaint } from '../services/projectionBootSignal';
import { setScenarioRunPlaceholder } from '../../shared-finance/hooks/useScenarioRunWorker';
import type { BuildScenarioForecastRunArgs } from '../../financial-planning/services/scenarioForecastRun';
import type {
  ScenarioForecastRunWorkerRequest,
  ScenarioForecastRunWorkerResponse,
} from '../../../workers/scenarioForecastRunWorkerTypes';
import { useScenarioRunWorker } from '../../shared-finance/hooks/useScenarioRunWorker';
import {
  buildFinancialProjectionSourceData,
  calculateCurrentBankCash,
  calculateInitialCash,
  rememberFinancialProjectionSourceData,
  tryGetCachedFinancialProjectionSourceData,
  type FinancialProjectionSourceData,
} from '../services/financialProjectionService';
import {
  loadProjectionSourceFromPersistentCache,
  loadScenarioRunFromPersistentCache,
  saveProjectionSourceToPersistentCache,
  saveScenarioRunToPersistentCache,
} from '../services/financialProjectionPersistentCache';
import { yieldToMain } from '../services/yieldToMain';
import {
  nextSourceJobId,
  postToSharedSourceWorker,
  subscribeSharedSourceWorker,
} from '../../shared-finance/services/sharedSourceWorker';
import {
  loadManualPlanningEntries,
  saveManualPlanningEntries,
} from '../../financial-planning/services/manualPlanningEntries';
import {
  loadPlanningAdjustments,
  loadPlanningScenarios,
  savePlanningAdjustments,
  savePlanningScenarios,
} from '../../financial-planning/services/financialPlanningStorage';
import { loadCellOverrides, saveCellOverrides } from '../../financial-planning/services/cellOverridesStorage';
import { loadCustomRows, saveCustomRows } from '../../financial-planning/services/customRowsStorage';
import { createNewDraft, duplicateDraft } from '../../financial-planning/services/scenarioDuplicate';
import { loadChangeLog, saveChangeLog } from '../../financial-planning/services/changeLogStorage';
import { newChangeLogEntry } from '../../financial-planning/services/changeLogTemplates';
import { type ScenarioForecastRun } from '../../financial-planning/services/scenarioForecastRun';
import { APPROVED_SCENARIO_ID, BASE_SCENARIO_ID, ensureCoreScenarios } from '../../financial-planning/services/scenarioBootstrap';
import {
  createQuickMovementAdjustment,
} from '../services/projectionPredictionEngine';
import { defaultTaxStore, loadTaxStore, TAX_STORE_CHANGED_EVENT, TAX_STORE_KEY } from '../../taxes/services/taxModuleService';
import KpiCard from '../../../components/ui/KpiCard';
import PageHeader from '../../../components/ui/PageHeader';
import DashboardLoadingShell from '../../shared-finance/components/DashboardLoadingShell';
import EmptyState from '../../shared-finance/components/EmptyState';
import { useNavigateToTab } from '../../shared-finance/components/NavigationContext';
import { useScenarioSelection } from '../../shared-finance/components/ScenarioSelectionContext';
import {
  toneByFloor,
  toneByCount,
  toneByDelta,
} from '../../shared-finance/components/tone';
import { MidasBubble, type MidasProposalSuggestion } from '../../midas-ai';
import { createFinancialAdjustment } from '../../financial-planning/services/financialPlanningService';
import { useProbabilisticForecast } from '../services/probabilisticForecastService';
import {
  FORECAST_MODELS,
  type ForecastModelId,
  type ForecastOutput,
} from '../../../domain/comprasForecastModels';

type ScenarioRun = ScenarioForecastRun;

interface Props {
  companyCode: string;
  bankStatements: BankAccountStatement[];
  clients: Client[];
  providers: Provider[];
  cxpRecords: CXPRecord[];
  cobranzaRecords?: CobranzaRecord[];
  cobranzaPayments?: CobranzaPayment[];
  cobranzaReconciliation?: RealReconciliationResult;
  /** ROL CITI: viajes ejecutados → ingreso futuro proyectado (Aprobado). */
  rolRecords?: RolRecord[];
  /** CXPs ya pagadas (PagoProveedor); se excluyen del egreso proyectado. */
  paidCxpKeys?: Set<string>;
  /** CARGO bancarios matcheados a PagoProveedor — reclasifican como AP_PAYMENT. */
  cargoEnrichments?: Map<string, { status: 'MATCHED' | 'ORPHAN'; payments?: Array<{ nombreProveedor: string; importe: number }> }>;
  purchaseReceipts?: PurchaseReceiptRecord[];
  payrollCosts?: PayrollCostRecord[];
  assumptions: CashFlowAssumptions;
  budget: Budget | null;
  startingBalance?: number;
  onNavigateToTax?: () => void;
  /** Modelo seleccionado para forecast de futuras OCs. */
  forecastModelId?: ForecastModelId;
  /** Cambia el modelo y persiste. */
  onForecastModelChange?: (id: ForecastModelId) => void;
  /** Salida del modelo seleccionado: receipts + estadísticas por proveedor. */
  forecastSummary?: ForecastOutput;
  /** Visible tab flag. Hidden keep-alive instances should not start new heavy builds. */
  isActive?: boolean;
  /**
   * Costo real de nómina del mes en curso (TRESS). Cuando > 0, el piso
   * operativo añade una sub-línea de referencia "Real TRESS". Rescatado
   * del antiguo Dashboard al fusionarse en Proyección.
   */
  payrollMonthlyActualJDE?: number;
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
  const today = useMemo(() => todayISO(), []);

  // NOTE: function props (onNavigateToTax, onForecastModelChange) must NOT
  // be part of this object — it is posted to a Web Worker and functions are
  // not structured-cloneable (DataCloneError → worker dies → 38s sync fallback).
  const cacheProbeInput = useMemo(
    () => {
      const {
        onNavigateToTax: _onNavigateToTax,
        onForecastModelChange: _onForecastModelChange,
        isActive: _isActive,
        ...data
      } = props;
      return { ...data, asOfDate: today };
    },
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
      props.rolRecords,
      props.paidCxpKeys,
      props.cargoEnrichments,
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
  // PERF (2026-05-14): mismo patrón que Planning — el build ahora vive en
  // Web Worker para no pinear el thread varios segundos. Fallback sync si
  // Worker falla. Logs en `[projection.source]` para diagnóstico.
  const sourceJobRef = useRef(0);
  // Map jobId → input that produced it, so the singleton-worker listener
  // remembers/caches against the right input (not whatever is current at
  // result time). Per-dashboard so Planning's jobs don't leak in.
  const sourceInputByJobId = useRef<Map<number, typeof cacheProbeInput>>(new Map());
  // Debounce source rebuilds. Boot data waves (compras / pagoproveedor /
  // banks FULL fetches) change cacheProbeInput seconds apart; without this
  // the 227k-movement canonical rebuilt 3× back-to-back and posted three
  // 227k results to the main thread in ~14s → renderer OOM exactly when the
  // user switched to daily. In-memory + persistent caches stay immediate
  // (fast path); only the expensive worker build waits for inputs to settle.
  // Each cacheProbeInput change cancels the pending build via effect cleanup.
  useEffect(() => {
    if (props.isActive === false && !cachedSource) return;
    if (cachedSource) {
      setSource(cachedSource);
      return;
    }
    let cancelled = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const jobId = nextSourceJobId();
    sourceJobRef.current = jobId;
    sourceInputByJobId.current.set(jobId, cacheProbeInput);

    const runSyncFallback = async () => {
      await yieldToMain();
      if (cancelled) return;
      const t0 = performance.now();
      try {
        const built = buildFinancialProjectionSourceData(cacheProbeInput);
        if (!cancelled && sourceJobRef.current === jobId) {
          saveProjectionSourceToPersistentCache(cacheProbeInput, built);
          setSource(built);
        }
      } catch {
        /* swallow — empty-state shows */
      }
      // eslint-disable-next-line no-console
      console.info(`[projection.source] sync fallback ${(performance.now() - t0).toFixed(0)}ms`);
    };

    const startWorker = () => {
      // eslint-disable-next-line no-console
      console.info(`[projection.source] requesting jobId=${jobId} cxp=${cacheProbeInput.cxpRecords.length} cobranza=${cacheProbeInput.cobranzaRecords?.length ?? 0} rol=${cacheProbeInput.rolRecords?.length ?? 0}`);

      if (typeof Worker === 'undefined') {
        void runSyncFallback();
        return;
      }

      // Singleton worker shared with Planning + useFinancialProjectionSource —
      // before, each dashboard spawned its own ~200MB compute worker; both
      // KeepAlive-mounted dashboards = duplicate. Now one worker handles all
      // callsites; per-call subscription filters by jobId.
      const ok = postToSharedSourceWorker({ jobId, input: cacheProbeInput });
      if (!ok) void runSyncFallback();
    };

    void (async () => {
      const persisted = await loadProjectionSourceFromPersistentCache(cacheProbeInput);
      if (cancelled || sourceJobRef.current !== jobId) return;
      if (persisted) {
        // eslint-disable-next-line no-console
        console.info(`[projection.source] persistent cache hit jobId=${jobId}`);
        rememberFinancialProjectionSourceData(cacheProbeInput, persisted);
        setSource(persisted);
        return;
      }
      // Settle inputs before paying the ~20s / 227k-movement build. Boot data
      // waves (compras / pagoproveedor / banks / nomina FULL fetches) land
      // SECONDS apart — cada cambio de cacheProbeInput cancela el timer
      // pendiente y arranca otro (debounce trailing), así que sólo dispara
      // cuando los inputs llevan QUIETOS la ventana completa.
      //
      // 12s (subido de 6s): en cold boot real las olas de JDE/nómina abarcan
      // >60s con huecos individuales que excedían 6s → el timer disparaba a
      // media settle y el source se reconstruía 5-6× (jobId 2→6), cada uno un
      // objeto de cientos de MB; con la data cruda residente el pico cruzaba
      // 4GB → OOM ("Aw Snap"). 12s cubre el hueco inter-ola típico y coalesce
      // el burst en ~1 build → pico acotado (con SOURCE_CACHE=2) → no OOM, y
      // habilita gatear el splash sin reventar (req 6). Los caminos rápidos
      // (cachedSource L233, persistent-hit L303) NO pasan por aquí, así que
      // warm boot sigue instantáneo; el retraso sólo afecta el cold MISS,
      // que es justo donde queremos coalescer. jsdom/no-Worker inmediato.
      if (typeof Worker === 'undefined') {
        startWorker();
      } else {
        debounce = setTimeout(() => {
          if (!cancelled) startWorker();
        }, 12000);
      }
    })();

    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      // With shared worker we no longer terminate — that would kill jobs
      // from Planning and useFinancialProjectionSource too. The `cancelled`
      // flag + jobId-filtered listener guarantee stale results no-op.
    };
  }, [cachedSource, cacheProbeInput, props.isActive]);

  // Subscribe to shared source worker once; filter by the per-job input map
  // so we only react to jobs this dashboard posted.
  useEffect(() => {
    const unsub = subscribeSharedSourceWorker((data) => {
      const myInput = sourceInputByJobId.current.get(data.jobId);
      if (!myInput) return; // not ours
      sourceInputByJobId.current.delete(data.jobId);
      // Stale-job guard: only commit if no newer job was posted after this one.
      if (data.jobId !== sourceJobRef.current) return;
      if (data.result) {
        // eslint-disable-next-line no-console
        console.info(`[projection.source] worker result jobId=${data.jobId}`);
        rememberFinancialProjectionSourceData(myInput, data.result);
        saveProjectionSourceToPersistentCache(myInput, data.result);
        setSource(data.result);
      } else if (data.error) {
        // eslint-disable-next-line no-console
        console.warn(`[projection.source] worker error`, data.error);
      }
    });
    return () => {
      unsub();
      sourceInputByJobId.current.clear();
    };
  }, []);

  const [scenarioRunCacheReady, setScenarioRunCacheReady] = useState(false);
  // Track which `source` identity we already preloaded. Boot data waves
  // (cxp/cobranza/compras/payroll hidratan en secuencia ~60s) rebuilden
  // `projectionProps` con identity nueva → este effect re-disparaba con
  // `props` cambiado, blanqueaba `scenarioRunCacheReady` y desmontaba
  // ProjectionDashboardInner. El remount perdía workerRef / lastResultByScenario
  // y respawneaba workers que volvían a postear ~100MB heavy → renderer OOM
  // (~1s después de entrar a Proyección, antes que termine la primera ola).
  // Solo re-preload cuando `source` cambia de identidad; cambios de props
  // los maneja Inner sin desmontar.
  const preloadedSourceRef = useRef<FinancialProjectionSourceData | null>(null);
  useEffect(() => {
    if (!source) {
      setScenarioRunCacheReady(false);
      preloadedSourceRef.current = null;
      return;
    }
    if (preloadedSourceRef.current === source) return;
    let cancelled = false;
    void (async () => {
      await preloadProjectionScenarioRuns({
        source,
        props,
        today,
      });
      if (!cancelled) {
        preloadedSourceRef.current = source;
        setScenarioRunCacheReady(true);
      }
    })();
    return () => { cancelled = true; };
    // props/today changes are handled by Inner without remounting; gating
    // remount on `source` alone is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // req 6: el primer paint REAL ocurre cuando el Inner monta con un activeRun
  // que ya NO es el placeholder universal (es decir, el worker terminó el
  // primer per-scenario run). Antes señalábamos en cuanto `source` resolvía,
  // pero el dashboard seguía mostrando "Cargando proyección de Escenario
  // Aprobado…" durante 500ms-2s mientras el worker computaba. El usuario
  // veía el splash desaparecer y la app aparentemente sin data. La señal
  // ahora vive dentro de `ProjectionDashboardInner` (ver el effect que
  // dispara cuando `activeRunIsPlaceholder` cae a false). El cap duro de
  // App garantiza que el splash nunca se cuelga si el run falla.

  if (!source || !scenarioRunCacheReady) {
    return <ProjectionWarmupShell />;
  }

  return <ProjectionDashboardInner {...props} today={today} source={source} />;
}

// Coalesce concurrent warmup calls. Boot waves (cxp/cobranza/compras/payroll
// hidratan incrementalmente) re-disparan el effect con `props` ref nuevo,
// pero el warmup en vuelo ya cubre la misma `source`. Sin esta guard cada
// wave spawneaba un `new Worker(...)` adicional → 3-5 worker scripts en cola
// de Vite dev → todos quedan pending → spinner infinito + OOM (Aw Snap 5).
let warmupInflight: Promise<void> | null = null;
let warmupInflightSource: FinancialProjectionSourceData | null = null;

async function preloadProjectionScenarioRuns(input: {
  source: FinancialProjectionSourceData;
  props: Props;
  today: string;
}): Promise<void> {
  // Misma `source` ya en vuelo → reusar promesa (no spawnear otro worker).
  if (warmupInflight && warmupInflightSource === input.source) {
    return warmupInflight;
  }
  // Diferente source pero hay uno en vuelo → esperar a que termine antes
  // de spawnear el nuevo, para no apilar workers en la cola de Vite.
  const prior = warmupInflight;
  warmupInflightSource = input.source;
  const promise = (async () => {
    if (prior) {
      try { await prior; } catch { /* prior failure shouldn't block us */ }
    }
    await runPreloadProjectionScenarioRuns(input);
  })();
  warmupInflight = promise;
  try {
    await promise;
  } finally {
    if (warmupInflight === promise) {
      warmupInflight = null;
      warmupInflightSource = null;
    }
  }
}

async function runPreloadProjectionScenarioRuns(input: {
  source: FinancialProjectionSourceData;
  props: Props;
  today: string;
}): Promise<void> {
  const { source, props, today } = input;
  const sourceBaseScenario = source.scenarios.find((scenario) => scenario.kind === 'BASE') ?? source.scenarios[0];
  const bootstrap = ensureCoreScenarios({
    storedScenarios: loadPlanningScenarios([]),
    storedAdjustments: loadPlanningAdjustments([]),
    manualEntries: loadManualPlanningEntries([]),
    customRows: loadCustomRows([]),
    cellOverrides: loadCellOverrides([]),
    changeLog: loadChangeLog([]),
    sourceBaseScenario,
    user: 'tesoreria@senda.local',
  });
  if (bootstrap.changed) {
    savePlanningScenarios(bootstrap.scenarios);
    savePlanningAdjustments(bootstrap.adjustments);
    saveManualPlanningEntries(bootstrap.manualEntries);
    saveCustomRows(bootstrap.customRows);
    saveCellOverrides(bootstrap.cellOverrides);
    saveChangeLog(bootstrap.changeLog);
  }
  const baseScenario = bootstrap.scenarios.find((scenario) => scenario.id === BASE_SCENARIO_ID && scenario.kind === 'BASE') ?? sourceBaseScenario;
  const approvedScenario = bootstrap.scenarios.find((scenario) => scenario.id === APPROVED_SCENARIO_ID && scenario.kind === 'APPROVED' && !scenario.archivedAt)
    ?? bootstrap.scenarios.find((scenario) => scenario.kind === 'APPROVED' && !scenario.archivedAt)
    ?? baseScenario;
  // Ventana = año natural en curso (1-ene → hoy+12m). El tramo histórico
  // (1-ene → hoy) hace que Proyección muestre los meses previos igual que
  // el antiguo Dashboard; el forward de 364 días se conserva.
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const yearEnd = addUtcDays(today, 364);
  const taxStore = loadTaxStore(defaultTaxStore());
  const initialCash = calculateInitialCash(props.bankStatements, props.startingBalance, { companyCode: props.companyCode });
  const supplierInitialCash = calculateCurrentBankCash(props.bankStatements, props.companyCode, initialCash);
  const minimumCash = minimumCashFor();
  const sharedInputsKey = [
    fingerprintArray(source.movements, (m) => m.id + ':' + (m.adjustedAmount ?? m.projectedAmount)),
    fingerprintArray(bootstrap.adjustments, (a) => a.id + ':' + a.status + ':' + a.createdAt),
    fingerprintArray(bootstrap.manualEntries, (m) => m.id + ':' + (m.updatedAt ?? m.createdAt ?? '')),
    [
      fingerprintArray(taxStore.obligations, (o) => o.id + ':' + o.pendingAmount + ':' + o.status + ':' + o.paymentPlan.length),
      fingerprintArray(taxStore.adjustments, (a) => a.id + ':' + a.kind + ':' + a.amount + ':' + a.createdAt),
      fingerprintArray(taxStore.taxRateOverrides, (r) => r.targetType + ':' + r.targetKey + ':' + r.rate + ':' + r.updatedAt),
      taxStore.overdueBalance,
    ].join(':'),
    fingerprintArray(props.providers, (provider) => provider.id + ':' + (provider.score ?? '') + ':' + (provider.lastUpdatedAt ?? '')),
    yearStart,
    yearEnd,
    today,
    initialCash,
    supplierInitialCash,
    minimumCash,
  ].join('|');

  let seededPlaceholder = false;
  await Promise.all([baseScenario, approvedScenario].map(async (scenario) => {
    const scenarioCustomRows = bootstrap.customRows.filter((row) => row.scenarioId === scenario.id);
    const scenarioOverrides = bootstrap.cellOverrides.filter((override) => override.scenarioId === scenario.id);
    const customKey = fingerprintArray(scenarioCustomRows, (row) => row.id + ':' + (row.updatedAt ?? ''));
    const overrideKey = fingerprintArray(scenarioOverrides, (override) => override.conceptKey + '@' + override.bucketKey + ':' + override.value);
    const cacheKey = [sharedInputsKey, scenario.id, 'monthly', customKey, overrideKey].join('||');
    const cached = await loadScenarioRunFromPersistentCache(cacheKey);
    if (cached) {
      primeProjectionRunCache(cacheKey, cached);
      // Persisted run = a valid ScenarioForecastRun shape → use it as the
      // universal placeholder so the first Inner render never has to run the
      // ~225k pipeline synchronously on the main thread (the "no abrió" freeze).
      setScenarioRunPlaceholder(cached);
      seededPlaceholder = true;
    }
  }));

  // Cold path (no persisted run for the current inputs — e.g. the compras
  // window changed the cache key). Build the *light* BASE run in the scenario
  // worker (off the main thread) and seed the placeholder, so the shell stays
  // up for the few worker seconds instead of the tab freezing/OOM-ing.
  if (!seededPlaceholder && typeof Worker !== 'undefined') {
    try {
      const baseArgs: BuildScenarioForecastRunArgs = {
        scenarioId: baseScenario.id,
        scenarioName: baseScenario.name ?? baseScenario.id,
        scenarioKind: 'BASE',
        sourceMovements: source.movements,
        adjustments: [],
        manualEntries: [],
        customRows: [],
        overrides: [],
        clients: props.clients,
        providers: props.providers,
        assumptions: props.assumptions,
        cxpRecords: props.cxpRecords,
        purchaseReceipts: props.purchaseReceipts,
        payrollCosts: props.payrollCosts,
        cobranzaPayments: props.cobranzaPayments,
        budget: props.budget,
        companyCode: props.companyCode,
        taxStore,
        startDate: yearStart,
        endDate: yearEnd,
        today,
        initialCash,
        supplierInitialCash,
        minimumCash,
        granularity: 'monthly',
        includeManualEntries: false,
      };
      const heavyKeys = [
        'sourceMovements', 'clients', 'providers', 'cxpRecords',
        'purchaseReceipts', 'payrollCosts', 'cobranzaPayments', 'bajioStatements',
      ] as const;
      const heavy: Record<string, unknown> = {};
      const light: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(baseArgs)) {
        if ((heavyKeys as readonly string[]).includes(k)) heavy[k] = v;
        else light[k] = v;
      }
      const worker = new Worker(
        new URL('../../../workers/scenarioForecastRun.worker.ts', import.meta.url),
        { type: 'module' },
      );
      await new Promise<void>((resolve) => {
        const done = (() => {
          let settled = false;
          return () => { if (settled) return; settled = true; worker.terminate(); resolve(); };
        })();
        const timeout = setTimeout(done, 20_000);
        worker.onmessage = (event: MessageEvent<ScenarioForecastRunWorkerResponse>) => {
          clearTimeout(timeout);
          if (event.data.result) setScenarioRunPlaceholder(event.data.result);
          done();
        };
        worker.onerror = () => { clearTimeout(timeout); done(); };
        const req: ScenarioForecastRunWorkerRequest = {
          jobId: 1,
          cacheKey: 'warmup:base',
          scenarioId: baseScenario.id,
          sourceVersion: 0,
          pipelineKey: 'warmup:base:pipeline',
          heavy: heavy as ScenarioForecastRunWorkerRequest['heavy'],
          light: light as ScenarioForecastRunWorkerRequest['light'],
        };
        worker.postMessage(req);
      });
    } catch {
      /* best-effort: if the warm build fails, runCached falls back as before */
    }
  }
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
  // Off-main-thread scenario pipeline (see useScenarioRunWorker). Cache hit =
  // sync (unchanged); miss = worker + stale-while-recompute, no main-thread freeze.
  const { runCached, runVersion } = useScenarioRunWorker();
  // projectionRunCache is module-level — survives this component's unmount.
  // Without this cleanup, MAX_ENTRIES fat ScenarioForecastRun objects (full
  // post-pipeline movements arrays) stay pinned for the whole SPA session if
  // the user never enters Planning. Mirror FinancialPlanningDashboard.tsx:455.
  useEffect(() => () => clearProjectionRunCache(), []);
  // Projection window is granularity-aware — defined just below, after
  // `deferredGranularity`. Monthly keeps the natural-year span (merged
  // Dashboard history + 12mo forward); weekly/daily are bounded to a near
  // window so the month→week→day flip can't blow up to ~365-730 buckets ×
  // scenarios and OOM the renderer (Chrome "Aw Snap" code 5).

  const [storedScenarios, setStoredScenarios] = useState<FinancialScenario[]>(() => loadPlanningScenarios([]));
  const [storedAdjustments, setStoredAdjustments] = useState<FinancialAdjustment[]>(() => loadPlanningAdjustments([]));
  const [manualEntries, setManualEntries] = useState<ManualPlanningEntry[]>(() => loadManualPlanningEntries([]));
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
  const bootstrap = useMemo(
    () => ensureCoreScenarios({
      storedScenarios,
      storedAdjustments,
      manualEntries,
      customRows,
      cellOverrides,
      changeLog,
      sourceBaseScenario,
      user: 'tesoreria@senda.local',
    }),
    [storedScenarios, storedAdjustments, manualEntries, customRows, cellOverrides, changeLog, sourceBaseScenario],
  );

  useEffect(() => {
    if (!bootstrap.changed) return;
    setStoredScenarios(bootstrap.scenarios);
    setStoredAdjustments(bootstrap.adjustments);
    setManualEntries(bootstrap.manualEntries);
    setCustomRows(bootstrap.customRows);
    setCellOverrides(bootstrap.cellOverrides);
    setChangeLog(bootstrap.changeLog);
  }, [bootstrap]);

  const baseScenario = bootstrap.scenarios.find((scenario) => scenario.id === BASE_SCENARIO_ID && scenario.kind === 'BASE')
    ?? sourceBaseScenario;
  const approvedScenario = bootstrap.scenarios.find((scenario) => scenario.id === APPROVED_SCENARIO_ID && scenario.kind === 'APPROVED' && !scenario.archivedAt)
    ?? bootstrap.scenarios.find((scenario) => scenario.kind === 'APPROVED' && !scenario.archivedAt)
    ?? baseScenario;
  const drafts = useMemo(
    () => bootstrap.scenarios.filter((scenario) => scenario.kind === 'DRAFT' && !scenario.archivedAt),
    [bootstrap.scenarios],
  );
  const scenarios = useMemo(
    () => [baseScenario, approvedScenario, ...drafts],
    [baseScenario, approvedScenario, drafts],
  );

  // Active scenario comes from the global header selector (provider mounted
  // in the app shell). Standalone falls back to local state.
  const scenarioCtx = useScenarioSelection();
  const [localScenarioId, setLocalScenarioId] = useState<string>(approvedScenario.id);
  const activeScenarioId = scenarioCtx?.activeScenarioId ?? localScenarioId;
  const setActiveScenarioId = scenarioCtx?.setActiveScenarioId ?? setLocalScenarioId;
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

  // Granularity-aware window (mirrors FinancialPlanningDashboard). Monthly =
  // natural year (Jan 1 → today+364, ~24 monthly buckets — the default
  // landing view, unchanged). Weekly/daily over that full span = up to
  // ~365-730 buckets × scenarios × full pipeline → renderer OOM on the
  // month→week→day flip. Bound the sub-month views to a near window: still
  // useful, computes/renders safely. Uses deferredGranularity so the window
  // tracks the same value the scenario runs key on (cache-key consistency).
  const { yearStart, yearEnd } = useMemo(
    () => projectionWindowFor(today, deferredGranularity),
    [today, deferredGranularity],
  );

  useEffect(() => {
    if (!scenarios.some((s) => s.id === activeScenarioId)) {
      setActiveScenarioId(approvedScenario.id);
    }
  }, [scenarios, activeScenarioId, approvedScenario.id, setActiveScenarioId]);

  // Keep the global header selector list in sync (drafts created in
  // Planeación show up here too).
  const registerScenarios = scenarioCtx?.registerScenarios;
  useEffect(() => {
    registerScenarios?.(scenarios);
  }, [registerScenarios, scenarios]);

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
      const scenario = scenarios.find((item) => item.id === scenarioId);
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
      // pipelineKey omits granularity so two requests differing only in gran
      // share the worker's pipeline cache → grain flip = aggregator only.
      const pipelineKey = [
        sharedInputsKey,
        scenarioId,
        customKey,
        overrideKey,
      ].join('||');

      const persistRun = (scenarioId === baseScenario.id || scenarioId === approvedScenario.id)
        ? (key: string, run: ScenarioRun) => saveScenarioRunToPersistentCache(key, run)
        : undefined;
      return runCached<ScenarioRun>(
        cacheKey,
        scenarioId,
        () => ({
          scenarioId,
          scenarioName,
          scenarioKind: scenario?.kind ?? 'DRAFT',
          sourceMovements: source.movements,
          adjustments: storedAdjustments,
          manualEntries,
          customRows: scenarioCustomRows,
          overrides: scenarioOverrides,
          clients: props.clients,
          providers: props.providers,
          assumptions: props.assumptions,
          cxpRecords: props.cxpRecords,
          purchaseReceipts: props.purchaseReceipts,
          payrollCosts: props.payrollCosts,
          cobranzaPayments: props.cobranzaPayments,
          budget: props.budget,
          companyCode: props.companyCode,
          taxStore,
          startDate: yearStart,
          endDate: yearEnd,
          today,
          initialCash,
          supplierInitialCash,
          minimumCash,
          granularity: gran,
        }),
        persistRun,
        pipelineKey,
      );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sharedInputsKey,
    scenarioNameById,
    scenarios,
    baseScenario.id,
    approvedScenario.id,
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
    runVersion,
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
  // runCached may serve a cross-scenario placeholder (warmup-seeded Base run)
  // while the real scenario compute is in-flight. Detect it so we render a
  // loading state instead of showing Base data labeled as Approved/Draft.
  const activeRunIsPlaceholder = activeRun.scenarioId !== activeScenarioId;
  // Signal the splash gate now that we have a REAL per-scenario run (not the
  // cross-scenario placeholder). Latched + idempotent: only the first
  // non-placeholder paint fires; subsequent renders no-op.
  useEffect(() => {
    if (!activeRunIsPlaceholder) signalProjectionFirstPaint();
  }, [activeRunIsPlaceholder]);
  const comparisonRun = useMemo(() => {
    if (!comparisonScenarioId) return null;
    if (comparisonScenarioId === baseScenario.id) return baseRun;
    if (comparisonScenarioId === activeScenarioId) return activeRun;
    return buildRun(comparisonScenarioId, deferredGranularity);
  }, [buildRun, comparisonScenarioId, baseScenario.id, baseRun, activeScenarioId, activeRun, deferredGranularity]);

  // Granularity pre-warm REMOVED (was the crash users hit ~2.5s after
  // Proyección mounts). It called buildRun(activeScenarioId, 'daily'|'weekly')
  // while the projection window stays the MONTHLY one (Jan 1 → today+364), so
  // it computed a *daily* projection over a ~365-730 day span → renderer OOM
  // ("Aw Snap code 5"). The on-demand granularity switch is already
  // non-freezing (worker offload + F1.8 gran-bounded window). Do NOT
  // reintroduce a pre-warm unless it passes a gran-bounded window into
  // buildRun — speculatively warming daily over the year is the bomb.

  // KPIs.
  const summary = activeRun.summary;
  const comparisonReference = comparisonRun ? comparisonRun.summary.finalCash : baseRun.summary.finalCash;
  const finalCashDelta = summary.finalCash - comparisonReference;
  const comparisonLabel = comparisonRun ? comparisonRun.name : baseRun.name;
  const probabilistic = useProbabilisticForecast(activeRun, summary.minimumCashRequired);

  // Rescatado del Dashboard: piso operativo + YTD del año en curso. El YTD
  // sale del MISMO scenario-run que el chart → reconcilia exacto.
  const currentYm = useMemo(() => today.slice(0, 7), [today]);
  const currentYear = useMemo(() => Number(today.slice(0, 4)), [today]);
  const minimumExpense = useMemo(
    () => computeMinimumOperatingExpense(props.providers, null, props.payrollMonthlyActualJDE),
    [props.providers, props.payrollMonthlyActualJDE],
  );
  const ytd = useMemo(
    () => computeRunYtd(activeRun, currentYm, currentYear),
    [activeRun, currentYm, currentYear],
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
            <ForecastModelSelector
              value={props.forecastModelId}
              onChange={props.onForecastModelChange}
              summary={props.forecastSummary}
            />
            <SegmentedControl
              value={granularity}
              options={GRANULARITY_OPTIONS}
              onChange={setGranularity}
              pending={granularityPending}
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

      <ScenarioComparisonBar
        scenarios={scenarios}
        activeScenarioId={activeScenarioId}
        activeName={scenarios.find((s) => s.id === activeScenarioId)?.name ?? activeRun.name}
        activeFinalCash={activeRunIsPlaceholder ? 0 : summary.finalCash}
        comparisonScenarioId={comparisonScenarioId}
        comparisonName={comparisonRun?.name ?? null}
        comparisonFinalCash={comparisonRun?.summary.finalCash ?? null}
        baseName={baseRun.name}
        baseFinalCash={baseRun.summary.finalCash}
        onChangeComparison={(id) => startTransition(() => setComparisonScenarioId(id))}
      />

      {activeRunIsPlaceholder && (
        <div className="rounded-xl border border-[var(--gray-200)] bg-white px-4 py-8 text-center text-[13px] text-[var(--gray-600)]">
          <div className="inline-flex items-center gap-2">
            <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-[var(--accent-blue)]" />
            Cargando proyección de "{scenarios.find((s) => s.id === activeScenarioId)?.name ?? activeScenarioId}"…
          </div>
        </div>
      )}

{!activeRunIsPlaceholder && <>
      {/* Daily-scan KPIs rescatados del Dashboard: YTD del año en curso +
          piso operativo. Mismo scenario-run que el chart. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label={`Ingresos YTD ${currentYear}`}
          value={fmtCurrency(ytd.ingresosYtd)}
          icon={<TrendingUp className="w-4 h-4" strokeWidth={1.5} />}
          color="var(--tone-success, var(--success))"
          sublabel={ytd.monthsElapsed > 0 ? `${fmtCompact(ytd.ingresosAvgMonth)} / mes promedio` : undefined}
          breakdown={ytd.monthsElapsed > 0 ? [
            { label: 'Meses transcurridos', value: String(ytd.monthsElapsed) },
            { label: 'Margen neto', value: `${(ytd.margenYtd * 100).toFixed(1)}%`, valueColor: toneByDelta(ytd.margenYtd) },
          ] : undefined}
          onClick={() => goTo({ tab: 'collections', focus: 'ingresos-ytd' })}
          navHint="Ver detalle de cobranza"
        />
        <KpiCard
          label={`Egresos YTD ${currentYear}`}
          value={fmtCurrency(ytd.egresosYtd)}
          icon={<TrendingDown className="w-4 h-4" strokeWidth={1.5} />}
          color="var(--tone-danger, var(--danger))"
          sublabel={ytd.monthsElapsed > 0 ? `${fmtCompact(ytd.egresosAvgMonth)} / mes promedio` : undefined}
          breakdown={ytd.monthsElapsed > 0 ? [
            { label: 'Vs Ingresos', value: `${ytd.ingresosYtd > 0 ? ((ytd.egresosYtd / ytd.ingresosYtd) * 100).toFixed(1) : '—'}%` },
            { label: 'Flujo neto YTD', value: fmtCompact(ytd.flujoNetoYtd), valueColor: toneByDelta(ytd.flujoNetoYtd) },
          ] : undefined}
          onClick={() => goTo({ tab: 'cxp', focus: 'egresos-ytd' })}
          navHint="Ver Antigüedad de Saldo"
        />
        <KpiCard
          label="Caja actual"
          value={fmtCurrency(ytd.cajaActual)}
          icon={<Wallet className="w-4 h-4" strokeWidth={1.5} />}
          color={toneByFloor(ytd.cajaActual, minimumExpense.totalMonthly)}
          sublabel={ytd.cajaInicial !== 0
            ? `${ytd.cajaDelta >= 0 ? '+' : ''}${fmtCompact(ytd.cajaDelta)} vs inicial (${(ytd.cajaDeltaPct * 100).toFixed(1)}%)`
            : undefined}
          breakdown={[
            { label: 'Caja inicial año', value: fmtCompact(ytd.cajaInicial) },
            {
              label: 'Runway aprox.',
              value: minimumExpense.totalMonthly > 0
                ? `${(ytd.cajaActual / minimumExpense.totalMonthly).toFixed(1)} meses`
                : '—',
              valueColor: toneByFloor(ytd.cajaActual / Math.max(1, minimumExpense.totalMonthly), 3),
            },
          ]}
          onClick={() => goTo({ tab: 'financialPlanning', focus: 'caja-actual' })}
          navHint="Abrir Planeación"
        />
        <MinimumExpenseKpi
          monthly={minimumExpense.totalMonthly}
          annual={minimumExpense.totalAnnual}
          providersMonthly={minimumExpense.providersMonthly}
          payrollMonthly={minimumExpense.payrollMonthly}
          criticalCount={minimumExpense.criticalCount}
        />
      </div>

      {/* KPIs forward propios de Proyección. */}
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

      {/* Cobranza ↔ bancos: solo cuando hay datos JDE + abonos cargados. */}
      {props.cobranzaReconciliation && props.cobranzaReconciliation.summary.totalAbonos > 0 && (
        <CobranzaKpiCard reconciliation={props.cobranzaReconciliation} />
      )}

      <DeferredMount delayMs={60} fallback={<ChartSkeleton />}>
        <CashFlowChart
          projection={activeRun}
          baseProjection={activeRun.scenarioId === baseRun.scenarioId ? undefined : baseRun}
          comparisonProjection={comparisonRun ?? undefined}
          probabilisticProjection={probabilistic.run}
          onNavigateToTax={props.onNavigateToTax}
          operatingFloor={deferredGranularity === 'monthly' ? minimumExpense.totalMonthly : undefined}
        />
      </DeferredMount>
      </>}

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

function ForecastModelSelector({
  value,
  onChange,
  summary,
}: {
  value?: ForecastModelId;
  onChange?: (id: ForecastModelId) => void;
  summary?: ForecastOutput;
}) {
  if (!value || !onChange) return null;
  const totalForecasted = summary?.receipts.reduce((s, r) => s + r.amountMxn, 0) ?? 0;
  const providersCount = summary?.perProvider.length ?? 0;
  return (
    <div className="inline-flex h-10 items-stretch overflow-hidden rounded-xl border border-[var(--gray-200)] bg-white">
      <label
        className="flex items-center px-3 text-[11px] font-medium uppercase tracking-wide text-[var(--gray-400)]"
        htmlFor="forecast-model-selector"
      >
        Modelo OC
      </label>
      <select
        id="forecast-model-selector"
        value={value}
        onChange={(e) => onChange(e.target.value as ForecastModelId)}
        className="border-l border-[var(--gray-200)] bg-transparent px-3 text-[12px] font-medium text-[var(--gray-700)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/20"
        title={`${providersCount} proveedores · forecast total ${fmtCompact(totalForecasted)} (12m)`}
      >
        {FORECAST_MODELS.map((m) => (
          <option key={m.id} value={m.id} title={m.description}>{m.label}</option>
        ))}
      </select>
    </div>
  );
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
