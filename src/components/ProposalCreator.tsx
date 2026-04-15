import { useState, useMemo } from 'react';
import {
  Plus,
  Edit3,
  Trash2,
  X,
  Save,
  TrendingDown,
  TrendingUp,
  Clock,
  RefreshCw,
  Search,
} from 'lucide-react';
import { FlowPlan, Proposal, MONTHS, MONTHS_FULL, CATEGORY_COLORS } from '../types';
import { calculateProposalImpact, formatCurrency } from '../utils/calculations';

interface ProposalCreatorProps {
  plan: FlowPlan;
  proposals: Proposal[];
  onAdd: (p: Proposal) => void;
  onUpdate: (p: Proposal) => void;
  onDelete: (id: string) => void;
}

const CATEGORIES: Proposal['category'][] = [
  'Reducción de Costos',
  'Incremento de Ingresos',
  'Diferimiento',
  'Renegociación',
];

const CATEGORY_ICONS: Record<string, any> = {
  'Reducción de Costos': TrendingDown,
  'Incremento de Ingresos': TrendingUp,
  'Diferimiento': Clock,
  'Renegociación': RefreshCw,
};

const DISTRIBUTIONS: Proposal['distribution'][] = ['Mensual', 'Semestral', 'Único'];
const STATUSES: Proposal['status'][] = ['Pendiente', 'En proceso', 'Aprobada', 'Descartada'];

const STATUS_STYLES: Record<string, string> = {
  'Pendiente': 'bg-[#fff8e6] text-[#b25000] border-[#ffe0a0]',
  'En proceso': 'bg-[#e8f4fd] text-[#0071e3] border-[#b3d7f5]',
  'Aprobada': 'bg-[#e8faf0] text-[#248a3d] border-[#b3e6c8]',
  'Descartada': 'bg-[#fff5f5] text-[#ff3b30] border-[#ffc9c6]',
};

interface FormData {
  category: Proposal['category'];
  name: string;
  monthlyAmount: number;
  probability: number;
  startMonth: number;
  distribution: Proposal['distribution'];
  status: Proposal['status'];
  responsible: string;
  notes: string;
}

const DEFAULT_FORM: FormData = {
  category: 'Reducción de Costos',
  name: '',
  monthlyAmount: 0,
  probability: 80,
  startMonth: 1,
  distribution: 'Mensual',
  status: 'Pendiente',
  responsible: '',
  notes: '',
};

const ProposalCreator = ({ plan, proposals, onAdd, onUpdate, onDelete }: ProposalCreatorProps) => {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<FormData>(DEFAULT_FORM);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'name' | 'annualImpact' | 'status' | 'createdAt'>('createdAt');

  const impactPreview = useMemo(() => {
    return calculateProposalImpact(
      formData.monthlyAmount,
      formData.probability / 100,
      formData.startMonth,
      formData.distribution,
    );
  }, [formData.monthlyAmount, formData.probability, formData.startMonth, formData.distribution]);

  const categoryTotals = useMemo(() => {
    const totals: Record<string, { count: number; impact: number }> = {};
    for (const cat of CATEGORIES) {
      const catProposals = proposals.filter((p) => p.category === cat && p.status !== 'Descartada');
      totals[cat] = {
        count: catProposals.length,
        impact: catProposals.reduce((sum, p) => sum + p.annualImpact, 0),
      };
    }
    return totals;
  }, [proposals]);

  const filteredProposals = useMemo(() => {
    let result = [...proposals];
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (p) => p.name.toLowerCase().includes(q) || p.responsible.toLowerCase().includes(q)
      );
    }
    if (filterCategory) result = result.filter((p) => p.category === filterCategory);
    if (filterStatus) result = result.filter((p) => p.status === filterStatus);

    result.sort((a, b) => {
      if (sortBy === 'annualImpact') return b.annualImpact - a.annualImpact;
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'status') return a.status.localeCompare(b.status);
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    return result;
  }, [proposals, searchQuery, filterCategory, filterStatus, sortBy]);

  const openNewForm = () => {
    setFormData(DEFAULT_FORM);
    setEditingId(null);
    setShowForm(true);
  };

  const openEditForm = (proposal: Proposal) => {
    setFormData({
      category: proposal.category,
      name: proposal.name,
      monthlyAmount: proposal.monthlyAmount,
      probability: proposal.probability * 100,
      startMonth: proposal.startMonth,
      distribution: proposal.distribution,
      status: proposal.status,
      responsible: proposal.responsible,
      notes: proposal.notes,
    });
    setEditingId(proposal.id);
    setShowForm(true);
  };

  const handleSave = () => {
    if (!formData.name.trim()) return;
    const { monthlyImpact, annualImpact } = impactPreview;

    const proposal: Proposal = {
      id: editingId || `proposal-${Date.now()}`,
      category: formData.category,
      name: formData.name,
      monthlyAmount: formData.monthlyAmount,
      probability: formData.probability / 100,
      startMonth: formData.startMonth,
      distribution: formData.distribution,
      status: formData.status,
      annualImpact,
      monthlyImpact,
      responsible: formData.responsible,
      notes: formData.notes,
      createdAt: editingId
        ? proposals.find((p) => p.id === editingId)?.createdAt || new Date().toISOString()
        : new Date().toISOString(),
    };

    if (editingId) {
      onUpdate(proposal);
    } else {
      onAdd(proposal);
    }

    setShowForm(false);
    setEditingId(null);
    setFormData(DEFAULT_FORM);
  };

  const cancelForm = () => {
    setShowForm(false);
    setEditingId(null);
    setFormData(DEFAULT_FORM);
  };

  return (
    <div className="space-y-5">
      {/* Category Summary Cards */}
      <div className="grid grid-cols-4 gap-4">
        {CATEGORIES.map((cat, idx) => {
          const Icon = CATEGORY_ICONS[cat];
          const totals = categoryTotals[cat] || { count: 0, impact: 0 };
          const isActive = filterCategory === cat;
          return (
            <div
              key={cat}
              onClick={() => setFilterCategory(isActive ? null : cat)}
              className={`bg-white rounded-2xl border p-5 cursor-pointer transition-all hover:shadow-md animate-card-in hover-lift ${['stagger-1', 'stagger-2', 'stagger-3', 'stagger-4'][idx]} ${
                isActive
                  ? 'border-[#0071e3] shadow-md ring-1 ring-[#0071e3]/20'
                  : 'border-[#d2d2d7]/40 shadow-sm'
              }`}
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] text-[#86868b] font-semibold uppercase tracking-wider">{cat}</span>
                <div
                  className="w-7 h-7 rounded-lg flex items-center justify-center"
                  style={{ backgroundColor: CATEGORY_COLORS[cat] + '18' }}
                >
                  <Icon className="w-3.5 h-3.5" style={{ color: CATEGORY_COLORS[cat] }} />
                </div>
              </div>
              <p className="text-[20px] font-bold text-[#1d1d1f] font-mono tracking-tight">{formatCurrency(totals.impact)}</p>
              <p className="text-[11px] text-[#86868b] mt-1">{totals.count} propuesta{totals.count !== 1 ? 's' : ''}</p>
            </div>
          );
        })}
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <button
          onClick={openNewForm}
          className="flex items-center gap-2 px-5 py-2.5 bg-[#0071e3] hover:bg-[#0077ED] text-white font-medium rounded-full transition text-[13px] shadow-sm"
        >
          <Plus className="w-4 h-4" />
          Nueva Propuesta
        </button>

        <div className="flex-1 relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#86868b]" />
          <input
            type="text"
            placeholder="Buscar propuesta o responsable..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-[#f5f5f7] border border-[#d2d2d7]/40 rounded-full text-[13px] text-[#1d1d1f] placeholder-[#86868b] focus:border-[#0071e3] focus:bg-white"
          />
        </div>

        <select
          value={filterStatus || ''}
          onChange={(e) => setFilterStatus(e.target.value || null)}
          className="px-4 py-2.5 bg-[#f5f5f7] border border-[#d2d2d7]/40 rounded-full text-[13px] text-[#6e6e73] focus:border-[#0071e3]"
        >
          <option value="">Todos los estatus</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as any)}
          className="px-4 py-2.5 bg-[#f5f5f7] border border-[#d2d2d7]/40 rounded-full text-[13px] text-[#6e6e73] focus:border-[#0071e3]"
        >
          <option value="createdAt">Más recientes</option>
          <option value="annualImpact">Mayor impacto</option>
          <option value="name">Nombre A-Z</option>
          <option value="status">Por estatus</option>
        </select>
      </div>

      {/* Active filter indicator */}
      {filterCategory && (
        <div className="flex items-center gap-2 text-[13px]">
          <span className="text-[#86868b]">Filtrando por:</span>
          <span
            className="px-2.5 py-0.5 rounded-full text-[12px] font-medium"
            style={{ backgroundColor: CATEGORY_COLORS[filterCategory] + '18', color: CATEGORY_COLORS[filterCategory] }}
          >
            {filterCategory}
          </span>
          <button onClick={() => setFilterCategory(null)} className="text-[#86868b] hover:text-[#1d1d1f]">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Proposal Form */}
      {showForm && (
        <div className="bg-white border border-[#d2d2d7]/40 rounded-2xl p-7 shadow-sm space-y-6 animate-card-in hover-lift stagger-5">
          <div className="flex items-center justify-between">
            <h3 className="text-[17px] font-semibold text-[#1d1d1f]">
              {editingId ? 'Editar Propuesta' : 'Nueva Propuesta'}
            </h3>
            <button onClick={cancelForm} className="w-8 h-8 rounded-full bg-[#f5f5f7] hover:bg-[#e8e8ed] flex items-center justify-center transition">
              <X className="w-4 h-4 text-[#86868b]" />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-7">
            {/* Left column */}
            <div className="space-y-5">
              {/* Category */}
              <div>
                <label className="block text-[12px] text-[#86868b] font-semibold mb-2 uppercase tracking-wider">Categoría</label>
                <div className="grid grid-cols-2 gap-2">
                  {CATEGORIES.map((cat) => {
                    const Icon = CATEGORY_ICONS[cat];
                    return (
                      <button
                        key={cat}
                        onClick={() => setFormData({ ...formData, category: cat })}
                        className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-[12px] font-medium transition ${
                          formData.category === cat
                            ? 'border-[#0071e3] bg-[#e8f4fd] text-[#0071e3]'
                            : 'border-[#d2d2d7]/60 bg-[#fbfbfd] text-[#6e6e73] hover:border-[#86868b]'
                        }`}
                      >
                        <Icon className="w-3.5 h-3.5" />
                        {cat}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Name */}
              <div>
                <label className="block text-[12px] text-[#86868b] font-semibold mb-2 uppercase tracking-wider">
                  Nombre de la Propuesta
                </label>
                <input
                  type="text"
                  placeholder="Ej: Renegociar contrato de diésel"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-4 py-2.5 bg-[#f5f5f7] border border-[#d2d2d7]/40 rounded-xl text-[14px] text-[#1d1d1f] placeholder-[#c7c7cc] focus:border-[#0071e3] focus:bg-white"
                />
              </div>

              {/* Responsible */}
              <div>
                <label className="block text-[12px] text-[#86868b] font-semibold mb-2 uppercase tracking-wider">Responsable</label>
                <input
                  type="text"
                  placeholder="Ej: David Silva"
                  value={formData.responsible}
                  onChange={(e) => setFormData({ ...formData, responsible: e.target.value })}
                  className="w-full px-4 py-2.5 bg-[#f5f5f7] border border-[#d2d2d7]/40 rounded-xl text-[14px] text-[#1d1d1f] placeholder-[#c7c7cc] focus:border-[#0071e3] focus:bg-white"
                />
              </div>

              {/* Notes */}
              <div>
                <label className="block text-[12px] text-[#86868b] font-semibold mb-2 uppercase tracking-wider">Notas</label>
                <textarea
                  placeholder="Contexto, justificación, riesgos..."
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  rows={3}
                  className="w-full px-4 py-2.5 bg-[#f5f5f7] border border-[#d2d2d7]/40 rounded-xl text-[14px] text-[#1d1d1f] placeholder-[#c7c7cc] focus:border-[#0071e3] focus:bg-white resize-none"
                />
              </div>
            </div>

            {/* Right column */}
            <div className="space-y-5">
              {/* Monthly Amount */}
              <div>
                <label className="block text-[12px] text-[#86868b] font-semibold mb-2 uppercase tracking-wider">
                  Impacto Mensual Estimado ($M)
                </label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[#86868b] text-[14px]">$</span>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    placeholder="0.00"
                    value={formData.monthlyAmount || ''}
                    onChange={(e) => setFormData({ ...formData, monthlyAmount: parseFloat(e.target.value) || 0 })}
                    className="w-full pl-8 pr-14 py-2.5 bg-[#f5f5f7] border border-[#d2d2d7]/40 rounded-xl text-[14px] text-[#1d1d1f] font-mono placeholder-[#c7c7cc] focus:border-[#0071e3] focus:bg-white"
                  />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[#86868b] text-[12px]">M/mes</span>
                </div>
              </div>

              {/* Probability */}
              <div>
                <label className="block text-[12px] text-[#86868b] font-semibold mb-2 uppercase tracking-wider">
                  Probabilidad: <span className="text-[#0071e3]">{formData.probability}%</span>
                </label>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="5"
                  value={formData.probability}
                  onChange={(e) => setFormData({ ...formData, probability: parseInt(e.target.value) })}
                  className="w-full"
                />
                <div className="flex justify-between text-[11px] text-[#c7c7cc] mt-1">
                  <span>0%</span>
                  <span>50%</span>
                  <span>100%</span>
                </div>
              </div>

              {/* Start Month & Distribution */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] text-[#86868b] font-semibold mb-2 uppercase tracking-wider">Mes de Inicio</label>
                  <select
                    value={formData.startMonth}
                    onChange={(e) => setFormData({ ...formData, startMonth: parseInt(e.target.value) })}
                    className="w-full px-4 py-2.5 bg-[#f5f5f7] border border-[#d2d2d7]/40 rounded-xl text-[14px] text-[#1d1d1f] focus:border-[#0071e3]"
                  >
                    {MONTHS_FULL.map((m, i) => (
                      <option key={i} value={i + 1}>{m}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] text-[#86868b] font-semibold mb-2 uppercase tracking-wider">Distribución</label>
                  <select
                    value={formData.distribution}
                    onChange={(e) => setFormData({ ...formData, distribution: e.target.value as Proposal['distribution'] })}
                    className="w-full px-4 py-2.5 bg-[#f5f5f7] border border-[#d2d2d7]/40 rounded-xl text-[14px] text-[#1d1d1f] focus:border-[#0071e3]"
                  >
                    {DISTRIBUTIONS.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Status */}
              <div>
                <label className="block text-[12px] text-[#86868b] font-semibold mb-2 uppercase tracking-wider">Estatus</label>
                <div className="flex gap-2">
                  {STATUSES.map((s) => (
                    <button
                      key={s}
                      onClick={() => setFormData({ ...formData, status: s })}
                      className={`px-3 py-1.5 rounded-full border text-[12px] font-medium transition ${
                        formData.status === s
                          ? STATUS_STYLES[s]
                          : 'border-[#d2d2d7]/60 bg-[#fbfbfd] text-[#86868b] hover:border-[#86868b]'
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              {/* Live Impact Preview */}
              <div className="bg-[#f5f5f7] rounded-2xl p-5">
                <p className="text-[11px] text-[#86868b] font-semibold uppercase tracking-wider mb-3">Preview de Impacto</p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-[11px] text-[#86868b]">Mensual Ponderado</p>
                    <p className="text-[18px] font-bold text-[#0071e3] font-mono">
                      {formatCurrency(formData.monthlyAmount * (formData.probability / 100))}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-[#86868b]">Anual Total</p>
                    <p className="text-[18px] font-bold text-[#34c759] font-mono">
                      {formatCurrency(impactPreview.annualImpact)}
                    </p>
                  </div>
                </div>
                <div className="mt-4 flex gap-1">
                  {impactPreview.monthlyImpact.map((val, i) => (
                    <div key={i} className="flex-1 flex flex-col items-center">
                      <div
                        className="w-full rounded-sm transition-all"
                        style={{
                          height: val > 0 ? Math.max(4, Math.min(32, (val / (formData.monthlyAmount || 1)) * 32)) : 2,
                          backgroundColor: val > 0 ? '#0071e3' : '#e8e8ed',
                        }}
                      />
                      <span className="text-[9px] text-[#c7c7cc] mt-1">{MONTHS[i]}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Save Button */}
          <div className="flex justify-end gap-3 pt-4 border-t border-[#e8e8ed]">
            <button
              onClick={cancelForm}
              className="px-5 py-2.5 text-[13px] text-[#6e6e73] hover:text-[#1d1d1f] font-medium rounded-full hover:bg-[#f5f5f7] transition hover-press"
            >
              Cancelar
            </button>
            <button
              onClick={handleSave}
              disabled={!formData.name.trim() || formData.monthlyAmount <= 0}
              className="flex items-center gap-2 px-6 py-2.5 bg-[#0071e3] hover:bg-[#0077ED] disabled:bg-[#d2d2d7] disabled:text-[#86868b] text-white font-medium rounded-full transition text-[13px] shadow-sm hover-press"
            >
              <Save className="w-4 h-4" />
              {editingId ? 'Guardar Cambios' : 'Crear Propuesta'}
            </button>
          </div>
        </div>
      )}

      {/* Proposals Table */}
      {filteredProposals.length > 0 ? (
        <div className="bg-white border border-[#d2d2d7]/40 rounded-2xl overflow-hidden shadow-sm animate-card-in hover-lift stagger-6">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-[#e8e8ed] bg-[#fbfbfd]">
                <th className="text-left py-3 px-5 text-[#86868b] font-semibold text-[11px] uppercase tracking-wider">Propuesta</th>
                <th className="text-left py-3 px-3 text-[#86868b] font-semibold text-[11px] uppercase tracking-wider">Categoría</th>
                <th className="text-left py-3 px-3 text-[#86868b] font-semibold text-[11px] uppercase tracking-wider">Responsable</th>
                <th className="text-right py-3 px-3 text-[#86868b] font-semibold text-[11px] uppercase tracking-wider">$/mes</th>
                <th className="text-right py-3 px-3 text-[#86868b] font-semibold text-[11px] uppercase tracking-wider">Prob</th>
                <th className="text-center py-3 px-3 text-[#86868b] font-semibold text-[11px] uppercase tracking-wider">Inicio</th>
                <th className="text-center py-3 px-3 text-[#86868b] font-semibold text-[11px] uppercase tracking-wider">Dist.</th>
                <th className="text-right py-3 px-3 text-[#86868b] font-semibold text-[11px] uppercase tracking-wider">Impacto Anual</th>
                <th className="text-center py-3 px-3 text-[#86868b] font-semibold text-[11px] uppercase tracking-wider">Estatus</th>
                <th className="text-right py-3 px-4 text-[#86868b] font-semibold text-[11px] uppercase tracking-wider">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filteredProposals.map((proposal) => (
                <tr
                  key={proposal.id}
                  className="border-b border-[#f5f5f7] hover:bg-[#fbfbfd] transition hover-row"
                >
                  <td className="py-3.5 px-5">
                    <p className="font-medium text-[#1d1d1f] text-[13px]">{proposal.name}</p>
                    {proposal.notes && (
                      <p className="text-[11px] text-[#86868b] mt-0.5 truncate max-w-[200px]">{proposal.notes}</p>
                    )}
                  </td>
                  <td className="py-3.5 px-3">
                    <span
                      className="text-[11px] px-2.5 py-1 rounded-full font-medium"
                      style={{
                        backgroundColor: CATEGORY_COLORS[proposal.category] + '18',
                        color: CATEGORY_COLORS[proposal.category],
                      }}
                    >
                      {proposal.category.split(' ')[0]}
                    </span>
                  </td>
                  <td className="py-3.5 px-3 text-[#6e6e73] text-[12px]">{proposal.responsible || '—'}</td>
                  <td className="py-3.5 px-3 text-right font-mono text-[#1d1d1f]">
                    {formatCurrency(proposal.monthlyAmount)}
                  </td>
                  <td className="py-3.5 px-3 text-right font-mono text-[#6e6e73]">
                    {(proposal.probability * 100).toFixed(0)}%
                  </td>
                  <td className="py-3.5 px-3 text-center text-[#6e6e73] text-[12px]">
                    {MONTHS[proposal.startMonth - 1]}
                  </td>
                  <td className="py-3.5 px-3 text-center text-[#6e6e73] text-[12px]">
                    {proposal.distribution}
                  </td>
                  <td className="py-3.5 px-3 text-right font-mono font-semibold text-[#34c759]">
                    {formatCurrency(proposal.annualImpact)}
                  </td>
                  <td className="py-3.5 px-3 text-center">
                    <span className={`text-[11px] px-2.5 py-1 rounded-full border font-medium ${STATUS_STYLES[proposal.status]}`}>
                      {proposal.status}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => openEditForm(proposal)}
                        className="p-2 text-[#86868b] hover:text-[#0071e3] transition rounded-lg hover:bg-[#e8f4fd] hover-press"
                        title="Editar"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => onDelete(proposal.id)}
                        className="p-2 text-[#86868b] hover:text-[#ff3b30] transition rounded-lg hover:bg-[#fff5f5] hover-press"
                        title="Eliminar"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Totals Row */}
          <div className="border-t border-[#e8e8ed] bg-[#fbfbfd] px-5 py-3.5 flex items-center justify-between">
            <span className="text-[13px] text-[#86868b]">
              {filteredProposals.length} propuesta{filteredProposals.length !== 1 ? 's' : ''}
              {filterCategory ? ` en "${filterCategory}"` : ''}
            </span>
            <div className="flex items-center gap-4">
              <span className="text-[12px] text-[#86868b]">Impacto anual total:</span>
              <span className="text-[17px] font-bold font-mono text-[#34c759]">
                {formatCurrency(
                  filteredProposals
                    .filter((p) => p.status !== 'Descartada')
                    .reduce((sum, p) => sum + p.annualImpact, 0)
                )}
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="text-center py-20 bg-white border border-[#d2d2d7]/40 rounded-2xl shadow-sm animate-fade-in">
          <div className="w-14 h-14 rounded-2xl bg-[#f5f5f7] flex items-center justify-center mx-auto mb-4">
            <Plus className="text-[#c7c7cc]" size={24} />
          </div>
          <p className="text-[15px] font-medium text-[#1d1d1f] mb-1">
            {proposals.length === 0 ? 'Sin propuestas aún' : 'Sin resultados'}
          </p>
          <p className="text-[13px] text-[#86868b]">
            {proposals.length === 0
              ? 'Crea tu primera propuesta para comenzar'
              : 'Ajusta los filtros para ver propuestas'}
          </p>
        </div>
      )}
    </div>
  );
};

export default ProposalCreator;
