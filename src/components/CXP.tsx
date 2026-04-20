import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import {
  Upload as UploadIcon,
  FileSpreadsheet,
  Loader2,
  AlertCircle,
  CheckCircle,
  Search,
  Building2,
  Clock,
  AlertTriangle,
  TrendingUp,
  ChevronDown,
  ChevronRight,
  X,
  ArrowUpDown,
  Receipt,
  Filter,
  RotateCcw,
  Database,
  RefreshCw,
} from 'lucide-react';
import { fetchAgedBalances, JdeApiError, type Company } from '../services/jde';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
  Treemap,
} from 'recharts';
import { hex, color } from '../theme';
import { fmtCompact, fmtCurrency, fmtSmart } from '../formatters';

/* ═══════════════════════════════════════════════════════════════════════
   Types
   ═══════════════════════════════════════════════════════════════════════ */

interface CXPRecord {
  cia: string;
  noProveedor: string;
  nombre: string;
  noFactura: string;
  fechaFactura: string;
  fechaVence: string;
  fechaProgramacionPago: string;
  diasVencida: number;
  importeBrutoPesos: number;
  importePendientePesos: number;
  importeSubtotalPesos: number;
  importeImpuestosPesos: number;
  importeBrutoDolares: number;
  importePendienteDolares: number;
  moneda: string;
  condPago: string;
  clasifica: string;
  clasificacionProveedor: string;
  edoPago: string;
  tipoCambio: number;
  porVencer: number;
  v1_30: number;
  v31_60: number;
  v61_90: number;
  v91_120: number;
  v121_150: number;
  v151_180: number;
  mas180: number;
}

interface AgingBucket {
  name: string;
  key: keyof CXPRecord;
  color: string;
  total: number;
  count: number;
}

type CXPView = 'upload' | 'dashboard';
type DashboardTab = 'resumen' | 'proveedores' | 'antiguedad';
type SortKey = 'nombre' | 'total' | 'count' | 'maxDias';
type SortDir = 'asc' | 'desc';

/* ═══════════════════════════════════════════════════════════════════════
   Constants
   ═══════════════════════════════════════════════════════════════════════ */

const AGING_COLORS = [hex.success, hex.primary, hex.info, hex.warning, '#ff6723', hex.danger, '#af52de', '#8e2d5c'];
const BUCKET_LABELS = ['Por Vencer','1-30','31-60','61-90','91-120','121-150','151-180','180+'];
const BUCKET_KEYS: (keyof CXPRecord)[] = ['porVencer','v1_30','v31_60','v61_90','v91_120','v121_150','v151_180','mas180'];
const PIE_COLORS = [hex.primary, hex.success, hex.warning, '#af52de', hex.danger, hex.info, '#ff6723', '#8e2d5c', '#30b0c7', '#a2845e'];
const PAGE_SIZE = 50;

/* ═══════════════════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════════════════ */

const parseNum = (val: string): number => {
  if (!val || val.trim() === '') return 0;
  const cleaned = val.replace(/"/g, '').replace(/,/g, '').trim();
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
};

/* fmt & fmtFull → imported from ../formatters as fmtCompact & fmtCurrency */
const fmt = fmtCompact;
const fmtFull = fmtCurrency;

const pct = (part: number, whole: number): string =>
  whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '0%';

/* ═══════════════════════════════════════════════════════════════════════
   CSV Parser — handles quoted fields, commas-in-numbers, \r\n
   ═══════════════════════════════════════════════════════════════════════ */

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur.trim());
  return result;
}

function parseCXP(text: string): CXPRecord[] {
  // Normalize line endings
  const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length < 2) throw new Error('CSV vacío o sin datos');

  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/"/g, '').trim());
  const colCount = headers.length;

  const idx = (name: string): number => headers.indexOf(name.toLowerCase());

  // Validate critical columns exist
  const required = ['cia','nombre','importe_pendiente_pesos','por_vencer'];
  const missing = required.filter(r => idx(r) < 0);
  if (missing.length) throw new Error(`Columnas faltantes: ${missing.join(', ')}`);

  const records: CXPRecord[] = [];
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    // Tolerate ±2 columns (some CSVs have trailing commas)
    if (fields.length < colCount - 2) { skipped++; continue; }

    const g = (name: string): string => {
      const ci = idx(name);
      return ci >= 0 && ci < fields.length ? fields[ci].replace(/"/g, '').trim() : '';
    };
    const n = (name: string): number => parseNum(g(name));

    records.push({
      cia: g('cia'),
      noProveedor: g('no_prov'),
      nombre: g('nombre'),
      noFactura: g('no_factura'),
      fechaFactura: g('fecha_factura'),
      fechaVence: g('fecha_vence'),
      fechaProgramacionPago: g('fecha_programacion_pago'),
      diasVencida: n('dias_vencida'),
      importeBrutoPesos: n('importe_bruto_pesos'),
      importePendientePesos: n('importe_pendiente_pesos'),
      importeSubtotalPesos: n('importe_subtotal_pesos'),
      importeImpuestosPesos: n('importe_impuestos_pesos'),
      importeBrutoDolares: n('importe_bruto_dolares'),
      importePendienteDolares: n('importe_pendiente_dolares'),
      moneda: g('moneda'),
      condPago: g('cond_pago'),
      clasifica: g('clasifica'),
      clasificacionProveedor: g('clasificacion_proveedor'),
      edoPago: g('edo_pago'),
      tipoCambio: n('tipo_cambio'),
      porVencer: n('por_vencer'),
      v1_30: n('v_1_30'),
      v31_60: n('v_31_60'),
      v61_90: n('v_61_90'),
      v91_120: n('v_91_120'),
      v121_150: n('v_121_150'),
      v151_180: n('v_151_180'),
      mas180: n('mas_180'),
    });
  }

  if (records.length === 0) throw new Error(`No se encontraron registros válidos (${skipped} filas omitidas)`);
  return records;
}

/* ═══════════════════════════════════════════════════════════════════════
   Upload Component
   ═══════════════════════════════════════════════════════════════════════ */

const CXPUpload = ({
  onDataLoaded,
  selectedCia,
}: {
  onDataLoaded: (r: CXPRecord[]) => void;
  selectedCia?: string;
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [count, setCount] = useState(0);
  const [source, setSource] = useState<'csv' | 'jde' | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  const handle = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.csv')) { setError('Solo archivos .csv'); return; }
    setSource('csv'); setLoading(true); setError(null);
    try {
      const text = await file.text();
      const recs = parseCXP(text);
      setCount(recs.length);
      setSuccess(true);
      onDataLoaded(recs);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al procesar');
      setLoading(false);
    }
  }, [onDataLoaded]);

  const loadFromJde = useCallback(async () => {
    if (!selectedCia || selectedCia === 'all') return;
    setSource('jde'); setLoading(true); setError(null);
    try {
      const records = await fetchAgedBalances({ cia: selectedCia });
      if (records.length === 0) throw new Error(`JDE devolvió 0 registros para la compañía ${selectedCia}`);
      setCount(records.length);
      setSuccess(true);
      onDataLoaded(records as CXPRecord[]);
    } catch (e) {
      if (e instanceof JdeApiError) {
        const hint = e.status === 401 ? ' — error de autenticación con el servidor' : '';
        setError(`JDE ${e.status}: ${e.message}${hint}`);
      } else {
        setError(e instanceof Error ? e.message : 'Error al consultar JDE');
      }
      setLoading(false);
    }
  }, [selectedCia, onDataLoaded]);

  const jdeDisabled = !selectedCia || selectedCia === 'all';

  const onDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    setDragActive(e.type === 'dragenter' || e.type === 'dragover');
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setDragActive(false);
    if (e.dataTransfer.files?.length) handle(e.dataTransfer.files[0]);
  }, [handle]);

  const retry = () => {
    setError(null);
    if (source === 'jde') loadFromJde();
    else ref.current?.click();
  };

  return (
    <div className="w-full max-w-3xl mx-auto">
      <div className="text-center mb-8">
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[var(--primary)] to-[var(--info)] flex items-center justify-center mx-auto mb-4 shadow-lg shadow-[var(--primary)]/15">
          <Clock className="text-white" size={26} />
        </div>
        <h1 className="text-[28px] font-bold text-[var(--gray-950)] tracking-tight">Cuentas por Pagar</h1>
        <p className="text-[15px] text-[var(--gray-400)] mt-1">Análisis de antigüedad de saldos CXP</p>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-[var(--gray-200)] p-8">
        {!loading && !success && !error && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* ── JDE ── */}
            <div className={`border-2 rounded-2xl p-10 text-center transition-all ${
              jdeDisabled ? 'border-[var(--gray-100)] bg-[var(--surface-alt)]' : 'border-[var(--primary)]/30 bg-[var(--primary-subtle)] hover:border-[var(--primary)] hover:bg-[var(--primary-muted)]'
            }`}>
              <Database className={`w-10 h-10 mx-auto mb-3 ${jdeDisabled ? 'text-[var(--gray-300)]' : 'text-[var(--primary)]'}`} />
              <p className="text-[15px] font-semibold text-[var(--gray-950)]">Consultar desde JDE</p>
              <p className="text-[12px] text-[var(--gray-400)] mt-1">
                Compañía: <span className="font-medium text-[var(--gray-950)]">
                  {jdeDisabled ? '— selecciona en el header —' : selectedCia}
                </span>
              </p>
              <button
                onClick={loadFromJde}
                disabled={jdeDisabled}
                title={jdeDisabled ? 'Selecciona una compañía en el header primero' : undefined}
                className="mt-4 inline-flex items-center gap-2 px-5 h-10 rounded-xl bg-[var(--primary)] text-white text-[13.5px] font-medium hover:bg-[var(--primary-hover)] shadow-sm shadow-[var(--primary)]/20 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                <Database className="w-4 h-4" />
                Consultar Antigüedad
              </button>
            </div>

            {/* ── CSV ── */}
            <div
              onDragEnter={onDrag} onDragLeave={onDrag} onDragOver={onDrag} onDrop={onDrop}
              onClick={() => ref.current?.click()}
              className={`border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-all ${
                dragActive ? 'border-[var(--primary)] bg-[var(--primary-muted)]' : 'border-[var(--gray-200)] hover:border-[var(--primary)] hover:bg-[var(--gray-50)]'
              }`}
            >
              <FileSpreadsheet className="w-10 h-10 text-[var(--gray-400)] mx-auto mb-3" />
              <p className="text-[15px] font-semibold text-[var(--gray-950)]">Arrastra tu CSV aquí</p>
              <p className="text-[13px] text-[var(--gray-400)] mt-1">o haz click para seleccionar archivo</p>
              <input ref={ref} type="file" accept=".csv" className="hidden" onChange={e => e.target.files?.[0] && handle(e.target.files[0])} />
            </div>
          </div>
        )}

        {loading && !success && (
          <div className="text-center py-16">
            <Loader2 className="w-8 h-8 text-[var(--primary)] animate-spin mx-auto mb-3" />
            <p className="text-[15px] font-medium text-[var(--gray-950)]">
              {source === 'jde' ? `Consultando JDE (compañía ${selectedCia})...` : 'Procesando archivo...'}
            </p>
          </div>
        )}

        {success && (
          <div className="text-center py-14">
            <CheckCircle className="w-12 h-12 text-[var(--success)] mx-auto mb-3" />
            <p className="text-[15px] font-semibold text-[var(--gray-950)]">{count.toLocaleString()} registros cargados</p>
            <p className="text-[13px] text-[var(--gray-400)] mt-1">
              {source === 'jde' ? `Desde JDE · compañía ${selectedCia}` : 'Desde archivo CSV'} — abriendo análisis...
            </p>
          </div>
        )}

        {error && (
          <div className="bg-[var(--danger-muted)] border border-red-100 rounded-xl p-5">
            <div className="flex items-start gap-3">
              <AlertCircle className="text-[var(--danger)] flex-shrink-0 mt-0.5" size={18} />
              <div className="flex-1">
                <p className="text-[14px] font-semibold text-[var(--gray-950)]">
                  {source === 'jde' ? 'Error al consultar JDE' : 'Error al procesar'}
                </p>
                <p className="text-[13px] text-[var(--gray-500)] mt-1">{error}</p>
                <button onClick={retry}
                  className="mt-3 text-[13px] font-medium text-[var(--primary)] hover:text-[var(--primary-hover)]">
                  Intentar de nuevo
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════════
   Custom Tooltip
   ═══════════════════════════════════════════════════════════════════════ */

const ChartTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.[0]) return null;
  return (
    <div className="bg-white/95 backdrop-blur-xl border border-[var(--gray-200)]/60 rounded-xl px-3 py-2 shadow-lg">
      <p className="text-[12px] font-semibold text-[var(--gray-950)]">{payload[0].payload.name || payload[0].name}</p>
      <p className="text-[12px] font-mono text-[var(--gray-500)]">{fmtFull(payload[0].value)}</p>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════════
   Dashboard
   ═══════════════════════════════════════════════════════════════════════ */

const CXPDashboard = ({ records, onReset, companies: compCatalog }: { records: CXPRecord[]; onReset: () => void; companies?: Company[] }) => {
  /** Resolve a cia code (e.g. "00011") to its short name from the catalog. */
  const ciaName = useCallback((code: string): string => {
    if (!compCatalog) return code;
    const found = compCatalog.find(c => c.cia === code);
    if (!found) return code;
    // Strip the code prefix if the nombre already starts with it (e.g. "00011 - Servicio Industrial...")
    const nombre = found.nombre;
    const prefix = `${code} - `;
    return nombre.startsWith(prefix) ? nombre.slice(prefix.length).trim() : nombre;
  }, [compCatalog]);
  const [tab, setTab] = useState<DashboardTab>('resumen');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCia, setSelectedCia] = useState('all');
  const [expandedSupplier, setExpandedSupplier] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('total');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [provPage, setProvPage] = useState(0);

  // Drilldown state
  const [activeBucket, setActiveBucket] = useState<string | null>(null);
  const [activeClassification, setActiveClassification] = useState<string | null>(null);
  const [activeKpi, setActiveKpi] = useState<string | null>(null);

  const clearDrill = () => { setActiveBucket(null); setActiveClassification(null); setActiveKpi(null); setProvPage(0); };
  const hasDrill = activeBucket || activeClassification || activeKpi;
  const drillLabel = activeBucket ? `Bucket "${activeBucket}"` :
    activeClassification ? `Clasificación "${activeClassification}"` :
    activeKpi === 'porVencer' ? 'Por Vencer' :
    activeKpi === 'vencido' ? 'Total Vencido' :
    activeKpi === 'mas90' ? 'Vencido > 90 días' : '';

  // Reset local filters when parent switches company (records no longer include the selected cia)
  useEffect(() => {
    if (selectedCia !== 'all' && !records.some(r => r.cia === selectedCia)) {
      setSelectedCia('all');
      setActiveBucket(null);
      setActiveClassification(null);
      setActiveKpi(null);
      setExpandedSupplier(null);
      setProvPage(0);
    }
  }, [records, selectedCia]);

  // ── Filtered Records ──
  const filtered = useMemo(() => {
    let f = records;
    if (selectedCia !== 'all') f = f.filter(r => r.cia === selectedCia);
    if (searchTerm) {
      const t = searchTerm.toLowerCase();
      f = f.filter(r => r.nombre.toLowerCase().includes(t) || r.noFactura.toLowerCase().includes(t) || r.noProveedor.includes(t));
    }
    if (activeBucket) {
      const bi = BUCKET_LABELS.indexOf(activeBucket);
      if (bi >= 0) { const k = BUCKET_KEYS[bi]; f = f.filter(r => (r[k] as number) > 0); }
    }
    if (activeClassification) f = f.filter(r => (r.clasificacionProveedor?.trim() || 'Sin Clasificar') === activeClassification);
    if (activeKpi === 'porVencer') f = f.filter(r => r.porVencer > 0);
    else if (activeKpi === 'vencido') f = f.filter(r => (r.v1_30 + r.v31_60 + r.v61_90 + r.v91_120 + r.v121_150 + r.v151_180 + r.mas180) > 0);
    else if (activeKpi === 'mas90') f = f.filter(r => (r.v91_120 + r.v121_150 + r.v151_180 + r.mas180) > 0);
    return f;
  }, [records, selectedCia, searchTerm, activeBucket, activeClassification, activeKpi]);

  // ── Derived Data ──
  const companies = useMemo(() => Array.from(new Set(records.map(r => r.cia))).sort(), [records]);

  const agingBuckets: AgingBucket[] = useMemo(() =>
    BUCKET_KEYS.map((key, i) => ({
      name: BUCKET_LABELS[i], key, color: AGING_COLORS[i],
      total: filtered.reduce((s, r) => s + (r[key] as number), 0),
      count: filtered.filter(r => (r[key] as number) > 0).length,
    })), [filtered]);

  const totalPendiente = useMemo(() => filtered.reduce((s, r) => s + r.importePendientePesos, 0), [filtered]);
  const totalVencido = useMemo(() => agingBuckets.slice(1).reduce((s, b) => s + b.total, 0), [agingBuckets]);
  const totalPorVencer = agingBuckets[0]?.total || 0;
  const totalMas90 = useMemo(() => agingBuckets.slice(4).reduce((s, b) => s + b.total, 0), [agingBuckets]);

  // Supplier aggregation
  const supplierData = useMemo(() => {
    const map = new Map<string, { nombre: string; total: number; count: number; maxDias: number; records: CXPRecord[] }>();
    filtered.forEach(r => {
      const k = r.nombre || 'SIN NOMBRE';
      if (!map.has(k)) map.set(k, { nombre: k, total: 0, count: 0, maxDias: 0, records: [] });
      const e = map.get(k)!;
      e.total += r.importePendientePesos;
      e.count++;
      e.maxDias = Math.max(e.maxDias, r.diasVencida);
      e.records.push(r);
    });
    const arr = Array.from(map.values());
    arr.sort((a, b) => {
      const mul = sortDir === 'desc' ? -1 : 1;
      if (sortKey === 'nombre') return mul * a.nombre.localeCompare(b.nombre);
      return mul * ((a[sortKey] as number) - (b[sortKey] as number));
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  // Classification — top 8 + "Otros"
  const classData = useMemo(() => {
    const map = new Map<string, number>();
    filtered.forEach(r => {
      const k = r.clasificacionProveedor?.trim() || 'Sin Clasificar';
      map.set(k, (map.get(k) || 0) + r.importePendientePesos);
    });
    const all = Array.from(map.entries()).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
    if (all.length <= 8) return all;
    const top = all.slice(0, 7);
    const otrosVal = all.slice(7).reduce((s, x) => s + x.value, 0);
    return [...top, { name: `Otros (${all.length - 7})`, value: otrosVal }];
  }, [filtered]);

  // Company breakdown — show names instead of codes
  const ciaData = useMemo(() => {
    const map = new Map<string, number>();
    filtered.forEach(r => map.set(r.cia, (map.get(r.cia) || 0) + r.importePendientePesos));
    return Array.from(map.entries())
      .map(([code, value]) => ({ name: ciaName(code), value }))
      .sort((a, b) => b.value - a.value);
  }, [filtered, ciaName]);

  // Pagination
  const totalPages = Math.ceil(supplierData.length / PAGE_SIZE);
  const pagedSuppliers = supplierData.slice(provPage * PAGE_SIZE, (provPage + 1) * PAGE_SIZE);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortKey(k); setSortDir('desc'); }
    setProvPage(0);
  };

  const tabs: { id: DashboardTab; label: string; count?: number }[] = [
    { id: 'resumen', label: 'Resumen' },
    { id: 'proveedores', label: 'Proveedores', count: supplierData.length },
    { id: 'antiguedad', label: 'Antigüedad' },
  ];

  /* ── Render ── */
  return (
    <div className="space-y-4">
      {/* ── Header Bar ── */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center bg-white rounded-full border border-[var(--gray-200)] px-3 py-1.5 gap-2 shadow-sm">
          <Search className="w-3.5 h-3.5 text-[var(--gray-400)]" />
          <input type="text" placeholder="Buscar proveedor, factura, # prov..."
            value={searchTerm} onChange={e => { setSearchTerm(e.target.value); setProvPage(0); }}
            className="text-[13px] bg-transparent border-none outline-none w-56 placeholder:text-[var(--gray-300)]" />
          {searchTerm && <button onClick={() => setSearchTerm('')}><X className="w-3.5 h-3.5 text-[var(--gray-400)]" /></button>}
        </div>

        <select value={selectedCia} onChange={e => { setSelectedCia(e.target.value); setProvPage(0); }}
          className="text-[13px] bg-white rounded-full border border-[var(--gray-200)] px-4 py-1.5 shadow-sm text-[var(--gray-950)] cursor-pointer">
          <option value="all">Todas las compañías</option>
          {companies.map(c => <option key={c} value={c}>{ciaName(c)}</option>)}
        </select>

        <div className="flex items-center gap-1 text-[12px] text-[var(--gray-400)] bg-[var(--gray-50)] rounded-full px-3 py-1.5">
          <Receipt className="w-3.5 h-3.5" />
          {filtered.length.toLocaleString()} facturas
        </div>

        {/* Sub-tabs — right aligned */}
        <div className="ml-auto flex items-center bg-[var(--gray-50)]/80 rounded-full p-[3px] gap-[2px]">
          {tabs.map(t => {
            const isActive = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`relative px-3.5 py-[6px] rounded-full text-[12.5px] font-medium transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] flex items-center gap-1.5 ${
                  isActive ? 'text-[var(--gray-950)]' : 'text-[var(--gray-400)] hover:text-[var(--gray-700)]'
                }`}>
                {isActive && (
                  <span className="absolute inset-0 bg-white rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.08),0_0_1px_rgba(0,0,0,0.04)] animate-scale-in" />
                )}
                <span className="relative flex items-center gap-1.5">
                  {t.label}
                  {t.count !== undefined && <span className="text-[11px] text-[var(--gray-400)]">({t.count})</span>}
                </span>
              </button>
            );
          })}
        </div>

        <button onClick={onReset} className="text-[12px] text-[var(--gray-400)] hover:text-[var(--danger)] flex items-center gap-1 transition">
          <RotateCcw className="w-3 h-3" /> Nuevo archivo
        </button>
      </div>

      {/* ── Drilldown Banner ── */}
      {hasDrill && (
        <div className="bg-[var(--primary-muted)] border border-[var(--primary)]/20 rounded-xl px-4 py-2.5 flex items-center justify-between animate-slide-down">
          <div className="flex items-center gap-2 text-[13px] text-[var(--primary)] font-medium">
            <Filter className="w-3.5 h-3.5" />
            Filtrando: {drillLabel} — {filtered.length.toLocaleString()} registros
          </div>
          <button onClick={clearDrill} className="text-[13px] font-medium text-[var(--primary)] hover:text-[var(--primary-hover)] flex items-center gap-1 hover-press">
            <X className="w-3.5 h-3.5" /> Limpiar
          </button>
        </div>
      )}

      {/* ── KPI Cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Saldo Total CXP', value: totalPendiente, sub: `${supplierData.length} proveedores · ${filtered.length.toLocaleString()} facturas`, icon: Building2, color: hex.primary, kpi: null as string | null },
          { label: 'Por Vencer', value: totalPorVencer, sub: pct(totalPorVencer, totalPendiente) + ' del total', icon: Clock, color: hex.success, kpi: 'porVencer' },
          { label: 'Total Vencido', value: totalVencido, sub: pct(totalVencido, totalPendiente) + ' del total', icon: AlertTriangle, color: hex.warning, kpi: 'vencido' },
          { label: 'Vencido > 90 días', value: totalMas90, sub: pct(totalMas90, totalPendiente) + ' del total', icon: TrendingUp, color: hex.danger, kpi: 'mas90' },
        ].map((kpi, i) => {
          const Icon = kpi.icon;
          const active = activeKpi === kpi.kpi && kpi.kpi !== null;
          return (
            <div key={i}
              onClick={() => {
                if (!kpi.kpi) { clearDrill(); return; }
                clearDrill();
                setActiveKpi(activeKpi === kpi.kpi ? null : kpi.kpi);
                setTab('proveedores');
              }}
              className={`animate-card-in stagger-${i + 1} bg-white rounded-2xl border p-4 shadow-sm hover-lift cursor-pointer ${
                active ? 'border-[var(--primary)] ring-2 ring-[var(--primary)]/20' : 'border-[var(--gray-200)]'
              }`}>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[11px] font-medium text-[var(--gray-400)] uppercase tracking-wider">{kpi.label}</p>
                <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ backgroundColor: kpi.color + '14' }}>
                  <Icon className="w-3.5 h-3.5" style={{ color: kpi.color }} />
                </div>
              </div>
              <p className="text-[22px] font-bold font-mono tracking-tight text-[var(--gray-950)]">
                {fmt(kpi.value as number)}
              </p>
              <p className="text-[11px] text-[var(--gray-400)] mt-0.5">{kpi.sub}</p>
            </div>
          );
        })}
      </div>

      {/* ════════════════════════════════════════════════════════════════
         RESUMEN TAB
         ════════════════════════════════════════════════════════════════ */}
      {tab === 'resumen' && (
        <>
          {/* Aging Bar Chart */}
          <div className="bg-white rounded-2xl border border-[var(--gray-200)] p-5 shadow-sm animate-card-in stagger-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">Distribución por Antigüedad</h2>
              <p className="text-[12px] text-[var(--gray-400)]">Click en barra para filtrar</p>
            </div>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={agingBuckets} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                <CartesianGrid stroke="var(--gray-100)" strokeDasharray="0" vertical={false} />
                <XAxis dataKey="name" tick={{ fill: 'var(--gray-400)', fontSize: 11 }} axisLine={{ stroke: 'var(--gray-100)' }} tickLine={false} />
                <YAxis tick={{ fill: 'var(--gray-400)', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} />
                <Tooltip content={<ChartTooltip />} />
                <Bar dataKey="total" radius={[6, 6, 0, 0]} cursor="pointer"
                  onClick={(data: any) => { clearDrill(); setActiveBucket(activeBucket === data.name ? null : data.name); setTab('proveedores'); }}>
                  {agingBuckets.map((b, i) => (
                    <Cell key={i} fill={b.color}
                      fillOpacity={activeBucket === b.name ? 1 : activeBucket ? 0.25 : 0.85}
                      stroke={activeBucket === b.name ? b.color : 'none'} strokeWidth={activeBucket === b.name ? 2 : 0} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            {/* Bucket summary chips */}
            <div className="flex gap-2 mt-3 flex-wrap">
              {agingBuckets.filter(b => b.total > 0).map((b, i) => (
                <div key={i} className="flex items-center gap-1.5 bg-[var(--gray-50)] rounded-full px-2.5 py-1 text-[11px]">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: b.color }} />
                  <span className="text-[var(--gray-500)]">{b.name}:</span>
                  <span className="font-mono font-semibold text-[var(--gray-950)]">{fmt(b.total)}</span>
                  <span className="text-[var(--gray-400)]">({b.count})</span>
                </div>
              ))}
            </div>
          </div>

          {/* Two columns: Clasificación + Top Proveedores */}
          <div className="grid grid-cols-2 gap-4 animate-card-in stagger-7">
            {/* Classification Donut */}
            <div className="bg-white rounded-2xl border border-[var(--gray-200)] p-5 shadow-sm overflow-hidden hover-lift">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">Por Clasificación</h2>
                <p className="text-[12px] text-[var(--gray-400)]">Click para filtrar</p>
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={classData} cx="50%" cy="50%" innerRadius={45} outerRadius={85}
                    paddingAngle={2} dataKey="value" cursor="pointer"
                    onClick={(data: any) => { clearDrill(); setActiveClassification(activeClassification === data.name ? null : data.name); setTab('proveedores'); }}>
                    {classData.map((e, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]}
                        fillOpacity={activeClassification === e.name ? 1 : activeClassification ? 0.25 : 0.85}
                        stroke={activeClassification === e.name ? PIE_COLORS[i % PIE_COLORS.length] : 'none'}
                        strokeWidth={activeClassification === e.name ? 3 : 0} />
                    ))}
                  </Pie>
                  <Tooltip content={<ChartTooltip />} />
                </PieChart>
              </ResponsiveContainer>
              {/* Custom compact legend */}
              <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
                {classData.map((e, i) => (
                  <button key={i} onClick={() => { clearDrill(); setActiveClassification(activeClassification === e.name ? null : e.name); setTab('proveedores'); }}
                    className="flex items-center gap-1 text-[10px] hover:opacity-70 transition">
                    <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
                    <span className="text-[var(--gray-500)] truncate max-w-[100px]">{e.name}</span>
                    <span className="font-mono text-[var(--gray-950)] font-medium">{fmt(e.value)}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Top 10 Proveedores */}
            <div className="bg-white rounded-2xl border border-[var(--gray-200)] p-5 shadow-sm hover-lift">
              <h2 className="text-[15px] font-semibold text-[var(--gray-950)] mb-3">Top 10 Proveedores</h2>
              <div className="space-y-1.5">
                {supplierData.slice(0, 10).map((s, i) => {
                  const barPct = supplierData[0]?.total > 0 ? (s.total / supplierData[0].total) : 0;
                  return (
                    <div key={i}
                      className="flex items-center gap-2.5 py-1.5 px-2 -mx-2 cursor-pointer hover:bg-[var(--gray-50)] rounded-lg transition-all duration-200"
                      onClick={() => { clearDrill(); setSearchTerm(s.nombre.slice(0, 20)); setTab('proveedores'); setExpandedSupplier(s.nombre); setProvPage(0); }}>
                      <span className="text-[11px] font-mono text-[var(--gray-400)] w-4 text-right">{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-[12px] font-medium text-[var(--primary)] truncate">{s.nombre}</p>
                        <div className="bg-[var(--gray-100)] rounded-full h-1.5 mt-1 overflow-hidden">
                          <div className="h-full rounded-full bg-[var(--primary)]/60" style={{ width: `${barPct * 100}%` }} />
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-[12px] font-mono font-semibold text-[var(--gray-950)]">{fmt(s.total)}</p>
                        <p className="text-[10px] text-[var(--gray-400)]">{s.count} fact.</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Company breakdown (if multiple) */}
          {ciaData.length > 1 && (
            <div className="bg-white rounded-2xl border border-[var(--gray-200)] p-5 shadow-sm animate-card-in stagger-9">
              <h2 className="text-[15px] font-semibold text-[var(--gray-950)] mb-4">Desglose por Compañía</h2>
              <div className="grid grid-cols-2 gap-3">
                {ciaData.map((c, i) => (
                  <div key={i} className="flex items-center gap-3 p-3 bg-[var(--surface-alt)] rounded-xl">
                    <div className="w-2 h-8 rounded-full" style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-medium text-[var(--gray-950)] truncate">{c.name}</p>
                      <p className="text-[11px] text-[var(--gray-400)]">{pct(c.value, totalPendiente)}</p>
                    </div>
                    <p className="text-[13px] font-mono font-semibold text-[var(--gray-950)]">{fmt(c.value)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* ════════════════════════════════════════════════════════════════
         PROVEEDORES TAB
         ════════════════════════════════════════════════════════════════ */}
      {tab === 'proveedores' && (
        <div className="bg-white rounded-2xl border border-[var(--gray-200)] shadow-sm overflow-hidden">
          {/* Header with sort controls */}
          <div className="p-4 border-b border-[var(--gray-100)] flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">
              Proveedores
              <span className="text-[var(--gray-400)] font-normal ml-1">({supplierData.length.toLocaleString()})</span>
            </h2>
            <div className="flex items-center gap-1">
              {([
                ['total', 'Monto'],
                ['count', 'Facturas'],
                ['maxDias', 'Días'],
                ['nombre', 'Nombre'],
              ] as [SortKey, string][]).map(([k, label]) => (
                <button key={k} onClick={() => toggleSort(k)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition flex items-center gap-1 ${
                    sortKey === k ? 'bg-[var(--primary)] text-white' : 'bg-[var(--gray-50)] text-[var(--gray-500)] hover:bg-[var(--gray-100)]'
                  }`}>
                  {label}
                  {sortKey === k && <ArrowUpDown className="w-2.5 h-2.5" />}
                </button>
              ))}
            </div>
          </div>

          {/* Supplier list */}
          <div className="divide-y divide-[var(--gray-50)]">
            {pagedSuppliers.map(s => {
              const isExpanded = expandedSupplier === s.nombre;
              const vencido = s.records.reduce((sum, r) => sum + r.v1_30 + r.v31_60 + r.v61_90 + r.v91_120 + r.v121_150 + r.v151_180 + r.mas180, 0);
              const severity = s.maxDias > 120 ? hex.danger : s.maxDias > 60 ? hex.warning : s.maxDias > 0 ? hex.primary : hex.success;

              return (
                <div key={s.nombre}>
                  <button onClick={() => setExpandedSupplier(isExpanded ? null : s.nombre)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[var(--gray-50)] transition text-left">
                    {isExpanded ? <ChevronDown className="w-4 h-4 text-[var(--gray-400)]" /> : <ChevronRight className="w-4 h-4 text-[var(--gray-400)]" />}

                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium text-[var(--gray-950)] truncate">{s.nombre}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[11px] text-[var(--gray-400)]">{s.count} factura{s.count !== 1 ? 's' : ''}</span>
                        {s.maxDias > 0 && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full" style={{ backgroundColor: severity + '14', color: severity }}>
                            máx {s.maxDias}d
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Mini aging bar */}
                    <div className="w-40 flex h-2.5 rounded-full overflow-hidden bg-[var(--gray-100)]">
                      {BUCKET_KEYS.map((key, bi) => {
                        const bval = s.records.reduce((sum, r) => sum + (r[key] as number), 0);
                        const bpct = s.total > 0 ? (bval / s.total) * 100 : 0;
                        return bpct > 0 ? <div key={bi} style={{ width: `${bpct}%`, backgroundColor: AGING_COLORS[bi] }} /> : null;
                      })}
                    </div>

                    <div className="text-right w-28">
                      <p className="text-[13px] font-mono font-semibold text-[var(--gray-950)]">{fmt(s.total)}</p>
                      {vencido > 0 && <p className="text-[10px] font-mono text-[var(--danger)]">{fmt(vencido)} vencido</p>}
                    </div>
                  </button>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div className="bg-[var(--surface-alt)] px-4 pb-3">
                      {/* Aging summary for this supplier */}
                      <div className="flex gap-1.5 mb-3 flex-wrap">
                        {BUCKET_KEYS.map((key, bi) => {
                          const bval = s.records.reduce((sum, r) => sum + (r[key] as number), 0);
                          if (bval === 0) return null;
                          return (
                            <div key={bi} className="flex items-center gap-1 bg-white rounded-full px-2 py-0.5 text-[10px] border border-[var(--gray-100)]">
                              <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: AGING_COLORS[bi] }} />
                              <span className="text-[var(--gray-500)]">{BUCKET_LABELS[bi]}:</span>
                              <span className="font-mono font-medium text-[var(--gray-950)]">{fmt(bval)}</span>
                            </div>
                          );
                        })}
                      </div>

                      <div className="overflow-x-auto">
                        <table className="w-full text-[11px]">
                          <thead>
                            <tr className="border-b border-[var(--gray-100)]">
                              <th className="text-left py-2 text-[var(--gray-400)] font-semibold">Factura</th>
                              <th className="text-left py-2 text-[var(--gray-400)] font-semibold">F. Factura</th>
                              <th className="text-left py-2 text-[var(--gray-400)] font-semibold">Vence</th>
                              <th className="text-right py-2 text-[var(--gray-400)] font-semibold">Días</th>
                              <th className="text-right py-2 text-[var(--gray-400)] font-semibold">Pendiente</th>
                              <th className="text-left py-2 text-[var(--gray-400)] font-semibold pl-3">Mon.</th>
                              <th className="text-left py-2 text-[var(--gray-400)] font-semibold">Cond. Pago</th>
                            </tr>
                          </thead>
                          <tbody>
                            {s.records.sort((a, b) => b.diasVencida - a.diasVencida).map((r, ri) => (
                              <tr key={ri} className="border-b border-[var(--gray-50)]">
                                <td className="py-1.5 font-mono text-[var(--gray-950)]">{r.noFactura}</td>
                                <td className="py-1.5 text-[var(--gray-500)]">{r.fechaFactura}</td>
                                <td className="py-1.5 text-[var(--gray-500)]">{r.fechaVence}</td>
                                <td className="py-1.5 text-right font-mono">
                                  <span className={r.diasVencida > 90 ? 'text-[var(--danger)] font-semibold' : r.diasVencida > 30 ? 'text-[var(--warning)]' : 'text-[var(--gray-950)]'}>
                                    {r.diasVencida}
                                  </span>
                                </td>
                                <td className="py-1.5 text-right font-mono font-medium text-[var(--gray-950)]">{fmtFull(r.importePendientePesos)}</td>
                                <td className="py-1.5 pl-3 text-[var(--gray-400)]">{r.moneda}</td>
                                <td className="py-1.5 text-[var(--gray-400)]">{r.condPago}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="px-4 py-3 border-t border-[var(--gray-100)] flex items-center justify-between">
              <p className="text-[12px] text-[var(--gray-400)]">
                Mostrando {provPage * PAGE_SIZE + 1}–{Math.min((provPage + 1) * PAGE_SIZE, supplierData.length)} de {supplierData.length.toLocaleString()}
              </p>
              <div className="flex gap-1">
                <button onClick={() => setProvPage(p => Math.max(0, p - 1))} disabled={provPage === 0}
                  className="px-3 py-1 rounded-lg text-[12px] font-medium bg-[var(--gray-50)] text-[var(--gray-500)] hover:bg-[var(--gray-100)] disabled:opacity-30 transition">
                  Anterior
                </button>
                <span className="px-3 py-1 text-[12px] text-[var(--gray-400)]">{provPage + 1} / {totalPages}</span>
                <button onClick={() => setProvPage(p => Math.min(totalPages - 1, p + 1))} disabled={provPage >= totalPages - 1}
                  className="px-3 py-1 rounded-lg text-[12px] font-medium bg-[var(--gray-50)] text-[var(--gray-500)] hover:bg-[var(--gray-100)] disabled:opacity-30 transition">
                  Siguiente
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════
         ANTIGÜEDAD TAB
         ════════════════════════════════════════════════════════════════ */}
      {tab === 'antiguedad' && (
        <div className="bg-white rounded-2xl border border-[var(--gray-200)] shadow-sm overflow-hidden">
          <div className="p-4 border-b border-[var(--gray-100)] flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">Matriz de Antigüedad por Proveedor</h2>
            <p className="text-[12px] text-[var(--gray-400)]">Top {Math.min(100, supplierData.length)} proveedores por monto</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-white z-10">
                <tr className="border-b-2 border-[var(--gray-200)]">
                  <th className="text-left py-2.5 px-3 text-[var(--gray-400)] font-semibold w-[200px] min-w-[200px]">Proveedor</th>
                  <th className="text-right py-2.5 px-2 text-[var(--gray-400)] font-semibold w-[90px]">Total</th>
                  <th className="text-center py-2.5 px-1 text-[var(--gray-400)] font-semibold w-[40px]">#</th>
                  {BUCKET_LABELS.map((label, i) => (
                    <th key={i} className="text-right py-2.5 px-2 font-semibold w-[85px]" style={{ color: AGING_COLORS[i] }}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {supplierData.slice(0, 100).map((s, si) => {
                  const bucketVals = BUCKET_KEYS.map(key => s.records.reduce((sum, r) => sum + (r[key] as number), 0));
                  const maxBucket = Math.max(...bucketVals);
                  return (
                    <tr key={si} className="border-b border-[var(--gray-50)] hover:bg-[var(--gray-50)] transition">
                      <td className="py-2 px-3 font-medium text-[var(--gray-950)] truncate max-w-[200px]" title={s.nombre}>{s.nombre}</td>
                      <td className="py-2 px-2 text-right font-mono font-semibold text-[var(--gray-950)]">{fmt(s.total)}</td>
                      <td className="py-2 px-1 text-center text-[var(--gray-400)]">{s.count}</td>
                      {bucketVals.map((val, bi) => {
                        const intensity = maxBucket > 0 ? Math.min(val / maxBucket, 1) : 0;
                        return (
                          <td key={bi} className="py-2 px-2 text-right font-mono">
                            {val > 0 ? (
                              <span className="inline-block px-1.5 py-0.5 rounded"
                                style={{
                                  color: AGING_COLORS[bi],
                                  backgroundColor: AGING_COLORS[bi] + (intensity > 0.5 ? '20' : '0a'),
                                  fontWeight: intensity > 0.5 ? 600 : 400,
                                }}>
                                {fmt(val)}
                              </span>
                            ) : (
                              <span className="text-[var(--gray-200)]">—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                {/* Totals */}
                <tr className="border-t-2 border-[var(--gray-200)] bg-[var(--gray-50)] font-semibold sticky bottom-0">
                  <td className="py-2.5 px-3 text-[var(--gray-950)]">TOTAL</td>
                  <td className="py-2.5 px-2 text-right font-mono text-[var(--gray-950)]">{fmt(totalPendiente)}</td>
                  <td className="py-2.5 px-1 text-center text-[var(--gray-400)]">{filtered.length}</td>
                  {agingBuckets.map((b, i) => (
                    <td key={i} className="py-2.5 px-2 text-right font-mono font-bold" style={{ color: b.color }}>{fmt(b.total)}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════════
   Main CXP Component — per-cia cache + auto-fetch
   ═══════════════════════════════════════════════════════════════════════ */

interface CXPProps {
  records: CXPRecord[];
  loadedCias: Record<string, string>;
  companies: Company[];
  selectedCia: string;
  onMergeCia: (cia: string, records: CXPRecord[]) => void;
  onReplaceAll: (records: CXPRecord[], cias: string[]) => void;
  onReset: () => void;
}

const CXP = ({
  records,
  loadedCias,
  companies,
  selectedCia,
  onMergeCia,
  onReplaceAll,
  onReset,
}: CXPProps) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCsv, setShowCsv] = useState(false);
  const csvInput = useRef<HTMLInputElement>(null);
  const autoFetchAttempted = useRef<Set<string>>(new Set());

  const activeCias = useMemo(
    () => companies.filter(c => c.activa !== false).map(c => c.cia),
    [companies],
  );
  const loadedCiaList = useMemo(() => Object.keys(loadedCias), [loadedCias]);

  // Visible records = filtered by header's selectedCia
  const visibleRecords = useMemo(() => {
    if (selectedCia === 'all') return records;
    return records.filter(r => r.cia === selectedCia);
  }, [records, selectedCia]);

  const hasData = visibleRecords.length > 0;
  const isCurrentCiaLoaded = selectedCia === 'all'
    ? loadedCiaList.length > 0
    : loadedCias[selectedCia] !== undefined;

  const loadSingle = useCallback(async (cia: string) => {
    setLoading(true); setError(null);
    try {
      const data = await fetchAgedBalances({ cia });
      // Stamp the requested cia so downstream filtering is consistent, even if
      // JDE doesn't echo the field back (or returns it in a different format).
      const stamped = (data as CXPRecord[]).map(r => ({ ...r, cia }));
      onMergeCia(cia, stamped);
    } catch (e) {
      if (e instanceof JdeApiError) {
        const hint = e.status === 401 ? ' — error de autenticación con el servidor' : '';
        setError(`JDE ${e.status}: ${e.message}${hint}`);
      } else {
        setError(e instanceof Error ? e.message : 'Error al consultar JDE');
      }
    } finally {
      setLoading(false);
    }
  }, [onMergeCia]);

  const loadAll = useCallback(async () => {
    if (activeCias.length === 0) {
      setError('No hay compañías activas en el catálogo.');
      return;
    }
    setLoading(true); setError(null);
    try {
      const results = await Promise.allSettled(
        activeCias.map(cia => fetchAgedBalances({ cia })),
      );
      const merged: CXPRecord[] = [];
      const succeededCias: string[] = [];
      const failures: { cia: string; reason: string }[] = [];
      results.forEach((r, i) => {
        const cia = activeCias[i];
        if (r.status === 'fulfilled') {
          // Stamp the requested cia so filtering by company works downstream.
          const stamped = (r.value as CXPRecord[]).map(rec => ({ ...rec, cia }));
          merged.push(...stamped);
          succeededCias.push(cia);
        } else {
          const reason = r.reason instanceof JdeApiError
            ? `${r.reason.status}: ${r.reason.message}`
            : (r.reason instanceof Error ? r.reason.message : String(r.reason));
          failures.push({ cia, reason });
        }
      });
      if (succeededCias.length > 0) {
        onReplaceAll(merged, succeededCias);
      }
      if (failures.length > 0) {
        const summary = failures.slice(0, 3).map(f => `${f.cia} (${f.reason})`).join('; ');
        const more = failures.length > 3 ? ` y ${failures.length - 3} más` : '';
        setError(`Fallaron ${failures.length}/${activeCias.length}: ${summary}${more}`);
      }
    } finally {
      setLoading(false);
    }
  }, [activeCias, onReplaceAll]);

  // When the user switches company, allow auto-fetch to retry this cia
  // (the attempt-guard is only to prevent infinite retries within one selection).
  useEffect(() => {
    autoFetchAttempted.current.delete(selectedCia);
  }, [selectedCia]);

  // Auto-fetch on cia change when we have a token and the cia isn't cached yet.
  useEffect(() => {
    if (selectedCia === 'all') return;
    if (loadedCias[selectedCia]) return;
    if (autoFetchAttempted.current.has(selectedCia)) return;
    if (loading) return;
    autoFetchAttempted.current.add(selectedCia);
    loadSingle(selectedCia);
  }, [selectedCia, loadedCias, loading, loadSingle]);

  // Allow re-attempting auto-fetch after a manual reset.
  useEffect(() => {
    if (loadedCiaList.length === 0 && !loading) {
      autoFetchAttempted.current.clear();
    }
  }, [loadedCiaList.length, loading]);

  const refresh = useCallback(() => {
    if (selectedCia === 'all') {
      loadAll();
    } else {
      loadSingle(selectedCia);
    }
  }, [selectedCia, loadAll, loadSingle]);

  const handleCsvFile = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setError('Solo archivos .csv');
      return;
    }
    setLoading(true); setError(null);
    try {
      const text = await file.text();
      const recs = parseCXP(text);
      const ciasInCsv = Array.from(new Set(recs.map(r => r.cia).filter(Boolean)));
      if (ciasInCsv.length > 0) {
        onReplaceAll(recs, ciasInCsv);
      }
      setShowCsv(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al procesar');
    } finally {
      setLoading(false);
    }
  }, [onReplaceAll]);

  const scopeLabel = selectedCia === 'all'
    ? (loadedCiaList.length > 0
        ? `Consolidado · ${loadedCiaList.length} compañía${loadedCiaList.length !== 1 ? 's' : ''}`
        : 'Todas las compañías')
    : `Compañía ${selectedCia}`;

  const lastSyncLabel = selectedCia === 'all'
    ? (loadedCiaList.length > 0 ? 'Última sincronización por compañía' : null)
    : (loadedCias[selectedCia]
        ? `Sincronizado ${new Date(loadedCias[selectedCia]).toLocaleString('es-MX')}`
        : null);

  const missingActiveCias = selectedCia === 'all'
    ? activeCias.filter(c => !loadedCias[c])
    : [];

  // ── Empty state (no data for current scope) ──
  if (!hasData && !isCurrentCiaLoaded) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center p-6">
        <div className="w-full max-w-3xl mx-auto">
          <div className="text-center mb-8">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[var(--primary)] to-[var(--info)] flex items-center justify-center mx-auto mb-4 shadow-lg shadow-[var(--primary)]/15">
              <Clock className="text-white" size={26} />
            </div>
            <h1 className="text-[28px] font-bold text-[var(--gray-950)] tracking-tight">Cuentas por Pagar</h1>
            <p className="text-[15px] text-[var(--gray-400)] mt-1">Antigüedad de saldos · {scopeLabel}</p>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-[var(--gray-200)] p-8">
            {loading ? (
              <div className="text-center py-14">
                <Loader2 className="w-8 h-8 text-[var(--primary)] animate-spin mx-auto mb-3" />
                <p className="text-[15px] font-medium text-[var(--gray-950)]">
                  {selectedCia === 'all'
                    ? `Consultando JDE para ${activeCias.length} compañías…`
                    : `Consultando JDE (compañía ${selectedCia})…`}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="border-2 border-[var(--primary)]/30 bg-[var(--primary-subtle)] rounded-2xl p-10 text-center hover:border-[var(--primary)] hover:bg-[var(--primary-muted)] transition-all">
                  <Database className="w-10 h-10 mx-auto mb-3 text-[var(--primary)]" />
                  <p className="text-[15px] font-semibold text-[var(--gray-950)]">Consultar desde JDE</p>
                  <p className="text-[12px] text-[var(--gray-400)] mt-1">{scopeLabel}</p>
                  <button
                    onClick={() => selectedCia === 'all' ? loadAll() : loadSingle(selectedCia)}
                    disabled={loading || (selectedCia === 'all' && activeCias.length === 0)}
                    className="mt-4 inline-flex items-center gap-2 px-5 h-10 rounded-xl bg-[var(--primary)] text-white text-[13.5px] font-medium hover:bg-[var(--primary-hover)] shadow-sm shadow-[var(--primary)]/20 disabled:opacity-40 disabled:cursor-not-allowed transition"
                  >
                    <Database className="w-4 h-4" />
                    {selectedCia === 'all' ? 'Consultar todas' : 'Consultar antigüedad'}
                  </button>
                </div>

                <div
                  onClick={() => csvInput.current?.click()}
                  className="border-2 border-dashed border-[var(--gray-200)] rounded-2xl p-10 text-center cursor-pointer hover:border-[var(--primary)] hover:bg-[var(--gray-50)] transition-all"
                >
                  <FileSpreadsheet className="w-10 h-10 text-[var(--gray-400)] mx-auto mb-3" />
                  <p className="text-[15px] font-semibold text-[var(--gray-950)]">Subir CSV</p>
                  <p className="text-[13px] text-[var(--gray-400)] mt-1">Opcional · si JDE no está disponible</p>
                  <input
                    ref={csvInput} type="file" accept=".csv" className="hidden"
                    onChange={e => e.target.files?.[0] && handleCsvFile(e.target.files[0])}
                  />
                </div>
              </div>
            )}

            {error && !loading && (
              <div className="mt-4 bg-[var(--danger-muted)] border border-red-100 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <AlertCircle className="text-[var(--danger)] flex-shrink-0 mt-0.5" size={18} />
                  <div className="flex-1">
                    <p className="text-[13px] font-semibold text-[var(--gray-950)]">Error al consultar JDE</p>
                    <p className="text-[12px] text-[var(--gray-500)] mt-1">{error}</p>
                    <button
                      onClick={refresh}
                      className="mt-2 text-[12px] font-medium text-[var(--primary)] hover:text-[var(--primary-hover)]"
                    >
                      Intentar de nuevo
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Dashboard view ──
  return (
    <div className="space-y-4">
      {/* Scope + actions bar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--primary-muted)] border border-[var(--primary)]/20 text-[12px] font-medium text-[var(--primary)]">
            <Building2 className="w-3.5 h-3.5" />
            {scopeLabel}
          </div>
          {lastSyncLabel && (
            <span className="text-[11px] text-[var(--gray-400)]">{lastSyncLabel}</span>
          )}
          {missingActiveCias.length > 0 && !loading && (
            <button
              onClick={loadAll}
              className="text-[11px] font-medium text-[var(--primary)] hover:text-[var(--primary-hover)] underline underline-offset-2"
              title={`Faltan: ${missingActiveCias.join(', ')}`}
            >
              Completar {missingActiveCias.length} faltantes
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            disabled={loading}
            className="flex items-center gap-1.5 text-[12px] text-[var(--gray-500)] hover:text-[var(--primary)] disabled:opacity-40 transition"
          >
            {loading
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <RefreshCw className="w-3.5 h-3.5" />}
            Actualizar
          </button>
          <button
            onClick={() => csvInput.current?.click()}
            className="flex items-center gap-1.5 text-[12px] text-[var(--gray-500)] hover:text-[var(--primary)] transition"
          >
            <UploadIcon className="w-3.5 h-3.5" />
            Subir CSV
          </button>
          <button
            onClick={onReset}
            className="flex items-center gap-1.5 text-[12px] text-[var(--gray-400)] hover:text-[var(--danger)] transition"
          >
            <X className="w-3.5 h-3.5" />
            Limpiar
          </button>
          <input
            ref={csvInput} type="file" accept=".csv" className="hidden"
            onChange={e => e.target.files?.[0] && handleCsvFile(e.target.files[0])}
          />
        </div>
      </div>

      {error && (
        <div className="bg-[var(--danger-muted)] border border-red-100 rounded-xl px-4 py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[12.5px] text-[var(--danger)] font-medium">
            <AlertCircle className="w-3.5 h-3.5" /> {error}
          </div>
          <button
            onClick={() => setError(null)}
            className="text-[11px] text-[var(--gray-500)] hover:text-[var(--danger)]"
          >
            Cerrar
          </button>
        </div>
      )}

      <CXPDashboard records={visibleRecords} onReset={onReset} companies={companies} />
    </div>
  );
};

export default CXP;
