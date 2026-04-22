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

const Simulator = ({ plan, proposals, scenarios, onSaveScenario }: SimulatorProps) => {
  const [selectedProposalIds, setSelectedProposalIds] = useState<Set<string>>(new Set());
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [scenarioName, setScenarioName] = useState('');
  const [scenarioDescription, setScenarioDescription] = useState('');
  const [copiedSummary, setCopiedSummary] = useState(false);

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

  const baseCashFlowData = useMemo(() => {
    const cajaFinalConcept = plan.concepts.find((c) => c.excelRow === 115);
    const variacionConcept = plan.concepts.find((c) => c.excelRow === 114);
    const baseCaja = cajaFinalConcept?.monthlyData || Array(12).fill(0);
    const baseVariacion = variacionConcept?.monthlyData || Array(12).fill(0);
    const cajaInicial = plan.cajaInicial || 0;
    return { baseCaja, baseVariacion, cajaInicial };
  }, [plan]);

  const simulationResult = useMemo(() => {
    if (activeProposals.length === 0) return null;
    return simulateCashFlow(
      baseCashFlowData.baseCaja,
      baseCashFlowData.baseVariacion,
      baseCashFlowData.cajaInicial,
      activeProposals
    );
  }, [baseCashFlowData, activeProposals]);

  const kpis = useMemo(() => {
    if (!simulationResult) return null;
    const { simulatedCaja } = simulationResult;
    const annualImpact = activeProposals.reduce((sum, p) => sum + p.annualImpact, 0);
    const minCaja = Math.min(...simulatedCaja);
    const hasDeficit = simulatedCaja.some((c) => c < 0);
    const deficitMonths = simulatedCaja.map((c, i) => (c < 0 ? MONTHS[i] : null)).filter((m) => m !== null);
    return { activeCount: activeProposals.length, annualImpact, minCaja, hasDeficit, deficitMonths };
  }, [simulationResult, activeProposals]);

  const chartData = useMemo(() => {
    const simulatedCaja = simulationResult?.simulatedCaja;
    return MONTHS.map((month, i) => ({
      month,
      cajaBase: baseCashFlowData.baseCaja[i] || 0,
      cajaSimulada: simulatedCaja ? simulatedCaja[i] || 0 : baseCashFlowData.baseCaja[i] || 0,
    }));
  }, [simulationResult, baseCashFlowData.baseCaja]);

  const tableData = useMemo(() => {
    if (!simulationResult) return [];
    const { simulatedCaja, totalImpact } = simulationResult;
    return MONTHS.map((month, i) => ({
      month,
      cajaBase: baseCashFlowData.baseCaja[i] || 0,
      impacto: totalImpact[i] || 0,
      cajaSimulada: simulatedCaja[i] || 0,
      delta: (simulatedCaja[i] || 0) - (baseCashFlowData.baseCaja[i] || 0),
    }));
  }, [simulationResult, baseCashFlowData.baseCaja]);

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

  return (
    <div className="flex gap-6 min-h-[calc(100vh-140px)]">
      {/* LEFT COLUMN: Proposals */}
      <div className="w-[340px] flex-shrink-0 flex flex-col bg-white rounded-2xl border border-[#d2d2d7]/40 shadow-sm overflow-hidden">
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
              className="w-full mb-3 px-3 py-2 bg-[#e8f4fd] hover:bg-[#d6ecfc] text-[#0071e3] rounded-xl transition text-[13px] font-medium"
            >
              {selectedProposalIds.size === filteredProposals.length ? 'Deseleccionar Todo' : 'Seleccionar Todo'}
            </button>
          )}

          {/* Category Filter */}
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setCategoryFilter(null)}
              className={`px-3 py-1.5 rounded-full text-[11px] font-medium transition ${
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
                className={`px-3 py-1.5 rounded-full text-[11px] font-medium transition ${
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
            {filteredProposals.map((proposal) => {
              const isSelected = selectedProposalIds.has(proposal.id);
              return (
                <button
                  key={proposal.id}
                  onClick={() => toggleProposal(proposal.id)}
                  className={`w-full text-left p-3.5 rounded-xl transition-all ${
                    isSelected
                      ? 'bg-[#e8f4fd] border border-[#0071e3]/20'
                      : 'bg-[#f5f5f7] border border-transparent hover:bg-[#e8e8ed]'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {/* Toggle Switch */}
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
          <div className="border-t border-[#e8e8ed] p-4">
            <p className="text-[11px] text-[#86868b] font-semibold uppercase tracking-wider mb-2">Escenarios Guardados</p>
            <div className="space-y-1.5 max-h-28 overflow-y-auto">
              {scenarios.map((scenario) => (
                <button
                  key={scenario.id}
                  onClick={() => loadScenario(scenario)}
                  className="w-full px-3 py-2 text-left bg-[#f5f5f7] hover:bg-[#e8e8ed] rounded-lg transition text-[12px] text-[#6e6e73] hover:text-[#1d1d1f] truncate"
                  title={scenario.description}
                >
                  {scenario.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* RIGHT COLUMN: Simulation Results */}
      <div className="flex-1 overflow-y-auto">
        {activeProposals.length === 0 ? (
          <div className="h-full flex items-center justify-center bg-white rounded-2xl border border-[#d2d2d7]/40 shadow-sm">
            <div className="text-center">
              <div className="w-16 h-16 rounded-2xl bg-[#f5f5f7] flex items-center justify-center mx-auto mb-4">
                <TrendingUp className="text-[#c7c7cc]" size={28} />
              </div>
              <p className="text-[15px] font-medium text-[#1d1d1f] mb-1">Simulador de Escenarios</p>
              <p className="text-[13px] text-[#86868b]">Selecciona propuestas para ver el impacto en el flujo</p>
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            {/* KPIs */}
            <div className="grid grid-cols-4 gap-4">
              <div className="bg-white border border-[#d2d2d7]/40 rounded-2xl p-5 shadow-sm">
                <p className="text-[11px] text-[#86868b] font-semibold uppercase tracking-wider mb-2">Propuestas Activas</p>
                <p className="text-[24px] font-bold text-[#0071e3]">{kpis?.activeCount}</p>
              </div>

              <div className="bg-white border border-[#d2d2d7]/40 rounded-2xl p-5 shadow-sm">
                <p className="text-[11px] text-[#86868b] font-semibold uppercase tracking-wider mb-2">Impacto Anual</p>
                <p className="text-[22px] font-bold text-[#34c759] font-mono">{formatCurrency(kpis?.annualImpact || 0)}</p>
              </div>

              <div className="bg-white border border-[#d2d2d7]/40 rounded-2xl p-5 shadow-sm">
                <p className="text-[11px] text-[#86868b] font-semibold uppercase tracking-wider mb-2">Caja Mínima</p>
                <p className={`text-[22px] font-bold font-mono ${(kpis?.minCaja || 0) > 0 ? 'text-[#34c759]' : 'text-[#ff3b30]'}`}>
                  {formatCurrency(kpis?.minCaja || 0)}
                </p>
              </div>

              <div className="bg-white border border-[#d2d2d7]/40 rounded-2xl p-5 shadow-sm">
                <p className="text-[11px] text-[#86868b] font-semibold uppercase tracking-wider mb-2">Liquidez</p>
                {kpis?.hasDeficit ? (
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-[#ffe5e5] flex items-center justify-center">
                      <X className="text-[#ff3b30]" size={12} />
                    </div>
                    <span className="text-[12px] text-[#ff3b30] font-medium">Déficit: {kpis.deficitMonths.join(', ')}</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-[#e8faf0] flex items-center justify-center">
                      <CheckCircle className="text-[#34c759]" size={12} />
                    </div>
                    <span className="text-[12px] text-[#34c759] font-medium">Asegurada</span>
                  </div>
                )}
              </div>
            </div>

            {/* Chart */}
            <div className="bg-white border border-[#d2d2d7]/40 rounded-2xl p-6 shadow-sm">
              <h3 className="text-[16px] font-semibold text-[#1d1d1f] mb-5">Proyección de Caja Simulada</h3>
              <ResponsiveContainer width="100%" height={350}>
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="colorCajaBase" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#86868b" stopOpacity={0.15} />
                      <stop offset="95%" stopColor="#86868b" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="colorCajaSimulada" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#0071e3" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#0071e3" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#e8e8ed" strokeDasharray="0" vertical={false} />
                  <XAxis
                    dataKey="month"
                    tick={{ fill: '#86868b', fontSize: 12 }}
                    axisLine={{ stroke: '#e8e8ed' }}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: '#86868b', fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(value) => `$${value}M`}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <ReferenceLine y={0} stroke="#ff3b30" strokeDasharray="5 5" strokeOpacity={0.4} />
                  <Area
                    type="monotone"
                    dataKey="cajaBase"
                    stroke="#c7c7cc"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorCajaBase)"
                    name="Caja Base"
                    dot={false}
                  />
                  <Area
                    type="monotone"
                    dataKey="cajaSimulada"
                    stroke="#0071e3"
                    strokeWidth={2.5}
                    fillOpacity={1}
                    fill="url(#colorCajaSimulada)"
                    name="Caja Simulada"
                    dot={{ fill: '#0071e3', r: 3, strokeWidth: 2, stroke: '#fff' }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Impact Table */}
            <div className="bg-white border border-[#d2d2d7]/40 rounded-2xl p-6 shadow-sm overflow-x-auto">
              <h3 className="text-[16px] font-semibold text-[#1d1d1f] mb-5">Detalle de Impacto Mensual</h3>
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-[#e8e8ed]">
                    <th className="text-left py-2.5 px-3 text-[#86868b] font-semibold">Concepto</th>
                    {MONTHS.map((month) => (
                      <th key={month} className="text-right py-2.5 px-2 text-[#86868b] font-semibold">
                        {month}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-[#f5f5f7]">
                    <td className="py-2.5 px-3 text-[#6e6e73]">Caja Base</td>
                    {tableData.map((row, i) => (
                      <td key={i} className="text-right py-2.5 px-2 text-[#86868b] font-mono">
                        {formatCurrency(row.cajaBase)}
                      </td>
                    ))}
                  </tr>
                  <tr className="border-b border-[#f5f5f7] bg-[#e8f4fd]/30">
                    <td className="py-2.5 px-3 text-[#0071e3] font-medium">Impacto Propuestas</td>
                    {tableData.map((row, i) => (
                      <td key={i} className="text-right py-2.5 px-2 text-[#0071e3] font-mono font-medium">
                        {formatCurrency(row.impacto)}
                      </td>
                    ))}
                  </tr>
                  <tr className="border-b border-[#f5f5f7]">
                    <td className="py-2.5 px-3 text-[#1d1d1f] font-bold">Caja Simulada</td>
                    {tableData.map((row, i) => (
                      <td
                        key={i}
                        className={`text-right py-2.5 px-2 font-mono font-bold ${
                          row.cajaSimulada > 0 ? 'text-[#34c759]' : 'text-[#ff3b30]'
                        }`}
                      >
                        {formatCurrency(row.cajaSimulada)}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="py-2.5 px-3 text-[#86868b]">Delta</td>
                    {tableData.map((row, i) => (
                      <td
                        key={i}
                        className={`text-right py-2.5 px-2 font-mono ${row.delta > 0 ? 'text-[#34c759]' : 'text-[#ff3b30]'}`}
                      >
                        {formatCurrency(row.delta)}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-3">
              <button
                onClick={copySummary}
                className="flex-1 flex items-center justify-center gap-2 bg-white border border-[#d2d2d7]/60 hover:bg-[#f5f5f7] text-[#1d1d1f] rounded-xl px-4 py-3 transition font-medium text-[13px] shadow-sm"
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
                className="flex-1 flex items-center justify-center gap-2 bg-[#0071e3] hover:bg-[#0077ED] text-white rounded-xl px-4 py-3 transition font-medium text-[13px] shadow-sm"
              >
                <Save size={16} />
                Guardar Escenario
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Save Scenario Modal */}
      {showSaveModal && (
        <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white border border-[#d2d2d7]/40 rounded-2xl max-w-md w-full p-7 shadow-2xl">
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
                onClick={() => {
                  setShowSaveModal(false);
                  setScenarioName('');
                  setScenarioDescription('');
                }}
                className="flex-1 px-4 py-2.5 bg-[#f5f5f7] hover:bg-[#e8e8ed] text-[#6e6e73] rounded-xl transition font-medium text-[13px]"
              >
                Cancelar
              </button>
              <button
                onClick={handleSaveScenario}
                disabled={!scenarioName.trim()}
                className="flex-1 px-4 py-2.5 bg-[#0071e3] hover:bg-[#0077ED] disabled:bg-[#d2d2d7] disabled:text-[#86868b] text-white rounded-xl transition font-medium text-[13px] flex items-center justify-center gap-2"
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
