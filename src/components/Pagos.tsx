/**
 * Vista de Pagos a Proveedor (PagoProveedor JDE) — modo auditoría por proveedor.
 *
 * Cierra el loop OC → CXP → Pago → Banco en una sola UI. Cada pago se cruza
 * con el motor `paymentReconciliationEngine` (cxpMatches + cargoMatch), y los
 * cxpMatches se enlazan a la OC origen vía `noFactura + noProveedor` contra
 * `comprasRecords`.
 *
 *   - Modo "Por proveedor" (default): panel maestro con un row por proveedor
 *     (clave + cía) → drawer con timeline cronológico de pagos. Cada pago
 *     expande sus OCs facturadas y CXPs cubiertas.
 *   - Modo "Lista plana": tabla clásica enriquecida con badge de cruce.
 *
 * Reglas:
 *   - Pagos `tipoBusqueda === 'Employees'` (nómina/vales/reembolsos) NO tienen
 *     OC ni CXP; se muestran con su propio chip y no rompen el cruce.
 *   - Pagos internos (`internalPaymentKeys`) se filtran antes de KPIs.
 *   - Bridge OC: `${cia}::${noProveedor}::${normalize(noFactura)}` →
 *     `ComprasRecord[]` (una factura puede cubrir varias líneas de OC).
 *   - "Huérfano" = UNMATCHED **con cobertura bancaria** (había banco cargado
 *     contra qué cruzar y el cargo no apareció) y no-empleado. Un UNMATCHED
 *     cuya cuenta no tiene estados de cuenta cargados (o cuya fecha cae fuera
 *     del rango bancario) se muestra como "Sin estado de cuenta" — falta de
 *     datos, no discrepancia. Misma definición en KPI, rollup y filtros.
 */

import { useMemo, useState, type ReactNode } from 'react';
import {
  CreditCard,
  Search,
  Database,
  Download,
  Filter,
  X,
  CheckCircle2,
  Users,
  Building2,
  AlertCircle,
  AlertTriangle,
  Info,
  Link2,
  Receipt,
  Banknote,
  FileText,
  ChevronRight,
  LayoutGrid,
  List,
  ShieldAlert,
} from 'lucide-react';
import { type PagoProveedorRecord, type ComprasRecord } from '../services/jde';
import { fmtCompact, fmtCurrency, fmtDate, todayISO } from '../formatters';
import PageHeader from './ui/PageHeader';
import ProviderBadge from './ProviderBadge';
import { buildProviderIndex } from '../domain/providerIdentity';
import type { Provider } from '../domain/types';
import type { PaymentMatch, CxpMatchTier, CargoMatchTier } from '../domain/paymentReconciliationEngine';
import type { CXPRecord } from '../domain/persistence';
import { isInternalCounterparty, isInternalProviderClassification } from '../domain/netCashFlowEngine';
import { normFactura } from '../domain/rolCobranzaMatch';
import {
  PAGO_STATUS_LABEL,
  buildPagadoPorMes,
  buildPagosDepuracionInsights,
  isEmployeePago,
  isRealOrphan,
  pagoDisplayStatus,
  pagoRecordKey,
  pagosToCsv,
  type PagoDisplayStatus,
  type PagosInsight,
  type PagosInsightSeverity,
} from '../domain/pagosInsights';

interface PagosProps {
  pagoProveedorRecords: PagoProveedorRecord[];
  pagoProveedorLoadedCias: Record<string, string>;
  selectedCia: string;
  providers: Provider[];
  internalPaymentKeys?: Set<string>;
  paymentMatches: PaymentMatch[];
  comprasRecords: ComprasRecord[];
  cxpRecords: CXPRecord[];
}

type ViewMode = 'byProvider' | 'flatList';
type TipoBusquedaFilter = 'all' | 'employees' | 'suppliers';
type StatusFilter = 'all' | 'matched' | 'cxp-only' | 'bank-only' | 'orphan' | 'no-bank-data';
type ProviderSortKey = 'totalPagado' | 'conciliacionPct' | 'pagosCount' | 'orphanCount' | 'ultimoPago' | 'nombre';
type FlatSortKey = 'fechaPago' | 'importePesos' | 'nombreProveedor' | 'banco' | 'noPago';
type SortDirection = 'asc' | 'desc';

/** Foco puntual sobre un set exacto de pagos (hallazgo de depuración o mes del strip). */
interface PagoFocus {
  id: string;
  label: string;
  keys: ReadonlySet<string>;
}

const PAGOS_CACHE_KEY = '__all__';
const ROW_CAP = 500;

interface ChipStyle {
  bg: string;
  border: string;
  text: string;
}

const CHIP_EMPLOYEE: ChipStyle = {
  bg: 'var(--info-muted)',
  border: 'var(--gray-200)',
  text: 'var(--info)',
};

/**
 * `MATCHED_BANK_ONLY` no es ruido: el banco YA confirmó que el dinero salió.
 * La CXP desaparece de `/antiguedadsaldos` cuando JDE la cierra (importe
 * pendiente = 0), o cuando la OC quedó fuera de la ventana de compras de 180d.
 * Pintarlo como warning generaba falsa alarma sobre cientos de pagos ya
 * conciliados. Lo tratamos como variante de "Pagado" — tono success suave y
 * etiqueta explícita "CXP cerrada".
 *
 * El estado visible (`pagoDisplayStatus`), la definición de huérfano real
 * (`isRealOrphan`) y sus etiquetas (`PAGO_STATUS_LABEL`) viven en
 * `src/domain/pagosInsights.ts` — única fuente de verdad compartida con el
 * panel de depuración y el export CSV.
 */
const STATUS_STYLE: Record<PagoDisplayStatus, ChipStyle> = {
  MATCHED_FULL: {
    bg: 'var(--success-muted)',
    border: 'oklch(88% 0.08 145)',
    text: 'var(--success)',
  },
  MATCHED_CXP_ONLY: {
    bg: 'var(--info-muted)',
    border: 'var(--gray-200)',
    text: 'var(--info)',
  },
  MATCHED_BANK_ONLY: {
    bg: 'color-mix(in oklch, var(--success-muted) 70%, transparent)',
    border: 'oklch(90% 0.05 145)',
    text: 'oklch(48% 0.1 145)',
  },
  UNMATCHED: {
    bg: 'oklch(95% 0.05 30)',
    border: 'oklch(85% 0.1 30)',
    text: 'var(--danger)',
  },
  NO_BANK_DATA: {
    bg: 'var(--surface-alt)',
    border: 'var(--gray-200)',
    text: 'var(--gray-500)',
  },
};

const TIER_LABEL: Record<CxpMatchTier, string> = {
  'folio-exact': 'folio exacto',
  'invoice-amount': 'monto exacto',
  'amount-tolerance': 'monto ±0.5%',
  'subset-sum': 'subset-sum',
  unmatched: 'sin cruce',
};

const CARGO_TIER_LABEL: Record<CargoMatchTier, string> = {
  exact: 'exacto',
  tolerance: 'tolerancia',
  batch: 'lote agregado',
  'cross-account': 'otra cuenta',
  subset: 'pago partido',
  unmatched: 'sin cruce',
};

/**
 * Un pago se considera interno y se oculta de Pagos cuando:
 *   1. El motor de conciliación ya lo marcó (matchea un CARGO interno por
 *      banco-banco propio o por patrón de concepto/referencia), o
 *   2. El proveedor en sí es una entidad del grupo (RFC o nombre en las
 *      listas curadas de `isInternalCounterparty`). Esto ataja los pagos
 *      intercompañía donde el banco aún no exhibe el patrón pero el
 *      destinatario YA es una empresa Senda.
 *   3. El comentario del pago coincide con el patrón de traspaso o intercía
 *      (TRASPASO REF / TRASLADO / INTERCIAS / ENTRE EMPRESAS …) — la misma
 *      heurística que `isInternalTransfer` aplica al texto bancario.
 */
const INTERNAL_COMMENT_PATTERN = /\b(?:TRA(?:N?S(?:P(?:ASO)?|F(?:ER(?:ENCIA)?)?)?)?[\s._/\-]*REF|TRASLADO|INTERCIAS?|ENTRE\s+(?:CIAS|EMPRESAS|COMPA(?:N|Ñ)IAS))\b/i;

function isInternalPaymentRecord(
  r: PagoProveedorRecord,
  engineInternalKeys: Set<string> | undefined,
): boolean {
  if (engineInternalKeys && engineInternalKeys.has(pagoRecordKey(r))) return true;
  if (isInternalCounterparty(r.rfcProveedor, r.nombreProveedor)) return true;
  // Clasificación JDE "Filiales"/intercompañía: empresa interna del grupo aunque
  // el nombre/RFC no la delaten (misma señal que usa la proyección de CXP).
  if (
    isInternalProviderClassification(r.clasificacionProveedor)
    || isInternalProviderClassification(r.clasificacionProveedorFinanciera)
  ) return true;
  if (r.comentarioPago && INTERNAL_COMMENT_PATTERN.test(r.comentarioPago)) return true;
  return false;
}

function bancoLabel(cuentaBancaria: string): string {
  const parts = cuentaBancaria.split(' - ');
  if (parts.length >= 2) return parts[1].trim();
  return cuentaBancaria.trim();
}

function normProv(s: string): string {
  return s.trim().toUpperCase();
}

function providerRollupKey(cia: string, clave: string): string {
  return `${cia}::${normProv(clave)}`;
}

/* ───────── Bridge OC ↔ CXP ↔ Pago ───────── */

interface ComprasBridge {
  /** Map de `${cia}::${noProveedor}::${normFactura}` → OCs de esa factura. */
  byFactura: Map<string, ComprasRecord[]>;
}

function buildComprasBridge(records: ComprasRecord[]): ComprasBridge {
  const byFactura = new Map<string, ComprasRecord[]>();
  for (const r of records) {
    // normFactura canónico (rolCobranzaMatch): tolera drift de formato
    // ("RI - 123" vs "RI-123") y mapea placeholders ("S/F", "N/A") a '' —
    // esos se saltan para no puentear OCs sin factura real entre sí.
    const folio = normFactura(r.noFactura);
    if (!folio) continue;
    const k = `${r.cia}::${normProv(r.noProveedor)}::${folio}`;
    const list = byFactura.get(k);
    if (list) list.push(r);
    else byFactura.set(k, [r]);
  }
  return { byFactura };
}

function findOCsForCxp(cxp: CXPRecord, bridge: ComprasBridge): ComprasRecord[] {
  const folio = normFactura(cxp.noFactura);
  if (!folio) return [];
  const k = `${cxp.cia}::${normProv(cxp.noProveedor)}::${folio}`;
  return bridge.byFactura.get(k) ?? [];
}

/** Agrupa OCs por noOrden (una factura puede tener N líneas de la misma OC). */
function groupOCsByOrden(records: ComprasRecord[]): Array<{
  noOrden: string;
  total: number;
  fechaRecepcion: string;
  fechaPagoProyectada: string;
  lineas: ComprasRecord[];
}> {
  const map = new Map<string, ComprasRecord[]>();
  for (const r of records) {
    const arr = map.get(r.noOrden) ?? [];
    arr.push(r);
    map.set(r.noOrden, arr);
  }
  return Array.from(map.entries()).map(([noOrden, lineas]) => ({
    noOrden,
    total: lineas.reduce((sum, l) => sum + l.importeTotal, 0),
    fechaRecepcion: lineas.find((l) => l.fechaRecepcion)?.fechaRecepcion ?? '',
    fechaPagoProyectada: lineas.find((l) => l.fechaPagoProyectada)?.fechaPagoProyectada ?? '',
    lineas,
  }));
}

/* ───────── Provider rollup ───────── */

interface ProviderRollup {
  key: string;
  cia: string;
  claveProveedor: string;
  nombreProveedor: string;
  rfcProveedor: string;
  isEmployee: boolean;
  clasificacion: string;
  matches: PaymentMatch[];
  totalPagado: number;
  ocsCubiertas: Set<string>;
  cxpsCubiertas: number;
  pagosFull: number;
  pagosCxpOnly: number;
  pagosBankOnly: number;
  /** Huérfanos REALES (UNMATCHED con cobertura bancaria, no-empleado). */
  pagosOrphan: number;
  /** UNMATCHED sin banco cargado contra qué cruzar — falta de datos, no alarma. */
  pagosSinBanco: number;
  ultimoPago: string;
  conciliacionPct: number;
}

function buildProviderRollups(matches: PaymentMatch[], bridge: ComprasBridge): ProviderRollup[] {
  const map = new Map<string, ProviderRollup>();
  for (const m of matches) {
    const p = m.payment;
    const key = providerRollupKey(p.cia, p.claveProveedor);
    let r = map.get(key);
    if (!r) {
      r = {
        key,
        cia: p.cia,
        claveProveedor: p.claveProveedor,
        nombreProveedor: p.nombreProveedor,
        rfcProveedor: p.rfcProveedor,
        isEmployee: isEmployeePago(p),
        clasificacion: p.clasificacionProveedorFinanciera || p.clasificacionProveedor,
        matches: [],
        totalPagado: 0,
        ocsCubiertas: new Set(),
        cxpsCubiertas: 0,
        pagosFull: 0,
        pagosCxpOnly: 0,
        pagosBankOnly: 0,
        pagosOrphan: 0,
        pagosSinBanco: 0,
        ultimoPago: '',
        conciliacionPct: 0,
      };
      map.set(key, r);
    }
    r.matches.push(m);
    r.totalPagado += p.importePesos;
    if (p.fechaPago && p.fechaPago > r.ultimoPago) r.ultimoPago = p.fechaPago;
    switch (m.status) {
      case 'MATCHED_FULL': r.pagosFull += 1; break;
      case 'MATCHED_CXP_ONLY': r.pagosCxpOnly += 1; break;
      case 'MATCHED_BANK_ONLY': r.pagosBankOnly += 1; break;
      case 'UNMATCHED':
        // Misma definición que el KPI: huérfano sólo con cobertura bancaria
        // y no-empleado; sin cobertura es falta de datos, no discrepancia.
        if (isRealOrphan(m)) r.pagosOrphan += 1;
        else if (m.bankCoverage !== 'covered') r.pagosSinBanco += 1;
        break;
    }
    for (const hit of m.cxpMatches) {
      r.cxpsCubiertas += 1;
      const ocs = findOCsForCxp(hit.cxp, bridge);
      for (const oc of ocs) r.ocsCubiertas.add(oc.noOrden);
    }
  }
  for (const r of map.values()) {
    const denom = r.matches.length;
    r.conciliacionPct = denom > 0 ? ((r.pagosFull + r.pagosCxpOnly) / denom) * 100 : 0;
    r.matches.sort((a, b) => (b.payment.fechaPago || '').localeCompare(a.payment.fechaPago || ''));
  }
  return Array.from(map.values());
}

/* ───────── Component ───────── */

export default function Pagos({
  pagoProveedorRecords,
  pagoProveedorLoadedCias,
  selectedCia,
  providers,
  internalPaymentKeys,
  paymentMatches,
  comprasRecords,
  cxpRecords: _cxpRecords,
}: PagosProps) {
  void _cxpRecords;
  const [viewMode, setViewMode] = useState<ViewMode>('byProvider');
  const [search, setSearch] = useState('');
  const [tipoFilter, setTipoFilter] = useState<TipoBusquedaFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [bancoFilter, setBancoFilter] = useState<string>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [amountMin, setAmountMin] = useState('');
  const [amountMax, setAmountMax] = useState('');
  const [providerSort, setProviderSort] = useState<{ key: ProviderSortKey; dir: SortDirection }>({
    key: 'totalPagado',
    dir: 'desc',
  });
  const [flatSort, setFlatSort] = useState<{ key: FlatSortKey; dir: SortDirection }>({
    key: 'fechaPago',
    dir: 'desc',
  });
  const [selectedProviderKey, setSelectedProviderKey] = useState<string | null>(null);
  const [focus, setFocus] = useState<PagoFocus | null>(null);

  const asOf = useMemo(() => todayISO(), []);
  const providerIndex = useMemo(() => buildProviderIndex(providers), [providers]);

  /* Visible matches: drop internal payments — engine flag + counterparty
     heuristic + comment pattern. Coverage redundante por diseño: tres señales
     independientes para no dejar pasar intercía. */
  const visibleMatches = useMemo(() => {
    return paymentMatches.filter((m) => !isInternalPaymentRecord(m.payment, internalPaymentKeys));
  }, [paymentMatches, internalPaymentKeys]);

  const bridge = useMemo(() => buildComprasBridge(comprasRecords), [comprasRecords]);

  /* Index by payment key for the flat view to look up its match in O(1). */
  const matchByPaymentKey = useMemo(() => {
    const map = new Map<string, PaymentMatch>();
    for (const m of visibleMatches) map.set(pagoRecordKey(m.payment), m);
    return map;
  }, [visibleMatches]);

  const visiblePagoProveedorRecords = useMemo(() => {
    return pagoProveedorRecords.filter((r) => !isInternalPaymentRecord(r, internalPaymentKeys));
  }, [pagoProveedorRecords, internalPaymentKeys]);

  const lastLoadedAt = pagoProveedorLoadedCias[PAGOS_CACHE_KEY];

  /* Reporte de depuración sobre TODO el scope de la cía (no sobre los filtros
     de la tabla): es el estado del dataset, no de la vista. */
  const insights = useMemo(() => {
    const scoped = selectedCia === 'all'
      ? visibleMatches
      : visibleMatches.filter((m) => m.payment.cia === selectedCia);
    return buildPagosDepuracionInsights(scoped.map((m) => m.payment), asOf, scoped);
  }, [visibleMatches, selectedCia, asOf]);

  /* Apply scalar filters (cía/tipo/banco/fecha/monto/búsqueda/status) at the
     PaymentMatch level — single source of truth for both views. */
  const scalarFilteredMatches = useMemo(() => {
    const q = search.trim().toUpperCase();
    const min = parseAmountInput(amountMin);
    const max = parseAmountInput(amountMax);
    return visibleMatches.filter((m) => {
      const r = m.payment;
      if (selectedCia !== 'all' && r.cia !== selectedCia) return false;
      if (tipoFilter === 'employees' && !isEmployeePago(r)) return false;
      if (tipoFilter === 'suppliers' && isEmployeePago(r)) return false;
      if (bancoFilter !== 'all' && bancoLabel(r.cuentaBancaria) !== bancoFilter) return false;
      if (dateFrom && (!r.fechaPago || r.fechaPago < dateFrom)) return false;
      if (dateTo && (!r.fechaPago || r.fechaPago > dateTo)) return false;
      if (min !== undefined && r.importePesos < min) return false;
      if (max !== undefined && r.importePesos > max) return false;
      if (statusFilter !== 'all') {
        const display = pagoDisplayStatus(m);
        if (statusFilter === 'matched' && display !== 'MATCHED_FULL') return false;
        if (statusFilter === 'cxp-only' && display !== 'MATCHED_CXP_ONLY') return false;
        if (statusFilter === 'bank-only' && display !== 'MATCHED_BANK_ONLY') return false;
        if (statusFilter === 'orphan' && !isRealOrphan(m)) return false;
        if (statusFilter === 'no-bank-data' && display !== 'NO_BANK_DATA') return false;
      }
      if (q) {
        const hay =
          r.nombreProveedor.toUpperCase().includes(q) ||
          r.claveProveedor.toUpperCase().includes(q) ||
          r.rfcProveedor.toUpperCase().includes(q) ||
          r.noPago.toUpperCase().includes(q) ||
          r.batchPago.toUpperCase().includes(q) ||
          r.comentarioPago.toUpperCase().includes(q) ||
          r.cuentaBancaria.toUpperCase().includes(q);
        if (!hay) return false;
      }
      return true;
    });
  }, [
    visibleMatches,
    search,
    tipoFilter,
    statusFilter,
    bancoFilter,
    dateFrom,
    dateTo,
    amountMin,
    amountMax,
    selectedCia,
  ]);

  const filteredMatches = useMemo(() => {
    if (!focus) return scalarFilteredMatches;
    return scalarFilteredMatches.filter((m) => focus.keys.has(pagoRecordKey(m.payment)));
  }, [scalarFilteredMatches, focus]);

  /* El strip ignora el foco a propósito: enfocar un mes no debe colapsar el
     propio strip a ese mes. */
  const pagadoPorMes = useMemo(
    () => buildPagadoPorMes(scalarFilteredMatches.map((m) => m.payment)),
    [scalarFilteredMatches],
  );

  const bancosDisponibles = useMemo(() => {
    const set = new Set<string>();
    for (const m of visibleMatches) {
      const b = bancoLabel(m.payment.cuentaBancaria);
      if (b) set.add(b);
    }
    return Array.from(set).sort();
  }, [visibleMatches]);

  const kpis = useMemo(() => {
    let total = 0;
    let aProveedores = 0;
    let aEmpleados = 0;
    let conciliados = 0;
    let conciliadosMonto = 0;
    let huerfanos = 0;
    let huerfanosMonto = 0;
    let sinBanco = 0;
    let sinBancoMonto = 0;
    const ocsCubiertas = new Set<string>();
    for (const m of filteredMatches) {
      const r = m.payment;
      total += r.importePesos;
      if (isEmployeePago(r)) aEmpleados += r.importePesos;
      else aProveedores += r.importePesos;
      if (m.status === 'MATCHED_FULL') {
        conciliados += 1;
        conciliadosMonto += r.importePesos;
      }
      if (isRealOrphan(m)) {
        huerfanos += 1;
        huerfanosMonto += r.importePesos;
      } else if (m.status === 'UNMATCHED' && m.bankCoverage !== 'covered') {
        sinBanco += 1;
        sinBancoMonto += r.importePesos;
      }
      for (const hit of m.cxpMatches) {
        for (const oc of findOCsForCxp(hit.cxp, bridge)) ocsCubiertas.add(`${oc.cia}::${oc.noOrden}`);
      }
    }
    const conciliacionPct = filteredMatches.length > 0 ? (conciliados / filteredMatches.length) * 100 : 0;
    return {
      total,
      aProveedores,
      aEmpleados,
      conciliados,
      conciliadosMonto,
      conciliacionPct,
      huerfanos,
      huerfanosMonto,
      sinBanco,
      sinBancoMonto,
      ocsCubiertas: ocsCubiertas.size,
      cuenta: filteredMatches.length,
    };
  }, [filteredMatches, bridge]);

  const providerRollups = useMemo(() => buildProviderRollups(filteredMatches, bridge), [filteredMatches, bridge]);

  const sortedProviderRollups = useMemo(() => {
    const arr = [...providerRollups];
    const dir = providerSort.dir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      const k = providerSort.key;
      if (k === 'nombre') return a.nombreProveedor.localeCompare(b.nombreProveedor, 'es-MX') * dir;
      if (k === 'totalPagado') return (a.totalPagado - b.totalPagado) * dir;
      if (k === 'conciliacionPct') return (a.conciliacionPct - b.conciliacionPct) * dir;
      if (k === 'pagosCount') return (a.matches.length - b.matches.length) * dir;
      if (k === 'orphanCount') return (a.pagosOrphan - b.pagosOrphan) * dir;
      if (k === 'ultimoPago') return (a.ultimoPago || '').localeCompare(b.ultimoPago || '') * dir;
      return 0;
    });
    return arr;
  }, [providerRollups, providerSort]);

  const selectedRollup = useMemo(() => {
    if (!selectedProviderKey) return null;
    return sortedProviderRollups.find((r) => r.key === selectedProviderKey)
      ?? providerRollups.find((r) => r.key === selectedProviderKey)
      ?? null;
  }, [selectedProviderKey, sortedProviderRollups, providerRollups]);

  const filtersActive =
    search.trim() !== '' ||
    tipoFilter !== 'all' ||
    statusFilter !== 'all' ||
    bancoFilter !== 'all' ||
    dateFrom !== '' ||
    dateTo !== '' ||
    amountMin !== '' ||
    amountMax !== '' ||
    focus !== null;

  const clearFilters = () => {
    setSearch('');
    setTipoFilter('all');
    setStatusFilter('all');
    setBancoFilter('all');
    setDateFrom('');
    setDateTo('');
    setAmountMin('');
    setAmountMax('');
    setFocus(null);
  };

  /* Enfocar = "muéstrame EXACTAMENTE estos pagos": resetea los demás filtros
     para que la tabla muestre el set completo del hallazgo/mes. */
  const toggleFocus = (id: string, label: string, keys: string[]) => {
    if (focus?.id === id) {
      setFocus(null);
      return;
    }
    setSearch('');
    setTipoFilter('all');
    setStatusFilter('all');
    setBancoFilter('all');
    setDateFrom('');
    setDateTo('');
    setAmountMin('');
    setAmountMax('');
    setFocus({ id, label, keys: new Set(keys) });
  };

  const handleExportCsv = () => {
    if (filteredMatches.length === 0) return;
    const csv = pagosToCsv(filteredMatches);
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const scope = selectedCia === 'all' ? '' : `-${selectedCia}`;
    const focused = focus ? `-${focus.id}` : '';
    a.download = `pagos-${asOf}${scope}${focused}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Pagos a Proveedores" />

      {/* Trust signal */}
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
              {visiblePagoProveedorRecords.length.toLocaleString()} pagos
            </span>
          </div>
        </div>
      )}

      {/* KPI cards */}
      <section className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KpiCard
          icon={CreditCard}
          label="Total pagado"
          value={fmtCurrency(kpis.total)}
          sub={`${kpis.cuenta.toLocaleString()} pagos`}
          tone="neutral"
        />
        <KpiCard
          icon={Building2}
          label="A proveedores"
          value={fmtCurrency(kpis.aProveedores)}
          sub="Comerciales · servicios"
          tone="success"
        />
        <KpiCard
          icon={Users}
          label="A empleados"
          value={fmtCurrency(kpis.aEmpleados)}
          sub="Nómina · vales · reembolsos"
          tone="info"
        />
        <KpiCard
          icon={Link2}
          label="Conciliación OC"
          value={`${kpis.conciliacionPct.toFixed(0)}%`}
          sub={`${kpis.ocsCubiertas.toLocaleString()} OCs cubiertas · ${fmtCompact(kpis.conciliadosMonto)}`}
          tone={kpis.conciliacionPct >= 75 ? 'success' : kpis.conciliacionPct >= 50 ? 'info' : 'warning'}
        />
        <KpiCard
          icon={ShieldAlert}
          label="Pagos huérfanos"
          value={kpis.huerfanos.toLocaleString()}
          sub={`Con banco cargado y sin cruce · ${fmtCompact(kpis.huerfanosMonto)}${
            kpis.sinBanco > 0 ? ` · ${kpis.sinBanco.toLocaleString()} sin edo. de cuenta` : ''
          }`}
          tone={kpis.huerfanos === 0 ? 'success' : 'warning'}
        />
      </section>

      {/* ─── Strip mensual: pagado por mes (split proveedores/empleados) ── */}
      {pagadoPorMes.length > 0 && (
        <section className="animate-card-in">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] mb-1 text-[var(--gray-500)]">
            Pagado por mes (fecha de pago)
          </h2>
          <p className="text-[11px] text-[var(--gray-400)] mb-2">
            Egreso ejecutado por mes, desglosado en proveedores vs. empleados. Clic para enfocar la
            tabla en el mes.
          </p>
          <div className="flex gap-2 flex-wrap">
            {pagadoPorMes.map((bucket) => {
              const focusId = `month:${bucket.ym}`;
              const isFocused = focus?.id === focusId;
              return (
                <button
                  key={bucket.ym}
                  type="button"
                  aria-pressed={isFocused}
                  onClick={() => toggleFocus(focusId, `Pagos · ${bucket.ym}`, bucket.keys)}
                  className="text-left bg-white border rounded-[var(--radius-md)] px-3 py-1.5 hover-press"
                  style={{ borderColor: isFocused ? 'var(--primary)' : 'var(--gray-200)' }}
                  title={`${bucket.count.toLocaleString()} pagos en ${bucket.ym} · proveedores ${fmtCompact(bucket.proveedoresMxn)} · empleados ${fmtCompact(bucket.empleadosMxn)}`}
                >
                  <div className="font-mono text-[10px] text-[var(--gray-400)]">{bucket.ym}</div>
                  <div className="text-[13px] font-bold tabular-nums text-[var(--gray-950)]">
                    {fmtCompact(bucket.totalMxn)}
                  </div>
                  <div className="text-[10px] tabular-nums text-[var(--gray-400)]">
                    {bucket.count.toLocaleString()} pagos
                    {bucket.empleadosMxn > 0 && ` · emp ${fmtCompact(bucket.empleadosMxn)}`}
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
            Pagos detectados con lógica sobre los datos del API — candidatos a corregir o depurar en
            JDE. Clic para enfocar la tabla; exporta el CSV para entregar la lista.
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

      {/* View toggle */}
      <section className="flex flex-wrap items-center gap-2">
        <div className="inline-flex bg-[var(--surface-alt)] border border-[var(--gray-200)] rounded-[var(--radius-md)] p-0.5">
          <button
            type="button"
            onClick={() => setViewMode('byProvider')}
            className={`inline-flex items-center gap-1.5 px-3 h-8 rounded-[var(--radius-sm)] text-[12px] font-medium transition-colors ${
              viewMode === 'byProvider'
                ? 'bg-white text-[var(--gray-950)] shadow-sm'
                : 'text-[var(--gray-500)] hover:text-[var(--gray-950)]'
            }`}
          >
            <LayoutGrid className="w-3.5 h-3.5" /> Por proveedor
          </button>
          <button
            type="button"
            onClick={() => setViewMode('flatList')}
            className={`inline-flex items-center gap-1.5 px-3 h-8 rounded-[var(--radius-sm)] text-[12px] font-medium transition-colors ${
              viewMode === 'flatList'
                ? 'bg-white text-[var(--gray-950)] shadow-sm'
                : 'text-[var(--gray-500)] hover:text-[var(--gray-950)]'
            }`}
          >
            <List className="w-3.5 h-3.5" /> Lista plana
          </button>
        </div>
        <span className="text-[11px] text-[var(--gray-400)]">
          {viewMode === 'byProvider'
            ? 'Auditoría OC → CXP → Pago → Banco agrupada por proveedor.'
            : 'Tabla cronológica con badge de cruce por pago.'}
        </span>
      </section>

      {/* Toolbar */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--gray-400)]" />
            <input
              type="text"
              placeholder="Buscar proveedor, RFC, no. pago, comentario…"
              className="input pl-9 w-full"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className="input max-w-[155px]"
            value={tipoFilter}
            onChange={(e) => setTipoFilter(e.target.value as TipoBusquedaFilter)}
            title="Filtrar por tipo de beneficiario"
          >
            <option value="all">Todos los tipos</option>
            <option value="suppliers">Proveedores</option>
            <option value="employees">Empleados</option>
          </select>
          <select
            className="input max-w-[180px]"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            title="Filtrar por estado de cruce"
          >
            <option value="all">Todos los cruces</option>
            <option value="matched">Conciliado completo</option>
            <option value="cxp-only">Sólo CXP</option>
            <option value="bank-only">Sólo Banco</option>
            <option value="orphan">Huérfano</option>
            <option value="no-bank-data">Sin estado de cuenta</option>
          </select>
          <select
            className="input max-w-[170px]"
            value={bancoFilter}
            onChange={(e) => setBancoFilter(e.target.value)}
            title="Filtrar por banco emisor"
          >
            <option value="all">Todos los bancos</option>
            {bancosDisponibles.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
          <input
            type="date"
            className="input max-w-[145px]"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            title="Fecha pago desde"
          />
          <input
            type="date"
            className="input max-w-[145px]"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            title="Fecha pago hasta"
          />
          <input
            type="number"
            className="input max-w-[120px]"
            placeholder="Importe mín."
            value={amountMin}
            onChange={(e) => setAmountMin(e.target.value)}
            min="0"
          />
          <input
            type="number"
            className="input max-w-[120px]"
            placeholder="Importe máx."
            value={amountMax}
            onChange={(e) => setAmountMax(e.target.value)}
            min="0"
          />
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
            disabled={filteredMatches.length === 0}
            className="inline-flex items-center gap-1 px-3 h-9 rounded-[var(--radius-md)] text-[12px] font-medium text-[var(--gray-500)] hover:text-[var(--gray-950)] hover:bg-[var(--gray-50)] hover-press disabled:opacity-40"
            title="Exportar los pagos filtrados a CSV (campos del API + cruce)"
          >
            <Download className="w-3.5 h-3.5" /> CSV
          </button>
          <div className="ml-auto text-[12px] text-[var(--gray-400)] tabular-nums">
            {filteredMatches.length === visibleMatches.length
              ? `${visibleMatches.length.toLocaleString()} total`
              : `${filteredMatches.length.toLocaleString()} de ${visibleMatches.length.toLocaleString()}`}
          </div>
        </div>

        {viewMode === 'byProvider' ? (
          <ProviderAuditView
            rollups={sortedProviderRollups}
            sort={providerSort}
            onSortChange={setProviderSort}
            selectedKey={selectedProviderKey}
            onSelect={setSelectedProviderKey}
            providerIndex={providerIndex}
            bridge={bridge}
            selectedRollup={selectedRollup}
            visibleTotal={visibleMatches.length}
            filtersActive={filtersActive}
            onClearFilters={clearFilters}
          />
        ) : (
          <FlatPaymentList
            matches={filteredMatches}
            visibleTotal={visibleMatches.length}
            sort={flatSort}
            onSortChange={setFlatSort}
            providerIndex={providerIndex}
            filtersActive={filtersActive}
            onClearFilters={clearFilters}
            matchByPaymentKey={matchByPaymentKey}
          />
        )}
      </section>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Provider audit view                                                      */
/* ──────────────────────────────────────────────────────────────────────── */

interface ProviderAuditViewProps {
  rollups: ProviderRollup[];
  sort: { key: ProviderSortKey; dir: SortDirection };
  onSortChange: (s: { key: ProviderSortKey; dir: SortDirection }) => void;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  providerIndex: ReturnType<typeof buildProviderIndex>;
  bridge: ComprasBridge;
  selectedRollup: ProviderRollup | null;
  visibleTotal: number;
  filtersActive: boolean;
  onClearFilters: () => void;
}

function ProviderAuditView({
  rollups,
  sort,
  onSortChange,
  selectedKey,
  onSelect,
  providerIndex,
  bridge,
  selectedRollup,
  visibleTotal,
  filtersActive,
  onClearFilters,
}: ProviderAuditViewProps) {
  const cappedRollups = useMemo(() => rollups.slice(0, ROW_CAP), [rollups]);

  if (visibleTotal === 0) {
    return <EmptyState filtersActive={false} onClear={onClearFilters} />;
  }
  if (rollups.length === 0) {
    return <EmptyState filtersActive={filtersActive} onClear={onClearFilters} />;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-3">
      {/* Master: provider list */}
      <div className="bg-white border border-[var(--gray-200)] rounded-[var(--radius)] overflow-hidden animate-card-in">
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="bg-[var(--surface-alt)] text-[var(--gray-400)] text-left text-[11px] uppercase tracking-wide sticky top-0 z-10">
              <tr>
                <SortableTh
                  label="Proveedor"
                  active={sort.key === 'nombre'}
                  dir={sort.dir}
                  onClick={() => onSortChange({ key: 'nombre', dir: sort.key === 'nombre' && sort.dir === 'asc' ? 'desc' : 'asc' })}
                  className="pl-5"
                />
                <SortableTh
                  label="Pagos"
                  align="right"
                  active={sort.key === 'pagosCount'}
                  dir={sort.dir}
                  onClick={() => onSortChange({ key: 'pagosCount', dir: sort.key === 'pagosCount' && sort.dir === 'desc' ? 'asc' : 'desc' })}
                />
                <SortableTh
                  label="Total"
                  align="right"
                  active={sort.key === 'totalPagado'}
                  dir={sort.dir}
                  onClick={() => onSortChange({ key: 'totalPagado', dir: sort.key === 'totalPagado' && sort.dir === 'desc' ? 'asc' : 'desc' })}
                />
                <SortableTh
                  label="Conciliación"
                  align="right"
                  active={sort.key === 'conciliacionPct'}
                  dir={sort.dir}
                  onClick={() => onSortChange({ key: 'conciliacionPct', dir: sort.key === 'conciliacionPct' && sort.dir === 'desc' ? 'asc' : 'desc' })}
                />
                <SortableTh
                  label="Huérfanos"
                  align="right"
                  active={sort.key === 'orphanCount'}
                  dir={sort.dir}
                  onClick={() => onSortChange({ key: 'orphanCount', dir: sort.key === 'orphanCount' && sort.dir === 'desc' ? 'asc' : 'desc' })}
                />
                <SortableTh
                  label="Último"
                  active={sort.key === 'ultimoPago'}
                  dir={sort.dir}
                  onClick={() => onSortChange({ key: 'ultimoPago', dir: sort.key === 'ultimoPago' && sort.dir === 'desc' ? 'asc' : 'desc' })}
                />
              </tr>
            </thead>
            <tbody>
              {cappedRollups.map((r) => {
                const selected = r.key === selectedKey;
                const tone =
                  r.pagosOrphan > 0 ? 'warning' :
                  r.conciliacionPct >= 75 ? 'success' : 'info';
                return (
                  <tr
                    key={r.key}
                    onClick={() => onSelect(r.key)}
                    className={`group border-t border-[var(--gray-200)]/40 cursor-pointer hover-row hover:bg-[var(--primary-muted)]/30 ${
                      selected ? 'bg-[var(--primary-muted)]/40' : ''
                    }`}
                  >
                    <Td className="pl-5">
                      <div className="flex items-center gap-1.5">
                        <ChevronRight
                          className={`w-3.5 h-3.5 text-[var(--gray-400)] transition-transform ${selected ? 'rotate-90 text-[var(--primary)]' : ''}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div
                            className="font-medium text-[var(--gray-950)] truncate"
                            title={r.nombreProveedor}
                          >
                            {r.nombreProveedor || '—'}
                          </div>
                          <div className="mt-0.5 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
                            {!r.isEmployee && (
                              <ProviderBadge
                                index={providerIndex}
                                jdeCode={r.claveProveedor}
                                name={r.nombreProveedor}
                              />
                            )}
                            <span className="font-mono text-[10px] text-[var(--gray-400)]">
                              {r.claveProveedor}
                            </span>
                            {r.isEmployee && (
                              <Chip style={CHIP_EMPLOYEE} icon={Users}>Empleado</Chip>
                            )}
                          </div>
                        </div>
                      </div>
                    </Td>
                    <Td align="right">
                      <span className="tabular-nums text-[12px] text-[var(--gray-700)]">
                        {r.matches.length}
                      </span>
                    </Td>
                    <Td align="right">
                      <span className="tabular-nums font-medium text-[var(--gray-950)]">
                        {fmtCurrency(r.totalPagado)}
                      </span>
                    </Td>
                    <Td align="right">
                      <ConciliationBar pct={r.conciliacionPct} tone={tone} ocs={r.ocsCubiertas.size} />
                    </Td>
                    <Td align="right">
                      {r.pagosOrphan > 0 ? (
                        <span className="inline-flex items-center gap-1 text-[12px] tabular-nums text-[var(--danger)] font-medium">
                          <AlertTriangle className="w-3 h-3" />
                          {r.pagosOrphan}
                        </span>
                      ) : (
                        <span className="text-[12px] text-[var(--gray-300)]">—</span>
                      )}
                    </Td>
                    <Td>
                      <span className="text-[11px] tabular-nums text-[var(--gray-500)]">
                        {r.ultimoPago || '—'}
                      </span>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {rollups.length > ROW_CAP && (
          <div className="px-4 py-2 text-[11px] text-[var(--gray-500)] bg-[var(--surface-alt)] border-t border-[var(--gray-200)]">
            Mostrando <span className="tabular-nums font-medium text-[var(--gray-950)]">{ROW_CAP}</span>{' '}
            de{' '}
            <span className="tabular-nums font-medium text-[var(--gray-950)]">
              {rollups.length.toLocaleString()}
            </span>{' '}
            proveedores. Refina los filtros para ver más.
          </div>
        )}
      </div>

      {/* Detail panel */}
      <div className="bg-white border border-[var(--gray-200)] rounded-[var(--radius)] overflow-hidden animate-card-in min-h-[400px]">
        {selectedRollup ? (
          <ProviderAuditDetail rollup={selectedRollup} bridge={bridge} providerIndex={providerIndex} />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-center p-8 text-[var(--gray-400)]">
            <Receipt className="w-7 h-7 text-[var(--gray-300)] mb-3" />
            <p className="text-[13px] text-[var(--gray-500)]">
              Selecciona un proveedor para auditar el cruce
            </p>
            <p className="text-[11px] mt-1">
              OC facturada → CXP → Pago ejecutado → Cargo bancario
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Provider detail — timeline                                               */
/* ──────────────────────────────────────────────────────────────────────── */

function ProviderAuditDetail({
  rollup,
  bridge,
  providerIndex,
}: {
  rollup: ProviderRollup;
  bridge: ComprasBridge;
  providerIndex: ReturnType<typeof buildProviderIndex>;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-[var(--gray-200)] px-5 py-4 bg-[var(--surface-alt)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-bold text-[var(--gray-950)] truncate" title={rollup.nombreProveedor}>
              {rollup.nombreProveedor || '—'}
            </h3>
            <div className="mt-1 flex items-center gap-2 flex-wrap">
              {!rollup.isEmployee && (
                <ProviderBadge
                  index={providerIndex}
                  jdeCode={rollup.claveProveedor}
                  name={rollup.nombreProveedor}
                />
              )}
              <span className="font-mono text-[11px] text-[var(--gray-500)]">
                {rollup.claveProveedor}
              </span>
              {rollup.rfcProveedor && (
                <span className="font-mono text-[11px] text-[var(--gray-500)]">
                  {rollup.rfcProveedor}
                </span>
              )}
              <span className="text-[11px] text-[var(--gray-400)]">Cía {rollup.cia}</span>
              {rollup.clasificacion && (
                <span className="text-[11px] text-[var(--gray-500)] truncate max-w-[260px]" title={rollup.clasificacion}>
                  · {rollup.clasificacion}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
          <MiniStat label="Total" value={fmtCurrency(rollup.totalPagado)} />
          <MiniStat label="Pagos" value={`${rollup.matches.length}`} />
          <MiniStat label="OCs cubiertas" value={`${rollup.ocsCubiertas.size}`} accent="success" />
          <MiniStat
            label="Huérfanos"
            value={`${rollup.pagosOrphan}`}
            accent={rollup.pagosOrphan > 0 ? 'warning' : 'neutral'}
          />
          {rollup.pagosSinBanco > 0 && (
            <MiniStat label="Sin edo. de cuenta" value={`${rollup.pagosSinBanco}`} />
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {rollup.matches.map((m) => (
          <PaymentAuditCard key={pagoRecordKey(m.payment)} match={m} bridge={bridge} />
        ))}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Payment audit card — single Pago with OC + CXP + Banco                   */
/* ──────────────────────────────────────────────────────────────────────── */

function PaymentAuditCard({ match, bridge }: { match: PaymentMatch; bridge: ComprasBridge }) {
  const [expanded, setExpanded] = useState(false);
  const p = match.payment;
  const isEmployee = isEmployeePago(p);
  const ocsByCxp = match.cxpMatches.map((hit) => ({
    cxp: hit.cxp,
    tier: hit.tier,
    confidence: hit.confidence,
    ocs: groupOCsByOrden(findOCsForCxp(hit.cxp, bridge)),
  }));
  const totalOCs = ocsByCxp.reduce((sum, x) => sum + x.ocs.length, 0);
  // UNMATCHED también expande: el detalle explica POR QUÉ no cruzó (sin
  // estados de cuenta / fuera de rango / cargo candidato ya reclamado).
  const canExpand = (!isEmployee && match.cxpMatches.length > 0) || !!match.cargoMatch || match.status === 'UNMATCHED';
  const display = pagoDisplayStatus(match);

  return (
    <div className="border border-[var(--gray-200)] rounded-[var(--radius-md)] bg-white">
      <button
        type="button"
        onClick={() => canExpand && setExpanded((v) => !v)}
        className={`w-full flex items-center gap-3 px-4 py-3 text-left ${canExpand ? 'hover:bg-[var(--gray-50)] cursor-pointer' : 'cursor-default'}`}
      >
        <div className="w-9 h-9 rounded-full bg-[var(--surface-alt)] border border-[var(--gray-200)] flex items-center justify-center shrink-0">
          {isEmployee ? (
            <Users className="w-4 h-4 text-[var(--info)]" />
          ) : (
            <Banknote className="w-4 h-4 text-[var(--gray-500)]" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-[11px] text-[var(--gray-700)]">{p.fechaPago || '—'}</span>
            <span className="text-[14px] tabular-nums font-bold text-[var(--gray-950)]">
              {fmtCurrency(p.importePesos)}
            </span>
            {p.moneda && p.moneda !== 'MXP' && p.moneda !== 'MXN' && (
              <span className="text-[10px] text-[var(--gray-400)]">{p.moneda}</span>
            )}
            <Chip style={STATUS_STYLE[display]} icon={statusIcon(display)}>
              {PAGO_STATUS_LABEL[display]}
            </Chip>
            {totalOCs > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] text-[var(--gray-500)] font-medium">
                <FileText className="w-3 h-3" /> {totalOCs} OC{totalOCs > 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-2 flex-wrap text-[11px] text-[var(--gray-500)]">
            <span className="font-mono">Pago {p.noPago}</span>
            {p.tipoPago && <span className="font-mono" title="Tipo de pago JDE">{p.tipoPago}</span>}
            {p.batchPago && <span className="font-mono" title="Batch JDE">B·{p.batchPago}</span>}
            <span>·</span>
            <span>{bancoLabel(p.cuentaBancaria)}</span>
            {p.cuentaBanco && <span className="font-mono">·{p.cuentaBanco}</span>}
            {p.comentarioPago && (
              <>
                <span>·</span>
                <span className="font-mono truncate max-w-[280px]" title={p.comentarioPago}>
                  {p.comentarioPago}
                </span>
              </>
            )}
          </div>
        </div>
        {canExpand && (
          <ChevronRight
            className={`w-4 h-4 text-[var(--gray-400)] transition-transform shrink-0 ${expanded ? 'rotate-90' : ''}`}
          />
        )}
      </button>

      {expanded && canExpand && (
        <div className="border-t border-[var(--gray-200)] bg-[var(--gray-50)]/40 px-4 py-3 space-y-3">
          {/* OC → CXP chain */}
          {ocsByCxp.length > 0 ? (
            ocsByCxp.map((entry) => (
              <div
                key={`${entry.cxp.cia}::${entry.cxp.noFactura}::${entry.cxp.noProveedor}`}
                className="bg-white border border-[var(--gray-200)] rounded-[var(--radius-sm)] p-3"
              >
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <Receipt className="w-3.5 h-3.5 text-[var(--info)]" />
                  <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--gray-500)]">
                    CXP
                  </span>
                  <span className="font-mono text-[12px] text-[var(--gray-950)]">{entry.cxp.noFactura}</span>
                  <span className="text-[11px] tabular-nums text-[var(--gray-500)]">
                    {fmtCurrency(entry.cxp.importeBrutoPesos)}
                  </span>
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded-full border"
                    style={{
                      backgroundColor: 'var(--info-muted)',
                      borderColor: 'var(--gray-200)',
                      color: 'var(--info)',
                    }}
                    title={`Confianza ${(entry.confidence * 100).toFixed(0)}%`}
                  >
                    {TIER_LABEL[entry.tier]}
                  </span>
                  {entry.cxp.fechaFactura && (
                    <span className="text-[11px] text-[var(--gray-500)]">
                      · {entry.cxp.fechaFactura}
                    </span>
                  )}
                </div>
                {entry.ocs.length > 0 ? (
                  <div className="space-y-1.5 pl-5 border-l-2 border-[var(--gray-200)]">
                    {entry.ocs.map((oc) => (
                      <div key={oc.noOrden} className="flex items-center gap-2 flex-wrap text-[12px]">
                        <FileText className="w-3 h-3 text-[var(--success)]" />
                        <span className="font-mono text-[var(--gray-950)] font-medium">OC {oc.noOrden}</span>
                        <span className="tabular-nums text-[var(--gray-700)]">
                          {fmtCurrency(oc.total)}
                        </span>
                        {oc.lineas.length > 1 && (
                          <span className="text-[10px] text-[var(--gray-400)]">
                            {oc.lineas.length} líneas
                          </span>
                        )}
                        {oc.fechaRecepcion && (
                          <span className="text-[11px] text-[var(--gray-500)]">
                            recep {oc.fechaRecepcion}
                          </span>
                        )}
                        {oc.fechaPagoProyectada && (
                          <span className="text-[11px] text-[var(--gray-400)]">
                            · pago proyectado {oc.fechaPagoProyectada}
                          </span>
                        )}
                        {oc.lineas[0]?.descCategoria && (
                          <span className="text-[10px] text-[var(--gray-400)] truncate max-w-[180px]" title={oc.lineas[0].descCategoria}>
                            {oc.lineas[0].descCategoria}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[11px] text-[var(--gray-400)] italic pl-5">
                    Sin OC encontrada para esta factura (puede ser servicio sin OC o fuera del rango cargado).
                  </div>
                )}
              </div>
            ))
          ) : (
            <div className="text-[12px] text-[var(--gray-500)] bg-white border border-[var(--gray-200)] rounded-[var(--radius-sm)] p-3">
              <AlertTriangle className="w-3.5 h-3.5 inline mr-1 text-[var(--warning)]" />
              Pago sin CXP asociada. {match.reason}
            </div>
          )}

          {/* Cargo bancario */}
          {match.cargoMatch ? (
            <div className="bg-white border border-[var(--gray-200)] rounded-[var(--radius-sm)] p-3">
              <div className="flex items-center gap-2 flex-wrap">
                <Banknote className="w-3.5 h-3.5 text-[var(--success)]" />
                <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--gray-500)]">
                  Cargo bancario
                </span>
                <span className="font-mono text-[12px] text-[var(--gray-950)]">
                  {match.cargoMatch.cuenta}
                </span>
                <span className="text-[11px] tabular-nums text-[var(--gray-700)]">
                  {fmtCurrency(Math.abs(match.cargoMatch.movement.importe))}
                </span>
                <span className="text-[11px] text-[var(--gray-500)]">
                  {match.cargoMatch.movement.fechaOperacion}
                </span>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-full border"
                  style={{
                    backgroundColor: 'var(--success-muted)',
                    borderColor: 'oklch(88% 0.08 145)',
                    color: 'var(--success)',
                  }}
                  title={`Confianza ${(match.cargoMatch.confidence * 100).toFixed(0)}%`}
                >
                  {CARGO_TIER_LABEL[match.cargoMatch.tier]}
                </span>
                {match.cargoMatch.extraMovements && match.cargoMatch.extraMovements.length > 0 && (
                  <span className="text-[10px] text-[var(--gray-500)]">
                    +{match.cargoMatch.extraMovements.length} cargo(s)
                  </span>
                )}
              </div>
              {match.cargoMatch.movement.concepto && (
                <div className="text-[11px] text-[var(--gray-500)] font-mono mt-1 truncate" title={match.cargoMatch.movement.concepto}>
                  {match.cargoMatch.movement.concepto}
                </div>
              )}
            </div>
          ) : (
            <div className="text-[11px] text-[var(--gray-500)] italic px-1">
              {bankGapExplanation(match)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Flat list view                                                           */
/* ──────────────────────────────────────────────────────────────────────── */

interface FlatPaymentListProps {
  matches: PaymentMatch[];
  visibleTotal: number;
  sort: { key: FlatSortKey; dir: SortDirection };
  onSortChange: (s: { key: FlatSortKey; dir: SortDirection }) => void;
  providerIndex: ReturnType<typeof buildProviderIndex>;
  filtersActive: boolean;
  onClearFilters: () => void;
  matchByPaymentKey: Map<string, PaymentMatch>;
}

function FlatPaymentList({
  matches,
  visibleTotal,
  sort,
  onSortChange,
  providerIndex,
  filtersActive,
  onClearFilters,
  matchByPaymentKey: _matchByPaymentKey,
}: FlatPaymentListProps) {
  void _matchByPaymentKey;
  const sorted = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...matches].sort((a, b) => {
      const ar = a.payment;
      const br = b.payment;
      if (sort.key === 'importePesos') return (ar.importePesos - br.importePesos) * dir;
      if (sort.key === 'banco') return bancoLabel(ar.cuentaBancaria).localeCompare(bancoLabel(br.cuentaBancaria)) * dir;
      const av = ar[sort.key] ?? '';
      const bv = br[sort.key] ?? '';
      return av.localeCompare(bv, 'es-MX', { numeric: true }) * dir;
    });
  }, [matches, sort]);

  if (visibleTotal === 0) return <EmptyState filtersActive={false} onClear={onClearFilters} />;
  if (sorted.length === 0) return <EmptyState filtersActive={filtersActive} onClear={onClearFilters} />;

  return (
    <div className="bg-white border border-[var(--gray-200)] rounded-[var(--radius)] overflow-hidden animate-card-in">
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="bg-[var(--surface-alt)] text-[var(--gray-400)] text-left text-[11px] uppercase tracking-wide sticky top-0 z-10">
            <tr>
              <Th className="pl-5">Cía</Th>
              <SortableTh
                label="Fecha"
                active={sort.key === 'fechaPago'}
                dir={sort.dir}
                onClick={() => onSortChange({ key: 'fechaPago', dir: sort.key === 'fechaPago' && sort.dir === 'desc' ? 'asc' : 'desc' })}
              />
              <SortableTh
                label="Beneficiario"
                active={sort.key === 'nombreProveedor'}
                dir={sort.dir}
                onClick={() => onSortChange({ key: 'nombreProveedor', dir: sort.key === 'nombreProveedor' && sort.dir === 'asc' ? 'desc' : 'asc' })}
              />
              <SortableTh
                label="Importe"
                align="right"
                active={sort.key === 'importePesos'}
                dir={sort.dir}
                onClick={() => onSortChange({ key: 'importePesos', dir: sort.key === 'importePesos' && sort.dir === 'desc' ? 'asc' : 'desc' })}
              />
              <SortableTh
                label="Banco"
                active={sort.key === 'banco'}
                dir={sort.dir}
                onClick={() => onSortChange({ key: 'banco', dir: sort.key === 'banco' && sort.dir === 'asc' ? 'desc' : 'asc' })}
              />
              <SortableTh
                label="Pago"
                active={sort.key === 'noPago'}
                dir={sort.dir}
                onClick={() => onSortChange({ key: 'noPago', dir: sort.key === 'noPago' && sort.dir === 'desc' ? 'asc' : 'desc' })}
              />
              <Th>Cruce</Th>
              <Th>Comentario / OC</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, ROW_CAP).map((m, idx) => {
              const r = m.payment;
              const employee = isEmployeePago(r);
              const ocCount = m.cxpMatches.length;
              return (
                <tr
                  key={pagoRecordKey(r)}
                  className={`group border-t border-[var(--gray-200)]/40 hover-row hover:bg-[var(--primary-muted)]/30 ${
                    idx % 2 === 1 ? 'bg-[var(--gray-50)]/40' : ''
                  }`}
                >
                  <Td className="pl-5">
                    <span className="font-mono text-[11px] text-[var(--gray-500)]" title={r.nombreCia}>
                      {r.cia}
                    </span>
                  </Td>
                  <Td>
                    <span className="text-[12px] tabular-nums text-[var(--gray-700)]">
                      {r.fechaPago || <span className="text-[var(--gray-300)]">—</span>}
                    </span>
                  </Td>
                  <Td>
                    <div className="font-medium text-[var(--gray-950)] truncate max-w-[220px]" title={r.nombreProveedor}>
                      {r.nombreProveedor}
                    </div>
                    <div className="mt-0.5 flex items-center gap-x-2 flex-wrap">
                      {!employee && (
                        <ProviderBadge
                          index={providerIndex}
                          jdeCode={r.claveProveedor}
                          name={r.nombreProveedor}
                        />
                      )}
                      <span className="font-mono text-[10px] text-[var(--gray-400)]">{r.claveProveedor}</span>
                      {r.rfcProveedor && (
                        <span className="font-mono text-[10px] text-[var(--gray-400)]">{r.rfcProveedor}</span>
                      )}
                      {employee && <Chip style={CHIP_EMPLOYEE} icon={Users}>Empleado</Chip>}
                    </div>
                  </Td>
                  <Td align="right">
                    <span className="tabular-nums font-medium text-[var(--gray-950)]">
                      {fmtCurrency(r.importePesos)}
                    </span>
                    {r.moneda && r.moneda !== 'MXP' && r.moneda !== 'MXN' && (
                      <span className="ml-1 text-[10px] text-[var(--gray-400)]">{r.moneda}</span>
                    )}
                  </Td>
                  <Td>
                    <span className="text-[12px] text-[var(--gray-700)]" title={r.cuentaBancaria}>
                      {bancoLabel(r.cuentaBancaria)}
                    </span>
                    <div className="text-[10px] font-mono text-[var(--gray-400)] mt-0.5">
                      {r.cuentaBanco || '—'}
                    </div>
                  </Td>
                  <Td>
                    <span className="font-mono text-[11px] text-[var(--gray-700)]">{r.noPago}</span>
                    {r.tipoPago && (
                      <span className="ml-1 text-[10px] font-mono text-[var(--gray-400)]" title="Tipo de pago JDE">
                        {r.tipoPago}
                      </span>
                    )}
                    {r.batchPago && (
                      <div className="text-[10px] font-mono text-[var(--gray-400)] mt-0.5">
                        Batch {r.batchPago}
                      </div>
                    )}
                  </Td>
                  <Td>
                    <Chip style={STATUS_STYLE[pagoDisplayStatus(m)]} icon={statusIcon(pagoDisplayStatus(m))}>
                      {PAGO_STATUS_LABEL[pagoDisplayStatus(m)]}
                    </Chip>
                  </Td>
                  <Td>
                    <span className="text-[11px] text-[var(--gray-600)] font-mono truncate inline-block max-w-[200px]" title={r.comentarioPago}>
                      {r.comentarioPago || <span className="text-[var(--gray-300)]">—</span>}
                    </span>
                    {ocCount > 0 && (
                      <div className="text-[10px] text-[var(--gray-500)] mt-0.5 inline-flex items-center gap-1">
                        <FileText className="w-3 h-3" /> {ocCount} CXP cubierta{ocCount > 1 ? 's' : ''}
                      </div>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {sorted.length > ROW_CAP && (
        <div className="px-4 py-2 text-[11px] text-[var(--gray-500)] bg-[var(--surface-alt)] border-t border-[var(--gray-200)]">
          Mostrando <span className="tabular-nums font-medium text-[var(--gray-950)]">{ROW_CAP}</span>{' '}
          de{' '}
          <span className="tabular-nums font-medium text-[var(--gray-950)]">
            {sorted.length.toLocaleString()}
          </span>{' '}
          registros. Refina los filtros para ver más.
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Helpers / atoms                                                          */
/* ──────────────────────────────────────────────────────────────────────── */

function EmptyState({ filtersActive, onClear }: { filtersActive: boolean; onClear: () => void }) {
  return (
    <div className="bg-white border border-[var(--gray-200)] rounded-[var(--radius)] py-14 text-center text-[var(--gray-400)] animate-card-in">
      <div className="flex flex-col items-center gap-2">
        {filtersActive ? (
          <>
            <Filter className="w-5 h-5 text-[var(--gray-300)]" />
            <div className="text-[13px]">Sin coincidencias con los filtros.</div>
            <button
              onClick={onClear}
              className="text-[12px] text-[var(--primary)] hover:underline"
            >
              Limpiar filtros
            </button>
          </>
        ) : (
          <>
            <CreditCard className="w-5 h-5 text-[var(--gray-300)]" />
            <div className="text-[13px]">Sin pagos cargados.</div>
          </>
        )}
      </div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  accent = 'neutral',
}: {
  label: string;
  value: string;
  accent?: 'neutral' | 'success' | 'warning';
}) {
  const color =
    accent === 'success' ? 'var(--success)' :
    accent === 'warning' ? 'var(--warning)' :
    'var(--gray-950)';
  return (
    <div className="bg-white border border-[var(--gray-200)] rounded-[var(--radius-sm)] px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--gray-400)]">
        {label}
      </div>
      <div className="text-[14px] font-bold tabular-nums leading-tight" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

function ConciliationBar({
  pct,
  tone,
  ocs,
}: {
  pct: number;
  tone: 'success' | 'info' | 'warning';
  ocs: number;
}) {
  const color =
    tone === 'success' ? 'var(--success)' :
    tone === 'warning' ? 'var(--warning)' :
    'var(--info)';
  return (
    <div className="inline-flex flex-col items-end gap-0.5 min-w-[80px]">
      <span className="text-[12px] tabular-nums font-medium" style={{ color }}>
        {pct.toFixed(0)}%
      </span>
      <div className="w-16 h-1 rounded-full bg-[var(--gray-100)] overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%`, backgroundColor: color }}
        />
      </div>
      {ocs > 0 && (
        <span className="text-[10px] text-[var(--gray-400)]">
          {ocs} OC{ocs > 1 ? 's' : ''}
        </span>
      )}
    </div>
  );
}

const SEVERITY_ICON: Record<PagosInsightSeverity, typeof AlertTriangle> = {
  danger: AlertTriangle,
  warning: AlertCircle,
  info: Info,
};
const SEVERITY_COLOR: Record<PagosInsightSeverity, string> = {
  danger: 'var(--danger)',
  warning: 'var(--warning)',
  info: 'var(--info)',
};

function InsightCard({
  insight,
  active,
  onClick,
}: {
  insight: PagosInsight;
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

function statusIcon(status: PagoDisplayStatus): typeof CheckCircle2 {
  if (status === 'MATCHED_FULL') return CheckCircle2;
  if (status === 'MATCHED_BANK_ONLY') return CheckCircle2;
  if (status === 'UNMATCHED') return AlertTriangle;
  if (status === 'NO_BANK_DATA') return Database;
  return Link2;
}

/**
 * Explica el hueco bancario de un pago sin `cargoMatch`, en orden de
 * especificidad: falta de cobertura (no es discrepancia) → CARGO candidato
 * que el motor vio pero no pudo confirmar → huérfano genuino.
 */
function bankGapExplanation(m: PaymentMatch): string {
  if (m.bankCoverage === 'no-account') {
    return 'La cuenta de este pago no tiene estados de cuenta cargados — no hay banco contra qué cruzar.';
  }
  if (m.bankCoverage === 'out-of-range') {
    return 'La fecha del pago cae fuera del rango bancario cargado para su cuenta.';
  }
  const c = m.unmatchedCandidate;
  if (c) {
    const claimed = c.claimed ? 'ya reclamado por otro pago' : 'fuera de la ventana de cruce';
    const cuenta = c.sameAccount ? 'misma cuenta' : `cuenta ${c.cuenta}`;
    return `Sin cargo bancario empatado. CARGO parecido de ${fmtCurrency(Math.abs(c.movement.importe))} en ${cuenta} a ${c.daysOff}d — ${claimed}.`;
  }
  return 'Sin cargo bancario empatado todavía.';
}

interface KpiCardProps {
  icon: typeof CreditCard;
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

function SortableTh({
  label,
  active,
  dir,
  onClick,
  align = 'left',
  className = '',
}: {
  label: string;
  active: boolean;
  dir: SortDirection;
  onClick: () => void;
  align?: 'left' | 'right' | 'center';
  className?: string;
}) {
  const alignCls = align === 'right' ? 'text-right justify-end' : align === 'center' ? 'text-center justify-center' : 'text-left';
  return (
    <th className={`px-2.5 py-2.5 font-medium ${align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'} ${className}`}>
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-1 ${alignCls} ${active ? 'text-[var(--gray-950)]' : 'text-[var(--gray-400)] hover:text-[var(--gray-700)]'}`}
      >
        {label}
        {active && <span className="text-[10px]">{dir === 'asc' ? '↑' : '↓'}</span>}
      </button>
    </th>
  );
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

function Chip({
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

function parseAmountInput(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
