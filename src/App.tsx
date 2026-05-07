import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react';
import { TabId, CashFlowOverrides } from './types';
import { Provider, Client, CashFlowAssumptions, ConfirmedPayment } from './domain/types';
import { MidasStore, loadStore, saveStore, exportStore, CXPRecord } from './domain/persistence';
import { fetchClientCatalog, fetchProviderCatalog } from './services/catalog.service';
import {
  fetchCompanies,
  fetchBankStatements,
  fetchBankStatementsRange,
  fetchAgedBalances,
  fetchCobranza,
  fetchIndicadoresCobranza,
  type Company,
  type BankAccountStatement,
  type BankStatementFormat,
  type CobranzaPayment,
  type CobranzaRecord,
} from './services/jde';

const FIXED_STARTING_BALANCE = 76_300_000;
// Lazy-loaded so the projection module's Recharts + canonical engine is
// not in the initial App bundle. This is the single largest chunk in the
// build — keeping it out of first paint cuts the dashboard's first
// interaction-time noticeably on cold loads.
const Providers = lazy(() => import('./components/Providers'));
const Clients = lazy(() => import('./components/Clients'));
const Dashboard = lazy(() => import('./components/Dashboard'));
const CashFlowDetail = lazy(() => import('./components/CashFlowDetail'));
const CXP = lazy(() => import('./components/CXP'));
const Bancos = lazy(() => import('./components/Bancos'));
const CollectionProjection = lazy(() => import('./components/CollectionProjection'));
const FinancialProjectionDashboard = lazy(() => import('./modules/financial-projection/pages/FinancialProjectionDashboard'));
const FinancialPlanningDashboard = lazy(() => import('./modules/financial-planning/pages/FinancialPlanningDashboard'));
const TaxDashboard = lazy(() => import('./modules/taxes/pages/TaxDashboard'));
import ErrorBoundary from './components/ErrorBoundary';
import MidasSplash, { type BootStep } from './components/MidasSplash';
import { ActivityFeedPanel } from './components/ActivityFeed';
import { useCommandPalette } from './components/CommandPalette';
import CommandPalette, { type CommandPaletteAction } from './components/CommandPalette';
import { loadPlanningScenarios, loadPlanningAdjustments } from './modules/financial-planning/services/financialPlanningStorage';
import { KeyboardShortcutsModal, useKeyboardShortcuts } from './components/KeyboardShortcuts';
import {
  LayoutDashboard,
  Users, UserSquare, Download,
  Building2, Loader2, ChevronDown, AlertCircle, Landmark, Check,
  HandCoins, ChevronRight, BookUser, Activity, TrendingUp,
  Receipt, Wallet, FolderPlus, Pencil, Trash2, X, FolderOpen,
  Bell, ClipboardList, BarChart3,
  type LucideIcon,
} from 'lucide-react';
import { CompanyGroup, loadCompanyGroups, saveCompanyGroups, newGroupId, GROUP_COLORS, resolveActiveCias } from './domain/companyGroups';
import type { Budget } from './domain/budget';
import { parseBudgetCsv } from './domain/budget';
import { loadBudget, saveBudget } from './domain/budgetPersistence';
import {
  attachImportedStatementsToKnownCompanies,
  excludeBajio,
  mergeBankStatements,
  type BankQueryState,
} from './domain/bankStatements';
import { SANTANDER_FILE_FORMAT } from './domain/santanderCsv';
import {
  type AbonoEnrichment,
  type RealReconciliationMatch,
  type RealReconciliationResult,
} from './domain/realReconciliationEngine';
import {
  applyManualConfirmations,
  useConfirmedReviewKeys,
} from './domain/reconciliationConfirmations';
import type { RealReconciliationWorkerResponse } from './workers/realReconciliationWorkerTypes';

const DEFAULT_BUDGET_CSV_URL = `${import.meta.env.BASE_URL}presupuesto.csv`;
const STORE_SAVE_DEBOUNCE_MS = 900;
const BANK_STORAGE_SAVE_DEBOUNCE_MS = 1200;
const COBRANZA_AUTO_REFRESH_TTL_MS = 6 * 60 * 60 * 1000;
const CXP_AUTO_REFRESH_TTL_MS = 6 * 60 * 60 * 1000;
// Tabs que dependen del cruce JDE↔banco para mostrar números correctos.
// Proyección / Planeación / Impuestos consumen `cobranzaReconciliation`
// vía `buildFinancialProjectionSourceData` para no doblar facturas
// CXC ya cobradas. Si no se calcula al entrar a esos tabs, el primer
// render de la proyección queda con cobranza inflada hasta que el
// usuario regresa a Cobranza/Bancos/Dashboard.
const RECONCILIATION_TABS = new Set<TabId>([
  'dashboard',
  'collections',
  'bancos',
  'financialProjection',
  'financialPlanning',
  'taxes',
]);

type SectionId = 'catalogos' | 'operacion' | 'proyeccion';

const SECTIONS: { id: SectionId; label: string; icon: LucideIcon; description: string }[] = [
  { id: 'catalogos',  label: 'Catálogos',   icon: BookUser,        description: 'Clientes y proveedores' },
  { id: 'operacion',  label: 'Operación',   icon: Activity,        description: 'Flujo neto, CXP, cobranza y bancos' },
  { id: 'proyeccion', label: 'Proyección',  icon: TrendingUp,      description: 'Dashboard, pronóstico y escenarios' },
];

const SUB_TABS: Record<SectionId, { id: TabId; label: string; icon: LucideIcon }[]> = {
  catalogos: [
    { id: 'clients',   label: 'Clientes',     icon: UserSquare },
    { id: 'providers', label: 'Proveedores',  icon: Users },
  ],
  operacion: [
    { id: 'netflow',     label: 'Flujo Neto',  icon: Wallet },
    { id: 'cxp',         label: 'CXP',         icon: Receipt },
    { id: 'collections', label: 'Cobranza',    icon: HandCoins },
    { id: 'bancos',      label: 'Bancos',      icon: Landmark },
  ],
  proyeccion: [
    { id: 'dashboard',   label: 'Dashboard',   icon: LayoutDashboard },
    { id: 'financialProjection', label: 'Proyección Financiera', icon: BarChart3 },
    { id: 'financialPlanning', label: 'Planeación Financiera', icon: ClipboardList },
    { id: 'taxes', label: 'Impuestos', icon: Landmark },
  ],
};

const SECTION_FOR_TAB: Partial<Record<TabId, SectionId>> = {
  clients: 'catalogos', providers: 'catalogos',
  netflow: 'operacion', bancos: 'operacion',
  cxp: 'operacion', collections: 'operacion',
  dashboard: 'proyeccion',
  financialProjection: 'proyeccion', financialPlanning: 'proyeccion', taxes: 'proyeccion',
};

const DEFAULT_TAB: Record<SectionId, TabId> = {
  catalogos: 'clients',
  operacion: 'netflow',
  proyeccion: 'dashboard',
};

/**
 * Identifica si el cache de bankStatements contiene registros demo/ficticios
 * que se hayan quedado de versiones anteriores del app. Los demo statements
 * legacy usaban referencias y conceptos muy específicos (TRF-001, PAG-055,
 * "PAGO PROVEEDORES DIESEL", etc.) que nunca aparecen en JDE real — basta con
 * detectar uno para descartar el cache completo y no mezclar ficticio con
 * real en el flujo.
 */
const DEMO_BANK_REFS = new Set([
  'TRF-001', 'TRF-002', 'TRF-003',
  'DEP-100', 'PAG-055',
  'COB-220', 'PAG-120',
  'WIRE-01', 'WIRE-02',
]);
const DEMO_BANK_CONCEPTS = [
  'PAGO CLIENTES NORTE',
  'PAGO NOMINA QUINCENAL',
  'COBRO FACTURA 2024-1150',
  'DEPOSITO COBRANZA SUR',
  'PAGO PROVEEDORES DIESEL',
  'COBRANZA CLIENTES CITI',
  'PAGO REFACCIONES',
  'COBRO CROSS-BORDER LAREDO',
  'PAGO SEGURO INTERNACIONAL',
];
/**
 * Quiet placeholder shown while a lazy-loaded tab module is fetched. Matches
 * the page chrome (header + KPI grid + section cards) so first paint after
 * code-split is layout-stable. No spinner, no marketing copy — just the
 * skeleton chassis the user is about to interact with.
 */
function LazyTabFallback({ label }: { label: string }) {
  return (
    <div className="space-y-4 animate-page-in" aria-busy="true" aria-label={`Cargando ${label}`}>
      <div className="flex items-center justify-between">
        <div>
          <div className="skeleton h-4 w-44 rounded opacity-60" />
          <div className="skeleton mt-2 h-3 w-64 rounded opacity-50" />
        </div>
        <div className="skeleton h-10 w-48 rounded-[var(--radius)] opacity-50" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, idx) => (
          <div key={idx} className="rounded-[var(--radius)] border border-[var(--gray-200)] bg-white p-4">
            <div className="skeleton h-3 w-1/2 rounded opacity-50" />
            <div className="skeleton mt-3 h-5 w-3/4 rounded opacity-60" />
            <div className="skeleton mt-2 h-3 w-2/3 rounded opacity-40" />
          </div>
        ))}
      </div>
      <div className="rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-white p-4">
        <div className="skeleton h-3 w-40 rounded opacity-50" />
        <div className="skeleton mt-3 h-[280px] w-full rounded-[var(--radius)] opacity-50" />
      </div>
    </div>
  );
}

function containsDemoBankData(statements: BankAccountStatement[] | undefined | null): boolean {
  if (!statements || statements.length === 0) return false;
  for (const acc of statements) {
    for (const mov of acc.movimientos ?? []) {
      const ref = (mov.referencia ?? '').trim();
      if (ref && DEMO_BANK_REFS.has(ref)) return true;
      const concepto = (mov.concepto ?? '').trim().toUpperCase();
      if (concepto && DEMO_BANK_CONCEPTS.includes(concepto)) return true;
    }
  }
  return false;
}

function emptyRealReconciliationResult(): RealReconciliationResult {
  return {
    matches: [],
    abonoEnrichments: [],
    paymentReconciliations: [],
    summary: {
      totalFacturas: 0,
      facturasCobradasBanco: 0,
      facturasCobradasJdeSinBanco: 0,
      facturasPendientes: 0,
      totalSaldoBruto: 0,
      totalSaldoPendiente: 0,
      totalCobradoBanco: 0,
      totalAbonos: 0,
      totalAbonoMonto: 0,
      abonosFacturaCobrada: 0,
      abonosSinFactura: 0,
      abonosTraspasoInterno: 0,
      pctAbonosCruzados: 0,
      pctFacturasCruzadas: 0,
      ciaBreakdown: [],
    },
    reviewCandidates: [],
    bankCoverage: {
      loadedDates: [],
      totalMovements: 0,
      totalAbonos: 0,
    },
    timingsMs: {
      totalMs: 0,
      indexMs: 0,
      matchMs: 0,
    },
  };
}

function buildFacturaIndex(
  matches: RealReconciliationMatch[],
): Map<string, RealReconciliationMatch> {
  const map = new Map<string, RealReconciliationMatch>();
  for (const m of matches) {
    map.set(`${m.cia}::${m.noFactura}`, m);
  }
  return map;
}

function buildAbonoIndex(
  enrichments: AbonoEnrichment[],
): Map<string, AbonoEnrichment> {
  const map = new Map<string, AbonoEnrichment>();
  for (const e of enrichments) {
    map.set(e.movementKey, e);
  }
  return map;
}

function isFreshTimestamp(value: string | undefined, ttlMs: number): boolean {
  if (!value) return false;
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < ttlMs;
}

type IdleWindow = Window & {
  requestIdleCallback?: (cb: IdleRequestCallback, options?: IdleRequestOptions) => number;
  cancelIdleCallback?: (id: number) => void;
};

interface EnsureBankCoverageRequest {
  from: string;
  to: string;
  ciaFilter?: string[];
}

function scheduleIdleTask(callback: () => void, timeout = 2000): () => void {
  if (typeof window === 'undefined') {
    callback();
    return () => {};
  }
  const idleWindow = window as IdleWindow;
  let cancelled = false;
  if (idleWindow.requestIdleCallback) {
    const id = idleWindow.requestIdleCallback(() => {
      if (!cancelled) callback();
    }, { timeout });
    return () => {
      cancelled = true;
      idleWindow.cancelIdleCallback?.(id);
    };
  }
  const id = window.setTimeout(() => {
    if (!cancelled) callback();
  }, 0);
  return () => {
    cancelled = true;
    window.clearTimeout(id);
  };
}

export default function App() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [assumptions, setAssumptions] = useState<CashFlowAssumptions>({
    year: new Date().getFullYear(),
    globalCompliance: 1,
    factorajeDays: 30,
  });
  const [confirmedPayments, setConfirmedPayments] = useState<ConfirmedPayment[]>([]);
  const [budget, setBudget] = useState<Budget | null>(() => loadBudget());

  useEffect(() => { saveBudget(budget); }, [budget]);

  // Carga automática del CSV de presupuesto empaquetado en `public/presupuesto.csv`.
  // Si el archivo existe y parsea bien, sobrescribe el budget cacheado — así el
  // usuario no tiene que volver a subir el CSV manualmente cada vez. Si falla
  // (404, parser error, red), dejamos el budget que ya estuviera en localStorage.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(DEFAULT_BUDGET_CSV_URL, { cache: 'no-cache' });
        if (!res.ok) return;
        const text = await res.text();
        const r = parseBudgetCsv(text, { fileName: 'presupuesto.csv' });
        if (!cancelled && r.budget) setBudget(r.budget);
      } catch { /* sin red o sin archivo → conservamos lo que hubiera en cache */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const [cxpRecords, setCxpRecords] = useState<CXPRecord[]>([]);
  const [cxpLoadedCias, setCxpLoadedCias] = useState<Record<string, string>>({});
  // Cobranza (CXC) — endpoint /v1/erp/tesoreria/cobranza, liberado a
  // producción 2026-05-01. Mismo patrón que cxpRecords: cache en localStorage
  // a través de MidasStore (v8), refresh secuencial por cia, último año
  // (fechaInicial = hoy - 365d).
  const [cobranzaRecords, setCobranzaRecords] = useState<CobranzaRecord[]>([]);
  const [cobranzaLoadedCias, setCobranzaLoadedCias] = useState<Record<string, string>>({});
  const [cobranzaPayments, setCobranzaPayments] = useState<CobranzaPayment[]>([]);
  const [cobranzaPaymentsLoadedCias, setCobranzaPaymentsLoadedCias] = useState<Record<string, string>>({});
  // Status del auto/manual fetch de cobranza — se muestra en la pestaña
  // Cobranza para que el usuario sepa qué pasó si la lista llega vacía.
  // Antes los errores eran silenciados y resultaba imposible diagnosticar
  // 0% de cruce sin abrir DevTools.
  const [cobranzaError, setCobranzaError] = useState<string | null>(null);
  const [cobranzaRefreshing, setCobranzaRefreshing] = useState(false);
  const [cashFlowOverrides, setCashFlowOverrides] = useState<CashFlowOverrides>({});
  const [activeTab, setActiveTab] = useState<TabId>('netflow');
  const [catalogLoaded, setCatalogLoaded] = useState(false);

  // ── Boot splash state ──
  const [bootStep, setBootStep] = useState<BootStep>('init');
  const [isBooted, setIsBooted] = useState(false);
  const [splashMounted, setSplashMounted] = useState(true);

  // ── JDE integration state ──
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyGroups, setCompanyGroups] = useState<CompanyGroup[]>(() => loadCompanyGroups());
  const [selectedCia, setSelectedCia] = useState<string>(
    () => localStorage.getItem('midas.selectedCia') ?? 'all'
  );

  // Persist company groups
  useEffect(() => { saveCompanyGroups(companyGroups); }, [companyGroups]);
  const [companiesLoading, setCompaniesLoading] = useState(false);
  const [companiesError, setCompaniesError] = useState<string | null>(null);
  const [bankJdeStatements, setBankJdeStatements] = useState<BankAccountStatement[]>(() => {
    try {
      const rawQuery = localStorage.getItem('midas.bankLastQuery.v2');
      const parsedQuery = rawQuery ? (JSON.parse(rawQuery) as BankQueryState) : null;
      const raw = localStorage.getItem('midas.bankStatements.v2');
      const parsed = raw ? (JSON.parse(raw) as BankAccountStatement[]) : [];
      // Descartar demo data ficticia que pudo haber quedado cacheada de
      // versiones previas. Si detectamos CUALQUIER referencia demo dentro
      // del cache, lo tiramos entero — no vale la pena mezclar ficticio con
      // real en el flujo.
      if (containsDemoBankData(parsed)) {
        localStorage.removeItem('midas.bankStatements.v2');
        localStorage.removeItem('midas.bankLastQuery.v2');
        localStorage.removeItem('midas.bankSupplementalStatements.v1');
        return [];
      }
      if (parsedQuery?.formatoElectronico === SANTANDER_FILE_FORMAT) return [];
      return parsed;
    } catch { return []; }
  });
  const [bankSupplementalStatements, setBankSupplementalStatements] = useState<BankAccountStatement[]>(() => {
    try {
      const rawCurrent = localStorage.getItem('midas.bankSupplementalStatements.v1');
      if (rawCurrent) {
        const parsedCurrent = JSON.parse(rawCurrent) as BankAccountStatement[];
        if (!containsDemoBankData(parsedCurrent)) return parsedCurrent;
        localStorage.removeItem('midas.bankSupplementalStatements.v1');
      }

      const rawQuery = localStorage.getItem('midas.bankLastQuery.v2');
      const parsedQuery = rawQuery ? (JSON.parse(rawQuery) as BankQueryState) : null;
      if (parsedQuery?.formatoElectronico !== SANTANDER_FILE_FORMAT) return [];

      const rawLegacy = localStorage.getItem('midas.bankStatements.v2');
      const parsedLegacy = rawLegacy ? (JSON.parse(rawLegacy) as BankAccountStatement[]) : [];
      if (containsDemoBankData(parsedLegacy)) return [];
      return parsedLegacy;
    } catch { return []; }
  });
  const [bankLastQuery, setBankLastQuery] = useState<BankQueryState | null>(() => {
    try {
      const raw = localStorage.getItem('midas.bankLastQuery.v2');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as BankQueryState;
      if (parsed.formatoElectronico === SANTANDER_FILE_FORMAT) {
        return { ...parsed, hasUploadedSantander: true };
      }
      const hasSupplemental = !!localStorage.getItem('midas.bankSupplementalStatements.v1');
      return hasSupplemental ? { ...parsed, hasUploadedSantander: true } : parsed;
    } catch { return null; }
  });
  const bankStatements = useMemo(
    () => mergeBankStatements(bankJdeStatements, bankSupplementalStatements),
    [bankJdeStatements, bankSupplementalStatements],
  );
  // BAJIO se exhibe en la pestaña Bancos pero no se contabiliza ni se proyecta:
  // el excedente cae siempre en Banamex, así que incluirlo duplica flujo.
  const accountableBankStatements = useMemo(
    () => excludeBajio(bankStatements),
    [bankStatements],
  );
  // ── Cruce cobranza ↔ bancos (compartido) ──────────────────────────────
  // Es un motor pesado (texto + subset-sum), así que no corre durante render.
  // Lo diferimos a idle y sólo cuando una pestaña lo necesita; así cargar JDE
  // no congela la plataforma ni bloquea el primer paint.
  const [rawCobranzaReconciliation, setCobranzaReconciliation] = useState<RealReconciliationResult>(
    () => emptyRealReconciliationResult(),
  );
  const confirmedReviewKeys = useConfirmedReviewKeys();
  const cobranzaReconciliation = useMemo(
    () => applyManualConfirmations(rawCobranzaReconciliation, confirmedReviewKeys),
    [rawCobranzaReconciliation, confirmedReviewKeys],
  );
  const shouldComputeCobranzaReconciliation =
    (cobranzaRecords.length > 0 || cobranzaPayments.length > 0) && RECONCILIATION_TABS.has(activeTab);
  const activeReconciliationCias = useMemo(() => {
    if (selectedCia === 'all') return undefined;
    const allCias = companies.filter(c => c.activa !== false).map(c => c.cia);
    const resolved = resolveActiveCias(selectedCia, companyGroups, allCias);
    return resolved.length > 0 ? resolved : undefined;
  }, [selectedCia, companies, companyGroups]);
  const activeReconciliationCiaKey = activeReconciliationCias?.join('|') ?? 'all';
  const reconciliationWorkerRef = useRef<Worker | null>(null);
  const reconciliationJobRef = useRef(0);
  useEffect(() => {
    if (cobranzaRecords.length === 0 && cobranzaPayments.length === 0) {
      setCobranzaReconciliation(emptyRealReconciliationResult());
      return;
    }
    if (!shouldComputeCobranzaReconciliation) return;

    let cancelled = false;
    const jobId = ++reconciliationJobRef.current;
    const cancelIdle = scheduleIdleTask(() => {
      const runFallback = () => {
        void import('./domain/realReconciliationEngine')
          .then(({ reconcileRealCollections }) => {
            if (cancelled || reconciliationJobRef.current !== jobId) return;
            const result = reconcileRealCollections(cobranzaRecords, accountableBankStatements, {
              ciaFilter: activeReconciliationCias?.length ? new Set(activeReconciliationCias) : undefined,
              cobranzaPayments,
            });
            if (!cancelled && reconciliationJobRef.current === jobId) setCobranzaReconciliation(result);
          });
      };

      if (typeof Worker === 'undefined') {
        runFallback();
        return;
      }

      try {
        if (!reconciliationWorkerRef.current) {
          reconciliationWorkerRef.current = new Worker(
            new URL('./workers/realReconciliation.worker.ts', import.meta.url),
            { type: 'module' },
          );
        }
        const worker = reconciliationWorkerRef.current;
        worker.onmessage = (event: MessageEvent<RealReconciliationWorkerResponse>) => {
          if (cancelled || event.data.jobId !== reconciliationJobRef.current) return;
          if (event.data.result) setCobranzaReconciliation(event.data.result);
          else runFallback();
        };
        worker.onerror = () => {
          if (!cancelled && reconciliationJobRef.current === jobId) runFallback();
        };
        worker.postMessage({
          jobId,
          cobranzaRecords,
          cobranzaPayments,
          bankStatements: accountableBankStatements,
          ciaFilter: activeReconciliationCias,
        });
      } catch {
        runFallback();
      }
    }, 1500);

    return () => {
      cancelled = true;
      cancelIdle();
    };
  }, [cobranzaRecords, cobranzaPayments, accountableBankStatements, shouldComputeCobranzaReconciliation, activeReconciliationCiaKey]);
  useEffect(() => {
    return () => {
      reconciliationWorkerRef.current?.terminate();
      reconciliationWorkerRef.current = null;
    };
  }, []);
  const cobranzaFacturaIndex = useMemo(
    () => buildFacturaIndex(cobranzaReconciliation.matches),
    [cobranzaReconciliation],
  );
  const cobranzaAbonoIndex = useMemo(
    () => buildAbonoIndex(cobranzaReconciliation.abonoEnrichments),
    [cobranzaReconciliation],
  );
  // UI status for the auto/manual bank refresh — shown as a pill in Flujo Neto.
  const [bankFetchStatus, setBankFetchStatus] = useState<
    'idle' | 'priming' | 'ranging'
  >('idle');
  const [bankFetchProgress, setBankFetchProgress] = useState<
    { done: number; total: number } | null
  >(null);
  const [bankCoverageLoading, setBankCoverageLoading] = useState(false);

  // Caja inicial fija — decisión de negocio, no editable por el usuario.
  const effectiveStartingBalance = FIXED_STARTING_BALANCE;

  const confirmPayment = (p: ConfirmedPayment) => setConfirmedPayments(prev => [...prev, p]);
  const unconfirmPayment = (key: string) => setConfirmedPayments(prev => prev.filter(x => x.key !== key));

  // ── New UI features state ──
  const { open: cmdOpen, setOpen: setCmdOpen } = useCommandPalette();
  const [activityOpen, setActivityOpen] = useState(false);

  // Planning scenarios + adjustments for Cmd+K — refreshed on every palette open.
  const [paletteScenarios, setPaletteScenarios] = useState<{ id: string; name: string }[]>([]);
  const [paletteAdjustments, setPaletteAdjustments] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!cmdOpen) return;
    try {
      const scenarios = loadPlanningScenarios([]);
      setPaletteScenarios(
        scenarios
          .filter((s) => !s.archivedAt)
          .map((s) => ({ id: s.id, name: s.name })),
      );
      const adjustments = loadPlanningAdjustments([]);
      setPaletteAdjustments(adjustments.map((a) => ({ id: a.id, name: a.name })));
    } catch {
      setPaletteScenarios([]);
      setPaletteAdjustments([]);
    }
  }, [cmdOpen]);
  const paletteActions: CommandPaletteAction[] = useMemo(() => [
    {
      id: 'open-planning',
      label: 'Abrir Planeación Financiera',
      run: () => setActiveTab('financialPlanning'),
    },
    {
      id: 'create-draft',
      label: 'Nueva propuesta (borrador)',
      run: () => {
        setActiveTab('financialPlanning');
        window.dispatchEvent(new CustomEvent('midas:planning:createDraft'));
      },
    },
  ], []);

  const TAB_IDS: TabId[] = ['clients', 'providers', 'netflow', 'bancos', 'dashboard', 'financialProjection', 'financialPlanning', 'collections', 'cxp'];
  const { shortcutsOpen, setShortcutsOpen } = useKeyboardShortcuts({
    onTabSwitch: (n) => { if (n >= 1 && n <= TAB_IDS.length) setActiveTab(TAB_IDS[n - 1]); },
  });

  // Load from persistence on mount
  useEffect(() => {
    const stored = loadStore();
    if (stored) {
      if (stored.providers.length) setProviders(stored.providers);
      if (stored.clients.length) setClients(stored.clients);
      if (stored.confirmedPayments.length) setConfirmedPayments(stored.confirmedPayments);
      if (stored.cxpRecords.length) setCxpRecords(stored.cxpRecords);
      if (stored.cxpLoadedCias) setCxpLoadedCias(stored.cxpLoadedCias);
      if (stored.cobranzaRecords?.length) setCobranzaRecords(stored.cobranzaRecords);
      if (stored.cobranzaLoadedCias) setCobranzaLoadedCias(stored.cobranzaLoadedCias);
      if (stored.cobranzaPayments?.length) setCobranzaPayments(stored.cobranzaPayments);
      if (stored.cobranzaPaymentsLoadedCias) setCobranzaPaymentsLoadedCias(stored.cobranzaPaymentsLoadedCias);
      if (stored.cashFlowOverrides) setCashFlowOverrides(stored.cashFlowOverrides);
      setAssumptions(stored.assumptions);
      setCatalogLoaded(true);
    }
  }, []);

  // Catalog bootstrap tracking — splash waits for both bundled CSVs to settle.
  const [clientsCatalogDone, setClientsCatalogDone] = useState(false);
  const [providersCatalogDone, setProvidersCatalogDone] = useState(false);
  useEffect(() => {
    if (clientsCatalogDone && providersCatalogDone) setCatalogLoaded(true);
  }, [clientsCatalogDone, providersCatalogDone]);

  // Load clients from catalog if no clients exist yet
  useEffect(() => {
    if (catalogLoaded || clients.length > 0) {
      setClientsCatalogDone(true);
      return;
    }
    fetchClientCatalog()
      .then(loaded => {
        if (loaded.length > 0) {
          setClients(loaded);
          setCatalogLoaded(true);
        }
      })
      .catch(() => { /* deja la app boote igual */ })
      .finally(() => setClientsCatalogDone(true));
  }, [catalogLoaded, clients.length]);

  // Load/merge providers from the bundled catalog. The local catalog includes
  // Romo's provider type classification plus flexibility/DTI metadata.
  const providerCatalogMerged = useRef(false);
  useEffect(() => {
    if (providerCatalogMerged.current) return;
    providerCatalogMerged.current = true;
    fetchProviderCatalog()
      .then((loaded) => {
      if (loaded.length === 0) return;
      setProviders((current) => {
        if (current.length === 0) return loaded;

        const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toUpperCase();

        // Remove catalog-sourced providers that no longer exist in the updated
        // catalog (e.g. unclassified providers that were purged from the catalog).
        const catalogNames = new Set(loaded.map(p => normalize(p.name)));
        const filtered = current.filter(
          p => !p.id.startsWith('catalog-prov-') || catalogNames.has(normalize(p.name))
        );

        const filteredByName = new Map(filtered.map((provider, index) => [normalize(provider.name), { provider, index }]));
        const merged = [...filtered];
        let changed = filtered.length !== current.length;

        for (const catalogProvider of loaded) {
          const existing = filteredByName.get(normalize(catalogProvider.name));
          if (!existing) {
            merged.push(catalogProvider);
            changed = true;
            continue;
          }

          const currentType = existing.provider.type?.trim();
          const catalogType = catalogProvider.type?.trim();
          const isCatalogManaged = existing.provider.id.startsWith('catalog-prov-');
          const nextProvider = {
            ...existing.provider,
            type: (isCatalogManaged || !currentType || currentType === 'Otro' || currentType === 'Sin clasificar') && catalogType
              ? catalogType
              : existing.provider.type,
            risk: catalogProvider.risk,
            riskComment: catalogProvider.riskComment,
            paymentPeriod: catalogProvider.paymentPeriod,
            flexibility: catalogProvider.flexibility,
            flexibilityComment: catalogProvider.flexibilityComment,
            creditLimit: catalogProvider.creditLimit ?? existing.provider.creditLimit,
            lastUpdatedAt: catalogProvider.lastUpdatedAt,
            dtiArea: catalogProvider.dtiArea ?? existing.provider.dtiArea,
            dtiCriticidad: catalogProvider.dtiCriticidad ?? existing.provider.dtiCriticidad,
            clasificacionAlberto: catalogProvider.clasificacionAlberto,
            clasificacionAlbertoRaw: catalogProvider.clasificacionAlbertoRaw,
            clasificacionAutomatica: catalogProvider.clasificacionAutomatica,
            score: catalogProvider.score,
            scoreCriterios: catalogProvider.scoreCriterios,
            numProveedorJDE: catalogProvider.numProveedorJDE ?? existing.provider.numProveedorJDE,
            frecuenciaHistorica: catalogProvider.frecuenciaHistorica,
            montoPromedioPago: catalogProvider.montoPromedioPago,
            numPagos2025: catalogProvider.numPagos2025,
            montoTotal2025: catalogProvider.montoTotal2025,
            gastoMinimoMensual: catalogProvider.gastoMinimoMensual,
          };

          if (JSON.stringify(nextProvider) !== JSON.stringify(existing.provider)) {
            merged[existing.index] = nextProvider;
            changed = true;
          }
        }

        return changed ? merged : current;
      });
    })
      .catch(() => { /* deja la app boote igual */ })
      .finally(() => setProvidersCatalogDone(true));
  }, []);

  // Save to localStorage after changes. Debounce coalesces bursts, but we also
  // flush synchronously on tab hide/close so the last change never gets lost
  // if the user navigates away within the debounce window.
  const latestStoreRef = useRef<MidasStore | null>(null);
  useEffect(() => {
    const snapshot: MidasStore = {
      providers, clients,
      assumptions, confirmedPayments, cxpRecords, cxpLoadedCias,
      cobranzaRecords, cobranzaLoadedCias,
      cobranzaPayments, cobranzaPaymentsLoadedCias,
      cashFlowOverrides,
      lastSaved: new Date().toISOString(),
    };
    latestStoreRef.current = snapshot;
    let cancelIdle: (() => void) | null = null;
    const timer = window.setTimeout(() => {
      cancelIdle = scheduleIdleTask(() => saveStore(snapshot), 2500);
    }, STORE_SAVE_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      cancelIdle?.();
    };
  }, [
    providers, clients,
    assumptions, confirmedPayments, cxpRecords, cxpLoadedCias,
    cobranzaRecords, cobranzaLoadedCias,
    cobranzaPayments, cobranzaPaymentsLoadedCias,
    cashFlowOverrides,
  ]);

  useEffect(() => {
    const flush = () => {
      if (latestStoreRef.current) saveStore(latestStoreRef.current);
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  // ── JDE: load companies on mount (sin fallback demo) ──
  const loadCompanies = useCallback(async () => {
    setCompaniesLoading(true);
    setCompaniesError(null);
    try {
      const list = await fetchCompanies();
      setCompanies(list);
      if (list.length === 0) {
        setCompaniesError('JDE respondió vacío. Revisa conectividad con srv-desarrollo.');
      }
    } catch (e) {
      setCompaniesError(e instanceof Error ? e.message : 'No se pudo contactar JDE.');
      setCompanies([]);
    } finally {
      setCompaniesLoading(false);
    }
  }, []);

  useEffect(() => { loadCompanies(); }, [loadCompanies]);

  // ── Boot orchestrator: drives splash step + dismiss when critical path ready ──
  // Critical path: catalogs settled + JDE companies settled (success or error) +
  // short bank priming finished (status === 'idle'). Heavy JDE ranges and CXC
  // reconciliation now run on demand so the user can enter the app sooner.
  useEffect(() => {
    if (isBooted) return;
    if (!catalogLoaded) {
      setBootStep('catalog');
    } else if (companiesLoading) {
      setBootStep('jde');
    } else if (bankFetchStatus === 'priming' || bankFetchStatus === 'ranging') {
      setBootStep('banks');
    } else {
      setBootStep('ready');
    }

    const catalogDone = catalogLoaded;
    const companiesDone = !companiesLoading;
    const banksDone = bankFetchStatus === 'idle';
    if (catalogDone && companiesDone && banksDone) {
      const t = setTimeout(() => setIsBooted(true), 220);
      return () => clearTimeout(t);
    }
  }, [catalogLoaded, companiesLoading, bankFetchStatus, isBooted]);

  // Hard timeout — never trap the user behind the splash if JDE hangs.
  useEffect(() => {
    const t = setTimeout(() => setIsBooted(true), 30000);
    return () => clearTimeout(t);
  }, []);

  // Unmount splash after fade-out.
  useEffect(() => {
    if (!isBooted) return;
    const t = setTimeout(() => setSplashMounted(false), 280);
    return () => clearTimeout(t);
  }, [isBooted]);

  // ── Auto-load CXP (antigüedad de saldos) en background al abrir el app ──
  // Se dispara una sola vez por sesión en cuanto tenemos el catálogo de
  // compañías. El usuario ve el empty state de CXP sólo si esto falla para
  // todas las compañías activas; si al menos una responde, la vista se
  // llena sola sin pasar por "Consultar todas". Llamadas secuenciales
  // (ver comentario en CXP.loadAll) — JDE revienta en paralelo.
  const cxpAutoFetchDone = useRef(false);
  useEffect(() => {
    if (cxpAutoFetchDone.current) return;
    if (companies.length === 0) return;
    const activeCias = companies.filter(c => c.activa !== false).map(c => c.cia);
    if (activeCias.length === 0) return;
    const ciasToFetch = activeCias.filter(cia => !isFreshTimestamp(cxpLoadedCias[cia], CXP_AUTO_REFRESH_TTL_MS));
    if (ciasToFetch.length === 0) return;
    cxpAutoFetchDone.current = true;
    let cancelled = false;
    (async () => {
      const fetchedRecords: CXPRecord[] = [];
      const fetchedCias: string[] = [];
      const fetchedTimestamps: Record<string, string> = {};
      for (const cia of ciasToFetch) {
        if (cancelled) return;
        try {
          const data = await fetchAgedBalances({ cia });
          if (cancelled) return;
          const stamped = (data as CXPRecord[]).map(r => ({ ...r, cia }));
          fetchedRecords.push(...stamped);
          fetchedCias.push(cia);
          fetchedTimestamps[cia] = new Date().toISOString();
        } catch {
          // Silent: si ninguna compañía carga, el empty state de CXP
          // deja al usuario "Consultar todas" o subir CSV manualmente.
        }
      }
      if (cancelled || fetchedCias.length === 0) return;
      const fetchedSet = new Set(fetchedCias);
      setCxpRecords(prev => [...prev.filter(r => !fetchedSet.has(r.cia)), ...fetchedRecords]);
      setCxpLoadedCias(prev => ({ ...prev, ...fetchedTimestamps }));
    })();
    return () => { cancelled = true; };
  }, [companies, cxpLoadedCias]);

  // ── Cargador unificado de Cobranza (CXC) ───────────────────────────────
  // Endpoint: POST /v1/erp/tesoreria/cobranza (productivo desde 2026-05-01).
  //
  // Estrategia (idéntica a CXP):
  //   1. Una llamada por compañía activa, secuencial — JDE revienta en
  //      paralelo igual que /antiguedadsaldos.
  //   2. Rango: últimos 365 días (fechaInicial = hoy - 365). Suficiente para
  //      conciliar el año fiscal con bancos sin traer histórico completo.
  //   3. Cache por (cia, noFactura): cada respuesta reemplaza solo los
  //      registros de esa cia para que reintentos de un día a otro no
  //      dupliquen filas.
  //   4. Errores agregados a `cobranzaError` para que la pestaña Cobranza
  //      pueda surfacerlos al usuario (antes se silenciaban).
  const refreshCobranza = useCallback(async (force = true) => {
    if (companies.length === 0) {
      setCobranzaError('No hay compañías cargadas todavía. Espera a que /empresas responda.');
      return;
    }
    const activeCias = companies.filter(c => c.activa !== false).map(c => c.cia);
    if (activeCias.length === 0) {
      setCobranzaError('No hay compañías activas en el catálogo.');
      return;
    }
    const ciasToFetch = force
      ? activeCias
      : activeCias.filter(cia =>
        !isFreshTimestamp(cobranzaLoadedCias[cia], COBRANZA_AUTO_REFRESH_TTL_MS)
        || !isFreshTimestamp(cobranzaPaymentsLoadedCias[cia], COBRANZA_AUTO_REFRESH_TTL_MS)
      );
    if (ciasToFetch.length === 0) return;

    setCobranzaRefreshing(true);
    setCobranzaError(null);

    const today = new Date();
    const fechaFinal = today.toISOString().slice(0, 10);
    const yearAgo = new Date(today);
    yearAgo.setUTCDate(yearAgo.getUTCDate() - 365);
    const fechaInicial = yearAgo.toISOString().slice(0, 10);

    const errors: string[] = [];
    let totalRecords = 0;
    const fetchedRecords: CobranzaRecord[] = [];
    const fetchedCias: string[] = [];
    const fetchedTimestamps: Record<string, string> = {};
    try {
      for (const cia of ciasToFetch) {
        try {
          const data = await fetchCobranza({ cia, fechaInicial, fechaFinal });
          const stamped = data.map(r => ({ ...r, cia: r.cia || cia }));
          fetchedRecords.push(...stamped);
          fetchedCias.push(cia);
          fetchedTimestamps[cia] = new Date().toISOString();
          totalRecords += stamped.length;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`${cia}: ${msg}`);
        }
      }

      try {
        const ciaBatch = ciasToFetch.join(',');
        const payments = await fetchIndicadoresCobranza({ cia: ciaBatch, fechaInicial, fechaFinal });
        const fetchedSet = new Set(ciasToFetch);
        setCobranzaPayments(prev => [
          ...prev.filter(p => !fetchedSet.has(p.cia)),
          ...payments,
        ]);
        const stamp = new Date().toISOString();
        setCobranzaPaymentsLoadedCias(prev => ({
          ...prev,
          ...Object.fromEntries(ciasToFetch.map(cia => [cia, stamp])),
        }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`indicadores ${ciasToFetch.join(',')}: ${msg}`);
      }

      if (fetchedCias.length > 0) {
        const fetchedSet = new Set(fetchedCias);
        setCobranzaRecords(prev => [
          ...prev.filter(r => !fetchedSet.has(r.cia)),
          ...fetchedRecords,
        ]);
        setCobranzaLoadedCias(prev => ({ ...prev, ...fetchedTimestamps }));
      }

      if (errors.length > 0) {
        setCobranzaError(`Errores en ${errors.length}/${ciasToFetch.length} cías: ${errors.slice(0, 2).join('; ')}${errors.length > 2 ? '…' : ''}`);
      } else if (totalRecords === 0) {
        setCobranzaError(`Todas las ${ciasToFetch.length} cías consultadas respondieron VACÍO. Revisa el token productivo y permisos JDE para /cobranza. (Detalles en consola con prefix [cobranza].)`);
      }
    } finally {
      setCobranzaRefreshing(false);
    }
  }, [companies, cobranzaLoadedCias, cobranzaPaymentsLoadedCias]);

  const cobranzaAutoFetchDone = useRef(false);
  useEffect(() => {
    if (cobranzaAutoFetchDone.current) return;
    if (!RECONCILIATION_TABS.has(activeTab)) return;
    if (companies.length === 0) return;
    cobranzaAutoFetchDone.current = true;
    refreshCobranza(false);
  }, [activeTab, companies, refreshCobranza]);

  // Persist selected cia (clear to 'all' if it disappears from the catalog)
  useEffect(() => {
    localStorage.setItem('midas.selectedCia', selectedCia);
  }, [selectedCia]);
  useEffect(() => {
    if (companies.length > 0 && selectedCia !== 'all'
        && !companies.some(c => c.cia === selectedCia)
        && !companyGroups.some(g => g.id === selectedCia)) {
      setSelectedCia('all');
    }
  }, [companies, selectedCia, companyGroups]);

  // Persist bank statements + last query
  useEffect(() => {
    let cancelIdle: (() => void) | null = null;
    const timer = window.setTimeout(() => {
      cancelIdle = scheduleIdleTask(() => {
        try { localStorage.setItem('midas.bankStatements.v2', JSON.stringify(bankJdeStatements)); }
        catch { /* quota or serialization issue; ignore */ }
      }, 2500);
    }, BANK_STORAGE_SAVE_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      cancelIdle?.();
    };
  }, [bankJdeStatements]);
  useEffect(() => {
    let cancelIdle: (() => void) | null = null;
    const timer = window.setTimeout(() => {
      cancelIdle = scheduleIdleTask(() => {
        try {
          if (bankSupplementalStatements.length > 0) localStorage.setItem('midas.bankSupplementalStatements.v1', JSON.stringify(bankSupplementalStatements));
          else localStorage.removeItem('midas.bankSupplementalStatements.v1');
        } catch { /* ignore */ }
      }, 2500);
    }, BANK_STORAGE_SAVE_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      cancelIdle?.();
    };
  }, [bankSupplementalStatements]);
  useEffect(() => {
    if (bankJdeStatements.length === 0 || bankSupplementalStatements.length === 0) return;
    setBankSupplementalStatements((current) => {
      const aligned = attachImportedStatementsToKnownCompanies(current, bankJdeStatements);
      const changed = aligned.some((statement, index) => {
        const previous = current[index];
        return previous?.cia !== statement.cia || previous?.movimientos.some((movement, mIndex) => movement.cia !== statement.movimientos[mIndex]?.cia);
      });
      return changed ? aligned : current;
    });
  }, [bankJdeStatements, bankSupplementalStatements.length]);
  useEffect(() => {
    try {
      if (bankLastQuery) localStorage.setItem('midas.bankLastQuery.v2', JSON.stringify(bankLastQuery));
      else localStorage.removeItem('midas.bankLastQuery.v2');
    } catch { /* ignore */ }
  }, [bankLastQuery]);

  // ── JDE: fetch bank statements ──
  // Boot sólo hace prime corto. El backfill año-a-la-fecha queda para refresh
  // manual; hacerlo automáticamente congelaba la app por red + renders +
  // persistencia de un dataset grande.
  const refreshBankStatementsRange = useCallback(async (
    force: boolean = false,
    includeRange: boolean = false,
  ) => {
    const today = new Date().toISOString().slice(0, 10);
    const yearStart = `${new Date().getUTCFullYear()}-01-01`;
    const defaultFormat: BankStatementFormat = 'SWIFT';

    // Cache hit: skip unless forced.
    if (!force) {
      const distinctDates = new Set<string>();
      for (const acc of bankJdeStatements) {
        for (const mov of acc.movimientos) distinctDates.add(mov.fechaOperacion);
      }
      const cacheIsFresh =
        bankLastQuery?.formatoElectronico !== SANTANDER_FILE_FORMAT &&
        bankLastQuery?.fechaEstadoCuenta === today &&
        distinctDates.size >= 30;
      if (cacheIsFresh) {
        return { primed: true, ranged: includeRange };
      }
    }

    // Prime: hoy + últimos 5 días hábiles
    const tryDates = [today];
    const d = new Date();
    for (let i = 0; i < 5; i++) {
      d.setDate(d.getDate() - 1);
      tryDates.push(d.toISOString().slice(0, 10));
    }

    setBankFetchStatus('priming');

    // ── Step 1: Prime con 1 día (solo si no hay cache o force) ──
    let primed = !force && bankJdeStatements.length > 0;
    if (!primed) {
      for (const fecha of tryDates) {
        try {
          const res = await fetchBankStatements({
            fechaEstadoCuenta: fecha,
            formatoElectronico: defaultFormat,
          });
          if (res.length > 0) {
            setBankJdeStatements(res);
            setBankLastQuery({
              fechaEstadoCuenta: fecha,
              formatoElectronico: defaultFormat,
              hasUploadedSantander: bankSupplementalStatements.length > 0,
            });
            primed = true;
            break;
          }
        } catch {
          // Try the next recent business date.
        }
      }
    }

    if (!includeRange) {
      setBankFetchStatus('idle');
      setBankFetchProgress(null);
      return { primed, ranged: false };
    }

    // ── Step 2: Backfill año-a-la-fecha ──
    setBankFetchStatus('ranging');
    setBankFetchProgress({ done: 0, total: 0 });
    let ranged = false;
    let lastTotal = 0;
    let lastProgressPaint = 0;
    try {
      const full = await fetchBankStatementsRange(
        yearStart,
        today,
        defaultFormat,
        {
          concurrency: 6,
          onProgress: (done, total) => {
            lastTotal = total;
            const now = performance.now();
            if (done === total || now - lastProgressPaint > 250) {
              lastProgressPaint = now;
              setBankFetchProgress({ done, total });
            }
          },
        },
      );
      if (full.length > 0) {
        setBankJdeStatements(full);
        setBankLastQuery({
          fechaEstadoCuenta: today,
          formatoElectronico: defaultFormat,
          hasUploadedSantander: bankSupplementalStatements.length > 0,
        });
        ranged = true;
      }
    } catch {
      // Keep the last known state visible when the range refresh fails.
    }

    // Snap bar to 100% and wait for the CSS transition so the user sees the
    // fill complete before the splash dismisses. Without this, fast JDE
    // responses finish before the bar visually fills.
    if (lastTotal > 0) {
      setBankFetchProgress({ done: lastTotal, total: lastTotal });
      await new Promise((r) => setTimeout(r, 420));
    }

    setBankFetchStatus('idle');
    setBankFetchProgress(null);
    return { primed, ranged };
  }, [bankJdeStatements, bankLastQuery, bankSupplementalStatements.length]);

  const ensureBankCoverageForCollections = useCallback(async ({
    from,
    to,
    ciaFilter,
  }: EnsureBankCoverageRequest) => {
    setBankCoverageLoading(true);
    const defaultFormat: BankStatementFormat = 'SWIFT';
    try {
      const fetched = await fetchBankStatementsRange(from, to, defaultFormat, {
        concurrency: 6,
      });
      const scoped = ciaFilter?.length
        ? fetched.filter(statement => ciaFilter.includes(statement.cia))
        : fetched;
      if (scoped.length > 0) {
        setBankJdeStatements(prev => mergeBankStatements(prev, scoped));
        setBankLastQuery({
          fechaEstadoCuenta: to,
          formatoElectronico: defaultFormat,
          hasUploadedSantander: bankSupplementalStatements.length > 0,
        });
      }
    } finally {
      setBankCoverageLoading(false);
    }
  }, [bankSupplementalStatements.length]);

  useEffect(() => {
    (async () => {
      // Sólo prime corto de JDE al boot. El backfill completo es manual para
      // evitar que el arranque bloquee la plataforma.
      await refreshBankStatementsRange(false, false);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Animated page key for re-mount on tab change ── */
  const [pageKey, setPageKey] = useState(0);
  const prevTab = useRef(activeTab);
  useEffect(() => {
    if (prevTab.current !== activeTab) { setPageKey(k => k + 1); prevTab.current = activeTab; }
  }, [activeTab]);

  // Los handlers de propuestas/escenarios ahora viven dentro de CashFlowView;
  // App sólo expone los setters directos al componente.

  // ── CXP per-cia cache management ──
  const mergeCxpForCia = useCallback((cia: string, records: CXPRecord[]) => {
    setCxpRecords(prev => [...prev.filter(r => r.cia !== cia), ...records]);
    setCxpLoadedCias(prev => ({ ...prev, [cia]: new Date().toISOString() }));
  }, []);
  const replaceAllCxp = useCallback((records: CXPRecord[], cias: string[]) => {
    setCxpRecords(records);
    const now = new Date().toISOString();
    setCxpLoadedCias(cias.reduce<Record<string, string>>((acc, c) => { acc[c] = now; return acc; }, {}));
  }, []);
  const resetCxp = useCallback(() => {
    setCxpRecords([]);
    setCxpLoadedCias({});
  }, []);

  const addProvider = (p: Provider) => setProviders(prev => [...prev, p]);
  const updateProvider = (p: Provider) => setProviders(prev => prev.map(x => x.id === p.id ? p : x));
  const deleteProvider = (id: string) => setProviders(prev => prev.filter(x => x.id !== id));

  const addClient = (c: Client) => setClients(prev => [...prev, c]);
  const updateClient = (c: Client) => setClients(prev => prev.map(x => x.id === c.id ? c : x));
  const deleteClient = (id: string) => setClients(prev => prev.filter(x => x.id !== id));

  const activeSection = SECTION_FOR_TAB[activeTab] ?? 'operacion';
  const subTabs = SUB_TABS[activeSection];

  const switchSection = (s: SectionId) => {
    if (s === activeSection) return;
    setActiveTab(DEFAULT_TAB[s]);
  };

  return (
    <div className="min-h-screen" style={{ background: 'var(--background)' }}>
      {splashMounted && (
        <MidasSplash
          visible={!isBooted}
          step={bootStep}
          hasError={!!companiesError}
          progress={bankFetchProgress}
        />
      )}
      <div
        style={{
          opacity: isBooted ? 1 : 0,
          transition: 'opacity 240ms var(--ease-smooth)',
        }}
        aria-hidden={!isBooted}
      >
      {/* Skip link — keyboard-only shortcut to main content */}
      <a href="#main-content" className="skip-link">Saltar al contenido</a>

      {/* ─── HEADER (Midas corporativo — dark slate shell) ─── */}
      <header
        role="banner"
        className="border-b sticky top-0 z-50"
        style={{
          borderColor: 'var(--shell-border)',
          background: 'var(--secondary)',
        }}
      >
        <div className="max-w-[1400px] mx-auto px-8 h-14 flex items-center justify-between gap-4">
          {/* Brand lockup — Senda (white, inverted on dark) + divider + Midas */}
          <div
            className="flex items-center gap-3 flex-shrink-0 cursor-pointer senda-lockup-dark"
            onClick={() => setActiveTab('netflow')}
            aria-label="Midas · Senda corporativo"
          >
            <img
              src="/logos/senda-corporativo.svg"
              alt="Senda"
              className="senda-mark-inverted"
              style={{ height: 22, width: 'auto', display: 'block' }}
            />
            <span
              aria-hidden="true"
              style={{ display: 'inline-block', width: 1, height: 22, background: 'var(--shell-border)' }}
            />
            <span
              style={{
                fontSize: '22px',
                fontWeight: 700,
                letterSpacing: 0,
                lineHeight: 1,
                color: 'var(--shell-text)',
              }}
            >
              Midas
            </span>
          </div>

          {/* Section nav */}
          <nav
            role="navigation"
            aria-label="Secciones principales"
            className="flex items-center rounded-[var(--radius-md)] p-0.5 gap-0.5"
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid var(--shell-border)' }}
          >
            {SECTIONS.map(s => {
              const isActive = activeSection === s.id;
              const catalogCount = clients.length + providers.length;
              const badge = s.id === 'catalogos' && catalogCount > 0
                ? `${catalogCount}`
                : s.id === 'operacion' && (cxpRecords.length > 0 || bankStatements.length > 0)
                  ? 'Activo'
                  : null;
              return (
                <button
                  key={s.id}
                  onClick={() => switchSection(s.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className="flex items-center gap-2 rounded-md border px-3.5 py-1.5 text-[13px] font-medium transition-colors duration-150 whitespace-nowrap"
                  style={{
                    background: isActive ? 'var(--card)' : 'transparent',
                    color: isActive ? 'var(--gray-950)' : 'var(--shell-text-muted)',
                    borderColor: isActive ? 'transparent' : 'transparent',
                  }}
                  title={s.description}
                >
                  <s.icon
                    className="w-4 h-4"
                    strokeWidth={1.5}
                    style={{ color: isActive ? 'var(--primary)' : 'currentColor' }}
                  />
                  {s.label}
                  {badge && (
                    <span
                      className="midas-pill"
                      data-tone={isActive ? 'neutral' : 'shell'}
                    >
                      <span className="midas-pill-dot" aria-hidden="true" />
                      {badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Actions */}
          <div className="flex items-center gap-1.5">
            <CompanySelector
              companies={companies}
              selectedCia={selectedCia}
              loading={companiesLoading}
              error={companiesError}
              onSelect={setSelectedCia}
              onRetry={loadCompanies}
              groups={companyGroups}
              onGroupsChange={setCompanyGroups}
            />
            {/* Activity feed bell */}
            <button
              onClick={() => setActivityOpen(true)}
              title="Actividad reciente"
              aria-label="Ver actividad reciente"
              className="shell-icon-btn flex items-center justify-center w-9 h-9 rounded-[var(--radius-md)] flex-shrink-0 transition-colors duration-150"
            >
              <Bell className="w-4 h-4" strokeWidth={1.5} />
            </button>
            <button
              onClick={() => {
                const json = exportStore({
                  providers, clients,
                  assumptions, confirmedPayments, cxpRecords, cxpLoadedCias,
                  cobranzaRecords, cobranzaLoadedCias,
                  cobranzaPayments, cobranzaPaymentsLoadedCias,
                  cashFlowOverrides,
                  lastSaved: new Date().toISOString(),
                });
                const blob = new Blob([json], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `midas-backup-${new Date().toISOString().slice(0,10)}.json`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              title="Descargar respaldo"
              aria-label="Descargar respaldo JSON"
              className="shell-icon-btn flex items-center justify-center w-9 h-9 rounded-[var(--radius-md)] flex-shrink-0 transition-colors duration-150"
            >
              <Download className="w-4 h-4" strokeWidth={1.5} />
            </button>
          </div>
        </div>
      </header>

      {/* ─── SUB-TABS with context breadcrumb (dark shell) ─── */}
      {subTabs.length > 0 && (
        <div className="border-b" style={{ background: 'var(--primary)', borderColor: 'var(--shell-border)' }}>
          <div className="max-w-[1400px] mx-auto px-8">
            <div className="flex items-center gap-1 py-1.5">
              {/* Breadcrumb context */}
              <span className="text-[12px] font-medium mr-2 flex items-center gap-1" style={{ color: 'var(--shell-text-muted)' }}>
                {SECTIONS.find(s => s.id === activeSection)?.label}
                <ChevronRight className="w-3 h-3" strokeWidth={1.5} />
              </span>
              {subTabs.map(t => {
                const isActive = activeTab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setActiveTab(t.id)}
                    aria-current={isActive ? 'page' : undefined}
                    className="min-h-9 px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors duration-150"
                    style={{
                      background: isActive ? 'rgba(255,255,255,0.12)' : 'transparent',
                      color: isActive ? 'var(--shell-text)' : 'var(--shell-text-muted)',
                      border: isActive ? '1px solid var(--shell-border)' : '1px solid transparent',
                    }}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ─── MAIN CONTENT ─── */}
      <main id="main-content" role="main" className="max-w-[1400px] mx-auto px-8 py-4">
        <div key={pageKey} className="animate-page-in">
          <ErrorBoundary fallbackLabel={subTabs.find(t => t.id === activeTab)?.label ?? activeTab}>
            {activeTab === 'dashboard' && (
              <Suspense fallback={<LazyTabFallback label="Dashboard" />}>
                <Dashboard
                  companyCode={selectedCia}
                  bankStatements={accountableBankStatements}
                  clients={clients}
                  providers={providers}
                  cxpRecords={cxpRecords}
                  assumptions={assumptions}
                  budget={budget}
                  onOpenFlow={() => setActiveTab('financialPlanning')}
                  startingBalance={effectiveStartingBalance}
                  cobranzaReconciliation={cobranzaReconciliation}
                />
              </Suspense>
            )}
            {activeTab === 'financialProjection' && (
              <Suspense fallback={<LazyTabFallback label="Proyección Financiera" />}>
                <FinancialProjectionDashboard
                  companyCode={selectedCia}
                  bankStatements={accountableBankStatements}
                  clients={clients}
                  providers={providers}
                  cxpRecords={cxpRecords}
                  cobranzaRecords={cobranzaRecords}
                  cobranzaPayments={cobranzaPayments}
                  cobranzaReconciliation={cobranzaReconciliation}
                  assumptions={assumptions}
                  budget={budget}
                  startingBalance={effectiveStartingBalance}
                  onNavigateToTax={() => setActiveTab('taxes')}
                />
              </Suspense>
            )}
            {activeTab === 'financialPlanning' && (
              <Suspense fallback={<LazyTabFallback label="Planeación Financiera" />}>
                <FinancialPlanningDashboard
                  companyCode={selectedCia}
                  bankStatements={accountableBankStatements}
                  clients={clients}
                  providers={providers}
                  cxpRecords={cxpRecords}
                  cobranzaRecords={cobranzaRecords}
                  cobranzaReconciliation={cobranzaReconciliation}
                  assumptions={assumptions}
                  budget={budget}
                  startingBalance={effectiveStartingBalance}
                />
              </Suspense>
            )}
            {activeTab === 'taxes' && (
              <Suspense fallback={<LazyTabFallback label="Impuestos" />}>
                <TaxDashboard
                  companyCode={selectedCia}
                  bankStatements={accountableBankStatements}
                  clients={clients}
                  providers={providers}
                  cxpRecords={cxpRecords}
                  cobranzaRecords={cobranzaRecords}
                  cobranzaPayments={cobranzaPayments}
                  cobranzaReconciliation={cobranzaReconciliation}
                  assumptions={assumptions}
                  budget={budget}
                  startingBalance={effectiveStartingBalance}
                />
              </Suspense>
            )}
            {activeTab === 'clients' && (
              <Suspense fallback={<LazyTabFallback label="Clientes" />}>
                <Clients
                  clients={clients}
                  assumptions={assumptions}
                  confirmedPayments={confirmedPayments}
                  onReplace={setClients}
                  onAdd={addClient}
                  onUpdate={updateClient}
                  onDelete={deleteClient}
                />
              </Suspense>
            )}
            {activeTab === 'collections' && (
              <Suspense fallback={<LazyTabFallback label="Cobranza" />}>
                <CollectionProjection
                  clients={clients}
                  assumptions={assumptions}
                  onAssumptionsChange={setAssumptions}
                  confirmedPayments={confirmedPayments}
                  onConfirm={confirmPayment}
                  onUnconfirm={unconfirmPayment}
                  cxpRecords={cxpRecords}
                  bankStatements={accountableBankStatements}
                  companies={companies}
                  cobranzaRecords={cobranzaRecords}
                  cobranzaPayments={cobranzaPayments}
                  cobranzaLoadedCias={cobranzaLoadedCias}
                  cobranzaReconciliation={cobranzaReconciliation}
                  cobranzaFacturaIndex={cobranzaFacturaIndex}
                  cobranzaError={cobranzaError}
                  onRefreshCobranza={refreshCobranza}
                  cobranzaRefreshing={cobranzaRefreshing}
                  selectedCia={selectedCia}
                  onEnsureBankCoverage={ensureBankCoverageForCollections}
                  bankCoverageLoading={bankCoverageLoading}
                />
              </Suspense>
            )}
            {activeTab === 'providers' && (
              <Suspense fallback={<LazyTabFallback label="Proveedores" />}>
                <Providers
                  providers={providers}
                  cxpRecords={cxpRecords}
                  onReplace={setProviders}
                  onAdd={addProvider}
                  onUpdate={updateProvider}
                  onDelete={deleteProvider}
                />
              </Suspense>
            )}
            {activeTab === 'cxp' && (
              <Suspense fallback={<LazyTabFallback label="CXP" />}>
                <CXP
                  records={cxpRecords}
                  loadedCias={cxpLoadedCias}
                  companies={companies}
                  selectedCia={selectedCia}
                  providers={providers}
                  clients={clients}
                  assumptions={assumptions}
                  bankStatements={accountableBankStatements}
                  budget={budget}
                  onMergeCia={mergeCxpForCia}
                  onReplaceAll={replaceAllCxp}
                  onReset={resetCxp}
                />
              </Suspense>
            )}
            {activeTab === 'bancos' && (
              <Suspense fallback={<LazyTabFallback label="Bancos" />}>
                <Bancos
                  selectedCia={selectedCia}
                  statements={bankStatements}
                  supplementalStatements={bankSupplementalStatements}
                  onJdeStatementsChange={setBankJdeStatements}
                  onSupplementalStatementsChange={setBankSupplementalStatements}
                  lastQuery={bankLastQuery}
                  onLastQueryChange={setBankLastQuery}
                  companies={companies}
                  abonoEnrichmentIndex={cobranzaAbonoIndex}
                />
              </Suspense>
            )}
            {activeTab === 'netflow' && (
              <Suspense fallback={<LazyTabFallback label="Flujo Neto" />}>
                <CashFlowDetail
                  clients={clients}
                  cxpRecords={cxpRecords}
                  assumptions={assumptions}
                  confirmedPayments={confirmedPayments}
                  bankStatements={accountableBankStatements}
                  companies={companies}
                  bankFetchStatus={bankFetchStatus}
                  bankFetchProgress={bankFetchProgress}
                  onRefreshBanks={() => refreshBankStatementsRange(true, true)}
                  startingBalance={effectiveStartingBalance}
                />
              </Suspense>
            )}
            {/* Forecast tab fused into Dashboard — no longer standalone */}
          </ErrorBoundary>
        </div>
      </main>

      {/* ── Global overlays ── */}
      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        onNavigate={(tabId) => { setActiveTab(tabId as TabId); setCmdOpen(false); }}
        clients={clients.map(c => ({ id: c.id, name: c.name }))}
        providers={providers.map(p => ({ id: p.id, name: p.name }))}
        simulations={paletteAdjustments}
        scenarios={paletteScenarios}
        actions={paletteActions}
      />
      <ActivityFeedPanel
        open={activityOpen}
        onClose={() => setActivityOpen(false)}
        onNavigate={(tabId) => { setActiveTab(tabId as TabId); setActivityOpen(false); }}
      />
      <KeyboardShortcutsModal
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />
      </div>
    </div>
  );
}

function CompanySelector({
  companies,
  selectedCia,
  loading,
  error,
  onSelect,
  onRetry,
  groups,
  onGroupsChange,
}: {
  companies: Company[];
  selectedCia: string;
  loading: boolean;
  error: string | null;
  onSelect: (cia: string) => void;
  onRetry: () => void;
  groups: CompanyGroup[];
  onGroupsChange: (groups: CompanyGroup[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'select' | 'create' | 'edit'>('select');
  const [editGroupId, setEditGroupId] = useState<string | null>(null);
  const [groupName, setGroupName] = useState('');
  const [groupCias, setGroupCias] = useState<Set<string>>(new Set());
  const [groupColor, setGroupColor] = useState<string>(GROUP_COLORS[0]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (!open) { setMode('select'); setEditGroupId(null); }
  }, [open]);

  const activeGroup = groups.find(g => g.id === selectedCia);
  const active = companies.find(c => c.cia === selectedCia);
  const label = selectedCia === 'all'
    ? 'Todas las compañías'
    : activeGroup
      ? `${activeGroup.name} (${activeGroup.cias.length})`
      : active ? `${active.cia} — ${active.nombre}` : selectedCia;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); }
  };

  const startCreate = () => {
    setMode('create');
    setGroupName('');
    setGroupCias(new Set());
    setGroupColor(GROUP_COLORS[groups.length % GROUP_COLORS.length]);
    setEditGroupId(null);
  };

  const startEdit = (g: CompanyGroup) => {
    setMode('edit');
    setGroupName(g.name);
    setGroupCias(new Set(g.cias));
    setGroupColor(g.color ?? GROUP_COLORS[0]);
    setEditGroupId(g.id);
  };

  const saveGroup = () => {
    if (!groupName.trim() || groupCias.size === 0) return;
    if (mode === 'edit' && editGroupId) {
      onGroupsChange(groups.map(g => g.id === editGroupId
        ? { ...g, name: groupName.trim(), cias: Array.from(groupCias), color: groupColor }
        : g
      ));
    } else {
      const newGroup: CompanyGroup = {
        id: newGroupId(),
        name: groupName.trim(),
        cias: Array.from(groupCias),
        color: groupColor,
        createdAt: new Date().toISOString(),
      };
      onGroupsChange([...groups, newGroup]);
    }
    setMode('select');
    setEditGroupId(null);
  };

  const deleteGroup = (id: string) => {
    onGroupsChange(groups.filter(g => g.id !== id));
    if (selectedCia === id) onSelect('all');
  };

  const toggleCia = (cia: string) => {
    const next = new Set(groupCias);
    next.has(cia) ? next.delete(cia) : next.add(cia);
    setGroupCias(next);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        onKeyDown={handleKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Compañía activa: ${label}. Filtra datos globalmente.`}
        className="shell-picker-btn flex items-center gap-1.5 h-9 px-3 rounded-[var(--radius-md)] text-[13px] font-medium transition-colors duration-150 max-w-[300px]"
        style={{
          background: activeGroup ? `${activeGroup.color}20` : 'rgba(255,255,255,0.08)',
          color: 'var(--shell-text)',
          border: '1px solid var(--shell-border)',
        }}
        title="Compañía o grupo activo — filtra los datos de todas las pestañas"
      >
        {activeGroup
          ? <FolderOpen className="w-4 h-4 flex-shrink-0" strokeWidth={1.5} style={{ color: activeGroup.color ?? 'var(--shell-text)' }} />
          : <Building2 className="w-4 h-4 flex-shrink-0" strokeWidth={1.5} style={{ color: 'var(--shell-text-muted)' }} />
        }
        <span className="truncate">{loading ? 'Cargando…' : label}</span>
        {loading
          ? <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" strokeWidth={1.5} style={{ color: 'var(--shell-text-muted)' }} />
          : <ChevronDown className={`w-3.5 h-3.5 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} strokeWidth={1.5} style={{ color: 'var(--shell-text-muted)' }} />
        }
      </button>

      {open && (
        <div
          className="absolute right-0 top-11 w-[360px] rounded-[var(--radius-md)] border p-1.5 z-50 max-h-[520px] overflow-y-auto animate-slide-down"
          style={{ background: 'var(--surface)', borderColor: 'var(--gray-200)', boxShadow: 'var(--shadow-md)' }}
        >
          {error ? (
            <div className="p-3">
              <div className="flex items-start gap-2 mb-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} />
                <p className="text-[12px] leading-snug" style={{ color: 'var(--gray-500)' }}>{error}</p>
              </div>
              <button onClick={() => { onRetry(); }} className="text-[12px] font-medium" style={{ color: 'var(--primary)' }}>Reintentar</button>
            </div>
          ) : mode === 'select' ? (
            <>
              {/* All companies */}
              <button
                role="option"
                aria-selected={selectedCia === 'all'}
                onClick={() => { onSelect('all'); setOpen(false); }}
                className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-[var(--radius-md)] text-[13px] text-left transition"
                style={{ background: selectedCia === 'all' ? 'var(--primary-muted)' : undefined, color: selectedCia === 'all' ? 'var(--primary)' : 'var(--gray-950)' }}
              >
                <span className="font-medium">Todas las compañías</span>
                {selectedCia === 'all' && <Check className="w-3.5 h-3.5" />}
              </button>

              {/* Groups section */}
              {groups.length > 0 && (
                <div className="mt-2 mb-1">
                  <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--gray-400)] px-3 py-1 font-medium">Grupos</div>
                  {groups.map(g => {
                    const isActive = selectedCia === g.id;
                    return (
                      <div key={g.id} className="flex items-center group">
                        <button
                          onClick={() => { onSelect(g.id); setOpen(false); }}
                          className="flex-1 flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] text-[13px] text-left transition"
                          style={{ background: isActive ? `${g.color}15` : undefined, color: isActive ? g.color : 'var(--gray-950)' }}
                        >
                          <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: g.color }} />
                          <div className="min-w-0 flex-1">
                            <p className="font-medium truncate">{g.name}</p>
                            <p className="text-[11px] truncate" style={{ color: 'var(--gray-400)' }}>
                              {g.cias.map(cia => {
                                const c = companies.find(co => co.cia === cia);
                                return c?.nombre ?? cia;
                              }).join(', ')}
                            </p>
                          </div>
                          {isActive && <Check className="w-3.5 h-3.5 flex-shrink-0" />}
                        </button>
                        <div className="flex gap-0.5 pr-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={(e) => { e.stopPropagation(); startEdit(g); }}
                            className="p-1 rounded hover:bg-[var(--gray-100)] text-[var(--gray-400)] hover:text-[var(--gray-700)]"
                            title="Editar grupo"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); deleteGroup(g.id); }}
                            className="p-1 rounded hover:bg-[var(--danger)]/10 text-[var(--gray-400)] hover:text-[var(--danger)]"
                            title="Eliminar grupo"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Create group button */}
              <button
                onClick={startCreate}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] text-[13px] text-left transition hover:bg-[var(--gray-50)]"
                style={{ color: 'var(--primary)' }}
              >
                <FolderPlus className="w-4 h-4" />
                <span className="font-medium">Crear grupo de empresas</span>
              </button>

              {/* Divider */}
              <div className="h-px bg-[var(--gray-100)] my-1.5" />

              {/* Individual companies */}
              <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--gray-400)] px-3 py-1 font-medium">Empresas individuales</div>
              {companies.length === 0 && !loading && (
                <p className="text-[12px] px-3 py-2" style={{ color: 'var(--gray-400)' }}>Sin compañías disponibles.</p>
              )}
              {companies
                .filter(c => c.activa !== false)
                .map(c => {
                  const isActive = selectedCia === c.cia;
                  return (
                    <button
                      key={c.cia}
                      onClick={() => { onSelect(c.cia); setOpen(false); }}
                      className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-[var(--radius-md)] text-[13px] text-left transition"
                      style={{ background: isActive ? 'var(--primary-muted)' : undefined, color: isActive ? 'var(--primary)' : 'var(--gray-950)' }}
                    >
                      <div className="min-w-0">
                        <p className="font-medium truncate">{c.cia} — {c.nombre}</p>
                        {c.rfc && <p className="text-[11px] truncate" style={{ color: 'var(--gray-400)' }}>{c.rfc}</p>}
                      </div>
                      {isActive && <Check className="w-3.5 h-3.5 flex-shrink-0" />}
                    </button>
                  );
                })}
            </>
          ) : (
            /* ── Create / Edit Group form ── */
            <div className="p-3 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-[14px] font-bold text-[var(--gray-950)]">
                  {mode === 'edit' ? 'Editar grupo' : 'Nuevo grupo'}
                </h3>
                <button onClick={() => setMode('select')} className="p-1 rounded hover:bg-[var(--gray-100)] text-[var(--gray-400)]">
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Name input */}
              <div>
                <label className="text-[11px] text-[var(--gray-400)] mb-1 block">Nombre del grupo</label>
                <input
                  type="text"
                  value={groupName}
                  onChange={e => setGroupName(e.target.value)}
                  placeholder="Ej: Grupo Norte, Pasaje Lujo..."
                  className="input w-full"
                  autoFocus
                />
              </div>

              {/* Color picker */}
              <div>
                <label className="text-[11px] text-[var(--gray-400)] mb-1 block">Color</label>
                <div className="flex gap-1.5">
                  {GROUP_COLORS.map(c => (
                    <button
                      key={c}
                      onClick={() => setGroupColor(c)}
                      className={`w-7 h-7 rounded-full transition-shadow ${groupColor === c ? 'ring-2 ring-offset-2 ring-[var(--gray-300)]' : 'hover:ring-2 hover:ring-offset-1 hover:ring-[var(--gray-200)]'}`}
                      style={{ background: c }}
                    />
                  ))}
                </div>
              </div>

              {/* Company checkboxes */}
              <div>
                <label className="text-[11px] text-[var(--gray-400)] mb-1 block">
                  Empresas ({groupCias.size} seleccionadas)
                </label>
                <div className="space-y-1 max-h-48 overflow-y-auto border border-[var(--gray-200)] rounded-[var(--radius-md)] p-1.5">
                  {companies.filter(c => c.activa !== false).map(c => {
                    const checked = groupCias.has(c.cia);
                    return (
                      <button
                        key={c.cia}
                        onClick={() => toggleCia(c.cia)}
                        className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-[var(--radius-md)] text-[12px] text-left transition ${
                          checked ? 'bg-[var(--primary-muted)]' : 'hover:bg-[var(--gray-50)]'
                        }`}
                      >
                        <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition ${
                          checked ? 'bg-[var(--primary)] border-[var(--primary)]' : 'border-[var(--gray-300)]'
                        }`}>
                          {checked && <Check className="w-3 h-3 text-white" strokeWidth={1.5} />}
                        </div>
                        <span className={checked ? 'text-[var(--primary)] font-medium' : 'text-[var(--gray-700)]'}>
                          {c.cia} — {c.nombre}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => setMode('select')}
                  className="flex-1 h-9 rounded-[var(--radius-md)] border border-[var(--gray-200)] text-[13px] text-[var(--gray-500)] hover:bg-[var(--gray-50)]"
                >
                  Cancelar
                </button>
                <button
                  onClick={saveGroup}
                  disabled={!groupName.trim() || groupCias.size === 0}
                  className="flex-1 h-9 rounded-[var(--radius-md)] text-white text-[13px] font-medium hover-press disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: groupColor }}
                >
                  {mode === 'edit' ? 'Guardar cambios' : 'Crear grupo'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
