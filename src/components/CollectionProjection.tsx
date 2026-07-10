import { useEffect, useMemo, useState } from 'react';
import { Client, CashFlowAssumptions, Frequency, CollectionEvent, ConfirmedPayment, eventKey } from '../domain/types';
import { projectYear } from '../domain/collectionEngine';
import { isBankHoliday } from '../domain/bankHolidays';
import { isInternalTransfer, buildOwnAccountsIndex, buildOwnAccountDetector } from '../domain/netCashFlowEngine';
import { reconcileCollections, buildReconciliationMap, type ReconciliationMatch, type ReconciliationSummary } from '../domain/reconciliationEngine';
import {
  type RealReconciliationMatch,
  type RealReconciliationResult,
  type RealReconciliationBankCoverage,
} from '../domain/realReconciliationEngine';
import { emptyRealReconciliationResult } from '../domain/emptyRealReconciliationResult';
import {
  applyManualConfirmations,
  useConfirmedReviewKeys,
} from '../domain/reconciliationConfirmations';
import {
  buildCollectionCalendar,
  COLLECTION_CALENDAR_SOURCE_LABELS,
  type BuildCollectionCalendarResult,
  type CollectionCalendarEvent,
  type CollectionCalendarEventSource,
} from '../domain/collectionCalendarEngine';
import { buildRolProjectedInflows } from '../domain/rolProjectionEngine';
import { segmentOf, listSegments, buildSegmentBreakdown, SEGMENT_UNCLASSIFIED } from '../domain/cobranzaSegment';
import {
  buildCobranzaBankCuadre,
  type CuadreStatus,
} from '../domain/cobranzaBankCuadre';
import { COMPENSATION_SCHEME_LABEL } from '../config/compensationClientsCatalog';
import { CXPRecord } from '../domain/persistence';
import type { BankAccountStatement, CobranzaPayment, CobranzaRecord } from '../services/jde';
import type { RolRecord } from '../services/jdeTypes';
import RolCobranzaPanel from './RolCobranzaPanel';
import { MONTHS } from '../types';
import { Search, Settings2, ChevronDown, ChevronLeft, ChevronRight, Check, Download, Landmark, ArrowRightLeft, CheckCircle2, AlertTriangle, HelpCircle, Handshake, Banknote, CalendarRange, Inbox, SlidersHorizontal, Database, Loader2 } from 'lucide-react';
import { useDataWindow } from '../contexts/DataWindowContext';
import { toCSV, downloadFile, csvDate } from '../utils/export';
import { hex } from '../theme';
import { fmtCurrency, fmtCompact, todayISO } from '../formatters';
import AnimatedNumber from './ui/AnimatedNumber';
import PageHeader from './ui/PageHeader';
import CompanyMultiSelect from './ui/CompanyMultiSelect';

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
   * CXC real proveniente de POST /JDEdwards/cobranza. Cada registro es
   * una factura abierta o reciente (últimos 12 meses). Cuando llega vacío,
   * la pestaña sigue funcionando en modo Proyectada y la sección "Real (JDE)"
   * muestra empty state.
   */
  cobranzaRecords?: CobranzaRecord[];
  /** Pagos/recibos de CobranzaIndicadores, agrupados por Id Pago. */
  cobranzaPayments?: CobranzaPayment[];
  /**
   * Viajes ejecutados del ROL diario CITI. Alimentan el panel de cruce
   * ROL ↔ Cobranza (facturado / predicho / huérfano).
   */
  rolRecords?: RolRecord[];
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
  /**
   * Facturas confirmadas como cobradas en el Auxiliar Contable
   * (`${cia}::${noFactura}`). Corroboración GL opcional para el panel de cuadre
   * cobranza-aplicada↔banco; best-effort (vacío si el auxiliar no está cargado).
   */
  glConfirmedInvoiceKeys?: ReadonlySet<string>;
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

export default function CollectionProjection({ clients, assumptions, onAssumptionsChange, confirmedPayments, onConfirm, onUnconfirm, cxpRecords = [], bankStatements = [], companies = [], cobranzaRecords = [], cobranzaPayments = [], rolRecords = [], cobranzaLoadedCias = {}, cobranzaReconciliation, cobranzaFacturaIndex, cobranzaError, onRefreshCobranza, cobranzaRefreshing, selectedCia, onEnsureBankCoverage, bankCoverageLoading, glConfirmedInvoiceKeys }: Props) {
  const [query, setQuery] = useState('');
  const [freqFilter, setFreqFilter] = useState<Set<Frequency>>(new Set());
  const [factorajeFilter, setFactorajeFilter] = useState<FactorajeFilter>('all');
  const [view, setView] = useState<ViewMode>('calendar');
  const [showSettings, setShowSettings] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [activeMonth, setActiveMonth] = useState(() => defaultActiveMonth(assumptions.year));
  // Unified: show real view when JDE data or companies are available,
  // fall back to projected-only when there's no JDE connection at all.
  const hasJdeConnection = companies.length > 0 || cobranzaRecords.length > 0;
  const sourceMode: SourceMode = hasJdeConnection ? 'real' : 'projected';

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
        <div className="w-16 h-16 rounded-[var(--radius-lg)] bg-[var(--primary-muted)] flex items-center justify-center mb-4 animate-scale-in">
          <Inbox className="w-7 h-7 text-[var(--primary)]" />
        </div>
        <h2 className="text-xl font-bold text-[var(--gray-950)]">Sin clientes cargados</h2>
        <p className="text-[13px] text-[var(--gray-400)] mt-1 max-w-sm">
          Importa el catálogo en la pestaña Clientes para ver la proyección.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5 animate-page-in">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <PageHeader title="Calendario de cobranza" />
        {/* Source mode indicator — no toggle needed; real view is
            always shown when JDE companies are available. */}
      </div>

      {/* ── Vista Real (JDE) — Fase 1: tabla raw ──────────
          Esta vista muestra los registros tal como llegan del API para
          validar el shape antes de construir el dashboard rico. Cuando el
          motor de cruce contra bancos esté listo (Fase 2), aquí va el KPI
          de % cruzado y el aging por cliente. */}
      {sourceMode === 'real' ? (
        <>
          <CobranzaRealView
            clients={clients}
            assumptions={assumptions}
            records={cobranzaRecords}
            payments={cobranzaPayments}
            rolRecords={rolRecords}
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
            glConfirmedInvoiceKeys={glConfirmedInvoiceKeys}
          />
          <RolCobranzaPanel rolRecords={rolRecords} cobranzaRecords={cobranzaRecords} cobranzaPayments={cobranzaPayments} />
        </>
      ) : (
      <>

      {/* ── Summary strip ─────────────────────────────────── */}
      <div className="bg-white border border-[var(--gray-200)]/60 rounded-[var(--radius)] p-5 flex items-end gap-8 animate-card-in stagger-1 hover-lift">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Total proyectado {assumptions.year}</div>
          <AnimatedNumber
            value={total}
            format={fmtCurrency}
            className="block text-3xl font-bold tabular-nums text-[var(--gray-950)] mt-0.5"
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
            className="flex items-center gap-1.5 px-3 h-8 rounded-[var(--radius-md)] border border-[var(--gray-200)] text-[13px] text-[var(--gray-400)] hover:text-[var(--gray-950)] hover:bg-[var(--gray-50)]"
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
          <div className="bg-white border border-[var(--gray-200)] rounded-[var(--radius)] animate-card-in stagger-1">
            <div className="flex items-end gap-8 p-4">
              <div className="flex items-center gap-2">
                <Landmark className="w-4 h-4 text-[var(--primary)]" />
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Saldo real bancos</div>
                  <AnimatedNumber
                    value={totalBankSaldo}
                    format={fmtCurrency}
                    className="block text-xl font-bold tabular-nums text-[var(--primary)] mt-0.5"
                  />
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Cobros reales (abonos)</div>
                <AnimatedNumber
                  value={bankRealAbonos}
                  format={fmtCurrency}
                  className="block text-xl font-bold tabular-nums text-[var(--success)] mt-0.5"
                />
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Empresas</div>
                <div className="text-xl font-bold tabular-nums text-[var(--gray-950)] mt-0.5">
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
        <div className="bg-white border border-[var(--gray-200)]/60 rounded-[var(--radius)] p-4 flex gap-6 items-end animate-slide-down">
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
      <div className="bg-white border border-[var(--gray-200)]/60 rounded-[var(--radius)] overflow-hidden animate-card-in stagger-6">
        <button
          onClick={() => setShowMore(!showMore)}
          className="w-full flex items-center justify-between px-5 py-3 hover:bg-[var(--gray-50)]/50 transition-colors"
        >
          <div className="flex items-center gap-2.5">
            <SlidersHorizontal className="w-4 h-4 text-[var(--gray-400)]" />
            <span className="text-[13px] font-bold text-[var(--gray-950)]">Filtros y otras vistas</span>
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
  const todayISO = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();

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
        'Fecha Cobro': csvDate(e.realDate),
        'Fecha Factura': csvDate(e.invoiceDate),
        Monto: e.amount,
        'Días Lag': e.lagDays,
        'Regla Pago': c?.paymentDayRaw ?? '',
        Confirmado: confirmedSet.has(key) ? 'Sí' : 'No',
        'Estado Banco': recon?.status === 'matched' ? 'Cruzado' : recon?.status === 'likely' ? 'Probable' : 'Sin cruzar',
        'Monto Banco': recon?.actualAmount ?? '',
        'Fecha Banco': csvDate(recon?.actualDate ?? ''),
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
      <div className="bg-white border border-[var(--gray-200)] rounded-[var(--radius)] p-4 flex items-end gap-8 flex-wrap animate-card-in stagger-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Cobranza total</div>
          <AnimatedNumber
            value={monthTotal}
            format={fmtCurrency}
            className="block text-xl font-bold tabular-nums text-[var(--gray-950)] mt-0.5"
          />
          <div className="text-[11px] text-[var(--gray-400)]">{monthEvents} pagos · {uniqueClients} clientes con pagos</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--success)]">Cobrado (real)</div>
          <AnimatedNumber
            value={confirmedTotal}
            format={fmtCurrency}
            className="block text-xl font-bold tabular-nums text-[var(--success)] mt-0.5"
          />
          <div className="text-[11px] text-[var(--gray-400)]">{confirmedCount} confirmados</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--primary)]">Proyectado</div>
          <AnimatedNumber
            value={projectedTotal}
            format={fmtCurrency}
            className="block text-xl font-bold tabular-nums text-[var(--primary)] mt-0.5"
          />
          <div className="text-[11px] text-[var(--gray-400)]">{monthEvents - confirmedCount} pendientes</div>
        </div>
        <div className="ml-auto min-w-[200px]">
          <div className="flex items-baseline justify-between">
            <div className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">% Avance</div>
            <div className="text-xl font-bold tabular-nums text-[var(--gray-950)]">
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
        <div className="bg-white border border-[var(--primary)]/20 rounded-[var(--radius)] overflow-hidden animate-card-in stagger-4">
          <button
            onClick={() => setShowReconciliation(!showReconciliation)}
            className="w-full flex items-center justify-between px-5 py-3 hover:bg-[var(--gray-50)]/50 transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <ArrowRightLeft className="w-4 h-4 text-[var(--primary)]" />
              <span className="text-[13px] font-bold text-[var(--gray-950)]">Reconciliación Bancaria</span>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--primary-muted)] text-[var(--primary)] font-medium">
                {(reconSummary.matchRate * 100).toFixed(0)}% cruzado
              </span>
            </div>
            <ChevronDown className={`w-4 h-4 text-[var(--gray-400)] transition-transform ${showReconciliation ? 'rotate-180' : ''}`} />
          </button>
          {showReconciliation && (
            <div className="px-5 pb-4 pt-1 space-y-3">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="p-3 rounded-[var(--radius-md)] bg-[var(--success)]/5 border border-[var(--success)]/20">
                  <div className="flex items-center gap-1.5 mb-1">
                    <CheckCircle2 className="w-3.5 h-3.5 text-[var(--success)]" />
                    <span className="text-[11px] uppercase tracking-wide text-[var(--success)]">Cruzados</span>
                  </div>
                  <div className="text-lg font-bold tabular-nums text-[var(--success)]">{fmtCurrency(reconSummary.totalMatched)}</div>
                  <div className="text-[11px] text-[var(--gray-400)]">{reconSummary.matchedCount} pago{reconSummary.matchedCount !== 1 ? 's' : ''} confirmados en banco</div>
                </div>
                <div className="p-3 rounded-[var(--radius-md)] bg-[var(--info)]/5 border border-[var(--info)]/20">
                  <div className="flex items-center gap-1.5 mb-1">
                    <HelpCircle className="w-3.5 h-3.5 text-[var(--info)]" />
                    <span className="text-[11px] uppercase tracking-wide text-[var(--info)]">Probables</span>
                  </div>
                  <div className="text-lg font-bold tabular-nums text-[var(--info)]">{fmtCurrency(reconSummary.totalLikely)}</div>
                  <div className="text-[11px] text-[var(--gray-400)]">{reconSummary.likelyCount} pago{reconSummary.likelyCount !== 1 ? 's' : ''} con match parcial</div>
                </div>
                <div className="p-3 rounded-[var(--radius-md)] bg-[var(--warning)]/5 border border-[var(--warning)]/20">
                  <div className="flex items-center gap-1.5 mb-1">
                    <AlertTriangle className="w-3.5 h-3.5 text-[var(--warning)]" />
                    <span className="text-[11px] uppercase tracking-wide text-[var(--warning)]">Sin cruzar</span>
                  </div>
                  <div className="text-lg font-bold tabular-nums text-[var(--warning)]">{fmtCurrency(reconSummary.totalUnmatched)}</div>
                  <div className="text-[11px] text-[var(--gray-400)]">{reconSummary.unmatchedCount} pago{reconSummary.unmatchedCount !== 1 ? 's' : ''} sin movimiento bancario</div>
                </div>
                <div className="p-3 rounded-[var(--radius-md)] bg-[var(--gray-50)] border border-[var(--gray-200)]/60">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Banknote className="w-3.5 h-3.5 text-[var(--gray-400)]" />
                    <span className="text-[11px] uppercase tracking-wide text-[var(--gray-400)]">Abonos no asignados</span>
                  </div>
                  <div className="text-lg font-bold tabular-nums text-[var(--gray-700)]">
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
                      <div key={i} className="flex items-center gap-2 py-1.5 px-3 rounded-[var(--radius-md)] bg-[var(--gray-50)] text-[12px]">
                        <span className="text-[var(--gray-400)]">{a.fechaOperacion}</span>
                        <span className="text-[var(--gray-700)] truncate flex-1">{a.concepto}</span>
                        <span className="text-[var(--gray-400)]">{a.referencia}</span>
                        <span className="font-bold tabular-nums text-[var(--success)]">+{fmtCurrency(a.importe)}</span>
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
      <div key={`grid-${year}-${month}`} className="bg-white border border-[var(--gray-200)]/60 rounded-[var(--radius)] overflow-hidden animate-card-in stagger-5">
        <div className="flex items-center justify-between px-4 py-3 bg-[var(--gray-950)]">
          <button
            onClick={prevMonth}
            aria-label="Mes anterior"
            className="p-1.5 rounded-[var(--radius-md)] hover:bg-white/10 text-white/70 hover:text-white transition-colors"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <h2 key={`${year}-${month}`} className="text-lg font-bold text-white flex items-center gap-2 animate-slide-down">
            <CalendarRange className="w-4 h-4 text-white/60" />
            <span>{MONTH_NAMES[month]} {year}</span>
          </h2>
          <div className="flex items-center gap-1">
            <button
              onClick={handleExport}
              title="Exportar mes"
              aria-label="Exportar mes"
              className="p-1.5 rounded-[var(--radius-md)] hover:bg-white/10 text-white/70 hover:text-white transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={nextMonth}
              aria-label="Mes siguiente"
              className="p-1.5 rounded-[var(--radius-md)] hover:bg-white/10 text-white/70 hover:text-white transition-colors"
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
                    <span className="text-[9px] uppercase tracking-wide font-bold text-[var(--warning)] leading-none mt-0.5">Inhábil</span>
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
                    <div className="rounded-md px-1.5 py-0.5 text-[11px] font-bold tabular-nums" style={{ backgroundColor: pillBg, color: pillFg }}>
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
        <div className="bg-white border border-[var(--gray-200)]/60 rounded-[var(--radius)] p-4 animate-slide-down">
          <div className="flex justify-between items-center mb-3">
            <h3 className="font-bold text-[14px] text-[var(--gray-950)]">
              {new Date(selectedDay + 'T12:00:00').toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })}
            </h3>
            <span className="text-lg font-bold tabular-nums text-[var(--success)]">
              +{fmtCurrency(selectedTotal)}
            </span>
          </div>
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {[...selectedEvents].sort((a, b) => b.amount - a.amount).map((e, i) => {
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
                <div key={i} className={`flex items-center gap-2 py-2 px-3 rounded-[var(--radius-md)] ${rowBg} hover:brightness-95 transition-colors`}>
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
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--success)]/15 text-[var(--success)] font-bold uppercase tracking-wide flex-shrink-0">
                          Cruzado
                        </span>
                      )}
                      {isLikely && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--info)]/15 text-[var(--info)] font-bold uppercase tracking-wide flex-shrink-0">
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
                    <div className={`text-[13px] font-bold tabular-nums ${isConfirmed || isReconciled ? 'text-[var(--success)]' : 'text-[var(--gray-950)]'}`}>{fmtCurrency(e.amount)}</div>
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
        <div className="bg-white border border-[var(--gray-200)]/60 rounded-[var(--radius)] p-4 hover-lift animate-card-in">
          <h3 className="text-[13px] font-bold text-[var(--gray-950)] mb-3">Cobranza semanal</h3>
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
    <div className="bg-white border border-[var(--gray-200)]/60 rounded-[var(--radius)] p-5 hover-lift animate-card-in stagger-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[13px] font-bold text-[var(--gray-950)]">Entrada de efectivo por mes</h3>
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
        <AnimatedNumber value={total} format={fmtCurrency} className="font-bold tabular-nums" />
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
    <div className="bg-white border border-[var(--gray-200)]/60 rounded-[var(--radius)] overflow-hidden hover-lift animate-card-in stagger-5">
      <div className="px-5 py-3 border-b border-[var(--gray-200)]/40 flex items-center justify-between">
        <h3 className="text-[13px] font-bold text-[var(--gray-950)]">Ranking por cliente</h3>
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
              <tr key={c.id} className="cv-row border-t border-[var(--gray-200)]/40 hover-row animate-slide-up" style={{ animationDelay: delay }}>
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
    <div className="bg-white border border-[var(--gray-200)]/60 rounded-[var(--radius)] overflow-hidden hover-lift">
      <div className="px-4 py-3 border-b border-[var(--gray-200)]/40 flex items-center justify-between">
        <div>
          <h3 className="text-[13px] font-bold text-[var(--gray-950)]">Detalle de eventos</h3>
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
                <tr key={i} className="cv-row border-t border-[var(--gray-200)]/40 hover-row">
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
  BANK_FEDERAL: {
    color: '#800020',
    rgb: '128,0,32',
    textClass: 'text-[#800020]',
    borderClass: 'border-[#800020]/30',
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
  JDE_OPEN_PROJECTED: {
    color: '#7c3aed',
    rgb: '124,58,237',
    textClass: 'text-[#6d28d9]',
    borderClass: 'border-[#7c3aed]/30',
  },
  ROL_PROJECTED: {
    color: '#0891b2',
    rgb: '8,145,178',
    textClass: 'text-[#0e7490]',
    borderClass: 'border-[#0891b2]/30',
  },
};

function PaymentLagBadge({ lag, expected }: { lag: number; expected?: string }) {
  if (lag === 0) {
    return (
      <span
        title={expected ? `Esperado ${expected}` : undefined}
        className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--success)]/10 text-[var(--success)]"
      >
        Puntual
      </span>
    );
  }
  const late = lag > 0;
  const cls = late
    ? 'bg-[var(--danger)]/10 text-[var(--danger)]'
    : 'bg-[var(--primary)]/10 text-[var(--primary)]';
  const sign = late ? '+' : '−';
  const word = late ? 'tarde' : 'temprano';
  return (
    <span
      title={expected ? `Esperado ${expected}` : undefined}
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${cls}`}
    >
      {sign}{Math.abs(lag)}d {word}
    </span>
  );
}

function CollectionSourceBadge({ source }: { source: CollectionCalendarEventSource }) {
  const style = COLLECTION_CALENDAR_SOURCE_STYLES[source];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border bg-white text-[11px] font-medium ${style.textClass} ${style.borderClass}`}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: style.color }} />
      {COLLECTION_CALENDAR_SOURCE_LABELS[source]}
    </span>
  );
}

function collectionEventMatchesCia(event: CollectionCalendarEvent, ciaFilter: Set<string>): boolean {
  // Set vacío = "Todas las compañías".
  if (ciaFilter.size === 0) return true;
  // La proyección ROL no siempre trae cia JDE; se mantiene visible para que
  // el calendario futuro no desaparezca al filtrar una o varias compañías.
  if (event.source === 'ROL_PROJECTED' && !event.cia) return true;
  return event.cia ? ciaFilter.has(event.cia) : false;
}


// ─────────────────────────────────────────────────────────────────────────
// CobranzaRealCalendar — calendario unico de banco + JDE + CXC + proyeccion.
//
// El input ya viene normalizado por `collectionCalendarEngine`; esta vista
// solo filtra, pinta barras por fuente y expone el drill-down operativo.
// ─────────────────────────────────────────────────────────────────────────
// Datasets que el calendario de Cobranza necesita para pintar un año previo.
const COBRANZA_CALENDAR_DATASETS = ['cobranza', 'rol', 'banks'];
function CobranzaRealCalendar({
  calendar,
  ciaFilter,
  bankCoverage,
  onEnsureBankCoverage,
  bankCoverageLoading,
}: {
  calendar: BuildCollectionCalendarResult;
  ciaFilter: Set<string>;
  bankCoverage?: RealReconciliationBankCoverage;
  onEnsureBankCoverage?: (request: EnsureBankCoverageRequest) => void | Promise<void>;
  bankCoverageLoading?: boolean;
}) {
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [month, setMonth] = useState(() => new Date().getMonth());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  // Carga diferida: al navegar a un año previo al piso por defecto, pide la
  // cobranza/ROL/bancos de ese año bajo demanda (ver DataWindowContext).
  const { ensureYearLoaded, isLoadingHistorical } = useDataWindow();
  useEffect(() => {
    ensureYearLoaded(year, COBRANZA_CALENDAR_DATASETS);
  }, [year, ensureYearLoaded]);
  const loadingHistorical = isLoadingHistorical(COBRANZA_CALENDAR_DATASETS);

  const monthEvents = useMemo(() => {
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
    return calendar.events.filter(event => {
      if (!event.date.startsWith(prefix)) return false;
      if (!collectionEventMatchesCia(event, ciaFilter)) return false;
      // BANK_UNMATCHED (abono real en banco sin factura JDE cruzada) SÍ entra
      // al calendario, pero como cubeta propia "Sin factura" — NO se suma al
      // ingreso cruzado ("Ing.") ni al Δ, para no contaminar el significado
      // del cruce ni de la comparación contra proyección. Es dinero que de
      // verdad entró: antes se descartaba aquí y por eso el calendario
      // reportaba menos ingreso que la realidad bancaria.
      return true;
    });
  }, [calendar.events, year, month, ciaFilter]);

  const byDay = useMemo(() => {
    const map = new Map<string, CollectionCalendarEvent[]>();
    for (const event of monthEvents) {
      const list = map.get(event.date) ?? [];
      list.push(event);
      map.set(event.date, list);
    }
    return map;
  }, [monthEvents]);

  const firstDay = new Date(Date.UTC(year, month, 1));
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  const startPad = (firstDay.getUTCDay() + 6) % 7;
  const days: Date[] = [];
  for (let i = -startPad; i < lastDay.getUTCDate() + (7 - ((lastDay.getUTCDay() + 6) % 7 + 1) % 7); i++) {
    days.push(new Date(Date.UTC(year, month, i + 1)));
  }
  while (days.length % 7 !== 0) days.push(new Date(Date.UTC(year, month, days.length - startPad + 1)));

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

  // Totales semanales (lunes-domingo). Replica el bloque "Cobranza
  // semanal" del calendario legacy. Si el mes no tiene eventos
  // visibles la sección no se renderiza.
  const weeklyTotals = useMemo(() => {
    const weeks: Record<string, { real: number; projected: number; unmatched: number }> = {};
    for (const [date, evts] of byDay.entries()) {
      const d = new Date(date + 'T12:00:00');
      const weekStart = new Date(d);
      weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
      const key = weekStart.toISOString().slice(0, 10);
      const slot = weeks[key] ?? { real: 0, projected: 0, unmatched: 0 };
      for (const e of evts) {
        // Federal suma al ingreso real de la semana (venta directa a banco).
        if (
          e.source === 'BANK_MATCHED'
          || e.source === 'BANK_FEDERAL'
          || e.source === 'JDE_PAID_UNMATCHED'
        ) {
          slot.real += e.amount;
        } else if (
          e.source === 'JDE_OPEN_PROJECTED'
          || e.source === 'ROL_PROJECTED'
        ) {
          slot.projected += e.amount;
        } else if (e.source === 'BANK_UNMATCHED') {
          // Ingreso real en banco sin factura — se reporta aparte, no se
          // mezcla con el ingreso cruzado.
          slot.unmatched += e.amount;
        }
      }
      weeks[key] = slot;
    }
    return weeks;
  }, [byDay]);

  const todayISO = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();

  return (
    <div className="space-y-4">
      {/* ── Calendario (header oscuro + chips + grid + detalle) ──
          Una sola card con la cabecera navy del legacy, la fila de
          chips de fuente con estilo legacy (primary cuando activo),
          el grid de celdas verticales y el panel de detalle. */}
      <div key={`real-grid-${year}-${month}`} className="bg-white border border-[var(--gray-200)]/60 rounded-[var(--radius)] overflow-hidden animate-card-in stagger-5">
        <div className="flex items-center justify-between px-4 py-3 bg-[var(--gray-950)]">
          <button
            onClick={prevMonth}
            aria-label="Mes anterior"
            className="p-1.5 rounded-[var(--radius-md)] hover:bg-white/10 text-white/70 hover:text-white transition-colors"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <h2 key={`${year}-${month}`} className="text-lg font-bold text-white flex items-center gap-2 capitalize animate-slide-down">
            <CalendarRange className="w-4 h-4 text-white/60" />
            <span>{monthLabel}</span>
            {loadingHistorical && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-white/70" role="status" aria-live="polite">
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
                Cargando {year}…
              </span>
            )}
          </h2>
          <button
            onClick={nextMonth}
            aria-label="Mes siguiente"
            className="p-1.5 rounded-[var(--radius-md)] hover:bg-white/10 text-white/70 hover:text-white transition-colors"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>

        {/* Leyenda — explica los colores que aparecen en cada día. */}
        <div className="px-4 py-2.5 border-b border-[var(--gray-200)]/60 bg-white flex items-center gap-4 text-[11px] text-[var(--gray-500)] flex-wrap">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-[#2563eb]" />
            <span><strong className="text-[var(--gray-950)]">Ingreso</strong> · cruzado con banco</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-[#800020]" />
            <span><strong className="text-[var(--gray-950)]">Federal</strong> · venta directa a banco</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-[#f59e0b]" />
            <span><strong className="text-[var(--gray-950)]">Sin factura</strong> · banco real por identificar</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-[#7c3aed]" />
            <span><strong className="text-[var(--gray-950)]">Proyección</strong> · ROL ejecutado por facturar</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm border border-[var(--gray-300)] bg-white" />
            <span><strong className="text-[var(--gray-950)]">Δ</strong> · ingreso − proyección</span>
          </span>
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
            const dayMatchedTotal = dayEvents
              .filter(event =>
                event.source === 'BANK_MATCHED'
                || event.source === 'JDE_PAID_UNMATCHED',
              )
              .reduce((s, event) => s + event.amount, 0);
            const dayFederalTotal = dayEvents
              .filter(event => event.source === 'BANK_FEDERAL')
              .reduce((s, event) => s + event.amount, 0);
            // Federal suma al ingreso del día (venta directa a banco).
            const dayRealTotal = dayMatchedTotal + dayFederalTotal;
            // Abonos reales en banco sin factura JDE cruzada — se muestran como
            // cubeta propia "Sin factura". NO entran a dayRealTotal ni al Δ
            // (no contaminan el cruce); solo hacen visible el dinero que entró.
            const dayUnmatchedTotal = dayEvents
              .filter(event => event.source === 'BANK_UNMATCHED')
              .reduce((s, event) => s + event.amount, 0);
            const dayProjectedTotal = dayEvents
              .filter(event =>
                event.source === 'JDE_OPEN_PROJECTED'
                || event.source === 'ROL_PROJECTED',
              )
              .reduce((s, event) => s + event.amount, 0);
            const dayDiff = dayRealTotal - dayProjectedTotal;
            const isSelected = selectedDay === iso;
            const isToday = iso === todayISO;
            const isWeekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
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
                  <div className="mt-1 space-y-0.5">
                    {dayMatchedTotal > 0 && (
                      <div
                        className="rounded-md bg-[#dbeafe] text-[#1d4ed8] dark:bg-[#1e3a8a]/50 dark:text-[#93c5fd] px-1.5 py-0.5 text-[11px] font-bold tabular-nums w-fit"
                        title="Ingreso real (cruzado con banco o JDE pagada)"
                      >
                        Ing. {fmtCompact(dayMatchedTotal)}
                      </div>
                    )}
                    {dayFederalTotal > 0 && (
                      <div
                        className="rounded-md bg-[#800020]/10 text-[#800020] dark:text-[#f0a0b0] px-1.5 py-0.5 text-[11px] font-bold tabular-nums w-fit"
                        title="Ingreso Federal (venta directa a banco, sin factura JDE) — suma al ingreso del día"
                      >
                        Fed. {fmtCompact(dayFederalTotal)}
                      </div>
                    )}
                    {dayUnmatchedTotal > 0 && (
                      <div
                        className="rounded-md bg-[var(--warning-muted)] text-[var(--warning)] px-1.5 py-0.5 text-[11px] font-semibold tabular-nums w-fit"
                        title="Ingreso real en banco sin factura JDE cruzada — por identificar. No entra al cruce ('Ing.') ni al Δ."
                      >
                        S/F {fmtCompact(dayUnmatchedTotal)}
                      </div>
                    )}
                    {dayProjectedTotal > 0 && (
                      <div
                        className="rounded-md bg-[#ede9fe] text-[#5b21b6] dark:bg-[#4c1d95]/50 dark:text-[#c4b5fd] px-1.5 py-0.5 text-[11px] font-semibold tabular-nums w-fit"
                        title="Proyección desde ROL ejecutado / facturas JDE abiertas"
                      >
                        Proy. {fmtCompact(dayProjectedTotal)}
                      </div>
                    )}
                    {(dayRealTotal > 0 || dayProjectedTotal > 0) && iso <= todayISO && (
                      <div
                        className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums w-fit ${
                          dayDiff >= 0
                            ? 'bg-[var(--success-muted)] text-[var(--success)]'
                            : 'bg-[var(--danger-muted)] text-[var(--danger)]'
                        }`}
                        title="Diferencia entre ingreso real y proyección"
                      >
                        Δ {dayDiff >= 0 ? '+' : '−'}{fmtCompact(Math.abs(dayDiff))}
                      </div>
                    )}
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
              <span className="text-[13px] font-bold text-[var(--gray-950)] capitalize">
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
                    <tr key={event.id} className="cv-row border-t border-[var(--gray-100)]">
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
                        <div className="tabular-nums text-[var(--gray-950)] flex items-center gap-1.5">
                          <span>{event.date}</span>
                          {typeof event.paymentLagDays === 'number' && (
                            <PaymentLagBadge lag={event.paymentLagDays} expected={event.expectedPayDate} />
                          )}
                        </div>
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
                        ) : event.source === 'ROL_PROJECTED' ? (
                          <span className="text-[11px] text-[var(--gray-500)]">Viaje ROL ejecutado; factura aún no emitida.</span>
                        ) : event.source === 'JDE_PAID_UNMATCHED' ? (
                          <span className="text-[11px] text-[var(--gray-500)]">JDE reporta Fecha_Pago; no se requiere banco cargado.</span>
                        ) : (
                          <span className="text-[11px] text-[var(--gray-500)]">Factura JDE emitida pendiente de cobro.</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-bold text-[var(--gray-950)]">
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

      {/* Cobranza semanal — barras por semana: ingreso real (cruzado con
          banco) arriba, proyección en medio y, cuando hay, el ingreso real
          sin factura ("por identificar") abajo. Escaladas al monto semanal
          más grande para hacer comparable la magnitud. */}
      {Object.keys(weeklyTotals).length > 0 && (() => {
        const entries = Object.entries(weeklyTotals).sort(([a], [b]) => a.localeCompare(b));
        const hasUnmatched = entries.some(([, w]) => w.unmatched > 0);
        const maxWeek = Math.max(
          ...entries.map(([, w]) => Math.max(w.real, w.projected, w.unmatched)),
          1,
        );
        return (
          <div className="bg-white border border-[var(--gray-200)]/60 rounded-[var(--radius)] p-4 animate-card-in">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <h3 className="text-[13px] font-bold text-[var(--gray-950)]">Cobranza semanal</h3>
              <div className="flex items-center gap-3 text-[11px] text-[var(--gray-500)]">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-sm bg-[#2563eb]" />
                  Ingreso real
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-sm bg-[#a78bfa]" />
                  Proyección
                </span>
                {hasUnmatched && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-sm bg-[#f59e0b]" />
                    Sin factura
                  </span>
                )}
              </div>
            </div>
            <div className="space-y-3">
              {entries.map(([week, w], i) => {
                const realPct = (w.real / maxWeek) * 100;
                const projPct = (w.projected / maxWeek) * 100;
                const unmatchedPct = (w.unmatched / maxWeek) * 100;
                const delay = `${i * 60}ms`;
                return (
                  <div key={week} className="grid grid-cols-[90px_1fr_180px] items-center gap-3 animate-slide-up" style={{ animationDelay: delay }}>
                    <span className="text-[12px] text-[var(--gray-400)]">
                      Sem. {new Date(week + 'T12:00:00').toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })}
                    </span>
                    <div className="space-y-1">
                      <div className="h-3 bg-[var(--gray-50)] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[#2563eb] rounded-full animate-progress-fill"
                          style={{ width: `${Math.min(100, realPct)}%`, animationDelay: delay }}
                        />
                      </div>
                      <div className="h-3 bg-[var(--gray-50)] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[#a78bfa] rounded-full animate-progress-fill"
                          style={{ width: `${Math.min(100, projPct)}%`, animationDelay: delay }}
                        />
                      </div>
                      {hasUnmatched && (
                        <div className="h-3 bg-[var(--gray-50)] rounded-full overflow-hidden">
                          <div
                            className="h-full bg-[#f59e0b] rounded-full animate-progress-fill"
                            style={{ width: `${Math.min(100, unmatchedPct)}%`, animationDelay: delay }}
                          />
                        </div>
                      )}
                    </div>
                    <div className="text-right space-y-0.5">
                      <div className="text-[12px] font-semibold tabular-nums text-[#2563eb]">
                        {fmtCurrency(w.real)}
                      </div>
                      <div className="text-[11px] tabular-nums text-[#7c3aed]">
                        {fmtCurrency(w.projected)}
                      </div>
                      {hasUnmatched && (
                        <div className="text-[11px] tabular-nums text-[#b45309]">
                          {fmtCurrency(w.unmatched)}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}
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
const CUADRE_META: Record<CuadreStatus, { label: string; color: string; Icon: typeof CheckCircle2 }> = {
  'cuadrado': { label: 'Cuadrado', color: 'var(--success)', Icon: CheckCircle2 },
  'descuadre-importe': { label: 'Descuadre de importe', color: 'var(--warning)', Icon: AlertTriangle },
  'sin-banco': { label: 'Sin banco (no entró)', color: 'var(--danger)', Icon: Landmark },
  'revisar': { label: 'Revisar', color: 'var(--info)', Icon: HelpCircle },
  // Esperado por esquema de compensación del cliente (TLJ/APTIV/CMI) — NO es
  // descuadre accionable. Catálogo: src/config/compensationClientsCatalog.ts.
  'compensacion': { label: 'Compensación (esperado)', color: 'var(--accent-blue)', Icon: Handshake },
};

/**
 * Panel de cuadre de la cobranza APLICADA en Edwards contra el banco. Deriva de
 * `reconciliation.paymentReconciliations` (ya computado por el motor); read-only.
 * Responde "¿el cobro que Verito aplicó en JDE sí entró al banco?" con desglose
 * cuadre/descuadre por cliente e importe + corroboración GL (Auxiliar) opcional.
 */
function CobranzaBankCuadrePanel({
  paymentReconciliations,
  ciaFilter,
  glConfirmedInvoiceKeys,
}: {
  paymentReconciliations: RealReconciliationResult['paymentReconciliations'];
  ciaFilter: Set<string>;
  glConfirmedInvoiceKeys?: ReadonlySet<string>;
}) {
  const [expanded, setExpanded] = useState(true);
  const [showAllClients, setShowAllClients] = useState(false);
  const cuadre = useMemo(
    () => buildCobranzaBankCuadre(paymentReconciliations, { ciaFilter, glConfirmedInvoiceKeys }),
    [paymentReconciliations, ciaFilter, glConfirmedInvoiceKeys],
  );

  // Sin recibos aplicados (indicadores) en el rango → el panel no aporta nada.
  if (paymentReconciliations.length === 0) return null;

  const { totals, byClient, payments } = cuadre;
  const glTracked = glConfirmedInvoiceKeys != null && glConfirmedInvoiceKeys.size > 0;
  const glCount = glTracked ? payments.filter(p => p.glConfirmado).length : 0;
  const descuadreImporte = totals.sinBanco.importe + totals.descuadreImporte.importe;
  const hasCompensacion = totals.compensacion.count > 0;
  // Reglas de compensación presentes en el resultado (para la nota explicativa
  // y la cuenta asociada): únicas por etiqueta del catálogo.
  const compensacionReglas = hasCompensacion
    ? Array.from(new Map(payments.filter(p => p.compensacion).map(p => [p.compensacion!.label, p.compensacion!])).values())
    : [];

  const CLIENT_PAGE = 15;
  const visibleClients = showAllClients ? byClient : byClient.slice(0, CLIENT_PAGE);

  const cards: Array<{ status: CuadreStatus; bucket: typeof totals.cuadrado }> = [
    { status: 'cuadrado', bucket: totals.cuadrado },
    { status: 'descuadre-importe', bucket: totals.descuadreImporte },
    { status: 'sin-banco', bucket: totals.sinBanco },
    { status: 'revisar', bucket: totals.revisar },
    // La tarjeta de compensación sólo aparece cuando hay recibos en el bucket
    // (el caso común sin clientes de compensación no cambia de layout).
    ...(hasCompensacion ? [{ status: 'compensacion' as const, bucket: totals.compensacion }] : []),
  ];

  const pctColor = totals.pctCuadradoImporte >= 95
    ? 'text-[var(--success)]'
    : totals.pctCuadradoImporte >= 70
      ? 'text-[var(--warning)]'
      : 'text-[var(--danger)]';

  const exportCsv = () => {
    const rows = payments.map(p => ({
      Cia: p.cia,
      Cliente: p.cliente,
      NoCliente: p.noCliente,
      IdPago: p.idPago,
      NoRecibo: p.noRecibo,
      FechaCobro: csvDate((p.fechaCobro || '').slice(0, 10)),
      Banco: p.banco,
      Cuenta: p.cuentaBancaria,
      ImporteEdwards: p.importeEdwards,
      ImporteBanco: p.importeBanco,
      Diferencia: p.diferencia,
      Cuadre: CUADRE_META[p.status].label,
      EstatusMotor: p.paymentStatus,
      ...(hasCompensacion ? {
        EsquemaCompensacion: p.compensacion ? COMPENSATION_SCHEME_LABEL[p.compensacion.scheme] : '',
        CuentaCompensacion: p.compensacion?.cuentaCompensacion ?? '',
      } : {}),
      ...(glTracked ? { ConfirmadoGL: p.glConfirmado ? 'Sí' : 'No' } : {}),
    }));
    downloadFile(toCSV(rows), `cobranza-cuadre-banco-${todayISO()}.csv`);
  };

  return (
    <div className="bg-white border border-[var(--gray-200)]/60 rounded-[var(--radius)] overflow-hidden">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--gray-50)]"
      >
        <ArrowRightLeft className="w-4 h-4 text-[var(--gray-400)]" />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-[var(--gray-950)]">Cobranza aplicada en Edwards vs banco</div>
          <div className="text-[11px] text-[var(--gray-500)]">
            {totals.totalPagos.toLocaleString('es-MX')} recibos aplicados · descuadre {fmtCompact(descuadreImporte)}
          </div>
        </div>
        <div className="inline-flex items-center gap-2 px-3 h-8 rounded-[var(--radius-md)] border border-[var(--gray-200)] bg-[var(--surface-alt)]">
          <span className="text-[11px] uppercase tracking-wide text-[var(--gray-500)]">Cuadrado</span>
          <span className={`text-[13px] font-bold tabular-nums ${pctColor}`}>{totals.pctCuadradoImporte.toFixed(1)}%</span>
        </div>
        <ChevronDown className={`w-4 h-4 text-[var(--gray-400)] transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-[var(--gray-200)]/60 pt-4">
          {/* Tarjetas de resumen */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            {cards.map(({ status, bucket }) => {
              const meta = CUADRE_META[status];
              return (
                <div key={status} className="rounded-[var(--radius-md)] border border-[var(--gray-200)] p-3">
                  <div className="flex items-center gap-1.5 mb-1">
                    <meta.Icon className="w-3.5 h-3.5" style={{ color: meta.color }} />
                    <span className="text-[11px] text-[var(--gray-500)]">{meta.label}</span>
                  </div>
                  <div className="text-[15px] font-bold tabular-nums" style={{ color: meta.color }}>
                    {fmtCurrency(bucket.importe)}
                  </div>
                  <div className="text-[11px] text-[var(--gray-400)] tabular-nums">
                    {bucket.count.toLocaleString('es-MX')} recibos
                  </div>
                </div>
              );
            })}
          </div>

          {/* Barra apilada por importe */}
          {totals.totalEdwards > 0 && (
            <div className="h-2 w-full rounded-full overflow-hidden flex bg-[var(--gray-100)]">
              {cards.map(({ status, bucket }) => {
                const pct = (bucket.importe / totals.totalEdwards) * 100;
                if (pct <= 0) return null;
                return (
                  <div key={status} style={{ width: `${pct}%`, background: CUADRE_META[status].color }} title={`${CUADRE_META[status].label}: ${pct.toFixed(1)}%`} />
                );
              })}
            </div>
          )}

          {hasCompensacion && (
            <div className="text-[11px] text-[var(--gray-500)] flex items-start gap-1.5">
              <Handshake className="w-3.5 h-3.5 shrink-0 mt-px text-[var(--accent-blue)]" />
              <span>
                <span className="font-medium text-[var(--gray-950)]">Compensación (esperado, no accionable):</span>{' '}
                clientes con esquema de compensación — el cobro aplicado no entra (completo) como abono
                bancario de cobranza y se excluye del % de descuadre.{' '}
                {compensacionReglas.map((r, i) => (
                  <span key={r.label}>
                    {i > 0 && ' · '}
                    <span className="font-medium">{r.label}</span>: {COMPENSATION_SCHEME_LABEL[r.scheme].toLowerCase()}
                    {r.cuentaCompensacion ? ` (cuenta ${r.cuentaCompensacion})` : ''}
                  </span>
                ))}
              </span>
            </div>
          )}

          {glTracked && (
            <div className="text-[11px] text-[var(--gray-500)] inline-flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-[var(--success)]" />
              Corroborado en Auxiliar Contable: {glCount.toLocaleString('es-MX')}/{totals.totalPagos.toLocaleString('es-MX')} recibos con todas sus facturas conciliadas en el libro mayor.
            </div>
          )}

          {/* Tabla por cliente */}
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-[var(--gray-500)] border-b border-[var(--gray-200)]">
                  <th className="py-1.5 pr-2 font-medium">Cliente</th>
                  <th className="py-1.5 px-2 font-medium text-right">Recibos</th>
                  <th className="py-1.5 px-2 font-medium text-right">Aplicado</th>
                  <th className="py-1.5 px-2 font-medium text-right">Cuadrado</th>
                  <th className="py-1.5 px-2 font-medium text-right">Descuadre imp.</th>
                  <th className={`py-1.5 ${hasCompensacion ? 'px-2' : 'pl-2'} font-medium text-right`}>Sin banco</th>
                  {hasCompensacion && <th className="py-1.5 pl-2 font-medium text-right">Compensación</th>}
                </tr>
              </thead>
              <tbody>
                {visibleClients.map(c => (
                  <tr key={c.clientKey} className="border-b border-[var(--gray-100)]">
                    <td className="py-1.5 pr-2 max-w-[240px] truncate" title={`${c.cliente}${c.noCliente ? ` (${c.noCliente})` : ''}`}>
                      {c.cliente || c.noCliente || '—'}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{c.totalPagos.toLocaleString('es-MX')}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{fmtCompact(c.totalEdwards)}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-[var(--success)]">{c.cuadrado.importe > 0 ? fmtCompact(c.cuadrado.importe) : '—'}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-[var(--warning)]">{c.descuadreImporte.importe > 0 ? fmtCompact(c.descuadreImporte.importe) : '—'}</td>
                    <td className={`py-1.5 ${hasCompensacion ? 'px-2' : 'pl-2'} text-right tabular-nums text-[var(--danger)]`}>{c.sinBanco.importe > 0 ? fmtCompact(c.sinBanco.importe) : '—'}</td>
                    {hasCompensacion && (
                      <td className="py-1.5 pl-2 text-right tabular-nums text-[var(--accent-blue)]" title="Esperado por esquema de compensación — no es descuadre.">
                        {c.compensacion.importe > 0 ? fmtCompact(c.compensacion.importe) : '—'}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between">
            {byClient.length > CLIENT_PAGE ? (
              <button onClick={() => setShowAllClients(v => !v)} className="text-[12px] text-[var(--primary)] hover:underline">
                {showAllClients ? 'Ver menos' : `Ver todos (${byClient.length.toLocaleString('es-MX')})`}
              </button>
            ) : <span />}
            <button
              onClick={exportCsv}
              className="inline-flex items-center gap-1.5 px-3 h-8 rounded-[var(--radius-md)] border border-[var(--gray-200)] text-[12px] text-[var(--gray-500)] hover:text-[var(--gray-950)] hover:bg-[var(--gray-50)]"
              title="Exporta el detalle por recibo (cuadre vs banco)."
            >
              <Download className="w-3.5 h-3.5" />
              Exportar CSV ({totals.totalPagos.toLocaleString('es-MX')})
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CobranzaRealView({
  clients,
  assumptions,
  records,
  payments,
  rolRecords = [],
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
  glConfirmedInvoiceKeys,
}: {
  clients: Client[];
  assumptions: CashFlowAssumptions;
  records: CobranzaRecord[];
  payments: CobranzaPayment[];
  /** Viajes ROL ejecutados — alimentan la proyección "por facturar" del calendario. */
  rolRecords?: RolRecord[];
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
  glConfirmedInvoiceKeys?: ReadonlySet<string>;
}) {
  // Default del filtro local: si el global selectedCia es una cía válida
  // (no 'all'), arrancamos filtrados por esa cía. Si después el usuario
  // cambia el global, sincronizamos también. Multi-empresa: Set vacío = todas.
  const [ciaFilter, setCiaFilter] = useState<Set<string>>(() =>
    defaultCia && defaultCia !== 'all' ? new Set([defaultCia]) : new Set(),
  );
  useEffect(() => {
    if (defaultCia && defaultCia !== 'all') setCiaFilter(new Set([defaultCia]));
    else if (defaultCia === 'all') setCiaFilter(new Set());
  }, [defaultCia]);
  const [estatusFilter, setEstatusFilter] = useState<string>('all');
  const [segmentoFilter, setSegmentoFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [crossFilter, setCrossFilter] = useState<'all' | 'matched' | 'review' | 'pending'>('all');

  // ── Motor de cruce (Fase 2/3) ──────────────────────────────────────────
  // Default: usar el resultado pre-computado de App.tsx. Si por alguna razón
  // no llegó (renders aislados, tests, embed externo) caemos a un cómputo
  // local — la pestaña debe seguir funcionando aunque el padre no haya
  // cableado la prop.
  const confirmedReviewKeys = useConfirmedReviewKeys();
  const [fallbackReconciliation, setFallbackReconciliation] = useState<RealReconciliationResult>(() =>
    emptyRealReconciliationResult(),
  );
  useEffect(() => {
    if (externalReconciliation) return;
    if (records.length === 0 && payments.length === 0) {
      setFallbackReconciliation(emptyRealReconciliationResult());
      return;
    }

    let cancelled = false;
    void import('../domain/realReconciliationEngine')
      .then(({ reconcileRealCollections }) => {
        if (cancelled) return;
        const raw = reconcileRealCollections(records, bankStatements, { cobranzaPayments: payments });
        if (!cancelled) setFallbackReconciliation(applyManualConfirmations(raw, confirmedReviewKeys));
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[reconciliation] fallback no disponible (chunk/compute falló)', err);
      });

    return () => {
      cancelled = true;
    };
  }, [externalReconciliation, records, bankStatements, payments, confirmedReviewKeys]);
  const reconciliation = externalReconciliation ?? fallbackReconciliation;
  const matchByFactura = useMemo(() => {
    if (externalFacturaIndex) return externalFacturaIndex;
    const m = new Map<string, RealReconciliationMatch>();
    for (const x of reconciliation.matches) {
      m.set(`${x.cia}::${x.noFactura}`, x);
    }
    return m;
  }, [externalFacturaIndex, reconciliation.matches]);
  // Proyección ROL: viajes ejecutados aún sin factura, fechados por la regla
  // del cliente (días crédito + día de pago + frecuencia). Es el ingreso de
  // corto plazo más grande del módulo — sin esta capa la proyección del
  // calendario salía muy por debajo de la realidad.
  const rolProjection = useMemo(
    () => buildRolProjectedInflows({
      rolRecords,
      cobranzaRecords: records,
      cobranzaPayments: payments,
      clients,
      assumptions,
      asOfDate: todayISO(),
      // El calendario SÍ muestra cobros ROL calendarizados en el pasado:
      // permite comparar lo que debía caer vs el ingreso real cruzado (Δ).
      includePastDates: true,
    }),
    [rolRecords, records, payments, clients, assumptions],
  );
  const collectionCalendar = useMemo(
    () => buildCollectionCalendar({
      clients,
      assumptions,
      cobranzaRecords: records,
      reconciliation,
      rolProjection,
    }),
    [clients, assumptions, records, reconciliation, rolProjection],
  );
  const calendarEventByFactura = useMemo(() => {
    const priority: Record<CollectionCalendarEventSource, number> = {
      BANK_MATCHED: 0,
      BANK_FEDERAL: 1,
      BANK_UNMATCHED: 2,
      JDE_PAID_UNMATCHED: 3,
      JDE_OPEN_PROJECTED: 4,
      ROL_PROJECTED: 5,
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

  const companyOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of records) if (r.cia) set.add(r.cia);
    return Array.from(set)
      .map(cia => ({ cia, nombre: ciaName.get(cia) ?? `Cia ${cia}` }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es-MX'));
  }, [records, ciaName]);

  const allEstatus = useMemo(() => {
    const set = new Set<string>();
    for (const r of records) if (r.estatus) set.add(r.estatus);
    return Array.from(set).sort();
  }, [records]);

  // Segmento / tipo de servicio (B2.3). El filtro y el desglose sólo aparecen
  // cuando el API realmente trae al menos un segmento clasificado — así el
  // mecanismo queda listo sin ensuciar la UI mientras el dato no fluya.
  const allSegments = useMemo(() => listSegments(records), [records]);
  const hasSegments = useMemo(() => allSegments.some(s => s !== SEGMENT_UNCLASSIFIED), [allSegments]);

  const filtered = useMemo(() => {
    return records.filter(r => {
      if (ciaFilter.size > 0 && !(r.cia && ciaFilter.has(r.cia))) return false;
      if (estatusFilter !== 'all' && r.estatus !== estatusFilter) return false;
      if (segmentoFilter !== 'all' && segmentOf(r) !== segmentoFilter) return false;
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
  }, [records, ciaFilter, estatusFilter, segmentoFilter, crossFilter, query, matchByFactura]);

  const segmentBreakdown = useMemo(() => buildSegmentBreakdown(filtered), [filtered]);

  if (records.length === 0 && payments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center bg-white border border-[var(--gray-200)]/60 rounded-[var(--radius)]">
        <div className="w-14 h-14 rounded-[var(--radius-lg)] bg-[var(--primary-muted)] flex items-center justify-center mb-3">
          <Database className="w-6 h-6 text-[var(--primary)]" />
        </div>
        <h3 className="text-base font-bold text-[var(--gray-950)]">Sin cobranza JDE cargada</h3>
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
            className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-[var(--radius-md)] border border-[var(--primary)] bg-[var(--primary)] text-white text-[13px] font-medium hover:bg-[var(--primary)]/90 disabled:opacity-50"
          >
            {refreshing ? 'Reintentando…' : 'Reintentar carga'}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filtros */}
      <div className="bg-white border border-[var(--gray-200)]/60 rounded-[var(--radius)] p-4 flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search className="w-4 h-4 text-[var(--gray-400)] absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Cliente, factura, número…"
            className="input pl-9 w-full"
          />
        </div>

        <CompanyMultiSelect
          options={companyOptions}
          selected={ciaFilter}
          onChange={setCiaFilter}
        />

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

        {hasSegments && (
          <select
            value={segmentoFilter}
            onChange={e => setSegmentoFilter(e.target.value)}
            className="input text-[12px] h-8"
            title="Segmento / tipo de servicio"
          >
            <option value="all">Todos los segmentos</option>
            {allSegments.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        )}

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

        {(query || ciaFilter.size > 0 || estatusFilter !== 'all' || segmentoFilter !== 'all' || crossFilter !== 'all') && (
          <button
            onClick={() => { setQuery(''); setCiaFilter(new Set()); setEstatusFilter('all'); setSegmentoFilter('all'); setCrossFilter('all'); }}
            className="text-[12px] text-[var(--primary)] hover:underline px-2"
          >
            Limpiar
          </button>
        )}

        {/* Indicador único: % de abonos bancarios que vienen tagueados con
            un noRecibo JDE — proxy rápido y exacto del cruce. Cuenta sobre
            todos los movimientos de los estados de cuenta cargados, sin
            depender del motor pesado de reconciliación que corre en worker
            (puede tardar minutos). Solo aparece cuando hay estados de cuenta. */}
        {bankStatements.length > 0 && (() => {
          let totalAbonos = 0;
          let abonosConRecibo = 0;
          for (const account of bankStatements) {
            for (const mov of account.movimientos) {
              if (mov.tipoMovimiento !== 'ABONO') continue;
              totalAbonos++;
              if ((mov.noRecibo ?? '').trim()) abonosConRecibo++;
            }
          }
          const pctCruzado = totalAbonos > 0 ? (abonosConRecibo / totalAbonos) * 100 : 0;
          const pctColor = pctCruzado >= 95
            ? 'text-[var(--success)]'
            : pctCruzado >= 70
              ? 'text-[var(--warning)]'
              : 'text-[var(--danger)]';
          return (
            <div
              className="ml-auto inline-flex items-center gap-2 px-3 h-8 rounded-[var(--radius-md)] border border-[var(--gray-200)] bg-[var(--surface-alt)]"
              title={`${abonosConRecibo.toLocaleString('es-MX')} de ${totalAbonos.toLocaleString('es-MX')} abonos bancarios del rango cargado vienen con número de recibo JDE.`}
            >
              <Landmark className="w-3.5 h-3.5 text-[var(--gray-400)]" />
              <span className="text-[11px] uppercase tracking-wide text-[var(--gray-500)]">Cruzado con banco</span>
              <span className={`text-[13px] font-bold tabular-nums ${pctColor}`}>{pctCruzado.toFixed(1)}%</span>
              <span className="text-[11px] text-[var(--gray-400)] tabular-nums">
                {abonosConRecibo.toLocaleString('es-MX')}/{totalAbonos.toLocaleString('es-MX')}
              </span>
            </div>
          );
        })()}

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
                FechaFactura: csvDate((r.fechaFactura || '').slice(0, 10)),
                FechaVence: csvDate((r.fechaVence || '').slice(0, 10)),
                FechaCobroJDE: csvDate((r.fechaCobro || '').slice(0, 10)),
                DiasVencida: r.diasVencida,
                BrutoMXN: r.importeBrutoPesos,
                PendienteMXN: r.importePendientePesos,
                Moneda: r.moneda,
                EstatusJDE: r.estatus,
                FuenteDato: calendarEvent ? COLLECTION_CALENDAR_SOURCE_LABELS[calendarEvent.source] : '',
                FechaCalendario: csvDate(calendarEvent?.date ?? ''),
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
                FechaBanco: csvDate(m?.bankDate ?? ''),
                RefBanco: m?.bankRef ?? '',
                MontoBanco: m?.bankAmount ?? '',
                CuentaBanco: m?.bankAccount ?? '',
                ConceptoBanco: m?.bankConcept ?? '',
                MovimientosBanco: m?.bankMovements?.length ?? '',
                SubsetID: m?.subsetGroupId ?? '',
              };
            });
            const stamp = todayISO();
            downloadFile(toCSV(rows), `cobranza-cruce-${stamp}.csv`);
          }}
          className="inline-flex items-center gap-1.5 px-3 h-8 rounded-[var(--radius-md)] border border-[var(--gray-200)] text-[12px] text-[var(--gray-500)] hover:text-[var(--gray-950)] hover:bg-[var(--gray-50)]"
          disabled={filtered.length === 0}
          title="Exporta lo visible con todas las columnas de cruce."
        >
          <Download className="w-3.5 h-3.5" />
          Exportar CSV ({filtered.length.toLocaleString('es-MX')})
        </button>
      </div>

      {/* Cuadre de cobranza APLICADA en Edwards vs banco (Bloque 2). Valida
          que cada cobro que Verito aplicó en JDE realmente entró al banco;
          marca cuadre vs descuadre por cliente/importe. Read-only, deriva de
          reconciliation.paymentReconciliations (ya computado). */}
      <CobranzaBankCuadrePanel
        paymentReconciliations={reconciliation.paymentReconciliations}
        ciaFilter={ciaFilter}
        glConfirmedInvoiceKeys={glConfirmedInvoiceKeys}
      />

      {/* Desglose por segmento / tipo de servicio (B2.3). Sólo aparece cuando
          el API trae al menos un segmento clasificado; respeta los filtros
          activos (opera sobre `filtered`). Display-only. */}
      {hasSegments && (
        <div className="bg-white border border-[var(--gray-200)]/60 rounded-[var(--radius)] p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[13px] font-semibold text-[var(--gray-950)]">Desglose por segmento</h3>
            <span className="text-[11px] text-[var(--gray-400)]">tipo de servicio · sobre lo filtrado</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead className="text-[var(--gray-400)] text-left border-b border-[var(--gray-200)]/60">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">Segmento</th>
                  <th className="py-1.5 px-3 font-medium text-right">Facturas</th>
                  <th className="py-1.5 px-3 font-medium text-right">Bruto</th>
                  <th className="py-1.5 pl-3 font-medium text-right">Pendiente</th>
                </tr>
              </thead>
              <tbody>
                {segmentBreakdown.map(row => (
                  <tr key={row.segment} className="border-b border-[var(--gray-200)]/30 last:border-0">
                    <td className="py-1.5 pr-3 text-[var(--gray-950)]">
                      {row.segment === SEGMENT_UNCLASSIFIED
                        ? <span className="text-[var(--gray-400)]">{row.segment}</span>
                        : row.segment}
                    </td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{row.invoiceCount}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums font-medium">{fmtCurrency(row.bruto)}</td>
                    <td className="py-1.5 pl-3 text-right tabular-nums text-[var(--warning)]">{fmtCurrency(row.pendiente)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

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

    </div>
  );
}
