import { useState, useEffect, useRef } from 'react';
import { FlowPlan, Proposal, Scenario, TabId } from './types';
import { Provider, Client, CashFlowAssumptions, ConfirmedPayment } from './domain/types';
import { loadStore, saveStore, exportStore, CXPRecord } from './domain/persistence';
import { loadClientsCatalog } from './domain/loadClientsCatalog';
import Upload from './components/Upload';
import Dashboard from './components/Dashboard';
import ProposalCreator from './components/ProposalCreator';
import Simulator from './components/Simulator';
import CXP from './components/CXP';
import Providers from './components/Providers';
import CollectionProjection from './components/CollectionProjection';
import Clients from './components/Clients';
import CashFlowDetail from './components/CashFlowDetail';
// NetCashFlowDashboard disabled — needs real JDE data to be useful
// import NetCashFlowDashboard from './components/NetCashFlowDashboard';
import ErrorBoundary from './components/ErrorBoundary';
import {
  LayoutDashboard, Lightbulb, FlaskConical, ArrowUpFromLine, Zap,
  Users, UserSquare, FileSpreadsheet, Download,
} from 'lucide-react';

type SectionId = 'cobros' | 'pagos' | 'plan';

const SECTIONS: { id: SectionId; label: string; icon: any }[] = [
  { id: 'cobros', label: 'Cobros', icon: UserSquare },
  { id: 'pagos',  label: 'Pagos',  icon: Users },
  { id: 'plan',   label: 'Plan',   icon: LayoutDashboard },
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
  ],
  plan: [
    { id: 'dashboard',  label: 'Dashboard',   icon: LayoutDashboard, needsPlan: true },
    { id: 'proposals',  label: 'Propuestas',  icon: Lightbulb, needsPlan: true },
    { id: 'simulator',  label: 'Simulador',   icon: FlaskConical, needsPlan: true },
  ],
};

const SECTION_FOR_TAB: Partial<Record<TabId, SectionId>> = {
  clients: 'cobros', collections: 'cobros', netflow: 'cobros',
  providers: 'pagos', cxp: 'pagos',
  dashboard: 'plan', proposals: 'plan', simulator: 'plan',
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
  const [providers, setProviders] = useState<Provider[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [assumptions, setAssumptions] = useState<CashFlowAssumptions>({
    year: new Date().getFullYear(),
    globalCompliance: 1,
    factorajeDays: 30,
  });
  const [confirmedPayments, setConfirmedPayments] = useState<ConfirmedPayment[]>([]);
  const [cxpRecords, setCxpRecords] = useState<CXPRecord[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>('clients');
  const [showUpload, setShowUpload] = useState(false);
  const [catalogLoaded, setCatalogLoaded] = useState(false);

  const confirmPayment = (p: ConfirmedPayment) => setConfirmedPayments(prev => [...prev, p]);
  const unconfirmPayment = (key: string) => setConfirmedPayments(prev => prev.filter(x => x.key !== key));

  // Load from persistence on mount
  useEffect(() => {
    const stored = loadStore();
    if (stored) {
      if (stored.plan) setPlan(stored.plan);
      if (stored.proposals.length) setProposals(stored.proposals);
      if (stored.scenarios.length) setScenarios(stored.scenarios);
      if (stored.providers.length) setProviders(stored.providers);
      if (stored.clients.length) setClients(stored.clients);
      if (stored.confirmedPayments.length) setConfirmedPayments(stored.confirmedPayments);
      if (stored.cxpRecords.length) setCxpRecords(stored.cxpRecords);
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

  // Auto-save to localStorage (debounced by 500ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      saveStore({
        plan, proposals, scenarios, providers, clients,
        assumptions, confirmedPayments, cxpRecords,
        lastSaved: new Date().toISOString(),
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [plan, proposals, scenarios, providers, clients, assumptions, confirmedPayments, cxpRecords]);

  /* ── Animated page key for re-mount on tab change ── */
  const [pageKey, setPageKey] = useState(0);
  const prevTab = useRef(activeTab);
  useEffect(() => {
    if (prevTab.current !== activeTab) { setPageKey(k => k + 1); prevTab.current = activeTab; }
  }, [activeTab]);

  const addProposal = (p: Proposal) => setProposals(prev => [...prev, p]);
  const updateProposal = (p: Proposal) => setProposals(prev => prev.map(x => x.id === p.id ? p : x));
  const deleteProposal = (id: string) => setProposals(prev => prev.filter(x => x.id !== id));
  const saveScenario = (s: Scenario) => setScenarios(prev => [...prev, s]);

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
    <div className="min-h-screen bg-[#f5f5f7]">
      {/* ─── HEADER — glass nav bar ─── */}
      <header className="glass border-b border-[#d2d2d7]/40 sticky top-0 z-50">
        <div className="max-w-[1400px] mx-auto px-8 h-[56px] flex items-center justify-between">
          {/* Logo */}
          <div className="flex items-center gap-2.5 flex-shrink-0 hover-press cursor-pointer" onClick={() => setActiveTab('clients')}>
            <div className="w-8 h-8 rounded-[9px] bg-gradient-to-br from-[#0071e3] to-[#40a9ff] flex items-center justify-center shadow-sm shadow-[#0071e3]/20">
              <Zap className="w-4 h-4 text-white" strokeWidth={2.5} />
            </div>
            <span className="text-[15px] font-semibold text-[#1d1d1f] tracking-[-0.01em]">FlowSense</span>
          </div>

          {/* 4-section nav */}
          <nav className="flex items-center bg-[#f5f5f7]/80 rounded-full p-[3px] gap-[2px]">
            {SECTIONS.map(s => {
              const isActive = activeSection === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => switchSection(s.id)}
                  className={`relative flex items-center gap-1.5 px-4 py-[7px] rounded-full text-[14px] font-medium transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] whitespace-nowrap ${
                    isActive
                      ? 'text-[#1d1d1f]'
                      : 'text-[#86868b] hover:text-[#515154]'
                  }`}
                >
                  {isActive && (
                    <span className="absolute inset-0 bg-white rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.08),0_0_1px_rgba(0,0,0,0.04)] animate-scale-in" />
                  )}
                  <span className="relative flex items-center gap-1.5">
                    <s.icon className={`w-4 h-4 transition-colors duration-300 ${isActive ? 'text-[#0071e3]' : ''}`} />
                    {s.label}
                  </span>
                </button>
              );
            })}
          </nav>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                const json = exportStore({
                  plan, proposals, scenarios, providers, clients,
                  assumptions, confirmedPayments, cxpRecords,
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
              className="flex items-center justify-center w-9 h-9 text-[#86868b] hover:text-[#1d1d1f] rounded-xl hover:bg-[#e8e8ed] transition-all duration-200 hover-press flex-shrink-0"
            >
              <Download className="w-[18px] h-[18px]" />
            </button>
            <button
              onClick={() => setShowUpload(true)}
              title={plan ? 'Nuevo Plan' : 'Cargar Plan'}
              className="flex items-center justify-center w-9 h-9 text-[#86868b] hover:text-[#1d1d1f] rounded-xl hover:bg-[#e8e8ed] transition-all duration-200 hover-press flex-shrink-0"
            >
              <ArrowUpFromLine className="w-[18px] h-[18px]" />
            </button>
          </div>
        </div>
      </header>

      {/* ─── SUB-TABS (only when section has multiple views) ─── */}
      {subTabs.length > 0 && (
        <div className="bg-white/60 border-b border-[#e8e8ed]">
          <div className="max-w-[1400px] mx-auto px-8">
            <div className="flex items-center gap-1 py-1.5">
              {subTabs.map(t => {
                const isActive = activeTab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setActiveTab(t.id)}
                    className={`px-4 py-2 rounded-lg text-[13px] font-medium transition-all duration-200 ${
                      isActive
                        ? 'bg-[#0071e3]/10 text-[#0071e3]'
                        : 'text-[#6e6e73] hover:text-[#1d1d1f] hover:bg-[#f5f5f7]'
                    }`}
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
            {activeTab === 'proposals' && (
              plan
                ? <ProposalCreator
                    plan={plan}
                    proposals={proposals}
                    onAdd={addProposal}
                    onUpdate={updateProposal}
                    onDelete={deleteProposal}
                  />
                : <PlanRequired onUpload={() => setShowUpload(true)} feature="Propuestas" />
            )}
            {activeTab === 'simulator' && (
              plan
                ? <Simulator
                    plan={plan}
                    proposals={proposals}
                    scenarios={scenarios}
                    onSaveScenario={saveScenario}
                  />
                : <PlanRequired onUpload={() => setShowUpload(true)} feature="Simulador" />
            )}
            {activeTab === 'cxp' && (
              <CXP records={cxpRecords} onRecordsChange={setCxpRecords} />
            )}
            {activeTab === 'netflow' && (
              <CashFlowDetail
                clients={clients}
                cxpRecords={cxpRecords}
                assumptions={assumptions}
                confirmedPayments={confirmedPayments}
              />
            )}
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}

function PlanRequired({ onUpload, feature }: { onUpload: () => void; feature: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-28 text-center">
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-b from-[#f5f5f7] to-[#ebebed] flex items-center justify-center mb-5 animate-card-in shadow-sm">
        <FileSpreadsheet className="w-7 h-7 text-[#86868b]" />
      </div>
      <h2 className="text-[22px] font-semibold text-[#1d1d1f] tracking-[-0.02em] animate-card-in stagger-1">
        {feature} requiere un Plan de Flujo
      </h2>
      <p className="text-[13.5px] text-[#86868b] mt-2 max-w-[380px] leading-relaxed animate-card-in stagger-2">
        Carga tu Excel de necesidad de flujo para usar esta pestaña. Mientras tanto puedes trabajar
        en Clientes, Cobranza y Proveedores.
      </p>
      <button
        onClick={onUpload}
        className="mt-6 flex items-center gap-2 px-5 h-10 rounded-xl bg-[#0071e3] text-white text-[13.5px] font-medium hover:bg-[#0077ed] hover-press shadow-sm shadow-[#0071e3]/20 animate-card-in stagger-3"
      >
        <ArrowUpFromLine className="w-4 h-4" /> Cargar Plan
      </button>
    </div>
  );
}
