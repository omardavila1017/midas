import { useMemo, useState } from 'react';
import { Client, CashFlowAssumptions, Frequency, CollectionEvent, ConfirmedPayment, eventKey } from '../domain/types';
import { projectYear } from '../domain/collectionEngine';
import { extractPaymentEvents, PaymentEvent } from '../domain/netCashFlowEngine';
import { CXPRecord } from '../domain/persistence';
import { MONTHS } from '../types';
import { Search, Settings2, ChevronDown, Check, X, Download } from 'lucide-react';
import { toCSV, downloadFile } from '../utils/export';

/**
 * Proyección de Cobranza — simplified layout.
 *
 * Design principles:
 *   - One summary row. Everything else is on-demand.
 *   - Two primary views: by month, by client. Detail is expandable.
 *   - Filters collapse when not in use.
 *   - Labels are explicit: "% del total" beats a bare "%".
 */

interface Props {
  clients: Client[];
  assumptions: CashFlowAssumptions;
  onAssumptionsChange: (a: CashFlowAssumptions) => void;
  confirmedPayments: ConfirmedPayment[];
  onConfirm: (p: ConfirmedPayment) => void;
  onUnconfirm: (key: string) => void;
  cxpRecords?: CXPRecord[];
}

type ViewMode = 'month' | 'client' | 'calendar';
type FactorajeFilter = 'all' | 'yes' | 'no';
const FREQUENCIES: Frequency[] = ['Semanal', 'Quincenal', 'Mensual', 'Contado'];
const DOW_HEADERS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const MONTH_NAMES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

export default function CollectionProjection({ clients, assumptions, onAssumptionsChange, confirmedPayments, onConfirm, onUnconfirm, cxpRecords = [] }: Props) {
  const [query, setQuery] = useState('');
  const [freqFilter, setFreqFilter] = useState<Set<Frequency>>(new Set());
  const [factorajeFilter, setFactorajeFilter] = useState<FactorajeFilter>('all');
  const [view, setView] = useState<ViewMode>('calendar');
  const [showSettings, setShowSettings] = useState(false);

  // Filtered clients
  const filteredClients = useMemo(() => {
    return clients.filter(c => {
      if (query && !c.name.toLowerCase().includes(query.toLowerCase())) return false;
      if (freqFilter.size > 0 && !freqFilter.has(c.frequency)) return false;
      if (factorajeFilter === 'yes' && !c.factoraje) return false;
      if (factorajeFilter === 'no' && c.factoraje) return false;
      return true;
    });
  }, [clients, query, freqFilter, factorajeFilter]);

  const events = useMemo(
    () => projectYear(filteredClients, assumptions),
    [filteredClients, assumptions],
  );

  const paymentEvents = useMemo(
    () => extractPaymentEvents(cxpRecords).filter(p => p.date.startsWith(String(assumptions.year))),
    [cxpRecords, assumptions.year],
  );

  const total = events.reduce((a, e) => a + e.amount, 0);
  const avgLag = events.length ? events.reduce((a, e) => a + e.lagDays, 0) / events.length : 0;

  // Empty state
  if (clients.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <h2 className="text-xl font-semibold text-[#1d1d1f]">Sin clientes cargados</h2>
        <p className="text-[13px] text-[#86868b] mt-1 max-w-sm">
          Importa el catálogo en la pestaña Clientes para ver la proyección.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[#1d1d1f] tracking-tight">Proyección de cobranza</h1>
          <p className="text-[13px] text-[#86868b] mt-1">
            La factura nace por ciclo de facturación; luego corre el crédito y el cobro cae en el siguiente día válido del patrón.
          </p>
        </div>
      </header>

      {/* ── Summary strip ─────────────────────────────────── */}
      <div className="bg-white border border-[#d2d2d7]/60 rounded-xl p-5 flex items-end gap-8 animate-card-in stagger-1">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[#86868b]">Total proyectado {assumptions.year}</div>
          <div className="text-3xl font-semibold tabular-nums text-[#1d1d1f] mt-0.5">{fmt(total)}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[#86868b]">Días promedio de lag</div>
          <div className="text-xl font-medium tabular-nums text-[#1d1d1f] mt-0.5">{avgLag.toFixed(1)}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[#86868b]">Clientes</div>
          <div className="text-xl font-medium tabular-nums text-[#1d1d1f] mt-0.5">
            {filteredClients.length}
            {filteredClients.length !== clients.length && (
              <span className="text-[#86868b] text-[13px]"> / {clients.length}</span>
            )}
          </div>
        </div>
        <div className="ml-auto">
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="flex items-center gap-1.5 px-3 h-8 rounded-lg border border-[#d2d2d7] text-[13px] text-[#86868b] hover:text-[#1d1d1f] hover:bg-[#f5f5f7]"
          >
            <Settings2 className="w-3.5 h-3.5" />
            Supuestos
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showSettings ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </div>

      {showSettings && (
        <div className="bg-white border border-[#d2d2d7]/60 rounded-xl p-4 flex gap-6 items-end">
          <Field label="Año">
            <input
              type="number"
              value={assumptions.year}
              onChange={e => onAssumptionsChange({ ...assumptions, year: Number(e.target.value) })}
              className="input w-24"
            />
          </Field>
          <Field label="Cumplimiento global (0–1)">
            <input
              type="number" min={0} max={1} step={0.05}
              value={assumptions.globalCompliance}
              onChange={e => onAssumptionsChange({ ...assumptions, globalCompliance: Number(e.target.value) })}
              className="input w-24"
            />
          </Field>
          <Field label="Días de factoraje">
            <input
              type="number"
              value={assumptions.factorajeDays}
              onChange={e => onAssumptionsChange({ ...assumptions, factorajeDays: Number(e.target.value) })}
              className="input w-24"
            />
          </Field>
        </div>
      )}

      {/* ── Filters ───────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2 items-center animate-card-in stagger-2">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search className="w-4 h-4 text-[#86868b] absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Buscar cliente…"
            className="input pl-9 w-full"
          />
        </div>

        <div className="flex gap-1">
          {FREQUENCIES.map(f => (
            <Chip
              key={f}
              active={freqFilter.has(f)}
              onClick={() => {
                const next = new Set(freqFilter);
                next.has(f) ? next.delete(f) : next.add(f);
                setFreqFilter(next);
              }}
            >{f}</Chip>
          ))}
        </div>

        <select
          value={factorajeFilter}
          onChange={e => setFactorajeFilter(e.target.value as FactorajeFilter)}
          className="input text-[12px] h-8"
        >
          <option value="all">Todos</option>
          <option value="yes">Solo factoraje</option>
          <option value="no">Sin factoraje</option>
        </select>

        {(query || freqFilter.size > 0 || factorajeFilter !== 'all') && (
          <button
            onClick={() => { setQuery(''); setFreqFilter(new Set()); setFactorajeFilter('all'); }}
            className="text-[12px] text-[#0071e3] hover:underline px-2"
          >
            Limpiar filtros
          </button>
        )}
      </div>

      {/* ── View toggle ───────────────────────────────────── */}
      <div className="flex items-center justify-between animate-card-in stagger-3">
        <nav className="flex bg-[#f5f5f7] rounded-full p-0.5 text-[13px]">
          <button
            onClick={() => setView('calendar')}
            className={`px-4 py-1 rounded-full font-medium hover-press ${view === 'calendar' ? 'bg-white text-[#1d1d1f] shadow-sm' : 'text-[#86868b]'}`}
          >Calendario</button>
          <button
            onClick={() => setView('month')}
            className={`px-4 py-1 rounded-full font-medium hover-press ${view === 'month' ? 'bg-white text-[#1d1d1f] shadow-sm' : 'text-[#86868b]'}`}
          >Por mes</button>
          <button
            onClick={() => setView('client')}
            className={`px-4 py-1 rounded-full font-medium hover-press ${view === 'client' ? 'bg-white text-[#1d1d1f] shadow-sm' : 'text-[#86868b]'}`}
          >Por cliente</button>
        </nav>
      </div>

      {/* ── Main view ─────────────────────────────────────── */}
      {view === 'calendar' && (
        <CalendarView
          events={events}
          clients={filteredClients}
          year={assumptions.year}
          confirmedPayments={confirmedPayments}
          onConfirm={onConfirm}
          onUnconfirm={onUnconfirm}
          payments={paymentEvents}
        />
      )}
      {view === 'month' && <MonthView events={events} total={total} />}
      {view === 'client' && <ClientView events={events} clients={filteredClients} total={total} />}

      <DetailView events={events} clients={filteredClients} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Calendar View — month grid with real vs projected tracking
//
// Colors:
//   Green  = confirmed (user clicked checkmark = "sí pagó")
//   Blue   = projected (future, not yet confirmed)
//   Amber  = past-due (date already passed, not confirmed = didn't pay yet)
// ---------------------------------------------------------------------------
function CalendarView({ events, clients, year, confirmedPayments, onConfirm, onUnconfirm, payments }: {
  events: CollectionEvent[];
  clients: Client[];
  year: number;
  confirmedPayments: ConfirmedPayment[];
  onConfirm: (p: ConfirmedPayment) => void;
  onUnconfirm: (key: string) => void;
  payments: PaymentEvent[];
}) {
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return now.getFullYear() === year ? now.getMonth() : 0;
  });
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const byId = new Map(clients.map(c => [c.id, c]));
  const confirmedSet = useMemo(() => new Set(confirmedPayments.map(p => p.key)), [confirmedPayments]);
  const todayISO = new Date().toISOString().slice(0, 10);

  const monthEventsList = useMemo(() => {
    return events.filter(e => {
      const m = Number(e.realDate.slice(5, 7)) - 1;
      return m === month;
    });
  }, [events, month]);

  // Bucket events by real date (ISO string)
  const byDay = useMemo(() => {
    const map: Record<string, CollectionEvent[]> = {};
    for (const e of events) {
      const m = Number(e.realDate.slice(5, 7)) - 1;
      if (m === month) {
        if (!map[e.realDate]) map[e.realDate] = [];
        map[e.realDate].push(e);
      }
    }
    return map;
  }, [events, month]);

  // Pagos by day for this month
  const paymentsByDay = useMemo(() => {
    const map: Record<string, PaymentEvent[]> = {};
    for (const p of payments) {
      const m = Number(p.date.slice(5, 7)) - 1;
      if (m === month) {
        if (!map[p.date]) map[p.date] = [];
        map[p.date].push(p);
      }
    }
    return map;
  }, [payments, month]);

  const monthPagos = Object.values(paymentsByDay).flat().reduce((s, p) => s + p.amount, 0);
  const monthIva = allMonthEventsIvaSum(byDay, byId);
  const monthNeto = (allMonthEventsTotal(byDay)) - monthPagos;

  // Weekly totals for this month
  const weeklyTotals = useMemo(() => {
    const weeks: Record<string, number> = {};
    for (const [date, evts] of Object.entries(byDay)) {
      const d = new Date(date + 'T12:00:00');
      const weekStart = new Date(d);
      weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
      const key = weekStart.toISOString().slice(0, 10);
      weeks[key] = (weeks[key] || 0) + evts.reduce((s, e) => s + e.amount, 0);
    }
    return weeks;
  }, [byDay]);

  const allMonthEvents = Object.values(byDay).flat();
  const monthTotal = allMonthEvents.reduce((s, e) => s + e.amount, 0);
  const monthEvents = allMonthEvents.length;
  const uniqueClients = new Set(allMonthEvents.map(e => e.clientId)).size;

  // Split: confirmed (real) vs projected
  const confirmedTotal = allMonthEvents
    .filter(e => confirmedSet.has(eventKey(e)))
    .reduce((s, e) => s + e.amount, 0);
  const projectedTotal = monthTotal - confirmedTotal;
  const confirmedCount = allMonthEvents.filter(e => confirmedSet.has(eventKey(e))).length;

  // Calendar grid (Monday-start)
  const firstDay = new Date(Date.UTC(year, month, 1));
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  const startPad = (firstDay.getUTCDay() + 6) % 7;
  const days: Date[] = [];
  for (let i = -startPad; i < lastDay.getUTCDate() + (7 - ((lastDay.getUTCDay() + 6) % 7 + 1) % 7); i++) {
    days.push(new Date(Date.UTC(year, month, i + 1)));
  }
  while (days.length % 7 !== 0) days.push(new Date(Date.UTC(year, month, days.length - startPad + 1)));

  const maxDayAmount = Math.max(
    ...Object.values(byDay).map(evts => evts.reduce((s, e) => s + e.amount, 0)),
    1,
  );

  const selectedEvents = selectedDay ? (byDay[selectedDay] || []) : [];
  const selectedTotal = selectedEvents.reduce((s, e) => s + e.amount, 0);

  const prevMonth = () => { setMonth(m => m <= 0 ? 11 : m - 1); setSelectedDay(null); };
  const nextMonth = () => { setMonth(m => m >= 11 ? 0 : m + 1); setSelectedDay(null); };

  const handleExport = () => {
    const rows = monthEventsList.map(e => {
      const c = byId.get(e.clientId);
      return {
        Cliente: c?.name ?? e.clientId,
        'Fecha Cobro': e.realDate,
        'Fecha Factura': e.invoiceDate,
        Monto: e.amount,
        'Días Lag': e.lagDays,
        'Regla Pago': c?.paymentDayRaw ?? '',
        Confirmado: confirmedSet.has(eventKey(e)) ? 'Sí' : 'No',
      };
    });
    downloadFile(toCSV(rows), `cobranza-${year}-${String(month + 1).padStart(2, '0')}.csv`);
  };

  return (
    <div className="space-y-4">
      {/* Month summary cards */}
      <div className="grid grid-cols-4 gap-4 animate-card-in stagger-4">
        <div className="bg-white border border-[#d2d2d7]/60 rounded-xl p-4 hover-lift">
          <div className="text-[11px] uppercase tracking-wide text-[#86868b]">Cobranza total</div>
          <div className="text-2xl font-semibold tabular-nums text-[#1d1d1f] mt-1">{fmt(monthTotal)}</div>
          <div className="text-[12px] text-[#86868b] mt-0.5">{monthEvents} pagos · {uniqueClients} clientes</div>
        </div>
        <div className="bg-white border border-[#34c759]/40 rounded-xl p-4 hover-lift">
          <div className="text-[11px] uppercase tracking-wide text-[#34c759]">Cobrado (real)</div>
          <div className="text-2xl font-semibold tabular-nums text-[#34c759] mt-1">{fmt(confirmedTotal)}</div>
          <div className="text-[12px] text-[#86868b] mt-0.5">{confirmedCount} pagos confirmados</div>
        </div>
        <div className="bg-white border border-[#0071e3]/30 rounded-xl p-4 hover-lift">
          <div className="text-[11px] uppercase tracking-wide text-[#0071e3]">Proyectado</div>
          <div className="text-2xl font-semibold tabular-nums text-[#0071e3] mt-1">{fmt(projectedTotal)}</div>
          <div className="text-[12px] text-[#86868b] mt-0.5">{monthEvents - confirmedCount} pendientes</div>
        </div>
        <div className="bg-white border border-[#d2d2d7]/60 rounded-xl p-4 hover-lift">
          <div className="text-[11px] uppercase tracking-wide text-[#86868b]">% Avance</div>
          <div className="text-2xl font-semibold tabular-nums text-[#1d1d1f] mt-1">
            {monthTotal > 0 ? `${((confirmedTotal / monthTotal) * 100).toFixed(0)}%` : '—'}
          </div>
          <div className="mt-1.5 h-2 bg-[#f5f5f7] rounded-full overflow-hidden">
            <div className="h-full bg-[#34c759] rounded-full transition-all" style={{ width: `${monthTotal > 0 ? (confirmedTotal / monthTotal) * 100 : 0}%` }} />
          </div>
        </div>
      </div>

      {/* Calendar header */}
      <div className="flex items-center justify-between">
        <button onClick={prevMonth} className="p-2 rounded-lg hover:bg-[#f5f5f7] transition-colors hover-press">
          <svg className="w-5 h-5 text-[#86868b]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        </button>
        <h2 className="text-lg font-semibold text-[#1d1d1f]">{MONTH_NAMES[month]} {year}</h2>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleExport}
            title="Exportar mes"
            className="p-1.5 rounded-lg hover:bg-[#f5f5f7] text-[#86868b] hover:text-[#1d1d1f] transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          <button onClick={nextMonth} className="p-2 rounded-lg hover:bg-[#f5f5f7] transition-colors hover-press">
            <svg className="w-5 h-5 text-[#86868b]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
          </button>
        </div>
      </div>

      {/* Calendar grid */}
      <div className="bg-white border border-[#d2d2d7]/60 rounded-xl overflow-hidden animate-card-in stagger-5">
        <div className="grid grid-cols-7 border-b border-[#d2d2d7]/40">
          {DOW_HEADERS.map(d => (
            <div key={d} className="px-2 py-2 text-center text-[11px] font-medium text-[#86868b] bg-[#fbfbfd] uppercase tracking-wide">{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((d, i) => {
            const iso = d.toISOString().slice(0, 10);
            const isCurrentMonth = d.getUTCMonth() === month;
            const dayEvents = byDay[iso] || [];
            const dayTotal = dayEvents.reduce((s, e) => s + e.amount, 0);
            const intensity = dayTotal > 0 ? Math.max(0.08, Math.min(0.85, dayTotal / maxDayAmount)) : 0;
            const isWeekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
            const isToday = iso === todayISO;
            const isSelected = selectedDay === iso;
            const isPast = iso < todayISO;

            // Color logic per day
            const dayConfirmed = dayEvents.filter(e => confirmedSet.has(eventKey(e)));
            const dayPending = dayEvents.filter(e => !confirmedSet.has(eventKey(e)));
            const allConfirmed = dayEvents.length > 0 && dayConfirmed.length === dayEvents.length;
            const someConfirmed = dayConfirmed.length > 0 && dayPending.length > 0;
            const hasPastDue = isPast && dayPending.length > 0;

            // Pick dominant color for the pill
            let pillBg: string, pillFg: string;
            if (allConfirmed) {
              // All paid → green
              pillBg = `rgba(52, 199, 89, ${intensity + 0.15})`;
              pillFg = intensity > 0.35 ? 'white' : '#15803d';
            } else if (hasPastDue && dayConfirmed.length === 0) {
              // All past-due → amber
              pillBg = `rgba(255, 159, 10, ${intensity + 0.1})`;
              pillFg = intensity > 0.35 ? 'white' : '#92400e';
            } else if (someConfirmed) {
              // Mix → split indicator
              pillBg = `rgba(0, 113, 227, ${intensity})`;
              pillFg = intensity > 0.45 ? 'white' : '#0071e3';
            } else {
              // Future projected → blue
              pillBg = `rgba(0, 113, 227, ${intensity})`;
              pillFg = intensity > 0.45 ? 'white' : '#0071e3';
            }

            return (
              <div
                key={i}
                className={`min-h-[84px] border-b border-r border-[#d2d2d7]/30 p-1.5 cursor-pointer transition-all duration-150
                  ${!isCurrentMonth ? 'bg-[#fbfbfd] opacity-30' : ''}
                  ${isWeekend && isCurrentMonth ? 'bg-[#fbfbfd]' : ''}
                  ${isSelected ? 'ring-2 ring-[#0071e3] ring-inset' : ''}
                  ${isToday && !isSelected ? 'ring-2 ring-[#34c759] ring-inset' : ''}
                  ${isCurrentMonth ? 'hover:bg-[#f5f5f7]/60' : ''}
                `}
                onClick={() => isCurrentMonth && setSelectedDay(isSelected ? null : iso)}
              >
                <div className="flex justify-between items-start">
                  <span className={`text-[12px] font-medium ${
                    isToday
                      ? 'bg-[#34c759] text-white w-5 h-5 rounded-full flex items-center justify-center text-[11px]'
                      : isCurrentMonth ? 'text-[#1d1d1f]' : 'text-[#d2d2d7]'
                  }`}>
                    {d.getUTCDate()}
                  </span>
                  {dayEvents.length > 0 && (
                    <div className="flex items-center gap-0.5">
                      {allConfirmed && <Check className="w-3 h-3 text-[#34c759]" />}
                      {hasPastDue && !allConfirmed && <span className="w-1.5 h-1.5 rounded-full bg-[#ff9f0a]" />}
                      <span className="text-[10px] text-[#86868b]">{dayEvents.length}</span>
                    </div>
                  )}
                </div>
                {dayTotal > 0 && isCurrentMonth && (
                  <div className="mt-1">
                    <div className="rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums" style={{ backgroundColor: pillBg, color: pillFg }}>
                      {dayTotal >= 1_000_000 ? `${(dayTotal / 1_000_000).toFixed(1)}M` : dayTotal >= 1000 ? `${Math.round(dayTotal / 1000)}K` : fmt(dayTotal)}
                    </div>
                    {someConfirmed && (
                      <div className="flex gap-0.5 mt-0.5">
                        <div className="h-1 rounded-full bg-[#34c759] flex-1" style={{ flex: dayConfirmed.length }} />
                        <div className={`h-1 rounded-full ${hasPastDue ? 'bg-[#ff9f0a]' : 'bg-[#0071e3]'} flex-1`} style={{ flex: dayPending.length }} />
                      </div>
                    )}
                    {!someConfirmed && dayEvents.length <= 3 && (
                      <div className="mt-0.5">
                        {dayEvents.slice(0, 2).map((e, j) => (
                          <div key={j} className="text-[10px] text-[#86868b] truncate leading-tight">
                            {byId.get(e.clientId)?.name.split(' ')[0] ?? '?'}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Day detail panel */}
      {selectedDay && selectedEvents.length > 0 && (
        <div className="bg-white border border-[#d2d2d7]/60 rounded-xl p-4 animate-slide-down">
          <div className="flex justify-between items-center mb-3">
            <h3 className="font-semibold text-[14px] text-[#1d1d1f]">
              {new Date(selectedDay + 'T12:00:00').toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })}
            </h3>
            <span className="text-lg font-semibold tabular-nums text-[#0071e3]">{fmt(selectedTotal)}</span>
          </div>
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {selectedEvents.sort((a, b) => b.amount - a.amount).map((e, i) => {
              const c = byId.get(e.clientId);
              const key = eventKey(e);
              const isConfirmed = confirmedSet.has(key);
              const isPastDue = !isConfirmed && e.realDate < todayISO;
              const rowBg = isConfirmed
                ? 'bg-[#34c759]/10 border border-[#34c759]/30'
                : isPastDue
                  ? 'bg-[#ff9500]/10 border border-[#ff9500]/30'
                  : 'bg-[#f5f5f7] border border-transparent';
              return (
                <div key={i} className={`flex items-center gap-2 py-2 px-3 rounded-lg ${rowBg} hover:brightness-95 transition-all`}>
                  {/* Confirm / Unconfirm toggle */}
                  <button
                    onClick={() => {
                      if (isConfirmed) {
                        onUnconfirm(key);
                      } else {
                        onConfirm({
                          key,
                          clientId: e.clientId,
                          realDate: e.realDate,
                          invoiceDate: e.invoiceDate,
                          amount: e.amount,
                          confirmedAt: new Date().toISOString(),
                        });
                      }
                    }}
                    title={isConfirmed ? 'Desmarcar cobro' : 'Marcar como cobrado'}
                    className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center transition-all ${
                      isConfirmed
                        ? 'bg-[#34c759] text-white shadow-sm shadow-[#34c759]/30'
                        : isPastDue
                          ? 'border-2 border-[#ff9500] text-[#ff9500] hover:bg-[#ff9500] hover:text-white'
                          : 'border-2 border-[#d2d2d7] text-[#d2d2d7] hover:border-[#0071e3] hover:text-[#0071e3]'
                    }`}
                  >
                    {isConfirmed ? <Check className="w-3.5 h-3.5" strokeWidth={3} /> : <span className="w-2 h-2" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-[#1d1d1f] truncate">{c?.name ?? e.clientId}</div>
                    <div className="text-[11px] text-[#86868b]">
                      {c?.paymentDayRaw ?? '—'} · {c?.creditDays}d crédito
                      {e.lagDays > 0 && <span className="text-[#ff3b30] font-medium"> (+{e.lagDays}d lag)</span>}
                      {isConfirmed && <span className="text-[#34c759] font-medium"> · Cobrado ✓</span>}
                      {isPastDue && <span className="text-[#ff9500] font-medium"> · Vencido</span>}
                    </div>
                  </div>
                  <div className="text-right ml-3">
                    <div className={`text-[13px] font-semibold tabular-nums ${isConfirmed ? 'text-[#34c759]' : 'text-[#1d1d1f]'}`}>{fmt(e.amount)}</div>
                    <div className="text-[10px] text-[#86868b]">Fact: {e.invoiceDate.slice(5)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Weekly breakdown */}
      {Object.keys(weeklyTotals).length > 0 && (
        <div className="bg-white border border-[#d2d2d7]/60 rounded-xl p-4 hover-lift">
          <h3 className="text-[13px] font-semibold text-[#1d1d1f] mb-3">Cobranza semanal</h3>
          <div className="space-y-2">
            {Object.entries(weeklyTotals).sort(([a], [b]) => a.localeCompare(b)).map(([week, total]) => {
              const pct = monthTotal ? (total / monthTotal) * 100 : 0;
              return (
                <div key={week} className="grid grid-cols-[90px_1fr_100px_50px] items-center gap-3">
                  <span className="text-[12px] text-[#86868b]">
                    Sem. {new Date(week + 'T12:00:00').toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })}
                  </span>
                  <div className="h-5 bg-[#f5f5f7] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-[#0071e3] to-[#40a9ff] rounded-full transition-all"
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>
                  <span className="text-[13px] font-medium tabular-nums text-right">{fmt(total)}</span>
                  <span className="text-[11px] text-[#86868b] text-right">{pct.toFixed(0)}%</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function MonthView({ events, total }: { events: CollectionEvent[]; total: number }) {
  const monthly = new Array(12).fill(0);
  for (const e of events) monthly[Number(e.realDate.slice(5, 7)) - 1] += e.amount;
  const max = Math.max(...monthly, 1);

  return (
    <div className="bg-white border border-[#d2d2d7]/60 rounded-xl p-5 hover-lift animate-card-in stagger-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[13px] font-semibold text-[#1d1d1f]">Entrada de efectivo por mes</h3>
        <span className="text-[12px] text-[#86868b]">
          Barra = monto del mes · % = participación sobre el total anual
        </span>
      </div>
      <div className="space-y-2.5">
        {MONTHS.map((m, i) => {
          const v = monthly[i];
          const pct = (v / max) * 100;
          const share = total ? (v / total) * 100 : 0;
          return (
            <div key={m} className="grid grid-cols-[44px_1fr_140px_90px] items-center gap-3 text-[13px]">
              <span className="text-[#86868b] font-medium">{m}</span>
              <div className="h-7 bg-[#f5f5f7] rounded-md relative overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 bg-gradient-to-r from-[#0071e3] to-[#40a9ff] rounded-md"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-right tabular-nums font-medium text-[#1d1d1f]">{fmt(v)}</span>
              <span className="text-right text-[#86868b] tabular-nums text-[12px]">
                {share.toFixed(1)}% del total
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-4 pt-3 border-t border-[#d2d2d7]/40 flex justify-between text-[13px]">
        <span className="text-[#86868b]">Total anual</span>
        <span className="font-semibold tabular-nums">{fmt(total)}</span>
      </div>
    </div>
  );
}

function ClientView({ events, clients, total }: { events: CollectionEvent[]; clients: Client[]; total: number }) {
  const agg = new Map<string, { total: number; count: number; lag: number }>();
  for (const e of events) {
    const prev = agg.get(e.clientId) ?? { total: 0, count: 0, lag: 0 };
    agg.set(e.clientId, {
      total: prev.total + e.amount,
      count: prev.count + 1,
      lag: prev.lag + e.lagDays,
    });
  }
  const rows = clients
    .map(c => {
      const a = agg.get(c.id);
      return {
        c,
        total: a?.total ?? 0,
        count: a?.count ?? 0,
        avgLag: a && a.count ? a.lag / a.count : 0,
      };
    })
    .filter(r => r.total > 0)
    .sort((a, b) => b.total - a.total);

  const maxTotal = rows[0]?.total ?? 1;

  return (
    <div className="bg-white border border-[#d2d2d7]/60 rounded-xl overflow-hidden hover-lift animate-card-in stagger-5">
      <div className="px-5 py-3 border-b border-[#d2d2d7]/40 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-[#1d1d1f]">Ranking por cliente</h3>
        <span className="text-[12px] text-[#86868b]">Ordenado por monto proyectado</span>
      </div>
      <table className="w-full text-[13px]">
        <thead className="bg-[#fbfbfd] text-[#86868b] text-left text-[11px] uppercase tracking-wide">
          <tr>
            <th className="px-5 py-2.5 font-medium">Cliente</th>
            <th className="px-3 py-2.5 font-medium text-right">Eventos</th>
            <th className="px-3 py-2.5 font-medium text-right">Lag</th>
            <th className="px-3 py-2.5 font-medium">Monto</th>
            <th className="px-5 py-2.5 font-medium text-right">% del total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ c, total: rowTotal, count, avgLag }) => {
            const pct = (rowTotal / maxTotal) * 100;
            const share = total ? (rowTotal / total) * 100 : 0;
            return (
              <tr key={c.id} className="border-t border-[#d2d2d7]/40 hover-row">
                <td className="px-5 py-2.5">
                  <div className="flex items-center gap-2">
                    {c.factoraje && (
                      <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">F</span>
                    )}
                    <span className="text-[#1d1d1f]">{c.name}</span>
                    <span className="text-[11px] text-[#86868b]">· {c.frequency}</span>
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-[#86868b]">{count}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-[#86868b]">{avgLag.toFixed(0)}d</td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="h-2 bg-[#f5f5f7] rounded-full flex-1 min-w-[80px] overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-[#0071e3] to-[#40a9ff] rounded-full"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="tabular-nums font-medium w-20 text-right">{fmt(rowTotal)}</span>
                  </div>
                </td>
                <td className="px-5 py-2.5 text-right tabular-nums text-[#86868b] text-[12px]">
                  {share.toFixed(1)}%
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr><td colSpan={5} className="text-center text-[#86868b] py-10">Sin datos con los filtros actuales.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function DetailView({ events, clients }: { events: CollectionEvent[]; clients: Client[] }) {
  const byId = new Map(clients.map(c => [c.id, c]));
  const sorted = [...events].sort((a, b) =>
    a.realDate.localeCompare(b.realDate) ||
    a.invoiceDate.localeCompare(b.invoiceDate) ||
    a.clientId.localeCompare(b.clientId),
  );
  return (
    <div className="bg-white border border-[#d2d2d7]/60 rounded-xl overflow-hidden hover-lift">
      <div className="px-4 py-3 border-b border-[#d2d2d7]/40 flex items-center justify-between">
        <div>
          <h3 className="text-[13px] font-semibold text-[#1d1d1f]">Detalle de eventos</h3>
          <p className="text-[12px] text-[#86868b] mt-0.5">
            Secuencia auditada: fecha de factura, fecha teórica por crédito y fecha real de cobro.
          </p>
        </div>
        <span className="text-[12px] text-[#86868b]">{Math.min(sorted.length, 1000).toLocaleString('es-MX')} eventos</span>
      </div>
      <div className="max-h-[560px] overflow-y-auto">
        <table className="w-full text-[13px]">
          <thead className="bg-[#f5f5f7] text-[#86868b] text-left sticky top-0">
            <tr>
              <th className="px-4 py-2">Cliente</th>
              <th className="px-4 py-2">Factura</th>
              <th className="px-4 py-2">Teórica</th>
              <th className="px-4 py-2">Real</th>
              <th className="px-4 py-2 text-right">Lag</th>
              <th className="px-4 py-2">Sem</th>
              <th className="px-4 py-2 text-center">F</th>
              <th className="px-4 py-2 text-right">Monto</th>
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, 1000).map((e, i) => {
              const c = byId.get(e.clientId);
              return (
                <tr key={i} className="border-t border-[#d2d2d7]/40 hover-row">
                  <td className="px-4 py-2">{c?.name ?? e.clientId}</td>
                  <td className="px-4 py-2 text-[#86868b]">{e.invoiceDate}</td>
                  <td className="px-4 py-2 text-[#86868b]">{e.theoreticalDate}</td>
                  <td className="px-4 py-2 font-medium">{e.realDate}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{e.lagDays}d</td>
                  <td className="px-4 py-2">S{e.isoWeek}</td>
                  <td className="px-4 py-2 text-center">
                    {c?.factoraje && <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">F</span>}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmt(e.amount)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {sorted.length > 1000 && (
        <div className="px-4 py-2 text-[12px] text-[#86868b] bg-[#f5f5f7] border-t border-[#d2d2d7]/40">
          Mostrando 1,000 de {sorted.length} eventos. Filtra para reducir.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function Chip({
  children, active, onClick, disabled,
}: { children: React.ReactNode; active?: boolean; onClick?: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-3 h-8 rounded-full text-[12px] font-medium border transition-colors hover-press ${
        disabled ? 'opacity-40 cursor-not-allowed border-[#d2d2d7]' :
        active ? 'bg-[#0071e3] text-white border-[#0071e3]' :
        'bg-white text-[#86868b] border-[#d2d2d7] hover:text-[#1d1d1f]'
      }`}
    >{children}</button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[12px] text-[#86868b]">
      <span>{label}</span>
      {children}
    </label>
  );
}

function fmt(n: number): string {
  return n.toLocaleString('es-MX', { maximumFractionDigits: 0 });
}
