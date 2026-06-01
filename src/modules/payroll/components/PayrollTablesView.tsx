/**
 * Sub-pestaña "Detalle" del dashboard de Nómina.
 *
 * Conserva las tablas operativas originales (periodos de pago + top conceptos)
 * que ya existían en el dashboard, sin cambios de fórmula. Es la vista cruda
 * que respalda los gráficos de las demás sub-pestañas.
 */

import { useMemo } from 'react';
import { Calendar } from 'lucide-react';
import { fmtCompact, fmtCurrency } from '../../../formatters';
import EmptyState from '../../shared-finance/components/EmptyState';
import type { PayrollCostRecord } from '../../shared-finance/types';
import { summarizeByConcept, summarizePeriods } from '../services/payrollModuleService';

export default function PayrollTablesView({ records }: { records: PayrollCostRecord[] }) {
  const periods = useMemo(() => summarizePeriods(records), [records]);
  const topConcepts = useMemo(() => summarizeByConcept(records).slice(0, 12), [records]);
  const hasData = records.length > 0;

  return (
    <div className="space-y-6">
      <section
        className="rounded-lg border"
        style={{ borderColor: 'var(--gray-200)', background: 'var(--surface)' }}
      >
        <header className="border-b px-4 py-3" style={{ borderColor: 'var(--gray-200)' }}>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--gray-900)' }}>Periodos de pago</h3>
          <p className="text-xs" style={{ color: 'var(--gray-500)' }}>
            Agrupado por (compañía, fecha de pago, periodo). El cash neto es lo que sale del banco al
            empleado el día de pago.
          </p>
        </header>
        {!hasData ? (
          <div className="p-6">
            <EmptyState
              icon={<Calendar className="h-6 w-6" />}
              title="Sin datos para estos filtros"
              description='Ajusta los filtros o presiona "Refrescar TRESS" para cargar la información.'
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead
                className="text-[11px] uppercase tracking-wide"
                style={{ color: 'var(--gray-500)', borderBottom: '1px solid var(--gray-200)' }}
              >
                <tr>
                  <th className="px-3 py-2 text-left">Compañía</th>
                  <th className="px-3 py-2 text-left">Tipo</th>
                  <th className="px-3 py-2 text-left">Periodo</th>
                  <th className="px-3 py-2 text-left">Fecha pago</th>
                  <th className="px-3 py-2 text-right">Bruto</th>
                  <th className="px-3 py-2 text-right">Deducciones</th>
                  <th className="px-3 py-2 text-right">Retenciones</th>
                  <th className="px-3 py-2 text-right">Patronal</th>
                  <th className="px-3 py-2 text-right" style={{ color: 'var(--success)' }}>Pago neto</th>
                </tr>
              </thead>
              <tbody>
                {periods.map((p) => (
                  <tr
                    key={`${p.cia}|${p.paymentDate}|${p.payrollType}|${p.payrollPeriod}`}
                    style={{ borderBottom: '1px solid var(--gray-100)' }}
                  >
                    <td className="px-3 py-2">
                      <div className="font-medium" style={{ color: 'var(--gray-900)' }}>{p.empresaNomina || p.cia}</div>
                      <div className="text-xs" style={{ color: 'var(--gray-500)' }}>{p.cia}</div>
                    </td>
                    <td className="px-3 py-2">{p.payrollType}</td>
                    <td className="px-3 py-2">{p.payrollPeriod}</td>
                    <td className="px-3 py-2">{p.paymentDate}</td>
                    <td className="px-3 py-2 text-right">{fmtCompact(p.grossEarnings)}</td>
                    <td className="px-3 py-2 text-right">{fmtCompact(p.netDeductions)}</td>
                    <td className="px-3 py-2 text-right">{fmtCompact(p.withholdings)}</td>
                    <td className="px-3 py-2 text-right">{fmtCompact(p.employerTaxes)}</td>
                    <td className="px-3 py-2 text-right font-semibold" style={{ color: 'var(--success)' }}>
                      {fmtCompact(p.netCashOnPaymentDate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {hasData && (
        <section
          className="rounded-lg border"
          style={{ borderColor: 'var(--gray-200)', background: 'var(--surface)' }}
        >
          <header className="border-b px-4 py-3" style={{ borderColor: 'var(--gray-200)' }}>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--gray-900)' }}>Top conceptos (por monto)</h3>
            <p className="text-xs" style={{ color: 'var(--gray-500)' }}>
              Los 12 conceptos con mayor monto absoluto en el filtro actual.
            </p>
          </header>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead
                className="text-[11px] uppercase tracking-wide"
                style={{ color: 'var(--gray-500)', borderBottom: '1px solid var(--gray-200)' }}
              >
                <tr>
                  <th className="px-3 py-2 text-left">Concepto</th>
                  <th className="px-3 py-2 text-left">Tipo</th>
                  <th className="px-3 py-2 text-left">Tratamiento cash</th>
                  <th className="px-3 py-2 text-right">Ocurrencias</th>
                  <th className="px-3 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {topConcepts.map((c) => (
                  <tr key={`${c.conceptId}|${c.conceptName}`} style={{ borderBottom: '1px solid var(--gray-100)' }}>
                    <td className="px-3 py-2">
                      <div className="font-medium" style={{ color: 'var(--gray-900)' }}>{c.conceptName}</div>
                      <div className="text-xs" style={{ color: 'var(--gray-500)' }}>#{c.conceptId}</div>
                    </td>
                    <td className="px-3 py-2">{c.conceptType}</td>
                    <td className="px-3 py-2">
                      <span className="rounded-md px-2 py-0.5 text-xs" style={{ background: 'var(--gray-100)', color: 'var(--gray-700)' }}>
                        {c.cashTreatment}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">{c.occurrences}</td>
                    <td className="px-3 py-2 text-right font-medium">{fmtCurrency(c.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
