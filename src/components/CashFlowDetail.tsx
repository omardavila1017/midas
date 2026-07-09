import { useMemo, useState, Fragment } from 'react';
import { CashFlowAssumptions } from '../domain/types';
import {
  aggregateWeekly,
  aggregateMonthly,
  computeBankOnlyCashFlow,
  EnrichedBankMovement,
  INTERNAL_REASON_LABELS,
} from '../domain/netCashFlowEngine';
import { sumBankFlowByCompany } from '../domain/bankFlowByCompany';
import type { BankAccountStatement } from '../services/jde';
import {
  ChevronDown,
  Download,
  Calendar as CalendarIcon,
  Landmark,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import { toCSV, downloadFile, csvDate } from '../utils/export';
import { fmtCompact, fmtCurrency } from '../formatters';
import PageHeader from './ui/PageHeader';
import { calculateInitialCash } from '../modules/financial-projection/services/financialProjectionService';

/**
 * Flujo de efectivo detallado — vista BANK-ONLY.
 *
 * Fuente única de verdad: estados de cuenta del API de JDE.
 * Tres granularidades: Diario, Semanal (default), Mensual.
 * Cada fila expandible muestra los movimientos bancarios reales del día
 * (ABONO / CARGO), filtrando traspasos internos entre cuentas propias.
 *
 * Sin proyecciones CXC, sin pendientes CXP — solo movimiento bancario real.
 */

interface Props {
  assumptions: CashFlowAssumptions;
  bankStatements?: BankAccountStatement[];
  companies?: { cia: string; nombre: string }[];
  /** Current status of the JDE bank range fetch (driven from App). */
  bankFetchStatus?: 'idle' | 'priming' | 'ranging';
  /** Progress counter while ranging (done/total days queried). */
  bankFetchProgress?: { done: number; total: number } | null;
  /** Manual refresh trigger — re-runs the YTD range fetch. */
  onRefreshBanks?: () => void;
  /**
   * Saldo inicial — valor fijo por decisión de negocio, mismo que "Caja
   * inicial" en Dashboard. Se muestra pero no es editable.
   */
  startingBalance?: number;
  /**
   * Legacy / compatibility props — ya no se usan en el cómputo del flujo
   * (la vista es bank-only), pero se aceptan para no romper call sites
   * existentes (App.tsx) que todavía los pasan.
   */
  clients?: unknown;
  cxpRecords?: unknown;
  confirmedPayments?: unknown;
}

type Granularity = 'daily' | 'weekly' | 'monthly';

const MONTH_NAMES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const DOW_SHORT = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

// Design tokens — Grupo Senda
const T = {
  text:        'text-[var(--card-foreground)]',
  textMuted:   'text-[var(--muted-foreground)]',
  textSubtle:  'text-[var(--gray-300)]',
  border:      'border-[var(--border)]',
  rowHover:    'hover:bg-[var(--surface-alt)]',
  surface:     'bg-white',
  surfaceAlt:  'bg-[var(--surface-alt)]',
  divider:     'divide-[var(--gray-100)]',
} as const;

export default function CashFlowDetail({
  assumptions,
  bankStatements = [],
  companies = [],
  bankFetchStatus = 'idle',
  bankFetchProgress = null,
  onRefreshBanks,
  startingBalance,
}: Props) {
  const [granularity, setGranularity] = useState<Granularity>('weekly');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [monthFilter, setMonthFilter] = useState<number | 'all'>('all');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  // B2.5 — filtro por empresa. 'all' = todas; si no, una cía.
  const [companyFilter, setCompanyFilter] = useState<string>('all');

  // Empresas presentes en los estados de cuenta cargados + nombre del catálogo.
  const ciaName = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of companies) map.set(c.cia, c.nombre);
    return map;
  }, [companies]);
  const presentCias = useMemo(() => {
    const set = new Set<string>();
    for (const s of bankStatements) if (s.cia) set.add(s.cia);
    return Array.from(set)
      .map(cia => ({ cia, nombre: ciaName.get(cia) ?? `Cia ${cia}` }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es-MX'));
  }, [bankStatements, ciaName]);

  // Estados de cuenta acotados por el filtro de empresa. La detección de
  // traspasos internos se siembra del catálogo (no de las cuentas cargadas),
  // así que filtrar por cía no rompe el neteo interno.
  const scopedStatements = useMemo(
    () => (companyFilter === 'all' ? bankStatements : bankStatements.filter(s => s.cia === companyFilter)),
    [bankStatements, companyFilter],
  );

  // ──────────────────────────────────────────────────────────────
  // Fuente única de verdad: estados de cuenta del API de JDE.
  // Sin proyecciones CXC, sin pendientes CXP, sin doble contabilidad.
  // Transferencias internas (TRASPASO/TRANSFERENCIA REF, RFCs propios,
  // beneficiarios propios, cuenta destino propia) se filtran antes de sumar.
  // ──────────────────────────────────────────────────────────────
  const initialCash = useMemo(
    () => calculateInitialCash(scopedStatements, startingBalance),
    [scopedStatements, startingBalance],
  );
  const { daily, abonosByDate, cargosByDate, internalAbonosByDate, internalCargosByDate } = useMemo(
    () => computeBankOnlyCashFlow(scopedStatements, assumptions.year, initialCash),
    [scopedStatements, assumptions.year, initialCash],
  );

  // Flujo Neto POR EMPRESA (B2.5): abonos/cargos reales (ya sin traspasos
  // internos) agrupados por cía, respetando el filtro de mes. Comparativo
  // display-only — no toca el cómputo del flujo principal.
  const perCompany = useMemo(
    () => sumBankFlowByCompany(abonosByDate, cargosByDate, { month: monthFilter })
      .map(r => ({ ...r, nombre: ciaName.get(r.cia) ?? `Cia ${r.cia}` })),
    [abonosByDate, cargosByDate, monthFilter, ciaName],
  );

  const weekly = useMemo(() => aggregateWeekly(daily), [daily]);
  const monthly = useMemo(() => aggregateMonthly(daily), [daily]);

  // Filter by month if selected
  const filteredDaily = useMemo(() => {
    const base = monthFilter === 'all'
      ? daily
      : daily.filter(d => Number(d.date.slice(5, 7)) - 1 === monthFilter);
    const sorted = [...base].sort((a, b) =>
      sortOrder === 'desc' ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date),
    );
    return sorted;
  }, [daily, monthFilter, sortOrder]);

  const filteredWeekly = useMemo(() => {
    const base = monthFilter === 'all'
      ? weekly
      : weekly.filter(w => Number(w.weekStart.slice(5, 7)) - 1 === monthFilter);
    const sorted = [...base].sort((a, b) =>
      sortOrder === 'desc' ? b.weekStart.localeCompare(a.weekStart) : a.weekStart.localeCompare(b.weekStart),
    );
    return sorted;
  }, [weekly, monthFilter, sortOrder]);

  const sortedMonthly = useMemo(() => {
    return [...monthly].sort((a, b) =>
      sortOrder === 'desc' ? b.month - a.month : a.month - b.month,
    );
  }, [monthly, sortOrder]);

  const minBalance = daily.reduce((m, d) => Math.min(m, d.cumulative), initialCash);
  const minBalanceDate = daily.find(d => d.cumulative === minBalance)?.date;

  // ── Empty state — sin datos bancarios todavía ──
  if (bankStatements.length === 0) {
    return (
      <div style={{ fontFamily: "'Roboto', sans-serif" }} className="space-y-5">
        <CashFlowPageHeader />

        {bankFetchStatus !== 'idle' ? (
          <BankSkeleton />
        ) : (
          <EmptyDataCard onRefreshBanks={onRefreshBanks} />
        )}
      </div>
    );
  }

  const handleExport = () => {
    const rows = daily.map(d => ({
      Fecha: csvDate(d.date),
      Abonos: d.inflows,
      Cargos: d.outflows,
      Neto: d.net,
      'Saldo acumulado': d.cumulative,
    }));
    downloadFile(toCSV(rows), `flujo-bancos-${assumptions.year}.csv`);
  };

  return (
    <div style={{ fontFamily: "'Roboto', sans-serif" }} className="space-y-5">
      <PageHeader title="Flujo de efectivo" />

      {/* Alerta de saldo mínimo negativo */}
      {minBalance < 0 && minBalanceDate && (
        <MinBalanceAlert minBalance={minBalance} minBalanceDate={minBalanceDate} />
      )}

      {/* Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <GranularityTabs value={granularity} onChange={(v) => { setGranularity(v); setExpandedKey(null); }} />

        <div className="flex items-center gap-3">
          <div
            className={`flex items-center gap-2 h-9 px-3 rounded-[var(--radius-md)] border ${T.border} bg-white text-sm ${T.textMuted}`}
            title="Saldo inicial real del año (Σ saldoInicial bancario)."
          >
            <span>Saldo inicial</span>
            <span className={`tabular-nums font-medium ${T.text}`}>
              {fmtCurrency(initialCash)}
            </span>
          </div>
          {presentCias.length > 1 && (
            <select
              value={companyFilter}
              onChange={e => setCompanyFilter(e.target.value)}
              className={`h-9 px-3 rounded-[var(--radius-md)] border ${T.border} bg-white text-sm ${T.text} focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]`}
              title="Empresa"
            >
              <option value="all">Todas las empresas</option>
              {presentCias.map(c => <option key={c.cia} value={c.cia}>{c.nombre}</option>)}
            </select>
          )}
          <select
            value={monthFilter}
            onChange={e => setMonthFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
            className={`h-9 px-3 rounded-[var(--radius-md)] border ${T.border} bg-white text-sm ${T.text} focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]`}
          >
            <option value="all">Todo el año</option>
            {MONTH_NAMES.map((m, i) => <option key={m} value={i}>{m}</option>)}
          </select>
          <select
            value={sortOrder}
            onChange={e => setSortOrder(e.target.value as 'desc' | 'asc')}
            className={`h-9 px-3 rounded-[var(--radius-md)] border ${T.border} bg-white text-sm ${T.text} focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]`}
            title="Orden por fecha"
          >
            <option value="desc">Última a primera fecha</option>
            <option value="asc">Primera a última fecha</option>
          </select>
          <button
            onClick={handleExport}
            className={`inline-flex items-center gap-1.5 text-xs ${T.textMuted} hover:text-[var(--primary)] transition-colors duration-150`}
            title="Exportar CSV"
          >
            <Download size={14} strokeWidth={1.5} />
            Exportar
          </button>
        </div>
      </div>

      {/* Flujo Neto por empresa (B2.5) — comparativo de abonos/cargos/neto por
          cía, ya sin traspasos internos. Sólo con más de una empresa. */}
      {presentCias.length > 1 && perCompany.length > 0 && (
        <div className={`${T.surface} border ${T.border} rounded-[var(--radius)] p-4`}>
          <div className="flex items-center justify-between mb-3">
            <h3 className={`text-sm font-semibold ${T.text}`}>Flujo neto por empresa</h3>
            <span className={`text-xs ${T.textMuted}`}>
              {monthFilter === 'all' ? 'todo el año' : MONTH_NAMES[monthFilter]} · sin traspasos internos
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className={`${T.textMuted} text-left border-b ${T.border}`}>
                <tr>
                  <th className="py-1.5 pr-3 font-medium">Empresa</th>
                  <th className="py-1.5 px-3 font-medium text-right">Abonos</th>
                  <th className="py-1.5 px-3 font-medium text-right">Cargos</th>
                  <th className="py-1.5 pl-3 font-medium text-right">Neto</th>
                </tr>
              </thead>
              <tbody>
                {perCompany.map(row => (
                  <tr key={row.cia} className={`border-b ${T.border} last:border-0`}>
                    <td className={`py-1.5 pr-3 ${T.text}`}>{row.nombre}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums text-[var(--success)]">{fmtCurrency(row.inflows)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums text-[var(--danger)]">{fmtCurrency(row.outflows)}</td>
                    <td className={`py-1.5 pl-3 text-right tabular-nums font-medium ${row.net < 0 ? 'text-[var(--danger)]' : T.text}`}>
                      {fmtCurrency(row.net)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tablas */}
      {granularity === 'daily' && (
        <DailyTable
          daily={filteredDaily}
          expandedKey={expandedKey}
          onToggle={setExpandedKey}
          abonosByDate={abonosByDate}
          cargosByDate={cargosByDate}
          internalAbonosByDate={internalAbonosByDate}
          internalCargosByDate={internalCargosByDate}
        />
      )}
      {granularity === 'weekly' && (
        <WeeklyTable
          weekly={filteredWeekly}
          daily={filteredDaily}
          expandedKey={expandedKey}
          onToggle={setExpandedKey}
          abonosByDate={abonosByDate}
          cargosByDate={cargosByDate}
          internalAbonosByDate={internalAbonosByDate}
          internalCargosByDate={internalCargosByDate}
        />
      )}
      {granularity === 'monthly' && (
        <MonthlyTable
          monthly={sortedMonthly}
          daily={daily}
          expandedKey={expandedKey}
          onToggle={setExpandedKey}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function CashFlowPageHeader() {
  return <PageHeader title="Flujo de efectivo" />;
}

function EmptyDataCard({ onRefreshBanks }: { onRefreshBanks?: () => void }) {
  return (
    <div className={`${T.surface} border ${T.border} rounded-[var(--radius)] p-8 max-w-lg mx-auto`}>
      <div className="flex flex-col items-center text-center">
        <div className="w-12 h-12 rounded-[var(--radius)] bg-[var(--surface-alt)] flex items-center justify-center mb-4">
          <Landmark size={22} strokeWidth={1.5} className={T.textSubtle} />
        </div>
        <h2 className={`text-base font-bold ${T.text}`}>Sin movimientos bancarios</h2>
        <p className={`text-sm mt-2 max-w-sm ${T.textMuted}`}>
          Esta vista usa únicamente los estados de cuenta del API de JDE como
          fuente de verdad. Refresca para traer los últimos movimientos del año.
        </p>
        {onRefreshBanks && (
          <button
            onClick={onRefreshBanks}
            className={`mt-6 inline-flex items-center gap-2 h-9 px-4 rounded-[var(--radius-md)] border ${T.border} text-sm font-medium ${T.text} ${T.rowHover} transition-colors duration-150`}
          >
            <RefreshCw size={14} strokeWidth={1.5} />
            Traer datos de bancos
          </button>
        )}
      </div>
    </div>
  );
}

function BankSkeleton() {
  return (
    <div className={`${T.surface} border ${T.border} rounded-[var(--radius)] animate-pulse`}>
      <div className={`px-5 py-4 border-b ${T.border} flex items-center gap-3`}>
        <div className="w-8 h-8 rounded-[var(--radius-md)] bg-[var(--muted)]" />
        <div className="h-4 bg-[var(--muted)] rounded w-48" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-[var(--gray-100)]">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-white p-4">
            <div className="h-3 bg-[var(--muted)] rounded w-20 mb-3" />
            <div className="h-6 bg-[var(--muted)] rounded w-32" />
          </div>
        ))}
      </div>
    </div>
  );
}

function MinBalanceAlert({ minBalance, minBalanceDate }: { minBalance: number; minBalanceDate: string }) {
  return (
    <div className="flex items-start gap-3 rounded-[var(--radius)] border border-[var(--warning)]/30 bg-[var(--warning)]/5 px-4 py-3">
      <AlertTriangle size={18} strokeWidth={1.5} className="text-[var(--warning)] mt-0.5 flex-shrink-0" />
      <div className="flex-1">
        <p className={`text-sm font-medium ${T.text}`}>Saldo mínimo negativo</p>
        <p className={`text-sm ${T.textMuted} mt-0.5`}>
          Tu saldo llegará a <span className={`font-bold tabular-nums ${T.text}`}>{fmtCurrency(minBalance)}</span> el {formatDate(minBalanceDate)}.
          Ajusta el saldo inicial o reprograma pagos.
        </p>
      </div>
    </div>
  );
}

function GranularityTabs({
  value, onChange,
}: {
  value: Granularity;
  onChange: (v: Granularity) => void;
}) {
  const items: { id: Granularity; label: string }[] = [
    { id: 'daily', label: 'Diario' },
    { id: 'weekly', label: 'Semanal' },
    { id: 'monthly', label: 'Mensual' },
  ];
  return (
    <div className="inline-flex p-0.5 rounded-[var(--radius-md)] bg-[var(--muted)]" role="tablist">
      {items.map(it => {
        const active = value === it.id;
        return (
          <button
            key={it.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(it.id)}
            className={`px-4 h-8 rounded-md text-sm font-medium transition-colors duration-150 ${
              active
                ? 'bg-white text-[var(--card-foreground)] shadow-sm'
                : 'text-[var(--muted-foreground)] hover:text-[var(--card-foreground)]'
            }`}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Daily table — one row per day with activity
// ---------------------------------------------------------------------------
function DailyTable({
  daily, expandedKey, onToggle, abonosByDate, cargosByDate,
  internalAbonosByDate, internalCargosByDate,
}: {
  daily: DailyFlowRow[];
  expandedKey: string | null;
  onToggle: (k: string | null) => void;
  abonosByDate: Map<string, EnrichedBankMovement[]>;
  cargosByDate: Map<string, EnrichedBankMovement[]>;
  internalAbonosByDate: Map<string, EnrichedBankMovement[]>;
  internalCargosByDate: Map<string, EnrichedBankMovement[]>;
}) {
  if (daily.length === 0) return <EmptyTable msg="Sin actividad en el periodo" />;

  return (
    <div className={`${T.surface} border ${T.border} rounded-[var(--radius)] overflow-hidden`}>
      <table className="w-full text-sm">
        <thead className={`${T.surfaceAlt} text-xs font-medium uppercase tracking-wide ${T.textMuted}`}>
          <tr>
            <th className="px-4 py-3 w-10"></th>
            <th className="px-4 py-3 text-left">Fecha</th>
            <th className="px-4 py-3 text-right">Abonos</th>
            <th className="px-4 py-3 text-right">Cargos</th>
            <th className="px-4 py-3 text-right">Neto</th>
            <th className="px-4 py-3 text-right">Saldo</th>
            <th className="px-4 py-3 text-right w-24">Mov.</th>
          </tr>
        </thead>
        <tbody className={`divide-y ${T.divider}`}>
          {daily.map(d => {
            const key = `d-${d.date}`;
            const isOpen = expandedKey === key;
            const abonos = abonosByDate.get(d.date) ?? [];
            const cargos = cargosByDate.get(d.date) ?? [];
            const internalAbonos = internalAbonosByDate.get(d.date) ?? [];
            const internalCargos = internalCargosByDate.get(d.date) ?? [];
            const eventCount = abonos.length + cargos.length + internalAbonos.length + internalCargos.length;
            const weekday = DOW_SHORT[new Date(d.date + 'T12:00:00').getDay()];
            return (
              <Fragment key={key}>
                <tr
                  className={`cursor-pointer transition-colors duration-150 ${isOpen ? T.surfaceAlt : T.rowHover}`}
                  onClick={() => onToggle(isOpen ? null : key)}
                >
                  <td className="px-4 py-3">
                    <ChevronDown
                      size={14}
                      strokeWidth={1.5}
                      className={`${T.textSubtle} transition-transform duration-150 ${isOpen ? 'rotate-0' : '-rotate-90'}`}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className={`text-sm font-medium ${T.text}`}>{formatDate(d.date)}</div>
                    <div className={`text-xs ${T.textMuted}`}>{weekday}</div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium text-[var(--success)]">
                    {d.inflows > 0 ? fmtCurrency(d.inflows) : <span className={T.textSubtle}>—</span>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-[var(--danger)]">
                    {d.outflows > 0 ? fmtCurrency(d.outflows) : <span className={T.textSubtle}>—</span>}
                  </td>
                  <td className={`px-4 py-3 text-right tabular-nums font-bold ${d.net >= 0 ? T.text : 'text-[var(--danger)]'}`}>
                    {fmtCurrency(d.net)}
                  </td>
                  <td className={`px-4 py-3 text-right tabular-nums ${d.cumulative < 0 ? 'text-[var(--danger)] font-bold' : T.text}`}>
                    {fmtCurrency(d.cumulative)}
                  </td>
                  <td className={`px-4 py-3 text-right tabular-nums text-xs ${T.textMuted}`}>{eventCount}</td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={7} className={`${T.surfaceAlt} px-4 py-4`}>
                      <DayDetail
                        abonos={abonos}
                        cargos={cargos}
                        internalAbonos={internalAbonos}
                        internalCargos={internalCargos}
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

type DailyFlowRow = {
  date: string;
  inflows: number;
  outflows: number;
  net: number;
  cumulative: number;
  confirmedIn: number;
  projectedIn: number;
};

// ---------------------------------------------------------------------------
// Weekly table — one row per ISO week, expands to show daily rows
// ---------------------------------------------------------------------------
function WeeklyTable({
  weekly, daily, expandedKey, onToggle, abonosByDate, cargosByDate,
  internalAbonosByDate, internalCargosByDate,
}: {
  weekly: ReturnType<typeof aggregateWeekly>;
  daily: DailyFlowRow[];
  expandedKey: string | null;
  onToggle: (k: string | null) => void;
  abonosByDate: Map<string, EnrichedBankMovement[]>;
  cargosByDate: Map<string, EnrichedBankMovement[]>;
  internalAbonosByDate: Map<string, EnrichedBankMovement[]>;
  internalCargosByDate: Map<string, EnrichedBankMovement[]>;
}) {
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

  if (weekly.length === 0) return <EmptyTable msg="Sin actividad en el periodo" />;

  return (
    <div className={`${T.surface} border ${T.border} rounded-[var(--radius)] overflow-hidden`}>
      <table className="w-full text-sm">
        <thead className={`${T.surfaceAlt} text-xs font-medium uppercase tracking-wide ${T.textMuted}`}>
          <tr>
            <th className="px-4 py-3 w-10"></th>
            <th className="px-4 py-3 text-left">Semana</th>
            <th className="px-4 py-3 text-right">Abonos</th>
            <th className="px-4 py-3 text-right">Cargos</th>
            <th className="px-4 py-3 text-right">Neto</th>
            <th className="px-4 py-3 text-right">Saldo al cierre</th>
            <th className="px-4 py-3 text-right w-24">Días activos</th>
          </tr>
        </thead>
        <tbody className={`divide-y ${T.divider}`}>
          {weekly.map(w => {
            const key = `w-${w.weekStart}`;
            const isOpen = expandedKey === key;
            const weekDays = dailyByWeek.get(w.weekStart) ?? [];
            return (
              <Fragment key={key}>
                <tr
                  className={`cursor-pointer transition-colors duration-150 ${isOpen ? T.surfaceAlt : T.rowHover}`}
                  onClick={() => onToggle(isOpen ? null : key)}
                >
                  <td className="px-4 py-3">
                    <ChevronDown
                      size={14}
                      strokeWidth={1.5}
                      className={`${T.textSubtle} transition-transform duration-150 ${isOpen ? 'rotate-0' : '-rotate-90'}`}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className={`text-sm font-medium ${T.text}`}>Semana {w.weekNumber}</div>
                    <div className={`text-xs ${T.textMuted}`}>Desde {formatDate(w.weekStart)}</div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium text-[var(--success)]">
                    {w.inflows > 0 ? fmtCurrency(w.inflows) : <span className={T.textSubtle}>—</span>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-[var(--danger)]">
                    {w.outflows > 0 ? fmtCurrency(w.outflows) : <span className={T.textSubtle}>—</span>}
                  </td>
                  <td className={`px-4 py-3 text-right tabular-nums font-bold ${w.net >= 0 ? T.text : 'text-[var(--danger)]'}`}>
                    {fmtCurrency(w.net)}
                  </td>
                  <td className={`px-4 py-3 text-right tabular-nums ${w.cumulative < 0 ? 'text-[var(--danger)] font-bold' : T.text}`}>
                    {fmtCurrency(w.cumulative)}
                  </td>
                  <td className={`px-4 py-3 text-right tabular-nums text-xs ${T.textMuted}`}>{weekDays.length}</td>
                </tr>
                {isOpen && weekDays.length > 0 && (
                  <tr>
                    <td colSpan={7} className={`${T.surfaceAlt} px-4 py-4`}>
                      <WeekDetail
                        weekDays={weekDays}
                        abonosByDate={abonosByDate}
                        cargosByDate={cargosByDate}
                        internalAbonosByDate={internalAbonosByDate}
                        internalCargosByDate={internalCargosByDate}
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
  daily: DailyFlowRow[];
  expandedKey: string | null;
  onToggle: (k: string | null) => void;
}) {
  if (monthly.length === 0) return <EmptyTable msg="Sin actividad en el periodo" />;
  const maxInflow = Math.max(...monthly.map(m => m.inflows), 1);
  const maxOutflow = Math.max(...monthly.map(m => m.outflows), 1);

  return (
    <div className={`${T.surface} border ${T.border} rounded-[var(--radius)] overflow-hidden`}>
      <table className="w-full text-sm">
        <thead className={`${T.surfaceAlt} text-xs font-medium uppercase tracking-wide ${T.textMuted}`}>
          <tr>
            <th className="px-4 py-3 w-10"></th>
            <th className="px-4 py-3 text-left">Mes</th>
            <th className="px-4 py-3 text-left">Flujo</th>
            <th className="px-4 py-3 text-right">Abonos</th>
            <th className="px-4 py-3 text-right">Cargos</th>
            <th className="px-4 py-3 text-right">Neto</th>
            <th className="px-4 py-3 text-right">Saldo</th>
          </tr>
        </thead>
        <tbody className={`divide-y ${T.divider}`}>
          {monthly.map(m => {
            const key = `m-${m.month}`;
            const isOpen = expandedKey === key;
            const inflowPct = (m.inflows / maxInflow) * 100;
            const outflowPct = (m.outflows / maxOutflow) * 100;
            const monthDays = daily.filter(d => Number(d.date.slice(5, 7)) - 1 === m.month);
            return (
              <Fragment key={key}>
                <tr
                  className={`cursor-pointer transition-colors duration-150 ${isOpen ? T.surfaceAlt : T.rowHover}`}
                  onClick={() => onToggle(isOpen ? null : key)}
                >
                  <td className="px-4 py-3">
                    <ChevronDown
                      size={14}
                      strokeWidth={1.5}
                      className={`${T.textSubtle} transition-transform duration-150 ${isOpen ? 'rotate-0' : '-rotate-90'}`}
                    />
                  </td>
                  <td className={`px-4 py-3 text-sm font-medium ${T.text}`}>{m.monthName}</td>
                  <td className="px-4 py-3 min-w-[180px]">
                    <div className="flex flex-col gap-1">
                      <div className="h-1.5 rounded-full bg-[var(--muted)] overflow-hidden">
                        <div className="h-full bg-[var(--success)] rounded-full" style={{ width: `${inflowPct}%`, transition: 'width var(--motion-state) var(--ease-smooth)' }} />
                      </div>
                      <div className="h-1.5 rounded-full bg-[var(--muted)] overflow-hidden">
                        <div className="h-full bg-[var(--danger)] rounded-full" style={{ width: `${outflowPct}%`, transition: 'width var(--motion-state) var(--ease-smooth)' }} />
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium text-[var(--success)]">{fmtCurrency(m.inflows)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-[var(--danger)]">{fmtCurrency(m.outflows)}</td>
                  <td className={`px-4 py-3 text-right tabular-nums font-bold ${m.net >= 0 ? T.text : 'text-[var(--danger)]'}`}>
                    {fmtCurrency(m.net)}
                  </td>
                  <td className={`px-4 py-3 text-right tabular-nums ${m.cumulative < 0 ? 'text-[var(--danger)] font-bold' : T.text}`}>
                    {fmtCurrency(m.cumulative)}
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={7} className={`${T.surfaceAlt} px-4 py-4`}>
                      <div className={`text-xs ${T.textMuted} mb-3`}>
                        {monthDays.length} días con actividad · {fmtCurrency(m.confirmedIn)} cobrado real · {fmtCurrency(m.projectedIn)} proyectado
                      </div>
                      <div className="grid grid-cols-7 gap-1.5">
                        {monthDays.map(d => (
                          <div key={d.date} className={`${T.surface} border ${T.border} rounded-[var(--radius-md)] p-2`}>
                            <div className={`text-xs font-medium ${T.textMuted}`}>{d.date.slice(8)}</div>
                            <div className="text-xs tabular-nums text-[var(--success)] mt-0.5">{d.inflows > 0 ? fmtCompact(d.inflows) : ''}</div>
                            <div className="text-xs tabular-nums text-[var(--danger)]">{d.outflows > 0 ? `-${fmtCompact(d.outflows)}` : ''}</div>
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
// Day detail — abonos + cargos reales del banco para un día.
// Los traspasos internos se muestran en una sección colapsable aparte, en
// gris, para que el usuario los vea pero entienda que NO suman al neto.
// ---------------------------------------------------------------------------
function DayDetail({
  abonos, cargos, internalAbonos = [], internalCargos = [],
}: {
  abonos: EnrichedBankMovement[];
  cargos: EnrichedBankMovement[];
  internalAbonos?: EnrichedBankMovement[];
  internalCargos?: EnrichedBankMovement[];
}) {
  const hasInternal = internalAbonos.length > 0 || internalCargos.length > 0;
  const internalAbonosSum = internalAbonos.reduce((s, m) => s + m.amount, 0);
  const internalCargosSum = internalCargos.reduce((s, m) => s + m.amount, 0);
  const [internalOpen, setInternalOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <MovementColumn
          title="Abonos"
          tone="success"
          movements={abonos}
          emptyMsg="Sin abonos"
        />
        <MovementColumn
          title="Cargos"
          tone="danger"
          movements={cargos}
          emptyMsg="Sin cargos"
        />
      </div>

      {hasInternal && (
        <div className={`border ${T.border} rounded-[var(--radius-md)] overflow-hidden`}>
          <button
            type="button"
            onClick={() => setInternalOpen(o => !o)}
            className={`w-full flex items-center justify-between gap-2 px-3 py-2 ${T.surfaceAlt} ${T.rowHover}`}
            aria-expanded={internalOpen}
          >
            <div className="flex items-center gap-2 min-w-0">
              <ChevronDown
                className={`w-3.5 h-3.5 ${T.textMuted} transition-transform ${internalOpen ? 'rotate-0' : '-rotate-90'}`}
              />
              <span className={`text-xs font-medium uppercase tracking-wide ${T.textMuted}`}>
                Movimientos internos
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--gray-200)] text-[var(--gray-500)] font-bold">
                {internalAbonos.length + internalCargos.length}
              </span>
            </div>
            <div className="flex items-center gap-3 text-xs tabular-nums text-[var(--gray-400)]">
              {internalAbonosSum > 0 && <span>+{fmtCurrency(internalAbonosSum)}</span>}
              {internalCargosSum > 0 && <span>−{fmtCurrency(internalCargosSum)}</span>}
              <span className="text-[10px] uppercase tracking-[0.08em]">excluidos del neto</span>
            </div>
          </button>
          {internalOpen && (
            <div className="px-3 py-3 grid grid-cols-1 md:grid-cols-2 gap-4 opacity-60">
              <MovementColumn
                title="Abonos internos"
                tone="muted"
                movements={internalAbonos}
                emptyMsg="—"
              />
              <MovementColumn
                title="Cargos internos"
                tone="muted"
                movements={internalCargos}
                emptyMsg="—"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MovementColumn({
  title, tone, movements, emptyMsg,
}: {
  title: string;
  tone: 'success' | 'danger' | 'muted';
  movements: EnrichedBankMovement[];
  emptyMsg: string;
}) {
  const colorClass =
    tone === 'success' ? 'text-[var(--success)]' :
    tone === 'danger' ? 'text-[var(--danger)]' :
    'text-[var(--gray-400)]';
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className={`text-xs font-medium uppercase tracking-wide ${colorClass}`}>{title}</h4>
        <span className={`text-xs ${T.textMuted}`}>{movements.length}</span>
      </div>
      {movements.length === 0 ? (
        <div className={`text-sm ${T.textSubtle} py-4 text-center border border-dashed ${T.border} rounded-[var(--radius-md)]`}>{emptyMsg}</div>
      ) : (
        <div className="space-y-1.5">
          {[...movements].sort((a, b) => b.amount - a.amount).map((m, i) => (
            <MovementRow key={i} m={m} tone={tone} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Movimiento individual — clickable para drill-down al detalle bancario
// ---------------------------------------------------------------------------
function MovementRow({ m, tone }: { m: EnrichedBankMovement; tone: 'success' | 'danger' | 'muted' }) {
  const [open, setOpen] = useState(false);
  const isInternal = m.kind === 'internal' || tone === 'muted';
  const reasonLabel = isInternal && m.internalReason
    ? INTERNAL_REASON_LABELS[m.internalReason]
    : null;
  const colorClass = isInternal
    ? 'text-[var(--gray-400)] line-through'
    : tone === 'success' ? 'text-[var(--success)]' : 'text-[var(--danger)]';

  return (
    <div className={`${T.surface} rounded-[var(--radius-md)] border ${T.border} overflow-hidden`}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left ${T.rowHover} cursor-pointer`}
        aria-expanded={open}
        title={reasonLabel ?? undefined}
      >
        <div className="min-w-0 flex-1">
          <div className={`text-sm font-medium ${T.text} truncate flex items-center gap-1.5`}>
            <span className="truncate">{m.concepto}</span>
            {isInternal && (
              <span className="text-[9px] uppercase tracking-[0.08em] px-1 py-0.5 rounded bg-[var(--gray-200)] text-[var(--gray-500)] font-bold flex-shrink-0">
                Interno
              </span>
            )}
          </div>
          <div className={`text-xs ${T.textMuted} mt-0.5 truncate`}>
            {(m.bankName || `Banco ${m.banco}`)} · {m.cuenta}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className={`text-sm font-bold tabular-nums ${colorClass}`}>{fmtCurrency(m.amount)}</div>
          <ChevronDown
            className={`w-4 h-4 ${T.textMuted} transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </div>
      </button>

      {open && (
        <div className={`border-t ${T.divider} ${T.surfaceAlt} px-3 py-2.5`}>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            <DetailField label="Banco" value={m.bankName || `Banco ${m.banco}`} />
            <DetailField label="Cuenta" value={m.cuenta} mono />
            <DetailField label="Compañía" value={m.cia} mono />
            <DetailField label="Moneda" value={m.moneda} />
            {m.referencia && <DetailField label="Referencia" value={m.referencia} mono colSpan />}
            {m.fechaValor && m.fechaValor !== m.date && (
              <DetailField label="Fecha valor" value={m.fechaValor} />
            )}
            {m.conceptoFull && m.conceptoFull !== m.concepto && (
              <DetailField label="Concepto completo" value={m.conceptoFull} colSpan />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DetailField({
  label, value, mono, colSpan,
}: {
  label: string;
  value: string;
  mono?: boolean;
  colSpan?: boolean;
}) {
  return (
    <div className={colSpan ? 'col-span-2' : ''}>
      <div className={`${T.textMuted} uppercase tracking-wide text-[10px]`}>{label}</div>
      <div className={`${T.text} ${mono ? 'font-mono tabular-nums' : ''} break-words`}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Week detail — tabla día-por-día dentro de una semana
// ---------------------------------------------------------------------------
function WeekDetail({
  weekDays, abonosByDate, cargosByDate, internalAbonosByDate, internalCargosByDate,
}: {
  weekDays: DailyFlowRow[];
  abonosByDate: Map<string, EnrichedBankMovement[]>;
  cargosByDate: Map<string, EnrichedBankMovement[]>;
  internalAbonosByDate: Map<string, EnrichedBankMovement[]>;
  internalCargosByDate: Map<string, EnrichedBankMovement[]>;
}) {
  const [dayOpen, setDayOpen] = useState<string | null>(null);
  return (
    <div className={`${T.surface} border ${T.border} rounded-[var(--radius-md)] overflow-hidden`}>
      <table className="w-full text-sm">
        <thead className={`${T.surfaceAlt} text-xs font-medium uppercase tracking-wide ${T.textMuted}`}>
          <tr>
            <th className="px-3 py-2.5 text-left">Día</th>
            <th className="px-3 py-2.5 text-right">Abonos</th>
            <th className="px-3 py-2.5 text-right">Cargos</th>
            <th className="px-3 py-2.5 text-right">Neto</th>
            <th className="px-3 py-2.5 text-right">Saldo</th>
            <th className="px-3 py-2.5 text-right w-16">Mov.</th>
          </tr>
        </thead>
        <tbody className={`divide-y ${T.divider}`}>
          {weekDays.map(d => {
            const isOpen = dayOpen === d.date;
            const abonos = abonosByDate.get(d.date) ?? [];
            const cargos = cargosByDate.get(d.date) ?? [];
            const internalAbonos = internalAbonosByDate.get(d.date) ?? [];
            const internalCargos = internalCargosByDate.get(d.date) ?? [];
            const weekday = DOW_SHORT[new Date(d.date + 'T12:00:00').getDay()];
            return (
              <Fragment key={d.date}>
                <tr
                  className={`cursor-pointer transition-colors duration-150 ${isOpen ? T.surfaceAlt : T.rowHover}`}
                  onClick={() => setDayOpen(isOpen ? null : d.date)}
                >
                  <td className="px-3 py-2">
                    <span className={`text-sm font-medium ${T.text}`}>{formatDate(d.date)}</span>
                    <span className={`text-xs ${T.textMuted} ml-2`}>{weekday}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--success)]">
                    {d.inflows > 0 ? fmtCurrency(d.inflows) : <span className={T.textSubtle}>—</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--danger)]">
                    {d.outflows > 0 ? fmtCurrency(d.outflows) : <span className={T.textSubtle}>—</span>}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums font-medium ${d.net >= 0 ? T.text : 'text-[var(--danger)]'}`}>
                    {fmtCurrency(d.net)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${d.cumulative < 0 ? 'text-[var(--danger)]' : T.text}`}>
                    {fmtCurrency(d.cumulative)}
                  </td>
                  <td className={`px-3 py-2 text-right text-xs tabular-nums ${T.textMuted}`}>
                    {abonos.length + cargos.length + internalAbonos.length + internalCargos.length}
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={6} className={`${T.surfaceAlt} px-3 py-3`}>
                      <DayDetail
                        abonos={abonos}
                        cargos={cargos}
                        internalAbonos={internalAbonos}
                        internalCargos={internalCargos}
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
// Helpers
// ---------------------------------------------------------------------------
function EmptyTable({ msg }: { msg: string }) {
  return (
    <div className={`${T.surface} border ${T.border} rounded-[var(--radius)] py-16 text-center`}>
      <CalendarIcon size={28} strokeWidth={1.5} className={`${T.textSubtle} mx-auto mb-3`} />
      <p className={`text-sm font-medium ${T.text}`}>{msg}</p>
      <p className={`text-xs ${T.textMuted} mt-1`}>Prueba con otro mes o carga más datos</p>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
}
