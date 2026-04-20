import { useMemo, useState, Fragment } from 'react';
import { Client, CashFlowAssumptions, ConfirmedPayment, CollectionEvent } from '../domain/types';
import { CXPRecord } from '../domain/persistence';
import { projectYear } from '../domain/collectionEngine';
import {
  extractPaymentEvents,
  computeDailyFlow,
  aggregateWeekly,
  aggregateMonthly,
  PaymentEvent,
} from '../domain/netCashFlowEngine';
import type { BankAccountStatement } from '../services/jde';
import { ChevronDown, Download, TrendingUp, TrendingDown, Wallet, Calendar as CalendarIcon, Landmark } from 'lucide-react';
import { toCSV, downloadFile } from '../utils/export';
import { hex } from '../theme';
import { fmtCompact, fmtCurrency } from '../formatters';

/**
 * Flujo de efectivo detallado — vista unificada CXC + CXP.
 *
 * Tres granularidades: Diario, Semanal (default), Mensual.
 * Cada fila expandible muestra eventos individuales (clientes que cobran,
 * proveedores que pagan) con montos, IVA y saldo acumulado día a día.
 */

interface Props {
  clients: Client[];
  cxpRecords: CXPRecord[];
  assumptions: CashFlowAssumptions;
  confirmedPayments: ConfirmedPayment[];
  bankStatements?: BankAccountStatement[];
  companies?: { cia: string; nombre: string }[];
}

/** Flatten bank statements into daily inflow/outflow totals + saldo snapshot */
interface BankDaySummary {
  date: string;
  abonos: number;      // total inflows from bank
  cargos: number;      // total outflows from bank
  saldoFinal: number;  // last known saldo final across accounts
  cuentas: number;     // how many accounts had movements
}

type Granularity = 'daily' | 'weekly' | 'monthly';

const MONTH_NAMES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const DOW_SHORT = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

export default function CashFlowDetail({ clients, cxpRecords, assumptions, confirmedPayments, bankStatements = [], companies = [] }: Props) {
  const [granularity, setGranularity] = useState<Granularity>('weekly');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [startingBalance, setStartingBalance] = useState(0);
  const [monthFilter, setMonthFilter] = useState<number | 'all'>('all');

  // Build company name lookup
  const ciaNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of companies) map.set(c.cia, c.nombre);
    return map;
  }, [companies]);

  // ── Flatten bank statements into day summaries ──
  const bankByDate = useMemo(() => {
    const map = new Map<string, BankDaySummary>();
    for (const acc of bankStatements) {
      for (const mov of acc.movimientos) {
        const date = mov.fechaOperacion;
        if (!date) continue;
        let entry = map.get(date);
        if (!entry) {
          entry = { date, abonos: 0, cargos: 0, saldoFinal: 0, cuentas: 0 };
          map.set(date, entry);
        }
        if (mov.tipoMovimiento === 'ABONO') entry.abonos += mov.importe;
        else entry.cargos += mov.importe;
      }
      // Track saldo final per account
      if (acc.saldoFinal !== undefined) {
        const date = acc.fechaEstadoCuenta;
        let entry = map.get(date);
        if (!entry) {
          entry = { date, abonos: 0, cargos: 0, saldoFinal: 0, cuentas: 0 };
          map.set(date, entry);
        }
        entry.saldoFinal += acc.saldoFinal;
        entry.cuentas += 1;
      }
    }
    return map;
  }, [bankStatements]);

  // Total bank saldo (latest)
  const totalBankSaldo = useMemo(() => {
    return bankStatements.reduce((sum, acc) => sum + (acc.saldoFinal ?? acc.saldoInicial ?? 0), 0);
  }, [bankStatements]);

  const totalBankAbonos = useMemo(() => {
    let total = 0;
    for (const entry of bankByDate.values()) total += entry.abonos;
    return total;
  }, [bankByDate]);

  const totalBankCargos = useMemo(() => {
    let total = 0;
    for (const entry of bankByDate.values()) total += entry.cargos;
    return total;
  }, [bankByDate]);

  // Project cash flow events
  const collections = useMemo(() => projectYear(clients, assumptions), [clients, assumptions]);
  const payments = useMemo(() => extractPaymentEvents(cxpRecords), [cxpRecords]);

  const daily = useMemo(
    () => computeDailyFlow(collections, payments, confirmedPayments, assumptions.year, startingBalance),
    [collections, payments, confirmedPayments, assumptions.year, startingBalance],
  );
  const weekly = useMemo(() => aggregateWeekly(daily), [daily]);
  const monthly = useMemo(() => aggregateMonthly(daily, startingBalance), [daily, startingBalance]);

  // Filter by month if selected
  const filteredDaily = useMemo(() => {
    if (monthFilter === 'all') return daily;
    return daily.filter(d => Number(d.date.slice(5, 7)) - 1 === monthFilter);
  }, [daily, monthFilter]);

  const filteredWeekly = useMemo(() => {
    if (monthFilter === 'all') return weekly;
    return weekly.filter(w => Number(w.weekStart.slice(5, 7)) - 1 === monthFilter);
  }, [weekly, monthFilter]);

  // Clients by id for lookup
  const clientById = useMemo(() => new Map(clients.map(c => [c.id, c])), [clients]);

  // KPIs
  const totalInflows = daily.reduce((s, d) => s + d.inflows, 0);
  const totalOutflows = daily.reduce((s, d) => s + d.outflows, 0);
  const netFlow = totalInflows - totalOutflows;
  const finalBalance = daily.length > 0 ? daily[daily.length - 1].cumulative : startingBalance;
  const minBalance = daily.reduce((m, d) => Math.min(m, d.cumulative), startingBalance);
  const minBalanceDate = daily.find(d => d.cumulative === minBalance)?.date;

  // IVA estimate on inflows (using per-client ivaRate applied to amounts)
  const totalIvaInflows = useMemo(() => {
    return collections
      .filter(e => e.realDate.startsWith(assumptions.year.toString()))
      .reduce((sum, e) => {
        const c = clientById.get(e.clientId);
        const rate = (c?.ivaRate ?? 16) / 100;
        return sum + e.amount * rate;
      }, 0);
  }, [collections, clientById, assumptions.year]);

  // Empty state — show bank data if available, guide user to load the rest
  if (clients.length === 0 && cxpRecords.length === 0) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold text-[var(--gray-950)] tracking-tight">Flujo de efectivo</h1>
          <p className="text-[13px] text-[var(--gray-400)] mt-1">
            Vista integrada de cobros, pagos y saldo acumulado.
          </p>
        </header>

        {/* If bank data exists, show it even without clients/CXP */}
        {bankStatements.length > 0 && (
          <div className="bg-white border border-[var(--primary)]/20 rounded-xl p-5 animate-card-in">
            <div className="flex items-center gap-2 mb-3">
              <Landmark className="w-4 h-4 text-[var(--primary)]" />
              <h3 className="text-[14px] font-semibold text-[var(--gray-950)]">Saldo Real Bancos</h3>
              <span className="text-[11px] text-[var(--gray-400)] ml-auto">
                {bankStatements.length} cuenta{bankStatements.length !== 1 ? 's' : ''} · Al {bankStatements[0]?.fechaEstadoCuenta}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-6">
              <div>
                <div className="text-[11px] text-[var(--gray-400)] uppercase tracking-wide">Saldo Total</div>
                <div className="text-2xl font-semibold tabular-nums text-[var(--primary)]">{fmtCurrency(totalBankSaldo)}</div>
              </div>
              <div>
                <div className="text-[11px] text-[var(--gray-400)] uppercase tracking-wide">Abonos</div>
                <div className="text-2xl font-semibold tabular-nums text-[var(--success)]">{fmtCurrency(totalBankAbonos)}</div>
              </div>
              <div>
                <div className="text-[11px] text-[var(--gray-400)] uppercase tracking-wide">Cargos</div>
                <div className="text-2xl font-semibold tabular-nums text-[var(--danger)]">{fmtCurrency(totalBankCargos)}</div>
              </div>
            </div>
          </div>
        )}

        {/* Guide card */}
        <div className="bg-white border border-[var(--gray-200)] rounded-2xl p-8 text-center max-w-lg mx-auto animate-card-in stagger-1">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background: 'linear-gradient(to bottom, var(--gray-50), var(--gray-100))' }}
          >
            <CalendarIcon className="w-6 h-6" style={{ color: 'var(--gray-400)' }} />
          </div>
          <h2 className="text-[18px] font-semibold text-[var(--gray-950)]">Completa los datos para proyectar flujo</h2>
          <p className="text-[13px] text-[var(--gray-400)] mt-2 leading-relaxed max-w-sm mx-auto">
            Esta vista combina cobros (de Clientes) y pagos (de CXP) para generar
            la proyección diaria de flujo de efectivo. Necesitas al menos uno:
          </p>
          <div className="flex justify-center gap-4 mt-5">
            <div className="flex flex-col items-center gap-1.5 px-4 py-3 rounded-xl" style={{ background: 'var(--gray-50)' }}>
              <span className="text-[12px] font-medium" style={{ color: clients.length > 0 ? 'var(--success)' : 'var(--gray-400)' }}>
                {clients.length > 0 ? '✓' : '○'} Clientes
              </span>
              <span className="text-[11px]" style={{ color: 'var(--gray-400)' }}>Catálogos → Clientes</span>
            </div>
            <div className="flex flex-col items-center gap-1.5 px-4 py-3 rounded-xl" style={{ background: 'var(--gray-50)' }}>
              <span className="text-[12px] font-medium" style={{ color: cxpRecords.length > 0 ? 'var(--success)' : 'var(--gray-400)' }}>
                {cxpRecords.length > 0 ? '✓' : '○'} CXP
              </span>
              <span className="text-[11px]" style={{ color: 'var(--gray-400)' }}>Operación → CXP</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Collections by date for row expansion
  const collectionsByDate = useMemo(() => {
    const map = new Map<string, CollectionEvent[]>();
    for (const e of collections) {
      if (!e.realDate.startsWith(assumptions.year.toString())) continue;
      if (!map.has(e.realDate)) map.set(e.realDate, []);
      map.get(e.realDate)!.push(e);
    }
    return map;
  }, [collections, assumptions.year]);

  const paymentsByDate = useMemo(() => {
    const map = new Map<string, PaymentEvent[]>();
    for (const p of payments) {
      if (!p.date.startsWith(assumptions.year.toString())) continue;
      if (!map.has(p.date)) map.set(p.date, []);
      map.get(p.date)!.push(p);
    }
    return map;
  }, [payments, assumptions.year]);

  const handleExport = () => {
    const rows = daily.map(d => ({
      Fecha: d.date,
      Cobros: d.inflows,
      'Cobros confirmados': d.confirmedIn,
      'Cobros proyectados': d.projectedIn,
      Pagos: d.outflows,
      Neto: d.net,
      'Saldo acumulado': d.cumulative,
    }));
    downloadFile(toCSV(rows), `flujo-diario-${assumptions.year}.csv`);
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--gray-950)] tracking-tight">Flujo de efectivo</h1>
          <p className="text-[13px] text-[var(--gray-400)] mt-1">
            Cobros y pagos combinados · saldo acumulado · expande cualquier fila para ver el detalle.
          </p>
        </div>
        <button
          onClick={handleExport}
          title="Exportar flujo diario"
          className="flex items-center gap-1.5 px-3 h-9 rounded-lg border border-[var(--gray-200)] text-[13px] text-[var(--gray-400)] hover:text-[var(--gray-950)] hover:bg-[var(--gray-50)]"
        >
          <Download className="w-3.5 h-3.5" /> Exportar
        </button>
      </header>

      {/* KPI cards */}
      <div className="grid grid-cols-5 gap-4 animate-card-in stagger-1">
        <KPI
          label="Cobros"
          value={totalInflows}
          icon={<TrendingUp className="w-4 h-4" />}
          color="var(--success)"
        />
        <KPI
          label="Pagos"
          value={totalOutflows}
          icon={<TrendingDown className="w-4 h-4" />}
          color="var(--danger)"
        />
        <KPI
          label="Neto"
          value={netFlow}
          icon={<Wallet className="w-4 h-4" />}
          color={netFlow >= 0 ? hex.primary : hex.danger}
        />
        <KPI
          label="Saldo final"
          value={finalBalance}
          icon={<Wallet className="w-4 h-4" />}
          color={finalBalance >= 0 ? hex.primary : hex.danger}
        />
        <KPI
          label="IVA cobrado"
          value={totalIvaInflows}
          icon={<TrendingUp className="w-4 h-4" />}
          color="var(--gray-400)"
        />
      </div>

      {/* Bank real data summary */}
      {bankStatements.length > 0 && (
        <div className="bg-white border border-[var(--primary)]/20 rounded-xl p-4 animate-card-in stagger-2">
          <div className="flex items-center gap-2 mb-3">
            <Landmark className="w-4 h-4 text-[var(--primary)]" />
            <h3 className="text-[13px] font-semibold text-[var(--gray-950)]">
              Saldo Real Bancos
            </h3>
            <span className="text-[11px] text-[var(--gray-400)] ml-auto">
              {bankStatements.length} cuenta{bankStatements.length !== 1 ? 's' : ''} · Al {bankStatements[0]?.fechaEstadoCuenta}
            </span>
          </div>
          <div className="grid grid-cols-4 gap-4">
            <div>
              <div className="text-[11px] text-[var(--gray-400)] uppercase tracking-wide">Saldo Total</div>
              <div className="text-[18px] font-semibold tabular-nums text-[var(--primary)]">{fmtCurrency(totalBankSaldo)}</div>
            </div>
            <div>
              <div className="text-[11px] text-[var(--gray-400)] uppercase tracking-wide">Abonos (real)</div>
              <div className="text-[18px] font-semibold tabular-nums text-[var(--success)]">{fmtCurrency(totalBankAbonos)}</div>
            </div>
            <div>
              <div className="text-[11px] text-[var(--gray-400)] uppercase tracking-wide">Cargos (real)</div>
              <div className="text-[18px] font-semibold tabular-nums text-[var(--danger)]">{fmtCurrency(totalBankCargos)}</div>
            </div>
            <div>
              <div className="text-[11px] text-[var(--gray-400)] uppercase tracking-wide">Empresas</div>
              <div className="text-[13px] text-[var(--gray-950)] mt-1">
                {Array.from(new Set(bankStatements.map(a => a.cia).filter(Boolean))).map(cia => (
                  <span key={cia} className="inline-block mr-2 px-2 py-0.5 rounded-full bg-[var(--gray-50)] text-[11px] font-medium text-[var(--gray-500)]">
                    {ciaNameMap.get(cia) ?? `Cia ${cia}`}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Min balance alert */}
      {minBalance < 0 && minBalanceDate && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-[13px] text-amber-900 flex items-center gap-2">
          <TrendingDown className="w-4 h-4 text-amber-700" />
          <span>
            Saldo mínimo proyectado: <strong className="tabular-nums">{fmtCurrency(minBalance)}</strong> el {formatDate(minBalanceDate)}.
            Considera ajustar el saldo inicial o reprogramar pagos.
          </span>
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center justify-between gap-4 animate-card-in stagger-2">
        <nav className="flex bg-[var(--gray-50)] rounded-full p-0.5 text-[13px]">
          <button
            onClick={() => { setGranularity('daily'); setExpandedKey(null); }}
            className={`px-4 py-1 rounded-full font-medium hover-press ${granularity === 'daily' ? 'bg-white text-[var(--gray-950)] shadow-sm' : 'text-[var(--gray-400)]'}`}
          >Diario</button>
          <button
            onClick={() => { setGranularity('weekly'); setExpandedKey(null); }}
            className={`px-4 py-1 rounded-full font-medium hover-press ${granularity === 'weekly' ? 'bg-white text-[var(--gray-950)] shadow-sm' : 'text-[var(--gray-400)]'}`}
          >Semanal</button>
          <button
            onClick={() => { setGranularity('monthly'); setExpandedKey(null); }}
            className={`px-4 py-1 rounded-full font-medium hover-press ${granularity === 'monthly' ? 'bg-white text-[var(--gray-950)] shadow-sm' : 'text-[var(--gray-400)]'}`}
          >Mensual</button>
        </nav>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-[12px] text-[var(--gray-400)]">
            <span>Saldo inicial</span>
            <input
              type="number"
              value={startingBalance}
              onChange={e => setStartingBalance(Number(e.target.value))}
              className="input w-32 h-8 text-right tabular-nums"
            />
          </label>
          <select
            value={monthFilter}
            onChange={e => setMonthFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
            className="input text-[12px] h-8"
          >
            <option value="all">Todo el año</option>
            {MONTH_NAMES.map((m, i) => <option key={m} value={i}>{m}</option>)}
          </select>
        </div>
      </div>

      {/* Main table */}
      {granularity === 'daily' && (
        <DailyTable
          daily={filteredDaily}
          expandedKey={expandedKey}
          onToggle={setExpandedKey}
          collectionsByDate={collectionsByDate}
          paymentsByDate={paymentsByDate}
          clientById={clientById}
        />
      )}
      {granularity === 'weekly' && (
        <WeeklyTable
          weekly={filteredWeekly}
          daily={filteredDaily}
          expandedKey={expandedKey}
          onToggle={setExpandedKey}
          collectionsByDate={collectionsByDate}
          paymentsByDate={paymentsByDate}
          clientById={clientById}
        />
      )}
      {granularity === 'monthly' && (
        <MonthlyTable
          monthly={monthly}
          daily={daily}
          expandedKey={expandedKey}
          onToggle={setExpandedKey}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Daily table — one row per day with activity
// ---------------------------------------------------------------------------
function DailyTable({
  daily, expandedKey, onToggle, collectionsByDate, paymentsByDate, clientById,
}: {
  daily: ReturnType<typeof computeDailyFlow>;
  expandedKey: string | null;
  onToggle: (k: string | null) => void;
  collectionsByDate: Map<string, CollectionEvent[]>;
  paymentsByDate: Map<string, PaymentEvent[]>;
  clientById: Map<string, Client>;
}) {
  if (daily.length === 0) {
    return <EmptyTable msg="Sin actividad en el periodo." />;
  }
  return (
    <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl overflow-hidden animate-card-in stagger-3">
      <table className="w-full text-[13px]">
        <thead className="bg-[var(--surface-alt)] text-[var(--gray-400)] text-left text-[11px] uppercase tracking-wide sticky top-0">
          <tr>
            <th className="px-4 py-2.5 font-medium w-10"></th>
            <th className="px-4 py-2.5 font-medium">Fecha</th>
            <th className="px-3 py-2.5 font-medium text-right">Cobros</th>
            <th className="px-3 py-2.5 font-medium text-right">Pagos</th>
            <th className="px-3 py-2.5 font-medium text-right">Neto</th>
            <th className="px-3 py-2.5 font-medium text-right">Saldo</th>
            <th className="px-3 py-2.5 font-medium text-right"># Eventos</th>
          </tr>
        </thead>
        <tbody>
          {daily.map(d => {
            const key = `d-${d.date}`;
            const isOpen = expandedKey === key;
            const cobroEvents = collectionsByDate.get(d.date) ?? [];
            const pagoEvents = paymentsByDate.get(d.date) ?? [];
            const eventCount = cobroEvents.length + pagoEvents.length;
            const weekday = DOW_SHORT[new Date(d.date + 'T12:00:00').getDay()];
            return (
              <Fragment key={key}>
                <tr
                  className={`border-t border-[var(--gray-200)]/40 cursor-pointer hover-row ${isOpen ? 'bg-[var(--gray-50)]/60' : ''}`}
                  onClick={() => onToggle(isOpen ? null : key)}
                >
                  <td className="px-4 py-2.5">
                    <ChevronDown className={`w-3.5 h-3.5 text-[var(--gray-400)] transition-transform ${isOpen ? 'rotate-180' : '-rotate-90'}`} />
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-[var(--gray-950)]">{formatDate(d.date)}</div>
                    <div className="text-[11px] text-[var(--gray-400)]">{weekday}</div>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-[var(--success)] font-medium">
                    {d.inflows > 0 ? fmtCurrency(d.inflows) : '—'}
                    {d.confirmedIn > 0 && (
                      <div className="text-[10px] text-[var(--gray-400)]">{fmtCurrency(d.confirmedIn)} confirmado</div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-[var(--danger)]">
                    {d.outflows > 0 ? fmtCurrency(d.outflows) : '—'}
                  </td>
                  <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${d.net >= 0 ? 'text-[var(--gray-950)]' : 'text-[var(--danger)]'}`}>
                    {fmtCurrency(d.net)}
                  </td>
                  <td className={`px-3 py-2.5 text-right tabular-nums ${d.cumulative < 0 ? 'text-[var(--danger)] font-semibold' : 'text-[var(--gray-950)]'}`}>
                    {fmtCurrency(d.cumulative)}
                  </td>
                  <td className="px-3 py-2.5 text-right text-[var(--gray-400)]">{eventCount}</td>
                </tr>
                {isOpen && (
                  <tr className="border-t border-[var(--gray-200)]/20 bg-[var(--surface-alt)]">
                    <td colSpan={7} className="px-4 py-3">
                      <DayDetail
                        cobroEvents={cobroEvents}
                        pagoEvents={pagoEvents}
                        clientById={clientById}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Weekly table — one row per ISO week, expands to show daily rows
// ---------------------------------------------------------------------------
function WeeklyTable({
  weekly, daily, expandedKey, onToggle, collectionsByDate, paymentsByDate, clientById,
}: {
  weekly: ReturnType<typeof aggregateWeekly>;
  daily: ReturnType<typeof computeDailyFlow>;
  expandedKey: string | null;
  onToggle: (k: string | null) => void;
  collectionsByDate: Map<string, CollectionEvent[]>;
  paymentsByDate: Map<string, PaymentEvent[]>;
  clientById: Map<string, Client>;
}) {
  if (weekly.length === 0) {
    return <EmptyTable msg="Sin actividad en el periodo." />;
  }

  // Group daily rows by week start for expansion
  const dailyByWeek = useMemo(() => {
    const map = new Map<string, typeof daily>();
    for (const d of daily) {
      const date = new Date(d.date + 'T00:00:00Z');
      const dow = date.getUTCDay();
      const diff = date.getUTCDate() - dow + (dow === 0 ? -6 : 1);
      const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), diff));
      const weekStart = monday.toISOString().slice(0, 10);
      if (!map.has(weekStart)) map.set(weekStart, []);
      map.get(weekStart)!.push(d);
    }
    return map;
  }, [daily]);

  return (
    <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl overflow-hidden animate-card-in stagger-3">
      <table className="w-full text-[13px]">
        <thead className="bg-[var(--surface-alt)] text-[var(--gray-400)] text-left text-[11px] uppercase tracking-wide sticky top-0">
          <tr>
            <th className="px-4 py-2.5 font-medium w-10"></th>
            <th className="px-4 py-2.5 font-medium">Semana</th>
            <th className="px-3 py-2.5 font-medium text-right">Cobros</th>
            <th className="px-3 py-2.5 font-medium text-right">Pagos</th>
            <th className="px-3 py-2.5 font-medium text-right">Neto</th>
            <th className="px-3 py-2.5 font-medium text-right">Saldo al cierre</th>
            <th className="px-3 py-2.5 font-medium text-right">Días activos</th>
          </tr>
        </thead>
        <tbody>
          {weekly.map(w => {
            const key = `w-${w.weekStart}`;
            const isOpen = expandedKey === key;
            const weekDays = dailyByWeek.get(w.weekStart) ?? [];
            return (
              <Fragment key={key}>
                <tr
                  className={`border-t border-[var(--gray-200)]/40 cursor-pointer hover-row ${isOpen ? 'bg-[var(--gray-50)]/60' : ''}`}
                  onClick={() => onToggle(isOpen ? null : key)}
                >
                  <td className="px-4 py-2.5">
                    <ChevronDown className={`w-3.5 h-3.5 text-[var(--gray-400)] transition-transform ${isOpen ? 'rotate-180' : '-rotate-90'}`} />
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-[var(--gray-950)]">Semana {w.weekNumber}</div>
                    <div className="text-[11px] text-[var(--gray-400)]">
                      Desde {formatDate(w.weekStart)}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-[var(--success)] font-medium">
                    {w.inflows > 0 ? fmtCurrency(w.inflows) : '—'}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-[var(--danger)]">
                    {w.outflows > 0 ? fmtCurrency(w.outflows) : '—'}
                  </td>
                  <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${w.net >= 0 ? 'text-[var(--gray-950)]' : 'text-[var(--danger)]'}`}>
                    {fmtCurrency(w.net)}
                  </td>
                  <td className={`px-3 py-2.5 text-right tabular-nums ${w.cumulative < 0 ? 'text-[var(--danger)] font-semibold' : 'text-[var(--gray-950)]'}`}>
                    {fmtCurrency(w.cumulative)}
                  </td>
                  <td className="px-3 py-2.5 text-right text-[var(--gray-400)]">{weekDays.length}</td>
                </tr>
                {isOpen && weekDays.length > 0 && (
                  <tr className="border-t border-[var(--gray-200)]/20 bg-[var(--surface-alt)]">
                    <td colSpan={7} className="px-4 py-3">
                      <WeekDetail
                        weekDays={weekDays}
                        collectionsByDate={collectionsByDate}
                        paymentsByDate={paymentsByDate}
                        clientById={clientById}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Monthly table
// ---------------------------------------------------------------------------
function MonthlyTable({
  monthly, daily, expandedKey, onToggle,
}: {
  monthly: ReturnType<typeof aggregateMonthly>;
  daily: ReturnType<typeof computeDailyFlow>;
  expandedKey: string | null;
  onToggle: (k: string | null) => void;
}) {
  if (monthly.length === 0) {
    return <EmptyTable msg="Sin actividad en el periodo." />;
  }
  const maxInflow = Math.max(...monthly.map(m => m.inflows), 1);

  return (
    <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl overflow-hidden animate-card-in stagger-3">
      <table className="w-full text-[13px]">
        <thead className="bg-[var(--surface-alt)] text-[var(--gray-400)] text-left text-[11px] uppercase tracking-wide sticky top-0">
          <tr>
            <th className="px-4 py-2.5 font-medium w-10"></th>
            <th className="px-4 py-2.5 font-medium">Mes</th>
            <th className="px-3 py-2.5 font-medium">Flujo</th>
            <th className="px-3 py-2.5 font-medium text-right">Cobros</th>
            <th className="px-3 py-2.5 font-medium text-right">Pagos</th>
            <th className="px-3 py-2.5 font-medium text-right">Neto</th>
            <th className="px-3 py-2.5 font-medium text-right">Saldo</th>
          </tr>
        </thead>
        <tbody>
          {monthly.map(m => {
            const key = `m-${m.month}`;
            const isOpen = expandedKey === key;
            const inflowPct = (m.inflows / maxInflow) * 100;
            const outflowPct = (m.outflows / maxInflow) * 100;
            const monthDays = daily.filter(d => Number(d.date.slice(5, 7)) - 1 === m.month);
            return (
              <Fragment key={key}>
                <tr
                  className={`border-t border-[var(--gray-200)]/40 cursor-pointer hover-row ${isOpen ? 'bg-[var(--gray-50)]/60' : ''}`}
                  onClick={() => onToggle(isOpen ? null : key)}
                >
                  <td className="px-4 py-2.5">
                    <ChevronDown className={`w-3.5 h-3.5 text-[var(--gray-400)] transition-transform ${isOpen ? 'rotate-180' : '-rotate-90'}`} />
                  </td>
                  <td className="px-4 py-2.5 font-medium text-[var(--gray-950)]">{m.monthName}</td>
                  <td className="px-3 py-2.5 min-w-[200px]">
                    <div className="flex items-center gap-1 h-4">
                      <div className="h-2.5 rounded-l" style={{ width: `${inflowPct}%`, backgroundColor: hex.success }} />
                      <div className="h-2.5 rounded-r" style={{ width: `${outflowPct}%`, backgroundColor: hex.danger }} />
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-[var(--success)] font-medium">{fmtCurrency(m.inflows)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-[var(--danger)]">{fmtCurrency(m.outflows)}</td>
                  <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${m.net >= 0 ? 'text-[var(--gray-950)]' : 'text-[var(--danger)]'}`}>
                    {fmtCurrency(m.net)}
                  </td>
                  <td className={`px-3 py-2.5 text-right tabular-nums ${m.cumulative < 0 ? 'text-[var(--danger)] font-semibold' : 'text-[var(--gray-950)]'}`}>
                    {fmtCurrency(m.cumulative)}
                  </td>
                </tr>
                {isOpen && (
                  <tr className="border-t border-[var(--gray-200)]/20 bg-[var(--surface-alt)]">
                    <td colSpan={7} className="px-4 py-3">
                      <div className="text-[12px] text-[var(--gray-400)] mb-2">
                        {monthDays.length} días con actividad · {fmtCurrency(m.confirmedIn)} cobrado (real), {fmtCurrency(m.projectedIn)} proyectado
                      </div>
                      <div className="grid grid-cols-7 gap-1 text-[11px]">
                        {monthDays.map(d => (
                          <div key={d.date} className="border border-[var(--gray-200)]/40 rounded p-1.5">
                            <div className="text-[var(--gray-400)]">{d.date.slice(8)}</div>
                            <div className="text-[var(--success)] tabular-nums">{d.inflows > 0 ? fmtCompact(d.inflows) : ''}</div>
                            <div className="text-[var(--danger)] tabular-nums">{d.outflows > 0 ? `-${fmtCompact(d.outflows)}` : ''}</div>
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Day detail — shows cobros + pagos for a single day
// ---------------------------------------------------------------------------
function DayDetail({
  cobroEvents, pagoEvents, clientById,
}: {
  cobroEvents: CollectionEvent[];
  pagoEvents: PaymentEvent[];
  clientById: Map<string, Client>;
}) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <h4 className="text-[12px] font-semibold text-[var(--success)] uppercase tracking-wide mb-2">
          Cobros ({cobroEvents.length})
        </h4>
        {cobroEvents.length === 0 ? (
          <div className="text-[12px] text-[var(--gray-400)]">Sin cobros</div>
        ) : (
          <div className="space-y-1">
            {cobroEvents.sort((a, b) => b.amount - a.amount).map((e, i) => {
              const c = clientById.get(e.clientId);
              const ivaRate = (c?.ivaRate ?? 16) / 100;
              const iva = e.amount * ivaRate;
              return (
                <div key={i} className="flex items-center justify-between text-[12px] bg-white px-2.5 py-1.5 rounded border border-[var(--gray-200)]/40">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-[var(--gray-950)] truncate">{c?.name ?? e.clientId}</div>
                    <div className="text-[10px] text-[var(--gray-400)]">
                      Fact {e.invoiceDate.slice(5)} · {c?.frequency} · IVA {c?.ivaRate ?? 16}%
                    </div>
                  </div>
                  <div className="text-right ml-2">
                    <div className="tabular-nums font-medium text-[var(--success)]">{fmtCurrency(e.amount)}</div>
                    <div className="text-[10px] text-[var(--gray-400)]">+IVA {fmtCurrency(iva)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div>
        <h4 className="text-[12px] font-semibold text-[var(--danger)] uppercase tracking-wide mb-2">
          Pagos ({pagoEvents.length})
        </h4>
        {pagoEvents.length === 0 ? (
          <div className="text-[12px] text-[var(--gray-400)]">Sin pagos</div>
        ) : (
          <div className="space-y-1">
            {pagoEvents.sort((a, b) => b.amount - a.amount).map((p, i) => (
              <div key={i} className="flex items-center justify-between text-[12px] bg-white px-2.5 py-1.5 rounded border border-[var(--gray-200)]/40">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-[var(--gray-950)] truncate">{p.supplier}</div>
                  <div className="text-[10px] text-[var(--gray-400)]">{p.classification}</div>
                </div>
                <div className="tabular-nums font-medium text-[var(--danger)] ml-2">{fmtCurrency(p.amount)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Week detail — shows day-by-day table inside a week row
// ---------------------------------------------------------------------------
function WeekDetail({
  weekDays, collectionsByDate, paymentsByDate, clientById,
}: {
  weekDays: ReturnType<typeof computeDailyFlow>;
  collectionsByDate: Map<string, CollectionEvent[]>;
  paymentsByDate: Map<string, PaymentEvent[]>;
  clientById: Map<string, Client>;
}) {
  const [dayOpen, setDayOpen] = useState<string | null>(null);
  return (
    <div className="bg-white border border-[var(--gray-200)]/40 rounded-lg overflow-hidden">
      <table className="w-full text-[12px]">
        <thead className="bg-[var(--gray-50)] text-[var(--gray-400)] text-left text-[10px] uppercase tracking-wide">
          <tr>
            <th className="px-3 py-2 font-medium">Día</th>
            <th className="px-3 py-2 font-medium text-right">Cobros</th>
            <th className="px-3 py-2 font-medium text-right">Pagos</th>
            <th className="px-3 py-2 font-medium text-right">Neto</th>
            <th className="px-3 py-2 font-medium text-right">Saldo</th>
            <th className="px-3 py-2 font-medium text-right">#</th>
          </tr>
        </thead>
        <tbody>
          {weekDays.map(d => {
            const isOpen = dayOpen === d.date;
            const cobroEvents = collectionsByDate.get(d.date) ?? [];
            const pagoEvents = paymentsByDate.get(d.date) ?? [];
            const weekday = DOW_SHORT[new Date(d.date + 'T12:00:00').getDay()];
            return (
              <Fragment key={d.date}>
                <tr
                  className="border-t border-[var(--gray-200)]/30 cursor-pointer hover:bg-[var(--gray-50)]/60"
                  onClick={() => setDayOpen(isOpen ? null : d.date)}
                >
                  <td className="px-3 py-1.5">
                    <span className="font-medium text-[var(--gray-950)]">{formatDate(d.date)}</span>
                    <span className="text-[10px] text-[var(--gray-400)] ml-2">{weekday}</span>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-[var(--success)]">{d.inflows > 0 ? fmtCurrency(d.inflows) : '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-[var(--danger)]">{d.outflows > 0 ? fmtCurrency(d.outflows) : '—'}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums font-medium ${d.net >= 0 ? 'text-[var(--gray-950)]' : 'text-[var(--danger)]'}`}>{fmtCurrency(d.net)}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${d.cumulative < 0 ? 'text-[var(--danger)]' : 'text-[var(--gray-950)]'}`}>{fmtCurrency(d.cumulative)}</td>
                  <td className="px-3 py-1.5 text-right text-[var(--gray-400)]">{cobroEvents.length + pagoEvents.length}</td>
                </tr>
                {isOpen && (
                  <tr className="border-t border-[var(--gray-200)]/20 bg-[var(--surface-alt)]">
                    <td colSpan={6} className="px-3 py-2">
                      <DayDetail cobroEvents={cobroEvents} pagoEvents={pagoEvents} clientById={clientById} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function KPI({ label, value, icon, color }: { label: string; value: number; icon: React.ReactNode; color: string }) {
  return (
    <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl p-4 hover-lift">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide" style={{ color }}>
        {icon}
        {label}
      </div>
      <div className="text-2xl font-semibold tabular-nums mt-1" style={{ color }}>
        {fmtCurrency(value)}
      </div>
    </div>
  );
}

function EmptyTable({ msg }: { msg: string }) {
  return (
    <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl py-12 text-center text-[13px] text-[var(--gray-400)]">
      {msg}
    </div>
  );
}


function formatDate(iso: string): string {
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
}
