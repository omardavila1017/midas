import { useEffect, useMemo, useState } from 'react';
import { Client, CashFlowAssumptions, Frequency, CollectionEvent, ConfirmedPayment, eventKey } from '../domain/types';
import { projectYear } from '../domain/collectionEngine';
import { extractPaymentEvents, PaymentEvent } from '../domain/netCashFlowEngine';
import { reconcileCollections, buildReconciliationMap, type ReconciliationMatch, type ReconciliationSummary } from '../domain/reconciliationEngine';
import { CXPRecord } from '../domain/persistence';
import type { BankAccountStatement } from '../services/jde';
import { MONTHS } from '../types';
import { Search, Settings2, ChevronDown, Check, Download, Landmark, ArrowRightLeft, CheckCircle2, AlertTriangle, HelpCircle, Banknote } from 'lucide-react';
import { toCSV, downloadFile } from '../utils/export';
import { hex } from '../theme';
import { fmtCurrency } from '../formatters';

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
  bankStatements?: BankAccountStatement[];
  companies?: { cia: string; nombre: string }[];
}

type ViewMode = 'month' | 'client' | 'calendar';
type FactorajeFilter = 'all' | 'yes' | 'no';

const FREQUENCIES: Frequency[] = ['Semanal', 'Quincenal', 'Mensual', 'Contado'];
const DOW_HEADERS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const MONTH_NAMES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

function defaultActiveMonth(year: number): number {
  const now = new Date();
  return now.getFullYear() === year ? now.getMonth() : 0;
}

export default function CollectionProjection({ clients, assumptions, onAssumptionsChange, confirmedPayments, onConfirm, onUnconfirm, cxpRecords = [], bankStatements = [], companies = [] }: Props) {
  const [query, setQuery] = useState('');
  const [freqFilter, setFreqFilter] = useState<Set<Frequency>>(new Set());
  const [factorajeFilter, setFactorajeFilter] = useState<FactorajeFilter>('all');
  const [view, setView] = useState<ViewMode>('calendar');
  const [showSettings, setShowSettings] = useState(false);
  const [activeMonth, setActiveMonth] = useState(() => defaultActiveMonth(assumptions.year));

  useEffect(() => {
    setActiveMonth(defaultActiveMonth(assumptions.year));
  }, [assumptions.year]);

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

  // ── Bank real data ──
  const ciaNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of companies) map.set(c.cia, c.nombre);
    return map;
  }, [companies]);

  const bankRealAbonos = useMemo(() => {
    return bankStatements.reduce((sum, acc) =>
      sum + acc.movimientos
        .filter(m => m.tipoMovimiento === 'ABONO')
        .reduce((s, m) => s + m.importe, 0), 0);
  }, [bankStatements]);

  const totalBankSaldo = useMemo(() => {
    return bankStatements.reduce((sum, acc) => sum + (acc.saldoFinal ?? acc.saldoInicial ?? 0), 0);
  }, [bankStatements]);

  // Empty state
  if (clients.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <h2 className="text-xl font-semibold text-[var(--gray-950)]">Sin clientes cargados</h2>
        <p className="text-[13px] text-[var(--gray-400)] mt-1 max-w-sm">
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
          <h1 className="text-2xl font-semibold text-[var(--gray-950)] tracking-tight">Proyección de cobranza</h1>
          <p className="text-[13px] text-[var(--gray-400)] mt-1">
            La factura nace por ciclo de facturación; luego corre el crédito y el cobro cae en el siguiente día válido del patrón.
          </p>
        </div>
      </header>

      {/* ── Summary strip ─────────────────────────────────── */}
      <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl p-5 flex items-end gap-8 animate-card-in stagger-1">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Total proyectado {assumptions.year}</div>
          <div className="text-3xl font-semibold tabular-nums text-[var(--gray-950)] mt-0.5">{fmtCurrency(total)}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Días promedio de lag</div>
          <div className="text-xl font-medium tabular-nums text-[var(--gray-950)] mt-0.5">{avgLag.toFixed(1)}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Clientes</div>
          <div className="text-xl font-medium tabular-nums text-[var(--gray-950)] mt-0.5">
            {filteredClients.length}
            {filteredClients.length !== clients.length && (
              <span className="text-[var(--gray-400)] text-[13px]"> / {clients.length}</span>
            )}
          </div>
        </div>
        <div className="ml-auto">
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="flex items-center gap-1.5 px-3 h-8 rounded-lg border border-[var(--gray-200)] text-[13px] text-[var(--gray-400)] hover:text-[var(--gray-950)] hover:bg-[var(--gray-50)]"
          >
            <Settings2 className="w-3.5 h-3.5" />
            Supuestos
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showSettings ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </div>

      {/* ── Bank real data strip ─────────────────────────── */}
      {bankStatements.length > 0 && (
        <div className="bg-white border border-[var(--primary)]/20 rounded-xl p-4 flex items-end gap-8 animate-card-in stagger-1">
          <div className="flex items-center gap-2">
            <Landmark className="w-4 h-4 text-[var(--primary)]" />
            <div>
              <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Saldo real bancos</div>
              <div className="text-xl font-semibold tabular-nums text-[var(--primary)] mt-0.5">{fmtCurrency(totalBankSaldo)}</div>
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Cobros reales (abonos)</div>
            <div className="text-xl font-semibold tabular-nums text-[var(--success)] mt-0.5">{fmtCurrency(bankRealAbonos)}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Empresas</div>
            <div className="flex items-center gap-1 mt-1">
              {Array.from(new Set(bankStatements.map(a => a.cia).filter(Boolean))).map(cia => (
                <span key={cia} className="px-2 py-0.5 rounded-full bg-[var(--gray-50)] text-[10px] font-medium text-[var(--gray-500)]">
                  {ciaNameMap.get(cia) ?? `Cia ${cia}`}
                </span>
              ))}
            </div>
          </div>
          <div className="ml-auto text-[11px] text-[var(--gray-400)]">
            Al {bankStatements[0]?.fechaEstadoCuenta} · {bankStatements.length} cuenta{bankStatements.length !== 1 ? 's' : ''} · SWIFT
          </div>
        </div>
      )}

      {showSettings && (
        <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl p-4 flex gap-6 items-end">
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
          <Search className="w-4 h-4 text-[var(--gray-400)] absolute left-3 top-1/2 -translate-y-1/2" />
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
            className="text-[12px] text-[var(--primary)] hover:underline px-2"
          >
            Limpiar filtros
          </button>
        )}
      </div>

      {/* ── View toggle ───────────────────────────────────── */}
      <div className="flex items-center justify-between animate-card-in stagger-3">
        <nav className="flex bg-[var(--gray-50)] rounded-full p-0.5 text-[13px]">
          <button
            onClick={() => setView('calendar')}
            className={`px-4 py-1 rounded-full font-medium hover-press ${view === 'calendar' ? 'bg-white text-[var(--gray-950)] shadow-sm' : 'text-[var(--gray-400)]'}`}
          >Calendario</button>
          <button
            onClick={() => setView('month')}
            className={`px-4 py-1 rounded-full font-medium hover-press ${view === 'month' ? 'bg-white text-[var(--gray-950)] shadow-sm' : 'text-[var(--gray-400)]'}`}
          >Por mes</button>
          <button
            onClick={() => setView('client')}
            className={`px-4 py-1 rounded-full font-medium hover-press ${view === 'client' ? 'bg-white text-[var(--gray-950)] shadow-sm' : 'text-[var(--gray-400)]'}`}
          >Por cliente</button>
        </nav>
      </div>

      {/* ── Main view ─────────────────────────────────────── */}
      {view === 'calendar' && (
        <CalendarView
          events={events}
          clients={filteredClients}
          year={assumptions.year}
          month={activeMonth}
          onMonthChange={setActiveMonth}
          confirmedPayments={confirmedPayments}
          onConfirm={onConfirm}
          onUnconfirm={onUnconfirm}
          payments={paymentEvents}
          bankStatements={bankStatements}
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
function CalendarView({ events, clients, year, month, onMonthChange, confirmedPayments, onConfirm, onUnconfirm, payments, bankStatements = [] }: {
  events: CollectionEvent[];
  clients: Client[];
  year: number;
  month: number;
  onMonthChange: (month: number) => void;
  confirmedPayments: ConfirmedPayment[];
  onConfirm: (p: ConfirmedPayment) => void;
  onUnconfirm: (key: string) => void;
  payments: PaymentEvent[];
  bankStatements?: BankAccountStatement[];
}) {
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [showReconciliation, setShowReconciliation] = useState(true);

  useEffect(() => {
    setSelectedDay(null);
  }, [month]);

  const byId = new Map(clients.map(c => [c.id, c]));
  const confirmedSet = useMemo(() => new Set(confirmedPayments.map(p => p.key)), [confirmedPayments]);
  const todayISO = new Date().toISOString().slice(0, 10);

  // ── Bank Reconciliation ──
  const { matches: reconMatches, summary: reconSummary } = useMemo(
    () => bankStatements.length > 0
      ? reconcileCollections(events, clients, bankStatements, year, month)
      : { matches: [] as ReconciliationMatch[], summary: null as ReconciliationSummary | null },
    [events, clients, bankStatements, year, month],
  );
  const reconMap = useMemo(() => buildReconciliationMap(reconMatches), [reconMatches]);

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
  const monthPagos = Object.values(paymentsByDay).flat().reduce((s, p) => s + p.amount, 0);
  const monthIva = allMonthEvents.reduce((s, e) => {
    const rate = (byId.get(e.clientId)?.ivaRate ?? 16) / 100;
    return s + (e.amount * rate) / (1 + rate);
  }, 0);
  const monthNeto = monthTotal - monthPagos;

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
  const selectedPayments = selectedDay ? (paymentsByDay[selectedDay] || []) : [];
  const selectedTotal = selectedEvents.reduce((s, e) => s + e.amount, 0);
  const selectedPagosTotal = selectedPayments.reduce((s, p) => s + p.amount, 0);

  const prevMonth = () => { onMonthChange(month <= 0 ? 11 : month - 1); };
  const nextMonth = () => { onMonthChange(month >= 11 ? 0 : month + 1); };

  const handleExport = () => {
    const rows = monthEventsList.map(e => {
      const c = byId.get(e.clientId);
      const key = eventKey(e);
      const recon = reconMap.get(key);
      return {
        Cliente: c?.name ?? e.clientId,
        'Fecha Cobro': e.realDate,
        'Fecha Factura': e.invoiceDate,
        Monto: e.amount,
        'Días Lag': e.lagDays,
        'Regla Pago': c?.paymentDayRaw ?? '',
        Confirmado: confirmedSet.has(key) ? 'Sí' : 'No',
        'Estado Banco': recon?.status === 'matched' ? 'Cruzado' : recon?.status === 'likely' ? 'Probable' : 'Sin cruzar',
        'Monto Banco': recon?.actualAmount ?? '',
        'Fecha Banco': recon?.actualDate ?? '',
        'Ref Bancaria': recon?.bankReference ?? '',
        'Confianza': recon?.confidence ? `${(recon.confidence * 100).toFixed(0)}%` : '',
      };
    });
    downloadFile(toCSV(rows), `cobranza-${year}-${String(month + 1).padStart(2, '0')}.csv`);
  };

  return (
    <div className="space-y-4">
      {/* Month summary cards */}
      <div className="grid grid-cols-4 gap-4 animate-card-in stagger-4" style={{ display: 'grid' }}>
        {monthPagos > 0 && (
          <div className="col-span-4 grid grid-cols-3 gap-4 mb-1">
            <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl p-3">
              <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Pagos CXP del mes</div>
              <div className="text-lg font-semibold tabular-nums text-[var(--danger)] mt-0.5">{fmtCurrency(monthPagos)}</div>
            </div>
            <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl p-3">
              <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Flujo neto</div>
              <div className={`text-lg font-semibold tabular-nums mt-0.5 ${monthNeto >= 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>{fmtCurrency(monthNeto)}</div>
            </div>
            <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl p-3">
              <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">IVA cobrado (estimado)</div>
              <div className="text-lg font-semibold tabular-nums text-[var(--primary)] mt-0.5">{fmtCurrency(monthIva)}</div>
            </div>
          </div>
        )}
        <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl p-4 hover-lift">
          <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Cobranza total</div>
          <div className="text-2xl font-semibold tabular-nums text-[var(--gray-950)] mt-1">{fmtCurrency(monthTotal)}</div>
          <div className="text-[12px] text-[var(--gray-400)] mt-0.5">{monthEvents} pagos · {uniqueClients} clientes</div>
        </div>
        <div className="bg-white border border-[var(--success)]/40 rounded-xl p-4 hover-lift">
          <div className="text-[11px] uppercase tracking-wide text-[var(--success)]">Cobrado (real)</div>
          <div className="text-2xl font-semibold tabular-nums text-[var(--success)] mt-1">{fmtCurrency(confirmedTotal)}</div>
          <div className="text-[12px] text-[var(--gray-400)] mt-0.5">{confirmedCount} pagos confirmados</div>
        </div>
        <div className="bg-white border border-[var(--primary)]/30 rounded-xl p-4 hover-lift">
          <div className="text-[11px] uppercase tracking-wide text-[var(--primary)]">Proyectado</div>
          <div className="text-2xl font-semibold tabular-nums text-[var(--primary)] mt-1">{fmtCurrency(projectedTotal)}</div>
          <div className="text-[12px] text-[var(--gray-400)] mt-0.5">{monthEvents - confirmedCount} pendientes</div>
        </div>
        <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl p-4 hover-lift">
          <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">% Avance</div>
          <div className="text-2xl font-semibold tabular-nums text-[var(--gray-950)] mt-1">
            {monthTotal > 0 ? `${((confirmedTotal / monthTotal) * 100).toFixed(0)}%` : '—'}
          </div>
          <div className="mt-1.5 h-2 bg-[var(--gray-50)] rounded-full overflow-hidden">
            <div className="h-full bg-[var(--success)] rounded-full transition-all" style={{ width: `${monthTotal > 0 ? (confirmedTotal / monthTotal) * 100 : 0}%` }} />
          </div>
        </div>
      </div>

      {/* ── Reconciliation Panel ─────────────────────── */}
      {bankStatements.length > 0 && reconSummary && (
        <div className="bg-white border border-[var(--primary)]/20 rounded-xl overflow-hidden animate-card-in stagger-4">
          <button
            onClick={() => setShowReconciliation(!showReconciliation)}
            className="w-full flex items-center justify-between px-5 py-3 hover:bg-[var(--gray-50)]/50 transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <ArrowRightLeft className="w-4 h-4 text-[var(--primary)]" />
              <span className="text-[13px] font-semibold text-[var(--gray-950)]">Reconciliación Bancaria</span>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--primary-muted)] text-[var(--primary)] font-medium">
                {(reconSummary.matchRate * 100).toFixed(0)}% cruzado
              </span>
            </div>
            <ChevronDown className={`w-4 h-4 text-[var(--gray-400)] transition-transform ${showReconciliation ? 'rotate-180' : ''}`} />
          </button>
          {showReconciliation && (
            <div className="px-5 pb-4 pt-1 space-y-3">
              <div className="grid grid-cols-4 gap-4">
                <div className="p-3 rounded-lg bg-[var(--success)]/5 border border-[var(--success)]/20">
                  <div className="flex items-center gap-1.5 mb-1">
                    <CheckCircle2 className="w-3.5 h-3.5 text-[var(--success)]" />
                    <span className="text-[11px] uppercase tracking-wide text-[var(--success)]">Cruzados</span>
                  </div>
                  <div className="text-lg font-semibold tabular-nums text-[var(--success)]">{fmtCurrency(reconSummary.totalMatched)}</div>
                  <div className="text-[11px] text-[var(--gray-400)]">{reconSummary.matchedCount} pago{reconSummary.matchedCount !== 1 ? 's' : ''} confirmados en banco</div>
                </div>
                <div className="p-3 rounded-lg bg-[var(--info)]/5 border border-[var(--info)]/20">
                  <div className="flex items-center gap-1.5 mb-1">
                    <HelpCircle className="w-3.5 h-3.5 text-[var(--info)]" />
                    <span className="text-[11px] uppercase tracking-wide text-[var(--info)]">Probables</span>
                  </div>
                  <div className="text-lg font-semibold tabular-nums text-[var(--info)]">{fmtCurrency(reconSummary.totalLikely)}</div>
                  <div className="text-[11px] text-[var(--gray-400)]">{reconSummary.likelyCount} pago{reconSummary.likelyCount !== 1 ? 's' : ''} con match parcial</div>
                </div>
                <div className="p-3 rounded-lg bg-[var(--warning)]/5 border border-[var(--warning)]/20">
                  <div className="flex items-center gap-1.5 mb-1">
                    <AlertTriangle className="w-3.5 h-3.5 text-[var(--warning)]" />
                    <span className="text-[11px] uppercase tracking-wide text-[var(--warning)]">Sin cruzar</span>
                  </div>
                  <div className="text-lg font-semibold tabular-nums text-[var(--warning)]">{fmtCurrency(reconSummary.totalUnmatched)}</div>
                  <div className="text-[11px] text-[var(--gray-400)]">{reconSummary.unmatchedCount} pago{reconSummary.unmatchedCount !== 1 ? 's' : ''} sin movimiento bancario</div>
                </div>
                <div className="p-3 rounded-lg bg-[var(--gray-50)] border border-[var(--gray-200)]/60">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Banknote className="w-3.5 h-3.5 text-[var(--gray-400)]" />
                    <span className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Abonos no asignados</span>
                  </div>
                  <div className="text-lg font-semibold tabular-nums text-[var(--gray-700)]">
                    {fmtCurrency(reconSummary.unmatchedBankAbonos.reduce((s, a) => s + a.importe, 0))}
                  </div>
                  <div className="text-[11px] text-[var(--gray-400)]">{reconSummary.unmatchedBankAbonos.length} depósito{reconSummary.unmatchedBankAbonos.length !== 1 ? 's' : ''} sin proyección</div>
                </div>
              </div>
              {/* Progress bar */}
              <div className="flex items-center gap-3">
                <div className="flex-1 h-3 bg-[var(--gray-50)] rounded-full overflow-hidden flex">
                  <div
                    className="h-full bg-[var(--success)] transition-all"
                    style={{ width: `${reconSummary.matchedCount / Math.max(1, reconSummary.matchedCount + reconSummary.likelyCount + reconSummary.unmatchedCount) * 100}%` }}
                    title={`Cruzados: ${reconSummary.matchedCount}`}
                  />
                  <div
                    className="h-full bg-[var(--info)] transition-all"
                    style={{ width: `${reconSummary.likelyCount / Math.max(1, reconSummary.matchedCount + reconSummary.likelyCount + reconSummary.unmatchedCount) * 100}%` }}
                    title={`Probables: ${reconSummary.likelyCount}`}
                  />
                </div>
                <span className="text-[12px] font-medium tabular-nums text-[var(--gray-400)] w-14 text-right">
                  {(reconSummary.matchRate * 100).toFixed(0)}%
                </span>
              </div>
              {/* Unmatched bank abonos list (collapsed by default, show first 5) */}
              {reconSummary.unmatchedBankAbonos.length > 0 && (
                <div className="mt-2">
                  <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)] mb-1.5">Depósitos bancarios sin proyección asociada</div>
                  <div className="space-y-1 max-h-32 overflow-y-auto">
                    {reconSummary.unmatchedBankAbonos.slice(0, 8).map((a, i) => (
                      <div key={i} className="flex items-center gap-2 py-1.5 px-3 rounded-lg bg-[var(--gray-50)] text-[12px]">
                        <span className="text-[var(--gray-400)]">{a.fechaOperacion}</span>
                        <span className="text-[var(--gray-700)] truncate flex-1">{a.concepto}</span>
                        <span className="text-[var(--gray-400)]">{a.referencia}</span>
                        <span className="font-semibold tabular-nums text-[var(--success)]">+{fmtCurrency(a.importe)}</span>
                      </div>
                    ))}
                    {reconSummary.unmatchedBankAbonos.length > 8 && (
                      <div className="text-[11px] text-[var(--gray-400)] px-3 py-1">
                        +{reconSummary.unmatchedBankAbonos.length - 8} depósitos más
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Calendar header */}
      <div className="flex items-center justify-between">
        <button onClick={prevMonth} className="p-2 rounded-lg hover:bg-[var(--gray-50)] transition-colors hover-press">
          <svg className="w-5 h-5 text-[var(--gray-400)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 19l-7-7 7-7" /></svg>
        </button>
        <h2 className="text-lg font-semibold text-[var(--gray-950)]">{MONTH_NAMES[month]} {year}</h2>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleExport}
            title="Exportar mes"
            className="p-1.5 rounded-lg hover:bg-[var(--gray-50)] text-[var(--gray-400)] hover:text-[var(--gray-950)] transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          <button onClick={nextMonth} className="p-2 rounded-lg hover:bg-[var(--gray-50)] transition-colors hover-press">
            <svg className="w-5 h-5 text-[var(--gray-400)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5l7 7-7 7" /></svg>
          </button>
        </div>
      </div>

      {/* Calendar grid */}
      <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl overflow-hidden animate-card-in stagger-5">
        <div className="grid grid-cols-7 border-b border-[var(--gray-200)]/40">
          {DOW_HEADERS.map(d => (
            <div key={d} className="px-2 py-2 text-center text-[11px] font-medium text-[var(--gray-400)] bg-[var(--surface-alt)] uppercase tracking-wide">{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((d, i) => {
            const iso = d.toISOString().slice(0, 10);
            const isCurrentMonth = d.getUTCMonth() === month;
            const dayEvents = byDay[iso] || [];
            const dayPayments = paymentsByDay[iso] || [];
            const dayPagosTotal = dayPayments.reduce((s, p) => s + p.amount, 0);
            const dayTotal = dayEvents.reduce((s, e) => s + e.amount, 0);
            const intensity = dayTotal > 0 ? Math.max(0.08, Math.min(0.85, dayTotal / maxDayAmount)) : 0;
            const isWeekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
            const isToday = iso === todayISO;
            const isSelected = selectedDay === iso;
            const isPast = iso < todayISO;

            // Color logic per day — now includes reconciliation status
            const dayConfirmed = dayEvents.filter(e => confirmedSet.has(eventKey(e)));
            const dayPending = dayEvents.filter(e => !confirmedSet.has(eventKey(e)));
            const dayReconciled = dayEvents.filter(e => {
              const r = reconMap.get(eventKey(e));
              return r?.status === 'matched' || r?.status === 'likely';
            });
            const allConfirmed = dayEvents.length > 0 && dayConfirmed.length === dayEvents.length;
            const allReconciled = dayEvents.length > 0 && !allConfirmed && dayReconciled.length === dayEvents.length;
            const someConfirmed = dayConfirmed.length > 0 && dayPending.length > 0;
            const someReconciled = !allConfirmed && !allReconciled && dayReconciled.length > 0;
            const hasPastDue = isPast && dayPending.length > 0 && dayReconciled.length === 0;

            // Pick dominant color for the pill
            let pillBg: string, pillFg: string;
            if (allConfirmed) {
              // All paid → green
              pillBg = `rgba(52, 199, 89, ${intensity + 0.15})`;
              pillFg = intensity > 0.35 ? 'white' : hex.success;
            } else if (hasPastDue && dayConfirmed.length === 0) {
              // All past-due → amber
              pillBg = `rgba(255, 159, 10, ${intensity + 0.1})`;
              pillFg = intensity > 0.35 ? 'white' : hex.warning;
            } else if (someConfirmed) {
              // Mix → split indicator
              pillBg = `rgba(0, 113, 227, ${intensity})`;
              pillFg = intensity > 0.45 ? 'white' : hex.primary;
            } else {
              // Future projected → blue
              pillBg = `rgba(0, 113, 227, ${intensity})`;
              pillFg = intensity > 0.45 ? 'white' : hex.primary;
            }

            return (
              <div
                key={i}
                className={`min-h-[84px] border-b border-r border-[var(--gray-200)]/30 p-1.5 cursor-pointer transition-all duration-150
                  ${!isCurrentMonth ? 'bg-[var(--surface-alt)] opacity-30' : ''}
                  ${isWeekend && isCurrentMonth ? 'bg-[var(--surface-alt)]' : ''}
                  ${isSelected ? 'ring-2 ring-[var(--primary)] ring-inset' : ''}
                  ${isToday && !isSelected ? 'ring-2 ring-[var(--success)] ring-inset' : ''}
                  ${isCurrentMonth ? 'hover:bg-[var(--gray-50)]/60' : ''}
                `}
                onClick={() => isCurrentMonth && setSelectedDay(isSelected ? null : iso)}
              >
                <div className="flex justify-between items-start">
                  <span className={`text-[12px] font-medium ${
                    isToday
                      ? 'bg-[var(--success)] text-white w-5 h-5 rounded-full flex items-center justify-center text-[11px]'
                      : isCurrentMonth ? 'text-[var(--gray-950)]' : 'text-[var(--gray-200)]'
                  }`}>
                    {d.getUTCDate()}
                  </span>
                  {dayEvents.length > 0 && (
                    <div className="flex items-center gap-0.5">
                      {allConfirmed && <Check className="w-3 h-3 text-[var(--success)]" />}
                      {allReconciled && <ArrowRightLeft className="w-3 h-3 text-[var(--success)]" />}
                      {someReconciled && <ArrowRightLeft className="w-3 h-3 text-[var(--info)]" />}
                      {hasPastDue && !allConfirmed && !allReconciled && <span className="w-1.5 h-1.5 rounded-full bg-[var(--warning)]" />}
                      <span className="text-[10px] text-[var(--gray-400)]">{dayEvents.length}</span>
                    </div>
                  )}
                </div>
                {dayTotal === 0 && dayPagosTotal > 0 && isCurrentMonth && (
                  <div className="mt-1">
                    <div className="rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums bg-[var(--danger)]/10 text-[var(--danger)]">
                      −{dayPagosTotal >= 1_000_000 ? `${(dayPagosTotal / 1_000_000).toFixed(1)}M` : dayPagosTotal >= 1000 ? `${Math.round(dayPagosTotal / 1000)}K` : fmtCurrency(dayPagosTotal)}
                    </div>
                  </div>
                )}
                {dayTotal > 0 && isCurrentMonth && (
                  <div className="mt-1">
                    <div className="rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums" style={{ backgroundColor: pillBg, color: pillFg }}>
                      {dayTotal >= 1_000_000 ? `${(dayTotal / 1_000_000).toFixed(1)}M` : dayTotal >= 1000 ? `${Math.round(dayTotal / 1000)}K` : fmtCurrency(dayTotal)}
                    </div>
                    {dayPagosTotal > 0 && (
                      <div className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold tabular-nums mt-0.5 bg-[var(--danger)]/10 text-[var(--danger)]">
                        −{dayPagosTotal >= 1_000_000 ? `${(dayPagosTotal / 1_000_000).toFixed(1)}M` : dayPagosTotal >= 1000 ? `${Math.round(dayPagosTotal / 1000)}K` : fmtCurrency(dayPagosTotal)}
                      </div>
                    )}
                    {someConfirmed && (
                      <div className="flex gap-0.5 mt-0.5">
                        <div className="h-1 rounded-full bg-[var(--success)] flex-1" style={{ flex: dayConfirmed.length }} />
                        <div className={`h-1 rounded-full ${hasPastDue ? 'bg-[var(--warning)]' : 'bg-[var(--primary)]'} flex-1`} style={{ flex: dayPending.length }} />
                      </div>
                    )}
                    {!someConfirmed && dayEvents.length <= 3 && (
                      <div className="mt-0.5">
                        {dayEvents.slice(0, 2).map((e, j) => (
                          <div key={j} className="text-[10px] text-[var(--gray-400)] truncate leading-tight">
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
      {selectedDay && (selectedEvents.length > 0 || selectedPayments.length > 0) && (
        <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl p-4 animate-slide-down">
          <div className="flex justify-between items-center mb-3">
            <h3 className="font-semibold text-[14px] text-[var(--gray-950)]">
              {new Date(selectedDay + 'T12:00:00').toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })}
            </h3>
            <div className="flex gap-4 items-baseline">
              {selectedTotal > 0 && <span className="text-[13px] tabular-nums text-[var(--success)]">+{fmtCurrency(selectedTotal)}</span>}
              {selectedPagosTotal > 0 && <span className="text-[13px] tabular-nums text-[var(--danger)]">−{fmtCurrency(selectedPagosTotal)}</span>}
              <span className={`text-lg font-semibold tabular-nums ${selectedTotal - selectedPagosTotal >= 0 ? 'text-[var(--primary)]' : 'text-[var(--danger)]'}`}>
                {fmtCurrency(selectedTotal - selectedPagosTotal)}
              </span>
            </div>
          </div>
          {selectedPayments.length > 0 && (
            <div className="mb-3">
              <div className="text-[11px] uppercase tracking-wide text-[var(--danger)] mb-1.5">Pagos ({selectedPayments.length})</div>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {selectedPayments.sort((a, b) => b.amount - a.amount).map((p, i) => (
                  <div key={i} className="flex items-center gap-2 py-1.5 px-3 rounded-lg bg-[var(--danger)]/5 border border-[var(--danger)]/20">
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-[var(--gray-950)] truncate">{p.supplier}</div>
                      <div className="text-[11px] text-[var(--gray-400)]">{p.classification}</div>
                    </div>
                    <div className="text-[13px] font-semibold tabular-nums text-[var(--danger)]">−{fmtCurrency(p.amount)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {selectedEvents.length > 0 && selectedPayments.length > 0 && (
            <div className="text-[11px] uppercase tracking-wide text-[var(--success)] mb-1.5">Cobros ({selectedEvents.length})</div>
          )}
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {selectedEvents.sort((a, b) => b.amount - a.amount).map((e, i) => {
              const c = byId.get(e.clientId);
              const key = eventKey(e);
              const isConfirmed = confirmedSet.has(key);
              const isPastDue = !isConfirmed && e.realDate < todayISO;
              const recon = reconMap.get(key);
              const isReconciled = recon?.status === 'matched';
              const isLikely = recon?.status === 'likely';
              const rowBg = isConfirmed
                ? 'bg-[var(--success)]/10 border border-[var(--success)]/30'
                : isReconciled
                  ? 'bg-[var(--success)]/5 border border-[var(--success)]/20'
                  : isLikely
                    ? 'bg-[var(--info)]/5 border border-[var(--info)]/20'
                    : isPastDue
                      ? 'bg-[var(--warning)]/10 border border-[var(--warning)]/30'
                      : 'bg-[var(--gray-50)] border border-transparent';
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
                          amount: recon?.actualAmount ?? e.amount,
                          confirmedAt: new Date().toISOString(),
                        });
                      }
                    }}
                    title={isConfirmed ? 'Desmarcar cobro' : isReconciled ? 'Confirmar (cruzado con banco)' : 'Marcar como cobrado'}
                    className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center transition-all ${
                      isConfirmed
                        ? 'bg-[var(--success)] text-white shadow-sm shadow-[var(--success)]/30'
                        : isReconciled
                          ? 'bg-[var(--success)]/20 text-[var(--success)] border-2 border-[var(--success)] hover:bg-[var(--success)] hover:text-white'
                          : isPastDue
                            ? 'border-2 border-[var(--warning)] text-[var(--warning)] hover:bg-[var(--warning)] hover:text-white'
                            : 'border-2 border-[var(--gray-200)] text-[var(--gray-200)] hover:border-[var(--primary)] hover:text-[var(--primary)]'
                    }`}
                  >
                    {isConfirmed ? <Check className="w-3.5 h-3.5" strokeWidth={1.5} /> : isReconciled ? <CheckCircle2 className="w-3.5 h-3.5" /> : <span className="w-2 h-2" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[13px] font-medium text-[var(--gray-950)] truncate">{c?.name ?? e.clientId}</span>
                      {isReconciled && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--success)]/15 text-[var(--success)] font-semibold uppercase tracking-wide flex-shrink-0">
                          Cruzado
                        </span>
                      )}
                      {isLikely && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--info)]/15 text-[var(--info)] font-semibold uppercase tracking-wide flex-shrink-0">
                          Probable
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-[var(--gray-400)]">
                      {c?.paymentDayRaw ?? '—'} · {c?.creditDays}d crédito
                      {e.lagDays > 0 && <span className="text-[var(--danger)] font-medium"> (+{e.lagDays}d lag)</span>}
                      {isConfirmed && <span className="text-[var(--success)] font-medium"> · Cobrado ✓</span>}
                      {isPastDue && !isReconciled && !isLikely && <span className="text-[var(--warning)] font-medium"> · Vencido</span>}
                    </div>
                    {/* Bank match detail */}
                    {(isReconciled || isLikely) && recon?.bankMovement && (
                      <div className="text-[10px] text-[var(--gray-400)] mt-0.5 flex items-center gap-1.5">
                        <Landmark className="w-3 h-3 flex-shrink-0" />
                        <span className="truncate">{recon.bankMovement.concepto}</span>
                        <span className="text-[var(--gray-300)]">·</span>
                        <span>Ref: {recon.bankReference}</span>
                        {recon.dateDelta !== undefined && recon.dateDelta !== 0 && (
                          <>
                            <span className="text-[var(--gray-300)]">·</span>
                            <span className={recon.dateDelta > 0 ? 'text-[var(--warning)]' : 'text-[var(--success)]'}>
                              {recon.dateDelta > 0 ? `+${recon.dateDelta}d` : `${recon.dateDelta}d`}
                            </span>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="text-right ml-3">
                    <div className={`text-[13px] font-semibold tabular-nums ${isConfirmed || isReconciled ? 'text-[var(--success)]' : 'text-[var(--gray-950)]'}`}>{fmtCurrency(e.amount)}</div>
                    {recon?.actualAmount && Math.abs((recon.actualAmount ?? 0) - e.amount) > 0.01 && (
                      <div className={`text-[10px] font-medium tabular-nums ${(recon.amountDelta ?? 0) > 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
                        Banco: {fmtCurrency(recon.actualAmount)} ({(recon.amountDelta ?? 0) > 0 ? '+' : ''}{fmtCurrency(recon.amountDelta ?? 0)})
                      </div>
                    )}
                    <div className="text-[10px] text-[var(--gray-400)]">Fact: {e.invoiceDate.slice(5)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Weekly breakdown */}
      {Object.keys(weeklyTotals).length > 0 && (
        <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl p-4 hover-lift">
          <h3 className="text-[13px] font-semibold text-[var(--gray-950)] mb-3">Cobranza semanal</h3>
          <div className="space-y-2">
            {Object.entries(weeklyTotals).sort(([a], [b]) => a.localeCompare(b)).map(([week, total]) => {
              const pct = monthTotal ? (total / monthTotal) * 100 : 0;
              return (
                <div key={week} className="grid grid-cols-[90px_1fr_100px_50px] items-center gap-3">
                  <span className="text-[12px] text-[var(--gray-400)]">
                    Sem. {new Date(week + 'T12:00:00').toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })}
                  </span>
                  <div className="h-5 bg-[var(--gray-50)] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[var(--primary)] rounded-full transition-all"
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>
                  <span className="text-[13px] font-medium tabular-nums text-right">{fmtCurrency(total)}</span>
                  <span className="text-[11px] text-[var(--gray-400)] text-right">{pct.toFixed(0)}%</span>
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
    <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl p-5 hover-lift animate-card-in stagger-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[13px] font-semibold text-[var(--gray-950)]">Entrada de efectivo por mes</h3>
        <span className="text-[12px] text-[var(--gray-400)]">
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
              <span className="text-[var(--gray-400)] font-medium">{m}</span>
              <div className="h-7 bg-[var(--gray-50)] rounded-md relative overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 bg-[var(--primary)] rounded-md"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-right tabular-nums font-medium text-[var(--gray-950)]">{fmtCurrency(v)}</span>
              <span className="text-right text-[var(--gray-400)] tabular-nums text-[12px]">
                {share.toFixed(1)}% del total
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-4 pt-3 border-t border-[var(--gray-200)]/40 flex justify-between text-[13px]">
        <span className="text-[var(--gray-400)]">Total anual</span>
        <span className="font-semibold tabular-nums">{fmtCurrency(total)}</span>
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
    <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl overflow-hidden hover-lift animate-card-in stagger-5">
      <div className="px-5 py-3 border-b border-[var(--gray-200)]/40 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-[var(--gray-950)]">Ranking por cliente</h3>
        <span className="text-[12px] text-[var(--gray-400)]">Ordenado por monto proyectado</span>
      </div>
      <table className="w-full text-[13px]">
        <thead className="bg-[var(--surface-alt)] text-[var(--gray-400)] text-left text-[11px] uppercase tracking-wide">
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
              <tr key={c.id} className="border-t border-[var(--gray-200)]/40 hover-row">
                <td className="px-5 py-2.5">
                  <div className="flex items-center gap-2">
                    {c.factoraje && (
                      <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">F</span>
                    )}
                    <span className="text-[var(--gray-950)]">{c.name}</span>
                    <span className="text-[11px] text-[var(--gray-400)]">· {c.frequency}</span>
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-[var(--gray-400)]">{count}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-[var(--gray-400)]">{avgLag.toFixed(0)}d</td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="h-2 bg-[var(--gray-50)] rounded-full flex-1 min-w-[80px] overflow-hidden">
                      <div
                        className="h-full bg-[var(--primary)] rounded-full"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="tabular-nums font-medium w-20 text-right">{fmtCurrency(rowTotal)}</span>
                  </div>
                </td>
                <td className="px-5 py-2.5 text-right tabular-nums text-[var(--gray-400)] text-[12px]">
                  {share.toFixed(1)}%
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr><td colSpan={5} className="text-center text-[var(--gray-400)] py-10">Sin datos con los filtros actuales.</td></tr>
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
    <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl overflow-hidden hover-lift">
      <div className="px-4 py-3 border-b border-[var(--gray-200)]/40 flex items-center justify-between">
        <div>
          <h3 className="text-[13px] font-semibold text-[var(--gray-950)]">Detalle de eventos</h3>
          <p className="text-[12px] text-[var(--gray-400)] mt-0.5">
            Secuencia auditada: fecha de factura, fecha teórica por crédito y fecha real de cobro.
          </p>
        </div>
        <span className="text-[12px] text-[var(--gray-400)]">{Math.min(sorted.length, 1000).toLocaleString('es-MX')} eventos</span>
      </div>
      <div className="max-h-[560px] overflow-y-auto">
        <table className="w-full text-[13px]">
          <thead className="bg-[var(--gray-50)] text-[var(--gray-400)] text-left sticky top-0">
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
                <tr key={i} className="border-t border-[var(--gray-200)]/40 hover-row">
                  <td className="px-4 py-2">{c?.name ?? e.clientId}</td>
                  <td className="px-4 py-2 text-[var(--gray-400)]">{e.invoiceDate}</td>
                  <td className="px-4 py-2 text-[var(--gray-400)]">{e.theoreticalDate}</td>
                  <td className="px-4 py-2 font-medium">{e.realDate}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{e.lagDays}d</td>
                  <td className="px-4 py-2">S{e.isoWeek}</td>
                  <td className="px-4 py-2 text-center">
                    {c?.factoraje && <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">F</span>}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtCurrency(e.amount)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {sorted.length > 1000 && (
        <div className="px-4 py-2 text-[12px] text-[var(--gray-400)] bg-[var(--gray-50)] border-t border-[var(--gray-200)]/40">
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
        disabled ? 'opacity-40 cursor-not-allowed border-[var(--gray-200)]' :
        active ? 'bg-[var(--primary)] text-white border-[var(--primary)]' :
        'bg-white text-[var(--gray-400)] border-[var(--gray-200)] hover:text-[var(--gray-950)]'
      }`}
    >{children}</button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[12px] text-[var(--gray-400)]">
      <span>{label}</span>
      {children}
    </label>
  );
}
