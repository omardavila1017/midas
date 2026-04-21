import { useState, useEffect, useRef, useCallback } from 'react';
import { BASE_SCENARIO_ID, FlowPlan, ForecastConfidenceOverride, ForecastGranularity, Simulation, Scenario, ScenarioCellOverride, Proposal, TabId, ForecastView } from './types';
import { Provider, Client, CashFlowAssumptions, ConfirmedPayment } from './domain/types';
import { FlowSenseStore, loadStore, saveStore, exportStore, CXPRecord } from './domain/persistence';
import { fetchClientCatalog, fetchProviderCatalog } from './services/catalog.service';
import { fetchCompanies, type Company, JdeApiError, type BankAccountStatement, type BankStatementFormat } from './services/jde';
import Upload from './components/Upload';
import Dashboard from './components/Dashboard';
import ScenarioWorkbench from './components/ScenarioWorkbench';
import CXP from './components/CXP';
import Bancos from './components/Bancos';
import Providers from './components/Providers';
import CollectionProjection from './components/CollectionProjection';
import Clients from './components/Clients';
import CashFlowDetail from './components/CashFlowDetail';
import Forecast from './components/Forecast';
import KpiCenter from './components/KpiCenter';
import { DEFAULT_ACTIVE_KPI_IDS, type CustomKpiDefinition, type KpiConfigOverride } from './domain/kpiCatalog';
import ErrorBoundary from './components/ErrorBoundary';
import { ToastProvider, useToast } from './components/Toast';
import { ActivityFeedProvider, useActivityFeed, ActivityFeedPanel } from './components/ActivityFeed';
import { useCommandPalette } from './components/CommandPalette';
import CommandPalette from './components/CommandPalette';
import { KeyboardShortcutsModal, useKeyboardShortcuts } from './components/KeyboardShortcuts';
import {
  LayoutDashboard, Lightbulb, FlaskConical, ArrowUpFromLine,
  Users, UserSquare, FileSpreadsheet, Download, LineChart, DollarSign, Sliders,
  Building2, Loader2, ChevronDown, AlertCircle, Landmark, Check,
  HandCoins, CreditCard, ChevronRight, BookUser, Activity, TrendingUp,
  Receipt, Wallet, FolderPlus, Pencil, Trash2, X, FolderOpen,
  Bell, Keyboard,
} from 'lucide-react';
import { hex } from './theme';
import { CompanyGroup, loadCompanyGroups, saveCompanyGroups, newGroupId, GROUP_COLORS, resolveActiveCias } from './domain/companyGroups';

type SectionId = 'catalogos' | 'operacion' | 'proyeccion';

const SECTIONS: { id: SectionId; label: string; icon: any; description: string }[] = [
  { id: 'catalogos',  label: 'Catálogos',   icon: BookUser,        description: 'Clientes y proveedores' },
  { id: 'operacion',  label: 'Operación',   icon: Activity,        description: 'Flujo diario y bancos' },
  { id: 'proyeccion', label: 'Proyección',  icon: TrendingUp,      description: 'Dashboard, cobranza, CXP, pronóstico y escenarios' },
];

const SUB_TABS: Record<SectionId, { id: TabId; label: string; icon: any; needsPlan?: boolean }[]> = {
  catalogos: [
    { id: 'clients',   label: 'Clientes',     icon: UserSquare },
    { id: 'providers', label: 'Proveedores',  icon: Users },
  ],
  operacion: [
    { id: 'netflow',     label: 'Flujo Neto',  icon: Wallet },
    { id: 'bancos',      label: 'Bancos',      icon: Landmark },
  ],
  proyeccion: [
    { id: 'dashboard',   label: 'Dashboard',   icon: LayoutDashboard, needsPlan: true },
    { id: 'kpis',        label: 'KPIs',        icon: Sliders },
    { id: 'collections', label: 'Cobranza',    icon: HandCoins },
    { id: 'cxp',         label: 'CXP',         icon: Receipt },
    { id: 'forecast',    label: 'Pronóstico',  icon: LineChart, needsPlan: true },
    { id: 'scenarios',   label: 'Escenarios',  icon: FlaskConical, needsPlan: true },
  ],
};

const SECTION_FOR_TAB: Partial<Record<TabId, SectionId>> = {
  clients: 'catalogos', providers: 'catalogos',
  netflow: 'operacion', bancos: 'operacion',
  dashboard: 'proyeccion', kpis: 'proyeccion',
  collections: 'proyeccion', cxp: 'proyeccion',
  forecast: 'proyeccion', scenarios: 'proyeccion',
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
  const [plan, setPlan] = useState<FlowPlan | null>(null);
  const [simulations, setSimulations] = useState<Simulation[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [activeSimulationId, setActiveSimulationId] = useState<string | null>(null);
  const [activeScenarioId, setActiveScenarioId] = useState<string | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [assumptions, setAssumptions] = useState<CashFlowAssumptions>({
    year: new Date().getFullYear(),
    globalCompliance: 1,
    factorajeDays: 30,
  });
  const [confirmedPayments, setConfirmedPayments] = useState<ConfirmedPayment[]>([]);
  const [cxpRecords, setCxpRecords] = useState<CXPRecord[]>([]);
  const [cxpLoadedCias, setCxpLoadedCias] = useState<Record<string, string>>({});
  const [scenarioCellOverrides, setScenarioCellOverrides] = useState<ScenarioCellOverride[]>([]);
  const [forecastConfidenceOverrides, setForecastConfidenceOverrides] = useState<ForecastConfidenceOverride[]>([]);
  const [forecastGranularity, setForecastGranularity] = useState<ForecastGranularity>('monthly');
  const [activeKpiIds, setActiveKpiIds] = useState<string[]>([...DEFAULT_ACTIVE_KPI_IDS]);
  const [customKpis, setCustomKpis] = useState<CustomKpiDefinition[]>([]);
  const [kpiConfigs, setKpiConfigs] = useState<KpiConfigOverride[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>('netflow');
  const [showUpload, setShowUpload] = useState(false);
  const [catalogLoaded, setCatalogLoaded] = useState(false);

  // ── JDE integration state ──
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyGroups, setCompanyGroups] = useState<CompanyGroup[]>(() => loadCompanyGroups());
  const [selectedCia, setSelectedCia] = useState<string>(
    () => localStorage.getItem('flowsense.selectedCia') ?? 'all'
  );

  // Persist company groups
  useEffect(() => { saveCompanyGroups(companyGroups); }, [companyGroups]);
  const [companiesLoading, setCompaniesLoading] = useState(false);
  const [companiesError, setCompaniesError] = useState<string | null>(null);
  const [bankStatements, setBankStatements] = useState<BankAccountStatement[]>(() => {
    try {
      const raw = localStorage.getItem('flowsense.bankStatements.v2');
      const parsed = raw ? (JSON.parse(raw) as BankAccountStatement[]) : [];
      // Descartar demo data ficticia que pudo haber quedado cacheada de
      // versiones previas. Si detectamos CUALQUIER referencia demo dentro
      // del cache, lo tiramos entero — no vale la pena mezclar ficticio con
      // real en el flujo.
      if (containsDemoBankData(parsed)) {
        localStorage.removeItem('flowsense.bankStatements.v2');
        localStorage.removeItem('flowsense.bankLastQuery.v2');
        return [];
      }
      return parsed;
    } catch { return []; }
  });
  const [bankLastQuery, setBankLastQuery] = useState<{
    fechaEstadoCuenta: string;
    formatoElectronico: BankStatementFormat;
  } | null>(() => {
    try {
      const raw = localStorage.getItem('flowsense.bankLastQuery.v2');
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  });
  // UI status for the auto/manual bank refresh — shown as a pill in Flujo Neto.
  const [bankFetchStatus, setBankFetchStatus] = useState<
    'idle' | 'priming' | 'ranging'
  >('idle');
  const [bankFetchProgress, setBankFetchProgress] = useState<
    { done: number; total: number } | null
  >(null);

  const confirmPayment = (p: ConfirmedPayment) => setConfirmedPayments(prev => [...prev, p]);
  const unconfirmPayment = (key: string) => setConfirmedPayments(prev => prev.filter(x => x.key !== key));

  // ── New UI features state ──
  const { open: cmdOpen, setOpen: setCmdOpen } = useCommandPalette();
  const [activityOpen, setActivityOpen] = useState(false);

  const TAB_IDS: TabId[] = ['clients', 'providers', 'netflow', 'bancos', 'dashboard', 'kpis', 'collections', 'cxp', 'forecast', 'scenarios'];
  const { shortcutsOpen, setShortcutsOpen } = useKeyboardShortcuts({
    onTabSwitch: (n) => { if (n >= 1 && n <= TAB_IDS.length) setActiveTab(TAB_IDS[n - 1]); },
  });

  // Load from persistence on mount
  useEffect(() => {
    const stored = loadStore();
    if (stored) {
      if (stored.plan) setPlan(stored.plan);
      if (stored.simulations.length) setSimulations(stored.simulations);
      if (stored.scenarios.length) setScenarios(stored.scenarios);
      if (stored.proposals.length) setProposals(stored.proposals);
      setActiveSimulationId(stored.activeSimulationId ?? null);
      setActiveScenarioId(stored.activeScenarioId ?? null);
      if (stored.providers.length) setProviders(stored.providers);
      if (stored.clients.length) setClients(stored.clients);
      if (stored.confirmedPayments.length) setConfirmedPayments(stored.confirmedPayments);
      if (stored.cxpRecords.length) setCxpRecords(stored.cxpRecords);
      if (stored.cxpLoadedCias) setCxpLoadedCias(stored.cxpLoadedCias);
      if (stored.scenarioCellOverrides?.length) setScenarioCellOverrides(stored.scenarioCellOverrides);
      if (stored.forecastConfidenceOverrides?.length) setForecastConfidenceOverrides(stored.forecastConfidenceOverrides);
      if (stored.activeKpiIds) setActiveKpiIds(stored.activeKpiIds);
      if (stored.customKpis) setCustomKpis(stored.customKpis);
      if (stored.kpiConfigs) setKpiConfigs(stored.kpiConfigs);
      setAssumptions(stored.assumptions);
      setCatalogLoaded(true);
    }
  }, []);

  // Load clients from catalog if no clients exist yet
  useEffect(() => {
    if (catalogLoaded || clients.length > 0) return;
    fetchClientCatalog().then(loaded => {
      if (loaded.length > 0) {
        setClients(loaded);
        setCatalogLoaded(true);
      }
    });
  }, [catalogLoaded, clients.length]);

  // Load providers from the bundled catalog if none are loaded yet.
  // El catálogo vive en src/assets/providerCatalog.json y trae ~470
  // proveedores con su flexibilidad (inamovible/flexible/revisar) para
  // planeación. Se evita si el usuario ya tiene proveedores (subidos o
  // persistidos) para no pisar su edición.
  useEffect(() => {
    if (providers.length > 0) return;
    fetchProviderCatalog().then((loaded) => {
      if (loaded.length > 0) setProviders(loaded);
    });
  }, [providers.length]);

  useEffect(() => {
    if (simulations.length === 0) {
      if (activeSimulationId !== null) setActiveSimulationId(null);
      return;
    }

    if (activeScenarioId === BASE_SCENARIO_ID) {
      if (activeSimulationId !== null) setActiveSimulationId(null);
      return;
    }

    if (!activeSimulationId || !simulations.some((simulation) => simulation.id === activeSimulationId)) {
      setActiveSimulationId(simulations[0].id);
    }
  }, [activeSimulationId, activeScenarioId, simulations]);

  useEffect(() => {
    if (!activeSimulationId) {
      if (activeScenarioId !== null && scenarios.length > 0) {
        setActiveScenarioId(scenarios[0].id);
      }
      return;
    }

    const simulationScenarios = scenarios.filter((scenario) => scenario.simulationId === activeSimulationId);
    if (simulationScenarios.length === 0) {
      if (activeScenarioId !== null) setActiveScenarioId(null);
      return;
    }

    if (!activeScenarioId || !simulationScenarios.some((scenario) => scenario.id === activeScenarioId)) {
      setActiveScenarioId(
        simulations.find((simulation) => simulation.id === activeSimulationId)?.activeScenarioId
          ?? simulationScenarios[0].id,
      );
    }
  }, [activeSimulationId, activeScenarioId, simulations, scenarios]);

  // Save to localStorage after changes (debounced by 500ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      const store: FlowSenseStore = {
        plan, simulations, scenarios, providers, clients,
        proposals, activeSimulationId, activeScenarioId,
        activeKpiIds,
        customKpis,
        kpiConfigs,
        assumptions, confirmedPayments, cxpRecords, cxpLoadedCias,
        scenarioCellOverrides,
        forecastConfidenceOverrides,
        lastSaved: new Date().toISOString(),
      };
      saveStore(store);
    }, 500);
    return () => clearTimeout(timer);
  }, [
    plan,
    simulations,
    scenarios,
    proposals,
    activeSimulationId,
    activeScenarioId,
    activeKpiIds,
    customKpis,
    kpiConfigs,
    providers,
    clients,
    assumptions,
    confirmedPayments,
    cxpRecords,
    cxpLoadedCias,
    scenarioCellOverrides,
    forecastConfidenceOverrides,
  ]);

  // ── JDE: load companies on mount (demo fallback if unreachable) ──
  const loadCompanies = useCallback(async () => {
    setCompaniesLoading(true);
    setCompaniesError(null);
    try {
      const list = await fetchCompanies();
      if (list.length > 0) {
        setCompanies(list);
      } else {
        throw new Error('empty');
      }
    } catch (e) {
      // JDE unreachable — load demo companies for development
      const demoCompanies: Company[] = [
        { cia: '00011', nombre: 'Transportes del Norte', rfc: 'TNO850101AAA', monedaBase: 'MXN', activa: true },
        { cia: '00038', nombre: 'Senda Citi', rfc: 'SCI900201BBB', monedaBase: 'MXN', activa: true },
        { cia: '00050', nombre: 'Turistar Lujo', rfc: 'TLU880301CCC', monedaBase: 'MXN', activa: true },
        { cia: '00060', nombre: 'Transportes Tamaulipecos', rfc: 'TTA870401DDD', monedaBase: 'MXN', activa: true },
      ];
      setCompanies(demoCompanies);
      // Don't show error if we loaded demo data
    } finally {
      setCompaniesLoading(false);
    }
  }, []);

  useEffect(() => { loadCompanies(); }, [loadCompanies]);

  // Persist selected cia (clear to 'all' if it disappears from the catalog)
  useEffect(() => {
    localStorage.setItem('flowsense.selectedCia', selectedCia);
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
    try { localStorage.setItem('flowsense.bankStatements.v2', JSON.stringify(bankStatements)); }
    catch { /* quota or serialization issue; ignore */ }
  }, [bankStatements]);
  useEffect(() => {
    try {
      if (bankLastQuery) localStorage.setItem('flowsense.bankLastQuery.v2', JSON.stringify(bankLastQuery));
      else localStorage.removeItem('flowsense.bankLastQuery.v2');
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
      for (const acc of bankStatements) {
        for (const mov of acc.movimientos) distinctDates.add(mov.fechaOperacion);
      }
      const cacheIsFresh =
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

    const { fetchBankStatements, fetchBankStatementsRange } = await import('./services/jde');

    setBankFetchStatus('priming');

    // ── Step 1: Prime con 1 día (solo si no hay cache o force) ──
    let primed = !force && bankStatements.length > 0;
    if (!primed) {
      for (const fecha of tryDates) {
        try {
          const res = await fetchBankStatements({
            fechaEstadoCuenta: fecha,
            formatoElectronico: defaultFormat,
          });
          if (res.length > 0) {
            setBankStatements(res);
            setBankLastQuery({ fechaEstadoCuenta: fecha, formatoElectronico: defaultFormat });
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
    try {
      const full = await fetchBankStatementsRange(
        yearStart,
        today,
        defaultFormat,
        {
          concurrency: 6,
          onProgress: (done, total) => {
            setBankFetchProgress({ done, total });
          },
        },
      );
      if (full.length > 0) {
        setBankStatements(full);
        setBankLastQuery({
          fechaEstadoCuenta: today,
          formatoElectronico: defaultFormat,
        });
        ranged = true;
      }
    } catch {
      // Keep the last known state visible when the range refresh fails.
    }

    setBankFetchStatus('idle');
    setBankFetchProgress(null);
    return { primed, ranged };
  // bankStatements & bankLastQuery are intentionally read inside; stable callback
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const addSimulation = (p: Simulation) => {
    setSimulations(prev => [...prev, p]);
    setActiveSimulationId(p.id);
  };
  const updateSimulation = (p: Simulation) => setSimulations(prev => prev.map(x => x.id === p.id ? p : x));
  const deleteSimulation = (id: string) => {
    const nextSimulations = simulations.filter(x => x.id !== id);
    const nextScenarios = scenarios.filter(x => x.simulationId !== id);
    const nextScenarioIds = new Set(nextScenarios.map((scenario) => scenario.id));
    setSimulations(nextSimulations);
    setScenarios(nextScenarios);
    setActiveSimulationId(current => current === id ? (nextSimulations[0]?.id ?? null) : current);
    setActiveScenarioId(current => {
      if (!current) return nextScenarios[0]?.id ?? null;
      return nextScenarioIds.has(current) ? current : (nextScenarios[0]?.id ?? null);
    });
    setScenarioCellOverrides(prev => prev.filter(override => nextScenarioIds.has(override.scenarioId)));
  };
  const saveScenario = (s: Scenario) => {
    setScenarios(prev => [...prev, s]);
    setActiveSimulationId(s.simulationId);
    setActiveScenarioId(s.id);
    setSimulations(prev => prev.map((simulation) => (
      simulation.id === s.simulationId
        ? { ...simulation, activeScenarioId: s.id, updatedAt: new Date().toISOString() }
        : simulation
    )));
  };
  const updateScenario = (s: Scenario) => {
    if (s.id === BASE_SCENARIO_ID) return;
    setScenarios(prev => prev.map(x => x.id === s.id ? s : x));
    setSimulations(prev => prev.map((simulation) => (
      simulation.id === s.simulationId && simulation.activeScenarioId === s.id
        ? { ...simulation, activeScenarioId: s.id, updatedAt: new Date().toISOString() }
        : simulation
    )));
  };
  const deleteScenario = (id: string) => {
    if (id === BASE_SCENARIO_ID) return;
    const nextScenarios = scenarios.filter(x => x.id !== id);
    setScenarios(nextScenarios);
    setActiveScenarioId(current => current === id ? (nextScenarios[0]?.id ?? null) : current);
    setScenarioCellOverrides(prev => prev.filter(override => override.scenarioId !== id));
    setSimulations(prev => prev.map((simulation) => (
      simulation.activeScenarioId === id
        ? { ...simulation, activeScenarioId: nextScenarios.find((scenario) => scenario.simulationId === simulation.id)?.id }
        : simulation
    )));
  };
  const addProposal = (proposal: Proposal) => setProposals(prev => [...prev, proposal]);
  const updateProposal = (proposal: Proposal) => setProposals(prev => prev.map(item => item.id === proposal.id ? proposal : item));
  const deleteProposal = (id: string) => {
    setProposals(prev => prev.filter(item => item.id !== id));
    setScenarios(prev => prev.map((scenario) => ({
      ...scenario,
      proposalIds: scenario.proposalIds.filter(proposalId => proposalId !== id),
    })));
  };
  const selectSimulation = (simulationId: string) => {
    setActiveSimulationId(simulationId);
    const simulation = simulations.find((item) => item.id === simulationId);
    const simulationScenarios = scenarios.filter((scenario) => scenario.simulationId === simulationId);
    setActiveScenarioId(simulation?.activeScenarioId ?? simulationScenarios[0]?.id ?? null);
  };
  const selectScenario = (scenarioId: string | null) => {
    setActiveScenarioId(scenarioId);
    if (!scenarioId) return;
    const scenario = scenarios.find((item) => item.id === scenarioId);
    if (!scenario) return;
    setActiveSimulationId(scenario.simulationId ?? null);
    if (scenario.id === BASE_SCENARIO_ID) return;
    setSimulations(prev => prev.map((simulation) => (
      simulation.id === scenario.simulationId
        ? { ...simulation, activeScenarioId: scenarioId, updatedAt: new Date().toISOString() }
        : simulation
    )));
  };

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

  // The Upload screen is opt-in now: the app shell always renders so the user
  // can jump directly to Clientes / Cobranza / Proveedores without first
  // loading a FlowPlan.
  if (showUpload) {
    return <Upload onPlanLoaded={p => { setPlan(p); setShowUpload(false); setActiveTab('dashboard'); }} />;
  }

  const activeSection = SECTION_FOR_TAB[activeTab] ?? 'operacion';
  const subTabs = SUB_TABS[activeSection];

  const switchSection = (s: SectionId) => {
    if (s === activeSection) return;
    setActiveTab(DEFAULT_TAB[s]);
  };

  return (
    <div className="min-h-screen" style={{ background: 'var(--card)' }}>
      {/* ─── HEADER ─── */}
      <header className="border-b sticky top-0 z-50" style={{ borderColor: 'var(--gray-200)', background: 'var(--card)' }}>
        <div className="max-w-[1400px] mx-auto px-8 h-14 flex items-center justify-between">
          {/* Logo */}
          <div className="flex items-center gap-2.5 flex-shrink-0 hover-press cursor-pointer" onClick={() => setActiveTab('netflow')}>
            <div className="h-9 rounded-lg bg-white px-3 flex items-center justify-center border border-[var(--gray-200)]">
              <img src="/logos/senda-corporativo.svg" alt="Senda" className="h-7 w-auto object-contain" />
            </div>
            <span className="text-[15px] font-semibold tracking-[-0.02em]" style={{ color: 'var(--gray-950)' }}>
              FlowSense
            </span>
          </div>

          {/* Section nav — prominent, distinctive icons */}
          <nav className="flex items-center rounded-2xl p-1 gap-1" style={{ background: 'var(--gray-50)' }}>
            {SECTIONS.map(s => {
              const isActive = activeSection === s.id;
              // Status badge logic
              const catalogCount = clients.length + providers.length;
              const badge = s.id === 'proyeccion' && !plan
                ? 'Sin plan'
                : s.id === 'catalogos' && catalogCount > 0
                  ? `${catalogCount}`
                  : s.id === 'operacion' && (cxpRecords.length > 0 || bankStatements.length > 0)
                    ? 'Activo'
                    : null;
              const badgeColor = s.id === 'proyeccion' && !plan ? 'var(--warning)' : 'var(--gray-400)';
              return (
                <button
                  key={s.id}
                  onClick={() => switchSection(s.id)}
                  className={`relative flex items-center gap-2 px-5 py-2 rounded-xl text-[14px] font-semibold transition-all duration-300 whitespace-nowrap`}
                  style={{
                    color: isActive ? 'var(--gray-950)' : 'var(--gray-400)',
                    transitionTimingFunction: 'var(--spring)',
                  }}
                  title={s.description}
                >
                  {isActive && (
                    <span
                      className="absolute inset-0 bg-white rounded-xl animate-scale-in"
                      style={{ boxShadow: 'var(--shadow-sm)' }}
                    />
                  )}
                  <span className="relative flex items-center gap-2">
                    <s.icon
                      className="w-[18px] h-[18px] transition-colors duration-300"
                      style={{ color: isActive ? 'var(--primary)' : undefined }}
                    />
                    {s.label}
                    {badge && (
                      <span
                        className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
                        style={{
                          background: s.id === 'proyeccion' && !plan ? 'var(--warning-muted)' : 'var(--gray-100)',
                          color: badgeColor,
                        }}
                      >
                        {badge}
                      </span>
                    )}
                  </span>
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
              className="flex items-center justify-center w-10 h-10 rounded-xl hover-press flex-shrink-0 transition-all duration-200"
              style={{ color: 'var(--gray-400)' }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--gray-950)'; e.currentTarget.style.background = 'var(--gray-100)'; }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--gray-400)'; e.currentTarget.style.background = 'transparent'; }}
            >
              <Bell className="w-[18px] h-[18px]" />
            </button>
            <button
              onClick={() => {
                const json = exportStore({
                  plan, simulations, scenarios, providers, clients,
                  proposals, activeSimulationId, activeScenarioId,
                  activeKpiIds,
                  customKpis,
                  kpiConfigs,
                  assumptions, confirmedPayments, cxpRecords, cxpLoadedCias,
                  scenarioCellOverrides,
                  forecastConfidenceOverrides,
                  lastSaved: new Date().toISOString(),
                });
                const blob = new Blob([json], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `flowsense-backup-${new Date().toISOString().slice(0,10)}.json`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              title="Descargar respaldo"
              aria-label="Descargar respaldo JSON"
              className="flex items-center justify-center w-10 h-10 rounded-xl hover-press flex-shrink-0 transition-all duration-200"
              style={{ color: 'var(--gray-400)' }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--gray-950)'; e.currentTarget.style.background = 'var(--gray-100)'; }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--gray-400)'; e.currentTarget.style.background = 'transparent'; }}
            >
              <Download className="w-[18px] h-[18px]" />
            </button>
            <button
              onClick={() => setShowUpload(true)}
              title={plan ? 'Nuevo Plan' : 'Cargar Plan'}
              aria-label={plan ? 'Cargar nuevo Plan de Flujo' : 'Cargar Plan de Flujo'}
              className="flex items-center justify-center w-10 h-10 rounded-xl hover-press flex-shrink-0 transition-all duration-200"
              style={{ color: 'var(--gray-400)' }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--gray-950)'; e.currentTarget.style.background = 'var(--gray-100)'; }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--gray-400)'; e.currentTarget.style.background = 'transparent'; }}
            >
              <ArrowUpFromLine className="w-[18px] h-[18px]" />
            </button>
          </div>
        </div>
      </header>

      {/* ─── SUB-TABS with context breadcrumb ─── */}
      {subTabs.length > 0 && (
        <div className="border-b" style={{ background: 'oklch(100% 0 0 / 0.6)', borderColor: 'var(--gray-100)' }}>
          <div className="max-w-[1400px] mx-auto px-8">
            <div className="flex items-center gap-1 py-2">
              {/* Breadcrumb context */}
              <span className="text-[12px] font-medium mr-2 flex items-center gap-1" style={{ color: 'var(--gray-400)' }}>
                {SECTIONS.find(s => s.id === activeSection)?.label}
                <ChevronRight className="w-3 h-3" />
              </span>
              {subTabs.map(t => {
                const isActive = activeTab === t.id;
                const needsPlan = t.needsPlan && !plan;
                return (
                  <button
                    key={t.id}
                    onClick={() => setActiveTab(t.id)}
                    className="px-4 py-2.5 rounded-lg text-[13px] font-medium transition-all duration-200 touch-target-44"
                    style={{
                      background: isActive ? 'var(--primary-muted)' : undefined,
                      color: isActive ? 'var(--primary)' : 'var(--gray-500)',
                      opacity: needsPlan ? 0.5 : 1,
                    }}
                    title={needsPlan ? 'Requiere cargar un Plan de Flujo' : undefined}
                  >
                    {t.label}
                    {needsPlan && <span className="ml-1 text-[10px]" style={{ color: 'var(--warning)' }}>*</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ─── MAIN CONTENT ─── */}
      <main className="max-w-[1400px] mx-auto px-8 py-6">
        <div key={pageKey} className="animate-page-in">
          <ErrorBoundary fallbackLabel={subTabs.find(t => t.id === activeTab)?.label ?? activeTab}>
            {activeTab === 'dashboard' && (
              plan
                ? <>
                    <Dashboard plan={plan} simulations={simulations} />
                    <div className="mt-8 rounded-2xl border border-[var(--gray-200)] bg-white p-5 shadow-sm">
                      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                        <div>
                          <h2 className="text-[18px] font-semibold text-[var(--gray-950)] tracking-tight">
                            Pronóstico con Escenarios
                          </h2>
                          <p className="text-[13px] mt-0.5" style={{ color: 'var(--gray-400)' }}>
                            La vista detallada se abre en su propia pestaña para mantener el Dashboard ligero.
                          </p>
                        </div>
                        <button
                          onClick={() => setActiveTab('forecast')}
                          className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[var(--primary)] px-4 text-[13px] font-medium text-white transition hover:bg-[var(--primary-hover)]"
                        >
                          <LineChart className="h-4 w-4" />
                          Abrir pronóstico
                        </button>
                      </div>
                    </div>
                  </>
                : <PlanRequired onUpload={() => setShowUpload(true)} feature="Dashboard" />
            )}
            {activeTab === 'kpis' && (
              <KpiCenter
                clients={clients}
                assumptions={assumptions}
                confirmedPayments={confirmedPayments}
                cxpRecords={cxpRecords}
                bankStatements={bankStatements}
                plan={plan}
                simulations={simulations}
                scenarios={scenarios}
                proposals={proposals}
                overrides={scenarioCellOverrides}
                activeSimulationId={activeSimulationId}
                activeScenarioId={activeScenarioId}
                activeKpiIds={activeKpiIds}
                onActiveKpiIdsChange={setActiveKpiIds}
                defaultKpiIds={DEFAULT_ACTIVE_KPI_IDS}
                customKpis={customKpis}
                onCustomKpisChange={setCustomKpis}
                kpiConfigs={kpiConfigs}
                onKpiConfigsChange={setKpiConfigs}
              />
            )}
            {activeTab === 'clients' && (
              <Clients
                clients={clients}
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
                onReplace={setProviders}
                onAdd={addProvider}
                onUpdate={updateProvider}
                onDelete={deleteProvider}
              />
            )}
            {activeTab === 'scenarios' && (
              plan
                ? <ScenarioWorkbench
                    plan={plan}
                    simulations={simulations}
                    scenarios={scenarios}
                    proposals={proposals}
                    overrides={scenarioCellOverrides}
                    activeSimulationId={activeSimulationId}
                    activeScenarioId={activeScenarioId}
                    onSelectSimulation={selectSimulation}
                    onSelectScenario={selectScenario}
                    onAdd={addSimulation}
                    onUpdate={updateSimulation}
                    onDelete={deleteSimulation}
                    onAddScenario={saveScenario}
                    onUpdateScenario={updateScenario}
                    onDeleteScenario={deleteScenario}
                    onAddProposal={addProposal}
                    onUpdateProposal={updateProposal}
                    onDeleteProposal={deleteProposal}
                  />
                : <PlanRequired onUpload={() => setShowUpload(true)} feature="Propuestas" />
            )}
            {activeTab === 'forecast' && (
              plan
                ? <Forecast
                    plan={plan}
                    simulations={simulations}
                    scenarios={scenarios}
                    proposals={proposals}
                    activeSimulationId={activeSimulationId}
                    activeScenarioId={activeScenarioId}
                    overrides={scenarioCellOverrides}
                    confidenceOverrides={forecastConfidenceOverrides}
                    granularity={forecastGranularity}
                    cxpRecords={cxpRecords}
                    cxpLoadedCias={cxpLoadedCias}
                    onGranularityChange={setForecastGranularity}
                    onSelectScenario={selectScenario}
                    onOverridesChange={setScenarioCellOverrides}
                    onConfidenceOverridesChange={setForecastConfidenceOverrides}
                  />
                : <PlanRequired onUpload={() => setShowUpload(true)} feature="Pronóstico" />
            )}
            {/* Simulator tab removed — functionality lives in ScenarioWorkbench */}
            {activeTab === 'cxp' && (
              <CXP
                records={cxpRecords}
                loadedCias={cxpLoadedCias}
                companies={companies}
                selectedCia={selectedCia}
                providers={providers}
                onMergeCia={mergeCxpForCia}
                onReplaceAll={replaceAllCxp}
                onReset={resetCxp}
              />
            )}
            {activeTab === 'bancos' && (
              <Bancos
                selectedCia={selectedCia}
                statements={bankStatements}
                onStatementsChange={setBankStatements}
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
        simulations={simulations.map(p => ({ id: p.id, name: p.name }))}
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
        className="flex items-center gap-1.5 h-10 px-3 rounded-xl text-[13px] font-medium transition-all duration-200 max-w-[300px]"
        style={{ background: activeGroup ? `${activeGroup.color}12` : 'var(--gray-50)', color: 'var(--gray-950)' }}
        title="Compañía o grupo activo — filtra los datos de todas las pestañas"
      >
        {activeGroup
          ? <FolderOpen className="w-4 h-4 flex-shrink-0" style={{ color: activeGroup.color ?? 'var(--primary)' }} />
          : <Building2 className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--primary)' }} />
        }
        <span className="truncate">{loading ? 'Cargando…' : label}</span>
        {loading
          ? <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" style={{ color: 'var(--gray-400)' }} />
          : <ChevronDown className={`w-3.5 h-3.5 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} style={{ color: 'var(--gray-400)' }} />
        }
      </button>

      {open && (
        <div
          className="absolute right-0 top-12 w-[360px] rounded-2xl border p-1.5 z-50 max-h-[520px] overflow-y-auto animate-slide-down"
          style={{ background: 'var(--surface)', borderColor: 'var(--gray-200)', boxShadow: 'var(--shadow-lg)' }}
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
                      className={`w-7 h-7 rounded-full transition-all ${groupColor === c ? 'ring-2 ring-offset-2 ring-[var(--gray-300)]' : 'hover:scale-110'}`}
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

function PlanRequired({ onUpload, feature }: { onUpload: () => void; feature: string }) {
  const tips: Record<string, string> = {
    Dashboard: 'El Dashboard muestra KPIs anuales, flujo mensual y alertas de liquidez.',
    'Pronóstico': 'El Pronóstico permite ver proyecciones P&L y flujo de caja con escenarios.',
    Propuestas: 'Las Propuestas te permiten crear y comparar escenarios what-if.',
    Simulador: 'El Simulador modela el impacto de cambios en ingresos, costos y timing.',
  };
  return (
    <div className="flex flex-col items-center justify-center py-28 text-center">
      <div
        className="w-16 h-16 rounded-2xl flex items-center justify-center mb-5 animate-card-in"
        style={{ background: 'var(--gray-50)', boxShadow: 'var(--shadow-xs)' }}
      >
        <FileSpreadsheet className="w-7 h-7" style={{ color: 'var(--gray-400)' }} />
      </div>
      <h2 className="text-[22px] font-semibold tracking-[-0.02em] animate-card-in stagger-1" style={{ color: 'var(--gray-950)' }}>
        {feature} requiere un Plan de Flujo
      </h2>
      <p className="text-[13.5px] mt-2 max-w-[420px] leading-relaxed animate-card-in stagger-2" style={{ color: 'var(--gray-400)' }}>
        {tips[feature] || ''} Carga el flujo consolidado para comenzar.
        Mientras tanto puedes trabajar en Clientes, Cobranza y Proveedores.
      </p>
      <button
        onClick={onUpload}
        className="mt-6 flex items-center gap-2 px-5 h-10 rounded-xl text-white text-[13.5px] font-medium hover-press animate-card-in stagger-3"
        style={{ background: 'var(--primary)', boxShadow: '0 2px 8px oklch(55% 0.22 255 / 0.2)' }}
      >
        <ArrowUpFromLine className="w-4 h-4" /> Cargar Plan
      </button>
    </div>
  );
}
