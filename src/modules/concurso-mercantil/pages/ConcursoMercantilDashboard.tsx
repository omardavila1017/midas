import { useMemo, useState } from 'react';
import {
  Scale,
  AlertTriangle,
  Users,
  Building2,
  Search,
  CalendarClock,
  Banknote,
  TrendingUp,
} from 'lucide-react';
import type { CXPRecord } from '../../../domain/persistence';
import type { Company } from '../../../services/jde';
import type { BankAccountStatement } from '../../../services/jdeTypes';
import { fmtCompact, fmtCurrency } from '../../../formatters';
import PageHeader from '../../../components/ui/PageHeader';
import KpiCard from '../../../components/ui/KpiCard';
import EmptyState from '../../shared-finance/components/EmptyState';
import {
  CONCURSO_MERCANTIL_CUTOFF,
  aggregateConcursoByCia,
  aggregateConcursoByProvider,
  aggregateConcursoByYear,
  normalizeFechaFactura,
  onlyConcursoMercantil,
} from '../../../domain/concursoMercantil';
import { buildConvenioSchedule } from '../../../domain/convenioConcursal';
import {
  reconcileConvenioPayments,
  type ConvenioMatchStatus,
} from '../../../domain/convenioReconciliationEngine';

interface Props {
  cxpRecords: CXPRecord[];
  companies: Company[];
  selectedCia: string;
  bankStatements: BankAccountStatement[];
}

const STATUS_LABEL: Record<ConvenioMatchStatus, string> = {
  matched: 'Empatado',
  partial: 'Parcial',
  unmatched: 'No empatado',
  'sin-datos-banco': 'Sin datos banco',
};

function statusClasses(status: ConvenioMatchStatus): string {
  switch (status) {
    case 'matched':
      return 'bg-green-100 text-green-700';
    case 'partial':
      return 'bg-amber-100 text-amber-700';
    case 'unmatched':
      return 'bg-red-100 text-red-700';
    case 'sin-datos-banco':
      return 'bg-gray-100 text-gray-600';
  }
}

function signed(value: number): string {
  const s = fmtCurrency(Math.abs(value));
  if (value > 0) return `+${s}`;
  if (value < 0) return `-${s}`;
  return s;
}

export default function ConcursoMercantilDashboard({
  cxpRecords,
  companies,
  selectedCia,
  bankStatements,
}: Props) {
  const [search, setSearch] = useState('');

  const ciaName = useMemo(() => {
    const map = new Map(companies.map((c) => [c.cia, c.nombre]));
    return (cia: string) => map.get(cia) ?? cia;
  }, [companies]);

  // ── Convenio concursal (calendario congelado en código, nivel grupo) ──
  const schedule = useMemo(() => buildConvenioSchedule(), []);
  const recon = useMemo(
    () => reconcileConvenioPayments(bankStatements),
    [bankStatements],
  );
  const matchedPct =
    recon.summary.elapsedCount > 0
      ? (recon.summary.matchedCount / recon.summary.elapsedCount) * 100
      : 0;

  // ── Saldos congelados de CXP (deuda histórica ≤ cutoff) ──
  const concursoRecords = useMemo(() => {
    const scoped =
      selectedCia === 'all'
        ? cxpRecords
        : cxpRecords.filter((r) => r.cia === selectedCia);
    return onlyConcursoMercantil(scoped);
  }, [cxpRecords, selectedCia]);

  const totals = useMemo(() => {
    let total = 0;
    let pendiente = 0;
    let oldest = '9999-99-99';
    let newest = '0000-00-00';
    const providerSet = new Set<string>();
    const ciaSet = new Set<string>();
    for (const r of concursoRecords) {
      total += r.importeBrutoPesos || 0;
      pendiente += r.importePendientePesos || 0;
      const iso = normalizeFechaFactura(r.fechaFactura);
      if (iso && iso < oldest) oldest = iso;
      if (iso && iso > newest) newest = iso;
      if (r.noProveedor) providerSet.add(r.noProveedor);
      if (r.cia) ciaSet.add(r.cia);
    }
    return {
      totalBruto: total,
      totalPendiente: pendiente,
      count: concursoRecords.length,
      providers: providerSet.size,
      cias: ciaSet.size,
      oldest: oldest === '9999-99-99' ? '' : oldest,
      newest: newest === '0000-00-00' ? '' : newest,
    };
  }, [concursoRecords]);

  const byProvider = useMemo(
    () => aggregateConcursoByProvider(concursoRecords),
    [concursoRecords],
  );
  const byCia = useMemo(() => aggregateConcursoByCia(concursoRecords), [concursoRecords]);
  const byYear = useMemo(() => aggregateConcursoByYear(concursoRecords), [concursoRecords]);

  const filteredProviders = useMemo(() => {
    const q = search.trim().toUpperCase();
    if (!q) return byProvider;
    return byProvider.filter(
      (p) => p.nombre.toUpperCase().includes(q) || p.noProveedor.toUpperCase().includes(q),
    );
  }, [byProvider, search]);

  return (
    <div className="space-y-6">
      <PageHeader
        meta="Operación"
        title="Concurso Mercantil"
        subtitle="Convenio concursal con bancos y proveedores: calendario trimestral, empate del histórico contra banco y proyección futura en el Escenario Aprobado."
      />

      {/* ── KPIs del convenio ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="Saldo convenio"
          value={fmtCompact(schedule.totals.saldoConvenioMxn)}
          tone="danger"
          icon={<Scale className="w-4 h-4" />}
          sublabel={`Sostenible ${fmtCompact(schedule.totals.tramoSostenibleMxn)} · Contingente ${fmtCompact(schedule.totals.tramoContingenteMxn)}`}
        />
        <KpiCard
          label="Pagado (histórico)"
          value={fmtCompact(recon.summary.scheduledElapsedMxn)}
          icon={<Banknote className="w-4 h-4" />}
          sublabel={`${recon.summary.elapsedCount} trimestres · ${recon.summary.matchedCount} empatados (${matchedPct.toFixed(0)}%)`}
        />
        <KpiCard
          label="Por pagar (futuro)"
          value={fmtCompact(schedule.totals.futureTotalMxn)}
          tone="warning"
          icon={<CalendarClock className="w-4 h-4" />}
          sublabel={`${schedule.future.length} trimestres → Escenario Aprobado`}
        />
        <KpiCard
          label="Variabilidad vs banco"
          value={signed(recon.summary.varianceMxn)}
          icon={<TrendingUp className="w-4 h-4" />}
          sublabel="Δ pagado − programado (interés por recorrido)"
        />
      </div>

      {/* ── Empate histórico vs banco ── */}
      <section
        className="rounded-lg border bg-white p-4"
        style={{ borderColor: 'var(--gray-200)' }}
      >
        <div className="flex items-center justify-between gap-3 mb-1 flex-wrap">
          <h2 className="text-sm font-semibold text-gray-900">
            Empate histórico vs movimientos bancarios
          </h2>
          <div className="text-xs text-gray-500">
            {recon.summary.bankCoverage.cargoCount > 0
              ? `${recon.summary.bankCoverage.cargoCount.toLocaleString('es-MX')} cargos · cobertura ${recon.summary.bankCoverage.earliest ?? '—'} → ${recon.summary.bankCoverage.latest ?? '—'}`
              : 'Sin estados de cuenta cargados'}
          </div>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Empate por monto entre el pago trimestral programado (interés +
          capital) y los CARGOS de todas las cuentas, con tolerancia para el
          interés extra por recorrido a día hábil.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
                <th className="py-2 pr-3 font-medium">Trimestre</th>
                <th className="py-2 pr-3 font-medium">Fecha pago</th>
                <th className="py-2 pr-3 font-medium text-right">Programado</th>
                <th className="py-2 pr-3 font-medium text-right">Empatado banco</th>
                <th className="py-2 pr-3 font-medium text-right">Δ</th>
                <th className="py-2 pr-3 font-medium">Estado</th>
                <th className="py-2 pr-3 font-medium text-right">Mov.</th>
              </tr>
            </thead>
            <tbody>
              {recon.matches.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-sm text-gray-500">
                    Aún no hay trimestres vencidos del convenio.
                  </td>
                </tr>
              )}
              {recon.matches.filter((m) => m.status !== 'sin-datos-banco').map((m) => (
                <tr key={m.key} className="border-b border-gray-100">
                  <td className="py-2 pr-3 font-medium">
                    {m.month} {m.year}
                  </td>
                  <td className="py-2 pr-3 text-xs text-gray-600 tabular-nums">
                    {m.scheduledDateIso}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {fmtCurrency(m.scheduledTotalMxn)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {m.matchedAmountMxn > 0 ? fmtCurrency(m.matchedAmountMxn) : '—'}
                  </td>
                  <td
                    className={`py-2 pr-3 text-right tabular-nums ${
                      m.deltaMxn > 0
                        ? 'text-amber-600'
                        : m.deltaMxn < 0
                          ? 'text-red-600'
                          : 'text-gray-400'
                    }`}
                  >
                    {m.status === 'matched' || m.status === 'partial'
                      ? signed(m.deltaMxn)
                      : '—'}
                  </td>
                  <td className="py-2 pr-3">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${statusClasses(m.status)}`}
                    >
                      {STATUS_LABEL[m.status]}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-gray-500">
                    {m.bankMovements.length || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Pagos futuros (Escenario Aprobado) ── */}
      <section
        className="rounded-lg border bg-white p-4"
        style={{ borderColor: 'var(--gray-200)' }}
      >
        <h2 className="text-sm font-semibold text-gray-900 mb-1">
          Pagos futuros del convenio
        </h2>
        <p className="text-xs text-gray-500 mb-3">
          Inyectados automáticamente como egresos bloqueados (DEBT) en el
          Escenario Aprobado. No editables: obligación legal fija.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
                <th className="py-2 pr-3 font-medium">Trimestre</th>
                <th className="py-2 pr-3 font-medium">Fecha pago</th>
                <th className="py-2 pr-3 font-medium text-right">Interés</th>
                <th className="py-2 pr-3 font-medium text-right">Capital</th>
                <th className="py-2 pr-3 font-medium text-right">Total</th>
                <th className="py-2 pr-3 font-medium text-right">Saldo restante</th>
              </tr>
            </thead>
            <tbody>
              {schedule.future.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-sm text-gray-500">
                    El convenio está totalmente liquidado.
                  </td>
                </tr>
              )}
              {schedule.future.map((q) => (
                <tr key={q.key} className="border-b border-gray-100">
                  <td className="py-2 pr-3 font-medium">
                    {q.month} {q.year}
                  </td>
                  <td className="py-2 pr-3 text-xs text-gray-600 tabular-nums">
                    {q.scheduledDateIso}
                    {q.rolledDays > 0 && (
                      <span className="ml-1 text-amber-600">
                        (+{q.rolledDays}d)
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-gray-600">
                    {fmtCurrency(q.interesMxn)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-gray-600">
                    {fmtCurrency(q.capitalMxn)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums font-medium">
                    {fmtCurrency(q.totalMxn)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-gray-500">
                    {fmtCurrency(q.nuevoSaldoMxn)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Saldos congelados de CXP (deuda histórica anterior al convenio) ── */}
      <section
        className="rounded-lg border bg-white p-4"
        style={{ borderColor: 'var(--gray-200)' }}
      >
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">
              Saldos CXP congelados
            </h2>
            <p className="text-xs text-gray-500">
              Facturas con fecha ≤ {CONCURSO_MERCANTIL_CUTOFF}. Excluidas de
              CXP y de la proyección.
            </p>
          </div>
          {concursoRecords.length > 0 && (
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar proveedor…"
                className="pl-7 pr-3 py-1.5 text-xs rounded border border-gray-200 bg-white w-56 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          )}
        </div>

        {concursoRecords.length === 0 ? (
          <EmptyState
            icon={<Scale className="w-5 h-5" />}
            title="Sin saldos CXP en concurso"
            description={`No hay facturas con antigüedad ≤ ${CONCURSO_MERCANTIL_CUTOFF} para la compañía seleccionada.`}
          />
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              <KpiCard
                label="Deuda CXP pendiente"
                value={fmtCurrency(totals.totalPendiente)}
                tone="danger"
                icon={<Scale className="w-4 h-4" />}
                sublabel={`Bruto: ${fmtCompact(totals.totalBruto)}`}
              />
              <KpiCard
                label="Facturas"
                value={String(totals.count)}
                icon={<AlertTriangle className="w-4 h-4" />}
                sublabel={
                  totals.oldest && totals.newest
                    ? `${totals.oldest} → ${totals.newest}`
                    : undefined
                }
              />
              <KpiCard
                label="Proveedores"
                value={String(totals.providers)}
                icon={<Users className="w-4 h-4" />}
                sublabel="Acreedores afectados"
              />
              <KpiCard
                label="Compañías"
                value={String(totals.cias)}
                icon={<Building2 className="w-4 h-4" />}
                sublabel="Cías con saldo"
              />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="overflow-x-auto">
                <h3 className="text-xs font-semibold text-gray-700 mb-2 uppercase tracking-wide">
                  Por año de factura
                </h3>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
                      <th className="py-2 pr-3 font-medium">Año</th>
                      <th className="py-2 pr-3 font-medium text-right">Facturas</th>
                      <th className="py-2 pr-3 font-medium text-right">Monto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byYear.map((y) => (
                      <tr key={y.year} className="border-b border-gray-100">
                        <td className="py-2 pr-3 font-medium">{y.year}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{y.count}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {fmtCurrency(y.total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="overflow-x-auto">
                <h3 className="text-xs font-semibold text-gray-700 mb-2 uppercase tracking-wide">
                  Por compañía
                </h3>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
                      <th className="py-2 pr-3 font-medium">Cía</th>
                      <th className="py-2 pr-3 font-medium text-right">Facturas</th>
                      <th className="py-2 pr-3 font-medium text-right">Monto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byCia.map((c) => (
                      <tr key={c.cia} className="border-b border-gray-100">
                        <td className="py-2 pr-3">
                          <span className="font-medium">{c.cia}</span>
                          <span className="text-xs text-gray-500 ml-1 truncate">
                            {ciaName(c.cia)}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">{c.count}</td>
                        <td className="py-2 pr-3 text-right tabular-nums font-medium">
                          {fmtCurrency(c.total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="overflow-x-auto mt-4">
              <h3 className="text-xs font-semibold text-gray-700 mb-2 uppercase tracking-wide">
                Por proveedor
              </h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
                    <th className="py-2 pr-3 font-medium">Proveedor</th>
                    <th className="py-2 pr-3 font-medium">Compañías</th>
                    <th className="py-2 pr-3 font-medium text-right">Facturas</th>
                    <th className="py-2 pr-3 font-medium">Más antigua</th>
                    <th className="py-2 pr-3 font-medium text-right">Deuda</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProviders.map((p) => (
                    <tr key={`${p.noProveedor}::${p.nombre}`} className="border-b border-gray-100">
                      <td className="py-2 pr-3">
                        <div className="font-medium truncate max-w-[320px]">
                          {p.nombre || '—'}
                        </div>
                        {p.noProveedor && (
                          <div className="text-xs text-gray-500">#{p.noProveedor}</div>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-xs text-gray-600">
                        {p.cias.join(', ') || '—'}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{p.count}</td>
                      <td className="py-2 pr-3 text-xs text-gray-600 tabular-nums">
                        {p.oldestFecha || '—'}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums font-medium">
                        {fmtCurrency(p.total)}
                      </td>
                    </tr>
                  ))}
                  {filteredProviders.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-6 text-center text-sm text-gray-500">
                        Sin coincidencias para "{search}".
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
