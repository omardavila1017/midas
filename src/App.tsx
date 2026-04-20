import { useState, useEffect, useRef, useCallback } from 'react';
import { BASE_SCENARIO_ID, FlowPlan, ForecastGranularity, Proposal, Scenario, ScenarioCellOverride, Simulation, TabId, ForecastView } from './types';
import { Provider, Client, CashFlowAssumptions, ConfirmedPayment } from './domain/types';
import { FlowSenseStore, loadStore, saveStore, exportStore, CXPRecord } from './domain/persistence';
import { loadClientsCatalog } from './domain/loadClientsCatalog';
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
// NetCashFlowDashboard disabled — needs real JDE data to be useful
// import NetCashFlowDashboard from './components/NetCashFlowDashboard';
import ErrorBoundary from './components/ErrorBoundary';
import {
  LayoutDashboard, Lightbulb, FlaskConical, ArrowUpFromLine, Zap,
  Users, UserSquare, FileSpreadsheet, Download, LineChart, DollarSign, Sliders,
  Building2, Loader2, ChevronDown, AlertCircle, Landmark, Check,
} from 'lucide-react';
import { hex } from './theme';

type SectionId = 'cobros' | 'pagos' | 'plan';

const SECTIONS: { id: SectionId; label: string; icon: any }[] = [
  { id: 'cobros',   label: 'Cobros',     icon: UserSquare },
  { id: 'pagos',    label: 'Pagos',      icon: Users },
  { id: 'plan',     label: 'Plan',       icon: LayoutDashboard },
];

const SUB_TABS: Record<SectionId, { id: TabId; label: string; icon: any; needsPlan?: boolean }[]> = {
  cobros: [
    { id: 'clients',     label: 'Clientes', icon: UserSquare },
    { id: 'collections', label: 'Cobranza', icon: UserSquare },
    { id: 'netflow',     label: 'Flujo',    icon: LayoutDashboard },
  ],
  pagos: [
    { id: 'providers', label: 'Proveedores', icon: Users },
    { id: 'cxp',       label: 'CXP',         icon: Users },
    { id: 'bancos',    label: 'Bancos',      icon: Landmark },
  ],
  plan: [
    { id: 'dashboard',  label: 'Dashboard',   icon: LayoutDashboard, needsPlan: true },
    { id: 'forecast',   label: 'Pronóstico',  icon: LineChart, needsPlan: true },
    { id: 'scenarios',  label: 'Escenarios',  icon: FlaskConical, needsPlan: true },
  ],
};

const SECTION_FOR_TAB: Partial<Record<TabId, SectionId>> = {
  clients: 'cobros', collections: 'cobros', netflow: 'cobros',
  providers: 'pagos', cxp: 'pagos', bancos: 'pagos',
  dashboard: 'plan', forecast: 'plan', scenarios: 'plan',
};

const DEFAULT_TAB: Record<SectionId, TabId> = {
  cobros: 'clients',
  pagos: 'providers',
  plan: 'dashboard',
};

export default function App() {
  const [plan, setPlan] = useState<FlowPlan | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [simulations, setSimulations] = useState<Simulation[]>([]);
  const [activeProposalId, setActiveProposalId] = useState<string | null>(null);
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
  const [forecastGranularity, setForecastGranularity] = useState<ForecastGranularity>('monthly');
  const [activeTab, setActiveTab] = useState<TabId>('clients');
  const [showUpload, setShowUpload] = useState(false);
  const [catalogLoaded, setCatalogLoaded] = useState(false);

  // ── JDE integration state ──
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCia, setSelectedCia] = useState<string>(
    () => localStorage.getItem('flowsense.selectedCia') ?? 'all'
  );
  const [companiesLoading, setCompaniesLoading] = useState(false);
  const [companiesError, setCompaniesError] = useState<string | null>(null);
  const [bankStatements, setBankStatements] = useState<BankAccountStatement[]>(() => {
    try {
      const raw = localStorage.getItem('flowsense.bankStatements');
      return raw ? (JSON.parse(raw) as BankAccountStatement[]) : [];
    } catch { return []; }
  });
  const [bankLastQuery, setBankLastQuery] = useState<{
    fechaEstadoCuenta: string;
    formatoElectronico: BankStatementFormat;
  } | null>(() => {
    try {
      const raw = localStorage.getItem('flowsense.bankLastQuery');
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  });

  const confirmPayment = (p: ConfirmedPayment) => setConfirmedPayments(prev => [...prev, p]);
  const unconfirmPayment = (key: string) => setConfirmedPayments(prev => prev.filter(x => x.key !== key));

  // Load from persistence on mount
  useEffect(() => {
    const stored = loadStore();
    if (stored) {
      if (stored.plan) setPlan(stored.plan);
      if (stored.proposals.length) setProposals(stored.proposals);
      if (stored.scenarios.length) setScenarios(stored.scenarios);
      if (stored.simulations.length) setSimulations(stored.simulations);
      setActiveProposalId(stored.activeProposalId ?? null);
      setActiveScenarioId(stored.activeScenarioId ?? null);
      if (stored.providers.length) setProviders(stored.providers);
      if (stored.clients.length) setClients(stored.clients);
      if (stored.confirmedPayments.length) setConfirmedPayments(stored.confirmedPayments);
      if (stored.cxpRecords.length) setCxpRecords(stored.cxpRecords);
      if (stored.cxpLoadedCias) setCxpLoadedCias(stored.cxpLoadedCias);
      if (stored.scenarioCellOverrides?.length) setScenarioCellOverrides(stored.scenarioCellOverrides);
      setAssumptions(stored.assumptions);
      setCatalogLoaded(true);
    }
  }, []);

  // Auto-load clients from catalog if no clients exist yet
  useEffect(() => {
    if (catalogLoaded || clients.length > 0) return;
    loadClientsCatalog().then(loaded => {
      if (loaded.length > 0) {
        setClients(loaded);
        setCatalogLoaded(true);
      }
    });
  }, [catalogLoaded, clients.length]);

  useEffect(() => {
    if (proposals.length === 0) {
      if (activeProposalId !== null) setActiveProposalId(null);
      return;
    }

    if (activeScenarioId === BASE_SCENARIO_ID) {
      if (activeProposalId !== null) setActiveProposalId(null);
      return;
    }

    if (!activeProposalId || !proposals.some((proposal) => proposal.id === activeProposalId)) {
      setActiveProposalId(proposals[0].id);
    }
  }, [activeProposalId, activeScenarioId, proposals]);

  useEffect(() => {
    if (!activeProposalId) {
      if (activeScenarioId !== null && scenarios.length > 0) {
        setActiveScenarioId(scenarios[0].id);
      }
      return;
    }

    const proposalScenarios = scenarios.filter((scenario) => scenario.proposalId === activeProposalId);
    if (proposalScenarios.length === 0) {
      if (activeScenarioId !== null) setActiveScenarioId(null);
      return;
    }

    if (!activeScenarioId || !proposalScenarios.some((scenario) => scenario.id === activeScenarioId)) {
      setActiveScenarioId(
        proposals.find((proposal) => proposal.id === activeProposalId)?.activeScenarioId
          ?? proposalScenarios[0].id,
      );
    }
  }, [activeProposalId, activeScenarioId, proposals, scenarios]);

  // Auto-save to localStorage (debounced by 500ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      const store: FlowSenseStore = {
        plan, proposals, scenarios, providers, clients,
        simulations, activeProposalId, activeScenarioId,
        assumptions, confirmedPayments, cxpRecords, cxpLoadedCias,
        scenarioCellOverrides,
        lastSaved: new Date().toISOString(),
      };
      saveStore(store);
    }, 500);
    return () => clearTimeout(timer);
  }, [
    plan,
    proposals,
    scenarios,
    simulations,
    activeProposalId,
    activeScenarioId,
    providers,
    clients,
    assumptions,
    confirmedPayments,
    cxpRecords,
    cxpLoadedCias,
    scenarioCellOverrides,
  ]);

  // ── JDE: load companies on mount ──
  const loadCompanies = useCallback(async () => {
    setCompaniesLoading(true);
    setCompaniesError(null);
    try {
      const list = await fetchCompanies();
      setCompanies(list);
    } catch (e) {
      setCompaniesError(
        e instanceof JdeApiError ? `${e.status}: ${e.message}` : (e as Error).message
      );
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
        && !companies.some(c => c.cia === selectedCia)) {
      setSelectedCia('all');
    }
  }, [companies, selectedCia]);

  // Persist bank statements + last query
  useEffect(() => {
    try { localStorage.setItem('flowsense.bankStatements', JSON.stringify(bankStatements)); }
    catch { /* quota or serialization issue; ignore */ }
  }, [bankStatements]);
  useEffect(() => {
    try {
      if (bankLastQuery) localStorage.setItem('flowsense.bankLastQuery', JSON.stringify(bankLastQuery));
      else localStorage.removeItem('flowsense.bankLastQuery');
    } catch { /* ignore */ }
  }, [bankLastQuery]);

  /* ── Animated page key for re-mount on tab change ── */
  const [pageKey, setPageKey] = useState(0);
  const prevTab = useRef(activeTab);
  useEffect(() => {
    if (prevTab.current !== activeTab) { setPageKey(k => k + 1); prevTab.current = activeTab; }
  }, [activeTab]);

  const addProposal = (p: Proposal) => {
    setProposals(prev => [...prev, p]);
    setActiveProposalId(p.id);
  };
  const updateProposal = (p: Proposal) => setProposals(prev => prev.map(x => x.id === p.id ? p : x));
  const deleteProposal = (id: string) => {
    const nextProposals = proposals.filter(x => x.id !== id);
    const nextScenarios = scenarios.filter(x => x.proposalId !== id);
    const nextScenarioIds = new Set(nextScenarios.map((scenario) => scenario.id));
    setProposals(nextProposals);
    setScenarios(nextScenarios);
    setActiveProposalId(current => current === id ? (nextProposals[0]?.id ?? null) : current);
    setActiveScenarioId(current => {
      if (!current) return nextScenarios[0]?.id ?? null;
      return nextScenarioIds.has(current) ? current : (nextScenarios[0]?.id ?? null);
    });
    setScenarioCellOverrides(prev => prev.filter(override => nextScenarioIds.has(override.scenarioId)));
  };
  const saveScenario = (s: Scenario) => {
    setScenarios(prev => [...prev, s]);
    setActiveProposalId(s.proposalId);
    setActiveScenarioId(s.id);
    setProposals(prev => prev.map((proposal) => (
      proposal.id === s.proposalId
        ? { ...proposal, activeScenarioId: s.id, updatedAt: new Date().toISOString() }
        : proposal
    )));
  };
  const updateScenario = (s: Scenario) => {
    if (s.id === BASE_SCENARIO_ID) return;
    setScenarios(prev => prev.map(x => x.id === s.id ? s : x));
    setProposals(prev => prev.map((proposal) => (
      proposal.id === s.proposalId && proposal.activeScenarioId === s.id
        ? { ...proposal, activeScenarioId: s.id, updatedAt: new Date().toISOString() }
        : proposal
    )));
  };
  const deleteScenario = (id: string) => {
    if (id === BASE_SCENARIO_ID) return;
    const nextScenarios = scenarios.filter(x => x.id !== id);
    setScenarios(nextScenarios);
    setActiveScenarioId(current => current === id ? (nextScenarios[0]?.id ?? null) : current);
    setScenarioCellOverrides(prev => prev.filter(override => override.scenarioId !== id));
    setProposals(prev => prev.map((proposal) => (
      proposal.activeScenarioId === id
        ? { ...proposal, activeScenarioId: nextScenarios.find((scenario) => scenario.proposalId === proposal.id)?.id }
        : proposal
    )));
  };
  const addSimulation = (simulation: Simulation) => setSimulations(prev => [...prev, simulation]);
  const updateSimulation = (simulation: Simulation) => setSimulations(prev => prev.map(item => item.id === simulation.id ? simulation : item));
  const deleteSimulation = (id: string) => {
    setSimulations(prev => prev.filter(item => item.id !== id));
    setScenarios(prev => prev.map((scenario) => ({
      ...scenario,
      simulationIds: scenario.simulationIds.filter(simulationId => simulationId !== id),
    })));
  };
  const selectProposal = (proposalId: string) => {
    setActiveProposalId(proposalId);
    const proposal = proposals.find((item) => item.id === proposalId);
    const proposalScenarios = scenarios.filter((scenario) => scenario.proposalId === proposalId);
    setActiveScenarioId(proposal?.activeScenarioId ?? proposalScenarios[0]?.id ?? null);
  };
  const selectScenario = (scenarioId: string | null) => {
    setActiveScenarioId(scenarioId);
    if (!scenarioId) return;
    const scenario = scenarios.find((item) => item.id === scenarioId);
    if (!scenario) return;
    setActiveProposalId(scenario.proposalId ?? null);
    if (scenario.id === BASE_SCENARIO_ID) return;
    setProposals(prev => prev.map((proposal) => (
      proposal.id === scenario.proposalId
        ? { ...proposal, activeScenarioId: scenarioId, updatedAt: new Date().toISOString() }
        : proposal
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

  const activeSection = SECTION_FOR_TAB[activeTab] ?? 'cobros';
  const subTabs = SUB_TABS[activeSection];

  const switchSection = (s: SectionId) => {
    if (s === activeSection) return;
    setActiveTab(DEFAULT_TAB[s]);
  };

  return (
    <div className="min-h-screen" style={{ background: 'var(--surface-alt)' }}>
      {/* ─── HEADER ─── */}
      <header className="glass border-b sticky top-0 z-50" style={{ borderColor: 'var(--gray-200)' }}>
        <div className="max-w-[1400px] mx-auto px-8 h-14 flex items-center justify-between">
          {/* Logo */}
          <div className="flex items-center gap-2.5 flex-shrink-0 hover-press cursor-pointer" onClick={() => setActiveTab('clients')}>
            <div
              className="w-8 h-8 rounded-[10px] flex items-center justify-center"
              style={{
                background: 'linear-gradient(135deg, var(--primary), var(--info))',
                boxShadow: '0 2px 8px oklch(55% 0.22 255 / 0.2)',
              }}
            >
              <Zap className="w-4 h-4 text-white" strokeWidth={2.5} />
            </div>
            <span className="text-[15px] font-semibold tracking-[-0.02em]" style={{ color: 'var(--gray-950)' }}>
              FlowSense
            </span>
          </div>

          {/* 4-section nav */}
          <nav className="flex items-center rounded-full p-[3px] gap-[2px]" style={{ background: 'var(--gray-50)' }}>
            {SECTIONS.map(s => {
              const isActive = activeSection === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => switchSection(s.id)}
                  className={`relative flex items-center gap-1.5 px-4 py-[7px] rounded-full text-[13.5px] font-medium transition-all duration-300 whitespace-nowrap`}
                  style={{
                    color: isActive ? 'var(--gray-950)' : 'var(--gray-400)',
                    transitionTimingFunction: 'var(--spring)',
                  }}
                >
                  {isActive && (
                    <span
                      className="absolute inset-0 bg-white rounded-full animate-scale-in"
                      style={{ boxShadow: 'var(--shadow-sm)' }}
                    />
                  )}
                  <span className="relative flex items-center gap-1.5">
                    <s.icon
                      className="w-4 h-4 transition-colors duration-300"
                      style={{ color: isActive ? 'var(--primary)' : undefined }}
                    />
                    {s.label}
                  </span>
                </button>
              );
            })}
          </nav>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <CompanySelector
              companies={companies}
              selectedCia={selectedCia}
              loading={companiesLoading}
              error={companiesError}
              onSelect={setSelectedCia}
              onRetry={loadCompanies}
            />
            <button
              onClick={() => {
                const json = exportStore({
                  plan, proposals, scenarios, providers, clients,
                  simulations, activeProposalId, activeScenarioId,
                  assumptions, confirmedPayments, cxpRecords, cxpLoadedCias,
                  scenarioCellOverrides,
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
              className="flex items-center justify-center w-9 h-9 rounded-xl hover-press flex-shrink-0 transition-all duration-200"
              style={{ color: 'var(--gray-400)' }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--gray-950)'; e.currentTarget.style.background = 'var(--gray-100)'; }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--gray-400)'; e.currentTarget.style.background = 'transparent'; }}
            >
              <Download className="w-[18px] h-[18px]" />
            </button>
            <button
              onClick={() => setShowUpload(true)}
              title={plan ? 'Nuevo Plan' : 'Cargar Plan'}
              className="flex items-center justify-center w-9 h-9 rounded-xl hover-press flex-shrink-0 transition-all duration-200"
              style={{ color: 'var(--gray-400)' }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--gray-950)'; e.currentTarget.style.background = 'var(--gray-100)'; }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--gray-400)'; e.currentTarget.style.background = 'transparent'; }}
            >
              <ArrowUpFromLine className="w-[18px] h-[18px]" />
            </button>
          </div>
        </div>
      </header>

      {/* ─── SUB-TABS ─── */}
      {subTabs.length > 0 && (
        <div className="border-b" style={{ background: 'oklch(100% 0 0 / 0.6)', borderColor: 'var(--gray-100)' }}>
          <div className="max-w-[1400px] mx-auto px-8">
            <div className="flex items-center gap-1 py-1.5">
              {subTabs.map(t => {
                const isActive = activeTab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setActiveTab(t.id)}
                    className="px-4 py-2 rounded-lg text-[13px] font-medium transition-all duration-200"
                    style={{
                      background: isActive ? 'var(--primary-muted)' : undefined,
                      color: isActive ? 'var(--primary)' : 'var(--gray-500)',
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
      <main className="max-w-[1400px] mx-auto px-8 py-6">
        <div key={pageKey} className="animate-page-in">
          <ErrorBoundary fallbackLabel={subTabs.find(t => t.id === activeTab)?.label ?? activeTab}>
            {activeTab === 'dashboard' && (
              plan
                ? <Dashboard plan={plan} proposals={proposals} />
                : <PlanRequired onUpload={() => setShowUpload(true)} feature="Dashboard" />
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
                    proposals={proposals}
                    scenarios={scenarios}
                    simulations={simulations}
                    overrides={scenarioCellOverrides}
                    activeProposalId={activeProposalId}
                    activeScenarioId={activeScenarioId}
                    onSelectProposal={selectProposal}
                    onSelectScenario={selectScenario}
                    onAdd={addProposal}
                    onUpdate={updateProposal}
                    onDelete={deleteProposal}
                    onAddScenario={saveScenario}
                    onUpdateScenario={updateScenario}
                    onDeleteScenario={deleteScenario}
                    onAddSimulation={addSimulation}
                    onUpdateSimulation={updateSimulation}
                    onDeleteSimulation={deleteSimulation}
                  />
                : <PlanRequired onUpload={() => setShowUpload(true)} feature="Propuestas" />
            )}
            {activeTab === 'simulator' && (
              plan
                ? <Simulator
                    plan={plan}
                    proposals={proposals}
                    scenarios={scenarios}
                    simulations={simulations}
                    overrides={scenarioCellOverrides}
                    activeProposalId={activeProposalId}
                    activeScenarioId={activeScenarioId}
                    onSelectProposal={selectProposal}
                    onSelectScenario={selectScenario}
                    onUpdateScenario={updateScenario}
                  />
                : <PlanRequired onUpload={() => setShowUpload(true)} feature="Simulador" />
            )}
            {activeTab === 'cxp' && (
              <CXP
                records={cxpRecords}
                loadedCias={cxpLoadedCias}
                companies={companies}
                selectedCia={selectedCia}
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
              />
            )}
            {activeTab === 'forecast' && (
              plan
                ? <Forecast
                    plan={plan}
                    proposals={proposals}
                    scenarios={scenarios}
                    simulations={simulations}
                    activeProposalId={activeProposalId}
                    activeScenarioId={activeScenarioId}
                    overrides={scenarioCellOverrides}
                    granularity={forecastGranularity}
                    onGranularityChange={setForecastGranularity}
                    onSelectProposal={selectProposal}
                    onSelectScenario={selectScenario}
                    onOverridesChange={setScenarioCellOverrides}
                  />
                : <PlanRequired onUpload={() => setShowUpload(true)} feature="Pronóstico" />
            )}
          </ErrorBoundary>
        </div>
      </main>
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
}: {
  companies: Company[];
  selectedCia: string;
  loading: boolean;
  error: string | null;
  onSelect: (cia: string) => void;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const active = companies.find(c => c.cia === selectedCia);
  const label = selectedCia === 'all'
    ? 'Todas las compañías'
    : active ? `${active.cia} — ${active.nombre}` : selectedCia;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 h-9 px-3 rounded-xl text-[13px] font-medium transition-all duration-200 max-w-[260px]"
        style={{ background: 'var(--gray-50)', color: 'var(--gray-950)' }}
        title="Compañía JDE activa"
      >
        <Building2 className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--primary)' }} />
        <span className="truncate">{loading ? 'Cargando…' : label}</span>
        {loading
          ? <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" style={{ color: 'var(--gray-400)' }} />
          : <ChevronDown className={`w-3.5 h-3.5 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} style={{ color: 'var(--gray-400)' }} />
        }
      </button>

      {open && (
        <div
          className="absolute right-0 top-11 w-[320px] rounded-2xl border p-1.5 z-50 max-h-[420px] overflow-y-auto animate-slide-down"
          style={{ background: 'var(--surface)', borderColor: 'var(--gray-200)', boxShadow: 'var(--shadow-lg)' }}
        >
          {error ? (
            <div className="p-3">
              <div className="flex items-start gap-2 mb-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} />
                <p className="text-[12px] leading-snug" style={{ color: 'var(--gray-500)' }}>{error}</p>
              </div>
              <button
                onClick={() => { onRetry(); }}
                className="text-[12px] font-medium"
                style={{ color: 'var(--primary)' }}
              >Reintentar</button>
            </div>
          ) : (
            <>
              <button
                onClick={() => { onSelect('all'); setOpen(false); }}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-[13px] text-left transition"
                style={{
                  background: selectedCia === 'all' ? 'var(--primary-muted)' : undefined,
                  color: selectedCia === 'all' ? 'var(--primary)' : 'var(--gray-950)',
                }}
              >
                <span className="font-medium">Todas las compañías</span>
                {selectedCia === 'all' && <Check className="w-3.5 h-3.5" />}
              </button>
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
                      style={{
                        background: isActive ? 'var(--primary-muted)' : undefined,
                        color: isActive ? 'var(--primary)' : 'var(--gray-950)',
                      }}
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
          )}
        </div>
      )}
    </div>
  );
}

function PlanRequired({ onUpload, feature }: { onUpload: () => void; feature: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-28 text-center">
      <div
        className="w-16 h-16 rounded-2xl flex items-center justify-center mb-5 animate-card-in"
        style={{ background: 'linear-gradient(to bottom, var(--gray-50), var(--gray-100))', boxShadow: 'var(--shadow-xs)' }}
      >
        <FileSpreadsheet className="w-7 h-7" style={{ color: 'var(--gray-400)' }} />
      </div>
      <h2 className="text-[22px] font-semibold tracking-[-0.02em] animate-card-in stagger-1" style={{ color: 'var(--gray-950)' }}>
        {feature} requiere un Plan de Flujo
      </h2>
      <p className="text-[13.5px] mt-2 max-w-[380px] leading-relaxed animate-card-in stagger-2" style={{ color: 'var(--gray-400)' }}>
        Carga tu Excel de necesidad de flujo para usar esta pestaña. Mientras tanto puedes trabajar
        en Clientes, Cobranza y Proveedores.
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
