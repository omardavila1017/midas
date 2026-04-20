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

const AGING_COLORS = ['#34c759','#0071e3','#5ac8fa','#ff9f0a','#ff6723','#ff3b30','#af52de','#8e2d5c'];
const BUCKET_LABELS = ['Por Vencer','1-30','31-60','61-90','91-120','121-150','151-180','180+'];
const BUCKET_KEYS: (keyof CXPRecord)[] = ['porVencer','v1_30','v31_60','v61_90','v91_120','v121_150','v151_180','mas180'];
const PIE_COLORS = ['#0071e3','#34c759','#ff9f0a','#af52de','#ff3b30','#5ac8fa','#ff6723','#8e2d5c','#30b0c7','#a2845e'];
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

const fmt = (v: number): string => {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
};

const fmtFull = (v: number): string =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 }).format(v);

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
      setTimeout(() => onDataLoaded(recs), 500);
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
      setTimeout(() => onDataLoaded(records as CXPRecord[]), 500);
    } catch (e) {
      if (e instanceof JdeApiError) {
        const hint = e.status === 401 ? ' — revisa VITE_JDE_TOKEN en .env.local' : '';
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
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#0071e3] to-[#40a9ff] flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-200/50">
          <Clock className="text-white" size={26} />
        </div>
        <h1 className="text-[28px] font-bold text-[#1d1d1f] tracking-tight">Cuentas por Pagar</h1>
        <p className="text-[15px] text-[#86868b] mt-1">Análisis de antigüedad de saldos CXP</p>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-[#d2d2d7]/40 p-8">
        {!loading && !success && !error && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* ── JDE ── */}
            <div className={`border-2 rounded-2xl p-10 text-center transition-all ${
              jdeDisabled ? 'border-[#e8e8ed] bg-[#fbfbfd]' : 'border-[#0071e3]/30 bg-[#f5fbff] hover:border-[#0071e3] hover:bg-[#e8f4fd]'
            }`}>
              <Database className={`w-10 h-10 mx-auto mb-3 ${jdeDisabled ? 'text-[#c7c7cc]' : 'text-[#0071e3]'}`} />
              <p className="text-[15px] font-semibold text-[#1d1d1f]">Consultar desde JDE</p>
              <p className="text-[12px] text-[#86868b] mt-1">
                Compañía: <span className="font-medium text-[#1d1d1f]">
                  {jdeDisabled ? '— selecciona en el header —' : selectedCia}
                </span>
              </p>
              <button
                onClick={loadFromJde}
                disabled={jdeDisabled}
                title={jdeDisabled ? 'Selecciona una compañía en el header primero' : undefined}
                className="mt-4 inline-flex items-center gap-2 px-5 h-10 rounded-xl bg-[#0071e3] text-white text-[13.5px] font-medium hover:bg-[#0077ed] shadow-sm shadow-[#0071e3]/20 disabled:opacity-40 disabled:cursor-not-allowed transition"
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
                dragActive ? 'border-[#0071e3] bg-[#e8f4fd]' : 'border-[#d2d2d7] hover:border-[#0071e3] hover:bg-[#fbfbfd]'
              }`}
            >
              <FileSpreadsheet className="w-10 h-10 text-[#86868b] mx-auto mb-3" />
              <p className="text-[15px] font-semibold text-[#1d1d1f]">Arrastra tu CSV aquí</p>
              <p className="text-[13px] text-[#86868b] mt-1">o haz click para seleccionar archivo</p>
              <input ref={ref} type="file" accept=".csv" className="hidden" onChange={e => e.target.files?.[0] && handle(e.target.files[0])} />
            </div>
          </div>
        )}

        {loading && !success && (
          <div className="text-center py-16">
            <Loader2 className="w-8 h-8 text-[#0071e3] animate-spin mx-auto mb-3" />
            <p className="text-[15px] font-medium text-[#1d1d1f]">
              {source === 'jde' ? `Consultando JDE (compañía ${selectedCia})...` : 'Procesando archivo...'}
            </p>
          </div>
        )}

        {success && (
          <div className="text-center py-14">
            <CheckCircle className="w-12 h-12 text-[#34c759] mx-auto mb-3" />
            <p className="text-[15px] font-semibold text-[#1d1d1f]">{count.toLocaleString()} registros cargados</p>
            <p className="text-[13px] text-[#86868b] mt-1">
              {source === 'jde' ? `Desde JDE · compañía ${selectedCia}` : 'Desde archivo CSV'} — abriendo análisis...
            </p>
          </div>
        )}

        {error && (
          <div className="bg-[#fff5f5] border border-red-100 rounded-xl p-5">
            <div className="flex items-start gap-3">
              <AlertCircle className="text-[#ff3b30] flex-shrink-0 mt-0.5" size={18} />
              <div className="flex-1">
                <p className="text-[14px] font-semibold text-[#1d1d1f]">
                  {source === 'jde' ? 'Error al consultar JDE' : 'Error al procesar'}
                </p>
                <p className="text-[13px] text-[#6e6e73] mt-1">{error}</p>
                <button onClick={retry}
                  className="mt-3 text-[13px] font-medium text-[#0071e3] hover:text-[#0077ED]">
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
    <div className="bg-white/95 backdrop-blur-xl border border-[#d2d2d7]/60 rounded-xl px-3 py-2 shadow-lg">
      <p className="text-[12px] font-semibold text-[#1d1d1f]">{payload[0].payload.name || payload[0].name}</p>
      <p className="text-[12px] font-mono text-[#6e6e73]">{fmtFull(payload[0].value)}</p>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════════
   Dashboard
   ═══════════════════════════════════════════════════════════════════════ */

const CXPDashboard = ({ records, onReset }: { records: CXPRecord[]; onReset: () => void }) => {
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

  // Company breakdown
  const ciaData = useMemo(() => {
    const map = new Map<string, number>();
    filtered.forEach(r => map.set(r.cia, (map.get(r.cia) || 0) + r.importePendientePesos));
    return Array.from(map.entries()).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [filtered]);

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
        <div className="flex items-center bg-white rounded-full border border-[#d2d2d7]/40 px-3 py-1.5 gap-2 shadow-sm">
          <Search className="w-3.5 h-3.5 text-[#86868b]" />
          <input type="text" placeholder="Buscar proveedor, factura, # prov..."
            value={searchTerm} onChange={e => { setSearchTerm(e.target.value); setProvPage(0); }}
            className="text-[13px] bg-transparent border-none outline-none w-56 placeholder:text-[#c7c7cc]" />
          {searchTerm && <button onClick={() => setSearchTerm('')}><X className="w-3.5 h-3.5 text-[#86868b]" /></button>}
        </div>

        <select value={selectedCia} onChange={e => { setSelectedCia(e.target.value); setProvPage(0); }}
          className="text-[13px] bg-white rounded-full border border-[#d2d2d7]/40 px-4 py-1.5 shadow-sm text-[#1d1d1f] cursor-pointer">
          <option value="all">Todas las compañías</option>
          {companies.map(c => <option key={c} value={c}>{c}</option>)}
        </select>

        <div className="flex items-center gap-1 text-[12px] text-[#86868b] bg-[#f5f5f7] rounded-full px-3 py-1.5">
          <Receipt className="w-3.5 h-3.5" />
          {filtered.length.toLocaleString()} facturas
        </div>

        {/* Sub-tabs — right aligned */}
        <div className="ml-auto flex items-center bg-[#f5f5f7]/80 rounded-full p-[3px] gap-[2px]">
          {tabs.map(t => {
            const isActive = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`relative px-3.5 py-[6px] rounded-full text-[12.5px] font-medium transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] flex items-center gap-1.5 ${
                  isActive ? 'text-[#1d1d1f]' : 'text-[#86868b] hover:text-[#515154]'
                }`}>
                {isActive && (
                  <span className="absolute inset-0 bg-white rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.08),0_0_1px_rgba(0,0,0,0.04)] animate-scale-in" />
                )}
                <span className="relative flex items-center gap-1.5">
                  {t.label}
                  {t.count !== undefined && <span className="text-[11px] text-[#86868b]">({t.count})</span>}
                </span>
              </button>
            );
          })}
        </div>

        <button onClick={onReset} className="text-[12px] text-[#86868b] hover:text-[#ff3b30] flex items-center gap-1 transition">
          <RotateCcw className="w-3 h-3" /> Nuevo archivo
        </button>
      </div>

      {/* ── Drilldown Banner ── */}
      {hasDrill && (
        <div className="bg-[#e8f4fd] border border-[#0071e3]/20 rounded-xl px-4 py-2.5 flex items-center justify-between animate-slide-down">
          <div className="flex items-center gap-2 text-[13px] text-[#0071e3] font-medium">
            <Filter className="w-3.5 h-3.5" />
            Filtrando: {drillLabel} — {filtered.length.toLocaleString()} registros
          </div>
          <button onClick={clearDrill} className="text-[13px] font-medium text-[#0071e3] hover:text-[#0077ED] flex items-center gap-1 hover-press">
            <X className="w-3.5 h-3.5" /> Limpiar
          </button>
        </div>
      )}

      {/* ── KPI Cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Saldo Total CXP', value: totalPendiente, sub: `${supplierData.length} proveedores · ${filtered.length.toLocaleString()} facturas`, icon: Building2, color: '#0071e3', kpi: null as string | null },
          { label: 'Por Vencer', value: totalPorVencer, sub: pct(totalPorVencer, totalPendiente) + ' del total', icon: Clock, color: '#34c759', kpi: 'porVencer' },
          { label: 'Total Vencido', value: totalVencido, sub: pct(totalVencido, totalPendiente) + ' del total', icon: AlertTriangle, color: '#ff9f0a', kpi: 'vencido' },
          { label: 'Vencido > 90 días', value: totalMas90, sub: pct(totalMas90, totalPendiente) + ' del total', icon: TrendingUp, color: '#ff3b30', kpi: 'mas90' },
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
                active ? 'border-[#0071e3] ring-2 ring-[#0071e3]/20' : 'border-[#d2d2d7]/40'
              }`}>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[11px] font-medium text-[#86868b] uppercase tracking-wider">{kpi.label}</p>
                <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ backgroundColor: kpi.color + '14' }}>
                  <Icon className="w-3.5 h-3.5" style={{ color: kpi.color }} />
                </div>
              </div>
              <p className="text-[22px] font-bold font-mono tracking-tight text-[#1d1d1f]">
                {fmt(kpi.value as number)}
              </p>
              <p className="text-[11px] text-[#86868b] mt-0.5">{kpi.sub}</p>
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
          <div className="bg-white rounded-2xl border border-[#d2d2d7]/40 p-5 shadow-sm animate-card-in stagger-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[15px] font-semibold text-[#1d1d1f]">Distribución por Antigüedad</h2>
              <p className="text-[12px] text-[#86868b]">Click en barra para filtrar</p>
            </div>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={agingBuckets} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                <CartesianGrid stroke="#f0f0f2" strokeDasharray="0" vertical={false} />
                <XAxis dataKey="name" tick={{ fill: '#86868b', fontSize: 11 }} axisLine={{ stroke: '#e8e8ed' }} tickLine={false} />
                <YAxis tick={{ fill: '#86868b', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} />
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
                <div key={i} className="flex items-center gap-1.5 bg-[#f5f5f7] rounded-full px-2.5 py-1 text-[11px]">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: b.color }} />
                  <span className="text-[#6e6e73]">{b.name}:</span>
                  <span className="font-mono font-semibold text-[#1d1d1f]">{fmt(b.total)}</span>
                  <span className="text-[#86868b]">({b.count})</span>
                </div>
              ))}
            </div>
          </div>

          {/* Two columns: Clasificación + Top Proveedores */}
          <div className="grid grid-cols-2 gap-4 animate-card-in stagger-7">
            {/* Classification Donut */}
            <div className="bg-white rounded-2xl border border-[#d2d2d7]/40 p-5 shadow-sm overflow-hidden hover-lift">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-[15px] font-semibold text-[#1d1d1f]">Por Clasificación</h2>
                <p className="text-[12px] text-[#86868b]">Click para filtrar</p>
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
                    <span className="text-[#6e6e73] truncate max-w-[100px]">{e.name}</span>
                    <span className="font-mono text-[#1d1d1f] font-medium">{fmt(e.value)}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Top 10 Proveedores */}
            <div className="bg-white rounded-2xl border border-[#d2d2d7]/40 p-5 shadow-sm hover-lift">
              <h2 className="text-[15px] font-semibold text-[#1d1d1f] mb-3">Top 10 Proveedores</h2>
              <div className="space-y-1.5">
                {supplierData.slice(0, 10).map((s, i) => {
                  const barPct = supplierData[0]?.total > 0 ? (s.total / supplierData[0].total) : 0;
                  return (
                    <div key={i}
                      className="flex items-center gap-2.5 py-1.5 px-2 -mx-2 cursor-pointer hover:bg-[#f5f5f7] rounded-lg transition-all duration-200"
                      onClick={() => { clearDrill(); setSearchTerm(s.nombre.slice(0, 20)); setTab('proveedores'); setExpandedSupplier(s.nombre); setProvPage(0); }}>
                      <span className="text-[11px] font-mono text-[#86868b] w-4 text-right">{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-[12px] font-medium text-[#0071e3] truncate">{s.nombre}</p>
                        <div className="bg-[#f0f0f2] rounded-full h-1.5 mt-1 overflow-hidden">
                          <div className="h-full rounded-full bg-[#0071e3]/60" style={{ width: `${barPct * 100}%` }} />
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-[12px] font-mono font-semibold text-[#1d1d1f]">{fmt(s.total)}</p>
                        <p className="text-[10px] text-[#86868b]">{s.count} fact.</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Company breakdown (if multiple) */}
          {ciaData.length > 1 && (
            <div className="bg-white rounded-2xl border border-[#d2d2d7]/40 p-5 shadow-sm animate-card-in stagger-9">
              <h2 className="text-[15px] font-semibold text-[#1d1d1f] mb-4">Desglose por Compañía</h2>
              <div className="grid grid-cols-2 gap-3">
                {ciaData.map((c, i) => (
                  <div key={i} className="flex items-center gap-3 p-3 bg-[#fbfbfd] rounded-xl">
                    <div className="w-2 h-8 rounded-full" style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-medium text-[#1d1d1f] truncate">{c.name}</p>
                      <p className="text-[11px] text-[#86868b]">{pct(c.value, totalPendiente)}</p>
                    </div>
                    <p className="text-[13px] font-mono font-semibold text-[#1d1d1f]">{fmt(c.value)}</p>
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
        <div className="bg-white rounded-2xl border border-[#d2d2d7]/40 shadow-sm overflow-hidden">
          {/* Header with sort controls */}
          <div className="p-4 border-b border-[#e8e8ed] flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-[#1d1d1f]">
              Proveedores
              <span className="text-[#86868b] font-normal ml-1">({supplierData.length.toLocaleString()})</span>
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
                    sortKey === k ? 'bg-[#0071e3] text-white' : 'bg-[#f5f5f7] text-[#6e6e73] hover:bg-[#e8e8ed]'
                  }`}>
                  {label}
                  {sortKey === k && <ArrowUpDown className="w-2.5 h-2.5" />}
                </button>
              ))}
            </div>
          </div>

          {/* Supplier list */}
          <div className="divide-y divide-[#f5f5f7]">
            {pagedSuppliers.map(s => {
              const isExpanded = expandedSupplier === s.nombre;
              const vencido = s.records.reduce((sum, r) => sum + r.v1_30 + r.v31_60 + r.v61_90 + r.v91_120 + r.v121_150 + r.v151_180 + r.mas180, 0);
              const severity = s.maxDias > 120 ? '#ff3b30' : s.maxDias > 60 ? '#ff9f0a' : s.maxDias > 0 ? '#0071e3' : '#34c759';

              return (
                <div key={s.nombre}>
                  <button onClick={() => setExpandedSupplier(isExpanded ? null : s.nombre)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[#fbfbfd] transition text-left">
                    {isExpanded ? <ChevronDown className="w-4 h-4 text-[#86868b]" /> : <ChevronRight className="w-4 h-4 text-[#86868b]" />}

                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium text-[#1d1d1f] truncate">{s.nombre}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[11px] text-[#86868b]">{s.count} factura{s.count !== 1 ? 's' : ''}</span>
                        {s.maxDias > 0 && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full" style={{ backgroundColor: severity + '14', color: severity }}>
                            máx {s.maxDias}d
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Mini aging bar */}
                    <div className="w-40 flex h-2.5 rounded-full overflow-hidden bg-[#f0f0f2]">
                      {BUCKET_KEYS.map((key, bi) => {
                        const bval = s.records.reduce((sum, r) => sum + (r[key] as number), 0);
                        const bpct = s.total > 0 ? (bval / s.total) * 100 : 0;
                        return bpct > 0 ? <div key={bi} style={{ width: `${bpct}%`, backgroundColor: AGING_COLORS[bi] }} /> : null;
                      })}
                    </div>

                    <div className="text-right w-28">
                      <p className="text-[13px] font-mono font-semibold text-[#1d1d1f]">{fmt(s.total)}</p>
                      {vencido > 0 && <p className="text-[10px] font-mono text-[#ff3b30]">{fmt(vencido)} vencido</p>}
                    </div>
                  </button>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div className="bg-[#fbfbfd] px-4 pb-3">
                      {/* Aging summary for this supplier */}
                      <div className="flex gap-1.5 mb-3 flex-wrap">
                        {BUCKET_KEYS.map((key, bi) => {
                          const bval = s.records.reduce((sum, r) => sum + (r[key] as number), 0);
                          if (bval === 0) return null;
                          return (
                            <div key={bi} className="flex items-center gap-1 bg-white rounded-full px-2 py-0.5 text-[10px] border border-[#e8e8ed]">
                              <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: AGING_COLORS[bi] }} />
                              <span className="text-[#6e6e73]">{BUCKET_LABELS[bi]}:</span>
                              <span className="font-mono font-medium text-[#1d1d1f]">{fmt(bval)}</span>
                            </div>
                          );
                        })}
                      </div>

                      <div className="overflow-x-auto">
                        <table className="w-full text-[11px]">
                          <thead>
                            <tr className="border-b border-[#e8e8ed]">
                              <th className="text-left py-2 text-[#86868b] font-semibold">Factura</th>
                              <th className="text-left py-2 text-[#86868b] font-semibold">F. Factura</th>
                              <th className="text-left py-2 text-[#86868b] font-semibold">Vence</th>
                              <th className="text-right py-2 text-[#86868b] font-semibold">Días</th>
                              <th className="text-right py-2 text-[#86868b] font-semibold">Pendiente</th>
                              <th className="text-left py-2 text-[#86868b] font-semibold pl-3">Mon.</th>
                              <th className="text-left py-2 text-[#86868b] font-semibold">Cond. Pago</th>
                            </tr>
                          </thead>
                          <tbody>
                            {s.records.sort((a, b) => b.diasVencida - a.diasVencida).map((r, ri) => (
                              <tr key={ri} className="border-b border-[#f5f5f7]">
                                <td className="py-1.5 font-mono text-[#1d1d1f]">{r.noFactura}</td>
                                <td className="py-1.5 text-[#6e6e73]">{r.fechaFactura}</td>
                                <td className="py-1.5 text-[#6e6e73]">{r.fechaVence}</td>
                                <td className="py-1.5 text-right font-mono">
                                  <span className={r.diasVencida > 90 ? 'text-[#ff3b30] font-semibold' : r.diasVencida > 30 ? 'text-[#ff9f0a]' : 'text-[#1d1d1f]'}>
                                    {r.diasVencida}
                                  </span>
                                </td>
                                <td className="py-1.5 text-right font-mono font-medium text-[#1d1d1f]">{fmtFull(r.importePendientePesos)}</td>
                                <td className="py-1.5 pl-3 text-[#86868b]">{r.moneda}</td>
                                <td className="py-1.5 text-[#86868b]">{r.condPago}</td>
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
            <div className="px-4 py-3 border-t border-[#e8e8ed] flex items-center justify-between">
              <p className="text-[12px] text-[#86868b]">
                Mostrando {provPage * PAGE_SIZE + 1}–{Math.min((provPage + 1) * PAGE_SIZE, supplierData.length)} de {supplierData.length.toLocaleString()}
              </p>
              <div className="flex gap-1">
                <button onClick={() => setProvPage(p => Math.max(0, p - 1))} disabled={provPage === 0}
                  className="px-3 py-1 rounded-lg text-[12px] font-medium bg-[#f5f5f7] text-[#6e6e73] hover:bg-[#e8e8ed] disabled:opacity-30 transition">
                  Anterior
                </button>
                <span className="px-3 py-1 text-[12px] text-[#86868b]">{provPage + 1} / {totalPages}</span>
                <button onClick={() => setProvPage(p => Math.min(totalPages - 1, p + 1))} disabled={provPage >= totalPages - 1}
                  className="px-3 py-1 rounded-lg text-[12px] font-medium bg-[#f5f5f7] text-[#6e6e73] hover:bg-[#e8e8ed] disabled:opacity-30 transition">
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
        <div className="bg-white rounded-2xl border border-[#d2d2d7]/40 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-[#e8e8ed] flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-[#1d1d1f]">Matriz de Antigüedad por Proveedor</h2>
            <p className="text-[12px] text-[#86868b]">Top {Math.min(100, supplierData.length)} proveedores por monto</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-white z-10">
                <tr className="border-b-2 border-[#d2d2d7]">
                  <th className="text-left py-2.5 px-3 text-[#86868b] font-semibold w-[200px] min-w-[200px]">Proveedor</th>
                  <th className="text-right py-2.5 px-2 text-[#86868b] font-semibold w-[90px]">Total</th>
                  <th className="text-center py-2.5 px-1 text-[#86868b] font-semibold w-[40px]">#</th>
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
                    <tr key={si} className="border-b border-[#f5f5f7] hover:bg-[#fbfbfd] transition">
                      <td className="py-2 px-3 font-medium text-[#1d1d1f] truncate max-w-[200px]" title={s.nombre}>{s.nombre}</td>
                      <td className="py-2 px-2 text-right font-mono font-semibold text-[#1d1d1f]">{fmt(s.total)}</td>
                      <td className="py-2 px-1 text-center text-[#86868b]">{s.count}</td>
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
                              <span className="text-[#e0e0e0]">—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                {/* Totals */}
                <tr className="border-t-2 border-[#d2d2d7] bg-[#f5f5f7] font-semibold sticky bottom-0">
                  <td className="py-2.5 px-3 text-[#1d1d1f]">TOTAL</td>
                  <td className="py-2.5 px-2 text-right font-mono text-[#1d1d1f]">{fmt(totalPendiente)}</td>
                  <td className="py-2.5 px-1 text-center text-[#86868b]">{filtered.length}</td>
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
      onMergeCia(cia, data as CXPRecord[]);
    } catch (e) {
      if (e instanceof JdeApiError) {
        const hint = e.status === 401 ? ' — revisa VITE_JDE_TOKEN en .env.local' : '';
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
          merged.push(...(r.value as CXPRecord[]));
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
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#0071e3] to-[#40a9ff] flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-200/50">
              <Clock className="text-white" size={26} />
            </div>
            <h1 className="text-[28px] font-bold text-[#1d1d1f] tracking-tight">Cuentas por Pagar</h1>
            <p className="text-[15px] text-[#86868b] mt-1">Antigüedad de saldos · {scopeLabel}</p>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-[#d2d2d7]/40 p-8">
            {loading ? (
              <div className="text-center py-14">
                <Loader2 className="w-8 h-8 text-[#0071e3] animate-spin mx-auto mb-3" />
                <p className="text-[15px] font-medium text-[#1d1d1f]">
                  {selectedCia === 'all'
                    ? `Consultando JDE para ${activeCias.length} compañías…`
                    : `Consultando JDE (compañía ${selectedCia})…`}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="border-2 border-[#0071e3]/30 bg-[#f5fbff] rounded-2xl p-10 text-center hover:border-[#0071e3] hover:bg-[#e8f4fd] transition-all">
                  <Database className="w-10 h-10 mx-auto mb-3 text-[#0071e3]" />
                  <p className="text-[15px] font-semibold text-[#1d1d1f]">Consultar desde JDE</p>
                  <p className="text-[12px] text-[#86868b] mt-1">{scopeLabel}</p>
                  <button
                    onClick={() => selectedCia === 'all' ? loadAll() : loadSingle(selectedCia)}
                    disabled={loading || (selectedCia === 'all' && activeCias.length === 0)}
                    className="mt-4 inline-flex items-center gap-2 px-5 h-10 rounded-xl bg-[#0071e3] text-white text-[13.5px] font-medium hover:bg-[#0077ed] shadow-sm shadow-[#0071e3]/20 disabled:opacity-40 disabled:cursor-not-allowed transition"
                  >
                    <Database className="w-4 h-4" />
                    {selectedCia === 'all' ? 'Consultar todas' : 'Consultar antigüedad'}
                  </button>
                </div>

                <div
                  onClick={() => csvInput.current?.click()}
                  className="border-2 border-dashed border-[#d2d2d7] rounded-2xl p-10 text-center cursor-pointer hover:border-[#0071e3] hover:bg-[#fbfbfd] transition-all"
                >
                  <FileSpreadsheet className="w-10 h-10 text-[#86868b] mx-auto mb-3" />
                  <p className="text-[15px] font-semibold text-[#1d1d1f]">Subir CSV</p>
                  <p className="text-[13px] text-[#86868b] mt-1">Opcional · si JDE no está disponible</p>
                  <input
                    ref={csvInput} type="file" accept=".csv" className="hidden"
                    onChange={e => e.target.files?.[0] && handleCsvFile(e.target.files[0])}
                  />
                </div>
              </div>
            )}

            {error && !loading && (
              <div className="mt-4 bg-[#fff5f5] border border-red-100 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <AlertCircle className="text-[#ff3b30] flex-shrink-0 mt-0.5" size={18} />
                  <div className="flex-1">
                    <p className="text-[13px] font-semibold text-[#1d1d1f]">Error al consultar JDE</p>
                    <p className="text-[12px] text-[#6e6e73] mt-1">{error}</p>
                    <button
                      onClick={refresh}
                      className="mt-2 text-[12px] font-medium text-[#0071e3] hover:text-[#0077ed]"
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
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#e8f4fd] border border-[#0071e3]/20 text-[12px] font-medium text-[#0071e3]">
            <Building2 className="w-3.5 h-3.5" />
            {scopeLabel}
          </div>
          {lastSyncLabel && (
            <span className="text-[11px] text-[#86868b]">{lastSyncLabel}</span>
          )}
          {missingActiveCias.length > 0 && !loading && (
            <button
              onClick={loadAll}
              className="text-[11px] font-medium text-[#0071e3] hover:text-[#0077ed] underline underline-offset-2"
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
            className="flex items-center gap-1.5 text-[12px] text-[#6e6e73] hover:text-[#0071e3] disabled:opacity-40 transition"
          >
            {loading
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <RefreshCw className="w-3.5 h-3.5" />}
            Actualizar
          </button>
          <button
            onClick={() => csvInput.current?.click()}
            className="flex items-center gap-1.5 text-[12px] text-[#6e6e73] hover:text-[#0071e3] transition"
          >
            <UploadIcon className="w-3.5 h-3.5" />
            Subir CSV
          </button>
          <button
            onClick={onReset}
            className="flex items-center gap-1.5 text-[12px] text-[#86868b] hover:text-[#ff3b30] transition"
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
        <div className="bg-[#fff5f5] border border-red-100 rounded-xl px-4 py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[12.5px] text-[#ff3b30] font-medium">
            <AlertCircle className="w-3.5 h-3.5" /> {error}
          </div>
          <button
            onClick={() => setError(null)}
            className="text-[11px] text-[#6e6e73] hover:text-[#ff3b30]"
          >
            Cerrar
          </button>
        </div>
      )}

      <CXPDashboard records={visibleRecords} onReset={onReset} />
    </div>
  );
};

export default CXP;
