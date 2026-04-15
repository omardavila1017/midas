import { useState, useMemo, useCallback } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  BarChart,
  Bar,
  Cell,
} from 'recharts';
import {
  FlaskConical,
  Save,
  Copy,
  Check,
  X,
  TrendingUp,
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Layers,
} from 'lucide-react';
import { FlowPlan, Proposal, Scenario } from '../types';
import { simulateCashFlow, formatCurrency } from '../utils/calculations';

interface SimulatorProps {
  plan: FlowPlan;
  proposals: Proposal[];
  scenarios: Scenario[];
  onSaveScenario: (s: Scenario) => void;
}

const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

const CATEGORY_COLORS: Record<string, string> = {
  'Reducción de Costos': '#0071e3',
  'Incremento de Ingresos': '#34c759',
  'Diferimiento': '#ff9f0a',
  'Renegociación': '#af52de',
};

/* ────────────────────────────────────────────
   Summary rows for the Flujo Resumido table.
   Each maps to an excelRow in the FlowPlan.
   ──────────────────────────────────────────── */
const SUMMARY_ROWS: { row: number; label: string; style: 'income' | 'expense' | 'subtotal' | 'total' }[] = [
  { row: 7,   label: 'Ingresos',              style: 'income' },
  { row: 14,  label: 'Nómina',                style: 'expense' },
  { row: 32,  label: 'Diésel',                style: 'expense' },
  { row: 33,  label: 'Gas',                   style: 'expense' },
  { row: 35,  label: 'Distribuidores',        style: 'expense' },
  { row: 37,  label: 'Impuestos',             style: 'expense' },
  { row: 75,  label: 'Gastos Operativos',     style: 'expense' },
  { row: 76,  label: 'Asesores',              style: 'expense' },
  { row: 83,  label: 'Proyectos',             style: 'expense' },
  { row: 88,  label: 'Pasivos Financieros',   style: 'expense' },
  { row: 114, label: 'Variación en Caja',     style: 'subtotal' },
  { row: 115, label: 'Caja Final',            style: 'total' },
];

const Simulator = ({ plan, proposals, scenarios, onSaveScenario }: SimulatorProps) => {
  const [selectedProposalIds, setSelectedProposalIds] = useState<Set<string>>(new Set());
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [scenarioName, setScenarioName] = useState('');
  const [scenarioDescription, setScenarioDescription] = useState('');
  const [copiedSummary, setCopiedSummary] = useState(false);
  const [showFlowTable, setShowFlowTable] = useState(true);

  const availableProposals = useMemo(
    () => proposals.filter((p) => p.status !== 'Descartada'),
    [proposals]
  );

  const filteredProposals = useMemo(() => {
    if (!categoryFilter) return availableProposals;
    return availableProposals.filter((p) => p.category === categoryFilter);
  }, [availableProposals, categoryFilter]);

  const activeProposals = useMemo(
    () => availableProposals.filter((p) => selectedProposalIds.has(p.id)),
    [availableProposals, selectedProposalIds]
  );

  const toggleProposal = useCallback((id: string) => {
    setSelectedProposalIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (selectedProposalIds.size === filteredProposals.length) {
      setSelectedProposalIds(new Set());
    } else {
      setSelectedProposalIds(new Set(filteredProposals.map((p) => p.id)));
    }
  }, [filteredProposals, selectedProposalIds.size]);

  const loadScenario = useCallback((scenario: Scenario) => {
    setSelectedProposalIds(new Set(scenario.selectedProposalIds));
  }, []);

  /* ── Base data from FlowPlan ── */
  const baseCashFlowData = useMemo(() => {
    const cajaFinalConcept = plan.concepts.find((c) => c.excelRow === 115);
    const variacionConcept = plan.concepts.find((c) => c.excelRow === 114);
    const baseCaja = cajaFinalConcept?.monthlyData || Array(12).fill(0);
    const baseVariacion = variacionConcept?.monthlyData || Array(12).fill(0);
    const cajaInicial = plan.cajaInicial || 0;
    return { baseCaja, baseVariacion, cajaInicial };
  }, [plan]);

  /* ── Simulation result ── */
  const simulationResult = useMemo(() => {
    if (activeProposals.length === 0) return null;
    return simulateCashFlow(
      baseCashFlowData.baseCaja,
      baseCashFlowData.baseVariacion,
      baseCashFlowData.cajaInicial,
      activeProposals
    );
  }, [baseCashFlowData, activeProposals]);

  /* ── KPIs ── */
  const kpis = useMemo(() => {
    if (!simulationResult) return null;
    const { simulatedCaja } = simulationResult;
    const annualImpact = activeProposals.reduce((sum, p) => sum + p.annualImpact, 0);
    const minCaja = simulatedCaja.length > 0 ? Math.min(...simulatedCaja) : 0;
    const baseMinCaja = baseCashFlowData.baseCaja.length > 0 ? Math.min(...baseCashFlowData.baseCaja) : 0;
    const hasDeficit = simulatedCaja.some((c) => c < 0);
    const deficitMonths = simulatedCaja.map((c, i) => (c < 0 ? MONTHS[i] : null)).filter(Boolean);
    return { activeCount: activeProposals.length, annualImpact, minCaja, baseMinCaja, hasDeficit, deficitMonths };
  }, [simulationResult, activeProposals, baseCashFlowData.baseCaja]);

  /* ── Chart data ── */
  const chartData = useMemo(() => {
    const simulatedCaja = simulationResult?.simulatedCaja;
    return MONTHS.map((month, i) => ({
      month,
      cajaBase: baseCashFlowData.baseCaja[i] || 0,
      cajaSimulada: simulatedCaja ? simulatedCaja[i] || 0 : baseCashFlowData.baseCaja[i] || 0,
    }));
  }, [simulationResult, baseCashFlowData.baseCaja]);

  /* ── Impact bar chart data ── */
  const impactBarData = useMemo(() => {
    if (!simulationResult) return [];
    return MONTHS.map((month, i) => ({
      month,
      impacto: simulationResult.cumulativeImpact[i] || 0,
    }));
  }, [simulationResult]);

  /* ── Impact detail table ── */
  const tableData = useMemo(() => {
    if (!simulationResult) return [];
    const { simulatedCaja, totalImpact, cumulativeImpact } = simulationResult;
    return MONTHS.map((month, i) => ({
      month,
      cajaBase: baseCashFlowData.baseCaja[i] || 0,
      impacto: totalImpact[i] || 0,
      impactoAcumulado: cumulativeImpact[i] || 0,
      cajaSimulada: simulatedCaja[i] || 0,
      delta: (simulatedCaja[i] || 0) - (baseCashFlowData.baseCaja[i] || 0),
    }));
  }, [simulationResult, baseCashFlowData.baseCaja]);

  /* ── Summary flow rows from plan concepts ── */
  const summaryFlowData = useMemo(() => {
    return SUMMARY_ROWS.map(({ row, label, style }) => {
      const concept = plan.concepts.find((c) => c.excelRow === row);
      return {
        row,
        label,
        style,
        data: concept?.monthlyData || Array(12).fill(0),
      };
    }).filter((r) => {
      // Keep rows that have at least some non-zero data, or are subtotal/total
      if (r.style === 'subtotal' || r.style === 'total') return true;
      return r.data.some((v) => v !== 0);
    });
  }, [plan]);

  /* ── Text summary ── */
  const generateSummary = useCallback(() => {
    const date = new Date().toLocaleDateString('es-ES');
    const proposalDetails = activeProposals
      .map((p, i) => `${i + 1}. ${p.name} — Impacto: ${formatCurrency(p.annualImpact)}/año (prob: ${(p.probability * 100).toFixed(0)}%)`)
      .join('\n');
    const flowDetails = tableData.map((row) => `${row.month}: ${formatCurrency(row.cajaSimulada)}`).join(' | ');
    return `FlowSense — Simulación: ${date}\nPlan: ${plan.name}\nPropuestas seleccionadas: ${activeProposals.length}\nImpacto anual total: ${formatCurrency(kpis?.annualImpact || 0)}\n\nPropuestas:\n${proposalDetails}\n\nFlujo Simulado:\n${flowDetails}`;
  }, [activeProposals, tableData, kpis, plan.name]);

  const copySummary = useCallback(() => {
    const summary = generateSummary();
    navigator.clipboard.writeText(summary);
    setCopiedSummary(true);
    setTimeout(() => setCopiedSummary(false), 2000);
  }, [generateSummary]);

  const handleSaveScenario = useCallback(() => {
    if (!scenarioName.trim()) return;
    const newScenario: Scenario = {
      id: `scenario-${Date.now()}`,
      name: scenarioName,
      description: scenarioDescription,
      selectedProposalIds: Array.from(selectedProposalIds),
      createdAt: new Date().toISOString(),
    };
    onSaveScenario(newScenario);
    setScenarioName('');
    setScenarioDescription('');
    setShowSaveModal(false);
  }, [scenarioName, scenarioDescription, selectedProposalIds, onSaveScenario]);

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white border border-[#d2d2d7]/60 rounded-xl p-3.5 shadow-lg shadow-black/5">
          <p className="text-[13px] font-semibold text-[#1d1d1f] mb-1.5">{label}</p>
          {payload.map((entry: any, idx: number) => (
            <p key={idx} style={{ color: entry.color || entry.stroke }} className="font-mono text-[12px] leading-5">
              {entry.name}: {formatCurrency(entry.value)}
            </p>
          ))}
        </div>
      );
    }
    return null;
  };

  const hasSimulation = activeProposals.length > 0;

  return (
    <div className="flex gap-6 min-h-[calc(100vh-140px)]">
      {/* ═══════════════ LEFT COLUMN: Proposals ═══════════════ */}
      <div className="w-[320px] flex-shrink-0 flex flex-col bg-white rounded-2xl border border-[#d2d2d7]/40 shadow-sm overflow-hidden animate-slide-down hover-lift">
        <div className="p-5 border-b border-[#e8e8ed]">
          <h2 className="text-[15px] font-semibold text-[#1d1d1f] mb-4 flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-[#f0e6ff] flex items-center justify-center">
              <FlaskConical size={14} className="text-[#af52de]" />
            </div>
            Propuestas ({availableProposals.length})
          </h2>

          {availableProposals.length > 0 && (
            <button
              onClick={toggleSelectAll}
              className="w-full mb-3 px-3 py-2 bg-[#e8f4fd] hover:bg-[#d6ecfc] text-[#0071e3] rounded-xl transition text-[13px] font-medium hover-press"
            >
              {selectedProposalIds.size === filteredProposals.length ? 'Deseleccionar Todo' : 'Seleccionar Todo'}
            </button>
          )}

          {/* Category Filter */}
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setCategoryFilter(null)}
              className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition hover-press ${
                categoryFilter === null
                  ? 'bg-[#1d1d1f] text-white'
                  : 'bg-[#f5f5f7] text-[#6e6e73] hover:bg-[#e8e8ed]'
              }`}
            >
              Todos
            </button>
            {Object.keys(CATEGORY_COLORS).map((cat) => (
              <button
                key={cat}
                onClick={() => setCategoryFilter(cat)}
                className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition hover-press ${
                  categoryFilter === cat
                    ? 'bg-[#1d1d1f] text-white'
                    : 'bg-[#f5f5f7] text-[#6e6e73] hover:bg-[#e8e8ed]'
                }`}
              >
                {cat.split(' ')[0]}
              </button>
            ))}
          </div>
        </div>

        {/* Proposals List */}
        {availableProposals.length === 0 ? (
          <div className="flex-1 flex items-center justify-center p-6 text-center">
            <div>
              <div className="w-12 h-12 rounded-2xl bg-[#f5f5f7] flex items-center justify-center mx-auto mb-3">
                <AlertTriangle className="text-[#c7c7cc]" size={20} />
              </div>
              <p className="text-[13px] text-[#6e6e73]">No hay propuestas creadas.</p>
              <p className="text-[11px] text-[#86868b] mt-1">Ve a Propuestas para crear la primera.</p>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {filteredProposals.map((proposal, idx) => {
              const isSelected = selectedProposalIds.has(proposal.id);
              return (
                <button
                  key={proposal.id}
                  onClick={() => toggleProposal(proposal.id)}
                  className={`w-full text-left p-3 rounded-xl transition-all animate-card-in hover-press ${
                    ['stagger-1','stagger-2','stagger-3','stagger-4','stagger-5','stagger-6','stagger-7','stagger-8'][idx % 8]
                  } ${
                    isSelected
                      ? 'bg-[#e8f4fd] border border-[#0071e3]/20'
                      : 'bg-[#f5f5f7] border border-transparent hover:bg-[#e8e8ed]'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={`w-9 h-5 rounded-full transition-colors flex-shrink-0 mt-0.5 relative ${
                        isSelected ? 'bg-[#0071e3]' : 'bg-[#c7c7cc]'
                      }`}
                    >
                      <div
                        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-all ${
                          isSelected ? 'left-[18px]' : 'left-0.5'
                        }`}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <div
                          className="w-2 h-2 rounded-full flex-shrink-0"
                          style={{ backgroundColor: CATEGORY_COLORS[proposal.category] }}
                        />
                        <p className="font-medium text-[#1d1d1f] text-[13px] truncate">{proposal.name}</p>
                      </div>
                      <div className="flex gap-3 text-[11px] text-[#86868b]">
                        <span>Prob: {(proposal.probability * 100).toFixed(0)}%</span>
                        <span>{formatCurrency(proposal.annualImpact)}/año</span>
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* Saved Scenarios */}
        {scenarios.length > 0 && (
          <div className="border-t border-[#e8e8ed] p-4 animate-fade-in">
            <p className="text-[11px] text-[#86868b] font-semibold uppercase tracking-wider mb-2">Escenarios Guardados</p>
            <div className="space-y-1.5 max-h-28 overflow-y-auto">
              {scenarios.map((scenario) => (
                <button
                  key={scenario.id}
                  onClick={() => loadScenario(scenario)}
                  className="w-full px-3 py-2 text-left bg-[#f5f5f7] hover:bg-[#e8e8ed] rounded-lg transition text-[12px] text-[#6e6e73] hover:text-[#1d1d1f] truncate hover-press"
                  title={scenario.description}
                >
                  {scenario.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ═══════════════ RIGHT COLUMN — stable layout, no mount/unmount ═══════════════ */}
      <div className="flex-1 overflow-y-auto">
          <div className="space-y-5">
            {/* ── KPIs — always rendered, values animate smoothly ── */}
            <div className="grid grid-cols-4 gap-4">
              <div className="bg-white border border-[#d2d2d7]/40 rounded-2xl p-5 shadow-sm hover-lift">
                <p className="text-[11px] text-[#86868b] font-semibold uppercase tracking-wider mb-2">Propuestas</p>
                <p className="text-[26px] font-bold text-[#0071e3] tracking-tight transition-all duration-300">{kpis?.activeCount ?? 0}</p>
                <p className="text-[11px] text-[#86868b] mt-1">activas</p>
              </div>

              <div className="bg-white border border-[#d2d2d7]/40 rounded-2xl p-5 shadow-sm hover-lift">
                <p className="text-[11px] text-[#86868b] font-semibold uppercase tracking-wider mb-2">Impacto Anual</p>
                <p className="text-[22px] font-bold text-[#34c759] font-mono transition-all duration-300">{formatCurrency(kpis?.annualImpact || 0)}</p>
                <p className="text-[11px] text-[#86868b] mt-1">beneficio estimado</p>
              </div>

              <div className="bg-white border border-[#d2d2d7]/40 rounded-2xl p-5 shadow-sm hover-lift">
                <p className="text-[11px] text-[#86868b] font-semibold uppercase tracking-wider mb-2">Caja Mínima</p>
                <p className={`text-[22px] font-bold font-mono transition-all duration-300 ${
                  hasSimulation
                    ? ((kpis?.minCaja || 0) > 0 ? 'text-[#34c759]' : 'text-[#ff3b30]')
                    : 'text-[#1d1d1f]'
                }`}>
                  {formatCurrency(hasSimulation ? (kpis?.minCaja || 0) : (baseCashFlowData.baseCaja.length > 0 ? Math.min(...baseCashFlowData.baseCaja) : 0))}
                </p>
                <p className="text-[11px] text-[#86868b] mt-1 transition-opacity duration-300" style={{ opacity: hasSimulation ? 1 : 0.5 }}>
                  {hasSimulation ? `base: ${formatCurrency(kpis?.baseMinCaja || 0)}` : 'línea base'}
                </p>
              </div>

              <div className="bg-white border border-[#d2d2d7]/40 rounded-2xl p-5 shadow-sm hover-lift">
                <p className="text-[11px] text-[#86868b] font-semibold uppercase tracking-wider mb-2">Liquidez</p>
                {hasSimulation && kpis?.hasDeficit ? (
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-[#ffe5e5] flex items-center justify-center transition-colors duration-300">
                        <X className="text-[#ff3b30]" size={12} />
                      </div>
                      <span className="text-[13px] text-[#ff3b30] font-semibold">Déficit</span>
                    </div>
                    <p className="text-[11px] text-[#86868b] mt-1">{(kpis.deficitMonths as string[]).join(', ')}</p>
                  </div>
                ) : hasSimulation ? (
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-[#e8faf0] flex items-center justify-center transition-colors duration-300">
                      <CheckCircle className="text-[#34c759]" size={12} />
                    </div>
                    <span className="text-[13px] text-[#34c759] font-semibold">Asegurada</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-[#f5f5f7] flex items-center justify-center transition-colors duration-300">
                      <TrendingUp className="text-[#86868b]" size={12} />
                    </div>
                    <span className="text-[13px] text-[#86868b] font-medium">Selecciona propuestas</span>
                  </div>
                )}
              </div>
            </div>

            {/* ── Area Chart — ALWAYS visible, stable ── */}
            <div className="bg-white border border-[#d2d2d7]/40 rounded-2xl p-6 shadow-sm hover-lift">
              <h3 className="text-[15px] font-semibold text-[#1d1d1f] mb-5 transition-all duration-300">
                {hasSimulation ? 'Proyección de Caja — Base vs Simulada' : `Proyección de Caja — ${plan.name}`}
              </h3>
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="colorCajaBase" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#86868b" stopOpacity={0.12} />
                      <stop offset="95%" stopColor="#86868b" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="colorCajaSimulada" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#0071e3" stopOpacity={0.18} />
                      <stop offset="95%" stopColor="#0071e3" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#e8e8ed" strokeDasharray="0" vertical={false} />
                  <XAxis dataKey="month" tick={{ fill: '#86868b', fontSize: 11 }} axisLine={{ stroke: '#e8e8ed' }} tickLine={false} />
                  <YAxis tick={{ fill: '#86868b', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v.toFixed(0)}M`} />
                  <Tooltip content={<CustomTooltip />} />
                  <ReferenceLine y={0} stroke="#ff3b30" strokeDasharray="5 5" strokeOpacity={0.4} />
                  <Area type="monotone" dataKey="cajaBase" stroke={hasSimulation ? '#c7c7cc' : '#0071e3'} strokeWidth={2} fillOpacity={1} fill={hasSimulation ? 'url(#colorCajaBase)' : 'url(#colorCajaSimulada)'} name="Caja Base" dot={hasSimulation ? false : { fill: '#0071e3', r: 3, strokeWidth: 2, stroke: '#fff' }} animationDuration={600} />
                  <Area type="monotone" dataKey="cajaSimulada" stroke="#0071e3" strokeWidth={2.5} fillOpacity={hasSimulation ? 1 : 0} fill="url(#colorCajaSimulada)" name="Caja Simulada" dot={hasSimulation ? { fill: '#0071e3', r: 3, strokeWidth: 2, stroke: '#fff' } : false} animationDuration={600} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* ── Cumulative Impact Bar Chart — smooth show/hide ── */}
            <div
              className="bg-white border border-[#d2d2d7]/40 rounded-2xl shadow-sm hover-lift overflow-hidden"
              style={{
                maxHeight: hasSimulation ? 340 : 0,
                padding: hasSimulation ? 24 : 0,
                opacity: hasSimulation ? 1 : 0,
                marginTop: hasSimulation ? undefined : 0,
                marginBottom: hasSimulation ? undefined : 0,
                borderWidth: hasSimulation ? 1 : 0,
                transition: 'max-height 0.4s cubic-bezier(0.22,1,0.36,1), padding 0.3s ease, opacity 0.3s ease, margin 0.3s ease, border-width 0.3s ease',
              }}
            >
              <h3 className="text-[15px] font-semibold text-[#1d1d1f] mb-1">Impacto Acumulado por Mes</h3>
              <p className="text-[12px] text-[#86868b] mb-4">Efecto acumulado de propuestas sobre la caja</p>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={hasSimulation ? impactBarData : []}>
                  <CartesianGrid stroke="#e8e8ed" strokeDasharray="0" vertical={false} />
                  <XAxis dataKey="month" tick={{ fill: '#86868b', fontSize: 11 }} axisLine={{ stroke: '#e8e8ed' }} tickLine={false} />
                  <YAxis tick={{ fill: '#86868b', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v.toFixed(1)}M`} />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar dataKey="impacto" name="Impacto Acumulado" radius={[6, 6, 0, 0]} animationDuration={500}>
                    {(hasSimulation ? impactBarData : []).map((entry, index) => (
                      <Cell key={index} fill={entry.impacto >= 0 ? '#34c759' : '#ff3b30'} fillOpacity={0.85} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* ═══════════════ FLUJO RESUMIDO TABLE ═══════════════ */}
            <div className="bg-white border border-[#d2d2d7]/40 rounded-2xl shadow-sm overflow-hidden hover-lift">
              <button
                onClick={() => setShowFlowTable(!showFlowTable)}
                className="w-full flex items-center justify-between px-6 py-4 hover:bg-[#fbfbfd] transition"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-xl bg-[#e8f4fd] flex items-center justify-center">
                    <Layers size={16} className="text-[#0071e3]" />
                  </div>
                  <div className="text-left">
                    <h3 className="text-[15px] font-semibold text-[#1d1d1f]">Flujo Resumido</h3>
                    <p className="text-[11px] text-[#86868b]">Desglose de flujo base + impacto simulado</p>
                  </div>
                </div>
                {showFlowTable
                  ? <ChevronDown size={18} className="text-[#86868b]" />
                  : <ChevronRight size={18} className="text-[#86868b]" />
                }
              </button>

              {showFlowTable && (
                <div className="overflow-x-auto border-t border-[#e8e8ed] animate-slide-down">
                  <table className="w-full text-[12px] min-w-[900px]">
                    <thead>
                      <tr className="border-b border-[#e8e8ed] bg-[#fbfbfd]">
                        <th className="text-left py-2.5 px-4 text-[#86868b] font-semibold sticky left-0 bg-[#fbfbfd] z-10 min-w-[160px]">
                          Concepto
                        </th>
                        {MONTHS.map((m) => (
                          <th key={m} className="text-right py-2.5 px-2 text-[#86868b] font-semibold min-w-[72px]">{m}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {summaryFlowData.map((row, ri) => {
                        const isSubtotal = row.style === 'subtotal';
                        const isTotal = row.style === 'total';
                        const isIncome = row.style === 'income';
                        return (
                          <tr
                            key={row.row}
                            className={`border-b hover-row transition ${
                              isTotal ? 'border-[#e8e8ed] bg-[#fbfbfd]' :
                              isSubtotal ? 'border-[#e8e8ed]' :
                              'border-[#f5f5f7]'
                            }`}
                          >
                            <td className={`py-2 px-4 sticky left-0 z-10 ${
                              isTotal ? 'font-bold text-[#1d1d1f] bg-[#fbfbfd]' :
                              isSubtotal ? 'font-semibold text-[#1d1d1f] bg-white' :
                              isIncome ? 'text-[#34c759] font-medium bg-white' :
                              'text-[#6e6e73] bg-white'
                            }`}>
                              {row.label}
                            </td>
                            {row.data.map((val, i) => (
                              <td key={i} className={`text-right py-2 px-2 font-mono ${
                                isTotal ? 'font-bold text-[#1d1d1f]' :
                                isSubtotal ? 'font-semibold text-[#1d1d1f]' :
                                isIncome ? 'text-[#34c759]' :
                                val < 0 ? 'text-[#ff3b30]' : 'text-[#6e6e73]'
                              }`}>
                                {formatCurrency(val)}
                              </td>
                            ))}
                          </tr>
                        );
                      })}

                      {/* ── Separator + Impact row ── */}
                      <tr className="border-b border-[#0071e3]/20 bg-[#e8f4fd]/40">
                        <td className="py-2.5 px-4 sticky left-0 z-10 bg-[#e8f4fd]/40 font-semibold text-[#0071e3]">
                          + Impacto Propuestas
                        </td>
                        {(simulationResult?.totalImpact || Array(12).fill(0)).map((val, i) => (
                          <td key={i} className="text-right py-2.5 px-2 font-mono font-semibold text-[#0071e3]">
                            {val !== 0 ? formatCurrency(val) : '—'}
                          </td>
                        ))}
                      </tr>

                      {/* Cumulative Impact row */}
                      <tr className="border-b border-[#0071e3]/20 bg-[#e8f4fd]/20">
                        <td className="py-2 px-4 sticky left-0 z-10 bg-[#e8f4fd]/20 text-[#0071e3] text-[11px]">
                          Impacto Acumulado
                        </td>
                        {(simulationResult?.cumulativeImpact || Array(12).fill(0)).map((val, i) => (
                          <td key={i} className="text-right py-2 px-2 font-mono text-[#0071e3] text-[11px]">
                            {val !== 0 ? formatCurrency(val) : '—'}
                          </td>
                        ))}
                      </tr>

                      {/* ── Variación Simulada ── */}
                      <tr className="border-b border-[#e8e8ed] hover-row">
                        <td className="py-2.5 px-4 sticky left-0 z-10 bg-white font-semibold text-[#1d1d1f]">
                          Variación Simulada
                        </td>
                        {(simulationResult?.simulatedVariacion || Array(12).fill(0)).map((val, i) => (
                          <td key={i} className={`text-right py-2.5 px-2 font-mono font-semibold ${
                            val > 0 ? 'text-[#34c759]' : val < 0 ? 'text-[#ff3b30]' : 'text-[#6e6e73]'
                          }`}>
                            {formatCurrency(val)}
                          </td>
                        ))}
                      </tr>

                      {/* ── Caja Final Simulada ── */}
                      <tr className="bg-gradient-to-r from-[#0071e3]/5 to-transparent">
                        <td className="py-3 px-4 sticky left-0 z-10 bg-[#e8f4fd]/30 font-bold text-[#0071e3] text-[13px]">
                          Caja Final Simulada
                        </td>
                        {(simulationResult?.simulatedCaja || Array(12).fill(0)).map((val, i) => (
                          <td key={i} className={`text-right py-3 px-2 font-mono font-bold text-[13px] ${
                            val > 0 ? 'text-[#34c759]' : 'text-[#ff3b30]'
                          }`}>
                            {formatCurrency(val)}
                          </td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* ── Impact Detail Table — smooth show/hide ── */}
            <div
              className="bg-white border border-[#d2d2d7]/40 rounded-2xl shadow-sm overflow-x-auto hover-lift"
              style={{
                maxHeight: hasSimulation ? 600 : 0,
                padding: hasSimulation ? 24 : 0,
                opacity: hasSimulation ? 1 : 0,
                borderWidth: hasSimulation ? 1 : 0,
                transition: 'max-height 0.4s cubic-bezier(0.22,1,0.36,1), padding 0.3s ease, opacity 0.3s ease, border-width 0.3s ease',
                overflow: 'hidden',
              }}
            >
              <h3 className="text-[15px] font-semibold text-[#1d1d1f] mb-4">Detalle de Impacto</h3>
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-[#e8e8ed]">
                    <th className="text-left py-2.5 px-3 text-[#86868b] font-semibold">Concepto</th>
                    {MONTHS.map((month) => (
                      <th key={month} className="text-right py-2.5 px-2 text-[#86868b] font-semibold">{month}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-[#f5f5f7] hover-row">
                    <td className="py-2.5 px-3 text-[#6e6e73]">Caja Base</td>
                    {tableData.map((row, i) => (
                      <td key={i} className="text-right py-2.5 px-2 text-[#86868b] font-mono">{formatCurrency(row.cajaBase)}</td>
                    ))}
                  </tr>
                  <tr className="border-b border-[#f5f5f7] hover-row">
                    <td className="py-2.5 px-3 text-[#6e6e73]">Impacto Mensual</td>
                    {tableData.map((row, i) => (
                      <td key={i} className="text-right py-2.5 px-2 text-[#0071e3] font-mono">{formatCurrency(row.impacto)}</td>
                    ))}
                  </tr>
                  <tr className="border-b border-[#f5f5f7] bg-[#e8f4fd]/20 hover-row">
                    <td className="py-2.5 px-3 text-[#0071e3] font-medium">Impacto Acumulado</td>
                    {tableData.map((row, i) => (
                      <td key={i} className="text-right py-2.5 px-2 text-[#0071e3] font-mono font-medium">{formatCurrency(row.impactoAcumulado)}</td>
                    ))}
                  </tr>
                  <tr className="border-b border-[#f5f5f7] hover-row">
                    <td className="py-2.5 px-3 text-[#1d1d1f] font-bold">Caja Simulada</td>
                    {tableData.map((row, i) => (
                      <td key={i} className={`text-right py-2.5 px-2 font-mono font-bold ${row.cajaSimulada > 0 ? 'text-[#34c759]' : 'text-[#ff3b30]'}`}>
                        {formatCurrency(row.cajaSimulada)}
                      </td>
                    ))}
                  </tr>
                  <tr className="hover-row">
                    <td className="py-2.5 px-3 text-[#86868b]">Delta vs Base</td>
                    {tableData.map((row, i) => (
                      <td key={i} className={`text-right py-2.5 px-2 font-mono ${row.delta > 0 ? 'text-[#34c759]' : row.delta < 0 ? 'text-[#ff3b30]' : 'text-[#86868b]'}`}>
                        {row.delta > 0 ? '+' : ''}{formatCurrency(row.delta)}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>

            {/* ── Action Buttons — smooth show/hide ── */}
            <div
              className="flex gap-3"
              style={{
                maxHeight: hasSimulation ? 60 : 0,
                opacity: hasSimulation ? 1 : 0,
                overflow: 'hidden',
                transition: 'max-height 0.3s ease, opacity 0.3s ease',
              }}
            >
              <button
                onClick={copySummary}
                className="flex-1 flex items-center justify-center gap-2 bg-white border border-[#d2d2d7]/60 hover:bg-[#f5f5f7] text-[#1d1d1f] rounded-xl px-4 py-3 transition font-medium text-[13px] shadow-sm hover-press"
              >
                {copiedSummary ? (
                  <>
                    <Check size={16} className="text-[#34c759]" />
                    <span className="text-[#34c759]">Copiado</span>
                  </>
                ) : (
                  <>
                    <Copy size={16} />
                    Exportar Resumen
                  </>
                )}
              </button>
              <button
                onClick={() => setShowSaveModal(true)}
                className="flex-1 flex items-center justify-center gap-2 bg-[#0071e3] hover:bg-[#0077ED] text-white rounded-xl px-4 py-3 transition font-medium text-[13px] shadow-sm hover-press"
              >
                <Save size={16} />
                Guardar Escenario
              </button>
            </div>
          </div>
      </div>

      {/* ═══════════════ Save Scenario Modal ═══════════════ */}
      {showSaveModal && (
        <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fade-in">
          <div className="bg-white border border-[#d2d2d7]/40 rounded-2xl max-w-md w-full p-7 shadow-2xl animate-scale-in">
            <h3 className="text-[17px] font-semibold text-[#1d1d1f] mb-5">Guardar Escenario</h3>
            <div className="space-y-4 mb-6">
              <div>
                <label className="block text-[12px] font-semibold text-[#86868b] mb-2 uppercase tracking-wider">Nombre</label>
                <input
                  type="text"
                  value={scenarioName}
                  onChange={(e) => setScenarioName(e.target.value)}
                  placeholder="Ej: Escenario Optimista"
                  className="w-full bg-[#f5f5f7] border border-[#d2d2d7]/40 rounded-xl px-4 py-2.5 text-[14px] text-[#1d1d1f] placeholder-[#c7c7cc] focus:border-[#0071e3] focus:bg-white"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[#86868b] mb-2 uppercase tracking-wider">Descripción (opcional)</label>
                <textarea
                  value={scenarioDescription}
                  onChange={(e) => setScenarioDescription(e.target.value)}
                  placeholder="Describe este escenario..."
                  className="w-full bg-[#f5f5f7] border border-[#d2d2d7]/40 rounded-xl px-4 py-2.5 text-[14px] text-[#1d1d1f] placeholder-[#c7c7cc] focus:border-[#0071e3] focus:bg-white resize-none h-24"
                />
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => { setShowSaveModal(false); setScenarioName(''); setScenarioDescription(''); }}
                className="flex-1 px-4 py-2.5 bg-[#f5f5f7] hover:bg-[#e8e8ed] text-[#6e6e73] rounded-xl transition font-medium text-[13px] hover-press"
              >
                Cancelar
              </button>
              <button
                onClick={handleSaveScenario}
                disabled={!scenarioName.trim()}
                className="flex-1 px-4 py-2.5 bg-[#0071e3] hover:bg-[#0077ED] disabled:bg-[#d2d2d7] disabled:text-[#86868b] text-white rounded-xl transition font-medium text-[13px] flex items-center justify-center gap-2 hover-press"
              >
                <Save size={14} />
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Simulator;
