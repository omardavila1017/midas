import React, { useState } from 'react';
import { RotateCcw, Pencil } from 'lucide-react';
import type { CashFlowOverrides } from '../types';
import type { ForecastMonth } from '../domain/forecastEngine';
import { fmtCompact, fmtCurrency, fmtYearMonthShort } from '../formatters';

interface Props {
  months: ForecastMonth[];
  overrides: CashFlowOverrides;
  onOverridesChange: (next: CashFlowOverrides) => void;
  currentYm: string;
  incomeCalibrationFactor: number;
  expenseCalibrationFactor: number;
  hasClientsCatalog: boolean;
}

const SOURCE_BADGES: Record<string, { label: string; color: string; bg: string }> = {
  historical: { label: 'Real', color: 'var(--gray-600)', bg: 'var(--gray-100)' },
  clients: { label: 'Clientes', color: 'var(--success)', bg: 'var(--success-muted, #ecfdf5)' },
  committed: { label: 'Programado', color: 'var(--danger)', bg: '#fef2f2' },
  baseline: { label: 'Baseline', color: 'var(--gray-500)', bg: 'var(--gray-50)' },
  override: { label: 'Manual', color: 'var(--primary)', bg: 'var(--primary-muted)' },
};

/**
 * Tabla editable del flujo mensual. Los meses históricos son de sólo lectura.
 * Los meses futuros (o el mes en curso) pueden editarse: al guardar un valor
 * se vuelca a `overrides` y el chart del Flujo mensual se recalcula. Reset
 * elimina el override y vuelve al valor calculado por el motor.
 */
const CashFlowTable: React.FC<Props> = ({
  months, overrides, onOverridesChange, currentYm,
  incomeCalibrationFactor, expenseCalibrationFactor, hasClientsCatalog,
}) => {
  const setOverride = (ym: string, field: 'income' | 'expense', value: number | null) => {
    const next = { ...overrides };
    const existing = next[ym] ?? {};
    const updated = { ...existing };
    if (value == null) {
      delete updated[field];
    } else {
      updated[field] = value;
    }
    if (updated.income === undefined && updated.expense === undefined) {
      delete next[ym];
    } else {
      next[ym] = updated;
    }
    onOverridesChange(next);
  };

  const hasAnyOverride = Object.keys(overrides).length > 0;

  return (
    <section className="rounded-2xl border border-[var(--gray-200)] bg-white overflow-hidden">
      <header className="flex items-start justify-between gap-4 px-5 py-4 border-b border-[var(--gray-100)]">
        <div>
          <h3 className="text-[15px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
            Flujo de efectivo
          </h3>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--gray-400)' }}>
            Edita los meses futuros: tus cambios se reflejan inmediato en el chart de arriba.
            {hasClientsCatalog && ` · Calibración ingresos ×${incomeCalibrationFactor.toFixed(2)}`}
            {` · Calibración egresos ×${expenseCalibrationFactor.toFixed(2)}`}
          </p>
        </div>
        {hasAnyOverride && (
          <button
            onClick={() => onOverridesChange({})}
            className="h-8 px-3 rounded-lg text-[11px] font-medium border border-[var(--gray-200)] text-[var(--gray-600)] hover:bg-[var(--gray-100)] flex items-center gap-1.5 flex-shrink-0"
          >
            <RotateCcw className="w-3 h-3" />
            Limpiar todos los overrides
          </button>
        )}
      </header>

      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="bg-[var(--gray-50)] border-b border-[var(--gray-100)]">
              <Th align="left">Mes</Th>
              <Th>Ingresos</Th>
              <Th>Egresos</Th>
              <Th>Flujo neto</Th>
              <Th>Caja final</Th>
              <Th>Fuente</Th>
            </tr>
          </thead>
          <tbody>
            {months.map((m) => {
              const isPast = m.yearMonth < currentYm;
              const editable = !isPast;
              const net = m.income - m.expense;
              return (
                <tr
                  key={m.yearMonth}
                  className="border-b border-[var(--gray-100)] last:border-b-0 hover:bg-[var(--gray-50)]/50"
                  style={m.yearMonth === currentYm ? { background: 'var(--primary-muted)' } : undefined}
                >
                  <td className="px-5 py-2.5 font-medium tabular-nums" style={{ color: 'var(--gray-950)' }}>
                    {fmtYearMonthShort(m.yearMonth)}
                    {m.yearMonth === currentYm && (
                      <span className="ml-2 text-[10px] uppercase tracking-wider" style={{ color: 'var(--primary)' }}>
                        · en curso
                      </span>
                    )}
                  </td>
                  <EditableCell
                    value={m.income}
                    editable={editable}
                    overridden={m.incomeOverridden}
                    color="var(--success)"
                    onChange={(v) => setOverride(m.yearMonth, 'income', v)}
                    subLabel={
                      !m.incomeOverridden && !isPast && m.incomeSource === 'clients'
                        ? `clientes ${fmtCompact(m.incomeFromClientsRaw)} × ${m.incomeCalibrationFactor.toFixed(2)}`
                        : !m.incomeOverridden && !isPast && m.incomeSource === 'baseline'
                          ? `baseline ${fmtCompact(m.incomeBaseline)}`
                          : undefined
                    }
                  />
                  <EditableCell
                    value={m.expense}
                    editable={editable}
                    overridden={m.expenseOverridden}
                    color="var(--danger)"
                    onChange={(v) => setOverride(m.yearMonth, 'expense', v)}
                    subLabel={
                      !m.expenseOverridden && !isPast && m.expenseSource === 'committed'
                        ? `programado ${fmtCompact(m.expenseCommitted)} × ${m.expenseCalibrationFactor.toFixed(2)}`
                        : !m.expenseOverridden && !isPast && m.expenseSource === 'baseline'
                          ? `baseline ${fmtCompact(m.expenseBaseline)}`
                          : undefined
                    }
                  />
                  <td className="px-3 py-2.5 text-right tabular-nums font-medium" style={{ color: net >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                    {net > 0 ? '+' : ''}{fmtCompact(net)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-semibold" style={{ color: 'var(--gray-950)' }}>
                    {fmtCompact(m.closingCash)}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex gap-1 justify-end">
                      <Badge source={m.incomeSource} />
                      <Badge source={m.expenseSource} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
};

const Th: React.FC<{ children: React.ReactNode; align?: 'left' | 'right' }> = ({ children, align = 'right' }) => (
  <th
    className={`px-${align === 'left' ? 5 : 3} py-2.5 text-[10px] font-semibold uppercase tracking-wider`}
    style={{ color: 'var(--gray-400)', textAlign: align }}
  >
    {children}
  </th>
);

const Badge: React.FC<{ source: string }> = ({ source }) => {
  const cfg = SOURCE_BADGES[source] ?? SOURCE_BADGES.baseline;
  return (
    <span
      className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded"
      style={{ background: cfg.bg, color: cfg.color }}
      title={`Fuente: ${cfg.label}`}
    >
      {cfg.label}
    </span>
  );
};

interface EditableCellProps {
  value: number;
  editable: boolean;
  overridden: boolean;
  color: string;
  subLabel?: string;
  onChange: (v: number | null) => void;
}

const EditableCell: React.FC<EditableCellProps> = ({ value, editable, overridden, color, subLabel, onChange }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>('');

  if (!editable) {
    return (
      <td className="px-3 py-2.5 text-right tabular-nums" style={{ color }}>
        {fmtCompact(value)}
      </td>
    );
  }

  if (editing) {
    return (
      <td className="px-3 py-2.5 text-right">
        <input
          type="number"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const num = Number(draft);
            if (!isNaN(num) && isFinite(num) && num >= 0) {
              onChange(num);
            }
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const num = Number(draft);
              if (!isNaN(num) && isFinite(num) && num >= 0) {
                onChange(num);
              }
              setEditing(false);
            } else if (e.key === 'Escape') {
              setEditing(false);
            }
          }}
          className="w-28 h-8 px-2 rounded-lg border text-[12px] text-right tabular-nums focus:outline-none"
          style={{ borderColor: color, color: 'var(--gray-950)' }}
          placeholder={fmtCompact(value)}
        />
      </td>
    );
  }

  return (
    <td
      className="px-3 py-2.5 text-right cursor-pointer group relative"
      onClick={() => {
        setDraft(String(Math.round(value)));
        setEditing(true);
      }}
      title={overridden ? 'Override manual — clic para editar' : 'Clic para editar'}
    >
      <div className="tabular-nums" style={{ color: overridden ? 'var(--primary)' : color, fontWeight: overridden ? 600 : 400 }}>
        {fmtCurrency(value)}
        <Pencil
          className="inline-block w-3 h-3 ml-1.5 opacity-0 group-hover:opacity-60 transition-opacity"
          style={{ color: 'var(--gray-400)' }}
        />
      </div>
      {subLabel && !overridden && (
        <p className="text-[10px]" style={{ color: 'var(--gray-400)' }}>{subLabel}</p>
      )}
      {overridden && (
        <button
          onClick={(e) => { e.stopPropagation(); onChange(null); }}
          className="text-[10px] underline"
          style={{ color: 'var(--gray-500)' }}
        >
          revertir
        </button>
      )}
    </td>
  );
};

export default CashFlowTable;
