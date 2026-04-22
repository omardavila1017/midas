import React, { useMemo, useState } from 'react';
import { Pencil, RotateCcw, TrendingUp, TrendingDown } from 'lucide-react';
import { fmtCurrency, fmtYearMonthShort } from '../formatters';
import { compareYearMonth } from '../domain/cashFlowEngine';
import type { ProjectionOverride, ProjectionOverrides, MonthlyProjection } from '../domain/projectionEngine';

export interface CashFlowTableRow {
  yearMonth: string;
  phase: 'past' | 'current' | 'future';
  /** Ingresos "reales" (histórico) o 0 a futuro. */
  realIncome: number;
  /** Egresos reales. */
  realExpense: number;
  /** Ingresos proyectados para el mes (total ya ajustado por override si existe). */
  projectedIncome: number;
  /** Egresos proyectados para el mes (total ya ajustado por override si existe). */
  projectedExpense: number;
  /** Caja al cierre del mes. */
  closingCash: number;
  /** Info de la proyección base (sin override) para el tooltip/editor. */
  projectionDetail?: MonthlyProjection;
  /** Override actualmente aplicado. */
  override?: ProjectionOverride;
}

interface Props {
  rows: CashFlowTableRow[];
  overrides: ProjectionOverrides;
  onOverridesChange: (overrides: ProjectionOverrides) => void;
  /** Filtra meses a mostrar — si no se pasa, muestra todos. */
  filter?: (row: CashFlowTableRow) => boolean;
  title?: string;
  subtitle?: string;
  /** Compacto: muestra solo rango reducido y sin encabezado. Útil en drilldown. */
  compact?: boolean;
  /** yearMonth seleccionado (scroll-highlight). */
  highlightYearMonth?: string | null;
  onRowClick?: (yearMonth: string) => void;
}

/**
 * Tabla editable de flujo mensual. Cada fila futura permite ajustar
 * ingreso y egreso proyectado vía un override que fluye hacia arriba a
 * `onOverridesChange`. La caja se recomputa en el padre.
 */
const CashFlowTable: React.FC<Props> = ({
  rows, overrides, onOverridesChange, filter, title, subtitle, compact, highlightYearMonth, onRowClick,
}) => {
  const filtered = useMemo(() => {
    const list = filter ? rows.filter(filter) : rows;
    return [...list].sort((a, b) => compareYearMonth(a.yearMonth, b.yearMonth));
  }, [rows, filter]);

  const updateOverride = (ym: string, field: 'income' | 'expense', value: string | undefined) => {
    const next: ProjectionOverrides = { ...overrides };
    const current: ProjectionOverride = { ...(next[ym] ?? {}) };
    if (value === undefined || value === '') {
      delete current[field];
    } else {
      const n = Number(value.replace(/[^\d.-]/g, ''));
      if (Number.isFinite(n)) current[field] = n;
    }
    if (current.income === undefined && current.expense === undefined) {
      delete next[ym];
    } else {
      next[ym] = current;
    }
    onOverridesChange(next);
  };

  const resetMonth = (ym: string) => {
    const next: ProjectionOverrides = { ...overrides };
    delete next[ym];
    onOverridesChange(next);
  };

  const resetAll = () => onOverridesChange({});

  const hasAnyOverride = Object.keys(overrides).length > 0;

  return (
    <section
      className={`rounded-2xl border border-[var(--gray-200)] bg-white ${compact ? '' : 'overflow-hidden'}`}
      aria-label={title ?? 'Flujo mensual editable'}
    >
      {!compact && (title || subtitle) && (
        <header className="flex items-start justify-between gap-3 px-5 py-4 border-b border-[var(--gray-100)]">
          <div>
            {title && (
              <h3 className="text-[15px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
                {title}
              </h3>
            )}
            {subtitle && (
              <p className="text-[11px] mt-0.5" style={{ color: 'var(--gray-400)' }}>
                {subtitle}
              </p>
            )}
          </div>
          {hasAnyOverride && (
            <button
              onClick={resetAll}
              className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--gray-200)] text-[12px] text-[var(--gray-500)] hover:bg-[var(--gray-50)]"
              title="Limpiar todos los ajustes manuales"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Limpiar ajustes
            </button>
          )}
        </header>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="bg-[var(--gray-50)] text-[var(--gray-400)] text-left text-[11px] uppercase tracking-wide">
            <tr>
              <th className="px-4 py-2.5 font-medium">Mes</th>
              <th className="px-3 py-2.5 font-medium text-right">Ingreso real</th>
              <th className="px-3 py-2.5 font-medium text-right">Ingreso proy.</th>
              <th className="px-3 py-2.5 font-medium text-right">Egreso real</th>
              <th className="px-3 py-2.5 font-medium text-right">Egreso proy.</th>
              <th className="px-3 py-2.5 font-medium text-right">Flujo neto</th>
              <th className="px-4 py-2.5 font-medium text-right">Caja</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <Row
                key={r.yearMonth}
                row={r}
                editable={r.phase !== 'past'}
                onChange={(field, val) => updateOverride(r.yearMonth, field, val)}
                onReset={() => resetMonth(r.yearMonth)}
                highlighted={r.yearMonth === highlightYearMonth}
                onRowClick={onRowClick ? () => onRowClick(r.yearMonth) : undefined}
              />
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-[var(--gray-400)] py-8 text-[12px]">
                  Sin meses que mostrar.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};

const Row: React.FC<{
  row: CashFlowTableRow;
  editable: boolean;
  onChange: (field: 'income' | 'expense', value: string | undefined) => void;
  onReset: () => void;
  highlighted: boolean;
  onRowClick?: () => void;
}> = ({ row, editable, onChange, onReset, highlighted, onRowClick }) => {
  const phaseBadge =
    row.phase === 'past' ? { label: 'Real', color: 'var(--gray-500)', bg: 'var(--gray-100)' }
    : row.phase === 'current' ? { label: 'En curso', color: 'var(--primary)', bg: 'var(--primary-muted)' }
    : { label: 'Proyectado', color: 'var(--warning)', bg: 'var(--warning-muted)' };

  const net = (row.realIncome + row.projectedIncome) - (row.realExpense + row.projectedExpense);
  const overrideIncome = row.override?.income !== undefined;
  const overrideExpense = row.override?.expense !== undefined;

  return (
    <tr
      className={`border-t border-[var(--gray-100)] hover:bg-[var(--gray-50)]/60 transition-colors ${highlighted ? 'bg-[var(--primary-muted)]/40' : ''} ${onRowClick ? 'cursor-pointer' : ''}`}
      onClick={onRowClick}
    >
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="font-medium" style={{ color: 'var(--gray-950)' }}>{fmtYearMonthShort(row.yearMonth)}</span>
          <span
            className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full"
            style={{ background: phaseBadge.bg, color: phaseBadge.color }}
          >
            {phaseBadge.label}
          </span>
        </div>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums" style={{ color: row.realIncome > 0 ? 'var(--success)' : 'var(--gray-300)' }}>
        {row.realIncome > 0 ? fmtCurrency(row.realIncome) : '—'}
      </td>
      <td className="px-3 py-2.5 text-right">
        <EditableAmount
          value={row.projectedIncome}
          editable={editable}
          overridden={overrideIncome}
          placeholder={row.projectionDetail?.income.total}
          onChange={(v) => onChange('income', v)}
          tone="success"
          title={
            overrideIncome
              ? 'Ajuste manual — clic para editar'
              : row.projectionDetail
                ? describeIncome(row.projectionDetail)
                : undefined
          }
        />
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums" style={{ color: row.realExpense > 0 ? 'var(--danger)' : 'var(--gray-300)' }}>
        {row.realExpense > 0 ? fmtCurrency(row.realExpense) : '—'}
      </td>
      <td className="px-3 py-2.5 text-right">
        <EditableAmount
          value={row.projectedExpense}
          editable={editable}
          overridden={overrideExpense}
          placeholder={row.projectionDetail?.expense.total}
          onChange={(v) => onChange('expense', v)}
          tone="danger"
          title={
            overrideExpense
              ? 'Ajuste manual — clic para editar'
              : row.projectionDetail
                ? describeExpense(row.projectionDetail)
                : undefined
          }
        />
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums font-medium" style={{ color: net >= 0 ? 'var(--success)' : 'var(--danger)' }}>
        {fmtCurrency(net)}
      </td>
      <td className="px-4 py-2.5 text-right">
        <div className="flex items-center justify-end gap-2">
          <span className="tabular-nums font-semibold" style={{ color: 'var(--gray-950)' }}>
            {fmtCurrency(row.closingCash)}
          </span>
          {(overrideIncome || overrideExpense) && (
            <button
              onClick={(e) => { e.stopPropagation(); onReset(); }}
              title="Restaurar proyección automática"
              className="p-1 rounded hover:bg-[var(--gray-100)]"
            >
              <RotateCcw className="w-3 h-3" style={{ color: 'var(--gray-400)' }} />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
};

const EditableAmount: React.FC<{
  value: number;
  editable: boolean;
  overridden: boolean;
  placeholder?: number;
  onChange: (v: string | undefined) => void;
  tone: 'success' | 'danger';
  title?: string;
}> = ({ value, editable, overridden, placeholder, onChange, tone, title }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>('');

  if (!editable) {
    return (
      <span
        className="tabular-nums"
        style={{ color: value > 0 ? `var(--${tone})` : 'var(--gray-300)' }}
        title={title}
      >
        {value > 0 ? fmtCurrency(value) : '—'}
      </span>
    );
  }

  if (editing) {
    const finish = (save: boolean) => {
      setEditing(false);
      if (save) onChange(draft === '' ? undefined : draft);
    };
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finish(true)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish(true);
          else if (e.key === 'Escape') finish(false);
        }}
        placeholder={placeholder !== undefined ? placeholder.toFixed(0) : ''}
        className="input tabular-nums text-right h-7 w-28 text-[12px]"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); setDraft(String(Math.round(value))); setEditing(true); }}
      className={`inline-flex items-center gap-1 tabular-nums px-2 py-0.5 rounded-md transition-colors ${overridden ? 'bg-[var(--warning-muted)]' : 'hover:bg-[var(--gray-100)]'}`}
      style={{ color: value > 0 ? `var(--${tone})` : 'var(--gray-400)' }}
      title={title ?? 'Ajustar manualmente'}
    >
      {value > 0 ? fmtCurrency(value) : '—'}
      <Pencil className="w-3 h-3 opacity-40" />
    </button>
  );
};

function describeIncome(m: MonthlyProjection): string {
  const parts: string[] = [];
  if (m.income.fromClients > 0) parts.push(`cobranza de clientes ${fmtCurrency(m.income.fromClients)}`);
  if (m.income.fromBaseline > 0) parts.push(`baseline ${fmtCurrency(m.income.fromBaseline)}`);
  if (parts.length === 0) return 'Sin cobranza proyectada.';
  return `Proyección: ${parts.join(' + ')}. Clic para ajustar.`;
}

function describeExpense(m: MonthlyProjection): string {
  const e = m.expense;
  const parts: string[] = [];
  parts.push(`programado ${fmtCurrency(e.scheduled)}`);
  parts.push(`recurrente ${fmtCurrency(e.recurring)}`);
  parts.push(`baseline ${fmtCurrency(e.baseline)}`);
  return `Proyección: max(${parts.join(', ')}) = ${fmtCurrency(e.total)}. Clic para ajustar.`;
}

export const __test__ = { describeIncome, describeExpense };

export default CashFlowTable;

interface CashSummaryProps {
  label?: string;
  icon?: 'up' | 'down';
  value: number;
}

export const CashFlowMiniStat: React.FC<CashSummaryProps> = ({ label, icon, value }) => (
  <div className="flex items-center gap-2">
    {icon === 'up' && <TrendingUp className="w-4 h-4" style={{ color: 'var(--success)' }} />}
    {icon === 'down' && <TrendingDown className="w-4 h-4" style={{ color: 'var(--danger)' }} />}
    <div>
      {label && <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--gray-400)' }}>{label}</p>}
      <p className="text-[14px] font-semibold tabular-nums" style={{ color: 'var(--gray-950)' }}>{fmtCurrency(value)}</p>
    </div>
  </div>
);
