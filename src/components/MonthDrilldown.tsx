import React, { useEffect, useMemo, useRef } from 'react';
import { X, TrendingUp, TrendingDown, ChevronRight } from 'lucide-react';
import type { BankAccountStatement, AgedBalanceRecord } from '../services/jde';
import { fmtCurrency, fmtYearMonthLong } from '../formatters';
import { toYearMonth, compareYearMonth } from '../domain/cashFlowEngine';

interface MonthDrilldownProps {
  yearMonth: string | null;
  bankStatements: BankAccountStatement[];
  agedBalances: AgedBalanceRecord[];
  companyCode: string;
  baseline: { avgIncome: number; avgExpense: number };
  today: string;
  onClose: () => void;
}

interface ConceptRow {
  label: string;
  count: number;
  amount: number;
}

interface GroupedRows {
  top: ConceptRow[];
  rest: ConceptRow | null;
}

function topByAmount(rows: ConceptRow[], limit = 6): GroupedRows {
  const sorted = [...rows].sort((a, b) => b.amount - a.amount);
  if (sorted.length <= limit) return { top: sorted, rest: null };
  const top = sorted.slice(0, limit);
  const remaining = sorted.slice(limit);
  const rest: ConceptRow = {
    label: `Otros (${remaining.length})`,
    count: remaining.reduce((s, r) => s + r.count, 0),
    amount: remaining.reduce((s, r) => s + r.amount, 0),
  };
  return { top, rest };
}

/**
 * Detalle del mes seleccionado en el chart del Dashboard. Se renderiza
 * inline debajo del chart — nunca como modal ni con backdrop.
 *
 *   - Ingresos reales: movimientos ABONO del periodo, agrupados por concepto.
 *   - Egresos reales: movimientos CARGO del periodo, agrupados por concepto.
 *   - Ingresos proyectados: baseline (promedio móvil 6 meses) escalado por
 *     los días restantes del mes si es el mes actual, o total si es futuro.
 *   - Egresos proyectados: facturas programadas en /AntiguedadSaldos para el
 *     periodo, agrupadas por proveedor.
 */
const MonthDrilldown: React.FC<MonthDrilldownProps> = ({
  yearMonth, bankStatements, agedBalances, companyCode, baseline, today, onClose,
}) => {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!yearMonth) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [yearMonth, onClose]);

  // Scroll suave hacia el detalle cuando cambia el mes — el usuario acaba de
  // hacer clic en el chart arriba.
  useEffect(() => {
    if (!yearMonth || !ref.current) return;
    ref.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [yearMonth]);

  const data = useMemo(() => {
    if (!yearMonth) return null;
    return buildDrilldownData({
      yearMonth, bankStatements, agedBalances, companyCode, baseline, today,
    });
  }, [yearMonth, bankStatements, agedBalances, companyCode, baseline, today]);

  if (!yearMonth || !data) return null;

  const {
    phase, daysElapsed, daysInMonth,
    incomeReal, incomeProjected, incomeProjectedNote,
    expenseReal, expenseProjected, expenseProjectedNote,
  } = data;

  const phaseBadge =
    phase === 'past' ? { label: 'Histórico', color: 'var(--gray-500)', bg: 'var(--gray-100)' } :
    phase === 'current' ? { label: `En curso · día ${daysElapsed}/${daysInMonth}`, color: 'var(--primary)', bg: 'var(--primary-muted)' } :
    { label: 'Proyectado', color: 'var(--warning)', bg: 'var(--warning-muted)' };

  const incomeTotal = incomeReal.total + incomeProjected;
  const expenseTotal = expenseReal.total + expenseProjected.total;
  const netFlow = incomeTotal - expenseTotal;

  return (
    <section
      ref={ref}
      className="rounded-2xl border border-[var(--gray-200)] bg-white overflow-hidden animate-slide-down"
      aria-label={`Detalle del flujo de ${fmtYearMonthLong(yearMonth)}`}
    >
      {/* Header */}
      <header className="flex items-start justify-between gap-4 px-5 py-4 border-b border-[var(--gray-100)]">
        <div className="flex items-center gap-3 min-w-0">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-[16px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
                {fmtYearMonthLong(yearMonth)}
              </h3>
              <span
                className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full"
                style={{ background: phaseBadge.bg, color: phaseBadge.color }}
              >
                {phaseBadge.label}
              </span>
            </div>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--gray-400)' }}>
              Desglose del flujo del mes · real + proyectado
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-[var(--gray-400)] hover:bg-[var(--gray-100)] hover:text-[var(--gray-950)] transition-colors flex-shrink-0"
          aria-label="Cerrar detalle"
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      {/* Summary row */}
      <div className="grid grid-cols-3 divide-x divide-[var(--gray-100)] border-b border-[var(--gray-100)]">
        <SummaryCell label="Ingresos" value={incomeTotal} color="var(--success)" />
        <SummaryCell label="Egresos" value={expenseTotal} color="var(--danger)" />
        <SummaryCell
          label="Flujo neto"
          value={netFlow}
          color={netFlow >= 0 ? 'var(--success)' : 'var(--danger)'}
          showSign
        />
      </div>

      {/* Detail — two columns on wide, stacked on narrow */}
      <div className="grid grid-cols-1 lg:grid-cols-2">
        <Column
          title="Ingresos"
          icon={<TrendingUp className="w-4 h-4" />}
          accent="var(--success)"
          total={incomeTotal}
          realLabel={phase === 'past' ? 'Reales' : phase === 'current' ? `Real hasta día ${daysElapsed}` : 'Real'}
          projectedLabel={phase === 'past' ? 'Proyectado' : phase === 'current' ? 'Proyectado (resto del mes)' : 'Proyectado'}
          realTotal={incomeReal.total}
          projectedTotal={incomeProjected}
          realRows={topByAmount(incomeReal.rows)}
          projectedRows={{ top: [], rest: null }}
          projectedNote={incomeProjectedNote}
          emptyRealHint={phase === 'future' ? 'Aún no hay movimientos — el mes está en el futuro.' : 'No se registraron abonos en el periodo.'}
          borderRight
        />
        <Column
          title="Egresos"
          icon={<TrendingDown className="w-4 h-4" />}
          accent="var(--danger)"
          total={expenseTotal}
          realLabel={phase === 'past' ? 'Reales' : phase === 'current' ? `Real hasta día ${daysElapsed}` : 'Real'}
          projectedLabel={phase === 'past' ? 'Proyectado' : phase === 'current' ? 'Programado (resto del mes)' : 'Programado + baseline'}
          realTotal={expenseReal.total}
          projectedTotal={expenseProjected.total}
          realRows={topByAmount(expenseReal.rows)}
          projectedRows={topByAmount(expenseProjected.rows)}
          projectedNote={expenseProjectedNote}
          emptyRealHint={phase === 'future' ? 'Aún no hay movimientos — el mes está en el futuro.' : 'No se registraron cargos en el periodo.'}
        />
      </div>
    </section>
  );
};

const SummaryCell: React.FC<{ label: string; value: number; color: string; showSign?: boolean }> = ({
  label, value, color, showSign,
}) => (
  <div className="px-5 py-3">
    <p className="text-[10px] font-medium uppercase tracking-wider mb-0.5" style={{ color: 'var(--gray-400)' }}>
      {label}
    </p>
    <p className="text-[18px] font-semibold tabular-nums" style={{ color }}>
      {showSign && value > 0 ? '+' : ''}{fmtCurrency(value)}
    </p>
  </div>
);

interface ColumnProps {
  title: string;
  icon: React.ReactNode;
  accent: string;
  total: number;
  realLabel: string;
  projectedLabel: string;
  realTotal: number;
  projectedTotal: number;
  realRows: GroupedRows;
  projectedRows: GroupedRows;
  projectedNote?: string;
  emptyRealHint: string;
  borderRight?: boolean;
}

const Column: React.FC<ColumnProps> = ({
  title, icon, accent, realLabel, projectedLabel,
  realTotal, projectedTotal, realRows, projectedRows, projectedNote,
  emptyRealHint, borderRight,
}) => {
  const hasReal = realRows.top.length > 0 || realRows.rest !== null;
  const hasProjectedRows = projectedRows.top.length > 0 || projectedRows.rest !== null;
  const totalBoth = realTotal + projectedTotal;
  const realPct = totalBoth > 0 ? (realTotal / totalBoth) * 100 : 0;
  const projPct = totalBoth > 0 ? (projectedTotal / totalBoth) * 100 : 0;

  return (
    <div className={`p-5 ${borderRight ? 'lg:border-r lg:border-[var(--gray-100)]' : ''}`}>
      <div className="flex items-center gap-2 mb-3">
        <span style={{ color: accent }}>{icon}</span>
        <h4 className="text-[13px] font-semibold uppercase tracking-wider" style={{ color: 'var(--gray-700)' }}>
          {title}
        </h4>
      </div>

      {/* Barra proporcional real vs proyectado */}
      {totalBoth > 0 && (
        <div className="mb-4">
          <div className="flex h-2 rounded-full overflow-hidden" style={{ background: 'var(--gray-100)' }}>
            {realPct > 0 && (
              <div
                className="h-full"
                style={{ width: `${realPct}%`, background: accent }}
                aria-label={`Real: ${realPct.toFixed(0)}%`}
              />
            )}
            {projPct > 0 && (
              <div
                className="h-full"
                style={{
                  width: `${projPct}%`,
                  backgroundImage: `repeating-linear-gradient(45deg, ${accent} 0 3px, color-mix(in srgb, ${accent} 20%, white) 3px 7px)`,
                }}
                aria-label={`Proyectado: ${projPct.toFixed(0)}%`}
              />
            )}
          </div>
          <div className="flex items-center justify-between mt-1.5 text-[11px]">
            <span className="flex items-center gap-1.5" style={{ color: 'var(--gray-500)' }}>
              <Swatch accent={accent} />
              {realLabel}
              <span className="tabular-nums font-medium" style={{ color: 'var(--gray-950)' }}>{fmtCurrency(realTotal)}</span>
            </span>
            <span className="flex items-center gap-1.5" style={{ color: 'var(--gray-500)' }}>
              <Swatch accent={accent} striped />
              {projectedLabel}
              <span className="tabular-nums font-medium" style={{ color: 'var(--gray-950)' }}>{fmtCurrency(projectedTotal)}</span>
            </span>
          </div>
        </div>
      )}

      {/* Real rows */}
      <SubBlock
        label={realLabel}
        total={realTotal}
        accent={accent}
      >
        {hasReal ? (
          <RowList rows={realRows} />
        ) : (
          <p className="text-[12px]" style={{ color: 'var(--gray-400)' }}>{emptyRealHint}</p>
        )}
      </SubBlock>

      {/* Projected rows */}
      <SubBlock
        label={projectedLabel}
        total={projectedTotal}
        accent={accent}
        striped
      >
        {projectedNote && (
          <p className="text-[11px] mb-2 leading-snug" style={{ color: 'var(--gray-500)' }}>
            {projectedNote}
          </p>
        )}
        {hasProjectedRows && <RowList rows={projectedRows} />}
        {!hasProjectedRows && !projectedNote && (
          <p className="text-[12px]" style={{ color: 'var(--gray-400)' }}>
            Sin desglose — baseline histórico.
          </p>
        )}
      </SubBlock>
    </div>
  );
};

const Swatch: React.FC<{ accent: string; striped?: boolean }> = ({ accent, striped }) => (
  <span
    className="inline-block w-2.5 h-2.5 rounded-sm"
    style={striped
      ? {
          backgroundImage: `repeating-linear-gradient(45deg, ${accent} 0 2px, transparent 2px 5px)`,
          backgroundColor: `color-mix(in srgb, ${accent} 18%, white)`,
        }
      : { backgroundColor: accent }
    }
  />
);

const SubBlock: React.FC<{
  label: string;
  total: number;
  accent: string;
  striped?: boolean;
  children: React.ReactNode;
}> = ({ label, total, accent, striped, children }) => (
  <div className="mb-4 last:mb-0">
    <div className="flex items-center justify-between mb-1.5">
      <div className="flex items-center gap-2">
        <Swatch accent={accent} striped={striped} />
        <span className="text-[12px] font-semibold" style={{ color: 'var(--gray-700)' }}>{label}</span>
      </div>
      <span className="text-[12px] font-semibold tabular-nums" style={{ color: 'var(--gray-950)' }}>
        {fmtCurrency(total)}
      </span>
    </div>
    <div className="pl-4 border-l-2" style={{ borderColor: 'var(--gray-100)' }}>
      {children}
    </div>
  </div>
);

const RowList: React.FC<{ rows: GroupedRows }> = ({ rows }) => (
  <ul>
    {rows.top.map((r, idx) => (
      <li
        key={r.label}
        className="flex items-center justify-between gap-3 py-1.5 text-[12px]"
        style={{ borderTop: idx === 0 ? 'none' : '1px solid var(--gray-100)' }}
      >
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <ChevronRight className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--gray-300)' }} />
          <div className="min-w-0 flex-1">
            <p className="truncate" style={{ color: 'var(--gray-900)' }}>{r.label}</p>
            <p className="text-[10px]" style={{ color: 'var(--gray-400)' }}>
              {r.count} mov.
            </p>
          </div>
        </div>
        <span className="tabular-nums font-medium flex-shrink-0" style={{ color: 'var(--gray-950)' }}>
          {fmtCurrency(r.amount)}
        </span>
      </li>
    ))}
    {rows.rest && (
      <li
        className="flex items-center justify-between gap-3 py-1.5 text-[12px]"
        style={{ borderTop: rows.top.length > 0 ? '1px solid var(--gray-100)' : 'none' }}
      >
        <span className="pl-4" style={{ color: 'var(--gray-500)' }}>{rows.rest.label}</span>
        <span className="tabular-nums flex-shrink-0" style={{ color: 'var(--gray-700)' }}>
          {fmtCurrency(rows.rest.amount)}
        </span>
      </li>
    )}
  </ul>
);

// ── Lógica de armado del detalle ─────────────────────────────────────────

function buildDrilldownData(args: {
  yearMonth: string;
  bankStatements: BankAccountStatement[];
  agedBalances: AgedBalanceRecord[];
  companyCode: string;
  baseline: { avgIncome: number; avgExpense: number };
  today: string;
}) {
  const { yearMonth, bankStatements, agedBalances, companyCode, baseline, today } = args;
  const currentYm = toYearMonth(today);
  const cmp = compareYearMonth(yearMonth, currentYm);
  const phase: 'past' | 'current' | 'future' = cmp < 0 ? 'past' : cmp === 0 ? 'current' : 'future';

  const [yNum, mNum] = yearMonth.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(yNum, mNum, 0)).getUTCDate();
  const todayDate = new Date(today);
  const daysElapsed = phase === 'past' ? daysInMonth
    : phase === 'current' ? Math.min(daysInMonth, todayDate.getUTCDate())
    : 0;
  const daysRemaining = Math.max(0, daysInMonth - daysElapsed);

  const incomeByConcept = new Map<string, { count: number; amount: number }>();
  const expenseByConcept = new Map<string, { count: number; amount: number }>();
  const filteredBank = companyCode === 'all' || !companyCode
    ? bankStatements
    : bankStatements.filter((s) => s.cia === companyCode);
  for (const acc of filteredBank) {
    for (const mov of acc.movimientos) {
      if (toYearMonth(mov.fechaOperacion) !== yearMonth) continue;
      const bucket = mov.tipoMovimiento === 'ABONO' ? incomeByConcept
        : mov.tipoMovimiento === 'CARGO' ? expenseByConcept
        : null;
      if (!bucket) continue;
      const label = (mov.concepto || 'Sin concepto').trim() || 'Sin concepto';
      const prev = bucket.get(label) ?? { count: 0, amount: 0 };
      prev.count += 1;
      prev.amount += mov.importe;
      bucket.set(label, prev);
    }
  }
  const incomeReal = toRows(incomeByConcept);
  const expenseReal = toRows(expenseByConcept);

  const filteredAged = companyCode === 'all' || !companyCode
    ? agedBalances
    : agedBalances.filter((r) => r.cia === companyCode);
  const committedByProvider = new Map<string, { count: number; amount: number }>();
  let committedTotal = 0;
  let committedInRemainingDays = 0;
  for (const r of filteredAged) {
    if (toYearMonth(r.fechaProgramacionPago) !== yearMonth) continue;
    const label = (r.nombre || r.noProveedor || 'Proveedor s/n').trim();
    const prev = committedByProvider.get(label) ?? { count: 0, amount: 0 };
    prev.count += 1;
    prev.amount += r.importePendientePesos;
    committedByProvider.set(label, prev);
    committedTotal += r.importePendientePesos;
    if (phase === 'current') {
      const payDate = new Date(r.fechaProgramacionPago);
      if (payDate.getTime() >= todayDate.getTime()) {
        committedInRemainingDays += r.importePendientePesos;
      }
    }
  }
  const committedRows = toRows(committedByProvider);

  let incomeProjected = 0;
  let incomeProjectedNote: string | undefined;
  let expenseProjectedTotal = 0;
  let expenseProjectedNote: string | undefined;

  if (phase === 'past') {
    incomeProjected = 0;
    expenseProjectedTotal = 0;
  } else if (phase === 'current') {
    incomeProjected = Math.max(0, baseline.avgIncome - incomeReal.total);
    incomeProjectedNote = `Baseline del mes ≈ ${fmtCurrency(baseline.avgIncome)} (promedio 6 meses). Real al día ${daysElapsed}: ${fmtCurrency(incomeReal.total)} → faltaría ${fmtCurrency(incomeProjected)} para llegar al baseline.`;

    const baselineRemaining = baseline.avgExpense * (daysRemaining / Math.max(1, daysInMonth));
    const baselineGapToMonth = Math.max(0, baseline.avgExpense - expenseReal.total);
    expenseProjectedTotal = Math.max(committedInRemainingDays + baselineRemaining, baselineGapToMonth);
    const pieces: string[] = [];
    if (committedInRemainingDays > 0) {
      pieces.push(`programado restante ${fmtCurrency(committedInRemainingDays)}`);
    }
    if (baselineRemaining > 0) {
      pieces.push(`baseline prorrateado ${fmtCurrency(baselineRemaining)} (${daysRemaining} días)`);
    }
    expenseProjectedNote = pieces.length > 0
      ? `Resto del mes: ${pieces.join(' + ')}.`
      : undefined;
  } else {
    incomeProjected = baseline.avgIncome;
    incomeProjectedNote = `Promedio móvil 6 meses: ${fmtCurrency(baseline.avgIncome)}.`;
    expenseProjectedTotal = Math.max(committedTotal, baseline.avgExpense);
    const parts: string[] = [];
    if (committedTotal > 0) parts.push(`programado ${fmtCurrency(committedTotal)}`);
    parts.push(`baseline ${fmtCurrency(baseline.avgExpense)}`);
    expenseProjectedNote = `max(${parts.join(', ')}).`;
  }

  return {
    phase,
    daysElapsed,
    daysInMonth,
    incomeReal,
    incomeProjected,
    incomeProjectedNote,
    expenseReal,
    expenseProjected: { total: expenseProjectedTotal, rows: committedRows.rows },
    expenseProjectedNote,
  };

  function toRows(map: Map<string, { count: number; amount: number }>) {
    let total = 0;
    const rows: ConceptRow[] = [];
    for (const [label, v] of map) {
      total += v.amount;
      rows.push({ label, count: v.count, amount: v.amount });
    }
    return { total, rows };
  }
}

export default MonthDrilldown;
