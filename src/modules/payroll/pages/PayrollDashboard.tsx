/**
 * Dashboard de Nómina — consumidor del API TRESS `/v1/erp/tress/nomina`.
 *
 * Lee `nominaRecords` y `nominaLoadedKeys` del store (cache aditivo), permite
 * disparar un refresh por (cia, tipoNomina, año, mes) y organiza el análisis en
 * sub-pestañas (Resumen / Comparativo / Conceptos / Tendencia / Predictivo /
 * Alertas / Detalle). La fórmula del cash neto vive en `payrollModuleService`;
 * las agregaciones de análisis en `payrollAnalyticsService`.
 *
 * Dos datasets se derivan de los filtros:
 *   - `monthSnapshot`: filtrado por (cía, tipo, año, mes) — alimenta las vistas
 *     instantáneas (Resumen, Comparativo, Conceptos, Detalle).
 *   - `historyFiltered`: filtrado sólo por (cía, tipo), TODA la historia —
 *     alimenta las vistas temporales (Tendencia, Predictivo, Alertas).
 *
 * App.tsx entrega estos registros al motor canónico para Planeación,
 * Proyección e Impuestos. El API es agregado (empresa × concepto × periodo ×
 * mes) y no trae empleado/puesto/centro de costo — ver `README.md` para el
 * mapeo HTML→API y los gaps.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Building2,
  CalendarClock,
  LayoutGrid,
  Loader2,
  PieChart,
  RefreshCcw,
  Sparkles,
  Table,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import { fmtDate } from '../../../formatters';
import PageHeader from '../../../components/ui/PageHeader';
import type { PayrollCostRecord } from '../../shared-finance/types';
import { fetchNomina, JdeApiError } from '../../../services/jde';
import {
  filterRecords,
  findSuspectMonths,
  lastNMonths,
  mergeNominaBatch,
  nominaCacheKey,
} from '../services/payrollModuleService';

const PayrollResumenView = lazy(() => import('../components/PayrollResumenView'));
const PayrollCompanyView = lazy(() => import('../components/PayrollCompanyView'));
const PayrollConceptView = lazy(() => import('../components/PayrollConceptView'));
const PayrollTrendView = lazy(() => import('../components/PayrollTrendView'));
const PayrollForecastView = lazy(() => import('../components/PayrollForecastView'));
const PayrollAlertsView = lazy(() => import('../components/PayrollAlertsView'));
const PayrollPeriodsView = lazy(() => import('../components/PayrollPeriodsView'));
const PayrollTablesView = lazy(() => import('../components/PayrollTablesView'));

/** Mes actual + N-1 anteriores. Refresh jala este histórico para proyectar. */
const HISTORY_WINDOW_MONTHS = 4;

interface Props {
  companyCode: string;
  /** Records ya persistidos en `MidasStore.nominaRecords`. */
  nominaRecords: PayrollCostRecord[];
  /** Llaves de cache ya cargadas (`${id}:${tipo}:${año}:${mes}` → ISO). */
  nominaLoadedKeys: Record<string, string>;
  /**
   * Cuántos meses esperados ya bajaron del backfill (24 meses = fast-path YTD
   * + histórico). Mientras `loaded < total` la UI muestra un banner.
   */
  backfillProgress?: { loaded: number; total: number };
  syncStatus?: 'idle' | 'loading' | 'ready' | 'stale' | 'error';
  /** Callback al merge exitoso — App.tsx persiste en MidasStore. */
  onNominaFetched: (
    merged: PayrollCostRecord[],
    cacheKeys: Record<string, string>,
  ) => void;
}

// ── Constantes UI ──────────────────────────────────────────────────────────

const ID_EMPRESA_CHOICES: Array<{ value: number; label: string }> = [
  { value: 99, label: 'Todas' },
  { value: 1, label: 'Federal' },
  { value: 11, label: 'SIR' },
  { value: 17, label: 'SIT' },
  { value: 33, label: 'Multicarga' },
  { value: 42, label: 'TICH' },
];

const TIPO_NOMINA_CHOICES: Array<{ value: number; label: string }> = [
  { value: 99, label: 'Todas' },
  { value: 1, label: 'Semanal y Operadores' },
  { value: 3, label: 'Quincenal y Ejecutivos' },
];

const MONTHS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

type SubTabId = 'resumen' | 'empresa' | 'conceptos' | 'tendencia' | 'predictivo' | 'alertas' | 'periodos' | 'detalle';

interface SubTabDef {
  id: SubTabId;
  label: string;
  icon: LucideIcon;
  /** `history` usa el dataset multi-mes; `snapshot` usa el mes filtrado. */
  scope: 'snapshot' | 'history';
}

const SUB_TABS: SubTabDef[] = [
  { id: 'resumen', label: 'Resumen', icon: PieChart, scope: 'snapshot' },
  { id: 'empresa', label: 'Comparativo', icon: Building2, scope: 'snapshot' },
  { id: 'conceptos', label: 'Conceptos', icon: BarChart3, scope: 'snapshot' },
  { id: 'tendencia', label: 'Tendencia', icon: TrendingUp, scope: 'history' },
  { id: 'predictivo', label: 'Predictivo', icon: Sparkles, scope: 'history' },
  { id: 'alertas', label: 'Alertas', icon: AlertTriangle, scope: 'history' },
  { id: 'periodos', label: 'Periodos', icon: CalendarClock, scope: 'snapshot' },
  { id: 'detalle', label: 'Detalle', icon: Table, scope: 'snapshot' },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function normalizeCia(idEmpresa: number): string {
  if (idEmpresa === 99) return '';
  return String(idEmpresa).padStart(5, '0');
}

// ── Component ──────────────────────────────────────────────────────────────

export default function PayrollDashboard({
  companyCode,
  nominaRecords,
  nominaLoadedKeys,
  backfillProgress,
  syncStatus = 'idle',
  onNominaFetched,
}: Props) {
  const now = new Date();
  const [idEmpresa, setIdEmpresa] = useState<number>(99);
  const [tipoNomina, setTipoNomina] = useState<number>(99);
  const [anio, setAnio] = useState<number>(now.getFullYear());
  const [mes, setMes] = useState<number>(now.getMonth() + 1);
  const [activeTab, setActiveTab] = useState<SubTabId>('resumen');
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const autoRefreshAttemptsRef = useRef<Set<string>>(new Set());

  const cacheKey = nominaCacheKey({ idEmpresa, tipoNomina, anio, mes });
  const lastLoadedAt = nominaLoadedKeys[cacheKey];

  // `companyCode` es la cia activa global; si el usuario filtra por una cia
  // específica en el módulo, se respeta esa.
  const ciaFilter = idEmpresa === 99
    ? (companyCode && companyCode !== 'all' ? companyCode : undefined)
    : normalizeCia(idEmpresa);
  // Filtro por CLASE tolerante (no por string exacto): TRESS emite "Semanal"/
  // "Operadores" (tipo 1) y "Quincenal"/"Ejecutivos" (tipo 3), así que comparar
  // contra 'Semanal'/'Quincenal' literal dejaba quincena en cero.
  const tipoClassFilter: 'semanal' | 'quincenal' | undefined =
    tipoNomina === 99 ? undefined : (tipoNomina === 1 ? 'semanal' : 'quincenal');

  // Snapshot del mes: alimenta Resumen / Comparativo / Conceptos / Periodos / Detalle.
  const monthSnapshot = useMemo(
    () => filterRecords(nominaRecords, {
      cia: ciaFilter,
      year: anio,
      month: mes,
      payrollTypeClass: tipoClassFilter,
    }),
    [nominaRecords, ciaFilter, anio, mes, tipoClassFilter],
  );

  // Historia completa (cía + tipo, todos los meses): Tendencia / Predictivo /
  // Alertas. No filtra por año/mes a propósito.
  const historyFiltered = useMemo(
    () => filterRecords(nominaRecords, { cia: ciaFilter, payrollTypeClass: tipoClassFilter }),
    [nominaRecords, ciaFilter, tipoClassFilter],
  );

  /**
   * Refresh = mes seleccionado + (HISTORY_WINDOW_MONTHS-1) anteriores, en
   * paralelo. Persiste lo que pase y reporta lo que falle.
   */
  const refresh = useCallback(async () => {
    setLoading(true);
    setErrMsg(null);
    try {
      const window = lastNMonths(anio, mes, HISTORY_WINDOW_MONTHS);
      const results = await Promise.allSettled(
        window.map(p => fetchNomina({ idEmpresa, tipoNomina, anio: p.anio, mes: p.mes })),
      );

      const fetchedAt = new Date().toISOString();
      let merged = nominaRecords;
      const freshKeys: Record<string, string> = {};
      const failures: string[] = [];

      results.forEach((res, i) => {
        const p = window[i];
        const key = nominaCacheKey({ idEmpresa, tipoNomina, anio: p.anio, mes: p.mes });
        if (res.status === 'fulfilled') {
          merged = mergeNominaBatch(merged, res.value);
          freshKeys[key] = fetchedAt;
        } else {
          const reason = res.reason;
          const msg = reason instanceof JdeApiError
            ? `${reason.message} (status ${reason.status})`
            : reason instanceof Error
              ? reason.message
              : 'Error desconocido';
          failures.push(`${p.anio}-${String(p.mes).padStart(2, '0')}: ${msg}`);
        }
      });

      if (Object.keys(freshKeys).length > 0) {
        onNominaFetched(merged, freshKeys);
      }
      if (failures.length > 0) {
        setErrMsg(`Fallaron ${failures.length}/${window.length} meses → ${failures.join(' · ')}`);
      }
    } catch (e) {
      const msg = e instanceof JdeApiError
        ? `${e.message} (status ${e.status})`
        : e instanceof Error
          ? e.message
          : 'Error desconocido';
      setErrMsg(msg);
    } finally {
      setLoading(false);
    }
  }, [idEmpresa, tipoNomina, anio, mes, nominaRecords, onNominaFetched]);

  const visibleMonthIsPartial = useMemo(
    () => findSuspectMonths(monthSnapshot).some((item) => item.year === anio && item.month === mes),
    [monthSnapshot, anio, mes],
  );
  const yearOptions = useMemo(() => {
    const current = now.getFullYear();
    return [current - 1, current, current + 1];
  }, [now]);

  useEffect(() => {
    if (!visibleMonthIsPartial || loading) return;
    const key = `${idEmpresa}:${tipoNomina}:${anio}:${mes}`;
    if (autoRefreshAttemptsRef.current.has(key)) return;
    autoRefreshAttemptsRef.current.add(key);
    void refresh();
  }, [visibleMonthIsPartial, loading, idEmpresa, tipoNomina, anio, mes, refresh]);

  const backfillInProgress = backfillProgress && backfillProgress.loaded < backfillProgress.total;
  const autoSyncInProgress = syncStatus === 'loading' || syncStatus === 'stale';

  const activeScope = SUB_TABS.find(t => t.id === activeTab)?.scope ?? 'snapshot';

  return (
    <div className="space-y-6">
      {autoSyncInProgress && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
          style={{
            borderColor: 'var(--accent-blue)',
            background: 'color-mix(in oklab, var(--accent-blue) 10%, transparent)',
            color: 'var(--gray-700)',
          }}
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Actualizando TRESS automáticamente. Los pagos pueden ajustarse al terminar la sincronización.</span>
        </div>
      )}
      {visibleMonthIsPartial && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
          style={{
            borderColor: 'var(--warning, #d97706)',
            background: 'rgba(217, 119, 6, 0.08)',
            color: 'var(--gray-700)',
          }}
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Detecté nómina parcial para este mes. Refrescando TRESS automáticamente.</span>
        </div>
      )}
      {backfillInProgress && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
          style={{
            borderColor: 'var(--warning, #d97706)',
            background: 'rgba(217, 119, 6, 0.08)',
            color: 'var(--warning, #d97706)',
          }}
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>
            Cargando histórico TRESS · {backfillProgress!.loaded} de {backfillProgress!.total} meses
            sincronizados. Los KPIs se actualizan conforme bajan los datos.
          </span>
        </div>
      )}
      <PageHeader
        title="Nómina"
        meta={
          lastLoadedAt
            ? `Último refresh ${fmtDate(new Date(lastLoadedAt))}`
            : 'Sin datos cargados para los filtros actuales'
        }
        actions={
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition disabled:opacity-50"
            style={{ borderColor: 'var(--gray-300)', background: 'var(--surface)' }}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            <span>{loading ? 'Cargando…' : `Refrescar TRESS (${HISTORY_WINDOW_MONTHS} meses)`}</span>
          </button>
        }
      />

      {/* Puente hacia el flujo de caja: Nómina es análisis sobre TRESS, no el
          egreso de caja. Aclara dónde vive ese egreso para que el módulo no
          quede como una isla (audit #23). */}
      <div
        className="rounded-md px-4 py-2.5 text-[12px] leading-relaxed"
        style={{ background: 'var(--gray-50)', border: '1px solid var(--gray-200)', color: 'var(--gray-600)' }}
      >
        Este módulo es <strong>análisis de nómina sobre TRESS</strong> (conceptos, tendencia,
        anomalías). El <strong>egreso de caja</strong> de la nómina —lo que sale del banco— se
        ve en <strong>Egresos → Planeación / Proyección</strong>, donde entra al flujo junto con
        el resto de los pagos.
      </div>

      {/* Filtros */}
      <section
        className="rounded-lg border p-4"
        style={{ borderColor: 'var(--gray-200)', background: 'var(--surface)' }}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--gray-500)' }}>Empresa</span>
            <select
              value={idEmpresa}
              onChange={(e) => setIdEmpresa(Number(e.target.value))}
              className="rounded-md border px-2 py-1.5"
              style={{ borderColor: 'var(--gray-300)', background: 'var(--surface)' }}
            >
              {ID_EMPRESA_CHOICES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--gray-500)' }}>Tipo de Nómina</span>
            <select
              value={tipoNomina}
              onChange={(e) => setTipoNomina(Number(e.target.value))}
              className="rounded-md border px-2 py-1.5"
              style={{ borderColor: 'var(--gray-300)', background: 'var(--surface)' }}
            >
              {TIPO_NOMINA_CHOICES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--gray-500)' }}>
              Año {activeScope === 'history' && <span className="lowercase">(no aplica)</span>}
            </span>
            <select
              value={anio}
              onChange={(e) => setAnio(Number(e.target.value))}
              disabled={activeScope === 'history'}
              className="rounded-md border px-2 py-1.5 disabled:opacity-50"
              style={{ borderColor: 'var(--gray-300)', background: 'var(--surface)' }}
            >
              {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--gray-500)' }}>
              Mes {activeScope === 'history' && <span className="lowercase">(no aplica)</span>}
            </span>
            <select
              value={mes}
              onChange={(e) => setMes(Number(e.target.value))}
              disabled={activeScope === 'history'}
              className="rounded-md border px-2 py-1.5 disabled:opacity-50"
              style={{ borderColor: 'var(--gray-300)', background: 'var(--surface)' }}
            >
              {MONTHS.map((label, i) => <option key={i} value={i + 1}>{label}</option>)}
            </select>
          </label>
        </div>
        {activeScope === 'history' && (
          <p className="mt-2 text-xs" style={{ color: 'var(--gray-500)' }}>
            Esta vista usa la historia completa (todos los meses) de la empresa y tipo de nómina
            seleccionados; los filtros de año/mes no aplican aquí.
          </p>
        )}
        {errMsg && (
          <p
            className="mt-3 rounded-md border px-3 py-2 text-sm"
            style={{
              borderColor: 'color-mix(in oklch, var(--danger) 30%, var(--gray-200))',
              background: 'var(--danger-muted)',
              color: 'var(--danger)',
            }}
          >
            {errMsg}
          </p>
        )}
      </section>

      {/* Sub-pestañas */}
      <nav
        className="flex flex-wrap gap-1 rounded-lg border p-1"
        style={{ borderColor: 'var(--gray-200)', background: 'var(--surface)' }}
        aria-label="Vistas de análisis de nómina"
      >
        {SUB_TABS.map((t) => {
          const Icon = t.icon;
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              aria-current={active ? 'page' : undefined}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition"
              style={{
                background: active ? 'var(--accent-blue)' : 'transparent',
                color: active ? '#fff' : 'var(--gray-600)',
              }}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          );
        })}
      </nav>

      <Suspense
        fallback={
          <div className="flex items-center gap-2 p-6 text-sm" style={{ color: 'var(--gray-500)' }}>
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando vista…
          </div>
        }
      >
        {activeTab === 'resumen' && <PayrollResumenView records={monthSnapshot} />}
        {activeTab === 'empresa' && <PayrollCompanyView records={monthSnapshot} />}
        {activeTab === 'conceptos' && <PayrollConceptView records={monthSnapshot} />}
        {activeTab === 'tendencia' && <PayrollTrendView records={historyFiltered} />}
        {activeTab === 'predictivo' && <PayrollForecastView records={historyFiltered} />}
        {activeTab === 'alertas' && <PayrollAlertsView records={historyFiltered} />}
        {activeTab === 'periodos' && <PayrollPeriodsView records={monthSnapshot} />}
        {activeTab === 'detalle' && <PayrollTablesView records={monthSnapshot} />}
      </Suspense>

      {activeScope === 'snapshot' && monthSnapshot.length === 0 && (
        <div
          className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
          style={{ borderColor: 'var(--gray-200)', background: 'var(--surface)', color: 'var(--gray-500)' }}
        >
          <LayoutGrid className="h-4 w-4" />
          <span>Sin datos para {MONTHS[mes - 1]} {anio} con los filtros actuales. Ajusta los filtros o refresca TRESS.</span>
        </div>
      )}
    </div>
  );
}
