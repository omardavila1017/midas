import { useEffect, useMemo, useState } from 'react';
import { Client, CashFlowAssumptions, Frequency, CollectionEvent, ConfirmedPayment, eventKey } from '../domain/types';
import { projectYear } from '../domain/collectionEngine';
import { extractPaymentEvents, PaymentEvent } from '../domain/netCashFlowEngine';
import { CXPRecord } from '../domain/persistence';
import type { BankAccountStatement } from '../services/jde';
import { MONTHS } from '../types';
import { Search, Settings2, ChevronDown, Check, X, Download, Landmark } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { toCSV, downloadFile } from '../utils/export';
import { hex } from '../theme';
import { fmtCompact, fmtCurrency, fmtInt, fmtPct } from '../formatters';

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
type CollectionKpiKey = 'projected' | 'confirmed' | 'coverage' | 'clients';
type KpiUnit = 'currency' | 'percent' | 'count';
type KpiStatus = 'met' | 'missed' | 'na';

interface CollectionKpiRow {
  key: CollectionKpiKey;
  label: string;
  subtitle: string;
  description: string;
  unit: KpiUnit;
  accentColor: string;
  resultSeries: number[];
  targetSeries: number[];
  statusSeries: KpiStatus[];
  currentValue: number;
  currentTarget: number;
  currentDiff: number;
  currentStatus: KpiStatus;
}

const FREQUENCIES: Frequency[] = ['Semanal', 'Quincenal', 'Mensual', 'Contado'];
const DOW_HEADERS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const MONTH_NAMES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

function defaultActiveMonth(year: number): number {
  const now = new Date();
  return now.getFullYear() === year ? now.getMonth() : 0;
}

function monthIndexFromIso(isoDate: string): number {
  return Number(isoDate.slice(5, 7)) - 1;
}

function createMonthlyClientBuckets(): Set<string>[] {
  return Array.from({ length: 12 }, () => new Set<string>());
}

function resolveKpiStatus(result: number, target: number): KpiStatus {
  if (Math.abs(result) < 0.0001 && Math.abs(target) < 0.0001) return 'na';
  return result + 0.0001 >= target ? 'met' : 'missed';
}

function formatCollectionKpiValue(unit: KpiUnit, value: number): string {
  if (unit === 'currency') return fmtCurrency(value);
  if (unit === 'percent') return fmtPct(value);
  return fmtInt(value);
}

function formatCollectionKpiCompactValue(unit: KpiUnit, value: number): string {
  if (unit === 'currency') return fmtCompact(value);
  return formatCollectionKpiValue(unit, value);
}

function formatCollectionKpiDiff(unit: KpiUnit, diff: number): string {
  if (Math.abs(diff) < 0.0001) return unit === 'percent' ? '0.0 pp' : '0';
  const sign = diff > 0 ? '+' : '-';
  if (unit === 'currency') return `${sign}${fmtCompact(Math.abs(diff))}`;
  if (unit === 'percent') return `${sign}${(Math.abs(diff) * 100).toFixed(1)} pp`;
  return `${sign}${fmtInt(Math.abs(Math.round(diff)))}`;
}

function formatCollectionKpiAxis(unit: KpiUnit, value: number): string {
  if (unit === 'currency') return fmtCompact(value);
  if (unit === 'percent') return `${Math.round(value * 100)}%`;
  return fmtInt(Math.round(value));
}

export default function CollectionProjection({ clients, assumptions, onAssumptionsChange, confirmedPayments, onConfirm, onUnconfirm, cxpRecords = [], bankStatements = [], companies = [] }: Props) {
  const [query, setQuery] = useState('');
  const [freqFilter, setFreqFilter] = useState<Set<Frequency>>(new Set());
  const [factorajeFilter, setFactorajeFilter] = useState<FactorajeFilter>('all');
  const [view, setView] = useState<ViewMode>('calendar');
  const [showSettings, setShowSettings] = useState(false);
  const [activeMonth, setActiveMonth] = useState(() => defaultActiveMonth(assumptions.year));
  const [selectedKpi, setSelectedKpi] = useState<CollectionKpiKey | null>(null);

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

  const filteredClientIds = useMemo(
    () => new Set(filteredClients.map(client => client.id)),
    [filteredClients],
  );

  const targetEvents = useMemo(() => {
    const fullComplianceClients = filteredClients.map(client => ({
      ...client,
      complianceRate: 1,
    }));
    return projectYear(fullComplianceClients, { ...assumptions, globalCompliance: 1 });
  }, [filteredClients, assumptions]);

  const projectedMonthly = useMemo(() => {
    const amounts = new Array(12).fill(0);
    for (const event of events) amounts[monthIndexFromIso(event.realDate)] += event.amount;
    return amounts;
  }, [events]);

  const targetMonthly = useMemo(() => {
    const amounts = new Array(12).fill(0);
    const clientBuckets = createMonthlyClientBuckets();
    for (const event of targetEvents) {
      const monthIndex = monthIndexFromIso(event.realDate);
      amounts[monthIndex] += event.amount;
      clientBuckets[monthIndex].add(event.clientId);
    }
    return {
      amounts,
      clientCounts: clientBuckets.map(bucket => bucket.size),
    };
  }, [targetEvents]);

  const confirmedMonthly = useMemo(() => {
    const amounts = new Array(12).fill(0);
    const clientBuckets = createMonthlyClientBuckets();
    for (const payment of confirmedPayments) {
      if (!filteredClientIds.has(payment.clientId)) continue;
      if (!payment.realDate.startsWith(String(assumptions.year))) continue;
      const monthIndex = monthIndexFromIso(payment.realDate);
      amounts[monthIndex] += payment.amount;
      clientBuckets[monthIndex].add(payment.clientId);
    }
    return {
      amounts,
      clientCounts: clientBuckets.map(bucket => bucket.size),
    };
  }, [confirmedPayments, filteredClientIds, assumptions.year]);

  const coverageMonthly = useMemo(
    () => targetMonthly.amounts.map((target, index) => (target > 0 ? confirmedMonthly.amounts[index] / target : 1)),
    [confirmedMonthly.amounts, targetMonthly.amounts],
  );

  const kpiRows = useMemo<CollectionKpiRow[]>(() => {
    const coverageTargets = new Array(12).fill(1);
    const projectedStatus = projectedMonthly.map((value, index) => resolveKpiStatus(value, targetMonthly.amounts[index]));
    const confirmedStatus = confirmedMonthly.amounts.map((value, index) => resolveKpiStatus(value, targetMonthly.amounts[index]));
    const coverageStatus = coverageMonthly.map((value, index) =>
      targetMonthly.amounts[index] > 0 ? resolveKpiStatus(value, 1) : 'na'
    );
    const clientStatus = confirmedMonthly.clientCounts.map((value, index) => resolveKpiStatus(value, targetMonthly.clientCounts[index]));

    return [
      {
        key: 'projected',
        label: 'Cobranza proyectada',
        subtitle: 'Escenario actual vs meta teórica del mes.',
        description: 'Compara la cobranza esperada bajo los supuestos actuales contra la misma agenda de cobro al 100% de cumplimiento.',
        unit: 'currency',
        accentColor: hex.primary,
        resultSeries: projectedMonthly,
        targetSeries: targetMonthly.amounts,
        statusSeries: projectedStatus,
        currentValue: projectedMonthly[activeMonth] ?? 0,
        currentTarget: targetMonthly.amounts[activeMonth] ?? 0,
        currentDiff: (projectedMonthly[activeMonth] ?? 0) - (targetMonthly.amounts[activeMonth] ?? 0),
        currentStatus: projectedStatus[activeMonth] ?? 'na',
      },
      {
        key: 'confirmed',
        label: 'Cobrado confirmado',
        subtitle: 'Cobros marcados como realizados vs meta teórica.',
        description: 'Mide cuánto del objetivo mensual ya quedó confirmado por el equipo, sin mezclarlo con proyección pendiente.',
        unit: 'currency',
        accentColor: hex.success,
        resultSeries: confirmedMonthly.amounts,
        targetSeries: targetMonthly.amounts,
        statusSeries: confirmedStatus,
        currentValue: confirmedMonthly.amounts[activeMonth] ?? 0,
        currentTarget: targetMonthly.amounts[activeMonth] ?? 0,
        currentDiff: (confirmedMonthly.amounts[activeMonth] ?? 0) - (targetMonthly.amounts[activeMonth] ?? 0),
        currentStatus: confirmedStatus[activeMonth] ?? 'na',
      },
      {
        key: 'coverage',
        label: 'Cumplimiento real',
        subtitle: 'Cobrado confirmado / meta del mes.',
        description: 'Indica qué porcentaje de la meta mensual ya se convirtió en cobro confirmado. La línea punteada marca 100% de cumplimiento.',
        unit: 'percent',
        accentColor: hex.warning,
        resultSeries: coverageMonthly,
        targetSeries: coverageTargets,
        statusSeries: coverageStatus,
        currentValue: coverageMonthly[activeMonth] ?? 1,
        currentTarget: 1,
        currentDiff: (coverageMonthly[activeMonth] ?? 1) - 1,
        currentStatus: coverageStatus[activeMonth] ?? 'na',
      },
      {
        key: 'clients',
        label: 'Clientes cobrados',
        subtitle: 'Clientes con cobro confirmado vs clientes esperados.',
        description: 'Cuenta cuántos clientes sí cobraron frente al total de clientes que debían caer en ese mes según la agenda de cobranza.',
        unit: 'count',
        accentColor: hex.info,
        resultSeries: confirmedMonthly.clientCounts,
        targetSeries: targetMonthly.clientCounts,
        statusSeries: clientStatus,
        currentValue: confirmedMonthly.clientCounts[activeMonth] ?? 0,
        currentTarget: targetMonthly.clientCounts[activeMonth] ?? 0,
        currentDiff: (confirmedMonthly.clientCounts[activeMonth] ?? 0) - (targetMonthly.clientCounts[activeMonth] ?? 0),
        currentStatus: clientStatus[activeMonth] ?? 'na',
      },
    ];
  }, [activeMonth, confirmedMonthly.amounts, confirmedMonthly.clientCounts, coverageMonthly, projectedMonthly, targetMonthly.amounts, targetMonthly.clientCounts]);

  const activeKpiRow = useMemo(
    () => kpiRows.find(row => row.key === selectedKpi) ?? null,
    [kpiRows, selectedKpi],
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

      <CollectionKpiBoard
        rows={kpiRows}
        activeMonth={activeMonth}
        year={assumptions.year}
        onMonthChange={setActiveMonth}
        onSelect={setSelectedKpi}
      />

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
        />
      )}
      {view === 'month' && <MonthView events={events} total={total} />}
      {view === 'client' && <ClientView events={events} clients={filteredClients} total={total} />}

      <DetailView events={events} clients={filteredClients} />

      {activeKpiRow && (
        <CollectionKpiModal
          kpi={activeKpiRow}
          monthIndex={activeMonth}
          year={assumptions.year}
          onClose={() => setSelectedKpi(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI board
// ---------------------------------------------------------------------------

function CollectionKpiBoard({
  rows,
  activeMonth,
  year,
  onMonthChange,
  onSelect,
}: {
  rows: CollectionKpiRow[];
  activeMonth: number;
  year: number;
  onMonthChange: (month: number) => void;
  onSelect: (key: CollectionKpiKey) => void;
}) {
  return (
    <section className="bg-white border border-[var(--gray-200)]/60 rounded-2xl overflow-hidden animate-card-in stagger-2">
      <div className="px-5 py-4 border-b border-[var(--gray-200)]/40 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">KPIs del mes</h2>
          <p className="text-[12px] text-[var(--gray-400)] mt-1">
            Meta = misma agenda de cobranza, pero con 100% de cumplimiento. Haz clic en cualquier KPI para ver la tendencia mensual y si se cumplió.
          </p>
        </div>
        <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-[var(--gray-400)]">
          Mes analizado
          <select
            value={activeMonth}
            onChange={e => onMonthChange(Number(e.target.value))}
            className="input h-9 min-w-[180px] text-[13px] normal-case tracking-normal"
          >
            {MONTH_NAMES.map((month, index) => (
              <option key={month} value={index}>{month} {year}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-[13px]">
          <thead className="bg-[var(--surface-alt)] text-[var(--gray-400)] uppercase tracking-wide text-[11px]">
            <tr>
              <th className="px-5 py-3 text-left font-medium">KPI</th>
              <th className="px-4 py-3 text-right font-medium">Resultado</th>
              <th className="px-4 py-3 text-right font-medium">Meta</th>
              <th className="px-4 py-3 text-right font-medium">Diferencia</th>
              <th className="px-5 py-3 text-right font-medium">Estado</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const diffTone = row.currentStatus === 'na'
                ? 'text-[var(--gray-400)]'
                : row.currentDiff >= 0
                  ? 'text-[var(--success)]'
                  : 'text-[var(--danger)]';
              return (
                <tr
                  key={row.key}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(row.key)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelect(row.key);
                    }
                  }}
                  className="border-t border-[var(--gray-200)]/40 cursor-pointer transition-colors hover:bg-[var(--gray-50)]/70 focus-visible:outline-none focus-visible:bg-[var(--gray-50)]/70"
                >
                  <td className="px-5 py-3.5">
                    <div className="flex items-start gap-3">
                      <span className="mt-1.5 h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: row.accentColor }} />
                      <div className="min-w-0">
                        <div className="font-medium text-[var(--gray-950)]">{row.label}</div>
                        <div className="text-[12px] text-[var(--gray-400)] mt-0.5">{row.subtitle}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3.5 text-right font-medium tabular-nums text-[var(--gray-950)]">
                    {row.currentStatus === 'na' ? 'Sin actividad' : formatCollectionKpiCompactValue(row.unit, row.currentValue)}
                  </td>
                  <td className="px-4 py-3.5 text-right tabular-nums text-[var(--gray-500)]">
                    {row.currentStatus === 'na' ? 'Sin meta' : formatCollectionKpiCompactValue(row.unit, row.currentTarget)}
                  </td>
                  <td className={`px-4 py-3.5 text-right tabular-nums font-medium ${diffTone}`}>
                    {row.currentStatus === 'na' ? 'N/A' : formatCollectionKpiDiff(row.unit, row.currentDiff)}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <KpiStatusBadge status={row.currentStatus} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CollectionKpiModal({
  kpi,
  monthIndex,
  year,
  onClose,
}: {
  kpi: CollectionKpiRow;
  monthIndex: number;
  year: number;
  onClose: () => void;
}) {
  const chartData = MONTHS.map((month, index) => ({
    month,
    result: kpi.resultSeries[index] ?? 0,
    target: kpi.targetSeries[index] ?? 0,
    status: kpi.statusSeries[index] ?? 'na',
  }));
  const monthsWithTarget = kpi.statusSeries.filter(status => status !== 'na').length;
  const metMonths = kpi.statusSeries.filter(status => status === 'met').length;
  const previousValue = monthIndex > 0 ? (kpi.resultSeries[monthIndex - 1] ?? 0) : null;
  const previousDiff = previousValue === null ? null : kpi.currentValue - previousValue;
  const previousMonthLabel = monthIndex > 0 ? MONTH_NAMES[monthIndex - 1] : null;
  const currentDiffTone = kpi.currentStatus === 'na'
    ? 'text-[var(--gray-400)]'
    : kpi.currentDiff >= 0
      ? 'text-[var(--success)]'
      : 'text-[var(--danger)]';
  const previousDiffTone = previousDiff === null
    ? 'text-[var(--gray-400)]'
    : previousDiff >= 0
      ? 'text-[var(--success)]'
      : 'text-[var(--danger)]';

  return (
    <div
      className="fixed inset-0 px-4 py-6 md:py-10"
      style={{ backgroundColor: 'rgba(29, 29, 31, 0.34)', zIndex: 60 }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="mx-auto max-w-6xl rounded-[28px] bg-white shadow-2xl shadow-black/10 overflow-hidden"
        onClick={event => event.stopPropagation()}
      >
        <div className="grid lg:grid-cols-[minmax(0,1.8fr)_320px]">
          <div className="p-6 md:p-8">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div
                  className="inline-flex rounded-xl px-3 py-1 text-[11px] font-semibold uppercase tracking-wide"
                  style={{ backgroundColor: `${kpi.accentColor}14`, color: kpi.accentColor }}
                >
                  KPI
                </div>
                <h3 className="mt-4 text-[30px] leading-tight font-semibold tracking-tight text-[var(--gray-950)]">
                  {kpi.label}
                </h3>
                <p className="mt-3 max-w-3xl text-[15px] leading-7 text-[var(--gray-500)]">
                  {kpi.description}
                </p>
              </div>
              <button
                onClick={onClose}
                className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--gray-400)] transition-colors hover:bg-[var(--gray-50)] hover:text-[var(--gray-950)]"
                aria-label="Cerrar detalle KPI"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="mt-8 h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 12, right: 12, left: 4, bottom: 8 }}>
                  <CartesianGrid stroke={hex.gray100} vertical={false} />
                  <XAxis
                    dataKey="month"
                    tick={{ fill: hex.gray400, fontSize: 12 }}
                    tickLine={false}
                    axisLine={{ stroke: hex.gray100 }}
                  />
                  <YAxis
                    width={88}
                    tick={{ fill: hex.gray400, fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value) => formatCollectionKpiAxis(kpi.unit, Number(value))}
                  />
                  <Tooltip
                    labelFormatter={(label) => `${label} ${year}`}
                    formatter={(value: number, name: string) => [
                      formatCollectionKpiValue(kpi.unit, Number(value)),
                      name === 'result' ? 'Resultado' : 'Meta',
                    ]}
                    contentStyle={{
                      borderRadius: 18,
                      border: `1px solid ${hex.gray200}`,
                      boxShadow: '0 16px 32px rgba(0,0,0,0.08)',
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="target"
                    name="target"
                    stroke={hex.gray300}
                    strokeWidth={2.5}
                    strokeDasharray="7 5"
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="result"
                    name="result"
                    stroke={kpi.accentColor}
                    strokeWidth={3}
                    dot={(props: any) => {
                      const { cx, cy, payload } = props;
                      if (typeof cx !== 'number' || typeof cy !== 'number') {
                        return <circle cx={0} cy={0} r={0} fill="transparent" />;
                      }
                      const fill = payload.status === 'met'
                        ? hex.success
                        : payload.status === 'missed'
                          ? hex.danger
                          : hex.gray300;
                      return <circle cx={cx} cy={cy} r={5} fill={fill} stroke="white" strokeWidth={2} />;
                    }}
                    activeDot={{ r: 6, stroke: kpi.accentColor, strokeWidth: 2, fill: '#fff' }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="mt-6 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
              {chartData.map(item => (
                <div
                  key={item.month}
                  className={`rounded-2xl border px-3 py-3 ${
                    item.status === 'met'
                      ? 'border-[var(--success)]/20 bg-[var(--success)]/10'
                      : item.status === 'missed'
                        ? 'border-[var(--danger)]/20 bg-[var(--danger)]/10'
                        : 'border-[var(--gray-200)]/60 bg-[var(--gray-50)]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--gray-400)]">
                      {item.month}
                    </span>
                    {item.status === 'met' && <Check className="w-3.5 h-3.5 text-[var(--success)]" />}
                    {item.status === 'missed' && <X className="w-3.5 h-3.5 text-[var(--danger)]" />}
                    {item.status === 'na' && <span className="text-[10px] text-[var(--gray-400)]">N/A</span>}
                  </div>
                  <div className="mt-2 text-[13px] font-medium tabular-nums text-[var(--gray-950)]">
                    {item.status === 'na' ? 'Sin actividad' : formatCollectionKpiCompactValue(kpi.unit, item.result)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <aside className="border-t border-[var(--gray-200)]/50 bg-[var(--surface-alt)] p-6 md:p-8 lg:border-l lg:border-t-0">
            <div className="text-[12px] uppercase tracking-wide text-[var(--gray-400)]">
              {MONTH_NAMES[monthIndex]} {year}
            </div>
            <div className="mt-3 text-[40px] leading-none font-semibold tracking-tight text-[var(--gray-950)]">
              {kpi.currentStatus === 'na' ? 'Sin dato' : formatCollectionKpiValue(kpi.unit, kpi.currentValue)}
            </div>

            <div className="mt-7">
              <div className="text-[12px] uppercase tracking-wide text-[var(--gray-400)]">Meta</div>
              <div className="mt-2 text-[28px] leading-tight font-semibold text-[var(--gray-950)]">
                {kpi.currentStatus === 'na' ? 'Sin meta' : formatCollectionKpiValue(kpi.unit, kpi.currentTarget)}
              </div>
            </div>

            <div className="mt-7">
              <div className="text-[12px] uppercase tracking-wide text-[var(--gray-400)]">Diferencia</div>
              <div className={`mt-2 text-[28px] leading-tight font-semibold ${currentDiffTone}`}>
                {kpi.currentStatus === 'na' ? 'N/A' : formatCollectionKpiDiff(kpi.unit, kpi.currentDiff)}
              </div>
            </div>

            <div className="mt-7">
              <div className="text-[12px] uppercase tracking-wide text-[var(--gray-400)]">
                Cambio vs {previousMonthLabel ?? 'mes previo'}
              </div>
              <div className={`mt-2 text-[28px] leading-tight font-semibold ${previousDiffTone}`}>
                {previousDiff === null ? 'N/A' : formatCollectionKpiDiff(kpi.unit, previousDiff)}
              </div>
            </div>

            <div className="mt-7">
              <div className="text-[12px] uppercase tracking-wide text-[var(--gray-400)]">Meses cumpliendo</div>
              <div className="mt-2 text-[28px] leading-tight font-semibold text-[var(--gray-950)]">
                {metMonths}/{monthsWithTarget || 0}
              </div>
            </div>

            <div className="mt-7">
              <div className="text-[12px] uppercase tracking-wide text-[var(--gray-400)]">Estado actual</div>
              <div className="mt-3">
                <KpiStatusBadge status={kpi.currentStatus} />
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function KpiStatusBadge({ status }: { status: KpiStatus }) {
  if (status === 'met') {
    return (
      <span className="inline-flex items-center rounded-full bg-[var(--success)]/10 px-3 py-1 text-[12px] font-medium text-[var(--success)]">
        Meta cumplida
      </span>
    );
  }

  if (status === 'missed') {
    return (
      <span className="inline-flex items-center rounded-full bg-[var(--danger)]/10 px-3 py-1 text-[12px] font-medium text-[var(--danger)]">
        Debajo de meta
      </span>
    );
  }

  return (
    <span className="inline-flex items-center rounded-full bg-[var(--gray-50)] px-3 py-1 text-[12px] font-medium text-[var(--gray-400)]">
      Sin actividad
    </span>
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
function CalendarView({ events, clients, year, month, onMonthChange, confirmedPayments, onConfirm, onUnconfirm, payments }: {
  events: CollectionEvent[];
  clients: Client[];
  year: number;
  month: number;
  onMonthChange: (month: number) => void;
  confirmedPayments: ConfirmedPayment[];
  onConfirm: (p: ConfirmedPayment) => void;
  onUnconfirm: (key: string) => void;
  payments: PaymentEvent[];
}) {
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  useEffect(() => {
    setSelectedDay(null);
  }, [month]);

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

      {/* Calendar header */}
      <div className="flex items-center justify-between">
        <button onClick={prevMonth} className="p-2 rounded-lg hover:bg-[var(--gray-50)] transition-colors hover-press">
          <svg className="w-5 h-5 text-[var(--gray-400)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
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
            <svg className="w-5 h-5 text-[var(--gray-400)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
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
                      {hasPastDue && !allConfirmed && <span className="w-1.5 h-1.5 rounded-full bg-[var(--warning)]" />}
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
              const rowBg = isConfirmed
                ? 'bg-[var(--success)]/10 border border-[var(--success)]/30'
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
                          amount: e.amount,
                          confirmedAt: new Date().toISOString(),
                        });
                      }
                    }}
                    title={isConfirmed ? 'Desmarcar cobro' : 'Marcar como cobrado'}
                    className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center transition-all ${
                      isConfirmed
                        ? 'bg-[var(--success)] text-white shadow-sm shadow-[var(--success)]/30'
                        : isPastDue
                          ? 'border-2 border-[var(--warning)] text-[var(--warning)] hover:bg-[var(--warning)] hover:text-white'
                          : 'border-2 border-[var(--gray-200)] text-[var(--gray-200)] hover:border-[var(--primary)] hover:text-[var(--primary)]'
                    }`}
                  >
                    {isConfirmed ? <Check className="w-3.5 h-3.5" strokeWidth={3} /> : <span className="w-2 h-2" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-[var(--gray-950)] truncate">{c?.name ?? e.clientId}</div>
                    <div className="text-[11px] text-[var(--gray-400)]">
                      {c?.paymentDayRaw ?? '—'} · {c?.creditDays}d crédito
                      {e.lagDays > 0 && <span className="text-[var(--danger)] font-medium"> (+{e.lagDays}d lag)</span>}
                      {isConfirmed && <span className="text-[var(--success)] font-medium"> · Cobrado ✓</span>}
                      {isPastDue && <span className="text-[var(--warning)] font-medium"> · Vencido</span>}
                    </div>
                  </div>
                  <div className="text-right ml-3">
                    <div className={`text-[13px] font-semibold tabular-nums ${isConfirmed ? 'text-[var(--success)]' : 'text-[var(--gray-950)]'}`}>{fmtCurrency(e.amount)}</div>
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
                      className="h-full bg-gradient-to-r from-[var(--primary)] to-[var(--info)] rounded-full transition-all"
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
                  className="absolute inset-y-0 left-0 bg-gradient-to-r from-[var(--primary)] to-[var(--info)] rounded-md"
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
                        className="h-full bg-gradient-to-r from-[var(--primary)] to-[var(--info)] rounded-full"
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
