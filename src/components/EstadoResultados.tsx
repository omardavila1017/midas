import React from 'react';
import type { EvaluatedCashFlow } from '../types';
import { fmtCompact } from '../formatters';

interface Props {
  data: EvaluatedCashFlow;
}

/**
 * Estado de Resultados sobreviviente del módulo viejo de Pronóstico.
 * Muestra Ingresos / Egresos / Utilidad Neta por mes con base y pronóstico.
 */
const EstadoResultados: React.FC<Props> = ({ data }) => {
  const { months } = data;
  if (months.length === 0) {
    return (
      <div className="rounded-2xl border border-[var(--gray-200)] bg-white px-4 py-10 text-center">
        <p className="text-[13px]" style={{ color: 'var(--gray-400)' }}>Sin datos para mostrar.</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-[var(--gray-200)] bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--gray-100)]">
        <h3 className="text-[14px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
          Estado de Resultados
        </h3>
        <p className="text-[11px]" style={{ color: 'var(--gray-400)' }}>
          Ingresos, egresos y utilidad neta por mes (base vs pronóstico con propuestas).
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-[var(--gray-100)] bg-[var(--gray-50)]">
              <th className="text-left px-4 py-2 font-medium sticky left-0 bg-[var(--gray-50)]" style={{ color: 'var(--gray-500)' }}>Concepto</th>
              {months.map((m) => (
                <th key={m.yearMonth} className="text-right px-3 py-2 font-medium whitespace-nowrap" style={{ color: m.isHistorical ? 'var(--gray-400)' : 'var(--gray-500)' }}>
                  {m.yearMonth}
                  {m.isHistorical ? <span className="block text-[9px] normal-case font-normal">histórico</span> : <span className="block text-[9px] normal-case font-normal">proyección</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <Row label="Ingresos (base)" values={months.map((m) => m.baseIncome)} />
            <Row label="Ingresos (forecast)" values={months.map((m) => m.forecastIncome)} accent />
            <Row label="Egresos (base)" values={months.map((m) => -m.baseExpense)} />
            <Row label="Egresos (forecast)" values={months.map((m) => -m.forecastExpense)} accent />
            <Row
              label="Utilidad neta (base)"
              values={months.map((m) => m.baseIncome - m.baseExpense)}
              bold
            />
            <Row
              label="Utilidad neta (forecast)"
              values={months.map((m) => m.forecastIncome - m.forecastExpense)}
              bold
              accent
            />
            <Row
              label="Caja final (base)"
              values={months.map((m) => m.baseClosingCash)}
              divider
            />
            <Row
              label="Caja final (forecast)"
              values={months.map((m) => m.forecastClosingCash)}
              accent
              bold
            />
          </tbody>
        </table>
      </div>
    </div>
  );
};

const Row: React.FC<{ label: string; values: number[]; bold?: boolean; accent?: boolean; divider?: boolean }> = ({ label, values, bold, accent, divider }) => (
  <tr className={divider ? 'border-t border-[var(--gray-200)]' : 'border-t border-[var(--gray-50)]'}>
    <td
      className="px-4 py-2 sticky left-0 bg-white whitespace-nowrap"
      style={{ color: accent ? 'var(--primary)' : 'var(--gray-700)', fontWeight: bold ? 600 : 400 }}
    >
      {label}
    </td>
    {values.map((v, i) => (
      <td
        key={i}
        className="text-right px-3 py-2 tabular-nums whitespace-nowrap"
        style={{ color: accent ? 'var(--primary)' : 'var(--gray-700)', fontWeight: bold ? 600 : 400 }}
      >
        {fmtCompact(v)}
      </td>
    ))}
  </tr>
);

export default EstadoResultados;
