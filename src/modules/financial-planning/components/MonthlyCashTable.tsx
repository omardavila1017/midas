import React, { useMemo } from 'react';
import { Download } from 'lucide-react';
import { fmtCompact } from '../../../formatters';
import { toCSV, downloadFile } from '../../../utils/export';
import type { ForecastRun } from '../../shared-finance/types';
import { aggregateProjectionToMonths } from './cashTrajectoryAggregation';

interface Props {
  projection: ForecastRun;
  baseProjection?: ForecastRun;
  scenarioName: string;
}

export const MonthlyCashTable: React.FC<Props> = ({ projection, baseProjection, scenarioName }) => {
  const months = useMemo(
    () => aggregateProjectionToMonths(projection, baseProjection),
    [projection, baseProjection],
  );

  const hasBaseline = Boolean(baseProjection) && projection.scenarioId !== baseProjection?.scenarioId;
  const anyImpact = hasBaseline && months.some((m) =>
    m.forecastIncome !== m.baseIncome
    || m.forecastExpense !== m.baseExpense
    || m.forecastClosingCash !== m.baseClosingCash,
  );

  const handleExport = () => {
    if (months.length === 0) return;
    const rows = months.map((m) => ({
      mes: m.yearMonth,
      ingresos_base: round(m.baseIncome),
      egresos_base: round(m.baseExpense),
      neto_base: round(m.baseIncome - m.baseExpense),
      caja_base: round(m.baseClosingCash),
      ingresos_escenario: round(m.forecastIncome),
      egresos_escenario: round(m.forecastExpense),
      neto_escenario: round(m.forecastIncome - m.forecastExpense),
      caja_escenario: round(m.forecastClosingCash),
      delta_caja: round(m.forecastClosingCash - m.baseClosingCash),
    }));
    const csv = toCSV(rows);
    const today = new Date().toISOString().slice(0, 10);
    const safeName = scenarioName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    downloadFile(csv, `midas-trayectoria-${safeName}-${today}.csv`);
  };

  return (
    <section className="rounded-2xl border border-[var(--gray-200)] bg-white overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-6 py-4 border-b border-[var(--gray-100)]">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
            Detalle mensual
          </h2>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--gray-400)' }}>
            {hasBaseline
              ? `Ingresos, egresos y caja por mes — base vs ${scenarioName}.`
              : 'Ingresos, egresos y caja por mes del escenario activo.'}
          </p>
        </div>
        <button
          type="button"
          onClick={handleExport}
          disabled={months.length === 0}
          title="Descargar detalle mensual en CSV"
          className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--gray-200)] text-[12px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)] hover:border-[var(--gray-300)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Download className="w-3.5 h-3.5" />
          Exportar CSV
        </button>
      </header>

      {months.length === 0 ? (
        <div className="px-4 py-10 text-center">
          <p className="text-[13px]" style={{ color: 'var(--gray-400)' }}>Sin datos para mostrar.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-[var(--gray-200)] bg-[var(--gray-50)]">
                <th
                  className="text-left px-4 py-2.5 font-medium sticky left-0 z-10 bg-[var(--gray-50)]"
                  style={{ color: 'var(--gray-500)' }}
                >
                  Mes
                </th>
                <th className="text-right px-3 py-2.5 font-medium whitespace-nowrap" style={{ color: 'var(--gray-500)' }}>
                  Ingresos
                </th>
                <th className="text-right px-3 py-2.5 font-medium whitespace-nowrap" style={{ color: 'var(--gray-500)' }}>
                  Egresos
                </th>
                <th className="text-right px-3 py-2.5 font-medium whitespace-nowrap" style={{ color: 'var(--gray-500)' }}>
                  Neto
                </th>
                <th className="text-right px-3 py-2.5 font-medium whitespace-nowrap" style={{ color: 'var(--gray-950)' }}>
                  Caja Final
                </th>
                {anyImpact && (
                  <th className="text-right px-3 py-2.5 font-medium whitespace-nowrap" style={{ color: 'var(--gray-500)' }}>
                    Δ vs base
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {months.map((m, idx) => {
                const netoBase = m.baseIncome - m.baseExpense;
                const netoSim = m.forecastIncome - m.forecastExpense;
                const deltaCaja = m.forecastClosingCash - m.baseClosingCash;
                const isLast = idx === months.length - 1;
                return (
                  <tr
                    key={m.yearMonth}
                    className="border-t border-[var(--gray-100)]"
                    style={{ background: isLast ? 'var(--gray-50)' : undefined }}
                  >
                    <td
                      className="px-4 py-2 sticky left-0 whitespace-nowrap"
                      style={{
                        background: isLast ? 'var(--gray-50)' : 'white',
                        color: 'var(--gray-950)',
                      }}
                    >
                      <span className="font-medium">{m.yearMonth}</span>
                    </td>
                    <MetricCell base={m.baseIncome} sim={m.forecastIncome} impactDir="up" hasBaseline={hasBaseline} />
                    <MetricCell base={m.baseExpense} sim={m.forecastExpense} impactDir="down" hasBaseline={hasBaseline} />
                    <NetoCell base={netoBase} sim={netoSim} hasBaseline={hasBaseline} />
                    <CajaCell base={m.baseClosingCash} sim={m.forecastClosingCash} hasBaseline={hasBaseline} />
                    {anyImpact && (
                      <td className="text-right px-3 py-2 tabular-nums whitespace-nowrap font-medium">
                        {Math.abs(deltaCaja) < 0.005 ? (
                          <span style={{ color: 'var(--gray-300)' }}>—</span>
                        ) : (
                          <span style={{ color: deltaCaja > 0 ? 'var(--success)' : 'var(--danger)' }}>
                            {deltaCaja > 0 ? '+' : ''}{fmtCompact(deltaCaja)}
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div
            className="flex flex-wrap items-center gap-4 px-4 py-3 border-t border-[var(--gray-100)] bg-[var(--gray-50)] text-[10px]"
            style={{ color: 'var(--gray-500)' }}
          >
            {anyImpact && (
              <>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full" style={{ background: 'var(--success)' }} />
                  Mejora vs base
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full" style={{ background: 'var(--danger)' }} />
                  Empeora vs base
                </span>
              </>
            )}
            <span className="ml-auto tabular-nums">Última fila resaltada: cierre proyectado del período</span>
          </div>
        </div>
      )}
    </section>
  );
};

const MetricCell: React.FC<{ base: number; sim: number; impactDir: 'up' | 'down'; hasBaseline: boolean }> = ({
  base, sim, impactDir, hasBaseline,
}) => {
  const delta = sim - base;
  const unchanged = !hasBaseline || Math.abs(delta) < 0.005;
  const goodForCash = impactDir === 'up' ? delta > 0 : delta < 0;
  const color = unchanged ? 'var(--gray-700)' : goodForCash ? 'var(--success)' : 'var(--danger)';
  return (
    <td className="text-right px-3 py-2 tabular-nums whitespace-nowrap">
      <span style={{ color: unchanged ? 'var(--gray-700)' : color, fontWeight: unchanged ? 400 : 500 }}>
        {fmtCompact(sim)}
      </span>
      {!unchanged && (
        <span className="block text-[10px]" style={{ color }}>
          {delta > 0 ? '+' : ''}{fmtCompact(delta)}
        </span>
      )}
    </td>
  );
};

const NetoCell: React.FC<{ base: number; sim: number; hasBaseline: boolean }> = ({ base, sim, hasBaseline }) => {
  const delta = sim - base;
  const unchanged = !hasBaseline || Math.abs(delta) < 0.005;
  const color = unchanged
    ? sim < 0 ? 'var(--danger)' : 'var(--gray-700)'
    : delta > 0 ? 'var(--success)' : 'var(--danger)';
  return (
    <td className="text-right px-3 py-2 tabular-nums whitespace-nowrap font-medium">
      <span style={{ color }}>
        {sim > 0 ? '+' : ''}{fmtCompact(sim)}
      </span>
      {!unchanged && (
        <span className="block text-[10px]" style={{ color }}>
          {delta > 0 ? '+' : ''}{fmtCompact(delta)}
        </span>
      )}
    </td>
  );
};

const CajaCell: React.FC<{ base: number; sim: number; hasBaseline: boolean }> = ({ base, sim, hasBaseline }) => {
  const delta = sim - base;
  const unchanged = !hasBaseline || Math.abs(delta) < 0.005;
  const critical = sim < 0;
  const color = critical
    ? 'var(--danger)'
    : unchanged
      ? 'var(--gray-950)'
      : delta > 0 ? 'var(--success)' : 'var(--danger)';
  return (
    <td className="text-right px-3 py-2 tabular-nums whitespace-nowrap font-semibold">
      <span style={{ color }}>
        {fmtCompact(sim)}
      </span>
      {!unchanged && (
        <span className="block text-[10px] font-normal" style={{ color: 'var(--gray-400)' }}>
          base {fmtCompact(base)}
        </span>
      )}
    </td>
  );
};

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export default MonthlyCashTable;
