import { useMemo, useState } from 'react';
import { FlowPlan, FlowConcept, MONTHS } from '../types';
import { ChevronDown, ChevronRight, Download, TrendingUp, TrendingDown, Wallet } from 'lucide-react';
import { toCSV, downloadFile } from '../utils/export';

/**
 * Pronóstico — vista tipo Fathom.
 *
 * Tres sub-vistas:
 *   P&L        → Ingresos, Egresos, Utilidad Neta
 *   Flujo      → Entradas, Salidas, Flujo Neto, Caja al cierre
 *   Drivers    → Conceptos planos con sus datos mensuales
 *
 * Ventana: rolling 12 meses desde el mes actual.
 */

type ForecastView = 'pnl' | 'cashflow' | 'drivers';

interface Props {
  plan: FlowPlan;
  view: ForecastView;
}

interface RollingMonth {
  monthIndex: number; // 0..11 inside plan.year
  year: number;
  label: string;      // "Abr 26"
}

function buildRollingWindow(planYear: number): RollingMonth[] {
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
    });
  }
  // Si el plan es del año actual o siguiente, los valores de plan.monthlyData[m]
  // se usarán cuando y === planYear.
  void planYear;
  return out;
}

function valueFor(concept: FlowConcept, month: RollingMonth, planYear: number): number {
  if (month.year !== planYear) return 0;
  return concept.monthlyData[month.monthIndex] ?? 0;
}

function rowTotal(concept: FlowConcept, window: RollingMonth[], planYear: number): number {
  return window.reduce((s, m) => s + valueFor(concept, m, planYear), 0);
}

export default function Forecast({ plan, view }: Props) {
  const window = useMemo(() => buildRollingWindow(plan.year), [plan.year]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    const next = new Set(expanded);
    next.has(id) ? next.delete(id) : next.add(id);
    setExpanded(next);
  };

  // Raíces por tipo (sin parentId)
  const roots = plan.concepts.filter(c => !c.parentId);
  const ingresos = roots.filter(c => c.conceptType === 'ingreso');
  const egresos = roots.filter(c => c.conceptType === 'egreso');

  // Totales por mes
  const ingresosPorMes = window.map(m =>
    ingresos.reduce((s, c) => s + valueFor(c, m, plan.year), 0));
  const egresosPorMes = window.map(m =>
    egresos.reduce((s, c) => s + valueFor(c, m, plan.year), 0));
  const netoPorMes = window.map((_, i) => ingresosPorMes[i] - egresosPorMes[i]);

  // Caja rodante
  const cajaPorMes: number[] = [];
  let saldo = plan.cajaInicial;
  for (const n of netoPorMes) {
    saldo += n;
    cajaPorMes.push(saldo);
  }

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

  // ── Render ──
  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[#1d1d1f] tracking-tight">
            {view === 'pnl' && 'Estado de Resultados'}
            {view === 'cashflow' && 'Flujo de Caja'}
            {view === 'drivers' && 'Drivers'}
          </h1>
          <p className="text-[13px] text-[#86868b] mt-1">
            Ventana mensual rodante · 12 meses desde {window[0].label}
          </p>
        </div>
        <button
          onClick={handleExport}
          className="flex items-center gap-1.5 px-3 h-8 rounded-lg border border-[#d2d2d7] text-[13px] text-[#86868b] hover:text-[#1d1d1f] hover:bg-[#f5f5f7]"
        >
          <Download className="w-3.5 h-3.5" /> Exportar
        </button>
      </header>

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
                  <th key={m.label} className="text-right px-3 py-2.5 font-medium whitespace-nowrap">{m.label}</th>
                ))}
                <th className="text-right px-4 py-2.5 font-medium bg-[#f5f5f7]">Total</th>
              </tr>
            </thead>
            <tbody>
              {view === 'drivers' ? (
                <DriversBody concepts={plan.concepts} window={window} planYear={plan.year} expanded={expanded} toggle={toggle} />
              ) : (
                <>
                  <CategoryBlock
                    label={view === 'pnl' ? 'Ingresos' : 'Entradas'}
                    tone="pos"
                    roots={ingresos}
                    totals={ingresosPorMes}
                    window={window}
                    planYear={plan.year}
                    expanded={expanded}
                    toggle={toggle}
                  />
                  <CategoryBlock
                    label={view === 'pnl' ? 'Egresos' : 'Salidas'}
                    tone="neg"
                    roots={egresos}
                    totals={egresosPorMes}
                    window={window}
                    planYear={plan.year}
                    expanded={expanded}
                    toggle={toggle}
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
                  {window.map((m, i) => (
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

function CategoryBlock({
  label, tone, roots, totals, window, planYear, expanded, toggle,
}: {
  label: string;
  tone: 'pos' | 'neg';
  roots: FlowConcept[];
  totals: number[];
  window: RollingMonth[];
  planYear: number;
  expanded: Set<string>;
  toggle: (id: string) => void;
}) {
  const total = totals.reduce((a, b) => a + b, 0);
  const toneCls = tone === 'pos' ? 'text-[#34c759]' : 'text-[#ff3b30]';

  return (
    <>
      <tr className="bg-[#fbfbfd]/60 border-t border-[#d2d2d7]/40">
        <td className="px-4 py-2 text-[11px] uppercase tracking-wide text-[#86868b] font-semibold sticky left-0 bg-[#fbfbfd]/60">{label}</td>
        {window.map((_, i) => <td key={i} />)}
        <td className="bg-[#f5f5f7]" />
      </tr>
      {roots.map(c => (
        <ConceptRow
          key={c.id}
          concept={c}
          window={window}
          planYear={planYear}
          expanded={expanded}
          toggle={toggle}
          depth={0}
        />
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
  concept, window, planYear, expanded, toggle, depth,
}: {
  concept: FlowConcept;
  window: RollingMonth[];
  planYear: number;
  expanded: Set<string>;
  toggle: (id: string) => void;
  depth: number;
}) {
  const hasChildren = (concept.children?.length ?? 0) > 0;
  const isOpen = expanded.has(concept.id);
  const total = rowTotal(concept, window, planYear);

  return (
    <>
      <tr className="border-t border-[#d2d2d7]/30 hover:bg-[#f5f5f7]/60">
        <td className="px-4 py-2 sticky left-0 bg-white" style={{ paddingLeft: 16 + depth * 16 }}>
          <div className="flex items-center gap-1.5">
            {hasChildren ? (
              <button onClick={() => toggle(concept.id)} className="p-0.5 rounded hover:bg-[#e8e8ed]">
                {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-[#86868b]" /> : <ChevronRight className="w-3.5 h-3.5 text-[#86868b]" />}
              </button>
            ) : <span className="w-4" />}
            <span className="text-[#1d1d1f]">{concept.name}</span>
          </div>
        </td>
        {window.map((m, i) => {
          const v = valueFor(concept, m, planYear);
          return (
            <td key={i} className="px-3 py-2 text-right tabular-nums text-[#1d1d1f]">
              {v === 0 ? <span className="text-[#d2d2d7]">—</span> : fmt(v)}
            </td>
          );
        })}
        <td className="px-4 py-2 text-right tabular-nums font-medium bg-[#f5f5f7]">{fmt(total)}</td>
      </tr>
      {isOpen && concept.children?.map(child => (
        <ConceptRow
          key={child.id}
          concept={child}
          window={window}
          planYear={planYear}
          expanded={expanded}
          toggle={toggle}
          depth={depth + 1}
        />
      ))}
    </>
  );
}

function DriversBody({
  concepts, window, planYear, expanded, toggle,
}: {
  concepts: FlowConcept[];
  window: RollingMonth[];
  planYear: number;
  expanded: Set<string>;
  toggle: (id: string) => void;
}) {
  const roots = concepts.filter(c => !c.parentId);
  return (
    <>
      {roots.map(c => (
        <ConceptRow
          key={c.id}
          concept={c}
          window={window}
          planYear={planYear}
          expanded={expanded}
          toggle={toggle}
          depth={0}
        />
      ))}
    </>
  );
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
