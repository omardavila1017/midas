import { useState, useCallback, useMemo, useEffect } from 'react';
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
import { hex } from '../theme';
import { fmtCurrency as fmtCurrencyUnified, fmtCompact as fmtCompactUnified } from '../formatters';

/* ═══════════════════════════════════════════════════════════════════════
   Props
   ═══════════════════════════════════════════════════════════════════════ */

interface BancosProps {
  selectedCia: string;
  statements: BankAccountStatement[];
  onStatementsChange: (list: BankAccountStatement[]) => void;
  lastQuery: { fechaEstadoCuenta: string; formatoElectronico: BankStatementFormat } | null;
  onLastQueryChange: (q: { fechaEstadoCuenta: string; formatoElectronico: BankStatementFormat } | null) => void;
  companies?: { cia: string; nombre: string }[];
}

type BancosView = 'form' | 'dashboard';
type TipoFilter = 'all' | 'CARGO' | 'ABONO';

const FORMATS: BankStatementFormat[] = ['SWIFT', 'BAI2', 'MT940'];

/* ═══════════════════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════════════════ */

const todayISO = () => new Date().toISOString().slice(0, 10);

/* Formatters → unified imports from ../formatters */
const fmtCurrency = (v: number, _moneda = 'MXN'): string => fmtCurrencyUnified(v);
const fmtCompact = (v: number): string => fmtCompactUnified(v);

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
      onLoaded(res, { fechaEstadoCuenta: fecha, formatoElectronico: formato });
    } catch (e) {
      if (e instanceof JdeApiError) {
        const hint = e.status === 401 ? ' — error de autenticación con el servidor' : '';
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
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[var(--primary)] to-[var(--info)] flex items-center justify-center mx-auto mb-4 shadow-lg shadow-[var(--primary)]/15">
          <Landmark className="text-white" size={26} />
        </div>
        <h1 className="text-[28px] font-bold text-[var(--gray-950)] tracking-tight">Bancos</h1>
        <p className="text-[15px] text-[var(--gray-400)] mt-1">Estado de cuenta bancario desde JDE</p>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-[var(--gray-200)] p-8">
        {!loading && !success && (
          <div className="space-y-5">
            <div>
              <label className="block text-[12px] font-medium text-[var(--gray-500)] mb-1.5">Fecha estado de cuenta</label>
              <input
                type="date"
                value={fecha}
                onChange={e => setFecha(e.target.value)}
                className="w-full px-3 h-10 rounded-xl border border-[var(--gray-200)] bg-white text-[13.5px] text-[var(--gray-950)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/30 focus:border-[var(--primary)]"
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--gray-500)] mb-1.5">Formato electrónico</label>
              <select
                value={formato}
                onChange={e => setFormato(e.target.value as BankStatementFormat)}
                className="w-full px-3 h-10 rounded-xl border border-[var(--gray-200)] bg-white text-[13.5px] text-[var(--gray-950)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/30 focus:border-[var(--primary)]"
              >
                {FORMATS.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <button
              onClick={consultar}
              disabled={!fecha}
              className="w-full h-11 rounded-xl bg-[var(--primary)] text-white text-[14px] font-medium hover:bg-[var(--primary-hover)] shadow-sm shadow-[var(--primary)]/20 disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center justify-center gap-2"
            >
              <Landmark className="w-4 h-4" /> Consultar
            </button>

            {error && (
              <div className="bg-[var(--danger-muted)] border border-red-100 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <AlertCircle className="text-[var(--danger)] flex-shrink-0 mt-0.5" size={18} />
                  <div>
                    <p className="text-[13px] font-semibold text-[var(--gray-950)]">Error al consultar JDE</p>
                    <p className="text-[12px] text-[var(--gray-500)] mt-1">{error}</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {loading && !success && (
          <div className="text-center py-16">
            <Loader2 className="w-8 h-8 text-[var(--primary)] animate-spin mx-auto mb-3" />
            <p className="text-[15px] font-medium text-[var(--gray-950)]">Consultando JDE...</p>
            <p className="text-[12px] text-[var(--gray-400)] mt-1">{fecha} · {formato}</p>
          </div>
        )}

        {success && (
          <div className="text-center py-14">
            <CheckCircle className="w-12 h-12 text-[var(--success)] mx-auto mb-3" />
            <p className="text-[15px] font-semibold text-[var(--gray-950)]">{count.toLocaleString()} cuenta{count !== 1 ? 's' : ''} cargada{count !== 1 ? 's' : ''}</p>
            <p className="text-[13px] text-[var(--gray-400)] mt-1">Abriendo dashboard...</p>
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
  companies = [],
}: {
  statements: BankAccountStatement[];
  query: { fechaEstadoCuenta: string; formatoElectronico: BankStatementFormat };
  selectedCia: string;
  onReset: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  refreshError: string | null;
  companies?: { cia: string; nombre: string }[];
}) => {
  // Build a cia→nombre lookup map
  const ciaNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of companies) map.set(c.cia, c.nombre);
    return map;
  }, [companies]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [bancoFilter, setBancoFilter] = useState<string>('all');
  const [monedaFilter, setMonedaFilter] = useState<string>('all');
  const [tipoFilter, setTipoFilter] = useState<TipoFilter>('all');

  // ── Filter accounts by cia, banco, moneda (account-level) ──
  // Note: cia may be "" for TMPB format where Cuenta_Contable is null;
  // those accounts show regardless of company filter.
  const accountsFiltered = useMemo(() => {
    return statements.filter(s => {
      if (selectedCia !== 'all' && s.cia && s.cia !== selectedCia) return false;
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
    () => Array.from(new Set(statements.map(s => s.nombreBanco ?? s.banco).filter(Boolean))).sort(),
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
    const header = ['cia','empresa','banco','cuenta','moneda','fechaOperacion','fechaValor','referencia','concepto','tipoMovimiento','importe','saldo'];
    const rows: string[] = [header.join(',')];
    accountsView.forEach(acc => {
      const empresaNombre = ciaNameMap.get(acc.cia) ?? '';
      acc.movimientos.forEach(m => {
        rows.push([
          acc.cia, empresaNombre, acc.banco, acc.cuenta, acc.moneda,
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
        <div className="flex items-center bg-white rounded-full border border-[var(--gray-200)] px-3 py-1.5 gap-2 shadow-sm">
          <Search className="w-3.5 h-3.5 text-[var(--gray-400)]" />
          <input
            type="text"
            placeholder="Buscar referencia o concepto..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="text-[13px] bg-transparent border-none outline-none w-64 placeholder:text-[var(--gray-300)]"
          />
          {searchTerm && <button onClick={() => setSearchTerm('')}><X className="w-3.5 h-3.5 text-[var(--gray-400)]" /></button>}
        </div>

        <select value={bancoFilter} onChange={e => setBancoFilter(e.target.value)}
          className="text-[13px] bg-white rounded-full border border-[var(--gray-200)] px-4 py-1.5 shadow-sm text-[var(--gray-950)] cursor-pointer">
          <option value="all">Todos los bancos</option>
          {bancoOptions.map(b => <option key={b} value={b}>{b}</option>)}
        </select>

        <select value={monedaFilter} onChange={e => setMonedaFilter(e.target.value)}
          className="text-[13px] bg-white rounded-full border border-[var(--gray-200)] px-4 py-1.5 shadow-sm text-[var(--gray-950)] cursor-pointer">
          <option value="all">Todas las monedas</option>
          {monedaOptions.map(m => <option key={m} value={m}>{m}</option>)}
        </select>

        <select value={tipoFilter} onChange={e => setTipoFilter(e.target.value as TipoFilter)}
          className="text-[13px] bg-white rounded-full border border-[var(--gray-200)] px-4 py-1.5 shadow-sm text-[var(--gray-950)] cursor-pointer">
          <option value="all">Cargos y abonos</option>
          <option value="ABONO">Solo abonos</option>
          <option value="CARGO">Solo cargos</option>
        </select>

        {hasFilters && (
          <button onClick={clearFilters} className="text-[12px] text-[var(--gray-400)] hover:text-[var(--primary)] flex items-center gap-1 transition">
            <Filter className="w-3 h-3" /> Limpiar filtros
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={exportCsv}
            disabled={totalMovs === 0}
            className="text-[12px] text-[var(--gray-400)] hover:text-[var(--primary)] flex items-center gap-1 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Download className="w-3 h-3" /> Exportar CSV
          </button>
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="text-[12px] text-[var(--gray-400)] hover:text-[var(--primary)] flex items-center gap-1 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {refreshing
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <RotateCcw className="w-3 h-3" />} Actualizar
          </button>
          <button onClick={onReset} className="text-[12px] text-[var(--gray-400)] hover:text-[var(--danger)] flex items-center gap-1 transition">
            <X className="w-3 h-3" /> Nueva consulta
          </button>
        </div>
      </div>

      {/* ── cia filter banner ── */}
      {selectedCia !== 'all' && (
        <div className="bg-[var(--primary-muted)] border border-[var(--primary)]/20 rounded-xl px-4 py-2.5 flex items-center gap-2 text-[13px] text-[var(--primary)] font-medium">
          <Filter className="w-3.5 h-3.5" />
          Filtrando por {ciaNameMap.get(selectedCia) ?? `compañía ${selectedCia}`} — {totalCuentas} cuenta{totalCuentas !== 1 ? 's' : ''}
          {statements.some(s => !s.cia) && (
            <span className="text-[11px] text-[var(--gray-400)] font-normal ml-2">
              (cuentas sin empresa asignada se muestran siempre)
            </span>
          )}
        </div>
      )}

      {refreshError && (
        <div className="bg-[var(--danger-muted)] border border-red-100 rounded-xl px-4 py-2.5 flex items-center gap-2 text-[13px] text-[var(--danger)] font-medium">
          <AlertCircle className="w-3.5 h-3.5" /> {refreshError}
        </div>
      )}

      {/* ── KPI cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Saldo Total', value: fmtCurrency(saldoTotal), sub: `${totalCuentas} cuenta${totalCuentas !== 1 ? 's' : ''}`, icon: Wallet, color: hex.primary },
          { label: 'Abonos', value: fmtCurrency(totalAbonos), sub: 'Entradas', icon: ArrowDownCircle, color: hex.success },
          { label: 'Cargos', value: fmtCurrency(totalCargos), sub: 'Salidas', icon: ArrowUpCircle, color: hex.danger },
          { label: 'Movimientos', value: totalMovs.toLocaleString(), sub: `Al ${query.fechaEstadoCuenta}`, icon: Receipt, color: '#af52de' },
        ].map((kpi, i) => {
          const Icon = kpi.icon;
          return (
            <div key={i} className="bg-white rounded-2xl border border-[var(--gray-200)] p-4 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[11px] font-medium text-[var(--gray-400)] uppercase tracking-wider">{kpi.label}</p>
                <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ backgroundColor: kpi.color + '14' }}>
                  <Icon className="w-3.5 h-3.5" style={{ color: kpi.color }} />
                </div>
              </div>
              <p className="text-[22px] font-bold font-mono tracking-tight text-[var(--gray-950)]">{kpi.value}</p>
              <p className="text-[11px] text-[var(--gray-400)] mt-0.5">{kpi.sub}</p>
            </div>
          );
        })}
      </div>

      {/* ── Query chip ── */}
      <div className="flex items-center gap-2 text-[12px] text-[var(--gray-400)]">
        <Calendar className="w-3.5 h-3.5" />
        <span>Estado al <span className="text-[var(--gray-950)] font-medium">{query.fechaEstadoCuenta}</span></span>
        <span className="text-[var(--gray-300)]">·</span>
        <span>Formato <span className="text-[var(--gray-950)] font-medium">{query.formatoElectronico}</span></span>
      </div>

      {/* ── Accounts list ── */}
      <div className="bg-white rounded-2xl border border-[var(--gray-200)] shadow-sm overflow-hidden">
        <div className="p-4 border-b border-[var(--gray-100)]">
          <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">
            Cuentas <span className="text-[var(--gray-400)] font-normal ml-1">({accountsView.length.toLocaleString()})</span>
          </h2>
        </div>

        {accountsView.length === 0 ? (
          <div className="p-10 text-center text-[13px] text-[var(--gray-400)]">
            No hay cuentas con los filtros actuales.
          </div>
        ) : (
          <div className="divide-y divide-[var(--gray-50)]">
            {accountsView.map(acc => {
              const key = `${acc.cia}::${acc.cuenta}::${acc.moneda}`;
              const isExpanded = expanded === key;
              const saldo = acc.saldoFinal ?? acc.saldoInicial ?? 0;
              const displayName = acc.nombreBanco || acc.banco || 'Cuenta bancaria';
              return (
                <div key={key}>
                  <button
                    onClick={() => setExpanded(isExpanded ? null : key)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[var(--surface-alt)] transition text-left"
                  >
                    {isExpanded
                      ? <ChevronDown className="w-4 h-4 text-[var(--gray-400)]" />
                      : <ChevronRight className="w-4 h-4 text-[var(--gray-400)]" />}

                    <div className="w-9 h-9 rounded-xl bg-[var(--gray-50)] flex items-center justify-center flex-shrink-0">
                      <Landmark className="w-4 h-4 text-[var(--primary)]" />
                    </div>

                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium text-[var(--gray-950)] truncate">
                        {displayName}
                        {acc.cuenta && <span className="text-[var(--gray-400)] font-normal ml-2">· {acc.cuenta}</span>}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[var(--gray-50)] text-[var(--gray-500)]">{acc.moneda}</span>
                        {acc.cia && (
                          <span className="text-[11px] text-[var(--gray-400)]">
                            {ciaNameMap.get(acc.cia) ?? `Cia ${acc.cia}`}
                          </span>
                        )}
                        <span className="text-[11px] text-[var(--gray-400)]">{acc.cia ? '· ' : ''}{acc.movimientos.length} mov.</span>
                      </div>
                    </div>

                    <div className="text-right w-36">
                      <p className="text-[13px] font-mono font-semibold text-[var(--gray-950)]">{fmtCurrency(saldo, acc.moneda)}</p>
                      <p className="text-[10px] text-[var(--gray-400)]">
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
      <div className="bg-[var(--surface-alt)] px-4 py-6 text-center text-[12px] text-[var(--gray-400)]">
        Sin movimientos con los filtros actuales.
      </div>
    );
  }

  const totalCargos = acc.movimientos.filter(m => m.tipoMovimiento === 'CARGO').reduce((s, m) => s + m.importe, 0);
  const totalAbonos = acc.movimientos.filter(m => m.tipoMovimiento === 'ABONO').reduce((s, m) => s + m.importe, 0);

  return (
    <div className="bg-[var(--surface-alt)] px-4 pb-3">
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-[var(--gray-100)]">
              <th className="text-left py-2 text-[var(--gray-400)] font-semibold">Fecha</th>
              <th className="text-left py-2 text-[var(--gray-400)] font-semibold">Referencia</th>
              <th className="text-left py-2 text-[var(--gray-400)] font-semibold">Concepto</th>
              <th className="text-center py-2 text-[var(--gray-400)] font-semibold">Tipo</th>
              <th className="text-right py-2 text-[var(--gray-400)] font-semibold">Importe</th>
              <th className="text-right py-2 text-[var(--gray-400)] font-semibold">Saldo</th>
            </tr>
          </thead>
          <tbody>
            {acc.movimientos.map((m, i) => {
              const isCargo = m.tipoMovimiento === 'CARGO';
              return (
                <tr key={i} className="border-b border-[var(--gray-50)]">
                  <td className="py-1.5 text-[var(--gray-500)] whitespace-nowrap">{m.fechaOperacion}</td>
                  <td className="py-1.5 font-mono text-[var(--gray-950)]">{m.referencia || '—'}</td>
                  <td className="py-1.5 text-[var(--gray-500)] max-w-[320px] truncate" title={m.concepto}>{m.concepto || '—'}</td>
                  <td className="py-1.5 text-center">
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                      isCargo ? 'bg-[var(--danger-muted)] text-[var(--danger)]' : 'bg-[var(--success-muted)] text-[var(--success)]'
                    }`}>
                      {m.tipoMovimiento}
                    </span>
                  </td>
                  <td className={`py-1.5 text-right font-mono font-medium ${isCargo ? 'text-[var(--danger)]' : 'text-[var(--success)]'}`}>
                    {isCargo ? '-' : '+'}{fmtCurrency(m.importe, acc.moneda)}
                  </td>
                  <td className="py-1.5 text-right font-mono text-[var(--gray-950)]">
                    {m.saldo !== undefined ? fmtCurrency(m.saldo, acc.moneda) : '—'}
                  </td>
                </tr>
              );
            })}
            <tr className="border-t-2 border-[var(--gray-200)] bg-[var(--gray-50)] font-semibold">
              <td className="py-2" colSpan={3}>Totales visibles</td>
              <td className="py-2 text-center text-[var(--gray-400)] text-[10px]">—</td>
              <td className="py-2 text-right font-mono">
                <span className="text-[var(--success)]">+{fmtCurrency(totalAbonos, acc.moneda)}</span>
                <span className="text-[var(--gray-300)] mx-1">/</span>
                <span className="text-[var(--danger)]">-{fmtCurrency(totalCargos, acc.moneda)}</span>
              </td>
              <td className="py-2 text-right font-mono text-[var(--gray-950)]">
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
  companies = [],
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

  // ── Auto-switch to dashboard when data arrives from App-level fetch ──
  useEffect(() => {
    if (statements.length > 0 && lastQuery && view === 'form') {
      setView('dashboard');
    }
  }, [statements.length, lastQuery, view]);

  const handleReset = useCallback(() => {
    onStatementsChange([]);
    onLastQueryChange(null);
    setRefreshError(null);
    setView('form');
  }, [onStatementsChange, onLastQueryChange]);

  const handleRefresh = useCallback(async () => {
    // Always refresh with today's date to get the latest data
    const queryToUse = {
      fechaEstadoCuenta: todayISO(),
      formatoElectronico: lastQuery?.formatoElectronico ?? 'SWIFT' as BankStatementFormat,
    };
    setRefreshing(true); setRefreshError(null);
    try {
      const res = await fetchBankStatements(queryToUse);
      onStatementsChange(res);
      onLastQueryChange(queryToUse);
    } catch (e) {
      if (e instanceof JdeApiError) {
        setRefreshError(`JDE ${e.status}: ${e.message}`);
      } else {
        setRefreshError(e instanceof Error ? e.message : 'Error al actualizar');
      }
    } finally {
      setRefreshing(false);
    }
  }, [lastQuery, onStatementsChange, onLastQueryChange]);

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
      companies={companies}
    />
  );
};

export default Bancos;
