/**
 * Vista de Pagos a Proveedor (PagoProveedor JDE).
 *
 * Muestra los pagos EFECTIVAMENTE EJECUTADOS (cosas ya pagadas). Es el espejo
 * egreso de Cobranza: cierra el loop banco↔CXP↔OC con datos reales.
 *
 * Lectura del registro:
 *   - `Comentario_Pago` suele referenciar el folio CXP (p.ej.
 *     "FL CXP-VALE21829") — el motor de conciliación lo usa para crucar
 *     con CXPRecord.noFactura.
 *   - `Tipo_busqueda === 'Employees'` distingue reembolsos/vales/nómina
 *     de proveedores comerciales; lo resaltamos con un chip aparte.
 *   - `Clasificacion_Proveedor_Financiera` viene como "220 - Por
 *     Clasificar" (semaforización del controller financiero).
 *
 * Patrón UI espejo de Compras.tsx: misma toolbar/filtros/refresh, mismas
 * constantes de cache (`COMPRAS_CACHE_KEY` = '__all__' para indicar global).
 */

import { useMemo, useState, type ReactNode } from 'react';
import {
  CreditCard,
  Search,
  Database,
  Filter,
  X,
  CheckCircle2,
  Users,
  Building2,
} from 'lucide-react';
import { type PagoProveedorRecord } from '../services/jde';
import { fmtCompact, fmtCurrency, fmtDate } from '../formatters';
import PageHeader from './ui/PageHeader';
import ProviderBadge from './ProviderBadge';
import { buildProviderIndex } from '../domain/providerIdentity';
import type { Provider } from '../domain/types';

interface PagosProps {
  pagoProveedorRecords: PagoProveedorRecord[];
  pagoProveedorLoadedCias: Record<string, string>;
  selectedCia: string;
  providers: Provider[];
  internalPaymentKeys?: Set<string>;
}

type TipoBusquedaFilter = 'all' | 'employees' | 'suppliers';
type BancoFilter = string;
type PagoSortKey = 'fechaPago' | 'importePesos' | 'nombreProveedor' | 'banco' | 'noPago';
type SortDirection = 'asc' | 'desc';

interface PagoSort {
  key: PagoSortKey;
  direction: SortDirection;
}

const PAGOS_CACHE_KEY = '__all__';
const ROW_CAP = 500;
const DEFAULT_SORT: PagoSort = { key: 'fechaPago', direction: 'desc' };

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
const CHIP_SUPPLIER: ChipStyle = {
  bg: 'var(--success-muted)',
  border: 'oklch(88% 0.08 145)',
  text: 'var(--success)',
};

function isEmployeePayment(r: PagoProveedorRecord): boolean {
  return r.tipoBusqueda.trim().toLowerCase().startsWith('employee');
}

/** Extrae solo el banco (parte legible) de Cuenta_Bancaria — p.ej. "BANAMEX". */
function bancoLabel(cuentaBancaria: string): string {
  // Formato típico: "38.1020.0010405 - BANAMEX - 7013 8708851"
  const parts = cuentaBancaria.split(' - ');
  if (parts.length >= 2) return parts[1].trim();
  return cuentaBancaria.trim();
}

export default function Pagos({
  pagoProveedorRecords,
  pagoProveedorLoadedCias,
  selectedCia,
  providers,
  internalPaymentKeys,
}: PagosProps) {
  const [search, setSearch] = useState('');
  const [tipoFilter, setTipoFilter] = useState<TipoBusquedaFilter>('all');
  const [bancoFilter, setBancoFilter] = useState<BancoFilter>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [amountMin, setAmountMin] = useState('');
  const [amountMax, setAmountMax] = useState('');
  const [monedaFilter, setMonedaFilter] = useState('all');
  const [clasificacionFilter, setClasificacionFilter] = useState('all');
  const [sort, setSort] = useState<PagoSort>(DEFAULT_SORT);

  const providerIndex = useMemo(() => buildProviderIndex(providers), [providers]);
  const visiblePagoProveedorRecords = useMemo(() => {
    if (!internalPaymentKeys || internalPaymentKeys.size === 0) return pagoProveedorRecords;
    return pagoProveedorRecords.filter((record) => !internalPaymentKeys.has(`${record.cia}::${record.noPago}`));
  }, [pagoProveedorRecords, internalPaymentKeys]);

  const lastLoadedAt = pagoProveedorLoadedCias[PAGOS_CACHE_KEY];
  const filtersActive =
    search.trim() !== ''
    || tipoFilter !== 'all'
    || bancoFilter !== 'all'
    || dateFrom !== ''
    || dateTo !== ''
    || amountMin !== ''
    || amountMax !== ''
    || monedaFilter !== 'all'
    || clasificacionFilter !== 'all'
    || sort.key !== DEFAULT_SORT.key
    || sort.direction !== DEFAULT_SORT.direction;

  // Lista única de bancos para el filtro (extraída de los datos visibles).
  const bancosDisponibles = useMemo(() => {
    const set = new Set<string>();
    for (const r of visiblePagoProveedorRecords) {
      const b = bancoLabel(r.cuentaBancaria);
      if (b) set.add(b);
    }
    return Array.from(set).sort();
  }, [visiblePagoProveedorRecords]);

  const monedasDisponibles = useMemo(() => {
    const set = new Set<string>();
    for (const r of visiblePagoProveedorRecords) {
      if (r.moneda) set.add(r.moneda);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [visiblePagoProveedorRecords]);

  const clasificacionesDisponibles = useMemo(() => {
    const set = new Set<string>();
    for (const r of visiblePagoProveedorRecords) {
      const classification = r.clasificacionProveedorFinanciera || r.clasificacionProveedor;
      if (classification) set.add(classification);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [visiblePagoProveedorRecords]);

  const filteredRecords = useMemo(() => {
    const q = search.trim().toUpperCase();
    const min = parseAmountInput(amountMin);
    const max = parseAmountInput(amountMax);
    return visiblePagoProveedorRecords.filter((r) => {
      if (selectedCia !== 'all' && r.cia !== selectedCia) return false;
      if (tipoFilter === 'employees' && !isEmployeePayment(r)) return false;
      if (tipoFilter === 'suppliers' && isEmployeePayment(r)) return false;
      if (bancoFilter !== 'all' && bancoLabel(r.cuentaBancaria) !== bancoFilter) return false;
      if (monedaFilter !== 'all' && r.moneda !== monedaFilter) return false;
      if (clasificacionFilter !== 'all') {
        const classification = r.clasificacionProveedorFinanciera || r.clasificacionProveedor;
        if (classification !== clasificacionFilter) return false;
      }
      if (dateFrom && (!r.fechaPago || r.fechaPago < dateFrom)) return false;
      if (dateTo && (!r.fechaPago || r.fechaPago > dateTo)) return false;
      if (min !== undefined && r.importePesos < min) return false;
      if (max !== undefined && r.importePesos > max) return false;
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
    }).sort((a, b) => comparePagoRecords(a, b, sort));
  }, [
    visiblePagoProveedorRecords,
    search,
    tipoFilter,
    bancoFilter,
    dateFrom,
    dateTo,
    amountMin,
    amountMax,
    monedaFilter,
    clasificacionFilter,
    selectedCia,
    sort,
  ]);

  const kpis = useMemo(() => {
    let totalAmount = 0;
    let aProveedores = 0;
    let aEmpleados = 0;
    let bancosUnicos = new Set<string>();
    for (const r of filteredRecords) {
      totalAmount += r.importePesos;
      if (isEmployeePayment(r)) aEmpleados += r.importePesos;
      else aProveedores += r.importePesos;
      bancosUnicos.add(bancoLabel(r.cuentaBancaria));
    }
    return {
      totalAmount,
      aProveedores,
      aEmpleados,
      bancosUnicos: bancosUnicos.size,
      cuenta: filteredRecords.length,
    };
  }, [filteredRecords]);

  const byMonth = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of filteredRecords) {
      if (!r.fechaPago) continue;
      const ym = r.fechaPago.slice(0, 7);
      map.set(ym, (map.get(ym) ?? 0) + r.importePesos);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredRecords]);

  const clearFilters = () => {
    setSearch('');
    setTipoFilter('all');
    setBancoFilter('all');
    setDateFrom('');
    setDateTo('');
    setAmountMin('');
    setAmountMax('');
    setMonedaFilter('all');
    setClasificacionFilter('all');
    setSort(DEFAULT_SORT);
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
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          icon={CreditCard}
          label="Total pagado"
          value={fmtCurrency(kpis.totalAmount)}
          sub={`${kpis.cuenta.toLocaleString()} pagos`}
          tone="neutral"
        />
        <KpiCard
          icon={Building2}
          label="A proveedores"
          value={fmtCurrency(kpis.aProveedores)}
          sub="Comerciales / servicios"
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
          icon={CheckCircle2}
          label="Bancos involucrados"
          value={kpis.bancosUnicos.toString()}
          sub="Cuentas que pagaron"
          tone="neutral"
        />
      </section>

      {/* Monthly outflow strip */}
      {byMonth.length > 0 && (
        <section className="animate-card-in">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] mb-2 text-[var(--gray-500)]">
            Egreso real por mes (ya ejecutado)
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
          <select
            className="input max-w-[135px]"
            value={monedaFilter}
            onChange={(e) => setMonedaFilter(e.target.value)}
            title="Filtrar por moneda"
          >
            <option value="all">Todas monedas</option>
            {monedasDisponibles.map((moneda) => (
              <option key={moneda} value={moneda}>{moneda}</option>
            ))}
          </select>
          <select
            className="input max-w-[190px]"
            value={clasificacionFilter}
            onChange={(e) => setClasificacionFilter(e.target.value)}
            title="Filtrar por clasificación financiera"
          >
            <option value="all">Todas clasificaciones</option>
            {clasificacionesDisponibles.map((classification) => (
              <option key={classification} value={classification}>{classification}</option>
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
            title="Importe mínimo"
          />
          <input
            type="number"
            className="input max-w-[120px]"
            placeholder="Importe máx."
            value={amountMax}
            onChange={(e) => setAmountMax(e.target.value)}
            min="0"
            title="Importe máximo"
          />
          <select
            className="input max-w-[185px]"
            value={`${sort.key}:${sort.direction}`}
            onChange={(e) => {
              const [key, direction] = e.target.value.split(':') as [PagoSortKey, SortDirection];
              setSort({ key, direction });
            }}
            title="Ordenar registros"
          >
            <option value="fechaPago:desc">Fecha reciente primero</option>
            <option value="fechaPago:asc">Fecha antigua primero</option>
            <option value="importePesos:desc">Importe mayor primero</option>
            <option value="importePesos:asc">Importe menor primero</option>
            <option value="nombreProveedor:asc">Proveedor A-Z</option>
            <option value="nombreProveedor:desc">Proveedor Z-A</option>
            <option value="banco:asc">Banco A-Z</option>
            <option value="banco:desc">Banco Z-A</option>
            <option value="noPago:desc">No. pago mayor primero</option>
            <option value="noPago:asc">No. pago menor primero</option>
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
            {filteredRecords.length === visiblePagoProveedorRecords.length
              ? `${visiblePagoProveedorRecords.length.toLocaleString()} total`
              : `${filteredRecords.length.toLocaleString()} de ${visiblePagoProveedorRecords.length.toLocaleString()}`}
          </div>
        </div>

        {/* Table */}
        <div className="bg-white border border-[var(--gray-200)] rounded-[var(--radius)] overflow-hidden animate-card-in">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-[var(--surface-alt)] text-[var(--gray-400)] text-left text-[11px] uppercase tracking-wide sticky top-0 z-10">
                <tr>
                  <Th className="pl-5">Cía</Th>
                  <Th>Fecha</Th>
                  <Th>Beneficiario</Th>
                  <Th>RFC</Th>
                  <Th align="right">Importe</Th>
                  <Th>Banco</Th>
                  <Th>Pago</Th>
                  <Th>Tipo</Th>
                  <Th>Comentario</Th>
                </tr>
              </thead>
              <tbody>
                {filteredRecords.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="text-center text-[var(--gray-400)] py-14">
                      <div className="flex flex-col items-center gap-2">
                        {visiblePagoProveedorRecords.length === 0 ? (
                          <>
                            <CreditCard className="w-5 h-5 text-[var(--gray-300)]" />
                            <div className="text-[13px]">Sin pagos cargados.</div>
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
                  filteredRecords.slice(0, ROW_CAP).map((r, idx) => {
                    const isEmployee = isEmployeePayment(r);
                    return (
                      <tr
                        key={`${r.cia}-${r.noPago}`}
                        className={`group border-t border-[var(--gray-200)]/40 hover-row hover:bg-[var(--primary-muted)]/30 ${
                          idx % 2 === 1 ? 'bg-[var(--gray-50)]/40' : ''
                        }`}
                      >
                        <Td className="pl-5">
                          <span className="font-mono text-[11px] text-[var(--gray-500)]">{r.cia}</span>
                        </Td>
                        <Td>
                          <span className="text-[12px] tabular-nums text-[var(--gray-700)]">
                            {r.fechaPago || <span className="text-[var(--gray-300)]">—</span>}
                          </span>
                        </Td>
                        <Td>
                          <div
                            className="font-medium text-[var(--gray-950)] truncate max-w-[220px]"
                            title={r.nombreProveedor}
                          >
                            {r.nombreProveedor}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            {!isEmployee && (
                              <ProviderBadge
                                index={providerIndex}
                                jdeCode={r.claveProveedor}
                                name={r.nombreProveedor}
                              />
                            )}
                            {r.clasificacionProveedor && (
                              <span className="text-[10px] text-[var(--gray-400)] truncate" title={r.clasificacionProveedor}>
                                {r.clasificacionProveedor}
                              </span>
                            )}
                          </div>
                        </Td>
                        <Td>
                          <span className="font-mono text-[11px] text-[var(--gray-700)]">{r.rfcProveedor}</span>
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
                          {r.batchPago && (
                            <div className="text-[10px] font-mono text-[var(--gray-400)] mt-0.5">
                              Batch {r.batchPago}
                            </div>
                          )}
                        </Td>
                        <Td>
                          <Chip style={isEmployee ? CHIP_EMPLOYEE : CHIP_SUPPLIER} icon={isEmployee ? Users : Building2}>
                            {isEmployee ? 'Empleado' : 'Proveedor'}
                          </Chip>
                        </Td>
                        <Td>
                          <span
                            className="text-[11px] text-[var(--gray-600)] font-mono truncate inline-block max-w-[200px]"
                            title={r.comentarioPago}
                          >
                            {r.comentarioPago || <span className="text-[var(--gray-300)]">—</span>}
                          </span>
                        </Td>
                      </tr>
                    );
                  })
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

function comparePagoRecords(a: PagoProveedorRecord, b: PagoProveedorRecord, sort: PagoSort): number {
  const direction = sort.direction === 'asc' ? 1 : -1;
  if (sort.key === 'importePesos') return (a.importePesos - b.importePesos) * direction;
  const av = pagoSortValue(a, sort.key);
  const bv = pagoSortValue(b, sort.key);
  if (!av && !bv) return 0;
  if (!av) return 1;
  if (!bv) return -1;
  return av.localeCompare(bv, 'es-MX', { numeric: true }) * direction;
}

function pagoSortValue(record: PagoProveedorRecord, key: PagoSortKey): string {
  if (key === 'banco') return bancoLabel(record.cuentaBancaria);
  if (key === 'importePesos') return String(record.importePesos);
  return record[key] ?? '';
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
