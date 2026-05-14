import { useMemo, useState, type ReactNode } from 'react';
import {
  Package,
  Search,
  Calendar,
  CheckCircle2,
  Clock,
  Database,
  Filter,
  X,
} from 'lucide-react';
import { type ComprasRecord } from '../services/jde';
import { fmtCompact, fmtCurrency, fmtDate } from '../formatters';
import PageHeader from './ui/PageHeader';
import ProviderBadge from './ProviderBadge';
import { buildProviderIndex } from '../domain/providerIdentity';
import type { Provider } from '../domain/types';

interface ComprasProps {
  comprasRecords: ComprasRecord[];
  comprasLoadedCias: Record<string, string>;
  selectedCia: string;
  providers: Provider[];
}

type FacturaFilter = 'all' | 'sinFacturar' | 'facturadas';
type ReceiptFilter = 'all' | 'recibidas' | 'pendienteRecepcion';

const COMPRAS_CACHE_KEY = '__all__';
const ROW_CAP = 500;

interface ChipStyle {
  bg: string;
  border: string;
  text: string;
  dot: string;
}

const STATUS_FACTURADA: ChipStyle = {
  bg: 'var(--success-muted)',
  border: 'oklch(88% 0.08 145)',
  text: 'var(--success)',
  dot: 'var(--success)',
};
const STATUS_POR_PAGAR: ChipStyle = {
  bg: 'var(--warning-muted)',
  border: 'oklch(88% 0.08 80)',
  text: 'var(--warning)',
  dot: 'var(--warning)',
};
const STATUS_POR_RECIBIR: ChipStyle = {
  bg: 'var(--info-muted)',
  border: 'var(--gray-200)',
  text: 'var(--info)',
  dot: 'var(--info)',
};

export default function Compras({
  comprasRecords,
  comprasLoadedCias,
  selectedCia,
  providers,
}: ComprasProps) {
  const [search, setSearch] = useState('');
  const [facturaFilter, setFacturaFilter] = useState<FacturaFilter>('all');
  const [receiptFilter, setReceiptFilter] = useState<ReceiptFilter>('all');

  const providerIndex = useMemo(() => buildProviderIndex(providers), [providers]);

  const lastLoadedAt = comprasLoadedCias[COMPRAS_CACHE_KEY];
  const filtersActive = search.trim() !== '' || facturaFilter !== 'all' || receiptFilter !== 'all';

  const filteredRecords = useMemo(() => {
    const q = search.trim().toUpperCase();
    return comprasRecords.filter((r) => {
      if (r.cancelada) return false;
      if (selectedCia !== 'all' && r.cia !== selectedCia) return false;
      if (facturaFilter === 'sinFacturar' && r.facturada) return false;
      if (facturaFilter === 'facturadas' && !r.facturada) return false;
      if (receiptFilter === 'recibidas' && !r.fechaRecepcion) return false;
      if (receiptFilter === 'pendienteRecepcion' && r.fechaRecepcion) return false;
      if (q) {
        const hay =
          r.nombreProveedor.toUpperCase().includes(q) ||
          r.noOrden.toUpperCase().includes(q) ||
          r.descProducto.toUpperCase().includes(q) ||
          r.descCategoria.toUpperCase().includes(q) ||
          r.descFamilia.toUpperCase().includes(q) ||
          r.noFactura.toUpperCase().includes(q);
        if (!hay) return false;
      }
      return true;
    });
  }, [comprasRecords, search, facturaFilter, receiptFilter, selectedCia]);

  const kpis = useMemo(() => {
    let totalAmount = 0;
    let pendientePago = 0;
    let pendienteRecepcion = 0;
    let yaFacturadas = 0;
    for (const r of filteredRecords) {
      totalAmount += r.importeTotal;
      if (r.facturada) {
        yaFacturadas += r.importeTotal;
      } else if (!r.fechaRecepcion) {
        pendienteRecepcion += r.importeTotal;
      } else {
        pendientePago += r.importeTotal;
      }
    }
    return { totalAmount, pendientePago, pendienteRecepcion, yaFacturadas };
  }, [filteredRecords]);

  const byMonth = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of filteredRecords) {
      if (r.facturada || !r.fechaPagoProyectada) continue;
      const ym = r.fechaPagoProyectada.slice(0, 7);
      map.set(ym, (map.get(ym) ?? 0) + r.importeTotal);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredRecords]);

  const clearFilters = () => {
    setSearch('');
    setFacturaFilter('all');
    setReceiptFilter('all');
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Órdenes de Compras" />

      {/* ─── Trust signal: last sync ───────────────────────────────────── */}
      {lastLoadedAt && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--gray-500)]">
          <div className="inline-flex items-center gap-2 bg-white border border-[var(--gray-200)] rounded-full px-3 py-1 shadow-sm">
            <Database className="w-3 h-3 text-[var(--gray-400)]" />
            <span>
              Última sync{' '}
              <span className="text-[var(--gray-950)] font-medium">{fmtDate(lastLoadedAt)}</span>
            </span>
            <span className="text-[var(--gray-300)]">·</span>
            <span className="tabular-nums">
              {comprasRecords.length.toLocaleString()} OCs
            </span>
          </div>
        </div>
      )}

      {/* ─── KPI cards ─────────────────────────────────────────────────── */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          icon={Package}
          label="OCs activas"
          value={fmtCurrency(kpis.totalAmount)}
          sub={`${filteredRecords.length.toLocaleString()} órdenes`}
          tone="neutral"
        />
        <KpiCard
          icon={Clock}
          label="Por pagar (proyectado)"
          value={fmtCurrency(kpis.pendientePago)}
          sub="Recibidas, sin factura aún"
          tone="warning"
        />
        <KpiCard
          icon={Calendar}
          label="Pendiente recepción"
          value={fmtCurrency(kpis.pendienteRecepcion)}
          sub="Sin fecha cierta de pago"
          tone="info"
        />
        <KpiCard
          icon={CheckCircle2}
          label="Ya facturadas"
          value={fmtCurrency(kpis.yaFacturadas)}
          sub="CXP / Facturas las cubre"
          tone="success"
        />
      </section>

      {/* ─── Monthly outflow strip ─────────────────────────────────────── */}
      {byMonth.length > 0 && (
        <section className="animate-card-in">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] mb-2 text-[var(--gray-500)]">
            Egreso proyectado por mes (sin facturar)
          </h2>
          <div className="flex gap-2 flex-wrap">
            {byMonth.map(([ym, amount]) => (
              <div
                key={ym}
                className="bg-white border border-[var(--gray-200)] rounded-[var(--radius-md)] px-3 py-1.5"
              >
                <div className="font-mono text-[10px] text-[var(--gray-400)]">{ym}</div>
                <div className="text-[13px] font-bold tabular-nums text-[var(--gray-950)]">
                  {fmtCompact(amount)}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ─── Toolbar: search + filters ─────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--gray-400)]" />
            <input
              type="text"
              placeholder="Buscar proveedor, OC, producto, factura…"
              className="input pl-9 w-full"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className="input max-w-[170px]"
            value={facturaFilter}
            onChange={(e) => setFacturaFilter(e.target.value as FacturaFilter)}
            title="Filtrar por estado de factura"
          >
            <option value="all">Todas (facturación)</option>
            <option value="sinFacturar">Sin facturar</option>
            <option value="facturadas">Ya facturadas</option>
          </select>
          <select
            className="input max-w-[180px]"
            value={receiptFilter}
            onChange={(e) => setReceiptFilter(e.target.value as ReceiptFilter)}
            title="Filtrar por estado de recepción"
          >
            <option value="all">Todas (recepción)</option>
            <option value="recibidas">Recibidas</option>
            <option value="pendienteRecepcion">Pendiente recepción</option>
          </select>
          {filtersActive && (
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex items-center gap-1 px-3 h-9 rounded-[var(--radius-md)] text-[12px] font-medium text-[var(--gray-500)] hover:text-[var(--gray-950)] hover:bg-[var(--gray-50)] hover-press"
            >
              <X className="w-3.5 h-3.5" /> Limpiar
            </button>
          )}
          <div className="ml-auto text-[12px] text-[var(--gray-400)] tabular-nums">
            {filteredRecords.length === comprasRecords.length
              ? `${comprasRecords.length.toLocaleString()} total`
              : `${filteredRecords.length.toLocaleString()} de ${comprasRecords.length.toLocaleString()}`}
          </div>
        </div>

        {/* ─── Table ──────────────────────────────────────────────────── */}
        <div className="bg-white border border-[var(--gray-200)] rounded-[var(--radius)] overflow-hidden animate-card-in">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-[var(--surface-alt)] text-[var(--gray-400)] text-left text-[11px] uppercase tracking-wide sticky top-0 z-10">
                <tr>
                  <Th className="pl-5">Cía</Th>
                  <Th>Proveedor</Th>
                  <Th>OC</Th>
                  <Th align="right">Importe</Th>
                  <Th>Categoría</Th>
                  <Th>Recepción</Th>
                  <Th align="right">D. créd.</Th>
                  <Th>Pago proy.</Th>
                  <Th>Estado</Th>
                </tr>
              </thead>
              <tbody>
                {filteredRecords.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="text-center text-[var(--gray-400)] py-14">
                      <div className="flex flex-col items-center gap-2">
                        {comprasRecords.length === 0 ? (
                          <>
                            <Package className="w-5 h-5 text-[var(--gray-300)]" />
                            <div className="text-[13px]">Sin OCs cargadas.</div>
                          </>
                        ) : (
                          <>
                            <Filter className="w-5 h-5 text-[var(--gray-300)]" />
                            <div className="text-[13px]">Sin coincidencias con los filtros.</div>
                            {filtersActive && (
                              <button
                                onClick={clearFilters}
                                className="text-[12px] text-[var(--primary)] hover:underline"
                              >
                                Limpiar filtros
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredRecords.slice(0, ROW_CAP).map((r, idx) => (
                    <tr
                      key={`${r.cia}-${r.noOrden}-${r.lineaOrden}`}
                      className={`group border-t border-[var(--gray-200)]/40 hover-row hover:bg-[var(--primary-muted)]/30 ${
                        idx % 2 === 1 ? 'bg-[var(--gray-50)]/40' : ''
                      }`}
                    >
                      <Td className="pl-5">
                        <span className="font-mono text-[11px] text-[var(--gray-500)]">{r.cia}</span>
                      </Td>
                      <Td>
                        <div
                          className="font-medium text-[var(--gray-950)] truncate max-w-[220px]"
                          title={r.nombreProveedor}
                        >
                          {r.nombreProveedor}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <ProviderBadge
                            index={providerIndex}
                            jdeCode={r.noProveedor}
                            name={r.nombreProveedor}
                          />
                          {r.noFactura && (
                            <span className="text-[10px] text-[var(--gray-400)] font-mono">
                              Fac. {r.noFactura}
                            </span>
                          )}
                        </div>
                      </Td>
                      <Td>
                        <span className="font-mono text-[11px] text-[var(--gray-700)]">{r.noOrden}</span>
                      </Td>
                      <Td align="right">
                        <span className="tabular-nums font-medium text-[var(--gray-950)]">
                          {fmtCurrency(r.importeTotal)}
                        </span>
                      </Td>
                      <Td>
                        <span
                          className="inline-block max-w-[160px] truncate text-[var(--gray-700)] text-[12px]"
                          title={r.descCategoria || r.descFamilia}
                        >
                          {r.descCategoria || r.descFamilia || (
                            <span className="text-[var(--gray-300)]">—</span>
                          )}
                        </span>
                      </Td>
                      <Td>
                        {r.fechaRecepcion ? (
                          <span className="text-[12px] tabular-nums text-[var(--gray-700)]">
                            {r.fechaRecepcion}
                          </span>
                        ) : (
                          <span className="text-[12px] text-[var(--gray-300)]">Pendiente</span>
                        )}
                      </Td>
                      <Td align="right">
                        <span className="tabular-nums text-[var(--gray-700)]">{r.diasCredito}</span>
                      </Td>
                      <Td>
                        {r.fechaPagoProyectada ? (
                          <span className="text-[12px] tabular-nums text-[var(--gray-950)]">
                            {r.fechaPagoProyectada}
                          </span>
                        ) : (
                          <span className="text-[12px] text-[var(--gray-300)]">—</span>
                        )}
                      </Td>
                      <Td>
                        {r.facturada ? (
                          <StatusChip style={STATUS_FACTURADA} icon={CheckCircle2}>
                            Facturada
                          </StatusChip>
                        ) : r.fechaRecepcion ? (
                          <StatusChip style={STATUS_POR_PAGAR} icon={Clock}>
                            Por pagar
                          </StatusChip>
                        ) : (
                          <StatusChip style={STATUS_POR_RECIBIR} icon={Calendar}>
                            Por recibir
                          </StatusChip>
                        )}
                      </Td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {filteredRecords.length > ROW_CAP && (
            <div className="px-4 py-2 text-[11px] text-[var(--gray-500)] bg-[var(--surface-alt)] border-t border-[var(--gray-200)]">
              Mostrando <span className="tabular-nums font-medium text-[var(--gray-950)]">{ROW_CAP}</span>{' '}
              de{' '}
              <span className="tabular-nums font-medium text-[var(--gray-950)]">
                {filteredRecords.length.toLocaleString()}
              </span>{' '}
              registros. Refina los filtros para ver más.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Helpers                                                                  */
/* ──────────────────────────────────────────────────────────────────────── */

interface KpiCardProps {
  icon: typeof Package;
  label: string;
  value: string;
  sub?: string;
  tone: 'neutral' | 'warning' | 'info' | 'success';
}

function KpiCard({ icon: Icon, label, value, sub, tone }: KpiCardProps) {
  const toneColor =
    tone === 'warning' ? 'var(--warning)' :
    tone === 'info' ? 'var(--info)' :
    tone === 'success' ? 'var(--success)' :
    'var(--gray-700)';
  return (
    <div className="bg-white border border-[var(--gray-200)] rounded-[var(--radius-lg)] p-4 shadow-sm animate-card-in">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--gray-400)]">
          {label}
        </p>
        <div
          className="w-7 h-7 rounded-[var(--radius-md)] flex items-center justify-center"
          style={{ backgroundColor: `color-mix(in oklch, ${toneColor} 12%, transparent)` }}
        >
          <Icon className="w-3.5 h-3.5" style={{ color: toneColor }} />
        </div>
      </div>
      <p className="text-[22px] font-bold tabular-nums tracking-tight text-[var(--gray-950)] leading-none">
        {value}
      </p>
      {sub && <p className="text-[11px] text-[var(--gray-400)] mt-1 truncate" title={sub}>{sub}</p>}
    </div>
  );
}

function Th({
  children,
  align = 'left',
  className = '',
}: {
  children?: ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
}) {
  const alignCls = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
  return <th className={`px-2.5 py-2.5 font-medium ${alignCls} ${className}`}>{children}</th>;
}

function Td({
  children,
  align = 'left',
  className = '',
}: {
  children?: ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
}) {
  const alignCls = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
  return (
    <td className={`px-2.5 py-2 text-[var(--gray-950)] align-middle ${alignCls} ${className}`}>
      {children}
    </td>
  );
}

function StatusChip({
  children,
  style,
  icon: Icon,
}: {
  children: ReactNode;
  style: ChipStyle;
  icon: typeof CheckCircle2;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-medium"
      style={{ backgroundColor: style.bg, borderColor: style.border, color: style.text }}
    >
      <Icon className="w-3 h-3" />
      {children}
    </span>
  );
}
