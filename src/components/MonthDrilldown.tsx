import React, { useEffect, useMemo } from 'react';
import { X, TrendingUp, TrendingDown } from 'lucide-react';
import type { BankAccountStatement, AgedBalanceRecord } from '../services/jde';
import { fmtCurrency, fmtYearMonthLong } from '../formatters';
import { toYearMonth, compareYearMonth } from '../domain/cashFlowEngine';

interface MonthDrilldownProps {
  open: boolean;
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

function topByAmount(rows: ConceptRow[], limit = 8): { top: ConceptRow[]; rest: ConceptRow } {
  const sorted = [...rows].sort((a, b) => b.amount - a.amount);
  if (sorted.length <= limit) return { top: sorted, rest: { label: '', count: 0, amount: 0 } };
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
 * Modal de detalle mes a mes: muestra ingresos reales vs proyectados y
 * egresos reales vs proyectados, cada uno con su desglose.
 *
 *   - Ingresos reales: movimientos ABONO del periodo, agrupados por concepto.
 *   - Egresos reales: movimientos CARGO del periodo, agrupados por concepto.
 *   - Ingresos proyectados: baseline (promedio móvil 6 meses) escalado por
 *     los días restantes del mes si es el mes actual, o total si es futuro.
 *   - Egresos proyectados: facturas programadas en /AntiguedadSaldos para el
 *     periodo, agrupadas por proveedor.
 */
const MonthDrilldown: React.FC<MonthDrilldownProps> = ({
  open,
  yearMonth,
  bankStatements,
  agedBalances,
  companyCode,
  baseline,
  today,
  onClose,
}) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const data = useMemo(() => {
    if (!yearMonth) return null;
    return buildDrilldownData({
      yearMonth,
      bankStatements,
      agedBalances,
      companyCode,
      baseline,
      today,
    });
  }, [yearMonth, bankStatements, agedBalances, companyCode, baseline, today]);

  if (!open || !yearMonth || !data) return null;

  const { phase, daysElapsed, daysInMonth, incomeReal, incomeProjected, incomeProjectedNote,
    expenseReal, expenseProjected, expenseProjectedNote } = data;

  const incomeRealRows = topByAmount(incomeReal.rows);
  const expenseRealRows = topByAmount(expenseReal.rows);
  const expenseProjRows = topByAmount(expenseProjected.rows);

  const phaseLabel =
    phase === 'past' ? 'Histórico' :
    phase === 'current' ? `En curso · día ${daysElapsed} de ${daysInMonth}` :
    'Proyectado';

  return (
    <>
      <div
        className="fixed inset-0 bg-black/40 z-[300] animate-fadeIn"
        onClick={onClose}
        aria-hidden="true"
      />
      <dialog
        open
        className="fixed inset-0 z-[400] flex items-center justify-center p-4"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div
          className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col animate-scale-in"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="sticky top-0 bg-white border-b border-[var(--gray-200)] px-6 py-4 flex items-center justify-between">
            <div>
              <h2 className="text-[18px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
                {fmtYearMonthLong(yearMonth)}
              </h2>
              <p className="text-[12px] mt-0.5" style={{ color: 'var(--gray-400)' }}>
                {phaseLabel}
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-[var(--gray-100)] rounded-md"
              aria-label="Cerrar"
            >
              <X size={20} style={{ color: 'var(--gray-500)' }} />
            </button>
          </div>

          <div className="overflow-y-auto p-6 space-y-5">
            <DrilldownSection
              title="Ingresos"
              icon={<TrendingUp className="w-4 h-4" />}
              accent="var(--success)"
              realTotal={incomeReal.total}
              projectedTotal={incomeProjected}
              realLabel={phase === 'past' ? 'Ingresos reales' : phase === 'current' ? `Real al día ${daysElapsed}` : 'Real'}
              projectedLabel={phase === 'past' ? 'Proyectado' : phase === 'current' ? 'Proyectado (resto del mes)' : 'Proyectado'}
              projectedNote={incomeProjectedNote}
              realRows={incomeRealRows}
              projectedRows={{ top: [], rest: { label: '', count: 0, amount: 0 } }}
              emptyRealHint={phase === 'future' ? 'Aún no hay movimientos — el mes está en el futuro.' : 'No se registraron abonos en el periodo.'}
            />

            <DrilldownSection
              title="Egresos"
              icon={<TrendingDown className="w-4 h-4" />}
              accent="var(--danger)"
              realTotal={expenseReal.total}
              projectedTotal={expenseProjected.total}
              realLabel={phase === 'past' ? 'Egresos reales' : phase === 'current' ? `Real al día ${daysElapsed}` : 'Real'}
              projectedLabel={phase === 'past' ? 'Proyectado' : phase === 'current' ? 'Proyectado (resto del mes)' : 'Programado + baseline'}
              projectedNote={expenseProjectedNote}
              realRows={expenseRealRows}
              projectedRows={expenseProjRows}
              emptyRealHint={phase === 'future' ? 'Aún no hay movimientos — el mes está en el futuro.' : 'No se registraron cargos en el periodo.'}
            />
          </div>
        </div>
      </dialog>
    </>
  );
};

interface DrilldownSectionProps {
  title: string;
  icon: React.ReactNode;
  accent: string;
  realTotal: number;
  projectedTotal: number;
  realLabel: string;
  projectedLabel: string;
  projectedNote?: string;
  realRows: { top: ConceptRow[]; rest: ConceptRow };
  projectedRows: { top: ConceptRow[]; rest: ConceptRow };
  emptyRealHint: string;
}

const DrilldownSection: React.FC<DrilldownSectionProps> = ({
  title, icon, accent, realTotal, projectedTotal, realLabel, projectedLabel,
  projectedNote, realRows, projectedRows, emptyRealHint,
}) => {
  const total = realTotal + projectedTotal;
  const hasReal = realRows.top.length > 0 || realRows.rest.amount > 0;
  const hasProjectedRows = projectedRows.top.length > 0 || projectedRows.rest.amount > 0;
  return (
    <section className="rounded-xl border border-[var(--gray-200)] overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 bg-[var(--gray-50)] border-b border-[var(--gray-200)]">
        <div className="flex items-center gap-2">
          <span style={{ color: accent }}>{icon}</span>
          <h3 className="text-[14px] font-semibold" style={{ color: 'var(--gray-950)' }}>{title}</h3>
        </div>
        <span className="text-[14px] font-semibold tabular-nums" style={{ color: accent }}>
          {fmtCurrency(total)}
        </span>
      </header>
      <div className="p-4 space-y-4">
        <SubBlock label={realLabel} total={realTotal} accent={accent}>
          {hasReal ? (
            <RowList rows={realRows} />
          ) : (
            <p className="text-[12px]" style={{ color: 'var(--gray-400)' }}>{emptyRealHint}</p>
          )}
        </SubBlock>

        <SubBlock label={projectedLabel} total={projectedTotal} accent={accent} striped>
          {projectedNote && (
            <p className="text-[12px] mb-2" style={{ color: 'var(--gray-500)' }}>{projectedNote}</p>
          )}
          {hasProjectedRows && <RowList rows={projectedRows} />}
          {!hasProjectedRows && !projectedNote && (
            <p className="text-[12px]" style={{ color: 'var(--gray-400)' }}>Sin desglose — baseline histórico.</p>
          )}
        </SubBlock>
      </div>
    </section>
  );
};

const SubBlock: React.FC<{
  label: string;
  total: number;
  accent: string;
  striped?: boolean;
  children: React.ReactNode;
}> = ({ label, total, accent, striped, children }) => (
  <div>
    <div className="flex items-center justify-between mb-2">
      <div className="flex items-center gap-2">
        <span
          className="inline-block w-3 h-3 rounded-sm"
          style={
            striped
              ? { backgroundImage: `repeating-linear-gradient(45deg, ${accent} 0 2px, transparent 2px 5px)`, backgroundColor: `color-mix(in srgb, ${accent} 18%, white)` }
              : { backgroundColor: accent }
          }
        />
        <span className="text-[12px] font-medium" style={{ color: 'var(--gray-700)' }}>{label}</span>
      </div>
      <span className="text-[12px] font-semibold tabular-nums" style={{ color: 'var(--gray-950)' }}>
        {fmtCurrency(total)}
      </span>
    </div>
    {children}
  </div>
);

const RowList: React.FC<{ rows: { top: ConceptRow[]; rest: ConceptRow } }> = ({ rows }) => (
  <ul className="divide-y divide-[var(--gray-100)]">
    {rows.top.map((r) => (
      <li key={r.label} className="flex items-center justify-between py-1.5 text-[12px]">
        <div className="flex-1 min-w-0 pr-3">
          <p className="truncate" style={{ color: 'var(--gray-900)' }}>{r.label}</p>
          <p className="text-[11px]" style={{ color: 'var(--gray-400)' }}>{r.count} mov.</p>
        </div>
        <span className="tabular-nums font-medium" style={{ color: 'var(--gray-950)' }}>
          {fmtCurrency(r.amount)}
        </span>
      </li>
    ))}
    {rows.rest.amount > 0 && (
      <li className="flex items-center justify-between py-1.5 text-[12px]">
        <span style={{ color: 'var(--gray-500)' }}>{rows.rest.label}</span>
        <span className="tabular-nums" style={{ color: 'var(--gray-700)' }}>
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

  // 1) Movimientos reales del periodo por concepto
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

  // 2) Programado en /AntiguedadSaldos para el periodo
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
  const committedByProviderRows = toRows(committedByProvider);

  // 3) Totales proyectados y notas — depende de la fase del mes
  let incomeProjected = 0;
  let incomeProjectedNote: string | undefined;
  let expenseProjectedTotal = 0;
  let expenseProjectedNote: string | undefined;

  if (phase === 'past') {
    // Histórico completo: no hay proyección útil.
    incomeProjected = 0;
    expenseProjectedTotal = 0;
  } else if (phase === 'current') {
    // Mes en curso: proyectamos lo que falta para cerrar el mes.
    incomeProjected = Math.max(0, baseline.avgIncome - incomeReal.total);
    incomeProjectedNote = `Baseline del mes ≈ ${fmtCurrency(baseline.avgIncome)} (promedio 6 meses). Real al día ${daysElapsed}: ${fmtCurrency(incomeReal.total)} → faltaría ${fmtCurrency(incomeProjected)} para llegar al promedio.`;

    // Egresos: tomamos lo programado pendiente + el baseline prorrateado a los
    // días restantes, con un piso mínimo del baseline para no subestimar.
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
      ? `Proyección del resto del mes: ${pieces.join(' + ')}.`
      : undefined;
  } else {
    // Mes futuro: usamos baseline íntegro para ingresos, max(programado, baseline) para egresos.
    incomeProjected = baseline.avgIncome;
    incomeProjectedNote = `Promedio móvil de los últimos 6 meses históricos: ${fmtCurrency(baseline.avgIncome)}.`;
    expenseProjectedTotal = Math.max(committedTotal, baseline.avgExpense);
    const parts: string[] = [];
    if (committedTotal > 0) {
      parts.push(`programado ${fmtCurrency(committedTotal)}`);
    }
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
    expenseProjected: { total: expenseProjectedTotal, rows: committedByProviderRows.rows },
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
