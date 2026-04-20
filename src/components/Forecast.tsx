import { useMemo, useState, useEffect, useRef } from 'react';
import { FlowPlan, FlowConcept, MONTHS, ForecastOverride, overrideKey } from '../types';
import { ChevronDown, ChevronRight, Download, TrendingUp, TrendingDown, Wallet, MessageSquare, RotateCcw, X } from 'lucide-react';
import { toCSV, downloadFile } from '../utils/export';

/**
 * Pronóstico — vista tipo Fathom con celdas editables tipo Excel.
 *
 * Indicadores de celda:
 *   ⚪ base (sin cambios)
 *   🟡 override manual
 *   💬 tiene comentario
 *   Doble clic → editor inline
 *   Tooltip → valor base, override, comentario, botón restaurar
 */

type ForecastView = 'pnl' | 'cashflow' | 'drivers';

interface Props {
  plan: FlowPlan;
  view: ForecastView;
  overrides: ForecastOverride[];
  onOverridesChange: (next: ForecastOverride[]) => void;
}

interface RollingMonth {
  monthIndex: number;
  year: number;
  label: string;
  ym: string; // "2026-04"
}

function buildRollingWindow(): RollingMonth[] {
  const today = new Date();
  const startMonth = today.getMonth();
  const startYear = today.getFullYear();
  const out: RollingMonth[] = [];
  for (let i = 0; i < 12; i++) {
    const m = (startMonth + i) % 12;
    const y = startYear + Math.floor((startMonth + i) / 12);
    out.push({
      monthIndex: m,
      year: y,
      label: `${MONTHS[m]} ${String(y).slice(2)}`,
      ym: `${y}-${String(m + 1).padStart(2, '0')}`,
    });
  }
  return out;
}

function baseValue(concept: FlowConcept, month: RollingMonth, planYear: number): number {
  if (month.year !== planYear) return 0;
  return concept.monthlyData[month.monthIndex] ?? 0;
}

export default function Forecast({ plan, view, overrides, onOverridesChange }: Props) {
  const window = useMemo(() => buildRollingWindow(), []);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ conceptId: string; ym: string } | null>(null);
  const [popover, setPopover] = useState<{ conceptId: string; ym: string } | null>(null);

  const overridesMap = useMemo(() => {
    const m = new Map<string, ForecastOverride>();
    for (const o of overrides) m.set(o.key, o);
    return m;
  }, [overrides]);

  const valueFor = (c: FlowConcept, month: RollingMonth): number => {
    const k = overrideKey(c.id, month.ym);
    const ov = overridesMap.get(k);
    if (ov) return ov.overrideValue;
    return baseValue(c, month, plan.year);
  };

  const rowTotal = (c: FlowConcept): number =>
    window.reduce((s, m) => s + valueFor(c, m), 0);

  const toggle = (id: string) => {
    const next = new Set(expanded);
    next.has(id) ? next.delete(id) : next.add(id);
    setExpanded(next);
  };

  const applyOverride = (conceptId: string, month: RollingMonth, newValue: number, comment?: string) => {
    const k = overrideKey(conceptId, month.ym);
    const concept = plan.concepts.find(c => c.id === conceptId);
    if (!concept) return;
    const original = baseValue(concept, month, plan.year);
    if (newValue === original && !comment) {
      // revert
      onOverridesChange(overrides.filter(o => o.key !== k));
      return;
    }
    const existing = overridesMap.get(k);
    const next: ForecastOverride = {
      key: k,
      conceptId,
      yearMonth: month.ym,
      originalValue: existing?.originalValue ?? original,
      overrideValue: newValue,
      comment: comment ?? existing?.comment,
      editedAt: new Date().toISOString(),
    };
    onOverridesChange([...overrides.filter(o => o.key !== k), next]);
  };

  const restoreOverride = (k: string) => {
    onOverridesChange(overrides.filter(o => o.key !== k));
    setPopover(null);
  };

  const setComment = (conceptId: string, month: RollingMonth, comment: string) => {
    const k = overrideKey(conceptId, month.ym);
    const existing = overridesMap.get(k);
    const concept = plan.concepts.find(c => c.id === conceptId);
    if (!concept) return;
    if (!existing && !comment) return;
    if (existing) {
      const updated = { ...existing, comment: comment || undefined, editedAt: new Date().toISOString() };
      onOverridesChange([...overrides.filter(o => o.key !== k), updated]);
    } else {
      const original = baseValue(concept, month, plan.year);
      const next: ForecastOverride = {
        key: k, conceptId, yearMonth: month.ym,
        originalValue: original, overrideValue: original,
        comment, editedAt: new Date().toISOString(),
      };
      onOverridesChange([...overrides, next]);
    }
  };

  // Raíces por tipo
  const roots = plan.concepts.filter(c => !c.parentId);
  const ingresos = roots.filter(c => c.conceptType === 'ingreso');
  const egresos = roots.filter(c => c.conceptType === 'egreso');

  // Totales por mes (usan valueFor → incluye overrides)
  const sumFor = (cs: FlowConcept[], m: RollingMonth) => cs.reduce((s, c) => s + valueFor(c, m), 0);
  const ingresosPorMes = window.map(m => sumFor(ingresos, m));
  const egresosPorMes = window.map(m => sumFor(egresos, m));
  const netoPorMes = window.map((_, i) => ingresosPorMes[i] - egresosPorMes[i]);

  const cajaPorMes: number[] = [];
  let saldo = plan.cajaInicial;
  for (const n of netoPorMes) { saldo += n; cajaPorMes.push(saldo); }

  const totalIngresos = ingresosPorMes.reduce((a, b) => a + b, 0);
  const totalEgresos = egresosPorMes.reduce((a, b) => a + b, 0);
  const totalNeto = totalIngresos - totalEgresos;

  const handleExport = () => {
    const rows: Record<string, string | number>[] = [];
    const pushRow = (label: string, vals: number[]) => {
      const row: Record<string, string | number> = { Concepto: label };
      window.forEach((m, i) => { row[m.label] = vals[i]; });
      row['Total'] = vals.reduce((a, b) => a + b, 0);
      rows.push(row);
    };
    if (view === 'pnl') {
      pushRow('Ingresos', ingresosPorMes);
      pushRow('Egresos', egresosPorMes);
      pushRow('Utilidad Neta', netoPorMes);
    } else if (view === 'cashflow') {
      pushRow('Entradas', ingresosPorMes);
      pushRow('Salidas', egresosPorMes);
      pushRow('Flujo Neto', netoPorMes);
      pushRow('Caja al cierre', cajaPorMes);
    }
    downloadFile(toCSV(rows), `${view}-${new Date().toISOString().slice(0, 10)}.csv`);
  };

  const overrideCount = overrides.length;
  const commentCount = overrides.filter(o => o.comment).length;

  const clearAllOverrides = () => {
    if (confirm(`¿Restaurar las ${overrideCount} celdas editadas a su valor original?`)) {
      onOverridesChange([]);
    }
  };

  return (
    <div className="space-y-5" onClick={() => setPopover(null)}>
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[#1d1d1f] tracking-tight">
            {view === 'pnl' && 'Estado de Resultados'}
            {view === 'cashflow' && 'Flujo de Caja'}
            {view === 'drivers' && 'Drivers'}
          </h1>
          <p className="text-[13px] text-[#86868b] mt-1">
            Ventana mensual rodante · 12 meses desde {window[0].label} · doble clic en celda para editar
          </p>
        </div>
        <div className="flex items-center gap-2">
          {overrideCount > 0 && (
            <button
              onClick={clearAllOverrides}
              className="flex items-center gap-1.5 px-3 h-8 rounded-lg border border-[#ff9500]/40 bg-[#ff9500]/10 text-[13px] text-[#ff9500] hover:bg-[#ff9500]/20"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Restaurar {overrideCount}
            </button>
          )}
          <button
            onClick={handleExport}
            className="flex items-center gap-1.5 px-3 h-8 rounded-lg border border-[#d2d2d7] text-[13px] text-[#86868b] hover:text-[#1d1d1f] hover:bg-[#f5f5f7]"
          >
            <Download className="w-3.5 h-3.5" /> Exportar
          </button>
        </div>
      </header>

      {/* Legend */}
      <div className="flex items-center gap-4 text-[12px] text-[#86868b]">
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#d2d2d7]" /> Base</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#ff9500]" /> Editada manualmente {overrideCount > 0 && <span className="text-[#ff9500] font-medium">({overrideCount})</span>}</span>
        <span className="flex items-center gap-1.5"><MessageSquare className="w-3 h-3 text-[#0071e3]" /> Con comentario {commentCount > 0 && <span className="text-[#0071e3] font-medium">({commentCount})</span>}</span>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-4 gap-4">
        <Kpi label="Ingresos (12m)" value={totalIngresos} tone="pos" icon={TrendingUp} />
        <Kpi label="Egresos (12m)" value={totalEgresos} tone="neg" icon={TrendingDown} />
        <Kpi label="Utilidad Neta" value={totalNeto} tone={totalNeto >= 0 ? 'pos' : 'neg'} />
        <Kpi label="Caja al final" value={cajaPorMes[cajaPorMes.length - 1] ?? plan.cajaInicial} tone="cash" icon={Wallet} />
      </div>

      {/* Main table */}
      <div className="bg-white border border-[#d2d2d7]/60 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="bg-[#fbfbfd] text-[11px] uppercase tracking-wide text-[#86868b] border-b border-[#d2d2d7]/40">
              <tr>
                <th className="text-left px-4 py-2.5 sticky left-0 bg-[#fbfbfd] min-w-[220px] font-medium">Concepto</th>
                {window.map(m => (
                  <th key={m.ym} className="text-right px-3 py-2.5 font-medium whitespace-nowrap min-w-[100px]">{m.label}</th>
                ))}
                <th className="text-right px-4 py-2.5 font-medium bg-[#f5f5f7]">Total</th>
              </tr>
            </thead>
            <tbody>
              {view === 'drivers' ? (
                <DriversBody
                  concepts={plan.concepts}
                  window={window}
                  valueFor={valueFor}
                  rowTotal={rowTotal}
                  overridesMap={overridesMap}
                  expanded={expanded}
                  toggle={toggle}
                  editing={editing}
                  setEditing={setEditing}
                  popover={popover}
                  setPopover={setPopover}
                  applyOverride={applyOverride}
                  restoreOverride={restoreOverride}
                  setComment={setComment}
                  plan={plan}
                />
              ) : (
                <>
                  <CategoryBlock
                    label={view === 'pnl' ? 'Ingresos' : 'Entradas'}
                    tone="pos"
                    roots={ingresos}
                    totals={ingresosPorMes}
                    window={window}
                    valueFor={valueFor}
                    rowTotal={rowTotal}
                    overridesMap={overridesMap}
                    expanded={expanded}
                    toggle={toggle}
                    editing={editing}
                    setEditing={setEditing}
                    popover={popover}
                    setPopover={setPopover}
                    applyOverride={applyOverride}
                    restoreOverride={restoreOverride}
                    setComment={setComment}
                    plan={plan}
                  />
                  <CategoryBlock
                    label={view === 'pnl' ? 'Egresos' : 'Salidas'}
                    tone="neg"
                    roots={egresos}
                    totals={egresosPorMes}
                    window={window}
                    valueFor={valueFor}
                    rowTotal={rowTotal}
                    overridesMap={overridesMap}
                    expanded={expanded}
                    toggle={toggle}
                    editing={editing}
                    setEditing={setEditing}
                    popover={popover}
                    setPopover={setPopover}
                    applyOverride={applyOverride}
                    restoreOverride={restoreOverride}
                    setComment={setComment}
                    plan={plan}
                  />
                  <TotalRow
                    label={view === 'pnl' ? 'Utilidad Neta' : 'Flujo Neto'}
                    values={netoPorMes}
                    emphasis
                  />
                </>
              )}
            </tbody>
            {view === 'cashflow' && (
              <tfoot className="border-t-2 border-[#1d1d1f]/10 bg-[#fbfbfd]">
                <tr>
                  <td className="px-4 py-2.5 font-semibold text-[#1d1d1f] sticky left-0 bg-[#fbfbfd]">Caja inicial</td>
                  {window.map((_, i) => (
                    <td key={i} className="px-3 py-2.5 text-right tabular-nums text-[#86868b]">
                      {i === 0 ? fmt(plan.cajaInicial) : fmt(cajaPorMes[i - 1])}
                    </td>
                  ))}
                  <td className="px-4 py-2.5 text-right tabular-nums text-[#86868b] bg-[#f5f5f7]">{fmt(plan.cajaInicial)}</td>
                </tr>
                <tr>
                  <td className="px-4 py-2.5 font-semibold text-[#1d1d1f] sticky left-0 bg-[#fbfbfd]">Caja al cierre</td>
                  {cajaPorMes.map((v, i) => (
                    <td key={i} className={`px-3 py-2.5 text-right tabular-nums font-semibold ${v < 0 ? 'text-[#ff3b30]' : 'text-[#1d1d1f]'}`}>
                      {fmt(v)}
                    </td>
                  ))}
                  <td className={`px-4 py-2.5 text-right tabular-nums font-semibold bg-[#f5f5f7] ${cajaPorMes[cajaPorMes.length - 1] < 0 ? 'text-[#ff3b30]' : 'text-[#1d1d1f]'}`}>
                    {fmt(cajaPorMes[cajaPorMes.length - 1] ?? 0)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {plan.concepts.length === 0 && (
        <div className="text-center py-10 text-[13px] text-[#86868b]">
          No hay conceptos cargados en el FlowPlan.
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────

interface RowCtx {
  window: RollingMonth[];
  valueFor: (c: FlowConcept, m: RollingMonth) => number;
  rowTotal: (c: FlowConcept) => number;
  overridesMap: Map<string, ForecastOverride>;
  expanded: Set<string>;
  toggle: (id: string) => void;
  editing: { conceptId: string; ym: string } | null;
  setEditing: (e: { conceptId: string; ym: string } | null) => void;
  popover: { conceptId: string; ym: string } | null;
  setPopover: (p: { conceptId: string; ym: string } | null) => void;
  applyOverride: (conceptId: string, month: RollingMonth, newValue: number, comment?: string) => void;
  restoreOverride: (k: string) => void;
  setComment: (conceptId: string, month: RollingMonth, comment: string) => void;
  plan: FlowPlan;
}

function CategoryBlock({
  label, tone, roots, totals, ...ctx
}: RowCtx & {
  label: string;
  tone: 'pos' | 'neg';
  roots: FlowConcept[];
  totals: number[];
}) {
  const total = totals.reduce((a, b) => a + b, 0);
  const toneCls = tone === 'pos' ? 'text-[#34c759]' : 'text-[#ff3b30]';
  return (
    <>
      <tr className="bg-[#fbfbfd]/60 border-t border-[#d2d2d7]/40">
        <td className="px-4 py-2 text-[11px] uppercase tracking-wide text-[#86868b] font-semibold sticky left-0 bg-[#fbfbfd]/60">{label}</td>
        {ctx.window.map((_, i) => <td key={i} />)}
        <td className="bg-[#f5f5f7]" />
      </tr>
      {roots.map(c => (
        <ConceptRow key={c.id} concept={c} depth={0} {...ctx} />
      ))}
      <tr className="border-t border-[#d2d2d7]/40">
        <td className={`px-4 py-2.5 font-semibold sticky left-0 bg-white ${toneCls}`}>Total {label}</td>
        {totals.map((v, i) => (
          <td key={i} className={`px-3 py-2.5 text-right tabular-nums font-semibold ${toneCls}`}>{fmt(v)}</td>
        ))}
        <td className={`px-4 py-2.5 text-right tabular-nums font-semibold bg-[#f5f5f7] ${toneCls}`}>{fmt(total)}</td>
      </tr>
    </>
  );
}

function ConceptRow({
  concept, depth, ...ctx
}: RowCtx & { concept: FlowConcept; depth: number }) {
  const hasChildren = (concept.children?.length ?? 0) > 0;
  const isOpen = ctx.expanded.has(concept.id);
  const total = ctx.rowTotal(concept);

  return (
    <>
      <tr className="border-t border-[#d2d2d7]/30 hover:bg-[#f5f5f7]/60">
        <td className="px-4 py-2 sticky left-0 bg-white" style={{ paddingLeft: 16 + depth * 16 }}>
          <div className="flex items-center gap-1.5">
            {hasChildren ? (
              <button onClick={() => ctx.toggle(concept.id)} className="p-0.5 rounded hover:bg-[#e8e8ed]">
                {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-[#86868b]" /> : <ChevronRight className="w-3.5 h-3.5 text-[#86868b]" />}
              </button>
            ) : <span className="w-4" />}
            <span className="text-[#1d1d1f]">{concept.name}</span>
          </div>
        </td>
        {ctx.window.map(m => (
          <EditableCell key={m.ym} concept={concept} month={m} {...ctx} />
        ))}
        <td className="px-4 py-2 text-right tabular-nums font-medium bg-[#f5f5f7]">{fmt(total)}</td>
      </tr>
      {isOpen && concept.children?.map(child => (
        <ConceptRow key={child.id} concept={child} depth={depth + 1} {...ctx} />
      ))}
    </>
  );
}

function EditableCell({
  concept, month, valueFor, overridesMap, editing, setEditing, popover, setPopover,
  applyOverride, restoreOverride, setComment, plan,
}: RowCtx & { concept: FlowConcept; month: RollingMonth }) {
  const k = overrideKey(concept.id, month.ym);
  const ov = overridesMap.get(k);
  const v = valueFor(concept, month);
  const isEditing = editing?.conceptId === concept.id && editing?.ym === month.ym;
  const isPopoverOpen = popover?.conceptId === concept.id && popover?.ym === month.ym;
  const isOverridden = !!ov && ov.overrideValue !== ov.originalValue;
  const hasComment = !!ov?.comment;

  const [draft, setDraft] = useState<string>(String(v));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      setDraft(String(v));
      setTimeout(() => inputRef.current?.select(), 0);
    }
  }, [isEditing]);

  const commit = () => {
    const cleaned = draft.replace(/[^0-9.\-]/g, '');
    const n = Number(cleaned);
    if (!isNaN(n)) applyOverride(concept.id, month, n);
    setEditing(null);
  };

  const cellBg = isOverridden ? 'bg-[#ff9500]/8' : '';
  const cellText = isOverridden ? 'text-[#ff9500] font-semibold' : 'text-[#1d1d1f]';

  return (
    <td
      className={`px-3 py-2 text-right tabular-nums relative cursor-cell group ${cellBg} ${cellText}`}
      onDoubleClick={(e) => { e.stopPropagation(); setEditing({ conceptId: concept.id, ym: month.ym }); }}
      onClick={(e) => {
        e.stopPropagation();
        if (!isEditing) setPopover(isPopoverOpen ? null : { conceptId: concept.id, ym: month.ym });
      }}
    >
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') setEditing(null);
          }}
          className="w-full text-right tabular-nums bg-white border border-[#0071e3] rounded px-1 py-0.5 outline-none"
        />
      ) : (
        <>
          <span className="inline-flex items-center gap-1 justify-end">
            {isOverridden && <span className="w-1.5 h-1.5 rounded-full bg-[#ff9500] flex-shrink-0" />}
            {hasComment && <MessageSquare className="w-3 h-3 text-[#0071e3] flex-shrink-0" />}
            <span>{v === 0 ? <span className="text-[#d2d2d7]">—</span> : fmt(v)}</span>
          </span>
          {isPopoverOpen && (
            <CellPopover
              concept={concept}
              month={month}
              ov={ov}
              plan={plan}
              onClose={() => setPopover(null)}
              onEdit={() => { setPopover(null); setEditing({ conceptId: concept.id, ym: month.ym }); }}
              onRestore={() => ov && restoreOverride(k)}
              onSetComment={(c) => setComment(concept.id, month, c)}
            />
          )}
        </>
      )}
    </td>
  );
}

function CellPopover({
  concept, month, ov, plan, onClose, onEdit, onRestore, onSetComment,
}: {
  concept: FlowConcept;
  month: RollingMonth;
  ov: ForecastOverride | undefined;
  plan: FlowPlan;
  onClose: () => void;
  onEdit: () => void;
  onRestore: () => void;
  onSetComment: (c: string) => void;
}) {
  const [commentDraft, setCommentDraft] = useState(ov?.comment ?? '');
  const originalValue = ov?.originalValue ?? baseValue(concept, month, plan.year);
  const currentValue = ov?.overrideValue ?? originalValue;
  const isOverridden = !!ov && ov.overrideValue !== ov.originalValue;
  const delta = currentValue - originalValue;

  return (
    <div
      className="absolute right-0 top-full mt-1 z-50 w-72 bg-white border border-[#d2d2d7] rounded-xl shadow-xl p-3 text-left"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[#86868b]">{month.label}</div>
          <div className="text-[13px] font-medium text-[#1d1d1f] truncate">{concept.name}</div>
        </div>
        <button onClick={onClose} className="text-[#86868b] hover:text-[#1d1d1f]"><X className="w-4 h-4" /></button>
      </div>

      <div className="space-y-1.5 mb-3 text-[12px]">
        <div className="flex justify-between">
          <span className="text-[#86868b]">Valor base</span>
          <span className="tabular-nums text-[#1d1d1f]">{fmt(originalValue)}</span>
        </div>
        {isOverridden && (
          <>
            <div className="flex justify-between">
              <span className="text-[#ff9500]">Valor editado</span>
              <span className="tabular-nums font-semibold text-[#ff9500]">{fmt(currentValue)}</span>
            </div>
            <div className="flex justify-between pt-1 border-t border-[#d2d2d7]/40">
              <span className="text-[#86868b]">Δ</span>
              <span className={`tabular-nums font-medium ${delta >= 0 ? 'text-[#34c759]' : 'text-[#ff3b30]'}`}>
                {delta >= 0 ? '+' : ''}{fmt(delta)}
              </span>
            </div>
          </>
        )}
      </div>

      <div className="mb-3">
        <label className="text-[11px] uppercase tracking-wide text-[#86868b] mb-1 block">Comentario</label>
        <textarea
          value={commentDraft}
          onChange={e => setCommentDraft(e.target.value)}
          onBlur={() => onSetComment(commentDraft)}
          placeholder="Nota o explicación…"
          rows={2}
          className="w-full text-[12px] border border-[#d2d2d7] rounded-lg px-2 py-1.5 outline-none focus:border-[#0071e3] resize-none"
        />
      </div>

      <div className="flex gap-2">
        <button
          onClick={onEdit}
          className="flex-1 h-7 rounded-lg bg-[#0071e3] text-white text-[12px] font-medium hover:bg-[#0077ed]"
        >
          Editar valor
        </button>
        {isOverridden && (
          <button
            onClick={onRestore}
            className="flex items-center gap-1 h-7 px-2 rounded-lg border border-[#d2d2d7] text-[12px] text-[#86868b] hover:text-[#ff9500] hover:border-[#ff9500]"
          >
            <RotateCcw className="w-3 h-3" /> Restaurar
          </button>
        )}
      </div>

      {ov?.editedAt && (
        <div className="text-[10px] text-[#86868b] mt-2 text-right">
          Editado {new Date(ov.editedAt).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
        </div>
      )}
    </div>
  );
}

function DriversBody({ concepts, ...ctx }: RowCtx & { concepts: FlowConcept[] }) {
  const roots = concepts.filter(c => !c.parentId);
  return <>{roots.map(c => <ConceptRow key={c.id} concept={c} depth={0} {...ctx} />)}</>;
}

function TotalRow({ label, values, emphasis }: { label: string; values: number[]; emphasis?: boolean }) {
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <tr className={`border-t-2 border-[#1d1d1f]/10 ${emphasis ? 'bg-[#fbfbfd]' : ''}`}>
      <td className="px-4 py-3 font-semibold text-[#1d1d1f] sticky left-0 bg-[#fbfbfd]">{label}</td>
      {values.map((v, i) => (
        <td key={i} className={`px-3 py-3 text-right tabular-nums font-semibold ${v < 0 ? 'text-[#ff3b30]' : 'text-[#1d1d1f]'}`}>{fmt(v)}</td>
      ))}
      <td className={`px-4 py-3 text-right tabular-nums font-semibold bg-[#f5f5f7] ${total < 0 ? 'text-[#ff3b30]' : 'text-[#1d1d1f]'}`}>{fmt(total)}</td>
    </tr>
  );
}

function Kpi({ label, value, tone, icon: Icon }: {
  label: string;
  value: number;
  tone: 'pos' | 'neg' | 'cash';
  icon?: React.ComponentType<{ className?: string }>;
}) {
  const color =
    tone === 'pos' ? 'text-[#34c759]' :
    tone === 'neg' ? 'text-[#ff3b30]' :
    'text-[#0071e3]';
  return (
    <div className="bg-white border border-[#d2d2d7]/60 rounded-xl p-4">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wide text-[#86868b]">{label}</div>
        {Icon && <Icon className={`w-4 h-4 ${color}`} />}
      </div>
      <div className={`text-2xl font-semibold tabular-nums mt-1 ${color}`}>{fmt(value)}</div>
    </div>
  );
}

function fmt(n: number): string {
  return n.toLocaleString('es-MX', { maximumFractionDigits: 0 });
}
