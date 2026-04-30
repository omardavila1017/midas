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
  type Company,
  type BankAccountStatement,
  type BankStatementFormat,
} from './services/jde';
import Dashboard from './components/Dashboard';

const FIXED_STARTING_BALANCE = 76_300_000;
import CXP from './components/CXP';
import Bancos from './components/Bancos';
import Providers from './components/Providers';
import CollectionProjection from './components/CollectionProjection';
import Clients from './components/Clients';
import CashFlowDetail from './components/CashFlowDetail';
import OperatingProjection from './components/OperatingProjection';
// Lazy-loaded so the projection module's Recharts + canonical engine is
// not in the initial App bundle. This is the single largest chunk in the
// build — keeping it out of first paint cuts the dashboard's first
// interaction-time noticeably on cold loads.
const FinancialProjectionDashboard = lazy(() => import('./modules/financial-projection/pages/FinancialProjectionDashboard'));
const FinancialPlanningDashboard = lazy(() => import('./modules/financial-planning/pages/FinancialPlanningDashboard'));
const TaxDashboard = lazy(() => import('./modules/taxes/pages/TaxDashboard'));
import ErrorBoundary from './components/ErrorBoundary';
import MidasSplash, { type BootStep } from './components/MidasSplash';
import { ActivityFeedPanel } from './components/ActivityFeed';
import { useCommandPalette } from './components/CommandPalette';
import CommandPalette from './components/CommandPalette';
import { KeyboardShortcutsModal, useKeyboardShortcuts } from './components/KeyboardShortcuts';
import {
  LayoutDashboard,
  Users, UserSquare, Download, LineChart,
  Building2, Loader2, ChevronDown, AlertCircle, Landmark, Check,
  HandCoins, ChevronRight, BookUser, Activity, TrendingUp,
  Receipt, Wallet, FolderPlus, Pencil, Trash2, X, FolderOpen,
  Bell, ClipboardList, BarChart3,
  type LucideIcon,
} from 'lucide-react';
import { CompanyGroup, loadCompanyGroups, saveCompanyGroups, newGroupId, GROUP_COLORS } from './domain/companyGroups';
import type { Budget } from './domain/budget';
import { parseBudgetCsv } from './domain/budget';
import { loadBudget, saveBudget } from './domain/budgetPersistence';
import {
  attachImportedStatementsToKnownCompanies,
  mergeBankStatements,
  type BankQueryState,
} from './domain/bankStatements';
import { SANTANDER_FILE_FORMAT } from './domain/santanderCsv';

const DEFAULT_BUDGET_CSV_URL = `${import.meta.env.BASE_URL}presupuesto.csv`;

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
    { id: 'operating',   label: 'Operativa',   icon: LineChart },
  ],
};

const SECTION_FOR_TAB: Partial<Record<TabId, SectionId>> = {
  clients: 'catalogos', providers: 'catalogos',
  netflow: 'operacion', bancos: 'operacion',
  cxp: 'operacion', collections: 'operacion',
  dashboard: 'proyeccion',
  financialProjection: 'proyeccion', financialPlanning: 'proyeccion', taxes: 'proyeccion',
  operating: 'proyeccion',
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
        <div className="skeleton h-10 w-48 rounded-xl opacity-50" />
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
  // UI status for the auto/manual bank refresh — shown as a pill in Flujo Neto.
  const [bankFetchStatus, setBankFetchStatus] = useState<
    'idle' | 'priming' | 'ranging'
  >('idle');
  const [bankFetchProgress, setBankFetchProgress] = useState<
    { done: number; total: number } | null
  >(null);

  // Caja inicial fija — decisión de negocio, no editable por el usuario.
  const effectiveStartingBalance = FIXED_STARTING_BALANCE;

  const confirmPayment = (p: ConfirmedPayment) => setConfirmedPayments(prev => [...prev, p]);
  const unconfirmPayment = (key: string) => setConfirmedPayments(prev => prev.filter(x => x.key !== key));

  // ── New UI features state ──
  const { open: cmdOpen, setOpen: setCmdOpen } = useCommandPalette();
  const [activityOpen, setActivityOpen] = useState(false);

  const TAB_IDS: TabId[] = ['clients', 'providers', 'netflow', 'bancos', 'dashboard', 'financialProjection', 'financialPlanning', 'collections', 'cxp', 'operating'];
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
      cashFlowOverrides,
      lastSaved: new Date().toISOString(),
    };
    latestStoreRef.current = snapshot;
    const timer = setTimeout(() => saveStore(snapshot), 200);
    return () => clearTimeout(timer);
  }, [
    providers, clients,
    assumptions, confirmedPayments, cxpRecords, cxpLoadedCias,
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
  // bank priming AND year-to-date ranging finished (status === 'idle'). The
  // splash shows a progress bar during ranging so the user sees concrete
  // progress instead of an indeterminate spinner.
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
    cxpAutoFetchDone.current = true;
    let cancelled = false;
    (async () => {
      for (const cia of activeCias) {
        if (cancelled) return;
        try {
          const data = await fetchAgedBalances({ cia });
          if (cancelled) return;
          const stamped = (data as CXPRecord[]).map(r => ({ ...r, cia }));
          setCxpRecords(prev => [...prev.filter(r => r.cia !== cia), ...stamped]);
          setCxpLoadedCias(prev => ({ ...prev, [cia]: new Date().toISOString() }));
        } catch {
          // Silent: si ninguna compañía carga, el empty state de CXP
          // deja al usuario "Consultar todas" o subir CSV manualmente.
        }
      }
    })();
    return () => { cancelled = true; };
  }, [companies]);

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
    try { localStorage.setItem('midas.bankStatements.v2', JSON.stringify(bankJdeStatements)); }
    catch { /* quota or serialization issue; ignore */ }
  }, [bankJdeStatements]);
  useEffect(() => {
    try {
      if (bankSupplementalStatements.length > 0) localStorage.setItem('midas.bankSupplementalStatements.v1', JSON.stringify(bankSupplementalStatements));
      else localStorage.removeItem('midas.bankSupplementalStatements.v1');
    } catch { /* ignore */ }
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

  // ── JDE: fetch bank statements on mount ──
  // Estrategia:
  //   1. Si NO hay nada cacheado, hacer un "prime" rápido de 1 día para
  //      poblar la UI al instante (hoy o últimos 5 días hábiles).
  //   2. SIEMPRE hacer backfill año-a-la-fecha (Ene 1 → hoy) en background,
  //      incluso si ya hay data cacheada — el cache típicamente es una foto
  //      de 1 día de sesiones pasadas y eso es precisamente lo que el usuario
  //      NO quiere para Flujo Neto. El range fetch mergea por (cia, cuenta,
  //      moneda) y reemplaza el state completo al terminar.
  //   3. Único escape: si el cache YA cubre >= 30 días distintos y la última
  //      query fue de hoy, consideramos que ya está fresco y nos saltamos.
  //   4. Si JDE está inalcanzable y no hay cache, cargamos demo data.
  // Refresh helper — extracted so the fetch effect and any manual
  // refresh button can share the same code path.
  const refreshBankStatementsRange = useCallback(async (force: boolean = false) => {
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
        return { primed: true, ranged: true };
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

    // ── Step 2: Backfill año-a-la-fecha ──
    setBankFetchStatus('ranging');
    setBankFetchProgress({ done: 0, total: 0 });
    let ranged = false;
    let lastTotal = 0;
    try {
      const full = await fetchBankStatementsRange(
        yearStart,
        today,
        defaultFormat,
        {
          concurrency: 6,
          onProgress: (done, total) => {
            lastTotal = total;
            setBankFetchProgress({ done, total });
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

  useEffect(() => {
    (async () => {
      // Sólo intentamos el refresh real de JDE. Si falla, la app se queda
      // sin datos de bancos — preferimos vacío antes que inyectar demo data
      // ficticia que ensucia los meses previos del flujo.
      await refreshBankStatementsRange(false);
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
            className="flex items-center rounded-lg p-0.5 gap-0.5"
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
              className="shell-icon-btn flex items-center justify-center w-9 h-9 rounded-lg flex-shrink-0 transition-colors duration-150"
            >
              <Bell className="w-4 h-4" strokeWidth={1.5} />
            </button>
            <button
              onClick={() => {
                const json = exportStore({
                  providers, clients,
                  assumptions, confirmedPayments, cxpRecords, cxpLoadedCias,
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
              className="shell-icon-btn flex items-center justify-center w-9 h-9 rounded-lg flex-shrink-0 transition-colors duration-150"
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
              <Dashboard
                companyCode={selectedCia}
                bankStatements={bankStatements}
                clients={clients}
                providers={providers}
                cxpRecords={cxpRecords}
                assumptions={assumptions}
                budget={budget}
                onOpenFlow={() => setActiveTab('financialPlanning')}
                startingBalance={effectiveStartingBalance}
              />
            )}
            {activeTab === 'financialProjection' && (
              <Suspense fallback={<LazyTabFallback label="Proyección Financiera" />}>
                <FinancialProjectionDashboard
                  companyCode={selectedCia}
                  bankStatements={bankStatements}
                  clients={clients}
                  providers={providers}
                  cxpRecords={cxpRecords}
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
                  bankStatements={bankStatements}
                  clients={clients}
                  providers={providers}
                  cxpRecords={cxpRecords}
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
                  bankStatements={bankStatements}
                  clients={clients}
                  providers={providers}
                  cxpRecords={cxpRecords}
                  assumptions={assumptions}
                  budget={budget}
                  startingBalance={effectiveStartingBalance}
                />
              </Suspense>
            )}
            {activeTab === 'operating' && (
              <OperatingProjection
                companyCode={selectedCia}
                bankStatements={bankStatements}
                clients={clients}
                providers={providers}
                cxpRecords={cxpRecords}
                assumptions={assumptions}
                budget={budget}
              />
            )}
            {activeTab === 'clients' && (
              <Clients
                clients={clients}
                assumptions={assumptions}
                confirmedPayments={confirmedPayments}
                onReplace={setClients}
                onAdd={addClient}
                onUpdate={updateClient}
                onDelete={deleteClient}
              />
            )}
            {activeTab === 'collections' && (
              <CollectionProjection
                clients={clients}
                assumptions={assumptions}
                onAssumptionsChange={setAssumptions}
                confirmedPayments={confirmedPayments}
                onConfirm={confirmPayment}
                onUnconfirm={unconfirmPayment}
                cxpRecords={cxpRecords}
                bankStatements={bankStatements}
                companies={companies}
              />
            )}
            {activeTab === 'providers' && (
              <Providers
                providers={providers}
                cxpRecords={cxpRecords}
                onReplace={setProviders}
                onAdd={addProvider}
                onUpdate={updateProvider}
                onDelete={deleteProvider}
              />
            )}
            {activeTab === 'cxp' && (
              <CXP
                records={cxpRecords}
                loadedCias={cxpLoadedCias}
                companies={companies}
                selectedCia={selectedCia}
                providers={providers}
                clients={clients}
                assumptions={assumptions}
                bankStatements={bankStatements}
                budget={budget}
                onMergeCia={mergeCxpForCia}
                onReplaceAll={replaceAllCxp}
                onReset={resetCxp}
              />
            )}
            {activeTab === 'bancos' && (
              <Bancos
                selectedCia={selectedCia}
                statements={bankStatements}
                supplementalStatements={bankSupplementalStatements}
                onJdeStatementsChange={setBankJdeStatements}
                onSupplementalStatementsChange={setBankSupplementalStatements}
                lastQuery={bankLastQuery}
                onLastQueryChange={setBankLastQuery}
                companies={companies}
              />
            )}
            {activeTab === 'netflow' && (
              <CashFlowDetail
                clients={clients}
                cxpRecords={cxpRecords}
                assumptions={assumptions}
                confirmedPayments={confirmedPayments}
                bankStatements={bankStatements}
                companies={companies}
                bankFetchStatus={bankFetchStatus}
                bankFetchProgress={bankFetchProgress}
                onRefreshBanks={() => refreshBankStatementsRange(true)}
                startingBalance={effectiveStartingBalance}
              />
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
        simulations={[]}
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
        className="shell-picker-btn flex items-center gap-1.5 h-9 px-3 rounded-lg text-[13px] font-medium transition-colors duration-150 max-w-[300px]"
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
          className="absolute right-0 top-11 w-[360px] rounded-lg border p-1.5 z-50 max-h-[520px] overflow-y-auto animate-slide-down"
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
                className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg text-[13px] text-left transition"
                style={{ background: selectedCia === 'all' ? 'var(--primary-muted)' : undefined, color: selectedCia === 'all' ? 'var(--primary)' : 'var(--gray-950)' }}
              >
                <span className="font-medium">Todas las compañías</span>
                {selectedCia === 'all' && <Check className="w-3.5 h-3.5" />}
              </button>

              {/* Groups section */}
              {groups.length > 0 && (
                <div className="mt-2 mb-1">
                  <div className="text-[10px] uppercase tracking-wider text-[var(--gray-400)] px-3 py-1 font-medium">Grupos</div>
                  {groups.map(g => {
                    const isActive = selectedCia === g.id;
                    return (
                      <div key={g.id} className="flex items-center group">
                        <button
                          onClick={() => { onSelect(g.id); setOpen(false); }}
                          className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] text-left transition"
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
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] text-left transition hover:bg-[var(--gray-50)]"
                style={{ color: 'var(--primary)' }}
              >
                <FolderPlus className="w-4 h-4" />
                <span className="font-medium">Crear grupo de empresas</span>
              </button>

              {/* Divider */}
              <div className="h-px bg-[var(--gray-100)] my-1.5" />

              {/* Individual companies */}
              <div className="text-[10px] uppercase tracking-wider text-[var(--gray-400)] px-3 py-1 font-medium">Empresas individuales</div>
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
                      className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-[13px] text-left transition"
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
                <h3 className="text-[14px] font-semibold text-[var(--gray-950)]">
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
                <div className="space-y-1 max-h-48 overflow-y-auto border border-[var(--gray-200)] rounded-lg p-1.5">
                  {companies.filter(c => c.activa !== false).map(c => {
                    const checked = groupCias.has(c.cia);
                    return (
                      <button
                        key={c.cia}
                        onClick={() => toggleCia(c.cia)}
                        className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[12px] text-left transition ${
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
                  className="flex-1 h-9 rounded-lg border border-[var(--gray-200)] text-[13px] text-[var(--gray-500)] hover:bg-[var(--gray-50)]"
                >
                  Cancelar
                </button>
                <button
                  onClick={saveGroup}
                  disabled={!groupName.trim() || groupCias.size === 0}
                  className="flex-1 h-9 rounded-lg text-white text-[13px] font-medium hover-press disabled:opacity-40 disabled:cursor-not-allowed"
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
