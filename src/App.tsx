import { useState } from 'react';
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
      <header className="bg-white/80 backdrop-blur-xl border-b border-[#d2d2d7]/60 sticky top-0 z-50">
        <div className="max-w-[1400px] mx-auto px-8 h-12 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#0071e3] to-[#40a9ff] flex items-center justify-center">
                <Zap className="w-4 h-4 text-white" />
              </div>
              <span className="text-[15px] font-semibold text-[#1d1d1f] tracking-tight">FlowSense</span>
            </div>
            <div className="h-4 w-px bg-[#d2d2d7]" />
            <span className="text-[13px] text-[#86868b] font-medium">
              {plan ? `${plan.name} — ${plan.year}` : 'Sin plan cargado'}
            </span>
          </div>

          <nav className="flex items-center bg-[#f5f5f7] rounded-full p-0.5">
            {tabs.map(t => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[13px] font-medium transition-all ${
                  activeTab === t.id
                    ? 'bg-white text-[#1d1d1f] shadow-sm'
                    : 'text-[#86868b] hover:text-[#1d1d1f]'
                }`}
              >
                <t.icon className="w-3.5 h-3.5" />
                {t.label}
              </button>
            ))}
          </nav>

          <button
            onClick={() => setShowUpload(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[13px] text-[#86868b] hover:text-[#1d1d1f] rounded-full hover:bg-[#f5f5f7] transition"
          >
            <ArrowUpFromLine className="w-3.5 h-3.5" />
            {plan ? 'Nuevo Plan' : 'Cargar Plan'}
          </button>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-8 py-6">
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
      </main>
    </div>
  );
}

function PlanRequired({ onUpload, feature }: { onUpload: () => void; feature: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="w-14 h-14 rounded-2xl bg-[#f5f5f7] flex items-center justify-center mb-4">
        <FileSpreadsheet className="w-6 h-6 text-[#86868b]" />
      </div>
      <h2 className="text-xl font-semibold text-[#1d1d1f] tracking-tight">
        {feature} requiere un Plan de Flujo
      </h2>
      <p className="text-[13px] text-[#86868b] mt-1 max-w-sm">
        Carga tu Excel de necesidad de flujo para usar esta pestaña. Mientras tanto puedes trabajar
        en Clientes, Cobranza y Proveedores.
      </p>
      <button
        onClick={onUpload}
        className="mt-5 flex items-center gap-1.5 px-4 h-9 rounded-lg bg-[#0071e3] text-white text-[13px] font-medium hover:bg-[#0077ed]"
      >
        <ArrowUpFromLine className="w-3.5 h-3.5" /> Cargar Plan
      </button>
    </div>
  );
}
