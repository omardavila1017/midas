import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  Calendar,
  CheckCircle2,
  Clock,
  Database,
  Download,
  FileText,
  Filter,
  Info,
  Layers,
  List,
  Package,
  PackageCheck,
  Search,
  X,
} from 'lucide-react';
import { type ComprasRecord } from '../services/jde';
import { fmtCompact, fmtCurrency, fmtDate, fmtInt, fmtNum, todayISO } from '../formatters';
import PageHeader from './ui/PageHeader';
import ProviderBadge from './ProviderBadge';
import SourceInfo from './ui/SourceInfo';
import { sourceOf } from '../domain/sourceAttribution';
import { buildProviderIndex } from '../domain/providerIdentity';
import type { Provider } from '../domain/types';
import {
  COMPRA_ORDER_ESTADO_LABEL,
  STALE_OPEN_ORDER_DAYS,
  buildComprasByOrder,
  buildComprasDepuracionInsights,
  buildOpenSinEntradaByMonth,
  compraEstado,
  comprasImporteMxn,
  comprasOrdersToCsv,
  comprasRecordKey,
  comprasToCsv,
  daysSinceIso,
  isComprasForeignCurrency,
  isStaleSinEntrada,
  type ComprasInsight,
  type ComprasInsightSeverity,
  type ComprasOrderEstado,
  type ComprasOrderSummary,
} from '../domain/comprasInsights';

interface ComprasProps {
  comprasRecords: ComprasRecord[];
  comprasLoadedCias: Record<string, string>;
  selectedCia: string;
  providers: Provider[];
}

type FacturaFilter = 'all' | 'sinFacturar' | 'facturadas';
type ReceiptFilter = 'all' | 'recibidas' | 'pendienteRecepcion';
type CompraStatusFilter = 'active' | 'all' | 'cancelled';
type CompraDateField = 'fechaPedido' | 'fechaRecepcion' | 'fechaPagoProyectada';
type CompraSortKey = CompraDateField | 'importeTotal';
type SortDirection = 'asc' | 'desc';

interface CompraSort {
  key: CompraSortKey;
  direction: SortDirection;
}

/** Foco puntual sobre un set exacto de OCs (hallazgo de depuración o mes del strip). */
interface CompraFocus {
  id: string;
  label: string;
  keys: ReadonlySet<string>;
}

const COMPRAS_CACHE_KEY = '__all__';
const PAGE_SIZE = 200;
const DEFAULT_SORT: CompraSort = { key: 'fechaPedido', direction: 'desc' };

/** Vista de la pestaña: resumen financiero por OC (default) o detalle por línea. */
type ComprasView = 'resumen' | 'detalle';
/** Filtro de estado del resumen por OC. `backlog` = pendiente de recibir + factura. */
type OcEstadoFilter = 'backlog' | ComprasOrderEstado | 'todas';
type OcSortKey = 'importe' | 'antiguedad';

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
const STATUS_SIN_ENTRADA: ChipStyle = {
  bg: 'var(--info-muted)',
  border: 'var(--gray-200)',
  text: 'var(--info)',
  dot: 'var(--info)',
};
const STATUS_CANCELADA: ChipStyle = {
  bg: 'var(--danger-muted)',
  border: 'var(--gray-200)',
  text: 'var(--danger)',
  dot: 'var(--danger)',
};
const STATUS_CERRADA_WF: ChipStyle = {
  bg: 'var(--surface-alt)',
  border: 'var(--gray-200)',
  text: 'var(--gray-500)',
  dot: 'var(--gray-400)',
};

/** Estilo + ícono del chip de estado de la OC (vista resumen). */
const ORDER_ESTADO_CHIP: Record<ComprasOrderEstado, { style: ChipStyle; icon: typeof Clock }> = {
  pendienteRecibir: { style: STATUS_SIN_ENTRADA, icon: Calendar },
  pendienteFactura: { style: STATUS_POR_PAGAR, icon: FileText },
  facturada: { style: STATUS_FACTURADA, icon: CheckCircle2 },
  cerrada: { style: STATUS_CERRADA_WF, icon: Archive },
  cancelada: { style: STATUS_CANCELADA, icon: X },
};

const SEVERITY_ICON: Record<ComprasInsightSeverity, typeof AlertTriangle> = {
  danger: AlertTriangle,
  warning: AlertCircle,
  info: Info,
};
const SEVERITY_COLOR: Record<ComprasInsightSeverity, string> = {
  danger: 'var(--danger)',
  warning: 'var(--warning)',
  info: 'var(--info)',
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
  const [statusFilter, setStatusFilter] = useState<CompraStatusFilter>('active');
  const [dateField, setDateField] = useState<CompraDateField>('fechaPedido');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [amountMin, setAmountMin] = useState('');
  const [amountMax, setAmountMax] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [sort, setSort] = useState<CompraSort>(DEFAULT_SORT);
  const [focus, setFocus] = useState<CompraFocus | null>(null);
  // Vista financiera por OC (default) vs detalle por línea (depuración JDE).
  const [view, setView] = useState<ComprasView>('resumen');
  const [ocSearch, setOcSearch] = useState('');
  const [ocEstado, setOcEstado] = useState<OcEstadoFilter>('backlog');
  const [ocSort, setOcSort] = useState<OcSortKey>('importe');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const asOf = useMemo(() => todayISO(), []);
  const providerIndex = useMemo(() => buildProviderIndex(providers), [providers]);

  const lastLoadedAt = comprasLoadedCias[COMPRAS_CACHE_KEY];
  const filtersActive =
    search.trim() !== ''
    || facturaFilter !== 'all'
    || receiptFilter !== 'all'
    || statusFilter !== 'active'
    || dateField !== 'fechaPedido'
    || dateFrom !== ''
    || dateTo !== ''
    || amountMin !== ''
    || amountMax !== ''
    || categoryFilter !== 'all'
    || sort.key !== DEFAULT_SORT.key
    || sort.direction !== DEFAULT_SORT.direction
    || focus !== null;

  const categoriasDisponibles = useMemo(() => {
    const set = new Set<string>();
    for (const r of comprasRecords) {
      const category = r.descCategoria || r.descFamilia || r.categoria || r.familia;
      if (category) set.add(category);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [comprasRecords]);

  // Reporte de higiene de datos sobre TODO el scope de la compañía (no sobre
  // los filtros de la tabla): es el estado del dataset, no de la vista.
  const insights = useMemo(() => {
    const scoped = selectedCia === 'all'
      ? comprasRecords
      : comprasRecords.filter((r) => r.cia === selectedCia);
    return buildComprasDepuracionInsights(scoped, asOf);
  }, [comprasRecords, selectedCia, asOf]);

  const baseFiltered = useMemo(() => {
    const q = search.trim().toUpperCase();
    const min = parseAmountInput(amountMin);
    const max = parseAmountInput(amountMax);
    return comprasRecords.filter((r) => {
      if (statusFilter === 'active' && r.cancelada) return false;
      if (statusFilter === 'cancelled' && !r.cancelada) return false;
      if (selectedCia !== 'all' && r.cia !== selectedCia) return false;
      if (facturaFilter === 'sinFacturar' && r.facturada) return false;
      if (facturaFilter === 'facturadas' && !r.facturada) return false;
      if (receiptFilter === 'recibidas' && !r.fechaRecepcion) return false;
      if (receiptFilter === 'pendienteRecepcion' && r.fechaRecepcion) return false;
      if (categoryFilter !== 'all') {
        const category = r.descCategoria || r.descFamilia || r.categoria || r.familia;
        if (category !== categoryFilter) return false;
      }
      const dateValue = r[dateField] || '';
      if (dateFrom && (!dateValue || dateValue < dateFrom)) return false;
      if (dateTo && (!dateValue || dateValue > dateTo)) return false;
      const mxn = comprasImporteMxn(r);
      if (min !== undefined && mxn < min) return false;
      if (max !== undefined && mxn > max) return false;
      if (q) {
        const hay =
          r.nombreProveedor.toUpperCase().includes(q) ||
          r.noProveedor.toUpperCase().includes(q) ||
          r.noOrden.toUpperCase().includes(q) ||
          r.descProducto.toUpperCase().includes(q) ||
          r.noProducto.toUpperCase().includes(q) ||
          r.concepto.toUpperCase().includes(q) ||
          r.descCategoria.toUpperCase().includes(q) ||
          r.descFamilia.toUpperCase().includes(q) ||
          r.centroCostos.toUpperCase().includes(q) ||
          r.noFactura.toUpperCase().includes(q);
        if (!hay) return false;
      }
      return true;
    }).sort((a, b) => compareCompraRecords(a, b, sort));
  }, [
    comprasRecords,
    search,
    facturaFilter,
    receiptFilter,
    statusFilter,
    dateField,
    dateFrom,
    dateTo,
    amountMin,
    amountMax,
    categoryFilter,
    selectedCia,
    sort,
  ]);

  const filteredRecords = useMemo(() => {
    if (!focus) return baseFiltered;
    return baseFiltered.filter((r) => focus.keys.has(comprasRecordKey(r)));
  }, [baseFiltered, focus]);

  // El strip ignora el foco a propósito: enfocar un mes no debe colapsar el
  // propio strip a ese mes.
  const openByMonth = useMemo(
    () => buildOpenSinEntradaByMonth(baseFiltered, asOf),
    [baseFiltered, asOf],
  );

  // ── Vista resumen: una fila por OC (agregada). Se construye sobre el scope
  // de la compañía + el foco (no sobre los filtros por línea del detalle), para
  // que cada OC salga completa. El filtro de estado por defecto (`backlog`)
  // deja FUERA las facturadas/cerradas/canceladas: las facturadas ya viven en
  // CXP/Antigüedad de Saldos, no se reproyectan aquí (petición de finanzas).
  const orderScoped = useMemo(() => {
    let base = selectedCia === 'all'
      ? comprasRecords
      : comprasRecords.filter((r) => r.cia === selectedCia);
    if (focus) base = base.filter((r) => focus.keys.has(comprasRecordKey(r)));
    return buildComprasByOrder(base, asOf);
  }, [comprasRecords, selectedCia, focus, asOf]);

  const orderRows = useMemo(() => {
    const q = ocSearch.trim().toUpperCase();
    const rows = orderScoped.filter((o) => {
      if (ocEstado === 'backlog') {
        if (o.estado !== 'pendienteRecibir' && o.estado !== 'pendienteFactura') return false;
      } else if (ocEstado !== 'todas' && o.estado !== ocEstado) {
        return false;
      }
      if (q) {
        const hay =
          o.nombreProveedor.toUpperCase().includes(q) ||
          o.noOrden.toUpperCase().includes(q) ||
          o.noProveedor.toUpperCase().includes(q);
        if (!hay) return false;
      }
      return true;
    });
    return rows.sort((a, b) =>
      ocSort === 'antiguedad'
        ? (b.antiguedadDias ?? -1) - (a.antiguedadDias ?? -1) || b.importeTotalMxn - a.importeTotalMxn
        : b.importeTotalMxn - a.importeTotalMxn,
    );
  }, [orderScoped, ocSearch, ocEstado, ocSort]);

  const ocKpis = useMemo(() => {
    let backlogTotal = 0;
    let pendienteRecibir = 0;
    let pendienteFactura = 0;
    let facturado = 0;
    for (const o of orderRows) {
      backlogTotal += o.importeTotalMxn;
      pendienteRecibir += o.importePendienteRecibirMxn;
      pendienteFactura += o.importePendienteFacturaMxn;
      facturado += o.importeFacturadoMxn;
    }
    return { backlogTotal, pendienteRecibir, pendienteFactura, facturado };
  }, [orderRows]);

  const orderFiltersActive = ocSearch.trim() !== '' || ocEstado !== 'backlog' || ocSort !== 'importe' || focus !== null;

  // Reset de paginación cuando cambia lo que se muestra (vista, filtros, foco).
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [view, filteredRecords, orderRows]);

  const kpis = useMemo(() => {
    let totalAmount = 0;
    let pendientePago = 0;
    let sinEntrada = 0;
    let sinEntradaStale = 0;
    let yaFacturadas = 0;
    for (const r of filteredRecords) {
      const mxn = comprasImporteMxn(r);
      totalAmount += mxn;
      const estado = compraEstado(r);
      if (estado === 'facturada') {
        yaFacturadas += mxn;
      } else if (estado === 'porPagar') {
        pendientePago += mxn;
      } else if (estado === 'sinEntrada') {
        sinEntrada += mxn;
        if (isStaleSinEntrada(r, asOf)) sinEntradaStale += mxn;
      }
    }
    return { totalAmount, pendientePago, sinEntrada, sinEntradaStale, yaFacturadas };
  }, [filteredRecords, asOf]);

  const clearFilters = () => {
    setSearch('');
    setFacturaFilter('all');
    setReceiptFilter('all');
    setStatusFilter('active');
    setDateField('fechaPedido');
    setDateFrom('');
    setDateTo('');
    setAmountMin('');
    setAmountMax('');
    setCategoryFilter('all');
    setSort(DEFAULT_SORT);
    setFocus(null);
  };

  const clearOrderFilters = () => {
    setOcSearch('');
    setOcEstado('backlog');
    setOcSort('importe');
    setFocus(null);
  };

  // Enfocar = "muéstrame EXACTAMENTE estas OCs": resetea los demás filtros
  // (statusFilter a 'all' — algunos hallazgos incluyen canceladas) para que la
  // tabla muestre el set completo del hallazgo/mes.
  const toggleFocus = (id: string, label: string, keys: string[]) => {
    if (focus?.id === id) {
      setFocus(null);
      return;
    }
    setSearch('');
    setFacturaFilter('all');
    setReceiptFilter('all');
    setStatusFilter('all');
    setDateField('fechaPedido');
    setDateFrom('');
    setDateTo('');
    setAmountMin('');
    setAmountMax('');
    setCategoryFilter('all');
    // El foco viene de hallazgos/meses por LÍNEA; en la vista resumen mostramos
    // todas las OCs que tocan esas líneas (sin recortar por estado).
    setOcSearch('');
    setOcEstado('todas');
    setFocus({ id, label, keys: new Set(keys) });
  };

  const handleExportCsv = () => {
    let csv: string;
    let suffix: string;
    if (view === 'resumen') {
      if (orderRows.length === 0) return;
      csv = comprasOrdersToCsv(orderRows);
      suffix = '-resumen';
    } else {
      if (filteredRecords.length === 0) return;
      csv = comprasToCsv(filteredRecords);
      suffix = '';
    }
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const scope = selectedCia === 'all' ? '' : `-${selectedCia}`;
    const focused = focus ? `-${focus.id}` : '';
    a.download = `ocs-${asOf}${scope}${focused}${suffix}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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

      {/* ─── View toggle: resumen financiero por OC vs detalle por línea ── */}
      <div className="inline-flex rounded-[var(--radius-md)] border border-[var(--gray-200)] bg-white p-0.5 shadow-sm">
        <ViewToggleButton icon={Layers} label="Resumen por OC" active={view === 'resumen'} onClick={() => setView('resumen')} />
        <ViewToggleButton icon={List} label="Detalle por línea" active={view === 'detalle'} onClick={() => setView('detalle')} />
      </div>

      {/* ─── KPI cards ─────────────────────────────────────────────────── */}
      {view === 'resumen' ? (
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard
            icon={Package}
            label={ocEstado === 'backlog' ? 'Backlog de OCs' : 'OCs en vista'}
            value={fmtCurrency(ocKpis.backlogTotal)}
            sub={`${orderRows.length.toLocaleString()} órdenes (MXN)`}
            tone="neutral"
          />
          <KpiCard
            icon={Calendar}
            label="Pendiente de recibir"
            value={fmtCurrency(ocKpis.pendienteRecibir)}
            sub="Creadas sin entrada · gasto futuro"
            tone="info"
          />
          <KpiCard
            icon={FileText}
            label="Pasivo por distribuir"
            value={fmtCurrency(ocKpis.pendienteFactura)}
            sub="Recibido sin factura"
            tone="warning"
          />
          <KpiCard
            icon={CheckCircle2}
            label="Ya facturado"
            value={fmtCurrency(ocKpis.facturado)}
            sub="En CXP / Antigüedad de Saldos"
            tone="success"
          />
        </section>
      ) : (
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard
            icon={Package}
            label="OCs activas"
            value={fmtCurrency(kpis.totalAmount)}
            sub={`${filteredRecords.length.toLocaleString()} órdenes (MXN)`}
            tone="neutral"
          />
          <KpiCard
            icon={FileText}
            label="Pasivo por distribuir"
            value={fmtCurrency(kpis.pendientePago)}
            sub="Recibidas, sin factura aún"
            tone="warning"
          />
          <KpiCard
            icon={Calendar}
            label="Abiertas sin entrada"
            value={fmtCurrency(kpis.sinEntrada)}
            sub={
              kpis.sinEntradaStale > 0
                ? `${fmtCompact(kpis.sinEntradaStale)} con +${STALE_OPEN_ORDER_DAYS} días`
                : 'Sin fecha cierta de pago'
            }
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
      )}

      {/* ─── Monthly strip: OCs abiertas que nunca recibieron entrada ──── */}
      {openByMonth.length > 0 && (
        <section className="animate-card-in">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] mb-1 text-[var(--gray-500)]">
            OCs abiertas sin entrada por mes (fecha de pedido)
          </h2>
          <p className="text-[11px] text-[var(--gray-400)] mb-2">
            Comprometido que nunca recibió entrada de mercancía — los meses en ámbar superan{' '}
            {STALE_OPEN_ORDER_DAYS} días y son candidatos a depurar en JDE. Clic para enfocar la tabla.
          </p>
          <div className="flex gap-2 flex-wrap">
            {openByMonth.map((bucket) => {
              const focusId = `month:${bucket.ym}`;
              const isFocused = focus?.id === focusId;
              return (
                <button
                  key={bucket.ym}
                  type="button"
                  aria-pressed={isFocused}
                  onClick={() => toggleFocus(focusId, `Sin entrada · ${bucket.ym}`, bucket.keys)}
                  className="text-left bg-white border rounded-[var(--radius-md)] px-3 py-1.5 hover-press"
                  style={{
                    backgroundColor: bucket.stale ? 'var(--warning-muted)' : undefined,
                    borderColor: isFocused
                      ? 'var(--primary)'
                      : bucket.stale
                        ? 'oklch(88% 0.08 80)'
                        : 'var(--gray-200)',
                  }}
                  title={`${bucket.count} OCs sin entrada pedidas en ${bucket.ym}`}
                >
                  <div className="font-mono text-[10px] text-[var(--gray-400)]">{bucket.ym}</div>
                  <div className="text-[13px] font-bold tabular-nums text-[var(--gray-950)]">
                    {fmtCompact(bucket.totalMxn)}
                  </div>
                  <div
                    className="text-[10px] tabular-nums"
                    style={{ color: bucket.stale ? 'var(--warning)' : 'var(--gray-400)' }}
                  >
                    {bucket.count} OCs{bucket.stale ? ` · +${STALE_OPEN_ORDER_DAYS} d` : ''}
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* ─── Depuración JDE: hallazgos detectados con lógica ───────────── */}
      {insights.length > 0 && (
        <section className="animate-card-in">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] mb-1 text-[var(--gray-500)]">
            Depuración JDE
          </h2>
          <p className="text-[11px] text-[var(--gray-400)] mb-2">
            Registros detectados con lógica sobre los datos del API — candidatos a corregir o cerrar
            en JDE. Clic para enfocar la tabla; exporta el CSV para entregar la lista.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-2">
            {insights.map((insight) => (
              <InsightCard
                key={insight.id}
                insight={insight}
                active={focus?.id === insight.id}
                onClick={() => toggleFocus(insight.id, insight.label, insight.keys)}
              />
            ))}
          </div>
        </section>
      )}

      {/* ─── Vista RESUMEN: una fila por OC (financiera) ───────────────── */}
      {view === 'resumen' && (
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--gray-400)]" />
            <input
              type="text"
              placeholder="Buscar proveedor u OC…"
              className="input pl-9 w-full"
              value={ocSearch}
              onChange={(e) => setOcSearch(e.target.value)}
            />
          </div>
          <select
            className="input max-w-[200px]"
            value={ocEstado}
            onChange={(e) => setOcEstado(e.target.value as OcEstadoFilter)}
            title="Filtrar por estado de la OC"
          >
            <option value="backlog">Backlog (pendiente)</option>
            <option value="pendienteRecibir">Pendiente de recibir</option>
            <option value="pendienteFactura">Pasivo por distribuir</option>
            <option value="facturada">Facturadas</option>
            <option value="cerrada">Cerradas en JDE</option>
            <option value="cancelada">Canceladas</option>
            <option value="todas">Todas</option>
          </select>
          <select
            className="input max-w-[185px]"
            value={ocSort}
            onChange={(e) => setOcSort(e.target.value as OcSortKey)}
            title="Ordenar OCs"
          >
            <option value="importe">Importe mayor primero</option>
            <option value="antiguedad">Más antiguas primero</option>
          </select>
          {focus && (
            <button
              type="button"
              onClick={() => setFocus(null)}
              className="inline-flex items-center gap-1 px-3 h-9 rounded-full text-[12px] font-medium border hover-press"
              style={{ backgroundColor: 'var(--primary-muted)', borderColor: 'var(--primary)', color: 'var(--primary)' }}
              title="Quitar el foco"
            >
              <Filter className="w-3.5 h-3.5" />
              {focus.label}
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          {orderFiltersActive && (
            <button
              type="button"
              onClick={clearOrderFilters}
              className="inline-flex items-center gap-1 px-3 h-9 rounded-[var(--radius-md)] text-[12px] font-medium text-[var(--gray-500)] hover:text-[var(--gray-950)] hover:bg-[var(--gray-50)] hover-press"
            >
              <X className="w-3.5 h-3.5" /> Limpiar
            </button>
          )}
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={orderRows.length === 0}
            className="inline-flex items-center gap-1 px-3 h-9 rounded-[var(--radius-md)] text-[12px] font-medium text-[var(--gray-500)] hover:text-[var(--gray-950)] hover:bg-[var(--gray-50)] hover-press disabled:opacity-40"
            title="Exportar el resumen por OC a CSV"
          >
            <Download className="w-3.5 h-3.5" /> CSV
          </button>
          <div className="ml-auto text-[12px] text-[var(--gray-400)] tabular-nums">
            {orderRows.length.toLocaleString()} OCs
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
                  <Th align="right">Importe total</Th>
                  <Th align="right">Recibido</Th>
                  <Th align="right">Pend. recibir</Th>
                  <Th align="right">Pend. factura</Th>
                  <Th>Antigüedad (pedido)</Th>
                  <Th>Estado</Th>
                </tr>
              </thead>
              <tbody>
                {orderRows.length === 0 ? (
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
                            <PackageCheck className="w-5 h-5 text-[var(--gray-300)]" />
                            <div className="text-[13px]">
                              {ocEstado === 'backlog'
                                ? 'Sin OCs pendientes de recibir o facturar.'
                                : 'Sin OCs con los filtros.'}
                            </div>
                            {orderFiltersActive && (
                              <button
                                onClick={clearOrderFilters}
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
                  orderRows.slice(0, visibleCount).map((o, idx) => (
                    <OrderRow
                      key={`${o.cia}::${o.noOrden}`}
                      order={o}
                      idx={idx}
                      providerIndex={providerIndex}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
          {orderRows.length > visibleCount && (
            <LoadMore
              shown={Math.min(visibleCount, orderRows.length)}
              total={orderRows.length}
              onMore={() => setVisibleCount((n) => n + PAGE_SIZE)}
            />
          )}
        </div>
      </section>
      )}

      {/* ─── Toolbar: search + filters (DETALLE por línea) ─────────────── */}
      {view === 'detalle' && (
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
            className="input max-w-[160px]"
            value={facturaFilter}
            onChange={(e) => setFacturaFilter(e.target.value as FacturaFilter)}
            title="Filtrar por estado de factura"
          >
            <option value="all">Todas (facturación)</option>
            <option value="sinFacturar">Sin facturar</option>
            <option value="facturadas">Ya facturadas</option>
          </select>
          <select
            className="input max-w-[170px]"
            value={receiptFilter}
            onChange={(e) => setReceiptFilter(e.target.value as ReceiptFilter)}
            title="Filtrar por estado de recepción"
          >
            <option value="all">Todas (recepción)</option>
            <option value="recibidas">Recibidas</option>
            <option value="pendienteRecepcion">Pendiente recepción</option>
          </select>
          <select
            className="input max-w-[145px]"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as CompraStatusFilter)}
            title="Filtrar por estado de la OC"
          >
            <option value="active">Activas</option>
            <option value="all">Activas + canceladas</option>
            <option value="cancelled">Canceladas</option>
          </select>
          <select
            className="input max-w-[160px]"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            title="Filtrar por categoría"
          >
            <option value="all">Todas las categorías</option>
            {categoriasDisponibles.map((category) => (
              <option key={category} value={category}>{category}</option>
            ))}
          </select>
          <select
            className="input max-w-[145px]"
            value={dateField}
            onChange={(e) => setDateField(e.target.value as CompraDateField)}
            title="Campo de fecha para rango"
          >
            <option value="fechaPedido">Fecha pedido</option>
            <option value="fechaRecepcion">Recepción</option>
            <option value="fechaPagoProyectada">Pago proy.</option>
          </select>
          <input
            type="date"
            className="input max-w-[145px]"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            title="Fecha desde"
          />
          <input
            type="date"
            className="input max-w-[145px]"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            title="Fecha hasta"
          />
          <input
            type="number"
            className="input max-w-[120px]"
            placeholder="Importe mín."
            value={amountMin}
            onChange={(e) => setAmountMin(e.target.value)}
            min="0"
            title="Importe mínimo (MXN)"
          />
          <input
            type="number"
            className="input max-w-[120px]"
            placeholder="Importe máx."
            value={amountMax}
            onChange={(e) => setAmountMax(e.target.value)}
            min="0"
            title="Importe máximo (MXN)"
          />
          <select
            className="input max-w-[185px]"
            value={`${sort.key}:${sort.direction}`}
            onChange={(e) => {
              const [key, direction] = e.target.value.split(':') as [CompraSortKey, SortDirection];
              setSort({ key, direction });
            }}
            title="Ordenar registros"
          >
            <option value="fechaPedido:desc">Pedido reciente primero</option>
            <option value="fechaPedido:asc">Pedido antiguo primero</option>
            <option value="fechaRecepcion:desc">Recepción reciente primero</option>
            <option value="fechaRecepcion:asc">Recepción antigua primero</option>
            <option value="fechaPagoProyectada:desc">Pago reciente primero</option>
            <option value="fechaPagoProyectada:asc">Pago antiguo primero</option>
            <option value="importeTotal:desc">Importe mayor primero</option>
            <option value="importeTotal:asc">Importe menor primero</option>
          </select>
          {focus && (
            <button
              type="button"
              onClick={() => setFocus(null)}
              className="inline-flex items-center gap-1 px-3 h-9 rounded-full text-[12px] font-medium border hover-press"
              style={{
                backgroundColor: 'var(--primary-muted)',
                borderColor: 'var(--primary)',
                color: 'var(--primary)',
              }}
              title="Quitar el foco"
            >
              <Filter className="w-3.5 h-3.5" />
              {focus.label}
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          {filtersActive && (
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex items-center gap-1 px-3 h-9 rounded-[var(--radius-md)] text-[12px] font-medium text-[var(--gray-500)] hover:text-[var(--gray-950)] hover:bg-[var(--gray-50)] hover-press"
            >
              <X className="w-3.5 h-3.5" /> Limpiar
            </button>
          )}
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={filteredRecords.length === 0}
            className="inline-flex items-center gap-1 px-3 h-9 rounded-[var(--radius-md)] text-[12px] font-medium text-[var(--gray-500)] hover:text-[var(--gray-950)] hover:bg-[var(--gray-50)] hover-press disabled:opacity-40"
            title="Exportar las OCs filtradas a CSV"
          >
            <Download className="w-3.5 h-3.5" /> CSV
          </button>
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
                  <Th>Producto</Th>
                  <Th align="right">Importe (MXN)</Th>
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
                    <td colSpan={10} className="text-center text-[var(--gray-400)] py-14">
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
                  filteredRecords.slice(0, visibleCount).map((r, idx) => (
                    <CompraRow
                      key={comprasRecordKey(r)}
                      record={r}
                      idx={idx}
                      asOf={asOf}
                      providerIndex={providerIndex}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
          {filteredRecords.length > visibleCount && (
            <LoadMore
              shown={Math.min(visibleCount, filteredRecords.length)}
              total={filteredRecords.length}
              onMore={() => setVisibleCount((n) => n + PAGE_SIZE)}
            />
          )}
        </div>
      </section>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Helpers                                                                  */
/* ──────────────────────────────────────────────────────────────────────── */

function ViewToggleButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof Layers;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-3 h-8 rounded-[var(--radius-sm)] text-[12px] font-medium transition-colors hover-press"
      style={{
        backgroundColor: active ? 'var(--primary)' : 'transparent',
        color: active ? 'var(--primary-foreground, #fff)' : 'var(--gray-500)',
      }}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}

function LoadMore({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  return (
    <div className="px-4 py-2.5 flex items-center justify-between gap-3 text-[11px] text-[var(--gray-500)] bg-[var(--surface-alt)] border-t border-[var(--gray-200)]">
      <span>
        Mostrando <b className="tabular-nums text-[var(--gray-950)]">{shown.toLocaleString()}</b> de{' '}
        <b className="tabular-nums text-[var(--gray-950)]">{total.toLocaleString()}</b>
      </span>
      <button
        type="button"
        onClick={onMore}
        className="inline-flex items-center gap-1 px-3 h-7 rounded-[var(--radius-md)] text-[12px] font-medium border border-[var(--gray-200)] bg-white hover:bg-[var(--gray-50)] hover-press text-[var(--gray-700)]"
      >
        Cargar más
      </button>
    </div>
  );
}

function OrderEstadoChip({ estado }: { estado: ComprasOrderEstado }) {
  const { style, icon: Icon } = ORDER_ESTADO_CHIP[estado];
  return (
    <StatusChip style={style} icon={Icon}>
      {COMPRA_ORDER_ESTADO_LABEL[estado]}
    </StatusChip>
  );
}

function OrderRow({
  order: o,
  idx,
  providerIndex,
}: {
  order: ComprasOrderSummary;
  idx: number;
  providerIndex: ReturnType<typeof buildProviderIndex>;
}) {
  const stale = o.estado === 'pendienteRecibir' && (o.antiguedadDias ?? 0) > STALE_OPEN_ORDER_DAYS;
  return (
    <tr
      className={`group border-t border-[var(--gray-200)]/40 hover-row hover:bg-[var(--primary-muted)]/30 ${
        idx % 2 === 1 ? 'bg-[var(--gray-50)]/40' : ''
      }`}
    >
      <Td className="pl-5">
        <span className="font-mono text-[11px] text-[var(--gray-500)]">{o.cia}</span>
      </Td>
      <Td>
        <div className="font-medium text-[var(--gray-950)] truncate max-w-[240px]" title={o.nombreProveedor}>
          {o.nombreProveedor}
        </div>
        <div className="mt-0.5">
          <ProviderBadge index={providerIndex} jdeCode={o.noProveedor} name={o.nombreProveedor} />
        </div>
      </Td>
      <Td>
        <span className="inline-flex items-center gap-1">
          <span className="font-mono text-[11px] text-[var(--gray-700)]">{o.noOrden}</span>
          <SourceInfo attribution={sourceOf('compras', 'Orden de compra (JDE).')} />
        </span>
        <div className="text-[10px] text-[var(--gray-400)]">
          {o.lineCount} {o.lineCount === 1 ? 'línea' : 'líneas'}
        </div>
      </Td>
      <Td align="right">
        <span className="tabular-nums font-semibold text-[var(--gray-950)]">{fmtCurrency(o.importeTotalMxn)}</span>
      </Td>
      <Td align="right">
        <span className="tabular-nums text-[var(--gray-700)]">{fmtCurrency(o.importeRecibidoMxn)}</span>
        {o.importeFacturadoMxn > 0 && (
          <div className="text-[10px] text-[var(--gray-400)] tabular-nums" title="Porción ya facturada (en CXP)">
            {fmtCompact(o.importeFacturadoMxn)} fact.
          </div>
        )}
      </Td>
      <Td align="right">
        {o.importePendienteRecibirMxn > 0 ? (
          <span className="tabular-nums font-medium" style={{ color: 'var(--info)' }}>
            {fmtCurrency(o.importePendienteRecibirMxn)}
          </span>
        ) : (
          <span className="text-[var(--gray-300)]">—</span>
        )}
      </Td>
      <Td align="right">
        {o.importePendienteFacturaMxn > 0 ? (
          <span className="tabular-nums font-medium" style={{ color: 'var(--warning)' }} title="Pasivo por distribuir: recibido sin factura">
            {fmtCurrency(o.importePendienteFacturaMxn)}
          </span>
        ) : (
          <span className="text-[var(--gray-300)]">—</span>
        )}
      </Td>
      <Td>
        {o.fechaPedido ? (
          <span className="text-[12px] tabular-nums" style={{ color: stale ? 'var(--warning)' : 'var(--gray-700)' }} title={`Pedido ${o.fechaPedido}`}>
            {o.antiguedadDias !== null ? `${o.antiguedadDias} d` : o.fechaPedido}
            {stale ? ` · +${STALE_OPEN_ORDER_DAYS}` : ''}
          </span>
        ) : (
          <span className="text-[var(--gray-300)]">—</span>
        )}
      </Td>
      <Td>
        <OrderEstadoChip estado={o.estado} />
      </Td>
    </tr>
  );
}

function CompraRow({
  record: r,
  idx,
  asOf,
  providerIndex,
}: {
  record: ComprasRecord;
  idx: number;
  asOf: string;
  providerIndex: ReturnType<typeof buildProviderIndex>;
}) {
  const estado = compraEstado(r);
  const foreign = isComprasForeignCurrency(r);
  const ocMeta = [
    r.descTipoOrden || r.tipoOrden,
    r.lineaOrden ? `L${r.lineaOrden}` : '',
  ].filter(Boolean).join(' · ');
  const pendingDays = !r.fechaRecepcion && r.fechaPedido ? daysSinceIso(r.fechaPedido, asOf) : null;
  const stale = isStaleSinEntrada(r, asOf);

  return (
    <tr
      className={`group border-t border-[var(--gray-200)]/40 hover-row hover:bg-[var(--primary-muted)]/30 ${
        idx % 2 === 1 ? 'bg-[var(--gray-50)]/40' : ''
      }`}
    >
      <Td className="pl-5">
        <span className="font-mono text-[11px] text-[var(--gray-500)]">{r.cia}</span>
        {r.centroCostos && (
          <div className="font-mono text-[10px] text-[var(--gray-400)]" title="Centro de costos">
            CC {r.centroCostos}
          </div>
        )}
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
        <span className="inline-flex items-center gap-1">
          <span className="font-mono text-[11px] text-[var(--gray-700)]">{r.noOrden}</span>
          <SourceInfo attribution={sourceOf('compras', 'Orden de compra (JDE), detalle por línea.')} />
        </span>
        {ocMeta && (
          <div className="text-[10px] text-[var(--gray-400)] truncate max-w-[140px]" title={ocMeta}>
            {ocMeta}
          </div>
        )}
      </Td>
      <Td>
        <span
          className="inline-block max-w-[180px] truncate text-[var(--gray-700)] text-[12px]"
          title={[r.noProducto, r.descProducto, r.concepto].filter(Boolean).join(' · ')}
        >
          {r.descProducto || r.concepto || <span className="text-[var(--gray-300)]">—</span>}
        </span>
        {r.cantidad > 0 && r.precioUnitario > 0 && (
          <div className="text-[10px] text-[var(--gray-400)] tabular-nums">
            {Number.isInteger(r.cantidad) ? fmtInt(r.cantidad) : fmtNum(r.cantidad)} × {fmtCurrency(r.precioUnitario)}
          </div>
        )}
      </Td>
      <Td align="right">
        <span className="tabular-nums font-medium text-[var(--gray-950)]">
          {fmtCurrency(comprasImporteMxn(r))}
        </span>
        {foreign && (
          <div
            className="text-[10px] text-[var(--gray-400)] tabular-nums"
            title="Importe original y tipo de cambio del API"
          >
            {r.moneda} {fmtNum(r.importeTotal)} · TC {fmtNum(r.tipoCambio || 1)}
          </div>
        )}
      </Td>
      <Td>
        <span
          className="inline-block max-w-[160px] truncate text-[var(--gray-700)] text-[12px]"
          title={[r.descCategoria, r.descFamilia, r.descSubFamilia].filter(Boolean).join(' · ')}
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
          <span
            className="text-[12px] tabular-nums"
            style={{ color: stale ? 'var(--warning)' : 'var(--gray-300)' }}
            title={pendingDays !== null ? `Pedida hace ${pendingDays} días sin entrada` : undefined}
          >
            Pendiente{pendingDays !== null && pendingDays >= 0 ? ` · ${pendingDays} d` : ''}
          </span>
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
        <EstadoChip estado={estado} edoSig={r.estadoSiguiente} />
      </Td>
    </tr>
  );
}

function EstadoChip({ estado, edoSig }: { estado: ReturnType<typeof compraEstado>; edoSig: string }) {
  const title = edoSig ? `Edo_Sig ${edoSig}` : undefined;
  switch (estado) {
    case 'cancelada':
      return <StatusChip style={STATUS_CANCELADA} icon={X} title={title}>Cancelada</StatusChip>;
    case 'facturada':
      return <StatusChip style={STATUS_FACTURADA} icon={CheckCircle2} title={title}>Facturada</StatusChip>;
    case 'cerradaWorkflow':
      return <StatusChip style={STATUS_CERRADA_WF} icon={Archive} title={title}>Cerrada en JDE</StatusChip>;
    case 'porPagar':
      return <StatusChip style={STATUS_POR_PAGAR} icon={FileText} title={title}>Pasivo por distribuir</StatusChip>;
    default:
      return <StatusChip style={STATUS_SIN_ENTRADA} icon={Calendar} title={title}>Sin entrada</StatusChip>;
  }
}

function InsightCard({
  insight,
  active,
  onClick,
}: {
  insight: ComprasInsight;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = SEVERITY_ICON[insight.severity];
  const color = SEVERITY_COLOR[insight.severity];
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={insight.description}
      className="text-left bg-white border rounded-[var(--radius-md)] p-3 hover-press"
      style={{ borderColor: active ? 'var(--primary)' : 'var(--gray-200)' }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--gray-950)]">
          <Icon className="w-3.5 h-3.5 shrink-0" style={{ color }} />
          {insight.label}
        </span>
        <span
          className="text-[11px] font-bold tabular-nums px-1.5 py-0.5 rounded-full"
          style={{ backgroundColor: `color-mix(in oklch, ${color} 12%, transparent)`, color }}
        >
          {insight.count.toLocaleString()}
        </span>
      </div>
      <div className="mt-1 text-[14px] font-bold tabular-nums text-[var(--gray-950)]">
        {fmtCompact(insight.totalMxn)}
      </div>
      <p className="mt-1 text-[11px] leading-snug text-[var(--gray-400)]">
        {insight.description}
      </p>
    </button>
  );
}

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

function parseAmountInput(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compareCompraRecords(a: ComprasRecord, b: ComprasRecord, sort: CompraSort): number {
  const direction = sort.direction === 'asc' ? 1 : -1;
  if (sort.key === 'importeTotal') {
    return (comprasImporteMxn(a) - comprasImporteMxn(b)) * direction;
  }
  const av = a[sort.key] || '';
  const bv = b[sort.key] || '';
  if (!av && !bv) return 0;
  if (!av) return 1;
  if (!bv) return -1;
  return av.localeCompare(bv) * direction;
}

function StatusChip({
  children,
  style,
  icon: Icon,
  title,
}: {
  children: ReactNode;
  style: ChipStyle;
  icon: typeof CheckCircle2;
  title?: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-medium whitespace-nowrap"
      style={{ backgroundColor: style.bg, borderColor: style.border, color: style.text }}
      title={title}
    >
      <Icon className="w-3 h-3" />
      {children}
    </span>
  );
}
