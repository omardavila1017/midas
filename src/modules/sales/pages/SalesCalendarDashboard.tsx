/**
 * Venta — calendario de cuánto se VENDIÓ (no cuánto se cobró).
 *
 * Combina facturado (facturas de cobranza por su fecha de factura) + por
 * facturar (viajes ROL/Especiales ejecutados aún sin factura). Ver
 * `salesCalendarService.ts`. Read-only; agrega sobre los records ya en memoria.
 * Montos en venta NETA (sin IVA). Los datos cubren el rango ya cargado
 * (~último año), así que años anteriores pueden salir vacíos.
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ShoppingCart, FileText, Clock, Info, Download, Building2, Loader2, Tag } from 'lucide-react';
import PageHeader from '../../../components/ui/PageHeader';
import { fmtCurrency, fmtCompact, fmtKpi, todayISO } from '../../../formatters';
import { MONTHS } from '../../../types';
import { useDataWindow } from '../../../contexts/DataWindowContext';
import type { CobranzaPayment, CobranzaRecord, RolRecord, ViajeEspecialRecord, Company } from '../../../services/jde';
import { SEGMENT_UNCLASSIFIED } from '../../../domain/cobranzaSegment';
import {
  aggregateByCompany,
  aggregateByDay,
  aggregateByMonth,
  aggregateBySegment,
  buildSaleEntries,
  entriesForMonth,
  filterEntriesBySegment,
  listVentaSegments,
  saleSourceAttribution,
  SEGMENT_POR_FACTURAR,
  toCsv,
} from '../services/salesCalendarService';
import SourceInfo from '../../../components/ui/SourceInfo';

interface SalesCalendarDashboardProps {
  cobranzaRecords: CobranzaRecord[];
  rolRecords: RolRecord[];
  viajesEspecialesRecords: ViajeEspecialRecord[];
  /** Recibos: ÚNICA fuente del segmento (ver `cobranzaSegment`). */
  cobranzaPayments?: CobranzaPayment[];
  companies: Company[];
}

const WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const FACTURADO_COLOR = 'var(--success)';
const POR_FACTURAR_COLOR = '#d97706';
const ALL_COMPANIES = '__all__';
const ALL_SEGMENTS = '__all__';
// Datasets que Venta necesita para pintar un año (viajes especiales viajan con
// el slot 'rol' en el backfill).
const VENTA_DATASETS = ['cobranza', 'rol'];

function isoKey(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Índice de día de semana (lunes = 0) del primer día del mes. */
function mondayFirstWeekday(year: number, month: number): number {
  const jsDay = new Date(Date.UTC(year, month, 1)).getUTCDay(); // 0=Dom
  return (jsDay + 6) % 7;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function StatusChip({ status }: { status: 'facturado' | 'por-facturar' }) {
  const facturado = status === 'facturado';
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
      style={{
        background: facturado ? 'var(--success-muted, rgba(16,185,129,0.12))' : 'rgba(217,119,6,0.12)',
        color: facturado ? FACTURADO_COLOR : POR_FACTURAR_COLOR,
      }}
    >
      {facturado ? <FileText className="h-3 w-3" strokeWidth={2} /> : <Clock className="h-3 w-3" strokeWidth={2} />}
      {facturado ? 'Facturado' : 'Por facturar'}
    </span>
  );
}

function Kpi({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div
      className="rounded-[var(--radius-lg)] p-4"
      style={{ background: 'var(--card)', border: '1px solid var(--gray-200)' }}
    >
      <p className="text-[11px] font-medium uppercase tracking-[0.06em]" style={{ color: 'var(--gray-500)' }}>
        {label}
      </p>
      <p className="mt-1.5 text-[20px] font-bold leading-tight" style={{ color: accent ?? 'var(--gray-950)' }}>
        {value}
      </p>
    </div>
  );
}

export default function SalesCalendarDashboard({
  cobranzaRecords,
  rolRecords,
  viajesEspecialesRecords,
  cobranzaPayments = [],
  companies,
}: SalesCalendarDashboardProps) {
  const allEntries = useMemo(
    () => buildSaleEntries({
      cobranza: cobranzaRecords,
      rol: rolRecords,
      viajesEspeciales: viajesEspecialesRecords,
      cobranzaPayments,
    }),
    [cobranzaRecords, rolRecords, viajesEspecialesRecords, cobranzaPayments],
  );

  const companyName = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of companies) if (c.cia) map.set(c.cia, c.nombre || c.cia);
    return map;
  }, [companies]);

  // Compañías presentes en las ventas (para el filtro — no mostramos vacías).
  const presentCias = useMemo(() => {
    const set = new Set<string>();
    for (const e of allEntries) if (e.cia) set.add(e.cia);
    return Array.from(set).sort();
  }, [allEntries]);

  const [companyFilter, setCompanyFilter] = useState<string>(ALL_COMPANIES);
  const companyEntries = useMemo(
    () => (companyFilter === ALL_COMPANIES ? allEntries : allEntries.filter((e) => e.cia === companyFilter)),
    [allEntries, companyFilter],
  );

  // Segmento / tipo de servicio (C.1): sólo la capa facturado lo trae. El
  // filtro se pinta cuando el API manda ≥1 segmento clasificado (espejo del
  // gate hasSegments de Cobranza). Las opciones se derivan del scope de la
  // compañía filtrada; si el segmento seleccionado deja de existir en ese
  // scope se resetea — sin esto, cambiar de compañía dejaba el calendario en
  // ceros silenciosos con un filtro heredado imposible de satisfacer.
  const segmentOptions = useMemo(() => listVentaSegments(companyEntries), [companyEntries]);
  const hasSegments = useMemo(
    () => segmentOptions.some((s) => s !== SEGMENT_UNCLASSIFIED),
    [segmentOptions],
  );
  const [segmentFilter, setSegmentFilter] = useState<string>(ALL_SEGMENTS);
  useEffect(() => {
    if (segmentFilter !== ALL_SEGMENTS && !segmentOptions.includes(segmentFilter)) {
      setSegmentFilter(ALL_SEGMENTS);
    }
  }, [segmentFilter, segmentOptions]);

  const entries = useMemo(
    () => filterEntriesBySegment(companyEntries, segmentFilter === ALL_SEGMENTS ? null : segmentFilter),
    [companyEntries, segmentFilter],
  );

  const byDay = useMemo(() => aggregateByDay(entries), [entries]);
  const byMonth = useMemo(() => aggregateByMonth(entries), [entries]);

  const today = todayISO();
  const currentYear = Number(today.slice(0, 4));
  const [year, setYear] = useState(currentYear);
  const [month, setMonth] = useState(Number(today.slice(5, 7)) - 1);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  // Carga diferida: al consultar un año previo al piso por defecto, pide la
  // cobranza/ROL/viajes de ese año bajo demanda (ver DataWindowContext). Venta
  // agrega sobre los records en memoria, así que basta con que lleguen por props.
  const { ensureYearLoaded, isLoadingHistorical } = useDataWindow();
  useEffect(() => {
    ensureYearLoaded(year, VENTA_DATASETS);
  }, [year, ensureYearLoaded]);
  const loadingHistorical = isLoadingHistorical(VENTA_DATASETS);

  // Totales del año seleccionado.
  const yearTotals = useMemo(() => {
    let facturado = 0;
    let porFacturar = 0;
    for (const [ym, m] of byMonth) {
      if (ym.slice(0, 4) === String(year)) {
        facturado += m.facturado;
        porFacturar += m.porFacturar;
      }
    }
    return { facturado, porFacturar, total: facturado + porFacturar };
  }, [byMonth, year]);

  const monthTotals = useMemo(() => {
    const out: number[] = [];
    for (let m = 0; m < 12; m += 1) {
      out.push(byMonth.get(`${year}-${String(m + 1).padStart(2, '0')}`)?.total ?? 0);
    }
    return out;
  }, [byMonth, year]);

  const selectedMonthYm = `${year}-${String(month + 1).padStart(2, '0')}`;
  const selectedMonthTotal = byMonth.get(selectedMonthYm)?.total ?? 0;
  const monthEntries = useMemo(() => entriesForMonth(entries, selectedMonthYm), [entries, selectedMonthYm]);

  // Desglose por compañía del mes seleccionado.
  const companyBreakdown = useMemo(() => aggregateByCompany(monthEntries).slice(0, 8), [monthEntries]);

  // Desglose por segmento del mes seleccionado (C.1).
  const segmentBreakdown = useMemo(() => aggregateBySegment(monthEntries), [monthEntries]);

  // Celdas del calendario del mes seleccionado.
  const grid = useMemo(() => {
    const lead = mondayFirstWeekday(year, month);
    const total = daysInMonth(year, month);
    const cells: ({ day: number; key: string } | null)[] = [];
    for (let i = 0; i < lead; i += 1) cells.push(null);
    for (let d = 1; d <= total; d += 1) cells.push({ day: d, key: isoKey(year, month, d) });
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [year, month]);

  const maxDayTotal = useMemo(() => {
    let max = 0;
    for (const cell of grid) {
      if (!cell) continue;
      const t = byDay.get(cell.key)?.total ?? 0;
      if (t > max) max = t;
    }
    return max;
  }, [grid, byDay]);

  const dayDetail = useMemo(
    () => (selectedDay ? monthEntries.filter((e) => e.date === selectedDay) : []),
    [selectedDay, monthEntries],
  );

  const hasData = allEntries.length > 0;

  const handleExport = () => {
    const scope = entries.filter((e) => e.date.slice(0, 4) === String(year));
    if (scope.length === 0) return;
    const csv = toCsv(scope);
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ventas-${year}${companyFilter === ALL_COMPANIES ? '' : `-${companyFilter}`}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        meta="Ingresos"
        title="Venta"
        subtitle="Calendario de ventas (facturado + por facturar), montos sin IVA. Marca cuánto se vendió, no cuánto se cobró."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {presentCias.length > 1 && (
              <div className="relative">
                <Building2
                  className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2"
                  strokeWidth={1.75}
                  style={{ color: 'var(--gray-400)' }}
                />
                <select
                  value={companyFilter}
                  onChange={(e) => { setCompanyFilter(e.target.value); setSelectedDay(null); }}
                  className="h-9 max-w-[220px] rounded-[var(--radius-md)] border pl-8 pr-2 text-[13px]"
                  style={{ borderColor: 'var(--gray-200)', background: 'var(--input)', color: 'var(--gray-950)' }}
                  aria-label="Filtrar por compañía"
                >
                  <option value={ALL_COMPANIES}>Todas las compañías</option>
                  {presentCias.map((cia) => (
                    <option key={cia} value={cia}>
                      {companyName.get(cia) ?? cia}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {hasSegments && (
              <div className="relative">
                <Tag
                  className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2"
                  strokeWidth={1.75}
                  style={{ color: 'var(--gray-400)' }}
                />
                <select
                  value={segmentFilter}
                  onChange={(e) => { setSegmentFilter(e.target.value); setSelectedDay(null); }}
                  className="h-9 max-w-[220px] rounded-[var(--radius-md)] border pl-8 pr-2 text-[13px]"
                  style={{ borderColor: 'var(--gray-200)', background: 'var(--input)', color: 'var(--gray-950)' }}
                  aria-label="Filtrar por segmento"
                  title="Segmento / tipo de servicio — aplica sólo a lo facturado; los viajes por facturar aún no traen segmento."
                >
                  <option value={ALL_SEGMENTS}>Todos los segmentos</option>
                  {segmentOptions.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            )}
            {segmentFilter !== ALL_SEGMENTS && (
              <span
                className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 py-1 text-[12px] font-medium"
                style={{ background: 'rgba(217,119,6,0.12)', color: POR_FACTURAR_COLOR }}
                title="Un segmento específico sólo puede empatar facturas; los viajes ROL/Especiales por facturar no traen segmento y quedan fuera."
              >
                Sólo facturado
              </span>
            )}
            <button
              type="button"
              onClick={handleExport}
              disabled={!hasData}
              className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-md)] border px-3 text-[13px] font-medium transition-colors hover:bg-[var(--gray-100)] disabled:cursor-not-allowed disabled:opacity-50"
              style={{ borderColor: 'var(--gray-200)', color: 'var(--gray-700)' }}
              title={`Exportar ventas ${year} a CSV`}
            >
              <Download className="h-4 w-4" strokeWidth={1.75} aria-hidden />
              Exportar
            </button>
            {loadingHistorical && (
              <span
                className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 py-1 text-[12px] font-medium"
                style={{ background: 'var(--primary-muted)', color: 'var(--primary)' }}
                role="status"
                aria-live="polite"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} aria-hidden />
                Cargando {year}…
              </span>
            )}
            <div
              className="inline-flex items-center gap-1 rounded-[var(--radius-md)] p-0.5"
              style={{ background: 'var(--gray-100)', border: '1px solid var(--gray-200)' }}
            >
              <button
                type="button"
                onClick={() => { setYear((y) => y - 1); setSelectedDay(null); }}
                className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] transition-colors hover:bg-[var(--card)]"
                aria-label="Año anterior"
              >
                <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
              </button>
              <span className="min-w-[56px] text-center text-[14px] font-semibold" style={{ color: 'var(--gray-950)' }}>
                {year}
              </span>
              <button
                type="button"
                onClick={() => { setYear((y) => y + 1); setSelectedDay(null); }}
                className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] transition-colors hover:bg-[var(--card)]"
                aria-label="Año siguiente"
              >
                <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
              </button>
            </div>
          </div>
        }
      />

      {!hasData ? (
        <div
          className="flex flex-col items-center gap-2 rounded-[var(--radius-lg)] p-10 text-center"
          style={{ background: 'var(--card)', border: '1px solid var(--gray-200)' }}
        >
          <ShoppingCart className="h-8 w-8" strokeWidth={1.5} style={{ color: 'var(--gray-400)' }} />
          <p className="text-[14px] font-medium" style={{ color: 'var(--gray-700)' }}>
            Sin ventas para mostrar
          </p>
          <p className="max-w-sm text-[12px]" style={{ color: 'var(--gray-500)' }}>
            Cuando carguen las facturas de cobranza y los viajes ejecutados, aquí verás el calendario de ventas.
          </p>
        </div>
      ) : (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label={`Vendido ${year}`} value={fmtKpi(yearTotals.total)} />
            <Kpi label="Facturado" value={fmtKpi(yearTotals.facturado)} accent={FACTURADO_COLOR} />
            <Kpi label="Por facturar" value={fmtKpi(yearTotals.porFacturar)} accent={POR_FACTURAR_COLOR} />
            <Kpi label={`Vendido ${MONTHS[month]}`} value={fmtKpi(selectedMonthTotal)} accent="var(--primary)" />
          </div>

          {/* Tira de meses */}
          <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6 lg:grid-cols-12">
            {MONTHS.map((label, m) => {
              const active = m === month;
              const total = monthTotals[m];
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => { setMonth(m); setSelectedDay(null); }}
                  className="flex flex-col items-center gap-0.5 rounded-[var(--radius-md)] border px-1 py-2 text-center transition-colors"
                  style={{
                    borderColor: active ? 'var(--primary)' : 'var(--gray-200)',
                    background: active ? 'var(--primary-muted)' : 'var(--card)',
                  }}
                  aria-current={active ? 'true' : undefined}
                >
                  <span className="text-[12px] font-semibold" style={{ color: active ? 'var(--primary)' : 'var(--gray-700)' }}>
                    {label}
                  </span>
                  <span className="text-[10px] font-medium" style={{ color: 'var(--gray-500)' }}>
                    {total > 0 ? fmtCompact(total) : '—'}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_360px]">
            {/* Calendario */}
            <div
              className="rounded-[var(--radius-lg)] p-4"
              style={{ background: 'var(--card)', border: '1px solid var(--gray-200)' }}
            >
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-[15px] font-semibold" style={{ color: 'var(--gray-950)' }}>
                  {MONTHS[month]} {year}
                </h2>
                <div className="flex items-center gap-3 text-[11px]" style={{ color: 'var(--gray-500)' }}>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm" style={{ background: FACTURADO_COLOR }} /> Facturado
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm" style={{ background: POR_FACTURAR_COLOR }} /> Por facturar
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-7 gap-1">
                {WEEKDAYS.map((w) => (
                  <div
                    key={w}
                    className="pb-1 text-center text-[11px] font-medium uppercase tracking-wide"
                    style={{ color: 'var(--gray-400)' }}
                  >
                    {w}
                  </div>
                ))}
                {grid.map((cell, idx) => {
                  if (!cell) return <div key={`empty-${idx}`} className="aspect-square" />;
                  const day = byDay.get(cell.key);
                  const total = day?.total ?? 0;
                  const isToday = cell.key === today;
                  const isSelected = cell.key === selectedDay;
                  const facturadoPct = total > 0 ? (day!.facturado / total) * 100 : 0;
                  const widthPct = maxDayTotal > 0 ? Math.max(8, (total / maxDayTotal) * 100) : 0;
                  return (
                    <button
                      key={cell.key}
                      type="button"
                      onClick={() => setSelectedDay(total > 0 ? cell.key : null)}
                      className="flex aspect-square flex-col rounded-[var(--radius-md)] border p-1.5 text-left transition-colors"
                      style={{
                        borderColor: isSelected ? 'var(--primary)' : isToday ? 'var(--gray-300)' : 'var(--gray-100)',
                        background: isSelected ? 'var(--primary-muted)' : total > 0 ? 'var(--gray-50)' : 'transparent',
                        cursor: total > 0 ? 'pointer' : 'default',
                      }}
                    >
                      <span
                        className="text-[11px] font-semibold"
                        style={{ color: isToday ? 'var(--primary)' : 'var(--gray-600)' }}
                      >
                        {cell.day}
                      </span>
                      {total > 0 && (
                        <div className="mt-auto">
                          <span className="block truncate text-[10px] font-semibold leading-tight" style={{ color: 'var(--gray-800)' }}>
                            {fmtCompact(total)}
                          </span>
                          <span className="mt-1 flex h-1 overflow-hidden rounded-full" style={{ width: `${widthPct}%`, background: 'var(--gray-200)' }}>
                            <span style={{ width: `${facturadoPct}%`, background: FACTURADO_COLOR }} />
                            <span style={{ width: `${100 - facturadoPct}%`, background: POR_FACTURAR_COLOR }} />
                          </span>
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Desglose por compañía (mes) */}
              {companyFilter === ALL_COMPANIES && companyBreakdown.length > 1 && (
                <div className="mt-4 border-t pt-3" style={{ borderColor: 'var(--gray-100)' }}>
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--gray-400)' }}>
                    Por compañía · {MONTHS[month]}
                  </p>
                  <ul className="space-y-1.5">
                    {companyBreakdown.map((c) => (
                      <li key={c.cia} className="flex items-center justify-between gap-2 text-[12px]">
                        <button
                          type="button"
                          onClick={() => { setCompanyFilter(c.cia); setSelectedDay(null); }}
                          className="min-w-0 flex-1 truncate text-left hover:underline"
                          style={{ color: 'var(--gray-700)' }}
                          title={companyName.get(c.cia) ?? c.cia}
                        >
                          {companyName.get(c.cia) ?? c.cia}
                        </button>
                        <span className="font-semibold" style={{ color: 'var(--gray-900)' }}>{fmtCompact(c.total)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Desglose por segmento (mes) — C.1. Sólo cuando el API manda
                  segmentos; el bucket "Por facturar (sin segmento)" agrupa los
                  viajes aún sin factura (no traen tipo de servicio). */}
              {hasSegments && segmentFilter === ALL_SEGMENTS && segmentBreakdown.length > 0 && (
                <div className="mt-4 border-t pt-3" style={{ borderColor: 'var(--gray-100)' }}>
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--gray-400)' }}>
                    Por segmento · {MONTHS[month]}
                  </p>
                  <ul className="space-y-1.5">
                    {segmentBreakdown.map((s) => {
                      const muted = s.segment === SEGMENT_UNCLASSIFIED || s.segment === SEGMENT_POR_FACTURAR;
                      const filterable = s.segment !== SEGMENT_POR_FACTURAR;
                      return (
                        <li key={s.segment} className="flex items-center justify-between gap-2 text-[12px]">
                          {filterable ? (
                            <button
                              type="button"
                              onClick={() => { setSegmentFilter(s.segment); setSelectedDay(null); }}
                              className="min-w-0 flex-1 truncate text-left hover:underline"
                              style={{ color: muted ? 'var(--gray-500)' : 'var(--gray-700)' }}
                              title={s.segment}
                            >
                              {s.segment}
                            </button>
                          ) : (
                            <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--gray-500)' }} title={s.segment}>
                              {s.segment}
                            </span>
                          )}
                          <span className="font-semibold" style={{ color: muted ? 'var(--gray-600)' : 'var(--gray-900)' }}>
                            {fmtCompact(s.total)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>

            {/* Detalle del día */}
            <div
              className="rounded-[var(--radius-lg)] p-4"
              style={{ background: 'var(--card)', border: '1px solid var(--gray-200)' }}
            >
              {selectedDay && dayDetail.length > 0 ? (
                <>
                  <h3 className="text-[14px] font-semibold" style={{ color: 'var(--gray-950)' }}>
                    Ventas del {selectedDay}
                  </h3>
                  <p className="mt-0.5 text-[12px]" style={{ color: 'var(--gray-500)' }}>
                    {dayDetail.length} {dayDetail.length === 1 ? 'venta' : 'ventas'} ·{' '}
                    {fmtCurrency(dayDetail.reduce((s, e) => s + e.amount, 0))}
                  </p>
                  <ul className="mt-3 max-h-[440px] space-y-2 overflow-y-auto">
                    {dayDetail.map((e, i) => (
                      <li
                        key={`${e.source}-${e.referencia}-${i}`}
                        className="rounded-[var(--radius-md)] border p-2.5"
                        style={{ borderColor: 'var(--gray-100)' }}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-1">
                            <StatusChip status={e.status} />
                            <SourceInfo attribution={saleSourceAttribution(e.source)} />
                          </span>
                          <span className="text-[13px] font-semibold" style={{ color: 'var(--gray-950)' }}>
                            {fmtCurrency(e.amount)}
                          </span>
                        </div>
                        <p className="mt-1.5 truncate text-[12px] font-medium" style={{ color: 'var(--gray-800)' }} title={e.cliente}>
                          {e.cliente || 'Sin cliente'}
                        </p>
                        <p className="truncate text-[11px]" style={{ color: 'var(--gray-500)' }} title={e.referencia}>
                          {e.referencia || '—'}
                        </p>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 py-10 text-center">
                  <Info className="h-6 w-6" strokeWidth={1.5} style={{ color: 'var(--gray-400)' }} />
                  <p className="text-[13px] font-medium" style={{ color: 'var(--gray-600)' }}>
                    Selecciona un día con ventas
                  </p>
                  <p className="max-w-[240px] text-[12px]" style={{ color: 'var(--gray-500)' }}>
                    Toca una celda del calendario para ver el detalle de lo vendido ese día.
                  </p>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
