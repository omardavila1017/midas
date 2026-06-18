import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Database, Download, FileWarning, PackageCheck, Search, X } from 'lucide-react';
import { type ComprasRecord } from '../services/jde';
import { fmtCompact, fmtCurrency, fmtDate, todayISO } from '../formatters';
import PageHeader from './ui/PageHeader';
import ProviderBadge from './ProviderBadge';
import { buildProviderIndex } from '../domain/providerIdentity';
import type { Provider } from '../domain/types';
import {
  buildPasivoAging,
  buildPasivoPorDistribuir,
  pasivoToCsv,
  pasivoTotalMxn,
  type PasivoItem,
} from '../domain/pasivoPorDistribuir';

interface PasivoDistribuirProps {
  comprasRecords: ComprasRecord[];
  comprasLoadedCias: Record<string, string>;
  selectedCia: string;
  providers: Provider[];
}

const COMPRAS_CACHE_KEY = '__all__';
const PAGE_SIZE = 200;
const STALE_DAYS = 90;
type PasivoSort = 'antiguedad' | 'importe';

export default function PasivoDistribuir({
  comprasRecords,
  comprasLoadedCias,
  selectedCia,
  providers,
}: PasivoDistribuirProps) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<PasivoSort>('antiguedad');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const asOf = useMemo(() => todayISO(), []);
  const providerIndex = useMemo(() => buildProviderIndex(providers), [providers]);
  const lastLoadedAt = comprasLoadedCias[COMPRAS_CACHE_KEY];

  const items = useMemo(() => {
    const scoped = selectedCia === 'all'
      ? comprasRecords
      : comprasRecords.filter((r) => r.cia === selectedCia);
    return buildPasivoPorDistribuir(scoped, asOf);
  }, [comprasRecords, selectedCia, asOf]);

  const aging = useMemo(() => buildPasivoAging(items), [items]);
  const total = useMemo(() => pasivoTotalMxn(items), [items]);
  const staleTotal = useMemo(
    () => items.reduce((s, i) => s + ((i.antiguedadDias ?? 0) > STALE_DAYS ? i.importeMxn : 0), 0),
    [items],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    const rows = q
      ? items.filter((i) =>
          i.nombreProveedor.toUpperCase().includes(q) ||
          i.noOrden.toUpperCase().includes(q) ||
          i.noProveedor.toUpperCase().includes(q) ||
          i.categoria.toUpperCase().includes(q))
      : items;
    return sort === 'importe'
      ? [...rows].sort((a, b) => b.importeMxn - a.importeMxn)
      : rows; // ya viene por antigüedad desc del builder
  }, [items, search, sort]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filtered]);

  const filtersActive = search.trim() !== '' || sort !== 'antiguedad';

  const handleExportCsv = () => {
    if (filtered.length === 0) return;
    const csv = pasivoToCsv(filtered);
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const scope = selectedCia === 'all' ? '' : `-${selectedCia}`;
    a.download = `pasivo-distribuir-${asOf}${scope}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Pasivo por Distribuir" />

      <p className="text-[12px] text-[var(--gray-500)] max-w-3xl">
        Órdenes de compra con material o servicio <b>ya recibido</b> pero <b>sin factura</b> todavía.
        El proveedor entregó, pero como aún no manda su factura el monto no está en cuentas por pagar
        ni en órdenes por recibir — es un gasto futuro latente. Aquí lo ves con importe y antigüedad
        para decidir qué darle seguimiento.
      </p>

      {lastLoadedAt && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--gray-500)]">
          <div className="inline-flex items-center gap-2 bg-white border border-[var(--gray-200)] rounded-full px-3 py-1 shadow-sm">
            <Database className="w-3 h-3 text-[var(--gray-400)]" />
            <span>Última sync <span className="text-[var(--gray-950)] font-medium">{fmtDate(lastLoadedAt)}</span></span>
            <span className="text-[var(--gray-300)]">·</span>
            <span className="tabular-nums">{items.length.toLocaleString()} OCs en pasivo</span>
          </div>
        </div>
      )}

      {/* ─── KPIs ─────────────────────────────────────────────────────── */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Total pasivo por distribuir" value={fmtCurrency(total)} sub={`${items.length.toLocaleString()} OCs recibidas sin factura`} tone="warning" />
        <KpiCard label="+90 días" value={fmtCurrency(staleTotal)} sub="Más viejo que el plazo típico" tone="danger" />
        {aging.slice(0, 2).map((b) => (
          <KpiCard key={b.label} label={b.label} value={fmtCurrency(b.total)} sub={`${b.count} OCs`} tone="neutral" />
        ))}
      </section>

      {/* ─── Aging strip ──────────────────────────────────────────────── */}
      {items.length > 0 && (
        <section>
          <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] mb-2 text-[var(--gray-500)]">
            Antigüedad del pasivo (desde la recepción)
          </h2>
          <div className="flex gap-2 flex-wrap">
            {aging.map((b) => (
              <div
                key={b.label}
                className="bg-white border rounded-[var(--radius-md)] px-3 py-1.5"
                style={{ borderColor: b.minDays >= 91 ? 'oklch(80% 0.12 25)' : 'var(--gray-200)' }}
              >
                <div className="text-[10px] text-[var(--gray-400)]">{b.label}</div>
                <div className="text-[13px] font-bold tabular-nums text-[var(--gray-950)]">{fmtCompact(b.total)}</div>
                <div className="text-[10px] tabular-nums" style={{ color: b.minDays >= 91 ? 'var(--danger)' : 'var(--gray-400)' }}>
                  {b.count} OCs
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ─── Toolbar ──────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--gray-400)]" />
            <input
              type="text"
              placeholder="Buscar proveedor, OC, categoría…"
              className="input pl-9 w-full"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className="input max-w-[200px]"
            value={sort}
            onChange={(e) => setSort(e.target.value as PasivoSort)}
            title="Ordenar"
          >
            <option value="antiguedad">Más antiguas primero</option>
            <option value="importe">Importe mayor primero</option>
          </select>
          {filtersActive && (
            <button
              type="button"
              onClick={() => { setSearch(''); setSort('antiguedad'); }}
              className="inline-flex items-center gap-1 px-3 h-9 rounded-[var(--radius-md)] text-[12px] font-medium text-[var(--gray-500)] hover:text-[var(--gray-950)] hover:bg-[var(--gray-50)] hover-press"
            >
              <X className="w-3.5 h-3.5" /> Limpiar
            </button>
          )}
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={filtered.length === 0}
            className="inline-flex items-center gap-1 px-3 h-9 rounded-[var(--radius-md)] text-[12px] font-medium text-[var(--gray-500)] hover:text-[var(--gray-950)] hover:bg-[var(--gray-50)] hover-press disabled:opacity-40"
            title="Exportar a CSV"
          >
            <Download className="w-3.5 h-3.5" /> CSV
          </button>
          <div className="ml-auto text-[12px] text-[var(--gray-400)] tabular-nums">
            {filtered.length.toLocaleString()} OCs
          </div>
        </div>

        <div className="bg-white border border-[var(--gray-200)] rounded-[var(--radius)] overflow-hidden animate-card-in">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-[var(--surface-alt)] text-[var(--gray-400)] text-left text-[11px] uppercase tracking-wide sticky top-0 z-10">
                <tr>
                  <Th className="pl-5">Cía</Th>
                  <Th>Proveedor</Th>
                  <Th>OC</Th>
                  <Th align="right">Importe (MXN)</Th>
                  <Th>Recepción</Th>
                  <Th align="right">Antigüedad</Th>
                  <Th>Categoría</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center text-[var(--gray-400)] py-14">
                      <div className="flex flex-col items-center gap-2">
                        <PackageCheck className="w-5 h-5 text-[var(--gray-300)]" />
                        <div className="text-[13px]">
                          {comprasRecords.length === 0 ? 'Sin OCs cargadas.' : 'Sin pasivo por distribuir con los filtros.'}
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filtered.slice(0, visibleCount).map((item, idx) => (
                    <PasivoRow key={`${item.cia}::${item.noOrden}`} item={item} idx={idx} providerIndex={providerIndex} />
                  ))
                )}
              </tbody>
            </table>
          </div>
          {filtered.length > visibleCount && (
            <div className="px-4 py-2.5 flex items-center justify-between gap-3 text-[11px] text-[var(--gray-500)] bg-[var(--surface-alt)] border-t border-[var(--gray-200)]">
              <span>
                Mostrando <b className="tabular-nums text-[var(--gray-950)]">{Math.min(visibleCount, filtered.length).toLocaleString()}</b> de{' '}
                <b className="tabular-nums text-[var(--gray-950)]">{filtered.length.toLocaleString()}</b>
              </span>
              <button
                type="button"
                onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
                className="inline-flex items-center gap-1 px-3 h-7 rounded-[var(--radius-md)] text-[12px] font-medium border border-[var(--gray-200)] bg-white hover:bg-[var(--gray-50)] hover-press text-[var(--gray-700)]"
              >
                Cargar más
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */

function PasivoRow({
  item,
  idx,
  providerIndex,
}: {
  item: PasivoItem;
  idx: number;
  providerIndex: ReturnType<typeof buildProviderIndex>;
}) {
  const stale = (item.antiguedadDias ?? 0) > STALE_DAYS;
  return (
    <tr className={`group border-t border-[var(--gray-200)]/40 hover-row hover:bg-[var(--primary-muted)]/30 ${idx % 2 === 1 ? 'bg-[var(--gray-50)]/40' : ''}`}>
      <Td className="pl-5">
        <span className="font-mono text-[11px] text-[var(--gray-500)]">{item.cia}</span>
      </Td>
      <Td>
        <div className="font-medium text-[var(--gray-950)] truncate max-w-[240px]" title={item.nombreProveedor}>{item.nombreProveedor}</div>
        <div className="mt-0.5"><ProviderBadge index={providerIndex} jdeCode={item.noProveedor} name={item.nombreProveedor} /></div>
      </Td>
      <Td>
        <span className="font-mono text-[11px] text-[var(--gray-700)]">{item.noOrden}</span>
        <div className="text-[10px] text-[var(--gray-400)]">{item.lineCount} {item.lineCount === 1 ? 'línea' : 'líneas'}</div>
      </Td>
      <Td align="right">
        <span className="tabular-nums font-semibold text-[var(--gray-950)]">{fmtCurrency(item.importeMxn)}</span>
      </Td>
      <Td>
        {item.fechaRecepcion ? (
          <span className="text-[12px] tabular-nums text-[var(--gray-700)]">{item.fechaRecepcion}</span>
        ) : (
          <span className="text-[var(--gray-300)]">—</span>
        )}
      </Td>
      <Td align="right">
        {item.antiguedadDias !== null ? (
          <span className="inline-flex items-center gap-1 tabular-nums text-[12px]" style={{ color: stale ? 'var(--danger)' : 'var(--gray-700)' }}>
            {stale && <FileWarning className="w-3 h-3" />}
            {item.antiguedadDias} d
          </span>
        ) : (
          <span className="text-[var(--gray-300)]">—</span>
        )}
      </Td>
      <Td>
        <span className="inline-block max-w-[160px] truncate text-[var(--gray-700)] text-[12px]" title={item.categoria}>
          {item.categoria || <span className="text-[var(--gray-300)]">—</span>}
        </span>
      </Td>
    </tr>
  );
}

interface KpiCardProps {
  label: string;
  value: string;
  sub?: string;
  tone: 'neutral' | 'warning' | 'danger';
}

function KpiCard({ label, value, sub, tone }: KpiCardProps) {
  const toneColor = tone === 'warning' ? 'var(--warning)' : tone === 'danger' ? 'var(--danger)' : 'var(--gray-700)';
  return (
    <div className="bg-white border border-[var(--gray-200)] rounded-[var(--radius-lg)] p-4 shadow-sm animate-card-in">
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--gray-400)]">{label}</p>
      <p className="mt-1.5 font-mono text-[20px] font-bold tabular-nums leading-none" style={{ color: toneColor }}>{value}</p>
      {sub && <p className="mt-1.5 text-[11px] text-[var(--gray-400)] truncate" title={sub}>{sub}</p>}
    </div>
  );
}

function Th({ children, align = 'left', className = '' }: { children?: ReactNode; align?: 'left' | 'right'; className?: string }) {
  return <th className={`px-2.5 py-2.5 font-medium ${align === 'right' ? 'text-right' : 'text-left'} ${className}`}>{children}</th>;
}

function Td({ children, align = 'left', className = '' }: { children?: ReactNode; align?: 'left' | 'right'; className?: string }) {
  return <td className={`px-2.5 py-2 text-[var(--gray-950)] align-middle ${align === 'right' ? 'text-right' : 'text-left'} ${className}`}>{children}</td>;
}
