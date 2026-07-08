/**
 * Sub-pestaña "Periodos" del dashboard de Nómina.
 *
 * Vista de CONCILIACIÓN por periodo/semana pedida en la junta 2026-07-06:
 * Finanzas (Romo) necesita cuadrar la nómina de Midas contra el reporte de
 * egresos de TRESS (sistema 3) de Ricardo, que va POR PERIODO. Hoy Midas solo
 * mostraba el resumen mensual por concepto y no dejaba ver qué periodos cubre
 * el mes (semanas 22–26, quincenas, o los especiales 3xx de despensa/vales/
 * finiquito) ni abrir cada uno con su desglose por concepto.
 *
 * Display-only: NO toca el motor ni la proyección. Reúsa `summarizePeriods`
 * (una fila por periodo con la fórmula del cash neto) y `summarizeByConcept`
 * (desglose por concepto de los records de ESE periodo). El dato de `Periodo`
 * ya llega del API y ya lo guarda el mapper (`payrollPeriod`).
 */

import { useMemo, useState } from 'react';
import { CalendarClock, ChevronDown, ChevronRight, Download } from 'lucide-react';
import { fmtCompact, fmtCurrency } from '../../../formatters';
import EmptyState from '../../shared-finance/components/EmptyState';
import type { PayrollCostRecord } from '../../shared-finance/types';
import {
  filterRecords,
  summarizeByConcept,
  summarizePeriods,
  type PayrollPeriodSummary,
} from '../services/payrollModuleService';

/** Clave estable de un periodo (espejo de la llave de `summarizePeriods`). */
function periodKey(p: PayrollPeriodSummary): string {
  return `${p.cia}|${p.paymentDate}|${p.payrollType}|${p.payrollPeriod}`;
}

/** Rango de fechas del periodo; tolera que falte `FechaInicial` (el API a veces
 *  solo trae `FechaFinal`). */
function periodRange(records: PayrollCostRecord[], p: PayrollPeriodSummary): string {
  const own = records.filter(
    r => r.cia === p.cia && r.paymentDate === p.paymentDate
      && r.payrollType === p.payrollType && String(r.payrollPeriod) === String(p.payrollPeriod),
  );
  const start = own.map(r => r.periodStartDate).find(Boolean);
  const end = own.map(r => r.periodEndDate).find(Boolean);
  const s = start ? start.slice(0, 10) : '';
  const e = end ? end.slice(0, 10) : '';
  if (s && e) return `${s} → ${e}`;
  if (e) return `→ ${e}`;
  if (s) return `${s} →`;
  return '—';
}

/** Orden por número de periodo (numérico primero), luego cía. */
function comparePeriods(a: PayrollPeriodSummary, b: PayrollPeriodSummary): number {
  const na = Number(a.payrollPeriod);
  const nb = Number(b.payrollPeriod);
  const aNum = Number.isFinite(na);
  const bNum = Number.isFinite(nb);
  if (aNum && bNum && na !== nb) return na - nb;
  if (aNum !== bNum) return aNum ? -1 : 1;
  const byPeriod = String(a.payrollPeriod).localeCompare(String(b.payrollPeriod));
  if (byPeriod !== 0) return byPeriod;
  return a.cia.localeCompare(b.cia);
}

const CSV_HEADERS = [
  'Compania', 'Empresa', 'Tipo', 'Periodo', 'Inicio', 'Fin', 'FechaPago',
  'Bruto', 'Deducciones', 'Retenciones', 'Patronal', 'NoCash', 'PagoNeto', 'Conceptos',
];

function buildCsv(records: PayrollCostRecord[], periods: PayrollPeriodSummary[]): string {
  const rows = periods.map((p) => {
    const range = periodRange(records, p).replace(/[→—]/g, '').trim().split(/\s+/);
    const start = range[0] && /\d{4}-\d{2}-\d{2}/.test(range[0]) ? range[0] : '';
    const end = range.reverse().find(x => /\d{4}-\d{2}-\d{2}/.test(x)) ?? '';
    return [
      p.cia, p.empresaNomina, p.payrollType, String(p.payrollPeriod), start, end,
      p.paymentDate?.slice(0, 10) ?? '',
      p.grossEarnings, p.netDeductions, p.withholdings, p.employerTaxes, p.nonCash,
      p.netCashOnPaymentDate, p.conceptCount,
    ]
      .map((v) => {
        const s = String(v ?? '');
        return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      })
      .join(',');
  });
  return `﻿${CSV_HEADERS.join(',')}\n${rows.join('\n')}`;
}

function download(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function PayrollPeriodsView({ records }: { records: PayrollCostRecord[] }) {
  const [periodFilter, setPeriodFilter] = useState<string>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  const periods = useMemo(
    () => summarizePeriods(records).slice().sort(comparePeriods),
    [records],
  );

  // Periodos distintos presentes en el mes (para el cue y el select).
  const distinctPeriods = useMemo(() => {
    const seen = new Map<string, number>();
    for (const p of periods) seen.set(String(p.payrollPeriod), (seen.get(String(p.payrollPeriod)) ?? 0) + 1);
    return Array.from(seen.keys()).sort((a, b) => {
      const na = Number(a); const nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.localeCompare(b);
    });
  }, [periods]);

  const visiblePeriods = useMemo(
    () => (periodFilter === 'all' ? periods : periods.filter(p => String(p.payrollPeriod) === periodFilter)),
    [periods, periodFilter],
  );

  const hasData = records.length > 0;

  if (!hasData) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<CalendarClock className="h-6 w-6" />}
          title="Sin nómina para estos filtros"
          description='Ajusta empresa / tipo / mes o presiona "Refrescar TRESS" para cargar la información.'
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Cue de reconciliación: qué periodos cubre el mes */}
      <div
        className="flex flex-wrap items-center gap-2 rounded-lg border px-4 py-3 text-sm"
        style={{ borderColor: 'var(--gray-200)', background: 'var(--surface)', color: 'var(--gray-700)' }}
      >
        <CalendarClock className="h-4 w-4" style={{ color: 'var(--accent-blue)' }} />
        <span className="font-medium">
          Este mes cubre {distinctPeriods.length} {distinctPeriods.length === 1 ? 'periodo' : 'periodos'}:
        </span>
        <div className="flex flex-wrap gap-1">
          {distinctPeriods.map((per) => (
            <button
              key={per}
              type="button"
              onClick={() => setPeriodFilter(prev => (prev === per ? 'all' : per))}
              className="rounded-md px-2 py-0.5 text-xs font-medium transition"
              style={{
                background: periodFilter === per ? 'var(--accent-blue)' : 'var(--gray-100)',
                color: periodFilter === per ? '#fff' : 'var(--gray-700)',
              }}
            >
              {per}
            </button>
          ))}
        </div>
      </div>

      <section
        className="rounded-lg border"
        style={{ borderColor: 'var(--gray-200)', background: 'var(--surface)' }}
      >
        <header
          className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3"
          style={{ borderColor: 'var(--gray-200)' }}
        >
          <div>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--gray-900)' }}>Periodos de nómina</h3>
            <p className="text-xs" style={{ color: 'var(--gray-500)' }}>
              Un renglón por periodo (compañía · fecha de pago · tipo). Abre un periodo para ver su desglose
              por concepto y cuadrarlo contra el reporte de egresos.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={periodFilter}
              onChange={(e) => setPeriodFilter(e.target.value)}
              className="rounded-md border px-2 py-1.5 text-sm"
              style={{ borderColor: 'var(--gray-300)', background: 'var(--surface)' }}
            >
              <option value="all">Todos los periodos</option>
              {distinctPeriods.map((per) => <option key={per} value={per}>Periodo {per}</option>)}
            </select>
            <button
              type="button"
              onClick={() => download(`nomina-periodos.csv`, buildCsv(records, visiblePeriods))}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition"
              style={{ borderColor: 'var(--gray-300)', background: 'var(--surface)', color: 'var(--gray-700)' }}
            >
              <Download className="h-4 w-4" /> CSV
            </button>
          </div>
        </header>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead
              className="text-[11px] uppercase tracking-wide"
              style={{ color: 'var(--gray-500)', borderBottom: '1px solid var(--gray-200)' }}
            >
              <tr>
                <th className="px-3 py-2 text-left" style={{ width: 28 }} />
                <th className="px-3 py-2 text-left">Compañía</th>
                <th className="px-3 py-2 text-left">Tipo</th>
                <th className="px-3 py-2 text-left">Periodo</th>
                <th className="px-3 py-2 text-left">Rango</th>
                <th className="px-3 py-2 text-left">Fecha pago</th>
                <th className="px-3 py-2 text-right">Bruto</th>
                <th className="px-3 py-2 text-right">Deducciones</th>
                <th className="px-3 py-2 text-right">Retenciones</th>
                <th className="px-3 py-2 text-right">Patronal</th>
                <th className="px-3 py-2 text-right" style={{ color: 'var(--success)' }}>Pago neto</th>
              </tr>
            </thead>
            <tbody>
              {visiblePeriods.map((p) => {
                const key = periodKey(p);
                const isOpen = expanded === key;
                return (
                  <PeriodRows
                    key={key}
                    period={p}
                    range={periodRange(records, p)}
                    open={isOpen}
                    onToggle={() => setExpanded(isOpen ? null : key)}
                    records={records}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function PeriodRows({
  period, range, open, onToggle, records,
}: {
  period: PayrollPeriodSummary;
  range: string;
  open: boolean;
  onToggle: () => void;
  records: PayrollCostRecord[];
}) {
  const concepts = useMemo(() => {
    if (!open) return [];
    const scoped = filterRecords(records, {
      cia: period.cia,
      payrollType: period.payrollType,
      payrollPeriod: period.payrollPeriod,
      paymentDate: period.paymentDate,
    });
    return summarizeByConcept(scoped);
  }, [open, records, period]);

  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer transition hover:bg-[color:var(--gray-50)]"
        style={{ borderBottom: '1px solid var(--gray-100)' }}
      >
        <td className="px-3 py-2" style={{ color: 'var(--gray-500)' }}>
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </td>
        <td className="px-3 py-2">
          <div className="font-medium" style={{ color: 'var(--gray-900)' }}>{period.empresaNomina || period.cia}</div>
          <div className="text-xs" style={{ color: 'var(--gray-500)' }}>{period.cia}</div>
        </td>
        <td className="px-3 py-2">{period.payrollType}</td>
        <td className="px-3 py-2 font-medium">{period.payrollPeriod}</td>
        <td className="px-3 py-2 text-xs" style={{ color: 'var(--gray-600)' }}>{range}</td>
        <td className="px-3 py-2">{period.paymentDate?.slice(0, 10)}</td>
        <td className="px-3 py-2 text-right">{fmtCompact(period.grossEarnings)}</td>
        <td className="px-3 py-2 text-right">{fmtCompact(period.netDeductions)}</td>
        <td className="px-3 py-2 text-right">{fmtCompact(period.withholdings)}</td>
        <td className="px-3 py-2 text-right">{fmtCompact(period.employerTaxes)}</td>
        <td className="px-3 py-2 text-right font-semibold" style={{ color: 'var(--success)' }}>
          {fmtCompact(period.netCashOnPaymentDate)}
        </td>
      </tr>
      {open && (
        <tr style={{ borderBottom: '1px solid var(--gray-200)' }}>
          <td colSpan={11} className="px-3 py-3" style={{ background: 'var(--gray-50)' }}>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--gray-500)' }}>
              Desglose por concepto · Periodo {period.payrollPeriod} · {period.conceptCount} conceptos
            </div>
            <div className="overflow-x-auto rounded-md border" style={{ borderColor: 'var(--gray-200)', background: 'var(--surface)' }}>
              <table className="w-full text-sm">
                <thead
                  className="text-[11px] uppercase tracking-wide"
                  style={{ color: 'var(--gray-500)', borderBottom: '1px solid var(--gray-200)' }}
                >
                  <tr>
                    <th className="px-3 py-2 text-left">Concepto</th>
                    <th className="px-3 py-2 text-left">Tipo</th>
                    <th className="px-3 py-2 text-left">Tratamiento</th>
                    <th className="px-3 py-2 text-right">Monto</th>
                  </tr>
                </thead>
                <tbody>
                  {concepts.map((c) => (
                    <tr key={`${c.conceptId}|${c.conceptName}`} style={{ borderBottom: '1px solid var(--gray-100)' }}>
                      <td className="px-3 py-2">
                        <span className="font-medium" style={{ color: 'var(--gray-900)' }}>{c.conceptName}</span>
                        <span className="ml-1 text-xs" style={{ color: 'var(--gray-500)' }}>#{c.conceptId}</span>
                      </td>
                      <td className="px-3 py-2">{c.conceptType}</td>
                      <td className="px-3 py-2">
                        <span className="rounded-md px-2 py-0.5 text-xs" style={{ background: 'var(--gray-100)', color: 'var(--gray-700)' }}>
                          {c.cashTreatment}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-medium">{fmtCurrency(c.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
