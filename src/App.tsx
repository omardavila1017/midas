import { useState } from 'react';
import { FlowPlan, Proposal, Scenario, TabId } from './types';
import Upload from './components/Upload';
import Dashboard from './components/Dashboard';
import ProposalCreator from './components/ProposalCreator';
import Simulator from './components/Simulator';
import CXP from './components/CXP';
import { LayoutDashboard, Lightbulb, FlaskConical, Clock, ArrowUpFromLine, Zap } from 'lucide-react';

export default function App() {
  const [plan, setPlan] = useState<FlowPlan | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>('dashboard');

  const addProposal = (p: Proposal) => setProposals(prev => [...prev, p]);
  const updateProposal = (p: Proposal) => setProposals(prev => prev.map(x => x.id === p.id ? p : x));
  const deleteProposal = (id: string) => setProposals(prev => prev.filter(x => x.id !== id));
  const saveScenario = (s: Scenario) => setScenarios(prev => [...prev, s]);

  if (!plan) {
    return <Upload onPlanLoaded={setPlan} />;
  }

  const tabs: { id: TabId; label: string; icon: any }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'proposals', label: 'Propuestas', icon: Lightbulb },
    { id: 'simulator', label: 'Simulador', icon: FlaskConical },
    { id: 'cxp', label: 'CXP', icon: Clock },
  ];

  return (
    <div className="min-h-screen bg-[#f5f5f7]">
      {/* Header */}
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
            <span className="text-[13px] text-[#86868b] font-medium">{plan.name} — {plan.year}</span>
          </div>

          {/* Tab Nav — Apple style pill nav */}
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
            onClick={() => { setPlan(null); setProposals([]); setScenarios([]); }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[13px] text-[#86868b] hover:text-[#1d1d1f] rounded-full hover:bg-[#f5f5f7] transition"
          >
            <ArrowUpFromLine className="w-3.5 h-3.5" />
            Nuevo Plan
          </button>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-[1400px] mx-auto px-8 py-6">
        {activeTab === 'dashboard' && <Dashboard plan={plan} proposals={proposals} />}
        {activeTab === 'proposals' && (
          <ProposalCreator
            plan={plan}
            proposals={proposals}
            onAdd={addProposal}
            onUpdate={updateProposal}
            onDelete={deleteProposal}
          />
        )}
        {activeTab === 'simulator' && (
          <Simulator
            plan={plan}
            proposals={proposals}
            scenarios={scenarios}
            onSaveScenario={saveScenario}
          />
        )}
        {activeTab === 'cxp' && <CXP />}
      </main>
    </div>
  );
}
