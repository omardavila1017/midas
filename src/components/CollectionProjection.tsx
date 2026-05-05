import { useEffect, useMemo, useState } from 'react';
import { Client, CashFlowAssumptions, Frequency, CollectionEvent, ConfirmedPayment, eventKey } from '../domain/types';
import { projectYear } from '../domain/collectionEngine';
import { isBankHoliday } from '../domain/bankHolidays';
import { isInternalTransfer, buildOwnAccountsIndex, buildOwnAccountDetector } from '../domain/netCashFlowEngine';
import { reconcileCollections, buildReconciliationMap, type ReconciliationMatch, type ReconciliationSummary } from '../domain/reconciliationEngine';
import {
  reconcileRealCollections,
  type RealReconciliationMatch,
  type RealReconciliationResult,
  type MatchTier as RealMatchTier,
  type ReconciliationReviewCandidate,
  type RealReconciliationBankCoverage,
} from '../domain/realReconciliationEngine';
import {
  applyManualConfirmations,
  confirmReviewKeys,
  reviewCandidateKeysAboveThreshold,
  useConfirmedReviewKeys,
} from '../domain/reconciliationConfirmations';
import {
  buildCollectionCalendar,
  calendarEventMatchesSourceFilter,
  COLLECTION_CALENDAR_SOURCE_LABELS,
  type BuildCollectionCalendarResult,
  type CollectionCalendarEvent,
  type CollectionCalendarEventSource,
  type CollectionCalendarSourceFilter,
} from '../domain/collectionCalendarEngine';
import { CXPRecord } from '../domain/persistence';
import type { BankAccountStatement, CobranzaRecord } from '../services/jde';
import { MONTHS } from '../types';
import { Search, Settings2, ChevronDown, ChevronLeft, ChevronRight, Check, Download, Landmark, ArrowRightLeft, CheckCircle2, AlertTriangle, HelpCircle, Banknote, CalendarRange, Inbox, SlidersHorizontal, Database, FileSpreadsheet } from 'lucide-react';
import { toCSV, downloadFile } from '../utils/export';
import { hex } from '../theme';
import { fmtCurrency, fmtCompact } from '../formatters';
import AnimatedNumber from './ui/AnimatedNumber';
import PageHeader from './ui/PageHeader';

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
  /**
   * CXC real proveniente de POST /v1/erp/tesoreria/cobranza. Cada registro es
   * una factura abierta o reciente (últimos 12 meses). Cuando llega vacío,
   * la pestaña sigue funcionando en modo Proyectada y la sección "Real (JDE)"
   * muestra empty state.
   */
  cobranzaRecords?: CobranzaRecord[];
  /**
   * ISO timestamp por compañía del último fetch exitoso de /cobranza. Hoy
   * solo se usa para mostrar "Actualizado hace X" en la vista raw; en fases
   * posteriores alimentará el indicador de staleness.
   */
  cobranzaLoadedCias?: Record<string, string>;
  /**
   * Resultado pre-computado del cruce cobranza ↔ bancos. App.tsx lo
   * memoiza una vez y lo pasa a todas las pestañas que lo consumen
   * (Cobranza, Bancos, Dashboard) — así evitamos recomputar el motor
   * cuando el usuario navega o cambia filtros locales que no tocan los
   * inputs del motor.
   */
  cobranzaReconciliation?: RealReconciliationResult;
  /** Lookup pre-construido (cia::noFactura) → match. */
  cobranzaFacturaIndex?: Map<string, RealReconciliationMatch>;
  /** Mensaje de error del último auto/manual fetch de cobranza, si lo hay. */
  cobranzaError?: string | null;
  /** Trigger un refetch manual de /cobranza para todas las cías activas. */
  onRefreshCobranza?: () => void;
  /** Indica si un refresh está en curso para deshabilitar el botón. */
  cobranzaRefreshing?: boolean;
  /** Carga bancos sólo para el rango visible de cobranza y mergea al cache. */
  onEnsureBankCoverage?: (request: EnsureBankCoverageRequest) => void | Promise<void>;
  bankCoverageLoading?: boolean;
  /**
   * Cía seleccionada globalmente (header del shell). Cuando viene un valor
   * distinto a 'all', el CobranzaRealView abre filtrado por esa cía;
   * cuando es 'all' muestra todas. Esto sincroniza el filtro local con el
   * global del app.
   */
  selectedCia?: string;
}

interface EnsureBankCoverageRequest {
  from: string;
  to: string;
  ciaFilter?: string[];
}

type ViewMode = 'month' | 'client' | 'calendar';
type FactorajeFilter = 'all' | 'yes' | 'no';
/**
 * Toggle nivel-página: la pestaña sirve dos modos.
 *   - 'projected': la lógica histórica (calendario, calc. heurístico).
 *   - 'real':      lectura directa de /cobranza (CXC JDE) — fase 1 muestra
 *                  tabla raw para validar shape; fase 2/3 traerá la UI rica
 *                  con cruces a bancos.
 */
type SourceMode = 'projected' | 'real';

const FREQUENCIES: Frequency[] = ['Semanal', 'Quincenal', 'Mensual', 'Contado'];
const DOW_HEADERS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const MONTH_NAMES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

function defaultActiveMonth(year: number): number {
  const now = new Date();
  return now.getFullYear() === year ? now.getMonth() : 0;
}

export default function CollectionProjection({ clients, assumptions, onAssumptionsChange, confirmedPayments, onConfirm, onUnconfirm, cxpRecords = [], bankStatements = [], companies = [], cobranzaRecords = [], cobranzaLoadedCias = {}, cobranzaReconciliation, cobranzaFacturaIndex, cobranzaError, onRefreshCobranza, cobranzaRefreshing, selectedCia, onEnsureBankCoverage, bankCoverageLoading }: Props) {
  const [query, setQuery] = useState('');
  const [freqFilter, setFreqFilter] = useState<Set<Frequency>>(new Set());
  const [factorajeFilter, setFactorajeFilter] = useState<FactorajeFilter>('all');
  const [view, setView] = useState<ViewMode>('calendar');
  const [showSettings, setShowSettings] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [activeMonth, setActiveMonth] = useState(() => defaultActiveMonth(assumptions.year));
  // Default a 'real' cuando hay datos JDE, 'projected' si no — para que el
  // primer abrir la pestaña muestre lo más cercano a la realidad sin
  // requerir clic. El usuario puede saltar entre ambos siempre.
  const [sourceMode, setSourceMode] = useState<SourceMode>(() =>
    cobranzaRecords.length > 0 ? 'real' : 'projected',
  );

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

  const total = events.reduce((a, e) => a + e.amount, 0);
  const avgLag = events.length ? events.reduce((a, e) => a + e.lagDays, 0) / events.length : 0;

  // ── Bank real data ──
  const ciaNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of companies) map.set(c.cia, c.nombre);
    return map;
  }, [companies]);

  const bankRealAbonos = useMemo(() => {
    // Los traspasos entre cuentas propias (TRASPASO/TRANSFERENCIA REF, RFCs
    // del grupo, etc.) no son cobros reales — se filtran para que el KPI
    // refleje solo flujos desde terceros.
    const detector = buildOwnAccountDetector(buildOwnAccountsIndex(bankStatements));
    return bankStatements.reduce((sum, acc) =>
      sum + acc.movimientos
        .filter(m => m.tipoMovimiento === 'ABONO' && !isInternalTransfer(m, detector))
        .reduce((s, m) => s + m.importe, 0), 0);
  }, [bankStatements]);

  const totalBankSaldo = useMemo(() => {
    return bankStatements.reduce((sum, acc) => sum + (acc.saldoFinal ?? acc.saldoInicial ?? 0), 0);
  }, [bankStatements]);

  // Empty state
  if (clients.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center animate-page-in">
        <div className="w-16 h-16 rounded-2xl bg-[var(--primary-muted)] flex items-center justify-center mb-4 animate-scale-in">
          <Inbox className="w-7 h-7 text-[var(--primary)]" />
        </div>
        <h2 className="text-xl font-semibold text-[var(--gray-950)]">Sin clientes cargados</h2>
        <p className="text-[13px] text-[var(--gray-400)] mt-1 max-w-sm">
          Importa el catálogo en la pestaña Clientes para ver la proyección.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5 animate-page-in">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <PageHeader title="Proyección de cobranza" />
        {/* Toggle Real (JDE) / Proyectada.
            Antes solo se mostraba cuando había registros de cobranza en
            cache, lo que ocultaba el caso "JDE devolvió vacío". Ahora se
            muestra siempre que haya catálogo de compañías cargado, para
            que el usuario pueda entrar al modo Real, ver el error y
            disparar un refresh manual. */}
        {(companies.length > 0 || cobranzaRecords.length > 0) && (
          <nav className="flex bg-[var(--gray-50)] rounded-full p-0.5 text-[12px] border border-[var(--gray-200)]/60">
            <button
              onClick={() => setSourceMode('real')}
              className={`px-3.5 py-1.5 rounded-full font-medium hover-press flex items-center gap-1.5 ${sourceMode === 'real' ? 'bg-white text-[var(--gray-950)] shadow-sm' : 'text-[var(--gray-400)]'}`}
            >
              <Database className="w-3.5 h-3.5" /> Real (JDE)
            </button>
            <button
              onClick={() => setSourceMode('projected')}
              className={`px-3.5 py-1.5 rounded-full font-medium hover-press flex items-center gap-1.5 ${sourceMode === 'projected' ? 'bg-white text-[var(--gray-950)] shadow-sm' : 'text-[var(--gray-400)]'}`}
            >
              <CalendarRange className="w-3.5 h-3.5" /> Proyectada
            </button>
          </nav>
        )}
      </div>

      {/* ── Vista Real (JDE) — Fase 1: tabla raw ──────────
          Esta vista muestra los registros tal como llegan del API para
          validar el shape antes de construir el dashboard rico. Cuando el
          motor de cruce contra bancos esté listo (Fase 2), aquí va el KPI
          de % cruzado y el aging por cliente. */}
      {sourceMode === 'real' ? (
        <CobranzaRealView
          clients={clients}
          assumptions={assumptions}
          records={cobranzaRecords}
          loadedCias={cobranzaLoadedCias}
          companies={companies}
          bankStatements={bankStatements}
          reconciliation={cobranzaReconciliation}
          facturaIndex={cobranzaFacturaIndex}
          error={cobranzaError ?? null}
          onRefresh={onRefreshCobranza}
          refreshing={!!cobranzaRefreshing}
          defaultCia={selectedCia}
          onEnsureBankCoverage={onEnsureBankCoverage}
          bankCoverageLoading={!!bankCoverageLoading}
        />
      ) : (
      <>

      {/* ── Summary strip ─────────────────────────────────── */}
      <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl p-5 flex items-end gap-8 animate-card-in stagger-1 hover-lift">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Total proyectado {assumptions.year}</div>
          <AnimatedNumber
            value={total}
            format={fmtCurrency}
            className="block text-3xl font-semibold tabular-nums text-[var(--gray-950)] mt-0.5"
          />
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Días promedio de lag</div>
          <AnimatedNumber
            value={avgLag}
            format={(n) => n.toFixed(1)}
            className="block text-xl font-medium tabular-nums text-[var(--gray-950)] mt-0.5"
          />
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Clientes en cartera</div>
          <div className="text-xl font-medium tabular-nums text-[var(--gray-950)] mt-0.5">
            <AnimatedNumber value={filteredClients.length} format={(n) => Math.round(n).toString()} />
            {filteredClients.length !== clients.length && (
              <span className="text-[var(--gray-400)] text-[13px]"> / {clients.length}</span>
            )}
          </div>
          <div className="text-[11px] text-[var(--gray-400)]">Activos en el catálogo</div>
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
      {bankStatements.length > 0 && (() => {
        const bankEmpresas = Array.from(new Set(bankStatements.map(a => a.cia).filter(Boolean)));
        return (
          <div className="bg-white border border-[var(--gray-200)] rounded-xl animate-card-in stagger-1">
            <div className="flex items-end gap-8 p-4">
              <div className="flex items-center gap-2">
                <Landmark className="w-4 h-4 text-[var(--primary)]" />
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Saldo real bancos</div>
                  <AnimatedNumber
                    value={totalBankSaldo}
                    format={fmtCurrency}
                    className="block text-xl font-semibold tabular-nums text-[var(--primary)] mt-0.5"
                  />
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Cobros reales (abonos)</div>
                <AnimatedNumber
                  value={bankRealAbonos}
                  format={fmtCurrency}
                  className="block text-xl font-semibold tabular-nums text-[var(--success)] mt-0.5"
                />
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Empresas</div>
                <div className="text-xl font-semibold tabular-nums text-[var(--gray-950)] mt-0.5">
                  {bankEmpresas.length > 0 ? bankEmpresas.length : <span className="text-[var(--gray-300)]">—</span>}
                </div>
              </div>
              <div className="ml-auto text-[11px] text-[var(--gray-400)]">
                Al {bankStatements[0]?.fechaEstadoCuenta} · {bankStatements.length} cuenta{bankStatements.length !== 1 ? 's' : ''} · SWIFT
              </div>
            </div>
            {bankEmpresas.length > 0 && (
              <div className="px-4 py-3 border-t border-[var(--gray-200)]/60 bg-[var(--surface-alt)] rounded-b-xl">
                <div className="flex items-center gap-2 overflow-x-auto scrollbar-thin">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--gray-400)] flex-shrink-0">
                    Activas
                  </span>
                  <div className="flex items-center gap-1.5 flex-nowrap">
                    {bankEmpresas.map(cia => (
                      <span
                        key={cia}
                        className="inline-flex flex-shrink-0 px-2 py-0.5 rounded-md bg-white border border-[var(--gray-200)] text-[11px] font-medium text-[var(--gray-500)] whitespace-nowrap"
                      >
                        {ciaNameMap.get(cia) ?? `Cia ${cia}`}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {showSettings && (
        <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl p-4 flex gap-6 items-end animate-slide-down">
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

      {/* ── Calendario (vista principal) ──────────────────── */}
      <CalendarView
        events={events}
        clients={filteredClients}
        year={assumptions.year}
        month={activeMonth}
        onMonthChange={setActiveMonth}
        confirmedPayments={confirmedPayments}
        onConfirm={onConfirm}
        onUnconfirm={onUnconfirm}
        bankStatements={bankStatements}
      />

      {/* ── Más vistas y filtros (colapsable) ─────────────── */}
      <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl overflow-hidden animate-card-in stagger-6">
        <button
          onClick={() => setShowMore(!showMore)}
          className="w-full flex items-center justify-between px-5 py-3 hover:bg-[var(--gray-50)]/50 transition-colors"
        >
          <div className="flex items-center gap-2.5">
            <SlidersHorizontal className="w-4 h-4 text-[var(--gray-400)]" />
            <span className="text-[13px] font-semibold text-[var(--gray-950)]">Filtros y otras vistas</span>
            {(query || freqFilter.size > 0 || factorajeFilter !== 'all') && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--primary-muted)] text-[var(--primary)] font-medium">
                Filtros activos
              </span>
            )}
          </div>
          <ChevronDown className={`w-4 h-4 text-[var(--gray-400)] transition-transform ${showMore ? 'rotate-180' : ''}`} />
        </button>
        {showMore && (
          <div className="px-5 pb-4 pt-1 space-y-4 animate-slide-down">
            {/* Filtros */}
            <div className="flex flex-wrap gap-2 items-center">
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

            {/* View toggle */}
            <nav className="flex bg-[var(--gray-50)] rounded-full p-0.5 text-[13px] w-fit">
              <button
                onClick={() => setView('month')}
                className={`px-4 py-1 rounded-full font-medium hover-press ${view === 'month' ? 'bg-white text-[var(--gray-950)] shadow-sm' : 'text-[var(--gray-400)]'}`}
              >Por mes</button>
              <button
                onClick={() => setView('client')}
                className={`px-4 py-1 rounded-full font-medium hover-press ${view === 'client' ? 'bg-white text-[var(--gray-950)] shadow-sm' : 'text-[var(--gray-400)]'}`}
              >Por cliente</button>
            </nav>

            {/* Vista alterna */}
            <div key={view} className="animate-view-swap">
              {view === 'month' && <MonthView events={events} total={total} />}
              {view === 'client' && <ClientView events={events} clients={filteredClients} total={total} />}
            </div>
          </div>
        )}
      </div>

      <DetailView events={events} clients={filteredClients} />

      </>
      )}
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
function CalendarView({ events, clients, year, month, onMonthChange, confirmedPayments, onConfirm, onUnconfirm, bankStatements = [] }: {
  events: CollectionEvent[];
  clients: Client[];
  year: number;
  month: number;
  onMonthChange: (month: number) => void;
  confirmedPayments: ConfirmedPayment[];
  onConfirm: (p: ConfirmedPayment) => void;
  onUnconfirm: (key: string) => void;
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

  const progressPct = monthTotal > 0 ? (confirmedTotal / monthTotal) * 100 : 0;

  return (
    <div className="space-y-4">
      {/* Month summary — compact strip */}
      <div className="bg-white border border-[var(--gray-200)] rounded-xl p-4 flex items-end gap-8 flex-wrap animate-card-in stagger-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Cobranza total</div>
          <AnimatedNumber
            value={monthTotal}
            format={fmtCurrency}
            className="block text-xl font-semibold tabular-nums text-[var(--gray-950)] mt-0.5"
          />
          <div className="text-[11px] text-[var(--gray-400)]">{monthEvents} pagos · {uniqueClients} clientes con pagos</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--success)]">Cobrado (real)</div>
          <AnimatedNumber
            value={confirmedTotal}
            format={fmtCurrency}
            className="block text-xl font-semibold tabular-nums text-[var(--success)] mt-0.5"
          />
          <div className="text-[11px] text-[var(--gray-400)]">{confirmedCount} confirmados</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--primary)]">Proyectado</div>
          <AnimatedNumber
            value={projectedTotal}
            format={fmtCurrency}
            className="block text-xl font-semibold tabular-nums text-[var(--primary)] mt-0.5"
          />
          <div className="text-[11px] text-[var(--gray-400)]">{monthEvents - confirmedCount} pendientes</div>
        </div>
        <div className="ml-auto min-w-[200px]">
          <div className="flex items-baseline justify-between">
            <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">% Avance</div>
            <div className="text-xl font-semibold tabular-nums text-[var(--gray-950)]">
              {monthTotal > 0 ? (
                <AnimatedNumber value={progressPct} format={(n) => `${n.toFixed(0)}%`} />
              ) : (
                '—'
              )}
            </div>
          </div>
          <div className="mt-1.5 h-1.5 bg-[var(--gray-50)] rounded-full overflow-hidden">
            <div
              className="h-full bg-[var(--success)] rounded-full"
              style={{ width: `${progressPct}%`, transition: 'width var(--motion-layout) var(--ease-smooth)' }}
            />
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
                    className="h-full bg-[var(--success)]"
                    style={{
                      width: `${reconSummary.matchedCount / Math.max(1, reconSummary.matchedCount + reconSummary.likelyCount + reconSummary.unmatchedCount) * 100}%`,
                      transition: 'width var(--motion-layout) var(--ease-smooth)',
                    }}
                    title={`Cruzados: ${reconSummary.matchedCount}`}
                  />
                  <div
                    className="h-full bg-[var(--info)]"
                    style={{
                      width: `${reconSummary.likelyCount / Math.max(1, reconSummary.matchedCount + reconSummary.likelyCount + reconSummary.unmatchedCount) * 100}%`,
                      transition: 'width var(--motion-layout) var(--ease-smooth)',
                    }}
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

      {/* Calendar (header oscuro + grid en una sola card) */}
      <div key={`grid-${year}-${month}`} className="bg-white border border-[var(--gray-200)]/60 rounded-xl overflow-hidden animate-card-in stagger-5">
        <div className="flex items-center justify-between px-4 py-3 bg-[var(--gray-950)]">
          <button
            onClick={prevMonth}
            aria-label="Mes anterior"
            className="p-1.5 rounded-lg hover:bg-white/10 text-white/70 hover:text-white transition-colors"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <h2 key={`${year}-${month}`} className="text-lg font-semibold text-white flex items-center gap-2 animate-slide-down">
            <CalendarRange className="w-4 h-4 text-white/60" />
            <span>{MONTH_NAMES[month]} {year}</span>
          </h2>
          <div className="flex items-center gap-1">
            <button
              onClick={handleExport}
              title="Exportar mes"
              aria-label="Exportar mes"
              className="p-1.5 rounded-lg hover:bg-white/10 text-white/70 hover:text-white transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={nextMonth}
              aria-label="Mes siguiente"
              className="p-1.5 rounded-lg hover:bg-white/10 text-white/70 hover:text-white transition-colors"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
        </div>
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
            const dayTotal = dayEvents.reduce((s, e) => s + e.amount, 0);
            const intensity = dayTotal > 0 ? Math.max(0.08, Math.min(0.85, dayTotal / maxDayAmount)) : 0;
            const isWeekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
            const isHoliday = isCurrentMonth && isBankHoliday(d);
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
                className={`min-h-[84px] border-b border-r border-[var(--gray-200)]/30 p-1.5 transition-colors duration-150
                  ${!isCurrentMonth ? 'bg-[var(--surface-alt)] opacity-30' : ''}
                  ${isWeekend && isCurrentMonth && !isHoliday ? 'bg-[var(--surface-alt)]' : ''}
                  ${isSelected ? 'ring-2 ring-[var(--primary)] ring-inset' : ''}
                  ${isToday && !isSelected ? 'ring-2 ring-[var(--success)] ring-inset' : ''}
                  ${isCurrentMonth && !isHoliday ? 'hover:bg-[var(--gray-50)]/60 cursor-pointer' : ''}
                  ${isHoliday ? 'cursor-not-allowed' : ''}
                `}
                style={isHoliday && isCurrentMonth ? { backgroundColor: 'rgba(255, 159, 10, 0.12)' } : undefined}
                title={isHoliday ? 'Día inhábil bancario' : undefined}
                onClick={() => isCurrentMonth && !isHoliday && setSelectedDay(isSelected ? null : iso)}
              >
                <div className="flex justify-between items-start">
                  <span className={`text-[12px] font-medium ${
                    isToday
                      ? 'bg-[var(--success)] text-white w-5 h-5 rounded-full flex items-center justify-center text-[11px] animate-pulse-ring'
                      : isHoliday && isCurrentMonth
                        ? 'text-[var(--warning)] line-through'
                        : isCurrentMonth ? 'text-[var(--gray-950)]' : 'text-[var(--gray-200)]'
                  }`}>
                    {d.getUTCDate()}
                  </span>
                  {isHoliday && isCurrentMonth && (
                    <span className="text-[9px] uppercase tracking-wide font-semibold text-[var(--warning)] leading-none mt-0.5">Inhábil</span>
                  )}
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
                {dayTotal > 0 && isCurrentMonth && (
                  <div className="mt-1">
                    <div className="rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums" style={{ backgroundColor: pillBg, color: pillFg }}>
                      {dayTotal >= 1_000_000 ? `${(dayTotal / 1_000_000).toFixed(1)}M` : dayTotal >= 1000 ? `${Math.round(dayTotal / 1000)}K` : fmtCurrency(dayTotal)}
                    </div>
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
      {selectedDay && selectedEvents.length > 0 && (
        <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl p-4 animate-slide-down">
          <div className="flex justify-between items-center mb-3">
            <h3 className="font-semibold text-[14px] text-[var(--gray-950)]">
              {new Date(selectedDay + 'T12:00:00').toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })}
            </h3>
            <span className="text-lg font-semibold tabular-nums text-[var(--success)]">
              +{fmtCurrency(selectedTotal)}
            </span>
          </div>
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
                <div key={i} className={`flex items-center gap-2 py-2 px-3 rounded-lg ${rowBg} hover:brightness-95 transition-colors`}>
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
                    className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center transition-colors ${
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
        <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl p-4 hover-lift animate-card-in">
          <h3 className="text-[13px] font-semibold text-[var(--gray-950)] mb-3">Cobranza semanal</h3>
          <div className="space-y-2">
            {Object.entries(weeklyTotals).sort(([a], [b]) => a.localeCompare(b)).map(([week, total], i) => {
              const pct = monthTotal ? (total / monthTotal) * 100 : 0;
              const delay = `${i * 60}ms`;
              return (
                <div key={week} className="grid grid-cols-[90px_1fr_100px_50px] items-center gap-3 animate-slide-up" style={{ animationDelay: delay }}>
                  <span className="text-[12px] text-[var(--gray-400)]">
                    Sem. {new Date(week + 'T12:00:00').toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })}
                  </span>
                  <div className="h-5 bg-[var(--gray-50)] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[var(--primary)] rounded-full animate-progress-fill"
                      style={{ width: `${Math.min(100, pct)}%`, animationDelay: delay }}
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
          const delay = `${i * 40}ms`;
          return (
            <div
              key={m}
              className="grid grid-cols-[44px_1fr_140px_90px] items-center gap-3 text-[13px] animate-slide-up"
              style={{ animationDelay: delay }}
            >
              <span className="text-[var(--gray-400)] font-medium">{m}</span>
              <div className="h-7 bg-[var(--gray-50)] rounded-md relative overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 bg-[var(--primary)] rounded-md animate-progress-fill"
                  style={{ width: `${pct}%`, animationDelay: delay }}
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
        <AnimatedNumber value={total} format={fmtCurrency} className="font-semibold tabular-nums" />
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
          {rows.map(({ c, total: rowTotal, count, avgLag }, i) => {
            const pct = (rowTotal / maxTotal) * 100;
            const share = total ? (rowTotal / total) * 100 : 0;
            const delay = `${Math.min(i, 20) * 25}ms`;
            return (
              <tr key={c.id} className="border-t border-[var(--gray-200)]/40 hover-row animate-slide-up" style={{ animationDelay: delay }}>
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
                        className="h-full bg-[var(--primary)] rounded-full animate-progress-fill"
                        style={{ width: `${pct}%`, animationDelay: delay }}
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
            <tr>
              <td colSpan={5} className="text-center py-10">
                <div className="flex flex-col items-center gap-2 animate-fade-in">
                  <Inbox className="w-6 h-6 text-[var(--gray-300)]" />
                  <span className="text-[13px] text-[var(--gray-400)]">Sin datos con los filtros actuales.</span>
                </div>
              </td>
            </tr>
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

const COLLECTION_CALENDAR_FILTERS: Array<{ id: CollectionCalendarSourceFilter; label: string }> = [
  { id: 'all', label: 'Todas' },
  { id: 'bank', label: 'Real banco' },
  { id: 'bank_unmatched', label: 'Banco sin CXC' },
  { id: 'jde', label: 'JDE' },
  { id: 'cxc', label: 'CXC pendiente' },
  { id: 'projected', label: 'Proyectado' },
  { id: 'unruled', label: 'Sin regla' },
];

const COLLECTION_CALENDAR_SOURCE_STYLES: Record<CollectionCalendarEventSource, {
  color: string;
  rgb: string;
  textClass: string;
  borderClass: string;
}> = {
  BANK_MATCHED: {
    color: '#10b981',
    rgb: '16,185,129',
    textClass: 'text-[var(--success)]',
    borderClass: 'border-[var(--success)]/30',
  },
  BANK_UNMATCHED: {
    color: '#f59e0b',
    rgb: '245,158,11',
    textClass: 'text-[var(--warning,_#d97706)]',
    borderClass: 'border-[var(--warning,_#f59e0b)]/30',
  },
  JDE_PAID_UNMATCHED: {
    color: '#2563eb',
    rgb: '37,99,235',
    textClass: 'text-[var(--primary)]',
    borderClass: 'border-[var(--primary)]/30',
  },
  CXC_RULED_PENDING: {
    color: '#7c3aed',
    rgb: '124,58,237',
    textClass: 'text-[#6d28d9]',
    borderClass: 'border-[#7c3aed]/30',
  },
  PROJECTED_CLIENT_RULE: {
    color: '#64748b',
    rgb: '100,116,139',
    textClass: 'text-[var(--gray-500)]',
    borderClass: 'border-[var(--gray-300)]',
  },
  CXC_UNRULED_PENDING: {
    color: '#ef4444',
    rgb: '239,68,68',
    textClass: 'text-[var(--danger)]',
    borderClass: 'border-[var(--danger)]/30',
  },
};

function CollectionSourceBadge({ source }: { source: CollectionCalendarEventSource }) {
  const style = COLLECTION_CALENDAR_SOURCE_STYLES[source];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border bg-white text-[11px] font-medium ${style.textClass} ${style.borderClass}`}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: style.color }} />
      {COLLECTION_CALENDAR_SOURCE_LABELS[source]}
    </span>
  );
}

function dominantCollectionSource(events: CollectionCalendarEvent[]): CollectionCalendarEventSource | null {
  const totals = new Map<CollectionCalendarEventSource, number>();
  for (const event of events) {
    totals.set(event.source, (totals.get(event.source) ?? 0) + event.amount);
  }
  let dominant: CollectionCalendarEventSource | null = null;
  let max = 0;
  for (const [source, amount] of totals) {
    if (amount > max) {
      dominant = source;
      max = amount;
    }
  }
  return dominant;
}

function collectionSourceAmount(
  events: CollectionCalendarEvent[],
  predicate: (source: CollectionCalendarEventSource) => boolean,
): number {
  return events
    .filter(event => predicate(event.source))
    .reduce((sum, event) => sum + event.amount, 0);
}

function collectionEventMatchesCia(event: CollectionCalendarEvent, ciaFilter: string): boolean {
  if (ciaFilter === 'all') return true;
  // Las proyecciones vienen del catalogo de clientes y no siempre tienen cia
  // JDE; se mantienen visibles para que el calendario futuro no desaparezca
  // al filtrar una compania.
  if (event.source === 'PROJECTED_CLIENT_RULE') return true;
  return event.cia === ciaFilter;
}

// ─────────────────────────────────────────────────────────────────────────
// CobranzaRealCalendar — calendario unico de banco + JDE + CXC + proyeccion.
//
// El input ya viene normalizado por `collectionCalendarEngine`; esta vista
// solo filtra, pinta barras por fuente y expone el drill-down operativo.
// ─────────────────────────────────────────────────────────────────────────
function CobranzaRealCalendar({
  calendar,
  ciaFilter,
  bankCoverage,
  onEnsureBankCoverage,
  bankCoverageLoading,
}: {
  calendar: BuildCollectionCalendarResult;
  ciaFilter: string;
  bankCoverage?: RealReconciliationBankCoverage;
  onEnsureBankCoverage?: (request: EnsureBankCoverageRequest) => void | Promise<void>;
  bankCoverageLoading?: boolean;
}) {
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [month, setMonth] = useState(() => new Date().getMonth());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<CollectionCalendarSourceFilter>('all');

  const monthEvents = useMemo(() => {
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
    return calendar.events.filter(event => {
      if (!event.date.startsWith(prefix)) return false;
      if (!collectionEventMatchesCia(event, ciaFilter)) return false;
      if (sourceFilter === 'all' && event.source === 'BANK_UNMATCHED') return false;
      return calendarEventMatchesSourceFilter(event, sourceFilter);
    });
  }, [calendar.events, year, month, ciaFilter, sourceFilter]);

  const byDay = useMemo(() => {
    const map = new Map<string, CollectionCalendarEvent[]>();
    for (const event of monthEvents) {
      const list = map.get(event.date) ?? [];
      list.push(event);
      map.set(event.date, list);
    }
    return map;
  }, [monthEvents]);

  // Totales por fuente. La KPI strip estilo legacy solo muestra
  // BANK_MATCHED (Real banco) y JDE+CXC (pendiente). BANK_UNMATCHED y
  // PROYECTADO siguen reflejados en el calendario por color/dot pero ya
  // no necesitan acumular un total — la fila inline de seis números
  // que vivía aquí migró a la KPI strip de cuatro bloques.
  const totalMes = monthEvents.reduce((s, event) => s + event.amount, 0);
  const bankTotal = collectionSourceAmount(monthEvents, source => source === 'BANK_MATCHED');
  const jdeTotal = collectionSourceAmount(monthEvents, source => source === 'JDE_PAID_UNMATCHED');
  const cxcTotal = collectionSourceAmount(monthEvents, source => source === 'CXC_RULED_PENDING' || source === 'CXC_UNRULED_PENDING');

  const firstDay = new Date(Date.UTC(year, month, 1));
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  const visibleFrom = firstDay.toISOString().slice(0, 10);
  const visibleTo = lastDay.toISOString().slice(0, 10);
  const loadedDateSet = useMemo(
    () => new Set(bankCoverage?.loadedDates ?? []),
    [bankCoverage],
  );
  const loadedInMonth = useMemo(
    () => (bankCoverage?.loadedDates ?? []).filter(date => date >= visibleFrom && date <= visibleTo).length,
    [bankCoverage, visibleFrom, visibleTo],
  );
  const monthDayCount = lastDay.getUTCDate();
  const coveragePct = monthDayCount > 0 ? loadedInMonth / monthDayCount : 0;
  const coverageWeak = loadedDateSet.size === 0 || coveragePct < 0.4;
  const startPad = (firstDay.getUTCDay() + 6) % 7;
  const days: Date[] = [];
  for (let i = -startPad; i < lastDay.getUTCDate() + (7 - ((lastDay.getUTCDay() + 6) % 7 + 1) % 7); i++) {
    days.push(new Date(Date.UTC(year, month, i + 1)));
  }
  while (days.length % 7 !== 0) days.push(new Date(Date.UTC(year, month, days.length - startPad + 1)));

  const maxDayMonto = Math.max(
    ...Array.from(byDay.values()).map(list => list.reduce((s, event) => s + event.amount, 0)),
    1,
  );

  const prevMonth = () => {
    if (month === 0) { setYear(year - 1); setMonth(11); }
    else setMonth(month - 1);
    setSelectedDay(null);
  };
  const nextMonth = () => {
    if (month === 11) { setYear(year + 1); setMonth(0); }
    else setMonth(month + 1);
    setSelectedDay(null);
  };

  const monthLabel = new Date(Date.UTC(year, month, 1)).toLocaleDateString('es-MX', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  const selectedEvents = selectedDay ? (byDay.get(selectedDay) ?? []) : [];
  const selectedTotal = selectedEvents.reduce((s, event) => s + event.amount, 0);

  useEffect(() => {
    if (selectedDay && !byDay.has(selectedDay)) setSelectedDay(null);
  }, [selectedDay, byDay]);

  // ── Métricas derivadas para la KPI strip estilo legacy ─────────────────
  // El legacy original mostraba (Total / Cobrado / Proyectado / % Avance).
  // Aquí adaptamos a las cuatro fuentes del modelo nuevo:
  //   1. Total CXC          — todo lo agregado por el calendar engine.
  //   2. Real banco         — BANK_MATCHED (entró al banco y cruzó factura).
  //   3. JDE + CXC pendiente — JDE_PAID_UNMATCHED + CXC_RULED_PENDING +
  //      CXC_UNRULED_PENDING. Es la cobranza que JDE/CXC reconoce pero
  //      todavía no aparece cruzada con banco.
  //   4. % Cruzado banco    — qué fracción de la cobranza esperada
  //      (BANK + JDE + CXC) ya cobró por banco. Excluye PROYECTADO porque
  //      no es factura emitida.
  const pendingTotal = jdeTotal + cxcTotal;
  const expectedThisMonth = bankTotal + pendingTotal;
  const progressPct = expectedThisMonth > 0
    ? (bankTotal / expectedThisMonth) * 100
    : 0;
  const eventCount = monthEvents.length;
  const uniqueClientCount = useMemo(() => {
    const set = new Set<string>();
    for (const event of monthEvents) {
      const key = event.clientId
        ?? `${event.cia ?? ''}::${event.noCliente ?? ''}`;
      set.add(key);
    }
    return set.size;
  }, [monthEvents]);

  // Totales semanales (lunes-domingo). Replica el bloque "Cobranza
  // semanal" del calendario legacy. Si el mes no tiene eventos
  // visibles la sección no se renderiza.
  const weeklyTotals = useMemo(() => {
    const weeks: Record<string, number> = {};
    for (const [date, evts] of byDay.entries()) {
      const d = new Date(date + 'T12:00:00');
      const weekStart = new Date(d);
      weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
      const key = weekStart.toISOString().slice(0, 10);
      weeks[key] = (weeks[key] ?? 0) + evts.reduce((s, e) => s + e.amount, 0);
    }
    return weeks;
  }, [byDay]);

  const todayISO = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-4">
      {/* ── KPI strip estilo legacy ────────────────────────────
          Cuatro bloques: Total CXC, Real banco, JDE+CXC pendiente,
          % Cruzado banco con barra de avance. La fila inline de seis
          totales que vivía aquí migró a esta estructura para que el
          primer scan visual sea idéntico al calendario legacy. */}
      <div className="bg-white border border-[var(--gray-200)] rounded-xl p-4 flex items-end gap-8 flex-wrap animate-card-in stagger-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Total CXC</div>
          <AnimatedNumber
            value={totalMes}
            format={fmtCurrency}
            className="block text-xl font-semibold tabular-nums text-[var(--gray-950)] mt-0.5"
          />
          <div className="text-[11px] text-[var(--gray-400)]">
            {eventCount} evento{eventCount !== 1 ? 's' : ''} · {uniqueClientCount} cliente{uniqueClientCount !== 1 ? 's' : ''}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--success)]">Real banco</div>
          <AnimatedNumber
            value={bankTotal}
            format={fmtCurrency}
            className="block text-xl font-semibold tabular-nums text-[var(--success)] mt-0.5"
          />
          <div className="text-[11px] text-[var(--gray-400)]">cruzado con banco</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--primary)]">JDE + CXC pendiente</div>
          <AnimatedNumber
            value={pendingTotal}
            format={fmtCurrency}
            className="block text-xl font-semibold tabular-nums text-[var(--primary)] mt-0.5"
          />
          <div className="text-[11px] text-[var(--gray-400)]">JDE pago + factura abierta</div>
        </div>
        <div className="ml-auto min-w-[200px]">
          <div className="flex items-baseline justify-between">
            <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">% Cruzado banco</div>
            <div className="text-xl font-semibold tabular-nums text-[var(--gray-950)]">
              {expectedThisMonth > 0 ? (
                <AnimatedNumber value={progressPct} format={(n) => `${n.toFixed(0)}%`} />
              ) : (
                '—'
              )}
            </div>
          </div>
          <div className="mt-1.5 h-1.5 bg-[var(--gray-50)] rounded-full overflow-hidden">
            <div
              className="h-full bg-[var(--success)] rounded-full"
              style={{ width: `${progressPct}%`, transition: 'width var(--motion-layout) var(--ease-smooth)' }}
            />
          </div>
        </div>
      </div>

      {/* ── Calendario (header oscuro + chips + grid + detalle) ──
          Una sola card con la cabecera navy del legacy, la fila de
          chips de fuente con estilo legacy (primary cuando activo),
          el grid de celdas verticales y el panel de detalle. */}
      <div key={`real-grid-${year}-${month}`} className="bg-white border border-[var(--gray-200)]/60 rounded-xl overflow-hidden animate-card-in stagger-5">
        <div className="flex items-center justify-between px-4 py-3 bg-[var(--gray-950)]">
          <button
            onClick={prevMonth}
            aria-label="Mes anterior"
            className="p-1.5 rounded-lg hover:bg-white/10 text-white/70 hover:text-white transition-colors"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <h2 key={`${year}-${month}`} className="text-lg font-semibold text-white flex items-center gap-2 capitalize animate-slide-down">
            <CalendarRange className="w-4 h-4 text-white/60" />
            <span>{monthLabel}</span>
          </h2>
          <button
            onClick={nextMonth}
            aria-label="Mes siguiente"
            className="p-1.5 rounded-lg hover:bg-white/10 text-white/70 hover:text-white transition-colors"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>

        {/* Chips de fuente — usan el patrón redondo del Chip legacy.
            Sus aria-labels y nombres accesibles se conservan exactos
            (Todas / Real banco / Banco sin CXC / JDE / CXC pendiente
            / Proyectado / Sin regla) porque CollectionProjection.test
            los matchea por getByRole('button', { name: ... }). */}
        <div className="px-4 py-3 border-b border-[var(--gray-200)]/60 bg-white">
          <div className="flex flex-wrap gap-1.5" aria-label="Filtrar fuente de calendario">
            {COLLECTION_CALENDAR_FILTERS.map(filter => {
              const active = sourceFilter === filter.id;
              return (
                <button
                  key={filter.id}
                  onClick={() => {
                    setSourceFilter(filter.id);
                    setSelectedDay(null);
                  }}
                  className={`px-3 h-8 rounded-full text-[12px] font-medium border transition-colors hover-press ${
                    active
                      ? 'bg-[var(--primary)] text-white border-[var(--primary)]'
                      : 'bg-white text-[var(--gray-400)] border-[var(--gray-200)] hover:text-[var(--gray-950)]'
                  }`}
                >
                  {filter.label}
                </button>
              );
            })}
          </div>
          {onEnsureBankCoverage && coverageWeak && (
            <div className="mt-3 flex items-center gap-3 rounded-lg border border-[var(--warning,_#f59e0b)]/30 bg-[var(--warning-muted,_#fef3c7)] px-3 py-2 text-[12px]">
              <AlertTriangle className="w-4 h-4 text-[var(--warning,_#b45309)] flex-shrink-0" />
              <div className="min-w-0">
                <div className="font-medium text-[var(--gray-950)]">Cobertura bancaria parcial del mes visible</div>
                <div className="text-[var(--gray-500)]">
                  {loadedInMonth} de {monthDayCount} días con movimientos cargados. Cargar sólo este rango mejora el cruce sin traer todo el año.
                </div>
              </div>
              <button
                onClick={() => {
                  void onEnsureBankCoverage({
                    from: visibleFrom,
                    to: visibleTo,
                    ciaFilter: ciaFilter === 'all' ? undefined : [ciaFilter],
                  });
                }}
                disabled={bankCoverageLoading}
                className="ml-auto inline-flex items-center gap-1.5 px-3 h-8 rounded-lg bg-[var(--gray-950)] text-white text-[12px] font-medium disabled:opacity-50"
              >
                {bankCoverageLoading ? 'Cargando…' : 'Cargar bancos del mes'}
              </button>
            </div>
          )}
        </div>

        {/* Cabecera de días de la semana — fondo surface-alt como legacy */}
        <div className="grid grid-cols-7 border-b border-[var(--gray-200)]/40">
          {DOW_HEADERS.map(d => (
            <div key={d} className="px-2 py-2 text-center text-[11px] font-medium text-[var(--gray-400)] bg-[var(--surface-alt)] uppercase tracking-wide">{d}</div>
          ))}
        </div>

        {/* Grid de días — celdas verticales min-h-[84px] tipo agenda
            (NO aspect-square). Mantiene aria-label, breakdown de
            fuente con dots y tinte por fuente dominante. */}
        <div className="grid grid-cols-7">
          {days.map((d, i) => {
            const inMonth = d.getUTCMonth() === month;
            const iso = d.toISOString().slice(0, 10);
            const dayEvents = byDay.get(iso) ?? [];
            const dayTotal = dayEvents.reduce((s, event) => s + event.amount, 0);
            const isSelected = selectedDay === iso;
            const isToday = iso === todayISO;
            const isWeekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
            const heat = dayTotal / maxDayMonto;
            const dominantSource = dominantCollectionSource(dayEvents);
            const sourceStyle = dominantSource ? COLLECTION_CALENDAR_SOURCE_STYLES[dominantSource] : null;
            // Pill: fondo coloreado por la fuente dominante con
            // intensidad proporcional al monto, igual que el legacy
            // hace con confirmado/proyectado.
            let pillBg = 'transparent';
            let pillFg = 'var(--gray-950)';
            if (sourceStyle && dayTotal > 0) {
              const intensity = Math.max(0.18, Math.min(0.88, heat + 0.12));
              pillBg = `rgba(${sourceStyle.rgb}, ${intensity})`;
              pillFg = intensity > 0.5 ? 'white' : sourceStyle.color;
            }
            const sourceBreakdown = Array.from(
              dayEvents.reduce((map, event) => {
                map.set(event.source, (map.get(event.source) ?? 0) + 1);
                return map;
              }, new Map<CollectionCalendarEventSource, number>()),
            );
            return (
              <button
                key={i}
                onClick={() => dayEvents.length > 0 && setSelectedDay(isSelected ? null : iso)}
                disabled={!inMonth}
                aria-label={`${iso}: ${dayEvents.length} evento${dayEvents.length !== 1 ? 's' : ''}${dayTotal > 0 ? ` por ${fmtCurrency(dayTotal)}` : ''}`}
                className={`min-h-[84px] border-b border-r border-[var(--gray-200)]/30 p-1.5 text-left transition-colors duration-150 flex flex-col
                  ${!inMonth ? 'bg-[var(--surface-alt)] opacity-30' : ''}
                  ${isWeekend && inMonth ? 'bg-[var(--surface-alt)]' : ''}
                  ${isSelected ? 'ring-2 ring-[var(--primary)] ring-inset' : ''}
                  ${isToday && !isSelected ? 'ring-2 ring-[var(--success)] ring-inset' : ''}
                  ${inMonth && dayEvents.length > 0 ? 'hover:bg-[var(--gray-50)]/60 cursor-pointer' : 'cursor-default'}
                `}
              >
                <div className="flex justify-between items-start">
                  <span className={`text-[12px] font-medium ${
                    isToday && inMonth
                      ? 'bg-[var(--success)] text-white w-5 h-5 rounded-full flex items-center justify-center text-[11px]'
                      : inMonth ? 'text-[var(--gray-950)]' : 'text-[var(--gray-200)]'
                  }`}>
                    {d.getUTCDate()}
                  </span>
                  {dayEvents.length > 0 && (
                    <span className="text-[10px] text-[var(--gray-400)] tabular-nums">{dayEvents.length}</span>
                  )}
                </div>
                {dayTotal > 0 && inMonth && (
                  <div className="mt-1">
                    <div
                      className="rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums inline-block"
                      style={{ backgroundColor: pillBg, color: pillFg }}
                    >
                      {dayTotal >= 1_000_000
                        ? `${(dayTotal / 1_000_000).toFixed(1)}M`
                        : dayTotal >= 1000
                          ? `${Math.round(dayTotal / 1000)}K`
                          : fmtCompact(dayTotal)}
                    </div>
                  </div>
                )}
                {sourceBreakdown.length > 0 && inMonth && (
                  <div className="flex items-center gap-0.5 mt-auto pt-1">
                    {sourceBreakdown.slice(0, 5).map(([source, count]) => (
                      <span
                        key={source}
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ backgroundColor: COLLECTION_CALENDAR_SOURCE_STYLES[source].color }}
                        title={`${COLLECTION_CALENDAR_SOURCE_LABELS[source]}: ${count}`}
                      />
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Detalle del día — mismo card, look legacy */}
        {selectedDay && (
          <div className="border-t border-[var(--gray-200)]/60 bg-[var(--surface-alt)] animate-slide-down">
            <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
              <span className="text-[13px] font-semibold text-[var(--gray-950)] capitalize">
                {new Date(selectedDay + 'T12:00:00Z').toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })}
              </span>
              <span className="text-[11px] text-[var(--gray-500)]">
                {selectedEvents.length} evento{selectedEvents.length !== 1 ? 's' : ''} · {fmtCurrency(selectedTotal)}
              </span>
              <button
                onClick={() => setSelectedDay(null)}
                className="ml-auto text-[12px] text-[var(--primary)] hover:underline"
              >
                Cerrar
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead className="text-[var(--gray-500)] text-[11px] uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-3 py-2">Fuente del dato</th>
                    <th className="text-left px-3 py-2">Cliente / factura</th>
                    <th className="text-left px-3 py-2">Fecha / regla</th>
                    <th className="text-left px-3 py-2">Origen / cruce</th>
                    <th className="text-right px-3 py-2">Importe</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedEvents.map(event => (
                    <tr key={event.id} className="border-t border-[var(--gray-100)]">
                      <td className="px-3 py-2">
                        <CollectionSourceBadge source={event.source} />
                        <div className="text-[10px] text-[var(--gray-400)] mt-1">{event.statusLabel}</div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium text-[var(--gray-950)] truncate max-w-[260px]" title={event.clientName}>
                          {event.clientName}
                        </div>
                        <div className="text-[10px] text-[var(--gray-400)] tabular-nums">
                          {event.cia ? `${event.cia} · ` : ''}
                          {event.noCliente ? `#${event.noCliente}` : event.clientId ?? 'Sin cliente'}
                          {event.noFactura ? ` · Fact. ${event.noFactura}` : ''}
                        </div>
                        {event.facturas.length > 1 && (
                          <div className="text-[10px] text-[var(--gray-400)] mt-0.5">
                            {event.facturas.length} facturas cruzadas
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="tabular-nums text-[var(--gray-950)]">{event.date}</div>
                        <div className="text-[10px] text-[var(--gray-500)] max-w-[300px]">{event.dateReason}</div>
                        <div className="text-[10px] text-[var(--gray-400)] max-w-[300px]">{event.ruleApplied}</div>
                      </td>
                      <td className="px-3 py-2">
                        {event.bank ? (
                          <div className="space-y-0.5">
                            <div className="text-[var(--gray-950)] tabular-nums">{event.bank.cia} · {event.bank.cuenta}</div>
                            <div className="text-[10px] text-[var(--gray-400)] max-w-[260px] truncate" title={event.bank.concepto}>{event.bank.concepto || 'Sin concepto'}</div>
                            <code className="font-mono text-[10px] text-[var(--gray-500)]">{event.bank.referencia || 'Sin referencia'}</code>
                            {typeof event.confidence === 'number' && (
                              <div className="text-[10px] text-[var(--gray-400)]">Confianza {(event.confidence * 100).toFixed(0)}%</div>
                            )}
                          </div>
                        ) : event.projected ? (
                          <span className="text-[11px] text-[var(--gray-500)]">Regla de cliente sin factura CXC emitida.</span>
                        ) : event.source === 'JDE_PAID_UNMATCHED' ? (
                          <span className="text-[11px] text-[var(--gray-500)]">JDE reporta Fecha_Pago; no se requiere banco cargado.</span>
                        ) : (
                          <span className="text-[11px] text-[var(--gray-500)]">Factura CXC pendiente.</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-[var(--gray-950)]">
                        {fmtCurrency(event.amount)}
                      </td>
                    </tr>
                  ))}
                  {selectedEvents.length === 0 && (
                    <tr><td colSpan={5} className="text-center text-[11px] text-[var(--gray-400)] py-6">Sin cobranza este día.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Cobranza semanal — réplica del bloque del calendario legacy.
          Lunes-domingo, ordenado por fecha. Solo se muestra cuando
          hay eventos en el mes para no dejar una card vacía. */}
      {Object.keys(weeklyTotals).length > 0 && (
        <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl p-4 animate-card-in">
          <h3 className="text-[13px] font-semibold text-[var(--gray-950)] mb-3">Cobranza semanal</h3>
          <div className="space-y-2">
            {Object.entries(weeklyTotals)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([week, weekTotal], i) => {
                const pct = totalMes ? (weekTotal / totalMes) * 100 : 0;
                const delay = `${i * 60}ms`;
                return (
                  <div key={week} className="grid grid-cols-[90px_1fr_100px_50px] items-center gap-3 animate-slide-up" style={{ animationDelay: delay }}>
                    <span className="text-[12px] text-[var(--gray-400)]">
                      Sem. {new Date(week + 'T12:00:00').toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })}
                    </span>
                    <div className="h-5 bg-[var(--gray-50)] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[var(--primary)] rounded-full animate-progress-fill"
                        style={{ width: `${Math.min(100, pct)}%`, animationDelay: delay }}
                      />
                    </div>
                    <span className="text-[13px] font-medium tabular-nums text-right">{fmtCurrency(weekTotal)}</span>
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

// ─────────────────────────────────────────────────────────────────────────
// ClientAgingTable — Top clientes con saldo abierto
//
// Aging por cliente (no por factura): agrupa las facturas filtradas por
// cliente, calcula el saldo total + buckets de antigüedad (por vencer,
// 1-30, 31-60, 61-90, 90+), y muestra el % cruzado con banco para cada
// cliente. Las top 20 facturas individuales siguen visibles abajo en la
// tabla raw — esta tabla es para el primer scan visual.
//
// Cuando hay datos de bancos cargados, también muestra una columna
// "Cobrado banco" con el porcentaje de facturas del cliente que cruzaron
// — si un cliente tiene 4 facturas y 3 cruzaron, dice "75%".
// ─────────────────────────────────────────────────────────────────────────
function ClientAgingTable({
  records,
  matchByFactura,
  bankActive,
}: {
  records: CobranzaRecord[];
  matchByFactura: Map<string, RealReconciliationMatch>;
  bankActive: boolean;
}) {
  // Agrupar por cliente. Usamos `${cia}::${noCliente}` para no fusionar el
  // mismo cliente entre dos compañías (caso real: HOMEX puede facturar a
  // Senda Norte y Senda Sur — son dos cuentas diferentes en JDE).
  const aging = useMemo(() => {
    type Bucket = { saldo: number; bruto: number };
    type Aging = {
      key: string;
      cia: string;
      noCliente: string;
      nombreCliente: string;
      saldoTotal: number;
      brutoTotal: number;
      facturasTotal: number;
      facturasCobradas: number;
      porVencer: Bucket;
      v1_30: Bucket;
      v31_60: Bucket;
      v61_90: Bucket;
      mas90: Bucket;
    };
    const map = new Map<string, Aging>();
    for (const r of records) {
      const key = `${r.cia}::${r.noCliente}`;
      let a = map.get(key);
      if (!a) {
        a = {
          key, cia: r.cia, noCliente: r.noCliente, nombreCliente: r.nombreCliente,
          saldoTotal: 0, brutoTotal: 0, facturasTotal: 0, facturasCobradas: 0,
          porVencer: { saldo: 0, bruto: 0 },
          v1_30: { saldo: 0, bruto: 0 },
          v31_60: { saldo: 0, bruto: 0 },
          v61_90: { saldo: 0, bruto: 0 },
          mas90: { saldo: 0, bruto: 0 },
        };
        map.set(key, a);
      }
      a.saldoTotal += r.importePendientePesos;
      a.brutoTotal += r.importeBrutoPesos;
      a.facturasTotal += 1;
      const m = matchByFactura.get(`${r.cia}::${r.noFactura}`);
      if (m?.status === 'cobrada-banco') a.facturasCobradas += 1;

      const bucket = r.diasVencida <= 0 ? a.porVencer
        : r.diasVencida <= 30 ? a.v1_30
        : r.diasVencida <= 60 ? a.v31_60
        : r.diasVencida <= 90 ? a.v61_90
        : a.mas90;
      bucket.saldo += r.importePendientePesos;
      bucket.bruto += r.importeBrutoPesos;
    }
    return Array.from(map.values()).sort((a, b) => b.saldoTotal - a.saldoTotal);
  }, [records, matchByFactura]);

  const top = aging.slice(0, 20);
  const restoSaldo = aging.slice(20).reduce((s, a) => s + a.saldoTotal, 0);

  if (top.length === 0) return null;

  const maxSaldo = Math.max(...top.map(a => a.saldoTotal), 1);

  return (
    <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--gray-200)]/60 bg-[var(--surface-alt)] flex items-center gap-2">
        <Banknote className="w-4 h-4 text-[var(--gray-400)]" />
        <span className="text-[13px] font-semibold text-[var(--gray-950)]">
          Top {Math.min(20, aging.length)} clientes — antigüedad de saldo
        </span>
        {aging.length > 20 && (
          <span className="text-[11px] text-[var(--gray-400)] ml-auto">
            +{aging.length - 20} clientes más · {fmtCurrency(restoSaldo)}
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="bg-[var(--surface-alt)] text-[var(--gray-500)] text-[11px] uppercase tracking-wide">
            <tr>
              <th className="text-left px-3 py-2">Cliente</th>
              <th className="text-right px-3 py-2">Saldo</th>
              <th className="text-left px-3 py-2 w-32">Distribución</th>
              <th className="text-right px-3 py-2">Por vencer</th>
              <th className="text-right px-3 py-2">1–30</th>
              <th className="text-right px-3 py-2">31–60</th>
              <th className="text-right px-3 py-2">61–90</th>
              <th className="text-right px-3 py-2">90+</th>
              <th className="text-right px-3 py-2">Facturas</th>
              {bankActive && <th className="text-right px-3 py-2">Cruzadas</th>}
            </tr>
          </thead>
          <tbody>
            {top.map((a) => {
              // Mini barra apilada con los 5 buckets — solo % relativos al saldoTotal.
              const seg = (b: number) => a.saldoTotal > 0 ? (b / a.saldoTotal) * 100 : 0;
              const widthPct = (a.saldoTotal / maxSaldo) * 100;
              return (
                <tr
                  key={a.key}
                  className="border-t border-[var(--gray-100)] hover:bg-[var(--gray-50)]/50"
                >
                  <td className="px-3 py-2">
                    <div className="font-medium text-[var(--gray-950)] truncate max-w-[280px]" title={a.nombreCliente}>
                      {a.nombreCliente || '—'}
                    </div>
                    <div className="text-[10px] text-[var(--gray-400)] tabular-nums">
                      {a.cia} · #{a.noCliente}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">
                    {fmtCurrency(a.saldoTotal)}
                  </td>
                  <td className="px-3 py-2">
                    {/* Barra apilada: verde "por vencer" + amarillos progresivos. */}
                    <div className="w-full h-2 bg-[var(--gray-100)] rounded-full overflow-hidden flex" style={{ width: `${Math.max(20, widthPct)}%` }}>
                      <div className="h-full bg-[var(--success)]" style={{ width: `${seg(a.porVencer.saldo)}%` }} />
                      <div className="h-full bg-[var(--warning,_#f59e0b)] opacity-60" style={{ width: `${seg(a.v1_30.saldo)}%` }} />
                      <div className="h-full bg-[var(--warning,_#f59e0b)] opacity-80" style={{ width: `${seg(a.v31_60.saldo)}%` }} />
                      <div className="h-full bg-[var(--danger)] opacity-70" style={{ width: `${seg(a.v61_90.saldo)}%` }} />
                      <div className="h-full bg-[var(--danger)]" style={{ width: `${seg(a.mas90.saldo)}%` }} />
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--success)]">
                    {a.porVencer.saldo > 0 ? fmtCurrency(a.porVencer.saldo) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--warning,_#b45309)]">
                    {a.v1_30.saldo > 0 ? fmtCurrency(a.v1_30.saldo) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--warning,_#b45309)]">
                    {a.v31_60.saldo > 0 ? fmtCurrency(a.v31_60.saldo) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--danger)]">
                    {a.v61_90.saldo > 0 ? fmtCurrency(a.v61_90.saldo) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--danger)] font-semibold">
                    {a.mas90.saldo > 0 ? fmtCurrency(a.mas90.saldo) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--gray-500)]">
                    {a.facturasTotal}
                  </td>
                  {bankActive && (
                    <td className="px-3 py-2 text-right tabular-nums">
                      {a.facturasTotal > 0
                        ? <span className={a.facturasCobradas / a.facturasTotal >= 0.8 ? 'text-[var(--success)]' : 'text-[var(--gray-500)]'}>
                            {Math.round((a.facturasCobradas / a.facturasTotal) * 100)}%
                          </span>
                        : '—'}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Pill que resume el cruce de una factura contra bancos.
 *
 * Estados:
 *   - cobrada-banco (matched): verde, muestra fecha y monto del ABONO.
 *     Si fue parte de un subset (un ABONO pagó N facturas) lo indica.
 *   - cobrada-jde-sin-banco: gris, factura ya cobrada en JDE pero sin
 *     ABONO equivalente — caso normal cuando el ABONO está fuera de la
 *     ventana de últimos 12 meses.
 *   - pendiente: ámbar tenue.
 *
 * El tier (exact / tolerance / subset) se muestra como sufijo cuando hay
 * match — el usuario sabe si fue un cruce limpio o si tuvo que aplicar
 * tolerancia.
 */
function BankBadge({ match }: { match?: RealReconciliationMatch }) {
  if (!match) {
    return <span className="text-[10px] text-[var(--gray-300)]">—</span>;
  }
  if (match.status === 'cobrada-banco') {
    const tierLabel: Record<RealMatchTier, string> = {
      'payment-confirmed-ref': 'Recibo ref.',
      'payment-auto-unique': 'Recibo',
      'payment-ambiguous': 'Recibo rev.',
      'invoice-reference': 'Factura ref.',
      'customer-reference': 'Cliente ref.',
      exact: 'Exacto',
      tolerance: '±0.5%',
      subset: `Subset ×${match.subsetSize ?? 2}`,
      'multi-abono': `Multi ×${match.bankMovements?.length ?? 2}`,
    };
    const tier = match.matchTier ?? 'exact';
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--success-muted,_#dcfce7)] text-[var(--success)] text-[11px] font-medium">
        <CheckCircle2 className="w-3 h-3" />
        {match.bankDate ? match.bankDate.slice(0, 10) : '—'}
        <span className="text-[10px] opacity-70 ml-0.5">{tierLabel[tier]}</span>
      </span>
    );
  }
  if (match.reviewStatus === 'review') {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--warning-muted,_#fef3c7)] text-[var(--warning,_#b45309)] text-[11px] font-medium"
        title={match.matchReason}
      >
        <HelpCircle className="w-3 h-3" /> Por revisar
        {typeof match.confidence === 'number' && (
          <span className="text-[10px] opacity-70 ml-0.5">{Math.round(match.confidence * 100)}%</span>
        )}
      </span>
    );
  }
  if (match.status === 'cobrada-jde-sin-banco') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--gray-100)] text-[var(--gray-500)] text-[11px]">
        <Check className="w-3 h-3" /> JDE (sin abono)
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--warning-muted,_#fef3c7)] text-[var(--warning)] text-[11px]">
      <AlertTriangle className="w-3 h-3" /> Pendiente
    </span>
  );
}

function ReviewCandidatesPanel({
  candidates,
  reconciliation,
}: {
  candidates: ReconciliationReviewCandidate[];
  reconciliation: RealReconciliationResult;
}) {
  const top = candidates.slice(0, 6);
  if (top.length === 0) return null;
  const totalAmount = top.reduce((sum, c) => sum + c.movement.importe, 0);
  const highConfidenceKeys = useMemo(
    () => reviewCandidateKeysAboveThreshold(reconciliation, 0.85),
    [reconciliation],
  );
  const handleBulkConfirm = () => {
    if (highConfidenceKeys.length === 0) return;
    confirmReviewKeys(highConfidenceKeys);
  };
  return (
    <div className="bg-white border border-[var(--warning,_#f59e0b)]/30 rounded-xl overflow-hidden">
      <div className="px-4 py-3 bg-[var(--warning-muted,_#fef3c7)] border-b border-[var(--warning,_#f59e0b)]/20 flex flex-wrap items-center gap-2">
        <HelpCircle className="w-4 h-4 text-[var(--warning,_#b45309)]" />
        <div>
          <div className="text-[13px] font-semibold text-[var(--gray-950)]">Cruces por revisar</div>
          <div className="text-[11px] text-[var(--gray-500)]">
            {candidates.length} abono{candidates.length !== 1 ? 's' : ''} candidato{candidates.length !== 1 ? 's' : ''}; no cuentan como banco cruzado hasta confirmarse.
          </div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {highConfidenceKeys.length > 0 && (
            <button
              type="button"
              onClick={handleBulkConfirm}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--primary,_#1d4ed8)] text-white text-[11px] font-semibold hover:opacity-90 transition-opacity"
              title="Confirma los cruces con confianza ≥ 85% y los suma al cruce real."
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              Confirmar {highConfidenceKeys.length} cruce{highConfidenceKeys.length === 1 ? '' : 's'} ≥ 85%
            </button>
          )}
          <div className="text-[12px] font-semibold tabular-nums text-[var(--gray-950)]">{fmtCurrency(totalAmount)}</div>
        </div>
      </div>
      <div className="divide-y divide-[var(--gray-100)]">
        {top.map(candidate => {
          const best = candidate.candidateFacturas[0];
          return (
            <div key={candidate.movement.movementKey} className="px-4 py-3 grid grid-cols-1 lg:grid-cols-[1.1fr_1fr_auto] gap-3 text-[12px]">
              <div>
                <div className="font-medium text-[var(--gray-950)] tabular-nums">
                  {candidate.movement.fechaOperacion} · {fmtCurrency(candidate.movement.importe)}
                </div>
                <div className="text-[11px] text-[var(--gray-500)] truncate" title={candidate.movement.concepto}>
                  {candidate.movement.cia} · {candidate.movement.cuenta} · {candidate.movement.concepto || 'Sin concepto'}
                </div>
                <code className="text-[10px] text-[var(--gray-400)]">{candidate.movement.referencia || 'Sin referencia'}</code>
              </div>
              <div>
                <div className="font-medium text-[var(--gray-950)] truncate" title={best?.nombreCliente}>
                  {best ? `${best.nombreCliente} · Fact. ${best.noFactura}` : 'Sin candidato'}
                </div>
                <div className="text-[11px] text-[var(--gray-500)]">
                  {candidate.matchReason}
                </div>
              </div>
              <div className="text-right tabular-nums">
                <span className="inline-flex px-2 py-0.5 rounded-md bg-[var(--gray-100)] text-[var(--gray-600)] text-[11px]">
                  {best ? `${Math.round(best.confidence * 100)}%` : '—'}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {candidates.length > top.length && (
        <div className="px-4 py-2 text-[11px] text-[var(--gray-400)] bg-[var(--surface-alt)]">
          Mostrando {top.length} de {candidates.length}; exporta CSV para revisar el resto.
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// CobranzaRealView — Fase 1
//
// Vista mínima funcional que confirma que el endpoint /cobranza está
// respondiendo y que el shape se mapea bien. Por ahora solo:
//   - KPIs agregados (saldo total, total facturas, % vencido).
//   - Filtro por compañía y por estatus.
//   - Tabla con la fila completa de CobranzaRecord.
//
// Lo intencionalmente NO está aquí (queda para Fase 2/3):
//   - Cruce contra movimientos bancarios (ABONO).
//   - Aging buckets visuales.
//   - Drill-down por cliente / factura.
//   - Export a CSV con info de banco.
//
// El UI rico vendrá una vez el motor `realReconciliationEngine.ts`
// produzca los matches; mientras, esta tabla deja al equipo validar que
// los datos de JDE son los esperados.
// ─────────────────────────────────────────────────────────────────────────
function CobranzaRealView({
  clients,
  assumptions,
  records,
  loadedCias,
  companies,
  bankStatements,
  reconciliation: externalReconciliation,
  facturaIndex: externalFacturaIndex,
  error,
  onRefresh,
  refreshing,
  defaultCia,
  onEnsureBankCoverage,
  bankCoverageLoading,
}: {
  clients: Client[];
  assumptions: CashFlowAssumptions;
  records: CobranzaRecord[];
  loadedCias: Record<string, string>;
  companies: { cia: string; nombre: string }[];
  bankStatements: BankAccountStatement[];
  reconciliation?: RealReconciliationResult;
  facturaIndex?: Map<string, RealReconciliationMatch>;
  error?: string | null;
  onRefresh?: () => void;
  refreshing?: boolean;
  defaultCia?: string;
  onEnsureBankCoverage?: (request: EnsureBankCoverageRequest) => void | Promise<void>;
  bankCoverageLoading?: boolean;
}) {
  // Default del filtro local: si el global selectedCia es una cía válida
  // (no 'all'), arrancamos filtrados por esa cía. Si después el usuario
  // cambia el global, sincronizamos también.
  const [ciaFilter, setCiaFilter] = useState<string>(
    defaultCia && defaultCia !== 'all' ? defaultCia : 'all',
  );
  useEffect(() => {
    if (defaultCia && defaultCia !== 'all') setCiaFilter(defaultCia);
    else if (defaultCia === 'all') setCiaFilter('all');
  }, [defaultCia]);
  const [estatusFilter, setEstatusFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [crossFilter, setCrossFilter] = useState<'all' | 'matched' | 'review' | 'pending'>('all');

  // ── Motor de cruce (Fase 2/3) ──────────────────────────────────────────
  // Default: usar el resultado pre-computado de App.tsx. Si por alguna razón
  // no llegó (renders aislados, tests, embed externo) caemos a un cómputo
  // local — la pestaña debe seguir funcionando aunque el padre no haya
  // cableado la prop.
  const confirmedReviewKeys = useConfirmedReviewKeys();
  const localReconciliation = useMemo(() => {
    // `externalReconciliation` ya viene con confirmaciones aplicadas desde
    // App.tsx; el fallback local debe aplicarlas también para no divergir.
    if (externalReconciliation) return externalReconciliation;
    const raw = reconcileRealCollections(records, bankStatements);
    return applyManualConfirmations(raw, confirmedReviewKeys);
  }, [externalReconciliation, records, bankStatements, confirmedReviewKeys]);
  const reconciliation = localReconciliation;
  const matchByFactura = useMemo(() => {
    if (externalFacturaIndex) return externalFacturaIndex;
    const m = new Map<string, RealReconciliationMatch>();
    for (const x of reconciliation.matches) {
      m.set(`${x.cia}::${x.noFactura}`, x);
    }
    return m;
  }, [externalFacturaIndex, reconciliation.matches]);
  const collectionCalendar = useMemo(
    () => buildCollectionCalendar({
      clients,
      assumptions,
      cobranzaRecords: records,
      reconciliation,
    }),
    [clients, assumptions, records, reconciliation],
  );
  const calendarEventByFactura = useMemo(() => {
    const priority: Record<CollectionCalendarEventSource, number> = {
      BANK_MATCHED: 0,
      BANK_UNMATCHED: 1,
      JDE_PAID_UNMATCHED: 2,
      CXC_RULED_PENDING: 3,
      CXC_UNRULED_PENDING: 4,
      PROJECTED_CLIENT_RULE: 5,
    };
    const map = new Map<string, CollectionCalendarEvent>();
    for (const event of collectionCalendar.events) {
      for (const factura of event.facturas) {
        const key = `${factura.cia}::${factura.noFactura}`;
        const previous = map.get(key);
        if (!previous || priority[event.source] < priority[previous.source]) {
          map.set(key, event);
        }
      }
    }
    return map;
  }, [collectionCalendar.events]);

  const ciaName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of companies) m.set(c.cia, c.nombre);
    return m;
  }, [companies]);

  const allCias = useMemo(() => {
    const set = new Set<string>();
    for (const r of records) if (r.cia) set.add(r.cia);
    return Array.from(set).sort();
  }, [records]);

  const allEstatus = useMemo(() => {
    const set = new Set<string>();
    for (const r of records) if (r.estatus) set.add(r.estatus);
    return Array.from(set).sort();
  }, [records]);

  const filtered = useMemo(() => {
    return records.filter(r => {
      if (ciaFilter !== 'all' && r.cia !== ciaFilter) return false;
      if (estatusFilter !== 'all' && r.estatus !== estatusFilter) return false;
      if (crossFilter !== 'all') {
        const m = matchByFactura.get(`${r.cia}::${r.noFactura}`);
        const matched = m?.status === 'cobrada-banco';
        const review = m?.reviewStatus === 'review';
        if (crossFilter === 'matched' && !matched) return false;
        if (crossFilter === 'review' && !review) return false;
        if (crossFilter === 'pending' && (matched || review)) return false;
      }
      if (query) {
        const q = query.toLowerCase();
        if (
          !r.nombreCliente.toLowerCase().includes(q) &&
          !r.noFactura.toLowerCase().includes(q) &&
          !r.noCliente.toLowerCase().includes(q)
        ) return false;
      }
      return true;
    });
  }, [records, ciaFilter, estatusFilter, crossFilter, query, matchByFactura]);

  // ── KPIs ──
  const totalSaldo = filtered.reduce((s, r) => s + (r.importePendientePesos || 0), 0);
  const totalBruto = filtered.reduce((s, r) => s + (r.importeBrutoPesos || 0), 0);
  const vencidoSaldo = filtered
    .filter(r => r.diasVencida > 0)
    .reduce((s, r) => s + (r.importePendientePesos || 0), 0);
  const pctVencido = totalSaldo > 0 ? (vencidoSaldo / totalSaldo) * 100 : 0;

  // Cuándo se actualizó la cia más reciente (si hay alguna)
  const lastUpdate = useMemo(() => {
    const ts = Object.values(loadedCias)
      .map(s => new Date(s).getTime())
      .filter(n => Number.isFinite(n));
    if (ts.length === 0) return null;
    return new Date(Math.max(...ts));
  }, [loadedCias]);

  if (records.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center bg-white border border-[var(--gray-200)]/60 rounded-xl">
        <div className="w-14 h-14 rounded-2xl bg-[var(--primary-muted)] flex items-center justify-center mb-3">
          <Database className="w-6 h-6 text-[var(--primary)]" />
        </div>
        <h3 className="text-base font-semibold text-[var(--gray-950)]">Sin cobranza JDE cargada</h3>
        {error ? (
          <p className="text-[13px] text-[var(--danger)] mt-1 max-w-md">
            {error}
          </p>
        ) : (
          <p className="text-[13px] text-[var(--gray-400)] mt-1 max-w-md">
            La carga arranca al boot del app y va compañía por compañía.
            Si no aparece nada después de un par de minutos, presiona Reintentar
            y abre la consola (DevTools → Console) para ver los logs con prefijo
            <code className="font-mono mx-1">[cobranza]</code>.
          </p>
        )}
        {onRefresh && (
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-[var(--primary)] bg-[var(--primary)] text-white text-[13px] font-medium hover:bg-[var(--primary)]/90 disabled:opacity-50"
          >
            {refreshing ? 'Reintentando…' : 'Reintentar carga'}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl p-5 flex items-end gap-8 flex-wrap">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Saldo CXC pendiente</div>
          <AnimatedNumber
            value={totalSaldo}
            format={fmtCurrency}
            className="block text-2xl font-semibold tabular-nums text-[var(--gray-950)] mt-0.5"
          />
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Importe bruto facturado</div>
          <AnimatedNumber
            value={totalBruto}
            format={fmtCurrency}
            className="block text-xl font-medium tabular-nums text-[var(--gray-950)] mt-0.5"
          />
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Vencido (% del saldo)</div>
          <div className="text-xl font-medium tabular-nums text-[var(--gray-950)] mt-0.5">
            <span className={pctVencido > 30 ? 'text-[var(--danger)]' : pctVencido > 10 ? 'text-[var(--warning)]' : 'text-[var(--success)]'}>
              {pctVencido.toFixed(1)}%
            </span>
            <span className="text-[12px] text-[var(--gray-400)] ml-2">
              {fmtCurrency(vencidoSaldo)}
            </span>
          </div>
        </div>
        {/* KPI principal de Fase 2: % cruzado con bancos.
            - Verde >= 95%: cobranza altamente reconciliada.
            - Ámbar 70-95%: hueco probable, revisar abonos sin factura.
            - Rojo  < 70%:  algo está mal (token, fechas, mapeo). */}
        {bankStatements.length > 0 && (() => {
          const pctCruzado = reconciliation.summary.pctAbonosCruzados * 100;
          const pctColor = pctCruzado >= 95
            ? 'text-[var(--success)]'
            : pctCruzado >= 70
              ? 'text-[var(--warning)]'
              : 'text-[var(--danger)]';
          return (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Cobranza cruzada con banco</div>
              <div className="text-xl font-medium tabular-nums mt-0.5">
                <span className={pctColor}>{pctCruzado.toFixed(1)}%</span>
                <span className="text-[12px] text-[var(--gray-400)] ml-2">
                  {reconciliation.summary.abonosFacturaCobrada} / {reconciliation.summary.totalAbonos} abonos
                </span>
                {reconciliation.reviewCandidates.length > 0 && (
                  <span className="text-[12px] text-[var(--warning,_#b45309)] ml-2">
                    {reconciliation.reviewCandidates.length} por revisar
                  </span>
                )}
              </div>
            </div>
          );
        })()}
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Facturas</div>
          <div className="text-xl font-medium tabular-nums text-[var(--gray-950)] mt-0.5">
            {filtered.length.toLocaleString('es-MX')}
            {filtered.length !== records.length && (
              <span className="text-[var(--gray-400)] text-[13px]"> / {records.length.toLocaleString('es-MX')}</span>
            )}
          </div>
        </div>
        {lastUpdate && (
          <div className="ml-auto text-[11px] text-[var(--gray-400)]">
            Actualizado: {lastUpdate.toLocaleString('es-MX')}
          </div>
        )}
      </div>

      <ReviewCandidatesPanel candidates={reconciliation.reviewCandidates} reconciliation={reconciliation} />

      {/* Filtros */}
      <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl p-4 flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search className="w-4 h-4 text-[var(--gray-400)] absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Cliente, factura, número…"
            className="input pl-9 w-full"
          />
        </div>

        <select
          value={ciaFilter}
          onChange={e => setCiaFilter(e.target.value)}
          className="input text-[12px] h-8"
        >
          <option value="all">Todas las compañías</option>
          {allCias.map(cia => (
            <option key={cia} value={cia}>
              {cia} · {ciaName.get(cia) ?? '—'}
            </option>
          ))}
        </select>

        <select
          value={estatusFilter}
          onChange={e => setEstatusFilter(e.target.value)}
          className="input text-[12px] h-8"
        >
          <option value="all">Todos los estatus</option>
          {allEstatus.map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        {bankStatements.length > 0 && (
          <select
            value={crossFilter}
            onChange={e => setCrossFilter(e.target.value as 'all' | 'matched' | 'review' | 'pending')}
            className="input text-[12px] h-8"
          >
            <option value="all">Todas (cruce)</option>
            <option value="matched">Solo cruzadas con banco</option>
            <option value="review">Solo por revisar</option>
            <option value="pending">Solo sin datos / sin cruce</option>
          </select>
        )}

        {(query || ciaFilter !== 'all' || estatusFilter !== 'all' || crossFilter !== 'all') && (
          <button
            onClick={() => { setQuery(''); setCiaFilter('all'); setEstatusFilter('all'); setCrossFilter('all'); }}
            className="text-[12px] text-[var(--primary)] hover:underline px-2"
          >
            Limpiar
          </button>
        )}

        {/* Export del cruce — incluye TODAS las columnas de la factura más
            las del banco cuando hay match. Ideal para mandar a contabilidad
            o reconciliar manualmente lo que el motor no cruzó. Respeta los
            filtros actuales: solo se exporta lo que se ve. */}
        <button
          onClick={() => {
            const rows = filtered.map(r => {
              const m = matchByFactura.get(`${r.cia}::${r.noFactura}`);
              const calendarEvent = calendarEventByFactura.get(`${r.cia}::${r.noFactura}`);
              return {
                Cia: r.cia,
                Cliente: r.nombreCliente,
                NoCliente: r.noCliente,
                Factura: r.noFactura,
                FechaFactura: (r.fechaFactura || '').slice(0, 10),
                FechaVence: (r.fechaVence || '').slice(0, 10),
                FechaCobroJDE: (r.fechaCobro || '').slice(0, 10),
                DiasVencida: r.diasVencida,
                BrutoMXN: r.importeBrutoPesos,
                PendienteMXN: r.importePendientePesos,
                Moneda: r.moneda,
                EstatusJDE: r.estatus,
                FuenteDato: calendarEvent ? COLLECTION_CALENDAR_SOURCE_LABELS[calendarEvent.source] : '',
                FechaCalendario: calendarEvent?.date ?? '',
                EstadoCalendario: calendarEvent?.statusLabel ?? '',
                ReglaAplicada: calendarEvent?.ruleApplied ?? '',
                MotivoFecha: calendarEvent?.dateReason ?? '',
                EstatusCruce: m?.status ?? 'pendiente',
                RevisionCruce: m?.reviewStatus ?? 'unmatched',
                MotivoCruce: m?.matchReason ?? '',
                BancoMatch: m?.matchTier ?? '',
                ConfianzaCruce: (m?.confidence ?? calendarEvent?.confidence)
                  ? `${((m?.confidence ?? calendarEvent?.confidence ?? 0) * 100).toFixed(0)}%`
                  : '',
                FechaBanco: m?.bankDate ?? '',
                RefBanco: m?.bankRef ?? '',
                MontoBanco: m?.bankAmount ?? '',
                CuentaBanco: m?.bankAccount ?? '',
                ConceptoBanco: m?.bankConcept ?? '',
                MovimientosBanco: m?.bankMovements?.length ?? '',
                SubsetID: m?.subsetGroupId ?? '',
              };
            });
            const stamp = new Date().toISOString().slice(0, 10);
            downloadFile(toCSV(rows), `cobranza-cruce-${stamp}.csv`);
          }}
          className="ml-auto inline-flex items-center gap-1.5 px-3 h-8 rounded-lg border border-[var(--gray-200)] text-[12px] text-[var(--gray-500)] hover:text-[var(--gray-950)] hover:bg-[var(--gray-50)]"
          disabled={filtered.length === 0}
          title="Exporta lo visible con todas las columnas de cruce."
        >
          <Download className="w-3.5 h-3.5" />
          Exportar CSV ({filtered.length.toLocaleString('es-MX')})
        </button>
      </div>

      {/* Calendario real — ABONOs bancarios cruzados con cobranza JDE.
          Esta es la vista principal: ver de un vistazo qué entró cada día,
          en qué cuenta, y si cruzó con alguna factura JDE. Reemplaza la
          calendar view de la versión proyectada cuando estamos en modo
          Real. */}
      <CobranzaRealCalendar
        calendar={collectionCalendar}
        ciaFilter={ciaFilter}
        bankCoverage={reconciliation.bankCoverage}
        onEnsureBankCoverage={onEnsureBankCoverage}
        bankCoverageLoading={bankCoverageLoading}
      />

      {/* Aging por cliente — Top 20 con mayor saldo abierto */}
      <ClientAgingTable
        records={filtered}
        matchByFactura={matchByFactura}
        bankActive={bankStatements.length > 0}
      />

      {/* Tabla raw */}
      <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--gray-200)]/60 bg-[var(--surface-alt)] flex items-center gap-2">
          <FileSpreadsheet className="w-4 h-4 text-[var(--gray-400)]" />
          <span className="text-[13px] font-semibold text-[var(--gray-950)]">Facturas (CXC)</span>
          <span className="text-[11px] text-[var(--gray-400)] ml-auto">
            {bankStatements.length > 0
              ? `Cruce activo · ${reconciliation.summary.facturasCobradasBanco} cobradas con banco`
              : 'Sube/carga estados de cuenta para activar el cruce.'}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="bg-[var(--surface-alt)] text-[var(--gray-500)] text-[11px] uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2">Cía</th>
                <th className="text-left px-3 py-2">Cliente</th>
                <th className="text-left px-3 py-2">Factura</th>
                <th className="text-left px-3 py-2">F. emisión</th>
                <th className="text-left px-3 py-2">F. vencimiento</th>
                <th className="text-right px-3 py-2">Días venc.</th>
                <th className="text-right px-3 py-2">Bruto MXN</th>
                <th className="text-right px-3 py-2">Pendiente MXN</th>
                <th className="text-left px-3 py-2">Moneda</th>
                <th className="text-left px-3 py-2">Estatus</th>
                {bankStatements.length > 0 && (
                  <th className="text-left px-3 py-2">Banco</th>
                )}
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 500).map((r, idx) => {
                const m = matchByFactura.get(`${r.cia}::${r.noFactura}`);
                return (
                  <tr
                    key={`${r.cia}-${r.noFactura}-${idx}`}
                    className="border-t border-[var(--gray-100)] hover:bg-[var(--gray-50)]/50"
                  >
                    <td className="px-3 py-2 tabular-nums text-[var(--gray-500)]">{r.cia}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-[var(--gray-950)]">{r.nombreCliente || '—'}</div>
                      {r.noCliente && (
                        <div className="text-[10px] text-[var(--gray-400)] tabular-nums">#{r.noCliente}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{r.noFactura || '—'}</td>
                    <td className="px-3 py-2 tabular-nums text-[var(--gray-500)]">
                      {r.fechaFactura ? r.fechaFactura.slice(0, 10) : '—'}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-[var(--gray-500)]">
                      {r.fechaVence ? r.fechaVence.slice(0, 10) : '—'}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${r.diasVencida > 0 ? 'text-[var(--danger)] font-medium' : 'text-[var(--gray-400)]'}`}>
                      {r.diasVencida}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtCurrency(r.importeBrutoPesos)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">
                      {fmtCurrency(r.importePendientePesos)}
                    </td>
                    <td className="px-3 py-2 text-[var(--gray-500)]">{r.moneda || '—'}</td>
                    <td className="px-3 py-2 text-[var(--gray-500)]">{r.estatus || '—'}</td>
                    {bankStatements.length > 0 && (
                      <td className="px-3 py-2">
                        <BankBadge match={m} />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length > 500 && (
            <div className="px-4 py-2 text-[11px] text-[var(--gray-400)] border-t border-[var(--gray-100)] bg-[var(--surface-alt)]">
              Mostrando 500 de {filtered.length.toLocaleString('es-MX')} — usa los filtros para acotar.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
