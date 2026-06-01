/**
 * Sub-pestaña "Alertas" del dashboard de Nómina.
 *
 * Detección de variaciones inusuales a nivel concepto / empresa (el grano más
 * fino que entrega el API agregado). Sustituye los "casos sospechosos por
 * empleado" del HTML de referencia, que no son posibles porque el API no trae
 * identidad de empleado. Ver la nota de gaps al pie.
 *
 * El cómputo (z-scores sobre todas las series de concepto) corre sólo cuando
 * esta sub-pestaña está montada.
 */

import { useMemo } from 'react';
import { AlertTriangle, Info, ShieldCheck } from 'lucide-react';
import { fmtCompact } from '../../../formatters';
import EmptyState from '../../shared-finance/components/EmptyState';
import type { PayrollCostRecord } from '../../shared-finance/types';
import {
  detectPayrollAnomalies,
  type AnomalySeverity,
  type PayrollAnomaly,
} from '../services/payrollAnomalyService';

const SEVERITY_STYLE: Record<AnomalySeverity, { bg: string; color: string; label: string }> = {
  CRITICO: { bg: 'var(--danger-muted)', color: 'var(--danger)', label: 'Crítico' },
  ALTO: { bg: 'var(--warning-muted)', color: 'var(--warning)', label: 'Alto' },
  MEDIO: { bg: 'var(--gray-100)', color: 'var(--gray-600)', label: 'Medio' },
};

export default function PayrollAlertsView({ records }: { records: PayrollCostRecord[] }) {
  const anomalies = useMemo(() => detectPayrollAnomalies(records), [records]);

  const counts = useMemo(() => {
    const c: Record<AnomalySeverity, number> = { CRITICO: 0, ALTO: 0, MEDIO: 0 };
    for (const a of anomalies) c[a.severity] += 1;
    return c;
  }, [anomalies]);

  return (
    <div className="space-y-4">
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {(['CRITICO', 'ALTO', 'MEDIO'] as const).map((sev) => {
          const s = SEVERITY_STYLE[sev];
          return (
            <div
              key={sev}
              className="rounded-[var(--radius-lg)] border p-4"
              style={{ borderColor: 'var(--gray-200)', background: s.bg }}
            >
              <p className="text-[11px] font-medium uppercase tracking-wide" style={{ color: s.color }}>
                {s.label}
              </p>
              <p className="text-[22px] font-bold tabular-nums" style={{ color: s.color }}>
                {counts[sev]}
              </p>
            </div>
          );
        })}
      </section>

      {anomalies.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck className="h-6 w-6" />}
          tone="info"
          title="Sin variaciones inusuales detectadas"
          description="No se encontraron desviaciones significativas en las series mensuales de concepto o empresa para el filtro actual."
        />
      ) : (
        <section
          className="rounded-[var(--radius-lg)] border"
          style={{ borderColor: 'var(--gray-200)', background: 'var(--surface)' }}
        >
          <header className="border-b px-4 py-3" style={{ borderColor: 'var(--gray-200)' }}>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--gray-900)' }}>
              Variaciones inusuales
            </h3>
            <p className="text-xs" style={{ color: 'var(--gray-500)' }}>
              z-score del último mes contra la historia previa de cada serie + salto MoM. Los meses
              con carga parcial de TRESS se excluyen.
            </p>
          </header>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead
                className="text-[11px] uppercase tracking-wide"
                style={{ color: 'var(--gray-500)', borderBottom: '1px solid var(--gray-200)' }}
              >
                <tr>
                  <th className="px-3 py-2 text-left">Severidad</th>
                  <th className="px-3 py-2 text-left">Ámbito</th>
                  <th className="px-3 py-2 text-left">Serie</th>
                  <th className="px-3 py-2 text-left">Mes</th>
                  <th className="px-3 py-2 text-right">Monto</th>
                  <th className="px-3 py-2 text-right">Promedio</th>
                  <th className="px-3 py-2 text-left">Señal</th>
                </tr>
              </thead>
              <tbody>
                {anomalies.map((a) => (
                  <AnomalyRow key={`${a.scope}|${a.key}|${a.month}`} anomaly={a} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div
        className="flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
        style={{ borderColor: 'var(--gray-200)', background: 'var(--surface-alt, var(--gray-50))', color: 'var(--gray-600)' }}
      >
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          El API de TRESS entrega nómina agregada por empresa y concepto, sin identidad de empleado,
          puesto ni centro de costo. Por eso las alertas operan a nivel concepto/empresa y no por
          empleado. Para detección por empleado (p. ej. variable+tiempo-extra &gt; sueldo) se requiere
          un endpoint de nómina a nivel empleado.
        </span>
      </div>
    </div>
  );
}

function AnomalyRow({ anomaly }: { anomaly: PayrollAnomaly }) {
  const s = SEVERITY_STYLE[anomaly.severity];
  return (
    <tr style={{ borderBottom: '1px solid var(--gray-100)' }}>
      <td className="px-3 py-2">
        <span
          className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium"
          style={{ background: s.bg, color: s.color }}
        >
          <AlertTriangle className="h-3 w-3" />
          {s.label}
        </span>
      </td>
      <td className="px-3 py-2" style={{ color: 'var(--gray-600)' }}>
        {anomaly.scope === 'concepto' ? 'Concepto' : 'Empresa'}
      </td>
      <td className="px-3 py-2">
        <span className="font-medium" style={{ color: 'var(--gray-900)' }}>{anomaly.label}</span>
      </td>
      <td className="px-3 py-2 tabular-nums" style={{ color: 'var(--gray-600)' }}>{anomaly.month}</td>
      <td className="px-3 py-2 text-right tabular-nums font-medium" style={{ color: 'var(--gray-900)' }}>
        {fmtCompact(anomaly.value)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums" style={{ color: 'var(--gray-500)' }}>
        {fmtCompact(anomaly.mean)}
      </td>
      <td className="px-3 py-2 text-xs" style={{ color: 'var(--gray-600)' }}>{anomaly.reason}</td>
    </tr>
  );
}
