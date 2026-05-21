/**
 * Dashboard de Nómina — consumidor del API TRESS `/v1/erp/tress/nomina`.
 *
 * Lee `nominaRecords` y `nominaLoadedKeys` del store (cache aditivo), permite
 * disparar un refresh por (cia, tipoNomina, año, mes) y renderiza KPIs +
 * tablas. La fórmula del cash neto al empleado vive en `payrollModuleService`.
 *
 * App.tsx entrega estos registros al motor canónico para Planeación,
 * Proyección e Impuestos. Aquí se mantienen visibles los datos crudos y
 * agregados para revisión operativa.
 */

import { useCallback, useMemo, useState } from 'react';
import { Banknote, Calendar, Coins, Download, Loader2, RefreshCcw, Users } from 'lucide-react';
import { fmtCompact, fmtCurrency, fmtDate } from '../../../formatters';
import PageHeader from '../../../components/ui/PageHeader';
import KpiCard from '../../../components/ui/KpiCard';
import EmptyState from '../../shared-finance/components/EmptyState';
import type { PayrollCostRecord } from '../../shared-finance/types';
import { fetchNomina, JdeApiError } from '../../../services/jde';
import {
  computeKpis,
  filterRecords,
  lastNMonths,
  mergeNominaBatch,
  nominaCacheKey,
  summarizeByConcept,
  summarizePeriods,
} from '../services/payrollModuleService';

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
   * + histórico). Mientras `loaded < total` la UI muestra un banner para que
   * el usuario no asuma que los KPIs (4 meses YTD) son definitivos.
   */
  backfillProgress?: { loaded: number; total: number };
  /**
   * Callback al merge exitoso — App.tsx persiste en MidasStore.
   * `cacheKeys` puede contener varias entradas cuando el refresh jala un
   * histórico (mes actual + meses anteriores), una por cada (anio, mes)
   * fetched OK.
   */
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
  onNominaFetched,
}: Props) {
  const now = new Date();
  const [idEmpresa, setIdEmpresa] = useState<number>(99);
  const [tipoNomina, setTipoNomina] = useState<number>(99);
  const [anio, setAnio] = useState<number>(now.getFullYear());
  const [mes, setMes] = useState<number>(now.getMonth() + 1);
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const cacheKey = nominaCacheKey({ idEmpresa, tipoNomina, anio, mes });
  const lastLoadedAt = nominaLoadedKeys[cacheKey];

  // Vista filtrada por (selectedCia/idEmpresa, año, mes, tipoNomina).
  // `companyCode` es la cia activa global del app; si el usuario filtra por
  // una cia específica en el módulo, se respeta esa.
  const ciaFilter = idEmpresa === 99
    ? (companyCode && companyCode !== 'all' ? companyCode : undefined)
    : normalizeCia(idEmpresa);
  const tipoFilter = tipoNomina === 99 ? undefined : (tipoNomina === 1 ? 'Semanal' : 'Quincenal');

  const filtered = useMemo(
    () => filterRecords(nominaRecords, {
      cia: ciaFilter,
      year: anio,
      month: mes,
      payrollType: tipoFilter,
    }),
    [nominaRecords, ciaFilter, anio, mes, tipoFilter],
  );

  const kpis = useMemo(() => computeKpis(filtered), [filtered]);
  const periods = useMemo(() => summarizePeriods(filtered), [filtered]);
  const conceptBreakdown = useMemo(() => summarizeByConcept(filtered), [filtered]);
  const topConcepts = conceptBreakdown.slice(0, 12);

  /**
   * Refresh = mes seleccionado + (HISTORY_WINDOW_MONTHS-1) anteriores.
   * Fetch en paralelo para que la latencia total ≈ max(fetch) y no Σ.
   * Si alguna falla, persistimos las que sí pasaron y reportamos el resto.
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

  const hasData = filtered.length > 0;
  const yearOptions = useMemo(() => {
    const current = now.getFullYear();
    return [current - 1, current, current + 1];
  }, [now]);

  const backfillInProgress = backfillProgress && backfillProgress.loaded < backfillProgress.total;

  return (
    <div className="space-y-6">
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

      {/* Filtros */}
      <section
        className="rounded-lg border p-4"
        style={{ borderColor: 'var(--gray-200)', background: 'var(--surface)' }}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--gray-500)' }}>
              Empresa
            </span>
            <select
              value={idEmpresa}
              onChange={(e) => setIdEmpresa(Number(e.target.value))}
              className="rounded-md border px-2 py-1.5"
              style={{ borderColor: 'var(--gray-300)', background: 'var(--surface)' }}
            >
              {ID_EMPRESA_CHOICES.map(c => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--gray-500)' }}>
              Tipo de Nómina
            </span>
            <select
              value={tipoNomina}
              onChange={(e) => setTipoNomina(Number(e.target.value))}
              className="rounded-md border px-2 py-1.5"
              style={{ borderColor: 'var(--gray-300)', background: 'var(--surface)' }}
            >
              {TIPO_NOMINA_CHOICES.map(c => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--gray-500)' }}>
              Año
            </span>
            <select
              value={anio}
              onChange={(e) => setAnio(Number(e.target.value))}
              className="rounded-md border px-2 py-1.5"
              style={{ borderColor: 'var(--gray-300)', background: 'var(--surface)' }}
            >
              {yearOptions.map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--gray-500)' }}>
              Mes
            </span>
            <select
              value={mes}
              onChange={(e) => setMes(Number(e.target.value))}
              className="rounded-md border px-2 py-1.5"
              style={{ borderColor: 'var(--gray-300)', background: 'var(--surface)' }}
            >
              {MONTHS.map((label, i) => (
                <option key={i} value={i + 1}>{label}</option>
              ))}
            </select>
          </label>
        </div>
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

      {/* KPIs */}
      <section className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <KpiCard
          label="Nómina Bruta"
          value={fmtCurrency(kpis.totalGross)}
          icon={<Coins className="h-4 w-4" />}
          sublabel="Σ Percepciones"
        />
        <KpiCard
          label="Pago Neto al Empleado"
          value={fmtCurrency(kpis.totalNetCash)}
          icon={<Banknote className="h-4 w-4" />}
          sublabel="Lo que sale del banco en FechaPago"
          tone="success"
        />
        <KpiCard
          label="Retenciones (ISR/IMSS Empleado)"
          value={fmtCurrency(kpis.totalWithholdings)}
          icon={<Download className="h-4 w-4" />}
          sublabel="Se enteran al SAT/IMSS después"
          tone="warning"
        />
        <KpiCard
          label="Aportaciones Patronales"
          value={fmtCurrency(kpis.totalEmployerTaxes)}
          icon={<Users className="h-4 w-4" />}
          sublabel={`${kpis.payingCompanies} cía(s) · ${kpis.periodCount} periodo(s)`}
        />
      </section>

      {/* Periodos */}
      <section
        className="rounded-lg border"
        style={{ borderColor: 'var(--gray-200)', background: 'var(--surface)' }}
      >
        <header
          className="border-b px-4 py-3"
          style={{ borderColor: 'var(--gray-200)' }}
        >
          <h3 className="text-sm font-semibold" style={{ color: 'var(--gray-900)' }}>
            Periodos de pago
          </h3>
          <p className="text-xs" style={{ color: 'var(--gray-500)' }}>
            Agrupado por (compañía, fecha de pago, periodo). El cash neto es lo que
            sale del banco al empleado el día de pago.
          </p>
        </header>
        {!hasData ? (
          <div className="p-6">
            <EmptyState
              icon={<Calendar className="h-6 w-6" />}
              title="Sin datos para estos filtros"
              description='Ajusta los filtros o presiona "Refrescar TRESS" para cargar la información.'
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead
                className="text-[11px] uppercase tracking-wide"
                style={{ color: 'var(--gray-500)', borderBottom: '1px solid var(--gray-200)' }}
              >
                <tr>
                  <th className="px-3 py-2 text-left">Compañía</th>
                  <th className="px-3 py-2 text-left">Tipo</th>
                  <th className="px-3 py-2 text-left">Periodo</th>
                  <th className="px-3 py-2 text-left">Fecha pago</th>
                  <th className="px-3 py-2 text-right">Bruto</th>
                  <th className="px-3 py-2 text-right">Deducciones</th>
                  <th className="px-3 py-2 text-right">Retenciones</th>
                  <th className="px-3 py-2 text-right">Patronal</th>
                  <th className="px-3 py-2 text-right" style={{ color: 'var(--success)' }}>
                    Pago neto
                  </th>
                </tr>
              </thead>
              <tbody>
                {periods.map((p) => (
                  <tr
                    key={`${p.cia}|${p.paymentDate}|${p.payrollType}|${p.payrollPeriod}`}
                    style={{ borderBottom: '1px solid var(--gray-100)' }}
                  >
                    <td className="px-3 py-2">
                      <div className="font-medium" style={{ color: 'var(--gray-900)' }}>
                        {p.empresaNomina || p.cia}
                      </div>
                      <div className="text-xs" style={{ color: 'var(--gray-500)' }}>
                        {p.cia}
                      </div>
                    </td>
                    <td className="px-3 py-2">{p.payrollType}</td>
                    <td className="px-3 py-2">{p.payrollPeriod}</td>
                    <td className="px-3 py-2">{p.paymentDate}</td>
                    <td className="px-3 py-2 text-right">{fmtCompact(p.grossEarnings)}</td>
                    <td className="px-3 py-2 text-right">{fmtCompact(p.netDeductions)}</td>
                    <td className="px-3 py-2 text-right">{fmtCompact(p.withholdings)}</td>
                    <td className="px-3 py-2 text-right">{fmtCompact(p.employerTaxes)}</td>
                    <td
                      className="px-3 py-2 text-right font-semibold"
                      style={{ color: 'var(--success)' }}
                    >
                      {fmtCompact(p.netCashOnPaymentDate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Top conceptos */}
      {hasData && (
        <section
          className="rounded-lg border"
          style={{ borderColor: 'var(--gray-200)', background: 'var(--surface)' }}
        >
          <header
            className="border-b px-4 py-3"
            style={{ borderColor: 'var(--gray-200)' }}
          >
            <h3 className="text-sm font-semibold" style={{ color: 'var(--gray-900)' }}>
              Top conceptos (por monto)
            </h3>
            <p className="text-xs" style={{ color: 'var(--gray-500)' }}>
              Los 12 conceptos con mayor monto absoluto en el filtro actual.
            </p>
          </header>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead
                className="text-[11px] uppercase tracking-wide"
                style={{ color: 'var(--gray-500)', borderBottom: '1px solid var(--gray-200)' }}
              >
                <tr>
                  <th className="px-3 py-2 text-left">Concepto</th>
                  <th className="px-3 py-2 text-left">Tipo</th>
                  <th className="px-3 py-2 text-left">Tratamiento cash</th>
                  <th className="px-3 py-2 text-right">Ocurrencias</th>
                  <th className="px-3 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {topConcepts.map((c) => (
                  <tr
                    key={`${c.conceptId}|${c.conceptName}`}
                    style={{ borderBottom: '1px solid var(--gray-100)' }}
                  >
                    <td className="px-3 py-2">
                      <div className="font-medium" style={{ color: 'var(--gray-900)' }}>
                        {c.conceptName}
                      </div>
                      <div className="text-xs" style={{ color: 'var(--gray-500)' }}>
                        #{c.conceptId}
                      </div>
                    </td>
                    <td className="px-3 py-2">{c.conceptType}</td>
                    <td className="px-3 py-2">
                      <span
                        className="rounded-md px-2 py-0.5 text-xs"
                        style={{
                          background: 'var(--gray-100)',
                          color: 'var(--gray-700)',
                        }}
                      >
                        {c.cashTreatment}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">{c.occurrences}</td>
                    <td className="px-3 py-2 text-right font-medium">
                      {fmtCurrency(c.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
