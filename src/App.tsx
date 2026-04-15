import { useState, useEffect, useRef } from 'react';
import { FlowPlan, Proposal, Scenario, TabId } from './types';
import { Provider, Client, CashFlowAssumptions } from './domain/types';
import Upload from './components/Upload';
import Dashboard from './components/Dashboard';
import ProposalCreator from './components/ProposalCreator';
import Simulator from './components/Simulator';
import CXP from './components/CXP';
import Providers from './components/Providers';
import CollectionProjection from './components/CollectionProjection';
import Clients from './components/Clients';
import {
  LayoutDashboard, Lightbulb, FlaskConical, ArrowUpFromLine, Zap,
  Users, Calendar, UserSquare, Clock, FileSpreadsheet,
} from 'lucide-react';

export default function App() {
  const [plan, setPlan] = useState<FlowPlan | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [assumptions, setAssumptions] = useState<CashFlowAssumptions>({
    year: new Date().getFullYear(),
    globalCompliance: 1,
    factorajeDays: 3,
  });
  const [activeTab, setActiveTab] = useState<TabId>('clients');
  const [showUpload, setShowUpload] = useState(false);

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

  const tabs: { id: TabId; label: string; icon: any; needsPlan?: boolean }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, needsPlan: true },
    { id: 'clients', label: 'Clientes', icon: UserSquare },
    { id: 'collections', label: 'Cobranza', icon: Calendar },
    { id: 'providers', label: 'Proveedores', icon: Users },
    { id: 'proposals', label: 'Propuestas', icon: Lightbulb, needsPlan: true },
    { id: 'simulator', label: 'Simulador', icon: FlaskConical, needsPlan: true },
    { id: 'cxp', label: 'CXP', icon: Clock },
  ];

  return (
    <div className="min-h-screen bg-[#f5f5f7]">
      {/* ─── HEADER — glass nav bar ─── */}
      <header className="glass border-b border-[#d2d2d7]/40 sticky top-0 z-50">
        <div className="max-w-[1400px] mx-auto px-8 h-[52px] flex items-center justify-between">
          {/* Logo + plan name */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="flex items-center gap-2 hover-press cursor-pointer" onClick={() => setActiveTab('dashboard')}>
              <div className="w-7 h-7 rounded-[8px] bg-gradient-to-br from-[#0071e3] to-[#40a9ff] flex items-center justify-center shadow-sm shadow-[#0071e3]/20">
                <Zap className="w-3.5 h-3.5 text-white" strokeWidth={2.5} />
              </div>
              <span className="text-[14px] font-semibold text-[#1d1d1f] tracking-[-0.01em]">FlowSense</span>
            </div>
            {plan && (
              <>
                <div className="h-4 w-px bg-[#d2d2d7]/60" />
                <span className="text-[11px] text-[#86868b] font-medium animate-fade-in truncate max-w-[100px]">
                  {plan.name}
                </span>
              </>
            )}
          </div>

          {/* Navigation pills */}
          <nav className="flex items-center bg-[#f5f5f7]/80 rounded-full p-[3px] gap-[1px]">
            {tabs.map(t => {
              const isActive = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setActiveTab(t.id)}
                  className={`relative flex items-center gap-1 px-2.5 py-[5px] rounded-full text-[12px] font-medium transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] whitespace-nowrap ${
                    isActive
                      ? 'text-[#1d1d1f]'
                      : 'text-[#86868b] hover:text-[#515154]'
                  }`}
                >
                  {isActive && (
                    <span className="absolute inset-0 bg-white rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.08),0_0_1px_rgba(0,0,0,0.04)] animate-scale-in" />
                  )}
                  <span className="relative flex items-center gap-1">
                    <t.icon className={`w-3 h-3 transition-colors duration-300 ${isActive ? 'text-[#0071e3]' : ''}`} />
                    {t.label}
                  </span>
                </button>
              );
            })}
          </nav>

          {/* Upload button */}
          <button
            onClick={() => setShowUpload(true)}
            title={plan ? 'Nuevo Plan' : 'Cargar Plan'}
            className="flex items-center justify-center w-8 h-8 text-[#86868b] hover:text-[#1d1d1f] rounded-full hover:bg-[#f5f5f7] transition-all duration-200 hover-press flex-shrink-0"
          >
            <ArrowUpFromLine className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* ─── MAIN CONTENT — animated page transitions ─── */}
      <main className="max-w-[1400px] mx-auto px-8 py-6">
        <div key={pageKey} className="animate-page-in">
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
            />
          )}
          {activeTab === 'providers' && (
            <Providers
              providers={providers}
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
          {activeTab === 'cxp' && <CXP />}
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
