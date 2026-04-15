import { useState, useCallback, useRef, useMemo } from 'react';
import {
  Upload as UploadIcon,
  FileSpreadsheet,
  Loader2,
  AlertCircle,
  CheckCircle,
  ArrowUpFromLine,
  Search,
  Building2,
  Clock,
  AlertTriangle,
  TrendingUp,
  ChevronDown,
  ChevronRight,
  X,
} from 'lucide-react';
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
} from 'recharts';

// ── Types ──────────────────────────────────────────────────────────────

interface CXPRecord {
  cia: string;
  noProveedor: string;
  nombre: string;
  noFactura: string;
  fechaFactura: string;
  fechaVence: string;
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

// ── Helpers ────────────────────────────────────────────────────────────

const parseSpanishNumber = (val: string): number => {
  if (!val || val.trim() === '') return 0;
  // Remove commas used as thousands separators: "17,827.27" → "17827.27"
  const cleaned = val.replace(/,/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
};

const formatCurrency = (value: number): string => {
  if (Math.abs(value) >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `$${(value / 1_000).toFixed(1)}K`;
  }
  return `$${value.toFixed(2)}`;
};

const formatFullCurrency = (value: number): string => {
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(value);
};

const AGING_COLORS = ['#34c759', '#0071e3', '#5ac8fa', '#ff9f0a', '#ff6723', '#ff3b30', '#af52de', '#8e2d5c'];
const BUCKET_LABELS = ['Por Vencer', '1-30', '31-60', '61-90', '91-120', '121-150', '151-180', '180+'];

// ── CSV Parser ─────────────────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCXPcsv(text: string): CXPRecord[] {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) throw new Error('El archivo CSV está vacío o no tiene datos');

  const headers = parseCSVLine(lines[0]);

  // Build header index map
  const idx = (name: string): number => {
    const i = headers.findIndex(h => h.trim().toLowerCase() === name.toLowerCase());
    return i;
  };

  const records: CXPRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length < 10) continue; // skip malformed rows

    const get = (colName: string): string => {
      const colIdx = idx(colName);
      return colIdx >= 0 && colIdx < fields.length ? fields[colIdx] : '';
    };
    const getNum = (colName: string): number => parseSpanishNumber(get(colName));

    records.push({
      cia: get('cia').trim(),
      noProveedor: get('no_prov'),
      nombre: get('nombre').trim(),
      noFactura: get('no_factura'),
      fechaFactura: get('fecha_factura'),
      fechaVence: get('fecha_vence'),
      diasVencida: getNum('Dias_Vencida'),
      importeBrutoPesos: getNum('importe_bruto_pesos'),
      importePendientePesos: getNum('importe_pendiente_pesos'),
      importeSubtotalPesos: getNum('importe_SubTotal_Pesos'),
      importeImpuestosPesos: getNum('importe_Impuestos_Pesos'),
      importeBrutoDolares: getNum('importe_bruto_dolares'),
      importePendienteDolares: getNum('importe_pendiente_dolares'),
      moneda: get('moneda').trim(),
      condPago: get('Cond_Pago').trim(),
      clasifica: get('Clasifica').trim(),
      clasificacionProveedor: get('Clasificacion_Proveedor').trim(),
      porVencer: getNum('Por_Vencer'),
      v1_30: getNum('V_1_30'),
      v31_60: getNum('V_31_60'),
      v61_90: getNum('V_61_90'),
      v91_120: getNum('V_91_120'),
      v121_150: getNum('V_121_150'),
      v151_180: getNum('V_151_180'),
      mas180: getNum('Mas_180'),
    });
  }

  if (records.length === 0) throw new Error('No se encontraron registros válidos en el CSV');
  return records;
}

// ── Upload Sub-Component ───────────────────────────────────────────────

const CXPUpload = ({ onDataLoaded }: { onDataLoaded: (records: CXPRecord[]) => void }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    if (!file.name.endsWith('.csv')) {
      setError('Solo se aceptan archivos .csv');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const text = await file.text();
      const records = parseCXPcsv(text);
      setSuccess(true);
      setTimeout(() => onDataLoaded(records), 600);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al procesar el archivo');
      setLoading(false);
    }
  }, [onDataLoaded]);

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files?.length) handleFile(e.dataTransfer.files[0]);
  }, [handleFile]);

  return (
    <div className="w-full max-w-lg mx-auto">
      <div className="text-center mb-10">
        <div className="flex items-center justify-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#af52de] to-[#da7ff7] flex items-center justify-center shadow-lg shadow-purple-200">
            <Clock className="text-white" size={24} />
          </div>
        </div>
        <h1 className="text-[28px] font-bold text-[#1d1d1f] tracking-tight mb-1">Antigüedad CXP</h1>
        <p className="text-[15px] text-[#86868b]">Análisis de Cuentas por Pagar</p>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-[#d2d2d7]/40 p-8">
        {!loading && !success && !error && (
          <>
            <div
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-2xl p-14 text-center cursor-pointer transition-all ${
                dragActive
                  ? 'border-[#af52de] bg-[#f8f0ff]'
                  : 'border-[#d2d2d7] hover:border-[#af52de] hover:bg-[#fbfbfd]'
              }`}
            >
              <div className="w-14 h-14 rounded-2xl bg-[#f5f5f7] flex items-center justify-center mx-auto mb-4">
                <UploadIcon className="text-[#86868b]" size={28} />
              </div>
              <p className="text-[15px] font-semibold text-[#1d1d1f] mb-1">Arrastra tu CSV aquí</p>
              <p className="text-[13px] text-[#86868b]">o haz clic para seleccionar — .csv</p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
              className="hidden"
            />
            <div className="mt-6 flex items-center gap-3 px-1">
              <FileSpreadsheet size={16} className="text-[#86868b] flex-shrink-0" />
              <p className="text-[12px] text-[#86868b]">
                Formato: Antigüedad de Saldos CXP con columnas de aging
              </p>
            </div>
          </>
        )}

        {loading && !success && (
          <div className="text-center py-14">
            <Loader2 className="text-[#af52de] animate-spin mx-auto mb-4" size={40} />
            <p className="text-[15px] font-semibold text-[#1d1d1f] mb-1">Procesando CSV...</p>
            <p className="text-[13px] text-[#86868b]">Analizando antigüedad de saldos</p>
            <div className="mt-6 h-1 bg-[#f5f5f7] rounded-full overflow-hidden max-w-xs mx-auto">
              <div className="h-full bg-[#af52de] rounded-full animate-pulse" style={{ width: '60%' }} />
            </div>
          </div>
        )}

        {success && (
          <div className="text-center py-14">
            <div className="w-14 h-14 rounded-full bg-[#e8faf0] flex items-center justify-center mx-auto mb-4">
              <CheckCircle className="text-[#34c759]" size={28} />
            </div>
            <p className="text-[15px] font-semibold text-[#1d1d1f]">Archivo procesado</p>
            <p className="text-[13px] text-[#86868b] mt-1">Cargando análisis...</p>
          </div>
        )}

        {error && !loading && (
          <div className="bg-[#fff5f5] border border-red-100 rounded-xl p-5">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-[#ffe5e5] flex items-center justify-center flex-shrink-0 mt-0.5">
                <AlertCircle className="text-[#ff3b30]" size={16} />
              </div>
              <div>
                <p className="text-[14px] font-semibold text-[#1d1d1f]">Error al procesar</p>
                <p className="text-[13px] text-[#6e6e73] mt-1">{error}</p>
                <button
                  onClick={() => { setError(null); fileInputRef.current?.click(); }}
                  className="mt-3 text-[13px] font-medium text-[#af52de] hover:text-[#9340c2]"
                >
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

// ── Dashboard Sub-Component ────────────────────────────────────────────

const CXPDashboard = ({ records, onReset }: { records: CXPRecord[]; onReset: () => void }) => {
  const [tab, setTab] = useState<DashboardTab>('resumen');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCia, setSelectedCia] = useState<string>('all');
  const [expandedSupplier, setExpandedSupplier] = useState<string | null>(null);

  // Filtered records
  const filteredRecords = useMemo(() => {
    let filtered = records;
    if (selectedCia !== 'all') {
      filtered = filtered.filter(r => r.cia === selectedCia);
    }
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(r =>
        r.nombre.toLowerCase().includes(term) ||
        r.noFactura.toLowerCase().includes(term) ||
        r.clasifica.toLowerCase().includes(term)
      );
    }
    return filtered;
  }, [records, selectedCia, searchTerm]);

  // Companies list
  const companies = useMemo(() => {
    const set = new Set(records.map(r => r.cia));
    return Array.from(set).sort();
  }, [records]);

  // Aging buckets
  const agingBuckets: AgingBucket[] = useMemo(() => {
    const keys: (keyof CXPRecord)[] = ['porVencer', 'v1_30', 'v31_60', 'v61_90', 'v91_120', 'v121_150', 'v151_180', 'mas180'];
    return keys.map((key, i) => ({
      name: BUCKET_LABELS[i],
      key,
      color: AGING_COLORS[i],
      total: filteredRecords.reduce((sum, r) => sum + (r[key] as number), 0),
      count: filteredRecords.filter(r => (r[key] as number) > 0).length,
    }));
  }, [filteredRecords]);

  const totalPendiente = useMemo(() =>
    filteredRecords.reduce((sum, r) => sum + r.importePendientePesos, 0),
  [filteredRecords]);

  const totalVencido = useMemo(() =>
    agingBuckets.slice(1).reduce((sum, b) => sum + b.total, 0),
  [agingBuckets]);

  const totalPorVencer = agingBuckets[0]?.total || 0;

  const totalMas90 = useMemo(() =>
    agingBuckets.slice(4).reduce((sum, b) => sum + b.total, 0),
  [agingBuckets]);

  // Supplier aggregation
  const supplierData = useMemo(() => {
    const map = new Map<string, { nombre: string; total: number; count: number; records: CXPRecord[] }>();
    filteredRecords.forEach(r => {
      const key = r.nombre;
      if (!map.has(key)) map.set(key, { nombre: key, total: 0, count: 0, records: [] });
      const entry = map.get(key)!;
      entry.total += r.importePendientePesos;
      entry.count += 1;
      entry.records.push(r);
    });
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [filteredRecords]);

  // Classification aggregation
  const classificationData = useMemo(() => {
    const map = new Map<string, number>();
    filteredRecords.forEach(r => {
      const key = r.clasificacionProveedor || 'Sin Clasificar';
      map.set(key, (map.get(key) || 0) + r.importePendientePesos);
    });
    return Array.from(map.entries())
      .map(([name, value]) => ({ name: name.trim() || 'Sin Clasificar', value }))
      .sort((a, b) => b.value - a.value);
  }, [filteredRecords]);

  const PIE_COLORS = ['#0071e3', '#34c759', '#ff9f0a', '#af52de', '#ff3b30', '#5ac8fa', '#ff6723', '#8e2d5c'];

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload?.[0]) {
      return (
        <div className="bg-white border border-[#d2d2d7]/60 rounded-xl p-3 shadow-lg shadow-black/5">
          <p className="text-[13px] font-semibold text-[#1d1d1f]">{payload[0].payload.name || payload[0].name}</p>
          <p className="text-[12px] font-mono text-[#6e6e73]">{formatFullCurrency(payload[0].value)}</p>
        </div>
      );
    }
    return null;
  };

  const tabs: { id: DashboardTab; label: string }[] = [
    { id: 'resumen', label: 'Resumen' },
    { id: 'proveedores', label: 'Proveedores' },
    { id: 'antiguedad', label: 'Antigüedad' },
  ];

  return (
    <div className="space-y-5">
      {/* Filters bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center bg-white rounded-full border border-[#d2d2d7]/40 px-3 py-1.5 gap-2 shadow-sm">
          <Search className="w-3.5 h-3.5 text-[#86868b]" />
          <input
            type="text"
            placeholder="Buscar proveedor o factura..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="text-[13px] bg-transparent border-none outline-none w-52 placeholder:text-[#c7c7cc]"
          />
          {searchTerm && (
            <button onClick={() => setSearchTerm('')}>
              <X className="w-3.5 h-3.5 text-[#86868b] hover:text-[#1d1d1f]" />
            </button>
          )}
        </div>

        <select
          value={selectedCia}
          onChange={(e) => setSelectedCia(e.target.value)}
          className="text-[13px] bg-white rounded-full border border-[#d2d2d7]/40 px-4 py-1.5 shadow-sm text-[#1d1d1f] cursor-pointer"
        >
          <option value="all">Todas las compañías</option>
          {companies.map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        {/* Sub-tabs */}
        <div className="ml-auto flex items-center bg-[#f5f5f7] rounded-full p-0.5">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-1.5 rounded-full text-[13px] font-medium transition-all ${
                tab === t.id
                  ? 'bg-white text-[#1d1d1f] shadow-sm'
                  : 'text-[#86868b] hover:text-[#1d1d1f]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: 'Saldo Pendiente', value: totalPendiente, icon: Building2, color: '#0071e3' },
          { label: 'Por Vencer', value: totalPorVencer, icon: Clock, color: '#34c759' },
          { label: 'Total Vencido', value: totalVencido, icon: AlertTriangle, color: '#ff9f0a' },
          { label: 'Vencido > 90 días', value: totalMas90, icon: TrendingUp, color: '#ff3b30' },
        ].map((kpi, idx) => {
          const Icon = kpi.icon;
          return (
            <div key={idx} className="bg-white rounded-2xl border border-[#d2d2d7]/40 p-5 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-3">
                <p className="text-[12px] font-medium text-[#86868b] uppercase tracking-wide">{kpi.label}</p>
                <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ backgroundColor: kpi.color + '12' }}>
                  <Icon className="w-4 h-4" style={{ color: kpi.color }} />
                </div>
              </div>
              <p className="text-[22px] font-bold font-mono tracking-tight text-[#1d1d1f]">
                {formatCurrency(kpi.value)}
              </p>
              <p className="text-[11px] text-[#86868b] mt-1 font-mono">{formatFullCurrency(kpi.value)}</p>
            </div>
          );
        })}
      </div>

      {/* ── RESUMEN TAB ── */}
      {tab === 'resumen' && (
        <>
          {/* Aging Chart */}
          <div className="bg-white rounded-2xl border border-[#d2d2d7]/40 p-6 shadow-sm">
            <h2 className="text-[16px] font-semibold text-[#1d1d1f] mb-5">Distribución por Antigüedad</h2>
            <ResponsiveContainer width="100%" height={340}>
              <BarChart data={agingBuckets} margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
                <CartesianGrid stroke="#e8e8ed" strokeDasharray="0" vertical={false} />
                <XAxis
                  dataKey="name"
                  tick={{ fill: '#86868b', fontSize: 12 }}
                  axisLine={{ stroke: '#e8e8ed' }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#86868b', fontSize: 12 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => formatCurrency(v)}
                />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="total" radius={[6, 6, 0, 0]}>
                  {agingBuckets.map((bucket, idx) => (
                    <Cell key={idx} fill={bucket.color} fillOpacity={0.85} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Two columns: Classification Pie + Top Suppliers */}
          <div className="grid grid-cols-2 gap-4">
            {/* Classification Pie */}
            <div className="bg-white rounded-2xl border border-[#d2d2d7]/40 p-6 shadow-sm">
              <h2 className="text-[16px] font-semibold text-[#1d1d1f] mb-5">Por Clasificación</h2>
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={classificationData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {classificationData.map((_, idx) => (
                      <Cell key={idx} fill={PIE_COLORS[idx % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip content={<CustomTooltip />} />
                  <Legend
                    layout="vertical"
                    align="right"
                    verticalAlign="middle"
                    iconType="circle"
                    iconSize={8}
                    formatter={(value: string) => (
                      <span style={{ color: '#6e6e73', fontSize: 11, fontWeight: 500 }}>{value}</span>
                    )}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>

            {/* Top 10 Suppliers */}
            <div className="bg-white rounded-2xl border border-[#d2d2d7]/40 p-6 shadow-sm">
              <h2 className="text-[16px] font-semibold text-[#1d1d1f] mb-5">Top 10 Proveedores</h2>
              <div className="space-y-2">
                {supplierData.slice(0, 10).map((s, idx) => {
                  const pct = totalPendiente > 0 ? (s.total / totalPendiente) : 0;
                  return (
                    <div key={idx} className="flex items-center gap-3 py-1.5">
                      <span className="text-[11px] font-mono text-[#86868b] w-5 text-right">{idx + 1}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-[12px] font-medium text-[#1d1d1f] truncate">{s.nombre}</p>
                        <div className="bg-[#f5f5f7] rounded-full h-2 mt-1 overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.min(pct * 100, 100)}%`,
                              backgroundColor: '#0071e3',
                              opacity: 0.7,
                            }}
                          />
                        </div>
                      </div>
                      <span className="text-[12px] font-mono font-semibold text-[#1d1d1f] w-24 text-right">
                        {formatCurrency(s.total)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Summary Stats */}
          <div className="bg-white rounded-2xl border border-[#d2d2d7]/40 p-6 shadow-sm">
            <h2 className="text-[16px] font-semibold text-[#1d1d1f] mb-4">Estadísticas</h2>
            <div className="grid grid-cols-4 gap-6">
              <div>
                <p className="text-[12px] text-[#86868b] mb-1">Total Facturas</p>
                <p className="text-[20px] font-bold font-mono text-[#1d1d1f]">{filteredRecords.length.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-[12px] text-[#86868b] mb-1">Proveedores</p>
                <p className="text-[20px] font-bold font-mono text-[#1d1d1f]">{supplierData.length.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-[12px] text-[#86868b] mb-1">Compañías</p>
                <p className="text-[20px] font-bold font-mono text-[#1d1d1f]">{companies.length}</p>
              </div>
              <div>
                <p className="text-[12px] text-[#86868b] mb-1">Días Prom. Vencimiento</p>
                <p className="text-[20px] font-bold font-mono text-[#1d1d1f]">
                  {filteredRecords.length > 0
                    ? Math.round(filteredRecords.reduce((s, r) => s + r.diasVencida, 0) / filteredRecords.length)
                    : 0}
                </p>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── PROVEEDORES TAB ── */}
      {tab === 'proveedores' && (
        <div className="bg-white rounded-2xl border border-[#d2d2d7]/40 shadow-sm overflow-hidden">
          <div className="p-6 border-b border-[#e8e8ed]">
            <h2 className="text-[16px] font-semibold text-[#1d1d1f]">
              Proveedores ({supplierData.length})
            </h2>
          </div>
          <div className="divide-y divide-[#f5f5f7]">
            {supplierData.map((s) => (
              <div key={s.nombre}>
                <button
                  onClick={() => setExpandedSupplier(expandedSupplier === s.nombre ? null : s.nombre)}
                  className="w-full flex items-center gap-4 px-6 py-4 hover:bg-[#fbfbfd] transition text-left"
                >
                  {expandedSupplier === s.nombre
                    ? <ChevronDown className="w-4 h-4 text-[#86868b] flex-shrink-0" />
                    : <ChevronRight className="w-4 h-4 text-[#86868b] flex-shrink-0" />
                  }
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-medium text-[#1d1d1f] truncate">{s.nombre}</p>
                    <p className="text-[11px] text-[#86868b]">{s.count} factura{s.count !== 1 ? 's' : ''}</p>
                  </div>
                  <div className="flex-1">
                    <div className="bg-[#f5f5f7] rounded-full h-3 overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.min((s.total / (supplierData[0]?.total || 1)) * 100, 100)}%`,
                          backgroundColor: '#0071e3',
                          opacity: 0.6,
                        }}
                      />
                    </div>
                  </div>
                  <span className="text-[13px] font-mono font-semibold text-[#1d1d1f] w-32 text-right">
                    {formatCurrency(s.total)}
                  </span>
                </button>

                {/* Expanded: show invoices */}
                {expandedSupplier === s.nombre && (
                  <div className="bg-[#fbfbfd] px-6 pb-4">
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="border-b border-[#e8e8ed]">
                          <th className="text-left py-2 text-[#86868b] font-semibold">Factura</th>
                          <th className="text-left py-2 text-[#86868b] font-semibold">Fecha</th>
                          <th className="text-left py-2 text-[#86868b] font-semibold">Vence</th>
                          <th className="text-right py-2 text-[#86868b] font-semibold">Días</th>
                          <th className="text-right py-2 text-[#86868b] font-semibold">Pendiente</th>
                          <th className="text-left py-2 text-[#86868b] font-semibold pl-4">Moneda</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.records.map((r, i) => (
                          <tr key={i} className="border-b border-[#f5f5f7]">
                            <td className="py-2 font-mono text-[#1d1d1f]">{r.noFactura}</td>
                            <td className="py-2 text-[#6e6e73]">{r.fechaFactura}</td>
                            <td className="py-2 text-[#6e6e73]">{r.fechaVence}</td>
                            <td className="py-2 text-right font-mono">
                              <span className={r.diasVencida > 90 ? 'text-[#ff3b30]' : r.diasVencida > 30 ? 'text-[#ff9f0a]' : 'text-[#1d1d1f]'}>
                                {r.diasVencida}
                              </span>
                            </td>
                            <td className="py-2 text-right font-mono font-medium text-[#1d1d1f]">
                              {formatFullCurrency(r.importePendientePesos)}
                            </td>
                            <td className="py-2 pl-4 text-[#86868b]">{r.moneda}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── ANTIGÜEDAD TAB ── */}
      {tab === 'antiguedad' && (
        <div className="bg-white rounded-2xl border border-[#d2d2d7]/40 shadow-sm overflow-hidden">
          <div className="p-6 border-b border-[#e8e8ed]">
            <h2 className="text-[16px] font-semibold text-[#1d1d1f]">Detalle por Bucket de Antigüedad</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-[#e8e8ed]">
                  <th className="text-left py-3 px-4 text-[#86868b] font-semibold">Proveedor</th>
                  <th className="text-right py-3 px-3 text-[#86868b] font-semibold">Pendiente</th>
                  {BUCKET_LABELS.map((label, i) => (
                    <th key={i} className="text-right py-3 px-3 font-semibold" style={{ color: AGING_COLORS[i] }}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {supplierData.slice(0, 50).map((s, idx) => {
                  const keys: (keyof CXPRecord)[] = ['porVencer', 'v1_30', 'v31_60', 'v61_90', 'v91_120', 'v121_150', 'v151_180', 'mas180'];
                  const bucketTotals = keys.map(key =>
                    s.records.reduce((sum, r) => sum + (r[key] as number), 0)
                  );
                  return (
                    <tr key={idx} className="border-b border-[#f5f5f7] hover:bg-[#fbfbfd] transition">
                      <td className="py-3 px-4 font-medium text-[#1d1d1f] max-w-[200px] truncate">{s.nombre}</td>
                      <td className="py-3 px-3 text-right font-mono font-semibold text-[#1d1d1f]">
                        {formatCurrency(s.total)}
                      </td>
                      {bucketTotals.map((val, i) => (
                        <td key={i} className="py-3 px-3 text-right font-mono">
                          {val > 0 ? (
                            <span style={{ color: AGING_COLORS[i] }}>{formatCurrency(val)}</span>
                          ) : (
                            <span className="text-[#d2d2d7]">—</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  );
                })}
                {/* Totals row */}
                <tr className="border-t-2 border-[#d2d2d7] bg-[#fbfbfd] font-semibold">
                  <td className="py-3 px-4 text-[#1d1d1f]">TOTAL</td>
                  <td className="py-3 px-3 text-right font-mono text-[#1d1d1f]">{formatCurrency(totalPendiente)}</td>
                  {agingBuckets.map((b, i) => (
                    <td key={i} className="py-3 px-3 text-right font-mono" style={{ color: b.color }}>
                      {formatCurrency(b.total)}
                    </td>
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

// ── Main CXP Component ─────────────────────────────────────────────────

const CXP = () => {
  const [view, setView] = useState<CXPView>('upload');
  const [records, setRecords] = useState<CXPRecord[]>([]);

  const handleDataLoaded = useCallback((data: CXPRecord[]) => {
    setRecords(data);
    setView('dashboard');
  }, []);

  const handleReset = useCallback(() => {
    setRecords([]);
    setView('upload');
  }, []);

  if (view === 'upload') {
    return (
      <div className="min-h-[60vh] flex items-center justify-center p-6">
        <CXPUpload onDataLoaded={handleDataLoaded} />
      </div>
    );
  }

  return <CXPDashboard records={records} onReset={handleReset} />;
};

export default CXP;
