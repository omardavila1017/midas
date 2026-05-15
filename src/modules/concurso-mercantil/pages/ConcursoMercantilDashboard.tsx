import { useMemo, useState } from 'react';
import { Scale, AlertTriangle, Users, Building2, Search } from 'lucide-react';
import type { CXPRecord } from '../../../domain/persistence';
import type { Company } from '../../../services/jde';
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

interface Props {
  cxpRecords: CXPRecord[];
  companies: Company[];
  selectedCia: string;
}

export default function ConcursoMercantilDashboard({ cxpRecords, companies, selectedCia }: Props) {
  const [search, setSearch] = useState('');

  const ciaName = useMemo(() => {
    const map = new Map(companies.map((c) => [c.cia, c.nombre]));
    return (cia: string) => map.get(cia) ?? cia;
  }, [companies]);

  const concursoRecords = useMemo(() => {
    const scoped = selectedCia === 'all'
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

  const byProvider = useMemo(() => aggregateConcursoByProvider(concursoRecords), [concursoRecords]);
  const byCia = useMemo(() => aggregateConcursoByCia(concursoRecords), [concursoRecords]);
  const byYear = useMemo(() => aggregateConcursoByYear(concursoRecords), [concursoRecords]);

  const filteredProviders = useMemo(() => {
    const q = search.trim().toUpperCase();
    if (!q) return byProvider;
    return byProvider.filter(
      (p) => p.nombre.toUpperCase().includes(q) || p.noProveedor.toUpperCase().includes(q),
    );
  }, [byProvider, search]);

  if (concursoRecords.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader
          meta="Operación"
          title="Concurso Mercantil"
          subtitle={`Saldos con fecha de factura ≤ ${CONCURSO_MERCANTIL_CUTOFF}. No se reflejan en CXP ni en la proyección.`}
        />
        <EmptyState
          icon={<Scale className="w-5 h-5" />}
          title="Sin saldos en Concurso Mercantil"
          description={`No se encontraron facturas con antigüedad anterior o igual a ${CONCURSO_MERCANTIL_CUTOFF} para la compañía seleccionada.`}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        meta="Operación"
        title="Concurso Mercantil"
        subtitle={`Saldos con fecha de factura ≤ ${CONCURSO_MERCANTIL_CUTOFF}. Deuda histórica congelada — excluida de CXP y proyección.`}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="Deuda total pendiente"
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
              ? `Antigüedad ${totals.oldest} → ${totals.newest}`
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
          sublabel="Cías con saldo en concurso"
        />
      </div>

      <section
        className="rounded-lg border bg-white p-4"
        style={{ borderColor: 'var(--gray-200)' }}
      >
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Deuda por año de factura</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
                <th className="py-2 pr-3 font-medium">Año</th>
                <th className="py-2 pr-3 font-medium text-right">Facturas</th>
                <th className="py-2 pr-3 font-medium text-right">Monto</th>
                <th className="py-2 pr-3 font-medium text-right">% del total</th>
              </tr>
            </thead>
            <tbody>
              {byYear.map((y) => (
                <tr key={y.year} className="border-b border-gray-100">
                  <td className="py-2 pr-3 font-medium">{y.year}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{y.count}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{fmtCurrency(y.total)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-gray-500">
                    {totals.totalPendiente > 0
                      ? `${((y.total / totals.totalPendiente) * 100).toFixed(1)}%`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section
        className="rounded-lg border bg-white p-4"
        style={{ borderColor: 'var(--gray-200)' }}
      >
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Deuda por compañía</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
                <th className="py-2 pr-3 font-medium">Compañía</th>
                <th className="py-2 pr-3 font-medium text-right">Proveedores</th>
                <th className="py-2 pr-3 font-medium text-right">Facturas</th>
                <th className="py-2 pr-3 font-medium text-right">Monto</th>
              </tr>
            </thead>
            <tbody>
              {byCia.map((c) => (
                <tr key={c.cia} className="border-b border-gray-100">
                  <td className="py-2 pr-3">
                    <div className="font-medium">{c.cia}</div>
                    <div className="text-xs text-gray-500 truncate max-w-[280px]">{ciaName(c.cia)}</div>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{c.providers}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{c.count}</td>
                  <td className="py-2 pr-3 text-right tabular-nums font-medium">{fmtCurrency(c.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section
        className="rounded-lg border bg-white p-4"
        style={{ borderColor: 'var(--gray-200)' }}
      >
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <h2 className="text-sm font-semibold text-gray-900">Deuda por proveedor</h2>
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
        </div>
        <div className="overflow-x-auto">
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
                    <div className="font-medium truncate max-w-[320px]">{p.nombre || '—'}</div>
                    {p.noProveedor && (
                      <div className="text-xs text-gray-500">#{p.noProveedor}</div>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-xs text-gray-600">{p.cias.join(', ') || '—'}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{p.count}</td>
                  <td className="py-2 pr-3 text-xs text-gray-600 tabular-nums">{p.oldestFecha || '—'}</td>
                  <td className="py-2 pr-3 text-right tabular-nums font-medium">{fmtCurrency(p.total)}</td>
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
      </section>
    </div>
  );
}
