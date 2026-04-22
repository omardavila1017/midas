import React, { useEffect, useMemo, useRef } from 'react';
import { X, TrendingUp, TrendingDown, ChevronRight } from 'lucide-react';
import type { BankAccountStatement, AgedBalanceRecord } from '../services/jde';
import { fmtCurrency, fmtYearMonthLong } from '../formatters';
import { toYearMonth, compareYearMonth } from '../domain/cashFlowEngine';
import type { MonthlyProjection, ProjectionOverrides } from '../domain/projectionEngine';
import CashFlowTable, { type CashFlowTableRow } from './CashFlowTable';

interface MonthDrilldownProps {
  yearMonth: string | null;
  bankStatements: BankAccountStatement[];
  agedBalances: AgedBalanceRecord[];
  companyCode: string;
  baseline: { avgIncome: number; avgExpense: number };
  projectionByMonth: Map<string, MonthlyProjection>;
  overrides: ProjectionOverrides;
  onOverridesChange: (overrides: ProjectionOverrides) => void;
  tableRows: CashFlowTableRow[];
  today: string;
  onClose: () => void;
}

interface ConceptRow {
  label: string;
  count: number;
  amount: number;
  /** Etiqueta de flexibilidad cuando el row viene de un proveedor del catálogo. */
  flexibility?: 'inamovible' | 'flexible' | 'revisar' | 'unknown';
  /** Día de crédito (paymentPeriod) del proveedor, si está clasificado. */
  paymentPeriod?: string;
  /** Fuente del número: scheduled (CXP), recurring (banco), mixed. */
  source?: 'scheduled' | 'recurring' | 'mixed' | 'real';
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
  yearMonth, bankStatements, agedBalances, companyCode, baseline,
  projectionByMonth, overrides, onOverridesChange, tableRows,
  today, onClose,
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
      yearMonth, bankStatements, agedBalances, companyCode, baseline,
      projection: projectionByMonth.get(yearMonth) ?? null,
      override: overrides[yearMonth],
      today,
    });
  }, [yearMonth, bankStatements, agedBalances, companyCode, baseline, projectionByMonth, overrides, today]);

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

      {/* Tabla editable del flujo — contexto de ±3 meses alrededor del mes
          seleccionado. Sin encabezado duplicado: la tabla principal arriba
          ya explica el propósito. */}
      <div className="border-t border-[var(--gray-100)] px-5 py-4 bg-[var(--gray-50)]/40">
        <CashFlowTable
          rows={tableRows}
          overrides={overrides}
          onOverridesChange={onOverridesChange}
          compact
          filter={(r) => Math.abs(monthsDistance(r.yearMonth, yearMonth)) <= 3}
          highlightYearMonth={yearMonth}
        />
      </div>
    </section>
  );
};

/** Devuelve la diferencia en meses entre dos "YYYY-MM" (firmada). */
function monthsDistance(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (ay - by) * 12 + (am - bm);
}

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

const FlexChip: React.FC<{ flexibility?: ConceptRow['flexibility'] }> = ({ flexibility }) => {
  if (!flexibility || flexibility === 'unknown') return null;
  const styles: Record<string, { bg: string; fg: string; label: string }> = {
    inamovible: { bg: 'var(--danger-muted)', fg: 'var(--danger)', label: 'Inamovible' },
    flexible:   { bg: 'var(--success-muted)', fg: 'var(--success)', label: 'Flexible' },
    revisar:    { bg: 'var(--warning-muted)', fg: 'var(--warning)', label: 'Revisar' },
  };
  const s = styles[flexibility];
  if (!s) return null;
  return (
    <span
      className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full"
      style={{ background: s.bg, color: s.fg }}
    >
      {s.label}
    </span>
  );
};

const SourceChip: React.FC<{ source?: ConceptRow['source'] }> = ({ source }) => {
  if (!source) return null;
  const labels: Record<string, string> = {
    scheduled: 'CXP',
    recurring: 'Recurrente',
    mixed: 'CXP + recurrente',
  };
  const l = labels[source];
  if (!l) return null;
  return (
    <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full border border-[var(--gray-200)]" style={{ color: 'var(--gray-500)' }}>
      {l}
    </span>
  );
};

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
            <div className="flex items-center gap-1.5 min-w-0">
              <p className="truncate" style={{ color: 'var(--gray-900)' }}>{r.label}</p>
              <FlexChip flexibility={r.flexibility} />
              <SourceChip source={r.source} />
            </div>
            <p className="text-[10px]" style={{ color: 'var(--gray-400)' }}>
              {r.paymentPeriod
                ? `Crédito ${r.paymentPeriod}${r.count > 1 ? ` · ${r.count} mov.` : ''}`
                : `${r.count} mov.`}
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
  projection: MonthlyProjection | null;
  override?: { income?: number; expense?: number };
  today: string;
}) {
  const { yearMonth, bankStatements, agedBalances, companyCode, baseline, projection, override, today } = args;
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

  // Proyección "total" del mes: override del usuario > engine de proyección >
  // baseline MA6. El drilldown muestra el total y, si es el mes en curso,
  // el gap contra lo real.
  const incomeTotalProjected = override?.income
    ?? projection?.income.total
    ?? baseline.avgIncome;
  const expenseTotalProjected = override?.expense
    ?? projection?.expense.total
    ?? baseline.avgExpense;

  if (phase === 'past') {
    incomeProjected = 0;
    expenseProjectedTotal = 0;
  } else if (phase === 'current') {
    incomeProjected = Math.max(0, incomeTotalProjected - incomeReal.total);
    const incomeSource = override?.income !== undefined
      ? `Ajuste manual: ${fmtCurrency(incomeTotalProjected)}`
      : projection && projection.income.source === 'clients'
        ? `Cobranza de clientes: ${fmtCurrency(projection.income.fromClients)}`
        : projection && projection.income.source === 'mixed'
          ? `Cobranza ${fmtCurrency(projection.income.fromClients)} + baseline ${fmtCurrency(projection.income.fromBaseline)}`
          : `Baseline MA6: ${fmtCurrency(baseline.avgIncome)}`;
    incomeProjectedNote = `Total del mes: ${fmtCurrency(incomeTotalProjected)}. ${incomeSource}. Real al día ${daysElapsed}: ${fmtCurrency(incomeReal.total)} → falta ${fmtCurrency(incomeProjected)} para cerrar.`;

    expenseProjectedTotal = Math.max(0, expenseTotalProjected - expenseReal.total);
    const pieces: string[] = [];
    if (override?.expense !== undefined) {
      pieces.push(`ajuste manual total ${fmtCurrency(expenseTotalProjected)}`);
    } else if (projection) {
      pieces.push(`programado ${fmtCurrency(projection.expense.scheduled)}`);
      if (projection.expense.recurring > 0) pieces.push(`recurrente ${fmtCurrency(projection.expense.recurring)}`);
      pieces.push(`baseline ${fmtCurrency(projection.expense.baseline)}`);
    } else {
      pieces.push(`baseline ${fmtCurrency(baseline.avgExpense)}`);
    }
    expenseProjectedNote = `Total del mes: ${fmtCurrency(expenseTotalProjected)} (max de: ${pieces.join(', ')}). Falta pagar ${fmtCurrency(expenseProjectedTotal)} (${daysRemaining} días).`;
  } else {
    incomeProjected = incomeTotalProjected;
    if (override?.income !== undefined) {
      incomeProjectedNote = `Ajuste manual: ${fmtCurrency(incomeTotalProjected)}.`;
    } else if (projection && projection.income.source === 'clients') {
      incomeProjectedNote = `Cobranza proyectada por catálogo de clientes: ${fmtCurrency(projection.income.fromClients)}.`;
    } else if (projection && projection.income.source === 'mixed') {
      incomeProjectedNote = `Cobranza clientes ${fmtCurrency(projection.income.fromClients)} + baseline MA6 ${fmtCurrency(projection.income.fromBaseline)} = ${fmtCurrency(incomeTotalProjected)}.`;
    } else {
      incomeProjectedNote = `Baseline MA6: ${fmtCurrency(incomeTotalProjected)}.`;
    }
    expenseProjectedTotal = expenseTotalProjected;
    const parts: string[] = [];
    if (override?.expense !== undefined) {
      parts.push(`ajuste manual ${fmtCurrency(expenseTotalProjected)}`);
    } else if (projection) {
      parts.push(`programado ${fmtCurrency(projection.expense.scheduled)}`);
      if (projection.expense.recurring > 0) parts.push(`recurrente ${fmtCurrency(projection.expense.recurring)}`);
      parts.push(`baseline ${fmtCurrency(projection.expense.baseline)}`);
    } else {
      parts.push(`baseline ${fmtCurrency(baseline.avgExpense)}`);
    }
    expenseProjectedNote = `max(${parts.join(', ')}) = ${fmtCurrency(expenseTotalProjected)}.`;
  }

  // Filas del desglose proyectado de egresos:
  //   - Si el engine trajo providerLines (catálogo de proveedores), las usamos
  //     con flexibility + paymentPeriod para que el usuario sepa si es un
  //     proveedor inamovible o flexible.
  //   - Si no hay providerLines pero sí aged, caemos al grupo por proveedor
  //     desde aged (committedRows).
  const providerLines = projection?.expense.providerLines ?? [];
  const expenseProjectedRows: ConceptRow[] = providerLines.length > 0
    ? providerLines.map((l) => ({
        label: l.providerName,
        count: 1,
        amount: l.amount,
        flexibility: l.flexibility,
        paymentPeriod: l.paymentPeriod,
        source: l.source,
      }))
    : committedRows.rows;

  return {
    phase,
    daysElapsed,
    daysInMonth,
    incomeReal,
    incomeProjected,
    incomeProjectedNote,
    expenseReal,
    expenseProjected: { total: expenseProjectedTotal, rows: expenseProjectedRows },
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
