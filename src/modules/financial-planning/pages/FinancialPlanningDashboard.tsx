import { lazy, startTransition, Suspense, useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
  nextSourceJobId,
  postToSharedSourceWorker,
  subscribeSharedSourceWorker,
} from '../../shared-finance/services/sharedSourceWorker';
import { AlertTriangle, CheckCircle2, Copy, Download, Eye, Trash2, Wallet, AlertTriangle as AlertIcon, TrendingUp } from 'lucide-react';
import type { Budget } from '../../../domain/budget';
import { computeMinimumOperatingExpense } from '../../../domain/minimumOperatingExpense';
import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import type { CobranzaPayment, CobranzaRecord, RolRecord, ViajeEspecialRecord } from '../../../services/jdeTypes';
import type { AuxiliarReconResult } from '../../../domain/auxiliarReconciliationEngine';
import type { CxpPaymentCoverage } from '../../../domain/paymentReconciliationEngine';
import { fmtCompact, fmtCurrency, todayISO } from '../../../formatters';
import {
  bucketKeyForDate,
  bucketLabel as engineBucketLabel,
  buildBucketDates,
  effectiveAmount,
  effectiveMovementDate,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type {
  CellOverride,
  FinancialAdjustment,
  FinancialMovement,
  FinancialMovementCategory,
  FinancialMovementType,
  FinancialScenario,
  ManualPlanningEntry,
  PayrollCostRecord,
  PlanningCustomRow,
  ProjectionGranularity,
  PurchaseReceiptRecord,
  ScenarioChangeLogEntry,
} from '../../shared-finance/types';
import { ScenarioTabs } from '../components/ScenarioTabs';
import { AddRowPopover } from '../components/AddRowPopover';
import { ChangeLogDrawer } from '../components/ChangeLogDrawer';
import { MergeDialog } from '../components/MergeDialog';
import { applyMerge, buildMergeDiff, type MergeDiffEntry } from '../services/scenarioMerge';
import {
  PLANNING_DEFAULT_GRANULARITY,
  planningRunCacheKey,
  planningSharedRunInputsKey,
  planningWindowFor,
} from '../services/planningRunCacheKey';
import { FirstSimulationNudge } from '../components/FirstSimulationNudge';
import { MovementPickerModal } from '../components/MovementPickerModal';
import { AdjustmentEditorPopover } from '../components/AdjustmentEditorPopover';
import { clearProjectionRunCache, fingerprintArray, primeProjectionRunCache } from '../../financial-projection/services/projectionCache';
import { clearProjectionSourceCache } from '../../financial-projection/services/financialProjectionService';
import { onMemoryPressure } from '../../../services/runtimeGuardian';
import { downloadFile, toCSV } from '../../../utils/export';
import SourceInfo from '../../../components/ui/SourceInfo';
import { attributeMovementId, sourceCsvFields } from '../../../domain/sourceAttribution';
import { useScenarioRunWorker } from '../../shared-finance/hooks/useScenarioRunWorker';
import { CellDetailPopover, type CellDetailData } from '../components/CellDetailPopover';
import { SpreadsheetGrid } from '../components/spreadsheet/SpreadsheetGrid';
import { BucketColumn } from '../components/spreadsheet/gridGeometry';
import {
  buildFinancialProjectionSourceData,
  calculateCurrentBankCash,
  calculateInitialCash,
  rememberFinancialProjectionSourceData,
  tryGetCachedFinancialProjectionSourceData,
  type FinancialProjectionSourceData,
} from '../../financial-projection/services/financialProjectionService';
import {
  loadProjectionSourceFromPersistentCache,
  loadScenarioRunFromPersistentCache,
  saveProjectionSourceToPersistentCache,
  saveScenarioRunToPersistentCache,
} from '../../financial-projection/services/financialProjectionPersistentCache';
import {
  defaultTaxStore,
  loadTaxStore,
  TAX_STORE_CHANGED_EVENT,
  TAX_STORE_KEY,
} from '../../taxes/services/taxModuleService';
import {
  loadManualPlanningEntries,
  saveManualPlanningEntries,
} from '../services/manualPlanningEntries';
import {
  loadPlanningAdjustments,
  loadPlanningScenarios,
  savePlanningAdjustments,
  savePlanningScenarios,
} from '../services/financialPlanningStorage';
import { loadCellOverrides, saveCellOverrides } from '../services/cellOverridesStorage';
import { reconcilePlanningAgainstBank } from '../services/cashFlowBankReconciliation';
import { buildCustomConceptKey, loadCustomRows, saveCustomRows } from '../services/customRowsStorage';
import { loadChangeLog, saveChangeLog } from '../services/changeLogStorage';
import { hydratePlanningFromServer } from '../services/planningRemoteSync';
import { debouncedPersist } from '../services/debouncedPersist';
import {
  describeAddRow,
  describeClearCell,
  describeEditCell,
  describeOverridePayload,
  newChangeLogEntry,
} from '../services/changeLogTemplates';
import { APPROVED_SCENARIO_ID, BASE_SCENARIO_ID, ensureCoreScenarios } from '../services/scenarioBootstrap';
import { conceptKeyForMovement, buildPlanningRows } from '../services/planningRowTaxonomy';
import { createNewDraft, duplicateDraft } from '../services/scenarioDuplicate';
import { type ScenarioForecastRun } from '../services/scenarioForecastRun';
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
import type { MidasProposalSuggestion } from '../../midas-ai';
import { createFinancialAdjustment } from '../services/financialPlanningService';

interface Props {
  companyCode: string;
  bankStatements: BankAccountStatement[];
  clients: Client[];
  providers: Provider[];
  cxpRecords: CXPRecord[];
  cxpPaymentCoverage?: Map<string, CxpPaymentCoverage>;
  cobranzaRecords?: CobranzaRecord[];
  cobranzaPayments?: CobranzaPayment[];
  /** Cruce AuxiliarContable ↔ banco — alimenta facturas cobradas / CXPs pagadas. */
  auxiliarReconciliation?: AuxiliarReconResult;
  /** ROL CITI: viajes ejecutados → ingreso futuro proyectado (Aprobado). */
  rolRecords?: RolRecord[];
  /** Viajes Especiales: ingresos especiales con factura/UUID propios. */
  viajesEspecialesRecords?: ViajeEspecialRecord[];
  purchaseReceipts?: PurchaseReceiptRecord[];
  payrollCosts?: PayrollCostRecord[];
  assumptions: CashFlowAssumptions;
  budget: Budget | null;
  startingBalance?: number;
  /**
   * Estados de cuenta Bajío (fideicomiso Dina). Llegan SEPARADOS porque
   * `bankStatements` ya viene sin Bajío (excludeBajio). Se usan para
   * re-inyectar el flujo del fideicomiso en escenarios no-base.
   */
  bajioStatements?: BankAccountStatement[];
  /**
   * Costo real de nómina del mes en curso (TRESS). Entra al piso operativo que
   * define el umbral de "Días en déficit" — mismo contrato que Proyección.
   */
  payrollMonthlyActualJDE?: number;
}

const USER = 'tesoreria@senda.local';
type PlanningScenarioRun = ScenarioForecastRun;
type SelectedPlanningCell = { conceptKey: string; bucketKey: string } | null;

const MovementDrillDownDrawer = lazy(() =>
  import('../../financial-projection/components/MovementDrillDownDrawer').then((module) => ({ default: module.MovementDrillDownDrawer })),
);
const MidasBubble = lazy(() =>
  import('../../midas-ai').then((module) => ({ default: module.MidasBubble })),
);

/**
 * Outer entry — gates the heavy planning pipeline behind a paint.
 *
 * The inner dashboard runs `buildFinancialProjectionSourceData` plus 3+
 * `buildScenarioRun` passes synchronously on mount. On a real catalog that
 * blocks the main thread for hundreds of ms — long enough that the user
 * never sees the Suspense skeleton between tabs (the lazy chunk resolves
 * synchronously after first navigation, so React skips the fallback and
 * commits the heavy mount in one frame).
 *
 * Mirrors `FinancialProjectionDashboard`'s pattern: cheap cache probe on
 * the first render, `DashboardLoadingShell` while we wait, idle-scheduled
 * canonical build, then mount the inner once `source` is ready.
 */
export default function FinancialPlanningDashboard(props: Props) {
  const today = useMemo(() => todayISO(), []);

  const cacheProbeInput = useMemo(
    // Planeación consume la misma fuente predictiva que el Dashboard; las reglas
    // de tesorería se aplican después en el pipeline compartido de escenarios.
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
      props.auxiliarReconciliation,
      props.rolRecords,
      props.viajesEspecialesRecords,
      props.purchaseReceipts,
      props.payrollCosts,
      props.assumptions,
      props.budget,
      props.startingBalance,
      today,
    ],
  );

  const cachedSource = useMemo(
    () => tryGetCachedFinancialProjectionSourceData(cacheProbeInput),
    [cacheProbeInput],
  );

  const [source, setSource] = useState<FinancialProjectionSourceData | null>(cachedSource);

  // PERF (2026-05-14): el build de source corría sync en idle callback
  // pinaba el thread varios segundos con data real (142k records) → "page
  // unresponsive" y crash del renderer. Ahora vive en Web Worker; UI muestra
  // PlanningWarmupShell mientras el worker computa. Fallback sync si Worker
  // no está disponible o falla.
  const sourceJobRef = useRef(0);
  // Per-job input map so the shared-worker listener uses the input that
  // produced THIS jobId (not whatever cacheProbeInput is current at result time).
  const sourceInputByJobId = useRef<Map<number, typeof cacheProbeInput>>(new Map());
  useEffect(() => {
    if (cachedSource) {
      setSource(cachedSource);
      return;
    }
    let cancelled = false;
    const jobId = nextSourceJobId();
    sourceJobRef.current = jobId;
    sourceInputByJobId.current.set(jobId, cacheProbeInput);

    const runSyncFallback = () => {
      const t0 = performance.now();
      try {
        const built = buildFinancialProjectionSourceData(cacheProbeInput);
        if (!cancelled && sourceJobRef.current === jobId) {
          saveProjectionSourceToPersistentCache(cacheProbeInput, built);
          setSource(built);
        }
      } catch (err) {
        console.warn('[planning.source] sync fallback failed', err);
      }
      // eslint-disable-next-line no-console
      console.info(`[planning.source] sync fallback ${(performance.now() - t0).toFixed(0)}ms`);
    };

    const startWorker = () => {
      // eslint-disable-next-line no-console
      console.info(`[planning.source] requesting jobId=${jobId} cxp=${cacheProbeInput.cxpRecords.length} cobranza=${cacheProbeInput.cobranzaRecords?.length ?? 0} rol=${cacheProbeInput.rolRecords?.length ?? 0} payroll=${cacheProbeInput.payrollCosts?.length ?? 0}`);

      if (typeof Worker === 'undefined') {
        runSyncFallback();
        return;
      }
      // Singleton worker shared with Projection + useFinancialProjectionSource.
      const ok = postToSharedSourceWorker({ jobId, input: cacheProbeInput });
      if (!ok) runSyncFallback();
    };

    void (async () => {
      const persisted = await loadProjectionSourceFromPersistentCache(cacheProbeInput);
      if (cancelled || sourceJobRef.current !== jobId) return;
      if (persisted) {
        // eslint-disable-next-line no-console
        console.info(`[planning.source] persistent cache hit jobId=${jobId}`);
        rememberFinancialProjectionSourceData(cacheProbeInput, persisted);
        setSource(persisted);
        return;
      }
      startWorker();
    })();

    return () => { cancelled = true; };
  }, [cachedSource, cacheProbeInput]);

  // Subscribe to shared source worker; filter by per-job input map.
  useEffect(() => {
    const unsub = subscribeSharedSourceWorker((data) => {
      const myInput = sourceInputByJobId.current.get(data.jobId);
      if (!myInput) return;
      sourceInputByJobId.current.delete(data.jobId);
      if (data.jobId !== sourceJobRef.current) return;
      if (data.result) {
        // eslint-disable-next-line no-console
        console.info(`[planning.source] worker result jobId=${data.jobId}`);
        rememberFinancialProjectionSourceData(myInput, data.result);
        saveProjectionSourceToPersistentCache(myInput, data.result);
        setSource(data.result);
      } else if (data.error) {
        // eslint-disable-next-line no-console
        console.warn(`[planning.source] worker error`, data.error);
      }
    });
    return () => {
      unsub();
      sourceInputByJobId.current.clear();
    };
  }, []);

  const [scenarioRunCacheReady, setScenarioRunCacheReady] = useState(false);
  // `props` is a fresh object every parent (App) render — App re-renders
  // often (bank-refresh pill, useDeferredValue settling, debounced autosave)
  // even while the user is idle. Depending the preload effect on `props`
  // re-ran the whole heavy preload (6× localStorage JSON.parse +
  // ensureCoreScenarios + fingerprintArray over ~142k movements + IDB read)
  // on every one of those renders → perpetual "Cargando" + GC pressure that
  // OOMs the renderer after a few minutes (Chrome "Aw Snap" code 5). Read
  // props through a ref and gate the effect on the stable, App-memoized
  // fields the preload actually consumes.
  const latestProps = useRef(props);
  latestProps.current = props;
  useEffect(() => {
    if (!source) {
      setScenarioRunCacheReady(false);
      return;
    }
    let cancelled = false;
    setScenarioRunCacheReady(false);
    void (async () => {
      await preloadPlanningScenarioRuns({
        source,
        props: latestProps.current,
        today,
      });
      if (!cancelled) setScenarioRunCacheReady(true);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    source,
    today,
    props.bankStatements,
    props.startingBalance,
    props.companyCode,
    props.providers,
    props.bajioStatements,
  ]);

  // Segundo paint gate: una vez `source` está listo, esperamos un frame
  // adicional antes de montar el inner. El inner corre 2-3 buildScenarioRun
  // SÍNCRONOS en su primer render (cada uno = applyAdjustments + taxView +
  // scheduleSupplier + calculateBaseProjection); sin este gate el browser
  // commitea el inner en el mismo frame que setSource y bloquea el main
  // thread cientos de ms — el usuario ve un freeze indistinguible de un
  // crash. Con el gate, la shell pinta primero, luego el work pesado corre,
  // y los siguientes paint los sirve el `projectionRunCache` (warm).
  const [innerReady, setInnerReady] = useState(false);
  useEffect(() => {
    if (!source || !scenarioRunCacheReady) return;
    if (innerReady) return;
    let cancelled = false;
    const fire = () => { if (!cancelled) setInnerReady(true); };
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    });
    if (typeof ric.requestIdleCallback === 'function') {
      const id = ric.requestIdleCallback(fire, { timeout: 120 });
      return () => {
        cancelled = true;
        if (typeof ric.cancelIdleCallback === 'function') ric.cancelIdleCallback(id);
      };
    }
    const raf = window.requestAnimationFrame(() => window.setTimeout(fire, 0));
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
    };
  }, [source, scenarioRunCacheReady, innerReady]);

  if (!source || !scenarioRunCacheReady || !innerReady) {
    return <PlanningWarmupShell />;
  }

  return <PlanningDashboardInner {...props} today={today} source={source} />;
}

async function preloadPlanningScenarioRuns(input: {
  source: FinancialProjectionSourceData;
  props: Props;
  today: string;
}): Promise<void> {
  const { source, props, today } = input;
  const sourceBaseScenario = source.scenarios.find((scenario) => scenario.kind === 'BASE') ?? source.scenarios[0];
  const storedScenarios = loadPlanningScenarios([]);
  const storedAdjustments = loadPlanningAdjustments([]);
  const manualEntries = loadManualPlanningEntries([]);
  const customRows = loadCustomRows([]);
  const cellOverrides = loadCellOverrides([]);
  const changeLog = loadChangeLog([]);
  const bootstrap = ensureCoreScenarios({
    storedScenarios,
    storedAdjustments,
    manualEntries,
    customRows,
    cellOverrides,
    changeLog,
    sourceBaseScenario,
    user: USER,
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
  // Ventana desde la única fuente: el precalentado la derivaba a mano y el
  // dashboard en su memo — si divergen, el warm-start queda inerte.
  const { yearStart, yearEnd } = planningWindowFor(today, PLANNING_DEFAULT_GRANULARITY);
  const taxStore = loadTaxStore(defaultTaxStore());
  const initialCash = calculateInitialCash(props.bankStatements, props.startingBalance, { companyCode: props.companyCode });
  const supplierInitialCash = calculateCurrentBankCash(props.bankStatements, props.companyCode, initialCash);
  const minimumCash = minimumCashFor(props.providers, props.payrollMonthlyActualJDE);
  const sharedRunInputsKey = planningSharedRunInputsKey({
    movements: source.movements,
    adjustments: bootstrap.adjustments,
    manualEntries: bootstrap.manualEntries,
    taxStore,
    providers: props.providers,
    cobranzaPayments: props.cobranzaPayments,
    bajioStatements: props.bajioStatements,
    auxiliarReconciliation: props.auxiliarReconciliation,
    cxpPaymentCoverage: props.cxpPaymentCoverage,
    yearStart,
    yearEnd,
    today,
    initialCash,
    supplierInitialCash,
    minimumCash,
    granularity: PLANNING_DEFAULT_GRANULARITY,
  });

  await Promise.all([baseScenario, approvedScenario].map(async (scenario) => {
    const scenarioCustomRows = bootstrap.customRows.filter((row) => row.scenarioId === scenario.id);
    const scenarioOverrides = bootstrap.cellOverrides.filter((override) => override.scenarioId === scenario.id);
    const customKey = fingerprintArray(scenarioCustomRows, (row) => row.id + ':' + (row.updatedAt ?? ''));
    const overrideKey = fingerprintArray(scenarioOverrides, (override) => `${override.conceptKey}@${override.bucketKey}:${override.value}:${override.updatedAt ?? ''}`);
    // Precalentado siempre con la granularidad default y tendencia OFF: es el
    // estado en el que abre Planeación. Base siempre corre con `trend:0` (el
    // top-off es no-base), así que su llave empata exacto; la Aprobada corre
    // con `trend:1` y se recomputa — mismo contrato que el warmup de
    // Proyección. `includeManualEntries: true` espeja los 4 call sites de
    // `buildScenarioRun`, que hoy pasan `true` sin excepción.
    const cacheKey = planningRunCacheKey({
      scenarioId: scenario.id,
      includeManualEntries: true,
      sharedRunInputsKey,
      customKey,
      overrideKey,
      trendTag: 'trend:0',
      granularity: PLANNING_DEFAULT_GRANULARITY,
    });
    const cached = await loadScenarioRunFromPersistentCache(cacheKey);
    if (cached) primeProjectionRunCache(cacheKey, cached);
  }));
}

function PlanningWarmupShell() {
  return (
    <DashboardLoadingShell
      kpis={4}
      showFilterBar
      showChart
      tableRows={4}
      label="Cargando planeación"
    />
  );
}

function PlanningDashboardInner(props: Props & { today: string; source: FinancialProjectionSourceData }) {
  const { today, source } = props;
  const goTo = useNavigateToTab();

  // projectionRunCache is a module-level LRU — it survives this component's
  // unmount. Free it when the user leaves Planning so the retained fat runs
  // don't pin renderer memory for the whole SPA session (the slow-burn cause
  // of the Chrome "Aw Snap" code 5 OOM after switching scenarios/tabs).
  useEffect(() => () => clearProjectionRunCache(), []);
  // Memory pressure handler: si runtimeGuardian detecta heap > 85%, libera
  // ambos caches (juntos ~530MB con datasets reales) para preempt Error
  // code: 5. Mismo patrón que FinancialProjectionDashboard.
  useEffect(() => {
    return onMemoryPressure(() => {
      clearProjectionRunCache();
      clearProjectionSourceCache();
    });
  }, []);

  // Off-main-thread scenario pipeline. Cache hit = sync (unchanged); miss =
  // worker + stale-while-recompute so cell edits never freeze the tab.
  const { runCached, runVersion } = useScenarioRunWorker();

  // Granularidad vía useTransition: el cambio mes/sem/día dispara recómputos
  // pesados (ventana + buckets + runs por escenario). Sin transición, clicks
  // rápidos encolaban N recómputos síncronos seriales → se trababa la UI.
  // Con transición React puede interrumpir/descartar renders intermedios y
  // sólo commitea la última selección. UNA sola fuente de verdad
  // (`granularity`) — no se parte en deferred/immediate para no arriesgar
  // bucket keys desalineadas (números financieros silenciosamente mal).
  // Default compartido con el precalentado (`planningRunCacheKey.ts`): si los
  // dos divergen, el warm-start desde IndexedDB queda inerte otra vez.
  const [granularity, setGranularityState] = useState<ProjectionGranularity>(PLANNING_DEFAULT_GRANULARITY);
  const [granularityPending, startGranularityTransition] = useTransition();
  const setGranularity = useCallback(
    (next: ProjectionGranularity) => {
      if (next === granularity) return;
      startGranularityTransition(() => setGranularityState(next));
    },
    [granularity],
  );
  // Ventana por granularidad desde la única fuente (`planningWindowFor`): el
  // precalentado arma la MISMA ventana para la granularidad default, así que
  // derivarla dos veces por concatenación era el tramo de llave que seguía
  // pudiendo desincronizarse. La regla (mensual = año natural, sub-mes =
  // ventana acotada de Proyección) está documentada ahí.
  const { yearStart, yearEnd } = useMemo(
    () => planningWindowFor(today, granularity),
    [today, granularity],
  );

  const sourceBaseScenario = useMemo(
    () => source.scenarios.find((s) => s.kind === 'BASE') ?? source.scenarios[0],
    [source.scenarios],
  );

  const [storedScenarios, setStoredScenarios] = useState<FinancialScenario[]>(() => loadPlanningScenarios([]));
  const [storedAdjustments, setStoredAdjustments] = useState<FinancialAdjustment[]>(() => loadPlanningAdjustments([]));
  const [manualEntries, setManualEntries] = useState<ManualPlanningEntry[]>(() => loadManualPlanningEntries([]));
  const [customRows, setCustomRows] = useState<PlanningCustomRow[]>(() => loadCustomRows([]));
  const [cellOverrides, setCellOverrides] = useState<CellOverride[]>(() => loadCellOverrides([]));
  const [changeLog, setChangeLog] = useState<ScenarioChangeLogEntry[]>(() => loadChangeLog([]));
  const [taxStore, setTaxStore] = useState(() => loadTaxStore(defaultTaxStore()));

  // Persistence — write through whenever state changes. Coalesced via
  // debouncedPersist so rapid edits collapse to a single localStorage write
  // (JSON.stringify of these arrays is multi-MB on real datasets and was
  // blocking the main thread per keystroke). Flushed on beforeunload/pagehide
  // so no data is lost.
  useEffect(() => { debouncedPersist('planning.scenarios', storedScenarios, savePlanningScenarios); }, [storedScenarios]);
  useEffect(() => { debouncedPersist('planning.adjustments', storedAdjustments, savePlanningAdjustments); }, [storedAdjustments]);
  useEffect(() => { debouncedPersist('planning.manualEntries', manualEntries, saveManualPlanningEntries); }, [manualEntries]);
  useEffect(() => { debouncedPersist('planning.customRows', customRows, saveCustomRows); }, [customRows]);
  useEffect(() => { debouncedPersist('planning.cellOverrides', cellOverrides, saveCellOverrides); }, [cellOverrides]);
  useEffect(() => { debouncedPersist('planning.changeLog', changeLog, saveChangeLog); }, [changeLog]);

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

  // Shared store: hydrate planning data from the server-side store once on
  // mount so every browser converges on the same scenarios/propuestas/overrides.
  // The first paint already rendered from the local mirror (useState above); if
  // the server holds different data we pull it into localStorage and reload it
  // into state here. No-op when the store is OFF or unreachable (best-effort).
  useEffect(() => {
    let cancelled = false;
    hydratePlanningFromServer()
      .then((changed) => {
        if (cancelled || !changed) return;
        setStoredScenarios(loadPlanningScenarios([]));
        setStoredAdjustments(loadPlanningAdjustments([]));
        setManualEntries(loadManualPlanningEntries([]));
        setCustomRows(loadCustomRows([]));
        setCellOverrides(loadCellOverrides([]));
        setChangeLog(loadChangeLog([]));
      })
      .catch(() => {
        /* best-effort: keep the local mirror */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Bootstrap: enforce Base + Approved + clean legacy on every relevant change.
  const bootstrap = useMemo(
    () => ensureCoreScenarios({
      storedScenarios,
      storedAdjustments,
      manualEntries,
      customRows,
      cellOverrides,
      changeLog,
      sourceBaseScenario,
      user: USER,
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

  const scenarios = bootstrap.scenarios;
  const baseScenario = scenarios.find((s) => s.id === BASE_SCENARIO_ID && s.kind === 'BASE')!;
  const approvedScenario = scenarios.find((s) => s.id === APPROVED_SCENARIO_ID && s.kind === 'APPROVED')!;

  // Active scenario is driven by the global header selector when the
  // provider is mounted (the app shell). Standalone (isolation tests) it
  // falls back to local state so behavior is preserved.
  const scenarioCtx = useScenarioSelection();
  const [localScenarioId, setLocalScenarioId] = useState<string>(() => APPROVED_SCENARIO_ID);
  const activeScenarioId = scenarioCtx?.activeScenarioId ?? localScenarioId;
  const setActiveScenarioId = scenarioCtx?.setActiveScenarioId ?? setLocalScenarioId;
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [mergeOpen, setMergeOpen] = useState<string | null>(null);
  const [addRowFor, setAddRowFor] = useState<FinancialMovementType | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  // Tendencia histórica (Holt-Winters): SIEMPRE activa en escenarios no-base
  // (ver buildScenarioRun). Las líneas `forecast:trend:` caen como filas propias
  // ("Tendencia histórica") editables por celda, por encima de ROL, OC y deudas.
  // El Escenario Base la excluye por definición. Ya no es opt-in.
  // Series mensuales del motor predictivo para el top-off. `undefined` si no
  // hay histórico suficiente → no se inyecta nada.
  const trendForecast = useMemo(() => {
    const predictive = source.canonical.predictive;
    if (!predictive) return undefined;
    return { income: predictive.income.monthly, expense: predictive.expense.monthly };
  }, [source.canonical.predictive]);
  const trendAvailable = trendForecast !== undefined;
  const [detailMovement, setDetailMovement] = useState<FinancialMovement | null>(null);
  const [detailAnchor, setDetailAnchor] = useState<DOMRect | null>(null);
  const [selectedCell, setSelectedCell] = useState<SelectedPlanningCell>(null);
  const [inspectedCell, setInspectedCell] = useState<{ conceptKey: string; bucketKey: string } | null>(null);
  const [proposalPickerOpen, setProposalPickerOpen] = useState(false);
  const [editorMovement, setEditorMovement] = useState<FinancialMovement | null>(null);

  useEffect(() => {
    if (!scenarios.some((s) => s.id === activeScenarioId && !s.archivedAt)) {
      setActiveScenarioId(approvedScenario.id);
    }
  }, [scenarios, activeScenarioId, approvedScenario.id, setActiveScenarioId]);

  // Publish the fully-bootstrapped scenario list (incl. drafts) up to the
  // global header selector. Planeación is the editing surface, so it owns
  // CRUD; the header just mirrors what lives here.
  const registerScenarios = scenarioCtx?.registerScenarios;
  useEffect(() => {
    registerScenarios?.(scenarios);
  }, [registerScenarios, scenarios]);

  // External commands from CommandPalette (Cmd+K).
  useEffect(() => {
    const onSetActive = (event: Event) => {
      const detail = (event as CustomEvent<{ scenarioId?: string }>).detail;
      if (detail?.scenarioId && scenarios.some((s) => s.id === detail.scenarioId && !s.archivedAt)) {
        setActiveScenarioId(detail.scenarioId);
      }
    };
    const onCreateDraftEvt = () => {
      handleCreateDraft();
    };
    window.addEventListener('midas:planning:setActiveScenario', onSetActive);
    window.addEventListener('midas:planning:createDraft', onCreateDraftEvt);
    return () => {
      window.removeEventListener('midas:planning:setActiveScenario', onSetActive);
      window.removeEventListener('midas:planning:createDraft', onCreateDraftEvt);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarios]);

  useEffect(() => {
    if (!statusMessage) return;
    const handle = setTimeout(() => setStatusMessage(null), 4500);
    return () => clearTimeout(handle);
  }, [statusMessage]);

  const activeScenario = scenarios.find((s) => s.id === activeScenarioId) ?? approvedScenario;
  const isReadOnly = activeScenario.kind !== 'DRAFT';

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
  const minimumCash = useMemo(
    () => minimumCashFor(props.providers, props.payrollMonthlyActualJDE),
    [props.providers, props.payrollMonthlyActualJDE],
  );

  // Stable fingerprint for the inputs every scenario run shares. Folds into
  // the LRU cache key so repeat tab visits + tab-strip lookups skip the
  // full pipeline. Mirrors `FinancialProjectionDashboard` so the modules
  // share a cache across navigation.
  const sharedRunInputsKey = useMemo(() => {
    return planningSharedRunInputsKey({
      movements: source.movements,
      adjustments: storedAdjustments,
      manualEntries,
      taxStore,
      providers: props.providers,
      cobranzaPayments: props.cobranzaPayments,
      bajioStatements: props.bajioStatements,
      auxiliarReconciliation: props.auxiliarReconciliation,
      cxpPaymentCoverage: props.cxpPaymentCoverage,
      yearStart,
      yearEnd,
      today,
      initialCash,
      supplierInitialCash,
      minimumCash,
      granularity,
    });
  }, [
    source.movements,
    storedAdjustments,
    manualEntries,
    taxStore,
    props.providers,
    props.cobranzaPayments,
    props.bajioStatements,
    props.auxiliarReconciliation,
    props.cxpPaymentCoverage,
    yearStart,
    yearEnd,
    today,
    initialCash,
    supplierInitialCash,
    minimumCash,
    granularity,
  ]);

  const buildScenarioRun = (scenarioId: string, includeManualEntries: boolean): PlanningScenarioRun => {
    const scenarioCustomRows = customRows.filter((row) => row.scenarioId === scenarioId);
    const scenarioOverrides = cellOverrides.filter((override) => override.scenarioId === scenarioId);
    const customKey = fingerprintArray(scenarioCustomRows, (row) => row.id + ':' + (row.updatedAt ?? ''));
    const overrideKey = fingerprintArray(scenarioOverrides, (override) => `${override.conceptKey}@${override.bucketKey}:${override.value}:${override.updatedAt ?? ''}`);
    const scenario = scenarios.find((s) => s.id === scenarioId);
    // La tendencia es no-base y siempre activa cuando hay histórico; en Base
    // nunca aplica (además `forecast:trend:` falla isRealShortTermApiMovement,
    // así que Base lo descartaría igual). El trendTag va en cacheKey Y
    // pipelineKey: el top-off vive en el pipeline (mismo contrato que Proyección).
    const trendOn = trendAvailable && scenario?.kind !== 'BASE';
    const trendTag = `trend:${trendOn ? 1 : 0}`;
    const cacheKey = planningRunCacheKey({
      scenarioId,
      includeManualEntries,
      sharedRunInputsKey,
      customKey,
      overrideKey,
      trendTag,
      granularity,
    });
    // pipelineKey omite el tramo `g=` porque el pipeline (pre-bucketing) no
    // depende de la granularidad en sí. NO esperes reuso al cambiar de
    // granularidad: `sharedRunInputsKey` ya lleva la granularidad Y su ventana
    // (`planningWindowFor` da un rango distinto por cada una), así que el
    // pipeline se recomputa — correcto, la ventana cambió los movimientos en
    // scope. El omitir `g=` sólo evita una segunda entrada redundante.
    const pipelineKey = `planning-pipeline:${scenarioId}:${includeManualEntries ? 'm1' : 'm0'}|${sharedRunInputsKey}|${customKey}|${overrideKey}|${trendTag}`;
    const persistRun = (scenarioId === baseScenario.id || scenarioId === approvedScenario.id)
      ? (key: string, run: PlanningScenarioRun) => saveScenarioRunToPersistentCache(key, run)
      : undefined;
    return runCached<PlanningScenarioRun>(
      cacheKey,
      scenarioId,
      () => ({
        scenarioId,
        scenarioName: scenario?.name ?? scenarioId,
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
        cxpPaymentCoverage: props.cxpPaymentCoverage,
        auxiliarReconciliation: props.auxiliarReconciliation,
        purchaseReceipts: props.purchaseReceipts,
        paidPurchaseOrderKeys: source.paidPurchaseOrderKeys,
        payrollCosts: props.payrollCosts,
        cobranzaPayments: props.cobranzaPayments,
        budget: props.budget,
        companyCode: props.companyCode,
        taxStore,
        startDate: yearStart,
        endDate: yearEnd,
        today,
        bajioStatements: props.bajioStatements ?? [],
        initialCash,
        supplierInitialCash,
        minimumCash,
        granularity,
        includeManualEntries,
        includeTrendTopOff: trendOn,
        trendForecast,
      }),
      persistRun,
      {
        pipelineKey,
        priority: scenarioId === activeScenarioId ? 'foreground' : 'background',
        placeholderMode: scenarioId === activeScenarioId ? 'any' : 'same-scenario',
      },
    );
  };

  // Approved baseline used for diff reference.
  const approvedRun = useMemo(
    () => buildScenarioRun(approvedScenario.id, true),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [approvedScenario.id, sharedRunInputsKey, cellOverrides, customRows, runVersion],
  );

  const baseRun = useMemo(
    () => buildScenarioRun(baseScenario.id, true),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseScenario.id, sharedRunInputsKey, cellOverrides, customRows, runVersion],
  );

  // Cruce Planeación ↔ Banco para meses históricos cerrados. El run Base sólo
  // debe contener lo real (banco/cobranza/CXP/OC/nómina); su caja final por mes
  // histórico tiene que cuadrar al peso con el saldo final bancario y sus
  // ingresos/egresos con los ABONO/CARGO reales. Si algo lo rompe, lo dejamos
  // observable (consola + window.__midas__.planningBankReconciliation) en vez de
  // que el desvío pase inadvertido. No bloquea render — sólo traza.
  useEffect(() => {
    if (!props.bankStatements || props.bankStatements.length === 0) return;
    const report = reconcilePlanningAgainstBank({
      movements: baseRun.movements,
      initialCash,
      bankStatements: props.bankStatements,
      companyCode: props.companyCode,
      today,
    });
    try {
      (window as unknown as { __midas__?: Record<string, unknown> }).__midas__ = {
        ...(window as unknown as { __midas__?: Record<string, unknown> }).__midas__,
        planningBankReconciliation: report,
      };
    } catch {
      /* window no disponible (SSR/tests) — ignorar */
    }
    // Atribución SIEMPRE (no solo en divergencia): permite leer en consola de
    // qué se compone la brecha caja Planeación (C) vs. banco. `bankKpiClosing`
    // (A = Σ saldoFinal reportado, el KPI de Bancos) vs. `bankClosingCash`
    // (B = saldoInicial+Σneto) aísla la "definición de saldo"; el desglose por
    // familia + `internalReconNet` + `initialCashVsBankInitial` aíslan el motor.
    /* eslint-disable no-console */
    console.info(
      '[planning.bank-recon] scope', report.scope,
      '| bankKpiClosing(A)', report.bankKpiClosing,
      '| initialCashVsBankInitial', report.initialCashVsBankInitial,
    );
    console.table(report.months.map((m) => ({
      ym: m.yearMonth,
      planIncome: m.planningIncome,
      bankIncome: m.bankIncome,
      dInc: m.incomeDiff,
      planExp: m.planningExpense,
      bankExp: m.bankExpense,
      dExp: m.expenseDiff,
      planCash: m.planningClosingCash,
      bankCash: m.bankClosingCash,
      dCash: m.closingCashDiff,
      internalReconNet: m.internalReconNet,
    })));
    console.table(report.months.map((m) => ({
      ym: m.yearMonth,
      ...Object.fromEntries(
        Object.entries(m.componentBreakdown).map(([fam, t]) => [fam, t.net]),
      ),
    })));
    /* eslint-enable no-console */
    if (!report.reconciled) {
      console.warn(
        `[planning.bank-recon] caja/ingresos/egresos NO cuadran con banco en ${report.divergentMonths.join(', ')} `
        + `(máx Δcaja=${report.maxClosingCashDiff.toFixed(2)})`,
        report.months.filter((m) => !m.reconciled),
      );
    }
  }, [baseRun, initialCash, props.bankStatements, props.companyCode, today]);

  // Reuse approved/base when the active scenario is one of them — the cache
  // would hit anyway, but skipping the call avoids an extra function frame
  // and keeps the dependency graph clearer for React's reconciliation.
  const activeRunRaw = useMemo(
    () => {
      if (activeScenario.id === approvedScenario.id) return approvedRun;
      if (activeScenario.id === baseScenario.id) return baseRun;
      return buildScenarioRun(activeScenario.id, true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeScenario.id, approvedScenario.id, baseScenario.id, approvedRun, baseRun, sharedRunInputsKey, cellOverrides, customRows, runVersion],
  );

  const activeOverrides = useMemo(
    () => cellOverrides.filter((override) => override.scenarioId === activeScenarioId),
    [cellOverrides, activeScenarioId],
  );
  const rows = activeRunRaw.rows;
  const activeRun = activeRunRaw;

  // Approved overrides for the diff and merge logic
  const approvedOverrides = useMemo(
    () => cellOverrides.filter((override) => override.scenarioId === approvedScenario.id),
    [cellOverrides, approvedScenario.id],
  );

  const approvedRunWithOverrides = approvedRun;

  const runsWithOverridesByScenarioId = useMemo(() => {
    const map = new Map<string, PlanningScenarioRun>();
    for (const scenario of scenarios) {
      if (scenario.archivedAt) continue;
      const raw = scenario.id === activeScenario.id
        ? activeRunRaw
        : scenario.id === approvedScenario.id
          ? approvedRun
          : scenario.id === baseScenario.id
            ? baseRun
            : buildScenarioRun(scenario.id, true);
      map.set(scenario.id, raw);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    scenarios,
    activeScenario.id,
    activeRunRaw,
    approvedScenario.id,
    approvedRun,
    baseScenario.id,
    baseRun,
    cellOverrides,
    customRows,
    granularity,
    today,
    initialCash,
    minimumCash,
    sharedRunInputsKey,
    runVersion,
  ]);

  // Pre-override per-row aggregates (for cell display when no override).
  const rowAggregateMap = useMemo(() => {
    const map = new Map<string, number>();
    const movementById = new Map<string, FinancialMovement>();
    for (const movement of activeRunRaw.movements) movementById.set(movement.id, movement);
    for (const bucket of activeRunRaw.buckets) {
      for (const id of bucket.movementIds) {
        const movement = movementById.get(id);
        if (!movement) continue;
        const key = `${conceptKeyForMovement(movement)}::${bucket.date}`;
        map.set(key, (map.get(key) ?? 0) + effectiveAmount(movement));
      }
    }
    return map;
  }, [activeRunRaw]);

  const overrideMap = useMemo(() => {
    const map = new Map<string, CellOverride>();
    for (const override of activeOverrides) {
      map.set(`${override.conceptKey}::${override.bucketKey}::${override.granularity}`, override);
    }
    return map;
  }, [activeOverrides]);

  const columns: BucketColumn[] = useMemo(() => {
    const todayKey = bucketKeyForDate(today, granularity);
    // El Escenario Base es sólo histórico: su run se recorta a hoy
    // (projectionEndDate = today). No mostrar columnas futuras vacías — la
    // tabla termina en el período en curso.
    const windowEnd = activeScenario.kind === 'BASE' ? today : yearEnd;
    const dates = buildBucketDates(yearStart, windowEnd, granularity);
    return dates.map((date) => ({
      key: date,
      label: engineBucketLabel(date, granularity),
      isPast: date < todayKey,
      isCurrent: date === todayKey,
    }));
  }, [granularity, yearStart, yearEnd, today, activeScenario.kind]);

  const totalsForKind = (kind: 'inflows' | 'outflows' | 'net' | 'closingCash', bucketKey: string): number => {
    const bucket = activeRun.buckets.find((b) => b.date === bucketKey);
    if (!bucket) return 0;
    return bucket[kind];
  };

  const baseValueFor = (conceptKey: string, bucketKey: string): number =>
    rowAggregateMap.get(`${conceptKey}::${bucketKey}`) ?? 0;

  const overrideFor = (conceptKey: string, bucketKey: string): CellOverride | undefined =>
    overrideMap.get(`${conceptKey}::${bucketKey}::${granularity}`);

  const aiTouchedSet = useMemo(() => {
    const set = new Set<string>();
    const aiAdjustments = storedAdjustments.filter(
      (adj) =>
        adj.scenarioIds.includes(activeScenarioId) &&
        adj.status !== 'REJECTED' &&
        typeof adj.createdBy === 'string' &&
        adj.createdBy.toLowerCase().startsWith('midas'),
    );
    if (aiAdjustments.length === 0) return set;
    const targetIds = new Set<string>();
    for (const adj of aiAdjustments) {
      if (adj.targetType === 'MOVEMENT' && adj.targetExpression) {
        targetIds.add(adj.targetExpression);
      }
    }
    for (const movement of activeRunRaw.movements) {
      const sourceMatches =
        targetIds.has(movement.id) ||
        (movement.sourceObjectId ? targetIds.has(movement.sourceObjectId) : false) ||
        Array.from(targetIds).some((tid) => movement.id.startsWith(`${tid}:split:`));
      if (!sourceMatches) continue;
      const conceptKey = conceptKeyForMovement(movement);
      const bucketKey = bucketKeyForDate(effectiveMovementDate(movement), granularity);
      set.add(`${conceptKey}::${bucketKey}`);
    }
    return set;
  }, [storedAdjustments, activeScenarioId, activeRunRaw.movements, granularity]);

  const isAiTouched = (conceptKey: string, bucketKey: string): boolean =>
    aiTouchedSet.has(`${conceptKey}::${bucketKey}`);

  const handleCommitCell = (conceptKey: string, bucketKey: string, value: number, type: FinancialMovementType) => {
    if (isReadOnly) return;
    const previousAggregate = baseValueFor(conceptKey, bucketKey);
    const existing = overrideFor(conceptKey, bucketKey);
    const oldValue = existing ? existing.value : previousAggregate;
    if (Math.round(oldValue) === Math.round(value)) return;
    const now = new Date().toISOString();
    const next: CellOverride = existing
      ? { ...existing, value, updatedAt: now }
      : {
        id: `co-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        scenarioId: activeScenarioId,
        conceptKey,
        granularity,
        bucketKey,
        type,
        mode: 'REPLACE',
        value,
        previousAggregatedValue: previousAggregate,
        createdBy: USER,
        createdAt: now,
        updatedAt: now,
      };
    setCellOverrides((current) => {
      const filtered = current.filter((o) => o.id !== (existing?.id ?? next.id));
      return [...filtered, next];
    });
    const row = rows.find((r) => r.conceptKey === conceptKey);
    setChangeLog((current) => [
      newChangeLogEntry({
        scenarioId: activeScenarioId,
        kind: 'EDIT_CELL',
        autoDescription: describeEditCell({
          rowLabel: row?.label ?? conceptKey,
          bucketLabel: engineBucketLabel(bucketKey, granularity),
          oldValue,
          newValue: value,
        }),
        payload: describeOverridePayload(next),
        createdBy: USER,
      }),
      ...current,
    ]);
  };

  const handleClearCell = (conceptKey: string, bucketKey: string) => {
    if (isReadOnly) return;
    const existing = overrideFor(conceptKey, bucketKey);
    if (!existing) return;
    const baseValue = baseValueFor(conceptKey, bucketKey);
    setCellOverrides((current) => current.filter((o) => o.id !== existing.id));
    const row = rows.find((r) => r.conceptKey === conceptKey);
    setChangeLog((current) => [
      newChangeLogEntry({
        scenarioId: activeScenarioId,
        kind: 'CLEAR_CELL',
        autoDescription: describeClearCell({
          rowLabel: row?.label ?? conceptKey,
          bucketLabel: engineBucketLabel(bucketKey, granularity),
          baseValue,
        }),
        payload: describeOverridePayload(existing),
        createdBy: USER,
      }),
      ...current,
    ]);
  };

  const handleAddRow = (type: FinancialMovementType) => {
    if (isReadOnly) return;
    setAddRowFor(type);
  };

  const handleCreateRow = (input: { type: FinancialMovementType; label: string; category: FinancialMovementCategory }) => {
    if (isReadOnly) return;
    const now = new Date().toISOString();
    const id = `custom-row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const conceptKey = buildCustomConceptKey(input.type, input.label, id);
    const row: PlanningCustomRow = {
      id,
      scenarioId: activeScenarioId,
      conceptKey,
      label: input.label,
      type: input.type,
      category: input.category,
      createdBy: USER,
      createdAt: now,
      updatedAt: now,
    };
    setCustomRows((current) => [...current, row]);
    setChangeLog((current) => [
      newChangeLogEntry({
        scenarioId: activeScenarioId,
        kind: 'ADD_ROW',
        autoDescription: describeAddRow(row),
        payload: { conceptKey: row.conceptKey, label: row.label, type: row.type, category: row.category },
        createdBy: USER,
      }),
      ...current,
    ]);
    setAddRowFor(null);
    setStatusMessage(`Fila "${row.label}" agregada.`);
  };

  const selectedCellMovements = useMemo(() => {
    if (!selectedCell) return [];
    return activeRun.movements
      .filter((movement) =>
        conceptKeyForMovement(movement) === selectedCell.conceptKey
        && bucketKeyForDate(effectiveMovementDate(movement), granularity) === selectedCell.bucketKey,
      )
      .sort((a, b) => effectiveMovementDate(a).localeCompare(effectiveMovementDate(b)));
  }, [activeRun.movements, granularity, selectedCell]);

  const handleCreateDraft = (name?: string): string => {
    const { newScenario, seedEntry } = createNewDraft({ approved: approvedScenario, user: USER, name });
    setStoredScenarios((current) => [...current, newScenario]);
    setChangeLog((current) => [seedEntry, ...current]);
    setActiveScenarioId(newScenario.id);
    setStatusMessage(`Propuesta "${newScenario.name}" creada.`);
    return newScenario.id;
  };

  const ensureEditableScenario = (name?: string): string => {
    if (activeScenario.kind === 'DRAFT' && !activeScenario.archivedAt) return activeScenario.id;
    return handleCreateDraft(name);
  };

  const handleAcceptMidasProposal = (suggestion: MidasProposalSuggestion) => {
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
      const withImpact: FinancialAdjustment = {
        ...adjustment,
        impactSummary: {
          cashImpact: suggestion.estimatedCashImpact,
          deficitDaysReduced: 0,
          riskChange: 0,
        },
      };
      setStoredAdjustments((current) => [...current, withImpact]);
      setStatusMessage(`MIDAS guardó propuesta "${withImpact.name}" como DRAFT.`);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'No se pudo crear la propuesta.');
    }
  };

  const openProposalPicker = () => {
    if (activeScenario.kind !== 'DRAFT') {
      handleCreateDraft();
    }
    setProposalPickerOpen(true);
  };

  const handlePickMovement = (movement: FinancialMovement) => {
    setProposalPickerOpen(false);
    setEditorMovement(movement);
  };

  const handleSaveAdjustment = (adjustment: FinancialAdjustment) => {
    setStoredAdjustments((current) => [...current, adjustment]);
    setEditorMovement(null);
    setStatusMessage(`Propuesta "${adjustment.name}" creada.`);
  };

  const handleDuplicateDraft = (scenarioId: string) => {
    const sourceDraft = scenarios.find((s) => s.id === scenarioId);
    if (!sourceDraft) return;
    const result = duplicateDraft({
      source: sourceDraft,
      approvedScenarioId: approvedScenario.id,
      allOverrides: cellOverrides,
      allCustomRows: customRows,
      changeLog,
      user: USER,
    });
    setStoredScenarios((current) => [...current, result.newScenario]);
    setCellOverrides(result.cellOverrides);
    setCustomRows(result.customRows);
    setChangeLog(result.changeLog);
    setActiveScenarioId(result.newScenario.id);
    setStatusMessage(`Propuesta duplicada como "${result.newScenario.name}".`);
  };

  const handleRenameDraft = (scenarioId: string, name: string) => {
    setStoredScenarios((current) => current.map((s) => (s.id === scenarioId ? { ...s, name, updatedAt: new Date().toISOString() } : s)));
  };

  const handleDiscardDraft = (scenarioId: string) => {
    if (!confirm('¿Descartar esta propuesta? Esta acción no se puede deshacer.')) return;
    const now = new Date().toISOString();
    setStoredScenarios((current) => current.map((s) => (s.id === scenarioId ? { ...s, archivedAt: now, updatedAt: now } : s)));
    setActiveScenarioId(approvedScenario.id);
    setStatusMessage('Propuesta descartada.');
  };

  const draftEntries = changeLog.filter((entry) => entry.scenarioId === activeScenarioId);

  // ------- Merge flow ---------
  const buildPendingChangesForDraft = useCallback((draftId: string): MergeDiffEntry[] => {
    const draft = scenarios.find((s) => s.id === draftId);
    if (!draft) return [];
    const draftOverrides = cellOverrides.filter((o) => o.scenarioId === draft.id);
    const draftCustomScoped = customRows.filter((r) => r.scenarioId === draft.id);
    const approvedCustomScoped = customRows.filter((r) => r.scenarioId === approvedScenario.id);
    const draftAdjustments = storedAdjustments.filter((adjustment) => adjustment.scenarioIds.includes(draft.id));
    const approvedAdjustments = storedAdjustments.filter((adjustment) => adjustment.scenarioIds.includes(approvedScenario.id));
    const allRows = buildPlanningRows({
      movements: approvedRun.movements,
      customRows: [...approvedCustomScoped, ...draftCustomScoped],
      overrides: [...approvedOverrides, ...draftOverrides],
      providers: props.providers,
    });
    const labelByKey = new Map(allRows.map((row) => [row.conceptKey, row.label]));
    const approvedAggregateMap = new Map<string, number>();
    const movementById = new Map(approvedRun.movements.map((m) => [m.id, m]));
    for (const bucket of approvedRun.buckets) {
      for (const id of bucket.movementIds) {
        const movement = movementById.get(id);
        if (!movement) continue;
        const key = `${conceptKeyForMovement(movement)}::${bucket.date}::${granularity}`;
        approvedAggregateMap.set(key, (approvedAggregateMap.get(key) ?? 0) + effectiveAmount(movement));
      }
    }
    return buildMergeDiff({
      approved: approvedScenario,
      draft,
      approvedOverrides,
      draftOverrides,
      approvedCustomRows: approvedCustomScoped,
      draftCustomRows: draftCustomScoped,
      approvedAdjustments,
      draftAdjustments,
      manualEntries,
      rowLabelLookup: (key) => labelByKey.get(key) ?? key,
      bucketLabelLookup: (key, gran) => engineBucketLabel(key, gran),
      approvedAggregateLookup: (key, bucketKey, gran) => {
        const aggKey = `${key}::${bucketKey}::${gran}`;
        return approvedAggregateMap.get(aggKey) ?? 0;
      },
    });
  }, [scenarios, cellOverrides, customRows, storedAdjustments, manualEntries, approvedScenario, approvedOverrides, approvedRun, granularity]);

  const mergeDiff: MergeDiffEntry[] = useMemo(
    () => (mergeOpen ? buildPendingChangesForDraft(mergeOpen) : []),
    [buildPendingChangesForDraft, mergeOpen],
  );

  const activeDraftDiff: MergeDiffEntry[] = useMemo(
    () => (activeScenario.kind === 'DRAFT' ? buildPendingChangesForDraft(activeScenario.id) : []),
    [activeScenario.id, activeScenario.kind, buildPendingChangesForDraft],
  );

  const handleConfirmMerge = (args: { selectedChanges: MergeDiffEntry[]; archiveDraft: boolean }) => {
    if (!mergeOpen) return;
    const draft = scenarios.find((s) => s.id === mergeOpen);
    if (!draft) return;
    const draftOverrides = cellOverrides.filter((o) => o.scenarioId === draft.id);
    const draftCustomScoped = customRows.filter((r) => r.scenarioId === draft.id);
    const approvedCustomScoped = customRows.filter((r) => r.scenarioId === approvedScenario.id);
    const draftAdjustments = storedAdjustments.filter((adjustment) => adjustment.scenarioIds.includes(draft.id));
    const approvedAdjustments = storedAdjustments.filter((adjustment) => adjustment.scenarioIds.includes(approvedScenario.id));
    const result = applyMerge({
      approved: approvedScenario,
      draft,
      scenarios,
      approvedOverrides,
      draftOverrides,
      allOverrides: cellOverrides,
      approvedAdjustments,
      draftAdjustments,
      allAdjustments: storedAdjustments,
      approvedCustomRows: approvedCustomScoped,
      draftCustomRows: draftCustomScoped,
      allCustomRows: customRows,
      manualEntries,
      changeLog,
      selectedChanges: args.selectedChanges.map((entry) => ({ kind: entry.kind, id: entry.id })),
      archiveDraft: args.archiveDraft,
      user: USER,
    });
    setStoredScenarios(result.scenarios);
    setCellOverrides(result.cellOverrides);
    setStoredAdjustments(result.adjustments);
    setCustomRows(result.customRows);
    setManualEntries(result.manualEntries);
    setChangeLog(result.changeLog);
    setMergeOpen(null);
    setActiveScenarioId(approvedScenario.id);
    setStatusMessage(`Cambios aplicados al Aprobado: ${args.selectedChanges.length}.`);
  };

  // ------- KPIs ---------
  const summary = activeRun.summary;
  const finalCashDelta = activeRun.summary.finalCash - approvedRunWithOverrides.summary.finalCash;
  const isDraft = activeScenario.kind === 'DRAFT';

  const finalCashFor = (scenarioId: string): number => {
    return runsWithOverridesByScenarioId.get(scenarioId)?.summary.finalCash ?? 0;
  };

  // KPI ingresos CITI vs Federal — sumar el run activo en su ventana forward
  // (después del asOfDate). La subcategoría la resuelve el motor canónico
  // (`resolveInflowSubcategory` en canonicalProjection.ts) y la taxonomía de
  // bucket la confirma `inflowBucketFor` en planningRowTaxonomy.ts. Filtro
  // forward para evitar mezclar histórico ya cobrado con expectativa futura.
  const inflowByEmpresa = useMemo(() => {
    const totals = { citi: 0, federal: 0, otros: 0 };
    for (const movement of activeRun.movements) {
      if (movement.type !== 'INFLOW') continue;
      if (effectiveMovementDate(movement) < props.today) continue;
      const amount = effectiveAmount(movement);
      if (amount <= 0) continue;
      const sub = movement.subcategory;
      if (sub === 'Federal') totals.federal += amount;
      else if (sub === 'Clientes Citi') totals.citi += amount;
      else totals.otros += amount;
    }
    return totals;
  }, [activeRun.movements, props.today]);

  const pendingChangeCount = activeDraftDiff.length;
  const mergeRun = mergeOpen ? runsWithOverridesByScenarioId.get(mergeOpen) : null;

  if (!source.hasData) {
    return (
      <div className="space-y-5">
        <PageHeader title="Planeación Financiera" />
        <EmptyDataState />
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-page-in">
      <PageHeader
        title="Planeación Financiera"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedFilter
              value={granularity}
              onChange={setGranularity}
              busy={granularityPending}
              options={[
                { value: 'monthly', label: 'Mes' },
                { value: 'weekly', label: 'Sem' },
                { value: 'daily', label: 'Día' },
              ]}
            />
            <button
              type="button"
              onClick={openProposalPicker}
              className="inline-flex h-10 items-center gap-2 rounded-[var(--radius)] bg-[var(--primary)] px-3 text-[12px] font-bold text-white transition-colors hover:bg-[var(--primary-hover)]"
            >
              + Crear propuesta
            </button>
          </div>
        }
      />

      {statusMessage && (
        <div className="rounded-[var(--radius)] border border-[var(--gray-200)] bg-white px-4 py-2 text-[12px] font-medium text-[var(--gray-700)]">
          {statusMessage}
        </div>
      )}

      <ScenarioTabs
        scenarios={scenarios}
        activeScenarioId={activeScenarioId}
        approvedFinalCash={approvedRunWithOverrides.summary.finalCash}
        finalCashFor={finalCashFor}
        onSelect={(id) => startTransition(() => setActiveScenarioId(id))}
        onCreateDraft={handleCreateDraft}
        onDuplicateDraft={handleDuplicateDraft}
        onRenameDraft={handleRenameDraft}
        onDiscardDraft={handleDiscardDraft}
      />

      {isDraft && (
        <ProposalActionBar
          scenarioName={activeScenario.name}
          pendingCount={pendingChangeCount}
          onReview={() => setMergeOpen(activeScenario.id)}
          onApply={() => setMergeOpen(activeScenario.id)}
          onDuplicate={() => handleDuplicateDraft(activeScenario.id)}
          onDiscard={() => handleDiscardDraft(activeScenario.id)}
        />
      )}

      {scenarios.filter((s) => s.kind === 'DRAFT' && !s.archivedAt).length === 0 && (
        <FirstSimulationNudge onCreateDraft={handleCreateDraft} />
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label={activeScenario.kind === 'BASE' ? 'Caja actual' : 'Caja final'}
          value={fmtCurrency(summary.finalCash)}
          icon={<Wallet className="w-4 h-4" />}
          color={toneByFloor(summary.finalCash, summary.minimumCashRequired)}
          sublabel={activeScenario.kind === 'BASE'
            ? 'Al corte de hoy · sólo histórico'
            : `12 meses · mínimo ${fmtCompact(summary.minimumCashRequired)}`}
          onClick={() => goTo({ tab: 'financialProjection', focus: 'caja-final' })}
          navHint="Ver en Proyección"
        />
        <KpiCard
          label="Días en déficit"
          value={String(summary.deficitDays)}
          icon={<AlertIcon className="w-4 h-4" />}
          color={toneByCount(summary.deficitDays)}
          sublabel={summary.maxRiskDate ? `Máx riesgo ${summary.maxRiskDate}` : 'Sin fecha crítica'}
          onClick={() => goTo({ tab: 'financialProjection', focus: 'deficit' })}
          navHint="Ver detalle"
        />
        <KpiCard
          label="Δ vs Aprobado"
          value={`${finalCashDelta === 0 ? '±0' : (finalCashDelta > 0 ? '+' : '') + fmtCompact(finalCashDelta)}`}
          icon={<TrendingUp className="w-4 h-4" />}
          color={toneByDelta(finalCashDelta)}
          sublabel={isDraft ? 'Propuesta activa' : 'Misma referencia'}
        />
        <KpiCard
          label="Ingresos por empresa"
          value={fmtCompact(inflowByEmpresa.citi + inflowByEmpresa.federal + inflowByEmpresa.otros)}
          icon={<TrendingUp className="w-4 h-4" />}
          sublabel="Forward (post-hoy)"
          breakdown={[
            { label: 'CITI', value: fmtCompact(inflowByEmpresa.citi) },
            { label: 'Federal', value: fmtCompact(inflowByEmpresa.federal) },
            ...(inflowByEmpresa.otros > 0
              ? [{ label: 'Otros', value: fmtCompact(inflowByEmpresa.otros) }]
              : []),
          ]}
        />
      </div>

      <SpreadsheetGrid
        rows={rows}
        columns={columns}
        granularity={granularity}
        isReadOnly={isReadOnly}
        asOfDate={today}
        baseValueFor={baseValueFor}
        overrideFor={overrideFor}
        isAiTouched={isAiTouched}
        totalsFor={totalsForKind}
        onCommitCell={handleCommitCell}
        onClearCell={handleClearCell}
        onAddRow={handleAddRow}
        onClickCell={(conceptKey, bucketKey) => setSelectedCell({ conceptKey, bucketKey })}
        onInspectCell={(conceptKey, bucketKey) => setInspectedCell({ conceptKey, bucketKey })}
        onReadOnlyAttempt={() => setStatusMessage('Solo lectura. Crea una propuesta para editar.')}
        closingCashLabel={activeScenario.kind === 'BASE' ? 'Caja actual' : 'Caja final'}
      />

      {selectedCell ? (
        <PlanningCellDetailPanel
          movements={selectedCellMovements}
          conceptLabel={rows.find((r) => r.conceptKey === selectedCell.conceptKey)?.label ?? selectedCell.conceptKey}
          scenarioName={activeScenario.name}
          bucketLabel={engineBucketLabel(selectedCell.bucketKey, granularity)}
          onSelectMovement={(movement) => {
            setDetailMovement(movement);
            setDetailAnchor(null);
          }}
          onClose={() => setSelectedCell(null)}
        />
      ) : activeScenario.kind !== 'BASE' ? (
        // El historial de cambios NO aplica al Escenario Base (read-only por
        // invariante, nunca acumula ediciones) — sólo Aprobado y propuestas.
        <ChangeLogDrawer
          open={drawerOpen}
          scenarioKind={activeScenario.kind === 'APPROVED' ? 'APPROVED' : 'DRAFT'}
          scenarioName={activeScenario.name}
          entries={draftEntries}
          onClose={() => setDrawerOpen(false)}
        />
      ) : null}

      {addRowFor && (
        <AddRowPopover
          type={addRowFor}
          onClose={() => setAddRowFor(null)}
          onCreate={handleCreateRow}
        />
      )}

      <MergeDialog
        open={Boolean(mergeOpen)}
        draft={mergeOpen ? scenarios.find((s) => s.id === mergeOpen) ?? null : null}
        approved={approvedScenario}
        diff={mergeDiff}
        changeLog={changeLog.filter((entry) => entry.scenarioId === mergeOpen)}
        draftFinalCash={mergeRun?.summary.finalCash ?? 0}
        approvedFinalCash={approvedRunWithOverrides.summary.finalCash}
        draftDeficitDays={mergeRun?.summary.deficitDays ?? 0}
        approvedDeficitDays={approvedRunWithOverrides.summary.deficitDays}
        onClose={() => setMergeOpen(null)}
        onConfirm={handleConfirmMerge}
      />

      <Suspense fallback={null}>
        <MovementDrillDownDrawer
          movement={detailMovement}
          anchor={detailAnchor}
          onClose={() => { setDetailMovement(null); setDetailAnchor(null); }}
          invoiceContext={{
            cxpRecords: props.cxpRecords,
            clients: props.clients,
            assumptions: props.assumptions,
            budget: props.budget,
          }}
        />
      </Suspense>

      <CellDetailPopover
        data={inspectedCell ? buildCellDetail(inspectedCell) : null}
        onClose={() => setInspectedCell(null)}
        onApplyOverride={(value) => {
          if (!inspectedCell) return;
          const row = rows.find((r) => r.conceptKey === inspectedCell.conceptKey);
          if (!row) return;
          if (activeScenario.kind !== 'DRAFT') {
            handleCreateDraft();
          }
          handleCommitCell(inspectedCell.conceptKey, inspectedCell.bucketKey, value, row.type);
          setInspectedCell(null);
          setStatusMessage('Override aplicado.');
        }}
      />

      {proposalPickerOpen && (
        <MovementPickerModal
          movements={activeRunRaw.movements}
          asOfDate={today}
          onPick={handlePickMovement}
          onClose={() => setProposalPickerOpen(false)}
        />
      )}

      <AdjustmentEditorPopover
        movement={editorMovement}
        anchor={null}
        scenarios={scenarios.filter((s) => s.kind === 'DRAFT' && !s.archivedAt)}
        defaultScenarioId={activeScenarioId}
        onClose={() => setEditorMovement(null)}
        onSave={handleSaveAdjustment}
      />

      <Suspense fallback={null}>
        <MidasBubble
          cia={props.companyCode}
          asOfDate={today}
          activeRun={activeRun}
          providers={props.providers}
          adjustments={storedAdjustments}
          activeScenarioId={activeScenario.id}
          activeScenarioKind={activeScenario.kind}
          onAcceptProposal={handleAcceptMidasProposal}
        />
      </Suspense>
    </div>
  );

  function buildCellDetail({ conceptKey, bucketKey }: { conceptKey: string; bucketKey: string }): CellDetailData | null {
    const row = rows.find((r) => r.conceptKey === conceptKey);
    if (!row) return null;
    const baseValue = baseValueFor(conceptKey, bucketKey);
    const override = overrideFor(conceptKey, bucketKey);
    const totalValue = override ? override.value : baseValue;
    const isBaseScenario = activeScenario.kind === 'BASE';
    return {
      conceptKey,
      conceptLabel: row.label,
      bucketKey,
      bucketLabel: engineBucketLabel(bucketKey, granularity),
      scenarioName: activeScenario.name,
      isBaseScenario,
      baseValue,
      manualOverride: override ? override.value : null,
      overrideComment: override?.note ?? null,
      totalValue,
      diffVsBase: 0,
    };
  }
}

function SegmentedFilter<T extends string>({
  value,
  onChange,
  options,
  busy = false,
}: {
  value: T;
  onChange: (next: T) => void;
  options: Array<{ value: T; label: string }>;
  // Recómputo de la nueva granularidad en curso (useTransition). No bloquea
  // clicks — el usuario puede recapacitar y la transición coalesce — sólo
  // da feedback visual de "calculando".
  busy?: boolean;
}) {
  return (
    <div
      aria-busy={busy}
      className="inline-flex h-10 rounded-[var(--radius)] border border-[var(--gray-200)] bg-[var(--gray-50)] p-0.5 transition-opacity"
      style={{ opacity: busy ? 0.6 : 1 }}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className="px-3 text-[12px] font-medium rounded-[var(--radius-md)] transition-colors"
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

function ProposalActionBar({
  scenarioName,
  pendingCount,
  onReview,
  onApply,
  onDuplicate,
  onDiscard,
}: {
  scenarioName: string;
  pendingCount: number;
  onReview: () => void;
  onApply: () => void;
  onDuplicate: () => void;
  onDiscard: () => void;
}) {
  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-white px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--gray-400)]">
          Propuesta activa
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-[var(--gray-950)]">{scenarioName}</span>
          <span className="rounded-full bg-[var(--gray-100)] px-2 py-0.5 text-[10px] font-bold text-[var(--gray-600)]">
            {pendingCount} cambio{pendingCount === 1 ? '' : 's'}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onReview}
          className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--gray-200)] bg-white px-3 text-[12px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)]"
        >
          <Eye className="h-3.5 w-3.5" strokeWidth={1.5} />
          Revisar cambios
        </button>
        <button
          type="button"
          onClick={onApply}
          disabled={pendingCount === 0}
          className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--primary)] px-3 text-[12px] font-semibold text-white hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.5} />
          Aplicar al Aprobado
        </button>
        <button
          type="button"
          onClick={onDuplicate}
          className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-md)] border border-[var(--gray-200)] bg-white text-[var(--gray-500)] hover:bg-[var(--gray-50)] hover:text-[var(--gray-800)]"
          aria-label="Duplicar propuesta"
          title="Duplicar propuesta"
        >
          <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-md)] border border-[var(--gray-200)] bg-white text-[var(--danger)] hover:bg-[var(--danger)]/8"
          aria-label="Descartar propuesta"
          title="Descartar propuesta"
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
        </button>
      </div>
    </section>
  );
}

function PlanningCellDetailPanel({
  movements,
  conceptLabel,
  scenarioName,
  bucketLabel,
  onSelectMovement,
  onClose,
}: {
  movements: FinancialMovement[];
  conceptLabel: string;
  scenarioName: string;
  bucketLabel: string;
  onSelectMovement: (movement: FinancialMovement) => void;
  onClose: () => void;
}) {
  const inflows = movements.filter((movement) => movement.type === 'INFLOW');
  const outflows = movements.filter((movement) => movement.type === 'OUTFLOW');
  const total = movements.reduce((sum, movement) => sum + effectiveAmount(movement), 0);
  const handleExport = useCallback(() => {
    const rows = movements.map((movement) => ({
      Concepto: movement.counterpartyName ?? movement.concept,
      Detalle: movement.concept,
      Tipo: movement.type === 'INFLOW' ? 'Ingreso' : 'Egreso',
      Categoría: movement.category,
      Subcategoría: movement.subcategory ?? '',
      Sistema: movement.sourceSystem,
      Documento: movement.sourceObjectId ?? '',
      'Cuenta banco': movement.bankAccountId ?? '',
      'Fecha original': movement.dueDate ?? movement.projectedDate ?? '',
      'Fecha estimada': effectiveMovementDate(movement) ?? '',
      Monto: effectiveAmount(movement),
      Moneda: movement.currency,
      Score: movement.confidenceScore,
      Estado: movement.status,
      ...sourceCsvFields(attributeMovementId(movement.id)),
    }));
    const slug = (text: string) =>
      text
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase() || 'celda';
    const filename = `detalle-${slug(conceptLabel)}-${slug(bucketLabel)}.csv`;
    downloadFile(toCSV(rows), filename);
  }, [movements, conceptLabel, bucketLabel]);
  return (
    <aside className="rounded-2xl border border-[var(--gray-200)] bg-white">
      <header className="flex items-start justify-between border-b border-[var(--gray-200)] px-4 py-3">
        <div className="min-w-0">
          <h3 className="truncate text-[13px] font-semibold text-[var(--gray-950)]">{conceptLabel}</h3>
          <p className="mt-1 text-[11px] text-[var(--gray-500)]">{bucketLabel} · {scenarioName}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleExport}
            disabled={movements.length === 0}
            className="inline-flex items-center gap-1 rounded-lg border border-[var(--gray-200)] px-2 py-1 text-[11px] font-medium text-[var(--gray-600)] hover:bg-[var(--gray-50)] disabled:cursor-not-allowed disabled:opacity-40"
            title="Descargar el detalle de esta celda en Excel (CSV)"
          >
            <Download className="h-3 w-3" strokeWidth={1.5} />
            Excel
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-[11px] font-medium text-[var(--gray-500)] hover:text-[var(--gray-950)]"
          >
            Cerrar
          </button>
        </div>
      </header>
      <div className="grid grid-cols-3 gap-2 border-b border-[var(--gray-200)] p-3">
        <MiniStat label="Ingresos" value={String(inflows.length)} />
        <MiniStat label="Egresos" value={String(outflows.length)} />
        <MiniStat label="Total" value={fmtCompact(total)} />
      </div>
      <div className="max-h-[480px] overflow-auto p-3">
        {movements.length === 0 ? (
          <div className="rounded-xl bg-[var(--gray-50)] px-3 py-8 text-center text-[12px] text-[var(--gray-400)]">
            No hay movimientos ligados a esta celda.
          </div>
        ) : (
          <div className="space-y-2">
            {movements.map((movement) => (
              <button
                key={movement.id}
                type="button"
                onClick={() => onSelectMovement(movement)}
                className="w-full rounded-xl border border-[var(--gray-200)] bg-white p-3 text-left hover:bg-[var(--gray-50)]"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1 text-[12px] font-semibold text-[var(--gray-950)]">
                      <span className="truncate">{movement.counterpartyName ?? movement.concept}</span>
                      <SourceInfo attribution={attributeMovementId(movement.id)} />
                    </div>
                    <div className="mt-0.5 truncate text-[10.5px] text-[var(--gray-500)]">
                      {movement.sourceSystem === 'BANK'
                        ? `Cuenta ${movement.bankAccountId ?? '—'} · Transf. ${movement.sourceObjectId ?? 's/n'}`
                        : `${movement.sourceSystem} · ${movement.category} · ${movement.sourceObjectId ?? 'sin documento'}`}
                    </div>
                  </div>
                  <div className="text-right text-[12px] font-semibold tabular-nums text-[var(--gray-950)]">
                    {fmtCompact(effectiveAmount(movement))}
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-[10.5px] text-[var(--gray-500)]">
                  <span>Original: {movement.dueDate ?? movement.projectedDate}</span>
                  <span>Estimado: {effectiveMovementDate(movement)}</span>
                  <span>Score: {movement.confidenceScore}</span>
                  <span>{movement.status}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--gray-200)] px-2 py-2">
      <div className="text-[9px] font-medium uppercase tracking-wider text-[var(--gray-400)]">{label}</div>
      <div className="mt-0.5 text-[12px] font-semibold tabular-nums text-[var(--gray-950)]">{value}</div>
    </div>
  );
}

/**
 * Piso operativo mensual (proveedores Operación críticos + nómina). Es el
 * umbral de "Días en déficit": un día cuenta como déficit cuando la caja
 * proyectada cae por debajo de este piso, no sólo cuando se vuelve negativa.
 *
 * Antes era una reserva HARDCODEADA de $20M — el mismo placeholder que
 * Proyección ya había reemplazado (2026-06-15) por el piso real, así que los
 * dos módulos medían el déficit contra umbrales distintos. Se computa idéntico
 * a `operatingFloorMonthlyFor` de Proyección, y debe computarse igual en
 * `preloadPlanningScenarioRuns` y en el dashboard interno para que el cache-key
 * del run empate.
 *
 * El fallback sobrevive sólo para el arranque sin catálogo de proveedores
 * (piso 0 = nunca hay déficit, que es peor que un umbral aproximado).
 */
function minimumCashFor(providers: Provider[], payrollMonthlyActualJDE?: number): number {
  const floor = computeMinimumOperatingExpense(providers, null, payrollMonthlyActualJDE).totalMonthly;
  return floor > 0 ? floor : 20_000_000;
}


function EmptyDataState() {
  return (
    <EmptyState
      tone="warning"
      align="center"
      icon={<AlertTriangle className="h-5 w-5" strokeWidth={1.5} />}
      title="Aún no hay datos suficientes para planear"
      description={<>Carga estados de cuenta en <strong>Bancos</strong>, CXP JDE o cobranza real para empezar.</>}
    />
  );
}
