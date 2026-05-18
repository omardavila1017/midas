import { useEffect, useMemo, useRef, useState } from 'react';
import type { FinancialProjectionSourceWorkerResponse } from '../../../workers/financialProjectionSourceWorkerTypes';
import { AlertTriangle, Wallet, AlertTriangle as AlertIcon, TrendingUp } from 'lucide-react';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import type { CobranzaRecord } from '../../../services/jdeTypes';
import type { RealReconciliationResult } from '../../../domain/realReconciliationEngine';
import { fmtCompact, fmtCurrency } from '../../../formatters';
import {
  applyAdjustmentsToMovements,
  applyCellOverridesToBuckets,
  bucketKeyForDate,
  bucketLabel as engineBucketLabel,
  buildBucketDates,
  calculateBaseProjection,
  effectiveAmount,
  effectiveMovementDate,
  summarizeBucketsForScenario,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type {
  CellOverride,
  FinancialAdjustment,
  FinancialMovement,
  FinancialMovementCategory,
  FinancialMovementType,
  FinancialScenario,
  ForecastRun,
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
import { FirstSimulationNudge } from '../components/FirstSimulationNudge';
import { MovementPickerModal } from '../components/MovementPickerModal';
import { AdjustmentEditorPopover } from '../components/AdjustmentEditorPopover';
import { cachedRun, clearProjectionRunCache, fingerprintArray } from '../../financial-projection/services/projectionCache';
import { CellDetailPopover, type CellDetailData } from '../components/CellDetailPopover';
import { SpreadsheetGrid } from '../components/spreadsheet/SpreadsheetGrid';
import { BucketColumn } from '../components/spreadsheet/gridGeometry';
import { MovementDrillDownDrawer } from '../../financial-projection/components/MovementDrillDownDrawer';
import {
  buildFinancialProjectionSourceData,
  calculateCurrentBankCash,
  calculateInitialCash,
  tryGetCachedFinancialProjectionSourceData,
  type FinancialProjectionSourceData,
} from '../../financial-projection/services/financialProjectionService';
import {
  buildAutomaticTaxReserveMovements,
  buildApprovedTaxPaymentMovements,
  buildTaxDashboardView,
  defaultTaxStore,
  loadTaxStore,
  TAX_STORE_CHANGED_EVENT,
  TAX_STORE_KEY,
} from '../../taxes/services/taxModuleService';
import { buildConvenioPaymentMovements } from '../../concurso-mercantil/services/convenioMovements';
import { buildFideicomisoMovements } from '../../fideicomiso/services/fideicomisoMovements';
import {
  expandManualPlanningEntriesToMovements,
  loadManualPlanningEntries,
  saveManualPlanningEntries,
} from '../services/manualPlanningEntries';
import {
  loadPlanningAdjustments,
  loadPlanningAudit,
  loadPlanningScenarios,
  savePlanningAdjustments,
  savePlanningAudit,
  savePlanningScenarios,
} from '../services/financialPlanningStorage';
import { loadCellOverrides, saveCellOverrides } from '../services/cellOverridesStorage';
import { buildCustomConceptKey, loadCustomRows, saveCustomRows } from '../services/customRowsStorage';
import { loadChangeLog, saveChangeLog } from '../services/changeLogStorage';
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
import {
  scheduleSupplierPaymentsByScore,
  type SupplierPaymentPlan,
} from '../services/supplierPaymentSchedule';
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
import { createFinancialAdjustment } from '../services/financialPlanningService';
import { ProbabilisticRiskStrip } from '../../financial-projection/components/ProbabilisticRiskStrip';
import { useProbabilisticForecast } from '../../financial-projection/services/probabilisticForecastService';

interface Props {
  companyCode: string;
  bankStatements: BankAccountStatement[];
  clients: Client[];
  providers: Provider[];
  cxpRecords: CXPRecord[];
  cobranzaRecords?: CobranzaRecord[];
  cobranzaReconciliation?: RealReconciliationResult;
  /**
   * CXPs ya pagadas según PagoProveedor. Se excluyen del egreso
   * proyectado para no doblar (el cargo bancario real ya las descontó).
   */
  paidCxpKeys?: Set<string>;
  /** CARGO bancarios matcheados a PagoProveedor — reclasifican como AP_PAYMENT. */
  cargoEnrichments?: Map<string, { status: 'MATCHED' | 'ORPHAN'; payments?: Array<{ nombreProveedor: string; importe: number }> }>;
  purchaseReceipts?: PurchaseReceiptRecord[];
  payrollCosts?: PayrollCostRecord[];
  assumptions: CashFlowAssumptions;
  budget: Budget | null;
  startingBalance: number;
  /**
   * Estados de cuenta Bajío (fideicomiso Dina). Llegan SEPARADOS porque
   * `bankStatements` ya viene sin Bajío (excludeBajio). Se usan para
   * re-inyectar el flujo del fideicomiso en escenarios no-base.
   */
  bajioStatements?: BankAccountStatement[];
}

const USER = 'tesoreria@senda.local';
type PlanningScenarioRun = ForecastRun & { supplierPlan: SupplierPaymentPlan };
type SelectedPlanningCell = { conceptKey: string; bucketKey: string } | null;

/**
 * Base scenario invariant: Base proyecta SÓLO datos reales de las APIs de
 * corto plazo. En el dominio Senda eso es cobranza real de JDE (facturas CXC
 * de viajes ya ejecutados — lo que el negocio llama "rol"), órdenes de compra
 * de JDE (`compras`) y nómina real de TRESS. NO debe incluir forecast por
 * regla (`client:` projectClientMonth), CXP, proveedores recurrentes, relleno
 * presupuestal ni el sintético de balanceo canónico. Filtramos por prefijo de
 * `id` porque el motor canónico es compartido (Dashboard/Proyección lo usan
 * completo) y no debe alterarse — el recorte vive sólo en la corrida de Base.
 */
const isRealShortTermApiMovement = (m: FinancialMovement): boolean => {
  if (m.id.startsWith('cxc:')) return true;
  if (m.id.startsWith('purchase:') || m.id.startsWith('po:')) return true;
  if (m.id.startsWith('payroll:')) return !m.id.includes(':forecast:');
  return false;
};

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
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const cacheProbeInput = useMemo(
    // PERF (2026-05-14): Planning NO usa `predictive` (Holt-Winters tiered).
    // Pasamos enablePredictive=false para que canonical no entrene el modelo
    // — ahorra varios cientos de ms en cold mounts y elimina extractHistorical
    // Series sobre 100k+ movimientos bancarios.
    () => ({ ...props, asOfDate: today, enablePredictive: false }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      props.companyCode,
      props.bankStatements,
      props.clients,
      props.providers,
      props.cxpRecords,
      props.cobranzaRecords,
      props.cobranzaReconciliation,
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
  const sourceWorkerRef = useRef<Worker | null>(null);
  const sourceJobRef = useRef(0);
  useEffect(() => {
    if (cachedSource) {
      setSource(cachedSource);
      return;
    }
    let cancelled = false;
    const jobId = ++sourceJobRef.current;
    const tStart = performance.now();
    // eslint-disable-next-line no-console
    console.info(`[planning.source] requesting jobId=${jobId} cxp=${cacheProbeInput.cxpRecords.length} cobranza=${cacheProbeInput.cobranzaRecords?.length ?? 0} payroll=${cacheProbeInput.payrollCosts?.length ?? 0}`);

    const runSyncFallback = () => {
      const t0 = performance.now();
      try {
        const built = buildFinancialProjectionSourceData(cacheProbeInput);
        if (!cancelled && sourceJobRef.current === jobId) setSource(built);
      } catch (err) {
        console.warn('[planning.source] sync fallback failed', err);
      }
      // eslint-disable-next-line no-console
      console.info(`[planning.source] sync fallback ${(performance.now() - t0).toFixed(0)}ms`);
    };

    if (typeof Worker === 'undefined') {
      runSyncFallback();
      return () => { cancelled = true; };
    }

    try {
      if (!sourceWorkerRef.current) {
        sourceWorkerRef.current = new Worker(
          new URL('../../../workers/financialProjectionSource.worker.ts', import.meta.url),
          { type: 'module' },
        );
      }
      const worker = sourceWorkerRef.current;
      worker.onmessage = (event: MessageEvent<FinancialProjectionSourceWorkerResponse>) => {
        if (cancelled || event.data.jobId !== sourceJobRef.current) return;
        const totalElapsed = performance.now() - tStart;
        if (event.data.result) {
          // eslint-disable-next-line no-console
          console.info(`[planning.source] worker result jobId=${jobId} total=${totalElapsed.toFixed(0)}ms (incluye spawn + cómputo + transferencia)`);
          setSource(event.data.result);
        } else if (event.data.error) {
          console.warn(`[planning.source] worker error jobId=${jobId} total=${totalElapsed.toFixed(0)}ms, fallback`, event.data.error);
          runSyncFallback();
        }
      };
      worker.onerror = (event) => {
        if (cancelled) return;
        console.warn('[planning.source] worker exception, fallback', event.message);
        runSyncFallback();
      };
      worker.postMessage({ jobId, input: cacheProbeInput });
    } catch (err) {
      console.warn('[planning.source] worker spawn failed, fallback', err);
      runSyncFallback();
    }

    return () => { cancelled = true; };
  }, [cachedSource, cacheProbeInput]);

  useEffect(() => {
    return () => {
      sourceWorkerRef.current?.terminate();
      sourceWorkerRef.current = null;
    };
  }, []);

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
    if (!source) return;
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
  }, [source, innerReady]);

  if (!source || !innerReady) {
    return <PlanningWarmupShell />;
  }

  return <PlanningDashboardInner {...props} today={today} source={source} />;
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

  const [granularity, setGranularity] = useState<ProjectionGranularity>('monthly');
  // Window depends on granularity. Monthly = año en curso (Ene 1 → Dic 31):
  // Planeación debe arrancar en enero y son solo 12 buckets. Weekly/daily over
  // a full year = up to 365 daily columns × N rows × synchronous per-scenario
  // projection runs with no grid virtualization → renderer OOM (Chrome
  // "Aw Snap" code 5). Bound the sub-month views to a near window instead.
  const { yearStart, yearEnd } = useMemo(() => {
    const y = today.slice(0, 4);
    if (granularity === 'monthly') {
      return { yearStart: `${y}-01-01`, yearEnd: `${y}-12-31` };
    }
    const base = new Date(`${today}T00:00:00.000Z`);
    const shift = (days: number) => {
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    };
    // weekly ≈ 32 buckets, daily ≈ 90 buckets — both render/compute safely.
    return granularity === 'weekly'
      ? { yearStart: shift(-56), yearEnd: shift(168) }
      : { yearStart: shift(-14), yearEnd: shift(76) };
  }, [today, granularity]);

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

  // Persistence — write through whenever state changes.
  useEffect(() => { savePlanningScenarios(storedScenarios); }, [storedScenarios]);
  useEffect(() => { savePlanningAdjustments(storedAdjustments); }, [storedAdjustments]);
  useEffect(() => { saveManualPlanningEntries(manualEntries); }, [manualEntries]);
  useEffect(() => { saveCustomRows(customRows); }, [customRows]);
  useEffect(() => { saveCellOverrides(cellOverrides); }, [cellOverrides]);
  useEffect(() => { saveChangeLog(changeLog); }, [changeLog]);

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
    if (bootstrap.auditEvents.length > 0) {
      const previous = loadPlanningAudit([]);
      savePlanningAudit([...bootstrap.auditEvents, ...previous]);
    }
  }, [bootstrap]);

  const scenarios = bootstrap.scenarios;
  const baseScenario = scenarios.find((s) => s.id === BASE_SCENARIO_ID && s.kind === 'BASE')!;
  const approvedScenario = scenarios.find((s) => s.id === APPROVED_SCENARIO_ID && s.kind === 'APPROVED')!;

  const [activeScenarioId, setActiveScenarioId] = useState<string>(() => APPROVED_SCENARIO_ID);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [mergeOpen, setMergeOpen] = useState<string | null>(null);
  const [addRowFor, setAddRowFor] = useState<FinancialMovementType | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
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
  }, [scenarios, activeScenarioId, approvedScenario.id]);

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
  const minimumCash = useMemo(() => minimumCashFor(), []);

  // Stable fingerprint for the inputs every scenario run shares. Folds into
  // the LRU cache key so repeat tab visits + tab-strip lookups skip the
  // full pipeline. Mirrors `FinancialProjectionDashboard` so the modules
  // share a cache across navigation.
  const sharedRunInputsKey = useMemo(() => {
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
    const bajioKey = fingerprintArray(
      props.bajioStatements ?? [],
      (s) => s.cia + ':' + s.cuenta + ':' + s.fechaEstadoCuenta + ':' + s.movimientos.length,
    );
    return [
      movementsKey,
      adjustmentsKey,
      manualKey,
      taxKey,
      providerKey,
      bajioKey,
      yearStart,
      yearEnd,
      today,
      initialCash,
      supplierInitialCash,
      minimumCash,
      granularity,
    ].join('|');
  }, [
    source.movements,
    storedAdjustments,
    manualEntries,
    taxStore,
    props.providers,
    props.bajioStatements,
    yearStart,
    yearEnd,
    today,
    initialCash,
    supplierInitialCash,
    minimumCash,
    granularity,
  ]);

  const buildScenarioRun = (scenarioId: string, includeManualEntries: boolean): PlanningScenarioRun => {
    const cacheKey = `planning-run:${scenarioId}:${includeManualEntries ? 'm1' : 'm0'}|${sharedRunInputsKey}`;
    return cachedRun<PlanningScenarioRun>(cacheKey, () => {
      const t0 = performance.now();
      const result = (() => {
      const isBase = scenarioId === BASE_SCENARIO_ID;
      const manualMovements = !isBase && includeManualEntries
        ? expandManualPlanningEntriesToMovements(manualEntries, {
          scenarioId,
          startDate: yearStart,
          endDate: yearEnd,
          asOfDate: today,
        })
        : [];
      const movementsBeforeAdjust = isBase
        ? source.movements.filter(isRealShortTermApiMovement)
        : [...source.movements, ...manualMovements];
      // applyAdjustmentsToMovements es determinístico sobre input idéntico —
      // calculamos una sola vez y lo reusamos como seed fiscal y como base
      // del schedule. La versión anterior corría el motor dos veces (preTax +
      // adjustedMovements) sobre exactamente los mismos inputs, duplicando CPU
      // en cada eval de escenario.
      const adjustedMovements = applyAdjustmentsToMovements(movementsBeforeAdjust, storedAdjustments, scenarioId);
      const taxSeedView = isBase ? null : buildTaxDashboardView({
        clients: props.clients,
        providers: props.providers,
        assumptions: props.assumptions,
        cxpRecords: props.cxpRecords,
        purchaseReceipts: props.purchaseReceipts,
        payrollCosts: props.payrollCosts,
        budget: props.budget,
        companyCode: props.companyCode,
        startDate: yearStart,
        endDate: yearEnd,
        movements: adjustedMovements,
        store: taxStore,
        today,
      });
      const taxMovements = taxSeedView
        ? [
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
        ]
        : [];
      // Convenio concursal: pagos futuros del convenio inyectados como
      // egresos DEBT bloqueados (mismo patrón e invariante que impuestos:
      // solo escenarios no-base, recortado a la ventana de proyección).
      const convenioMovements = isBase
        ? []
        : buildConvenioPaymentMovements({
          scenarioId,
          startDate: yearStart,
          endDate: yearEnd,
          asOfDate: today,
        });
      // Fideicomiso Dina: ingreso Corning real (Bajío) + egreso DINA mensual.
      // Mismo invariante/patrón que convenio (solo no-base, ventana recortada).
      const fideicomisoMovements = isBase
        ? []
        : buildFideicomisoMovements({
          scenarioId,
          startDate: yearStart,
          endDate: yearEnd,
          asOfDate: today,
          bajioStatements: props.bajioStatements ?? [],
        });
      const movementsWithTax = [...adjustedMovements, ...taxMovements, ...convenioMovements, ...fideicomisoMovements];
      const supplierSchedule = scheduleSupplierPaymentsByScore({
        movements: movementsWithTax,
        providers: props.providers,
        startDate: today,
        endDate: yearEnd,
        initialCash: supplierInitialCash,
        minimumCash,
        scenarioId,
      });
      const projection = calculateBaseProjection(supplierSchedule.movements, {
        startDate: yearStart,
        endDate: yearEnd,
        initialCash,
        minimumCash,
        granularity,
        scenarioId,
        name: scenarios.find((s) => s.id === scenarioId)?.name ?? scenarioId,
      });
      return { ...projection, supplierPlan: supplierSchedule.plan };
      })();
      // eslint-disable-next-line no-console
      console.info(`[planning.scenarioRun] scenarioId=${scenarioId} ${(performance.now() - t0).toFixed(0)}ms · movements=${result.movements.length}`);
      return result;
    });
  };

  // Approved baseline used for diff reference.
  const approvedRun = useMemo(
    () => buildScenarioRun(approvedScenario.id, true),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [approvedScenario.id, sharedRunInputsKey],
  );

  const baseRun = useMemo(
    () => buildScenarioRun(baseScenario.id, true),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseScenario.id, sharedRunInputsKey],
  );

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
    [activeScenario.id, approvedScenario.id, baseScenario.id, approvedRun, baseRun, sharedRunInputsKey],
  );

  const activeOverrides = useMemo(
    () => cellOverrides.filter((override) => override.scenarioId === activeScenarioId),
    [cellOverrides, activeScenarioId],
  );
  const activeCustomRows = useMemo(
    () => customRows.filter((row) => row.scenarioId === activeScenarioId),
    [customRows, activeScenarioId],
  );

  const rows = useMemo(
    () => buildPlanningRows({
      movements: activeRunRaw.movements,
      customRows: activeCustomRows,
      overrides: activeOverrides,
    }),
    [activeRunRaw.movements, activeCustomRows, activeOverrides],
  );

  const activeRun = useMemo(() => {
    const buckets = applyCellOverridesToBuckets({
      buckets: activeRunRaw.buckets,
      overrides: activeOverrides,
      movements: activeRunRaw.movements,
      rows,
      granularity,
      conceptKeyForMovement,
      asOfDate: today,
      initialCash,
    });
    return {
      ...activeRunRaw,
      buckets,
      summary: summarizeBucketsForScenario(buckets, activeRunRaw.movements, minimumCash, granularity),
      supplierPlan: activeRunRaw.supplierPlan,
    };
  }, [activeRunRaw, activeOverrides, rows, granularity, today, initialCash, minimumCash]);
  const probabilistic = useProbabilisticForecast(activeRun, activeRun.summary.minimumCashRequired);

  // Approved overrides for the diff and merge logic
  const approvedOverrides = useMemo(
    () => cellOverrides.filter((override) => override.scenarioId === approvedScenario.id),
    [cellOverrides, approvedScenario.id],
  );

  const approvedRunWithOverrides = useMemo(() => {
    const approvedCustomRowsScoped = customRows.filter((row) => row.scenarioId === approvedScenario.id);
    const approvedRows = buildPlanningRows({
      movements: approvedRun.movements,
      customRows: approvedCustomRowsScoped,
      overrides: approvedOverrides,
    });
    const buckets = applyCellOverridesToBuckets({
      buckets: approvedRun.buckets,
      overrides: approvedOverrides,
      movements: approvedRun.movements,
      rows: approvedRows,
      granularity,
      conceptKeyForMovement,
      asOfDate: today,
      initialCash,
    });
    return {
      ...approvedRun,
      buckets,
      summary: summarizeBucketsForScenario(buckets, approvedRun.movements, minimumCash, granularity),
      supplierPlan: approvedRun.supplierPlan,
    };
  }, [approvedRun, approvedOverrides, customRows, approvedScenario.id, granularity, today, initialCash, minimumCash]);

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
    const dates = buildBucketDates(yearStart, yearEnd, granularity);
    const todayKey = bucketKeyForDate(today, granularity);
    return dates.map((date) => ({
      key: date,
      label: engineBucketLabel(date, granularity),
      isPast: date < todayKey,
      isCurrent: date === todayKey,
    }));
  }, [granularity, yearStart, yearEnd, today]);

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
    if (!confirm('¿Descartar este borrador? Esta acción no se puede deshacer.')) return;
    const now = new Date().toISOString();
    setStoredScenarios((current) => current.map((s) => (s.id === scenarioId ? { ...s, archivedAt: now, updatedAt: now } : s)));
    setActiveScenarioId(approvedScenario.id);
    setStatusMessage('Borrador descartado.');
  };

  const draftEntries = changeLog.filter((entry) => entry.scenarioId === activeScenarioId);

  // ------- Merge flow ---------
  const mergeDiff: MergeDiffEntry[] = useMemo(() => {
    if (!mergeOpen) return [];
    const draft = scenarios.find((s) => s.id === mergeOpen);
    if (!draft) return [];
    const draftOverrides = cellOverrides.filter((o) => o.scenarioId === draft.id);
    const draftCustomScoped = customRows.filter((r) => r.scenarioId === draft.id);
    const approvedCustomScoped = customRows.filter((r) => r.scenarioId === approvedScenario.id);
    const allRows = buildPlanningRows({
      movements: approvedRun.movements,
      customRows: [...approvedCustomScoped, ...draftCustomScoped],
      overrides: [...approvedOverrides, ...draftOverrides],
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
      rowLabelLookup: (key) => labelByKey.get(key) ?? key,
      bucketLabelLookup: (key, gran) => engineBucketLabel(key, gran),
      approvedAggregateLookup: (key, bucketKey, gran) => {
        const aggKey = `${key}::${bucketKey}::${gran}`;
        return approvedAggregateMap.get(aggKey) ?? 0;
      },
    });
  }, [mergeOpen, scenarios, cellOverrides, customRows, approvedScenario, approvedOverrides, approvedRun, granularity]);

  const handleConfirmMerge = (args: { selectedKeys: MergeDiffEntry[]; archiveDraft: boolean }) => {
    if (!mergeOpen) return;
    const draft = scenarios.find((s) => s.id === mergeOpen);
    if (!draft) return;
    const draftOverrides = cellOverrides.filter((o) => o.scenarioId === draft.id);
    const draftCustomScoped = customRows.filter((r) => r.scenarioId === draft.id);
    const approvedCustomScoped = customRows.filter((r) => r.scenarioId === approvedScenario.id);
    const result = applyMerge({
      approved: approvedScenario,
      draft,
      scenarios,
      approvedOverrides,
      draftOverrides,
      allOverrides: cellOverrides,
      approvedCustomRows: approvedCustomScoped,
      draftCustomRows: draftCustomScoped,
      allCustomRows: customRows,
      manualEntries,
      changeLog,
      selectedKeys: args.selectedKeys.map((entry) => ({
        conceptKey: entry.conceptKey,
        bucketKey: entry.bucketKey,
        granularity: entry.granularity,
      })),
      archiveDraft: args.archiveDraft,
      user: USER,
    });
    setStoredScenarios(result.scenarios);
    setCellOverrides(result.cellOverrides);
    setCustomRows(result.customRows);
    setManualEntries(result.manualEntries);
    setChangeLog(result.changeLog);
    if (result.auditEvents.length > 0) {
      const previous = loadPlanningAudit([]);
      savePlanningAudit([...result.auditEvents, ...previous]);
    }
    setMergeOpen(null);
    setActiveScenarioId(approvedScenario.id);
    setStatusMessage(`Merge aplicado: ${args.selectedKeys.length} cambio${args.selectedKeys.length === 1 ? '' : 's'}.`);
  };

  // ------- KPIs ---------
  const summary = activeRun.summary;
  const finalCashDelta = activeRun.summary.finalCash - approvedRunWithOverrides.summary.finalCash;
  const isDraft = activeScenario.kind === 'DRAFT';

  const finalCashFor = (scenarioId: string): number => {
    if (scenarioId === activeScenario.id) return activeRun.summary.finalCash;
    if (scenarioId === approvedScenario.id) return approvedRunWithOverrides.summary.finalCash;
    if (scenarioId === baseScenario.id) return baseRun.summary.finalCash;
    return 0;
  };

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
        onSelect={setActiveScenarioId}
        onCreateDraft={handleCreateDraft}
        onDuplicateDraft={handleDuplicateDraft}
        onRenameDraft={handleRenameDraft}
        onDiscardDraft={handleDiscardDraft}
      />

      {scenarios.filter((s) => s.kind === 'DRAFT' && !s.archivedAt).length === 0 && (
        <FirstSimulationNudge onCreateDraft={handleCreateDraft} />
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <KpiCard
          label="Caja final"
          value={fmtCurrency(summary.finalCash)}
          icon={<Wallet className="w-4 h-4" />}
          color={toneByFloor(summary.finalCash, summary.minimumCashRequired)}
          sublabel={`12 meses · mínimo ${fmtCompact(summary.minimumCashRequired)}`}
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
          sublabel={isDraft ? 'Borrador activo' : 'Misma referencia'}
        />
      </div>

      <ProbabilisticRiskStrip
        run={probabilistic.run}
        loading={probabilistic.loading}
        error={probabilistic.error}
      />

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
        onClickRow={(conceptKey) => setSelectedCell({ conceptKey, bucketKey: columns.find((column) => column.isCurrent)?.key ?? columns[0]?.key ?? yearStart })}
        onInspectCell={(conceptKey, bucketKey) => setSelectedCell({ conceptKey, bucketKey })}
        onReadOnlyAttempt={() => setStatusMessage('Solo lectura. Crea una propuesta para editar.')}
      />

      {drawerOpen && selectedCell ? (
        <PlanningCellDetailPanel
          movements={selectedCellMovements}
          scenarioName={activeScenario.name}
          bucketLabel={engineBucketLabel(selectedCell.bucketKey, granularity)}
          onSelectMovement={(movement) => {
            setDetailMovement(movement);
            setDetailAnchor(null);
          }}
          onClose={() => setSelectedCell(null)}
        />
      ) : (
        <ChangeLogDrawer
          open={drawerOpen}
          scenarioName={activeScenario.name}
          entries={draftEntries}
          onClose={() => setDrawerOpen(false)}
        />
      )}

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
        draftFinalCash={mergeOpen ? finalCashFor(mergeOpen) : 0}
        approvedFinalCash={approvedRunWithOverrides.summary.finalCash}
        draftDeficitDays={mergeOpen ? activeRun.summary.deficitDays : 0}
        approvedDeficitDays={approvedRunWithOverrides.summary.deficitDays}
        onClose={() => setMergeOpen(null)}
        onConfirm={handleConfirmMerge}
      />

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
}: {
  value: T;
  onChange: (next: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <div className="inline-flex h-10 rounded-[var(--radius)] border border-[var(--gray-200)] bg-[var(--gray-50)] p-0.5">
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

function PlanningCellDetailPanel({
  movements,
  scenarioName,
  bucketLabel,
  onSelectMovement,
  onClose,
}: {
  movements: FinancialMovement[];
  scenarioName: string;
  bucketLabel: string;
  onSelectMovement: (movement: FinancialMovement) => void;
  onClose: () => void;
}) {
  const inflows = movements.filter((movement) => movement.type === 'INFLOW');
  const outflows = movements.filter((movement) => movement.type === 'OUTFLOW');
  const total = movements.reduce((sum, movement) => sum + effectiveAmount(movement), 0);
  return (
    <aside className="rounded-2xl border border-[var(--gray-200)] bg-white">
      <header className="flex items-start justify-between border-b border-[var(--gray-200)] px-4 py-3">
        <div>
          <h3 className="text-[13px] font-semibold text-[var(--gray-950)]">Detalle de celda</h3>
          <p className="mt-1 text-[11px] text-[var(--gray-500)]">{scenarioName} · {bucketLabel}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-[11px] font-medium text-[var(--gray-500)] hover:text-[var(--gray-950)]"
        >
          Cerrar
        </button>
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
                    <div className="truncate text-[12px] font-semibold text-[var(--gray-950)]">
                      {movement.counterpartyName ?? movement.concept}
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

function minimumCashFor(): number {
  const fallback = 20_000_000;
  return fallback;
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
