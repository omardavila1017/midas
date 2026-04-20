import { useState, useCallback, useMemo } from 'react';
import {
  Landmark,
  Loader2,
  AlertCircle,
  CheckCircle,
  Wallet,
  Building2,
  Receipt,
  Calendar,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Search,
  X,
  Download,
  Filter,
  ArrowDownCircle,
  ArrowUpCircle,
} from 'lucide-react';
import {
  fetchBankStatements,
  JdeApiError,
  type BankAccountStatement,
  type BankStatementLine,
  type BankStatementFormat,
} from '../services/jde';

/* ═══════════════════════════════════════════════════════════════════════
   Props
   ═══════════════════════════════════════════════════════════════════════ */

interface BancosProps {
  selectedCia: string;
  statements: BankAccountStatement[];
  onStatementsChange: (list: BankAccountStatement[]) => void;
  lastQuery: { fechaEstadoCuenta: string; formatoElectronico: BankStatementFormat } | null;
  onLastQueryChange: (q: { fechaEstadoCuenta: string; formatoElectronico: BankStatementFormat } | null) => void;
}

type BancosView = 'form' | 'dashboard';
type TipoFilter = 'all' | 'CARGO' | 'ABONO';

const FORMATS: BankStatementFormat[] = ['SWIFT', 'BAI2', 'MT940'];

/* ═══════════════════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════════════════ */

const todayISO = () => new Date().toISOString().slice(0, 10);

const fmtCurrency = (v: number, moneda = 'MXN'): string => {
  try {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: moneda, minimumFractionDigits: 2 }).format(v);
  } catch {
    return `${moneda} ${v.toFixed(2)}`;
  }
};

const fmtCompact = (v: number): string => {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(0);
};

const csvEscape = (v: string | number | undefined): string => {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/* ═══════════════════════════════════════════════════════════════════════
   Form view — inicial / nueva consulta
   ═══════════════════════════════════════════════════════════════════════ */

const BancosForm = ({
  initial,
  onLoaded,
}: {
  initial: { fechaEstadoCuenta: string; formatoElectronico: BankStatementFormat } | null;
  onLoaded: (
    statements: BankAccountStatement[],
    query: { fechaEstadoCuenta: string; formatoElectronico: BankStatementFormat },
  ) => void;
}) => {
  const [fecha, setFecha] = useState<string>(initial?.fechaEstadoCuenta ?? todayISO());
  const [formato, setFormato] = useState<BankStatementFormat>(initial?.formatoElectronico ?? 'SWIFT');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [count, setCount] = useState(0);

  const consultar = useCallback(async () => {
    setLoading(true); setError(null); setSuccess(false);
    try {
      const res = await fetchBankStatements({ fechaEstadoCuenta: fecha, formatoElectronico: formato });
      if (res.length === 0) throw new Error(`JDE devolvió 0 cuentas para ${fecha} (${formato})`);
      setCount(res.length);
      setSuccess(true);
      setTimeout(() => onLoaded(res, { fechaEstadoCuenta: fecha, formatoElectronico: formato }), 500);
    } catch (e) {
      if (e instanceof JdeApiError) {
        const hint = e.status === 401 ? ' — revisa VITE_JDE_TOKEN en .env.local' : '';
        setError(`JDE ${e.status}: ${e.message}${hint}`);
      } else {
        setError(e instanceof Error ? e.message : 'Error al consultar JDE');
      }
      setLoading(false);
    }
  }, [fecha, formato, onLoaded]);

  return (
    <div className="w-full max-w-lg mx-auto">
      <div className="text-center mb-8">
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#0071e3] to-[#40a9ff] flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-200/50">
          <Landmark className="text-white" size={26} />
        </div>
        <h1 className="text-[28px] font-bold text-[#1d1d1f] tracking-tight">Bancos</h1>
        <p className="text-[15px] text-[#86868b] mt-1">Estado de cuenta bancario desde JDE</p>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-[#d2d2d7]/40 p-8">
        {!loading && !success && (
          <div className="space-y-5">
            <div>
              <label className="block text-[12px] font-medium text-[#6e6e73] mb-1.5">Fecha estado de cuenta</label>
              <input
                type="date"
                value={fecha}
                onChange={e => setFecha(e.target.value)}
                className="w-full px-3 h-10 rounded-xl border border-[#d2d2d7] bg-white text-[13.5px] text-[#1d1d1f] focus:outline-none focus:ring-2 focus:ring-[#0071e3]/30 focus:border-[#0071e3]"
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[#6e6e73] mb-1.5">Formato electrónico</label>
              <select
                value={formato}
                onChange={e => setFormato(e.target.value as BankStatementFormat)}
                className="w-full px-3 h-10 rounded-xl border border-[#d2d2d7] bg-white text-[13.5px] text-[#1d1d1f] focus:outline-none focus:ring-2 focus:ring-[#0071e3]/30 focus:border-[#0071e3]"
              >
                {FORMATS.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <button
              onClick={consultar}
              disabled={!fecha}
              className="w-full h-11 rounded-xl bg-[#0071e3] text-white text-[14px] font-medium hover:bg-[#0077ed] shadow-sm shadow-[#0071e3]/20 disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center justify-center gap-2"
            >
              <Landmark className="w-4 h-4" /> Consultar
            </button>

            {error && (
              <div className="bg-[#fff5f5] border border-red-100 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <AlertCircle className="text-[#ff3b30] flex-shrink-0 mt-0.5" size={18} />
                  <div>
                    <p className="text-[13px] font-semibold text-[#1d1d1f]">Error al consultar JDE</p>
                    <p className="text-[12px] text-[#6e6e73] mt-1">{error}</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {loading && !success && (
          <div className="text-center py-16">
            <Loader2 className="w-8 h-8 text-[#0071e3] animate-spin mx-auto mb-3" />
            <p className="text-[15px] font-medium text-[#1d1d1f]">Consultando JDE...</p>
            <p className="text-[12px] text-[#86868b] mt-1">{fecha} · {formato}</p>
          </div>
        )}

        {success && (
          <div className="text-center py-14">
            <CheckCircle className="w-12 h-12 text-[#34c759] mx-auto mb-3" />
            <p className="text-[15px] font-semibold text-[#1d1d1f]">{count.toLocaleString()} cuenta{count !== 1 ? 's' : ''} cargada{count !== 1 ? 's' : ''}</p>
            <p className="text-[13px] text-[#86868b] mt-1">Abriendo dashboard...</p>
          </div>
        )}
      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════════
   Dashboard
   ═══════════════════════════════════════════════════════════════════════ */

const BancosDashboard = ({
  statements,
  query,
  selectedCia,
  onReset,
  onRefresh,
  refreshing,
  refreshError,
}: {
  statements: BankAccountStatement[];
  query: { fechaEstadoCuenta: string; formatoElectronico: BankStatementFormat };
  selectedCia: string;
  onReset: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  refreshError: string | null;
}) => {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [bancoFilter, setBancoFilter] = useState<string>('all');
  const [monedaFilter, setMonedaFilter] = useState<string>('all');
  const [tipoFilter, setTipoFilter] = useState<TipoFilter>('all');

  // ── Filter accounts by cia, banco, moneda (account-level) ──
  const accountsFiltered = useMemo(() => {
    return statements.filter(s => {
      if (selectedCia !== 'all' && s.cia !== selectedCia) return false;
      if (bancoFilter !== 'all' && (s.nombreBanco ?? s.banco) !== bancoFilter) return false;
      if (monedaFilter !== 'all' && s.moneda !== monedaFilter) return false;
      return true;
    });
  }, [statements, selectedCia, bancoFilter, monedaFilter]);

  // Movement-level filter (search + tipo)
  const accountsView = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    return accountsFiltered.map(acc => {
      const movimientos = acc.movimientos.filter(m => {
        if (tipoFilter !== 'all' && m.tipoMovimiento !== tipoFilter) return false;
        if (needle) {
          const hay = `${m.referencia} ${m.concepto}`.toLowerCase();
          if (!hay.includes(needle)) return false;
        }
        return true;
      });
      return { ...acc, movimientos };
    });
  }, [accountsFiltered, searchTerm, tipoFilter]);

  const bancoOptions = useMemo(
    () => Array.from(new Set(statements.map(s => s.nombreBanco ?? s.banco))).sort(),
    [statements],
  );
  const monedaOptions = useMemo(
    () => Array.from(new Set(statements.map(s => s.moneda))).sort(),
    [statements],
  );

  // ── KPIs ──
  const totalCuentas = accountsView.length;
  const totalMovs = accountsView.reduce((s, a) => s + a.movimientos.length, 0);
  const saldoTotal = accountsView.reduce((s, a) => s + (a.saldoFinal ?? a.saldoInicial ?? 0), 0);
  const totalCargos = accountsView.reduce((s, a) =>
    s + a.movimientos.filter(m => m.tipoMovimiento === 'CARGO').reduce((x, m) => x + m.importe, 0), 0);
  const totalAbonos = accountsView.reduce((s, a) =>
    s + a.movimientos.filter(m => m.tipoMovimiento === 'ABONO').reduce((x, m) => x + m.importe, 0), 0);

  const hasFilters = bancoFilter !== 'all' || monedaFilter !== 'all' || tipoFilter !== 'all' || searchTerm !== '';
  const clearFilters = () => { setBancoFilter('all'); setMonedaFilter('all'); setTipoFilter('all'); setSearchTerm(''); };

  const exportCsv = () => {
    const header = ['cia','banco','cuenta','moneda','fechaOperacion','fechaValor','referencia','concepto','tipoMovimiento','importe','saldo'];
    const rows: string[] = [header.join(',')];
    accountsView.forEach(acc => {
      acc.movimientos.forEach(m => {
        rows.push([
          acc.cia, acc.banco, acc.cuenta, acc.moneda,
          m.fechaOperacion, m.fechaValor ?? '',
          m.referencia, m.concepto, m.tipoMovimiento,
          m.importe, m.saldo ?? '',
        ].map(csvEscape).join(','));
      });
    });
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `estado-cuenta-${query.fechaEstadoCuenta}-${query.formatoElectronico}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      {/* ── Top bar ── */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center bg-white rounded-full border border-[#d2d2d7]/40 px-3 py-1.5 gap-2 shadow-sm">
          <Search className="w-3.5 h-3.5 text-[#86868b]" />
          <input
            type="text"
            placeholder="Buscar referencia o concepto..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="text-[13px] bg-transparent border-none outline-none w-64 placeholder:text-[#c7c7cc]"
          />
          {searchTerm && <button onClick={() => setSearchTerm('')}><X className="w-3.5 h-3.5 text-[#86868b]" /></button>}
        </div>

        <select value={bancoFilter} onChange={e => setBancoFilter(e.target.value)}
          className="text-[13px] bg-white rounded-full border border-[#d2d2d7]/40 px-4 py-1.5 shadow-sm text-[#1d1d1f] cursor-pointer">
          <option value="all">Todos los bancos</option>
          {bancoOptions.map(b => <option key={b} value={b}>{b}</option>)}
        </select>

        <select value={monedaFilter} onChange={e => setMonedaFilter(e.target.value)}
          className="text-[13px] bg-white rounded-full border border-[#d2d2d7]/40 px-4 py-1.5 shadow-sm text-[#1d1d1f] cursor-pointer">
          <option value="all">Todas las monedas</option>
          {monedaOptions.map(m => <option key={m} value={m}>{m}</option>)}
        </select>

        <select value={tipoFilter} onChange={e => setTipoFilter(e.target.value as TipoFilter)}
          className="text-[13px] bg-white rounded-full border border-[#d2d2d7]/40 px-4 py-1.5 shadow-sm text-[#1d1d1f] cursor-pointer">
          <option value="all">Cargos y abonos</option>
          <option value="ABONO">Solo abonos</option>
          <option value="CARGO">Solo cargos</option>
        </select>

        {hasFilters && (
          <button onClick={clearFilters} className="text-[12px] text-[#86868b] hover:text-[#0071e3] flex items-center gap-1 transition">
            <Filter className="w-3 h-3" /> Limpiar filtros
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={exportCsv}
            disabled={totalMovs === 0}
            className="text-[12px] text-[#86868b] hover:text-[#0071e3] flex items-center gap-1 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Download className="w-3 h-3" /> Exportar CSV
          </button>
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="text-[12px] text-[#86868b] hover:text-[#0071e3] flex items-center gap-1 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {refreshing
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <RotateCcw className="w-3 h-3" />} Actualizar
          </button>
          <button onClick={onReset} className="text-[12px] text-[#86868b] hover:text-[#ff3b30] flex items-center gap-1 transition">
            <X className="w-3 h-3" /> Nueva consulta
          </button>
        </div>
      </div>

      {/* ── cia filter banner ── */}
      {selectedCia !== 'all' && (
        <div className="bg-[#e8f4fd] border border-[#0071e3]/20 rounded-xl px-4 py-2.5 flex items-center gap-2 text-[13px] text-[#0071e3] font-medium">
          <Filter className="w-3.5 h-3.5" />
          Filtrando por compañía {selectedCia} — {totalCuentas} cuenta{totalCuentas !== 1 ? 's' : ''}
        </div>
      )}

      {refreshError && (
        <div className="bg-[#fff5f5] border border-red-100 rounded-xl px-4 py-2.5 flex items-center gap-2 text-[13px] text-[#ff3b30] font-medium">
          <AlertCircle className="w-3.5 h-3.5" /> {refreshError}
        </div>
      )}

      {/* ── KPI cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Saldo Total', value: fmtCurrency(saldoTotal), sub: `${totalCuentas} cuenta${totalCuentas !== 1 ? 's' : ''}`, icon: Wallet, color: '#0071e3' },
          { label: 'Abonos', value: fmtCompact(totalAbonos), sub: 'Entradas', icon: ArrowDownCircle, color: '#34c759' },
          { label: 'Cargos', value: fmtCompact(totalCargos), sub: 'Salidas', icon: ArrowUpCircle, color: '#ff3b30' },
          { label: 'Movimientos', value: totalMovs.toLocaleString(), sub: `Al ${query.fechaEstadoCuenta}`, icon: Receipt, color: '#af52de' },
        ].map((kpi, i) => {
          const Icon = kpi.icon;
          return (
            <div key={i} className="bg-white rounded-2xl border border-[#d2d2d7]/40 p-4 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[11px] font-medium text-[#86868b] uppercase tracking-wider">{kpi.label}</p>
                <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ backgroundColor: kpi.color + '14' }}>
                  <Icon className="w-3.5 h-3.5" style={{ color: kpi.color }} />
                </div>
              </div>
              <p className="text-[22px] font-bold font-mono tracking-tight text-[#1d1d1f]">{kpi.value}</p>
              <p className="text-[11px] text-[#86868b] mt-0.5">{kpi.sub}</p>
            </div>
          );
        })}
      </div>

      {/* ── Query chip ── */}
      <div className="flex items-center gap-2 text-[12px] text-[#86868b]">
        <Calendar className="w-3.5 h-3.5" />
        <span>Estado al <span className="text-[#1d1d1f] font-medium">{query.fechaEstadoCuenta}</span></span>
        <span className="text-[#c7c7cc]">·</span>
        <span>Formato <span className="text-[#1d1d1f] font-medium">{query.formatoElectronico}</span></span>
      </div>

      {/* ── Accounts list ── */}
      <div className="bg-white rounded-2xl border border-[#d2d2d7]/40 shadow-sm overflow-hidden">
        <div className="p-4 border-b border-[#e8e8ed]">
          <h2 className="text-[15px] font-semibold text-[#1d1d1f]">
            Cuentas <span className="text-[#86868b] font-normal ml-1">({accountsView.length.toLocaleString()})</span>
          </h2>
        </div>

        {accountsView.length === 0 ? (
          <div className="p-10 text-center text-[13px] text-[#86868b]">
            No hay cuentas con los filtros actuales.
          </div>
        ) : (
          <div className="divide-y divide-[#f5f5f7]">
            {accountsView.map(acc => {
              const key = `${acc.cia}::${acc.banco}::${acc.cuenta}::${acc.moneda}`;
              const isExpanded = expanded === key;
              const saldo = acc.saldoFinal ?? acc.saldoInicial ?? 0;
              return (
                <div key={key}>
                  <button
                    onClick={() => setExpanded(isExpanded ? null : key)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[#fbfbfd] transition text-left"
                  >
                    {isExpanded
                      ? <ChevronDown className="w-4 h-4 text-[#86868b]" />
                      : <ChevronRight className="w-4 h-4 text-[#86868b]" />}

                    <div className="w-9 h-9 rounded-xl bg-[#f5f5f7] flex items-center justify-center flex-shrink-0">
                      <Building2 className="w-4 h-4 text-[#0071e3]" />
                    </div>

                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium text-[#1d1d1f] truncate">
                        {acc.nombreBanco ?? acc.banco}
                        <span className="text-[#86868b] font-normal ml-2">· {acc.cuenta}</span>
                      </p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[#f5f5f7] text-[#6e6e73]">{acc.moneda}</span>
                        <span className="text-[11px] text-[#86868b]">Cia {acc.cia}</span>
                        <span className="text-[11px] text-[#86868b]">· {acc.movimientos.length} mov.</span>
                      </div>
                    </div>

                    <div className="text-right w-36">
                      <p className="text-[13px] font-mono font-semibold text-[#1d1d1f]">{fmtCurrency(saldo, acc.moneda)}</p>
                      <p className="text-[10px] text-[#86868b]">
                        {acc.saldoFinal !== undefined ? 'Saldo final' : acc.saldoInicial !== undefined ? 'Saldo inicial' : 'Sin saldo'}
                      </p>
                    </div>
                  </button>

                  {isExpanded && <BancosMovimientos acc={acc} />}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════════
   Movements table
   ═══════════════════════════════════════════════════════════════════════ */

const BancosMovimientos = ({ acc }: { acc: BankAccountStatement & { movimientos: BankStatementLine[] } }) => {
  if (acc.movimientos.length === 0) {
    return (
      <div className="bg-[#fbfbfd] px-4 py-6 text-center text-[12px] text-[#86868b]">
        Sin movimientos con los filtros actuales.
      </div>
    );
  }

  const totalCargos = acc.movimientos.filter(m => m.tipoMovimiento === 'CARGO').reduce((s, m) => s + m.importe, 0);
  const totalAbonos = acc.movimientos.filter(m => m.tipoMovimiento === 'ABONO').reduce((s, m) => s + m.importe, 0);

  return (
    <div className="bg-[#fbfbfd] px-4 pb-3">
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-[#e8e8ed]">
              <th className="text-left py-2 text-[#86868b] font-semibold">Fecha</th>
              <th className="text-left py-2 text-[#86868b] font-semibold">Referencia</th>
              <th className="text-left py-2 text-[#86868b] font-semibold">Concepto</th>
              <th className="text-center py-2 text-[#86868b] font-semibold">Tipo</th>
              <th className="text-right py-2 text-[#86868b] font-semibold">Importe</th>
              <th className="text-right py-2 text-[#86868b] font-semibold">Saldo</th>
            </tr>
          </thead>
          <tbody>
            {acc.movimientos.map((m, i) => {
              const isCargo = m.tipoMovimiento === 'CARGO';
              return (
                <tr key={i} className="border-b border-[#f5f5f7]">
                  <td className="py-1.5 text-[#6e6e73] whitespace-nowrap">{m.fechaOperacion}</td>
                  <td className="py-1.5 font-mono text-[#1d1d1f]">{m.referencia || '—'}</td>
                  <td className="py-1.5 text-[#6e6e73] max-w-[320px] truncate" title={m.concepto}>{m.concepto || '—'}</td>
                  <td className="py-1.5 text-center">
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                      isCargo ? 'bg-[#ffecec] text-[#ff3b30]' : 'bg-[#e5f9ec] text-[#34c759]'
                    }`}>
                      {m.tipoMovimiento}
                    </span>
                  </td>
                  <td className={`py-1.5 text-right font-mono font-medium ${isCargo ? 'text-[#ff3b30]' : 'text-[#34c759]'}`}>
                    {isCargo ? '-' : '+'}{fmtCurrency(m.importe, acc.moneda)}
                  </td>
                  <td className="py-1.5 text-right font-mono text-[#1d1d1f]">
                    {m.saldo !== undefined ? fmtCurrency(m.saldo, acc.moneda) : '—'}
                  </td>
                </tr>
              );
            })}
            <tr className="border-t-2 border-[#d2d2d7] bg-[#f5f5f7] font-semibold">
              <td className="py-2" colSpan={3}>Totales visibles</td>
              <td className="py-2 text-center text-[#86868b] text-[10px]">—</td>
              <td className="py-2 text-right font-mono">
                <span className="text-[#34c759]">+{fmtCurrency(totalAbonos, acc.moneda)}</span>
                <span className="text-[#c7c7cc] mx-1">/</span>
                <span className="text-[#ff3b30]">-{fmtCurrency(totalCargos, acc.moneda)}</span>
              </td>
              <td className="py-2 text-right font-mono text-[#1d1d1f]">
                {acc.saldoFinal !== undefined ? fmtCurrency(acc.saldoFinal, acc.moneda) : '—'}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════════
   Main Bancos component
   ═══════════════════════════════════════════════════════════════════════ */

const Bancos = ({
  selectedCia,
  statements,
  onStatementsChange,
  lastQuery,
  onLastQueryChange,
}: BancosProps) => {
  const [view, setView] = useState<BancosView>(
    statements.length > 0 && lastQuery ? 'dashboard' : 'form'
  );
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const handleLoaded = useCallback(
    (result: BankAccountStatement[], q: { fechaEstadoCuenta: string; formatoElectronico: BankStatementFormat }) => {
      onStatementsChange(result);
      onLastQueryChange(q);
      setView('dashboard');
    },
    [onStatementsChange, onLastQueryChange],
  );

  const handleReset = useCallback(() => {
    onStatementsChange([]);
    onLastQueryChange(null);
    setRefreshError(null);
    setView('form');
  }, [onStatementsChange, onLastQueryChange]);

  const handleRefresh = useCallback(async () => {
    if (!lastQuery) return;
    setRefreshing(true); setRefreshError(null);
    try {
      const res = await fetchBankStatements(lastQuery);
      onStatementsChange(res);
    } catch (e) {
      if (e instanceof JdeApiError) {
        setRefreshError(`JDE ${e.status}: ${e.message}`);
      } else {
        setRefreshError(e instanceof Error ? e.message : 'Error al actualizar');
      }
    } finally {
      setRefreshing(false);
    }
  }, [lastQuery, onStatementsChange]);

  if (view === 'form' || !lastQuery) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center p-6">
        <BancosForm initial={lastQuery} onLoaded={handleLoaded} />
      </div>
    );
  }

  return (
    <BancosDashboard
      statements={statements}
      query={lastQuery}
      selectedCia={selectedCia}
      onReset={handleReset}
      onRefresh={handleRefresh}
      refreshing={refreshing}
      refreshError={refreshError}
    />
  );
};

export default Bancos;
