import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  Landmark,
  Loader2,
  AlertCircle,
  CheckCircle,
  Wallet,
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
  Upload,
  Building2,
} from 'lucide-react';
import {
  fetchBankStatements,
  JdeApiError,
  type BankAccountStatement,
  type BankStatementLine,
  type BankStatementFormat,
} from '../services/jde';
import {
  buildOwnAccountDetector,
  buildOwnAccountsIndex,
  buildPairMatchedKeys,
  classifyMovement,
  INTERNAL_REASON_LABELS,
  type ClassificationContext,
  type InternalReason,
} from '../domain/netCashFlowEngine';
import {
  bankMovementKey,
  type AbonoEnrichment,
} from '../domain/realReconciliationEngine';
import {
  attachImportedStatementsToKnownCompanies,
  bankStatementBalance,
  currentBankStatements,
  latestStatementDate,
  mergeBankStatements,
  sumBankStatementBalances,
  type BankQueryState,
} from '../domain/bankStatements';
import { parseSantanderFile, SANTANDER_FILE_FORMAT } from '../domain/santanderCsv';
import { hex } from '../theme';
import { fmtCurrency as fmtCurrencyUnified } from '../formatters';
import {
  bankAccountBusinessUnitLabel,
  bankAccountFlowLabel,
  bankAccountRoleLabel,
  bankAccountSearchText,
  findBankAccount,
  type BankAccountCatalogEntry,
} from '../domain/bankAccountsCatalog';

/* ═══════════════════════════════════════════════════════════════════════
   Props
   ═══════════════════════════════════════════════════════════════════════ */

interface BancosProps {
  selectedCia: string;
  statements: BankAccountStatement[];
  supplementalStatements: BankAccountStatement[];
  onJdeStatementsChange: (list: BankAccountStatement[]) => void;
  onSupplementalStatementsChange: (list: BankAccountStatement[]) => void;
  lastQuery: BankQueryState | null;
  onLastQueryChange: (q: BankQueryState | null) => void;
  companies?: { cia: string; nombre: string }[];
  /**
   * Mapa pre-construido de bankMovementKey(mov) → AbonoEnrichment, viene
   * memoizado desde App.tsx tras correr el motor de cruce con cobranza.
   * Cuando llega vacío o `undefined`, los badges no se muestran y la
   * pestaña sigue funcionando como antes.
   */
  abonoEnrichmentIndex?: Map<string, AbonoEnrichment>;
  /**
   * Mapa de bankMovementKey(mov) → CargoPaymentEnrichment, memoizado desde
   * App.tsx tras correr el motor de PagoProveedor. Espejo egreso de
   * `abonoEnrichmentIndex`: revela qué pagos a proveedor generaron cada
   * CARGO y resalta CARGOs huérfanos (sin pago asociado).
   */
  cargoEnrichmentIndex?: Map<string, import('../domain/paymentReconciliationEngine').CargoPaymentEnrichment>;
}

type BancosView = 'form' | 'dashboard';
type TipoFilter = 'all' | 'CARGO' | 'ABONO';

const FORMATS: BankStatementFormat[] = ['SWIFT', 'BAI2', 'MT940'];

/* ═══════════════════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════════════════ */

const todayISO = () => new Date().toISOString().slice(0, 10);
const formatSourceLabel = (format: string, hasUploadedSantander?: boolean): string => {
  if (format === SANTANDER_FILE_FORMAT) return 'Archivo Santander';
  if (hasUploadedSantander) return `${format} + Archivo Santander`;
  return format;
};

async function readSantanderFile(
  file: File,
  selectedCia: string,
  existingStatements: BankAccountStatement[],
): Promise<{ statements: BankAccountStatement[]; latestDate: string }> {
  const text = await file.text();
  const defaultCia = /^\d{5}$/.test(selectedCia) ? selectedCia : '';
  const parsed = parseSantanderFile(text, { defaultCia });
  const statements = attachImportedStatementsToKnownCompanies(parsed, existingStatements);
  const latestDate = statements.reduce(
    (max, statement) => statement.fechaEstadoCuenta > max ? statement.fechaEstadoCuenta : max,
    statements[0]?.fechaEstadoCuenta ?? todayISO(),
  );
  return { statements, latestDate };
}

/* Formatters → unified imports from ../formatters */
const fmtCurrency = (v: number, _moneda = 'MXN'): string => fmtCurrencyUnified(v);

const csvEscape = (v: string | number | undefined): string => {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function accountCatalogEntry(acc: Pick<BankAccountStatement, 'cuenta' | 'cuentaBancos'>): BankAccountCatalogEntry | null {
  return findBankAccount(acc.cuentaBancos ?? acc.cuenta);
}

function catalogFlowClass(flow: string | undefined): string {
  if (flow === 'ingreso') return 'bg-[var(--success-muted)] text-[var(--success)]';
  if (flow === 'egreso') return 'bg-[var(--danger-muted)] text-[var(--danger)]';
  return 'bg-[var(--gray-100)] text-[var(--gray-500)]';
}

function BankAccountBadges({ entry }: { entry: BankAccountCatalogEntry | null }) {
  if (!entry) {
    return (
      <span className="inline-flex h-5 items-center rounded-full bg-[var(--warning-muted)] px-2 text-[10px] font-bold uppercase tracking-[0.05em] text-[var(--warning)]">
        Sin catálogo
      </span>
    );
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="inline-flex h-5 items-center rounded-full bg-[var(--primary-muted)] px-2 text-[10px] font-bold uppercase tracking-[0.05em] text-[var(--primary)]">
        {bankAccountBusinessUnitLabel(entry.unidadNegocio)}
      </span>
      <span className="inline-flex h-5 items-center rounded-full bg-[var(--gray-100)] px-2 text-[10px] font-medium text-[var(--gray-600)]">
        {bankAccountRoleLabel(entry.role)}
      </span>
      <span className={`inline-flex h-5 items-center rounded-full px-2 text-[10px] font-medium ${catalogFlowClass(entry.flow)}`}>
        {bankAccountFlowLabel(entry.flow)}
      </span>
      <span className="min-w-0 max-w-[360px] truncate text-[11px] text-[var(--gray-400)]" title={`${entry.razonSocial} · ${entry.concepto}`}>
        {entry.concepto}
      </span>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Form view — inicial / nueva consulta
   ═══════════════════════════════════════════════════════════════════════ */

const BancosForm = ({
  initial,
  selectedCia,
  onLoadedJde,
  onLoadedFile,
}: {
  initial: BankQueryState | null;
  selectedCia: string;
  onLoadedJde: (
    statements: BankAccountStatement[],
    query: BankQueryState,
  ) => void;
  onLoadedFile: (
    statements: BankAccountStatement[],
    query: BankQueryState,
  ) => void;
}) => {
  const santanderInputRef = useRef<HTMLInputElement | null>(null);
  const [fecha, setFecha] = useState<string>(initial?.fechaEstadoCuenta ?? todayISO());
  const [formato, setFormato] = useState<BankStatementFormat>(initial?.formatoElectronico ?? 'SWIFT');
  const [loading, setLoading] = useState(false);
  const [loadingSource, setLoadingSource] = useState<'jde' | 'file' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorSource, setErrorSource] = useState<'jde' | 'file' | null>(null);
  const [success, setSuccess] = useState(false);
  const [count, setCount] = useState(0);

  const consultar = useCallback(async () => {
    setLoading(true); setLoadingSource('jde'); setError(null); setErrorSource(null); setSuccess(false);
    try {
      const res = await fetchBankStatements({ fechaEstadoCuenta: fecha, formatoElectronico: formato });
      if (res.length === 0) throw new Error(`JDE devolvió 0 cuentas para ${fecha} (${formato})`);
      setCount(res.length);
      setSuccess(true);
      onLoadedJde(res, { fechaEstadoCuenta: fecha, formatoElectronico: formato });
    } catch (e) {
      if (e instanceof JdeApiError) {
        const hint = e.status === 401 ? ' — error de autenticación con el servidor' : '';
        setError(`JDE ${e.status}: ${e.message}${hint}`);
      } else {
        setError(e instanceof Error ? e.message : 'Error al consultar JDE');
      }
      setErrorSource('jde');
      setLoading(false);
    }
  }, [fecha, formato, onLoadedJde]);

  const cargarSantanderArchivo = useCallback(async (file: File) => {
    setLoading(true); setLoadingSource('file'); setError(null); setErrorSource(null); setSuccess(false);
    try {
      const result = parseSantanderFile(await file.text(), { defaultCia: /^\d{5}$/.test(selectedCia) ? selectedCia : '' });
      const latestDate = result.reduce(
        (max, statement) => statement.fechaEstadoCuenta > max ? statement.fechaEstadoCuenta : max,
        result[0]?.fechaEstadoCuenta ?? todayISO(),
      );
      setCount(result.length);
      setSuccess(true);
      onLoadedFile(result, { fechaEstadoCuenta: latestDate, formatoElectronico: SANTANDER_FILE_FORMAT, hasUploadedSantander: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al leer el archivo Santander');
      setErrorSource('file');
      setLoading(false);
    }
  }, [onLoadedFile, selectedCia]);

  return (
    <div className="w-full max-w-lg mx-auto">
      <div className="text-center mb-8">
        <div className="w-14 h-14 rounded-[var(--radius-lg)] bg-[var(--primary)] flex items-center justify-center mx-auto mb-4 shadow-lg shadow-[var(--primary)]/15">
          <Landmark className="text-white" size={26} />
        </div>
        <h1 className="text-[28px] font-bold text-white tracking-tight">Bancos</h1>
      </div>

      <div className="bg-white rounded-[var(--radius-lg)] shadow-sm border border-[var(--gray-200)] p-8">
        {!loading && !success && (
          <div className="space-y-5">
            <div>
              <label className="block text-[12px] font-medium text-[var(--gray-500)] mb-1.5">Fecha estado de cuenta</label>
              <input
                type="date"
                value={fecha}
                onChange={e => setFecha(e.target.value)}
                className="w-full px-3 h-10 rounded-[var(--radius)] border border-[var(--gray-200)] bg-white text-[13.5px] text-[var(--gray-950)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/30 focus:border-[var(--primary)]"
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--gray-500)] mb-1.5">Formato electrónico</label>
              <select
                value={formato}
                onChange={e => setFormato(e.target.value as BankStatementFormat)}
                className="w-full px-3 h-10 rounded-[var(--radius)] border border-[var(--gray-200)] bg-white text-[13.5px] text-[var(--gray-950)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/30 focus:border-[var(--primary)]"
              >
                {FORMATS.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <button
              onClick={consultar}
              disabled={!fecha}
              className="w-full h-11 rounded-[var(--radius)] bg-[var(--primary)] text-white text-[14px] font-medium hover:bg-[var(--primary-hover)] shadow-sm shadow-[var(--primary)]/20 disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center justify-center gap-2"
            >
              <Landmark className="w-4 h-4" /> Consultar
            </button>

            <div className="flex items-center gap-3 py-1">
              <div className="h-px flex-1 bg-[var(--gray-100)]" />
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--gray-300)]">o</span>
              <div className="h-px flex-1 bg-[var(--gray-100)]" />
            </div>

            <div className="space-y-2">
              <label className="block text-[12px] font-medium text-[var(--gray-500)]">Archivo Santander</label>
              <input
                ref={santanderInputRef}
                type="file"
                accept=".csv,.txt,text/csv,text/plain"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.currentTarget.value = '';
                  if (!file) return;
                  await cargarSantanderArchivo(file);
                }}
              />
              <button
                type="button"
                onClick={() => santanderInputRef.current?.click()}
                className="w-full h-11 rounded-[var(--radius)] border border-dashed border-[var(--gray-200)] bg-[var(--gray-50)] text-[13.5px] font-medium text-[var(--gray-700)] hover:border-[var(--primary)] hover:bg-[var(--primary-subtle)] transition flex items-center justify-center gap-2"
              >
                <Upload className="w-4 h-4" />
                Subir archivo Santander
              </button>
              <p className="text-[11px] text-[var(--gray-400)]">
                Carga el exportado CSV o TXT de movimientos para ver la cuenta en Bancos.
              </p>
            </div>

            {error && (
              <div className="bg-[var(--danger-muted)] border border-red-100 rounded-[var(--radius)] p-4">
                <div className="flex items-start gap-3">
                  <AlertCircle className="text-[var(--danger)] flex-shrink-0 mt-0.5" size={18} />
                  <div>
                    <p className="text-[13px] font-bold text-[var(--gray-950)]">
                      {errorSource === 'file' ? 'Error al leer archivo Santander' : 'Error al consultar JDE'}
                    </p>
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
            <p className="text-[15px] font-medium text-[var(--gray-950)]">
              {loadingSource === 'file' ? 'Leyendo archivo Santander...' : 'Consultando JDE...'}
            </p>
            <p className="text-[12px] text-[var(--gray-400)] mt-1">
              {loadingSource === 'file' ? 'Preparando movimientos bancarios' : `${fecha} · ${formato}`}
            </p>
          </div>
        )}

        {success && (
          <div className="text-center py-14">
            <CheckCircle className="w-12 h-12 text-[var(--success)] mx-auto mb-3" />
            <p className="text-[15px] font-bold text-[var(--gray-950)]">{count.toLocaleString()} cuenta{count !== 1 ? 's' : ''} cargada{count !== 1 ? 's' : ''}</p>
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
  onUploadFile,
  onRefresh,
  canRefresh,
  refreshing,
  uploadingFile,
  refreshError,
  companies = [],
  abonoEnrichmentIndex,
  cargoEnrichmentIndex,
}: {
  statements: BankAccountStatement[];
  query: BankQueryState;
  selectedCia: string;
  onReset: () => void;
  onUploadFile: (file: File) => Promise<void>;
  onRefresh: () => void;
  canRefresh: boolean;
  refreshing: boolean;
  uploadingFile: boolean;
  refreshError: string | null;
  companies?: { cia: string; nombre: string }[];
  abonoEnrichmentIndex?: Map<string, AbonoEnrichment>;
  cargoEnrichmentIndex?: Map<string, import('../domain/paymentReconciliationEngine').CargoPaymentEnrichment>;
}) => {
  const santanderInputRef = useRef<HTMLInputElement | null>(null);
  const refreshBlockedReason = 'Este dataset viene solo de archivo Santander. Para actualizarlo desde JDE, primero corre una consulta.';
  // Build a cia→nombre lookup map
  const ciaNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of companies) map.set(c.cia, c.nombre);
    return map;
  }, [companies]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [collapsedBanks, setCollapsedBanks] = useState<Set<string>>(new Set());
  const seenBanksRef = useRef<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [bancoFilter, setBancoFilter] = useState<string>('all');
  const [monedaFilter, setMonedaFilter] = useState<string>('all');
  const [tipoFilter, setTipoFilter] = useState<TipoFilter>('all');
  const [unidadFilter, setUnidadFilter] = useState<string>('all');
  const [roleFilter, setRoleFilter] = useState<string>('all');

  // Construir el contexto de clasificación una sola vez sobre el universo
  // completo (no sobre el subset filtrado) para que la detección de cuenta
  // propia y de pares cargo/abono funcione correctamente.
  const classificationCtx: ClassificationContext = useMemo(() => ({
    ownAccountDetector: buildOwnAccountDetector(buildOwnAccountsIndex(statements)),
    pairedKeys: buildPairMatchedKeys(statements),
  }), [statements]);

  const internalReasonOf = useCallback(
    (cia: string, cuenta: string, mov: BankStatementLine): InternalReason | null => {
      const c = classifyMovement(mov, classificationCtx, cia, cuenta);
      return c.kind === 'internal' ? (c.reason ?? null) : null;
    },
    [classificationCtx],
  );

  // ── Filter accounts by cia, banco, moneda (account-level) ──
  // Note: cia may be "" for TMPB format where Cuenta_Contable is null;
  // those accounts show regardless of company filter.
  const accountsFiltered = useMemo(() => {
    return statements.filter(s => {
      const catalogEntry = accountCatalogEntry(s);
      if (selectedCia !== 'all' && s.cia && s.cia !== selectedCia) return false;
      if (bancoFilter !== 'all' && (s.nombreBanco ?? s.banco) !== bancoFilter) return false;
      if (monedaFilter !== 'all' && s.moneda !== monedaFilter) return false;
      if (unidadFilter !== 'all' && (catalogEntry?.unidadNegocio ?? '__uncatalogued__') !== unidadFilter) return false;
      if (roleFilter !== 'all' && (catalogEntry?.role ?? '__uncatalogued__') !== roleFilter) return false;
      return true;
    });
  }, [statements, selectedCia, bancoFilter, monedaFilter, unidadFilter, roleFilter]);

  // Movement-level filter (search + tipo). Los traspasos internos NUNCA se
  // filtran fuera por sí mismos: aparecen siempre, en gris, restando de los
  // totales. Sólo se ocultan si el usuario activó un filtro CARGO/ABONO o
  // un término de búsqueda que no los matchee.
  const accountsView = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    return accountsFiltered.map(acc => {
      const catalogEntry = accountCatalogEntry(acc);
      const accountHay = [
        acc.banco,
        acc.nombreBanco,
        acc.cia,
        acc.cuenta,
        acc.cuentaBancos,
        acc.cuentaContable,
        acc.nombreCuentaContable,
        acc.desc039,
        acc.desc036,
        bankAccountSearchText(catalogEntry),
      ].filter(Boolean).join(' ').toLowerCase();
      const accountMatches = needle !== '' && accountHay.includes(needle);
      const movimientos = acc.movimientos.filter(m => {
        if (tipoFilter !== 'all' && m.tipoMovimiento !== tipoFilter) return false;
        if (accountMatches) return true;
        if (needle) {
          const hay = `${m.referencia} ${m.concepto} ${m.noRecibo ?? ''} ${m.cuentaBancos ?? ''} ${m.cuenta ?? ''}`.toLowerCase();
          if (!hay.includes(needle)) return false;
        }
        return true;
      });
      return { ...acc, movimientos };
    }).filter(acc => !needle || acc.movimientos.length > 0 || bankAccountSearchText(accountCatalogEntry(acc)).toLowerCase().includes(needle));
  }, [accountsFiltered, searchTerm, tipoFilter]);

  const balanceDate = useMemo(() => latestStatementDate(accountsView), [accountsView]);
  const balanceAccountsView = useMemo(
    () => currentBankStatements(accountsView, balanceDate),
    [accountsView, balanceDate],
  );

  const accountsByBank = useMemo(() => {
    type Acc = typeof accountsView[number];
    const m = new Map<string, Acc[]>();
    for (const acc of accountsView) {
      const k = acc.nombreBanco || acc.banco || 'Sin banco';
      const list = m.get(k);
      if (list) list.push(acc); else m.set(k, [acc]);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [accountsView]);

  useEffect(() => {
    const newOnes: string[] = [];
    for (const [bankName] of accountsByBank) {
      if (!seenBanksRef.current.has(bankName)) {
        seenBanksRef.current.add(bankName);
        newOnes.push(bankName);
      }
    }
    if (newOnes.length > 0) {
      setCollapsedBanks(prev => {
        const next = new Set(prev);
        for (const n of newOnes) next.add(n);
        return next;
      });
    }
  }, [accountsByBank]);

  const bancoOptions = useMemo(
    () => Array.from(new Set(statements.map(s => s.nombreBanco ?? s.banco).filter(Boolean))).sort(),
    [statements],
  );
  const monedaOptions = useMemo(
    () => Array.from(new Set(statements.map(s => s.moneda))).sort(),
    [statements],
  );
  const unidadOptions = useMemo(
    () => Array.from(new Set(
      statements.map(s => accountCatalogEntry(s)?.unidadNegocio ?? '__uncatalogued__'),
    )).sort((a, b) => bankAccountBusinessUnitLabel(a).localeCompare(bankAccountBusinessUnitLabel(b), 'es-MX')),
    [statements],
  );
  const roleOptions = useMemo(
    () => Array.from(new Set(
      statements.map(s => accountCatalogEntry(s)?.role ?? '__uncatalogued__'),
    )).sort((a, b) => bankAccountRoleLabel(a).localeCompare(bankAccountRoleLabel(b), 'es-MX')),
    [statements],
  );

  // ── KPIs ──
  // Calcula 4 totales: bruto (incluye internos) y real (sin internos).
  // Los internos se siguen mostrando en la tabla pero en gris y restados.
  const kpis = useMemo(() => {
    let totalCuentas = 0;
    let totalMovs = 0;
    let totalMovsInternal = 0;
    const saldoTotal = sumBankStatementBalances(balanceAccountsView);
    let cargosBruto = 0;
    let cargosReal = 0;
    let abonosBruto = 0;
    let abonosReal = 0;
    for (const a of accountsView) {
      totalCuentas += 1;
      totalMovs += a.movimientos.length;
      for (const m of a.movimientos) {
        const isInternal = internalReasonOf(a.cia, a.cuenta, m) !== null;
        if (isInternal) totalMovsInternal += 1;
        if (m.tipoMovimiento === 'CARGO') {
          cargosBruto += m.importe;
          if (!isInternal) cargosReal += m.importe;
        } else if (m.tipoMovimiento === 'ABONO') {
          abonosBruto += m.importe;
          if (!isInternal) abonosReal += m.importe;
        }
      }
    }
    return { totalCuentas, totalMovs, totalMovsInternal, saldoTotal, cargosBruto, cargosReal, abonosBruto, abonosReal };
  }, [accountsView, balanceAccountsView, internalReasonOf]);
  const { totalCuentas, totalMovs, totalMovsInternal, saldoTotal, cargosBruto, cargosReal, abonosBruto, abonosReal } = kpis;
  const totalCargos = cargosReal;
  const totalAbonos = abonosReal;
  const balanceCuentas = balanceAccountsView.length;
  const staleCuentas = Math.max(0, totalCuentas - balanceCuentas);

  const unitSummaries = useMemo(() => {
    const summaries = new Map<string, { label: string; accounts: number; movimientos: number; saldo: number; abonos: number; cargos: number }>();
    for (const acc of accountsView) {
      const entry = accountCatalogEntry(acc);
      const key = entry?.unidadNegocio ?? '__uncatalogued__';
      const current = summaries.get(key) ?? {
        label: entry ? bankAccountBusinessUnitLabel(entry.unidadNegocio) : 'Sin catálogo',
        accounts: 0,
        movimientos: 0,
        saldo: 0,
        abonos: 0,
        cargos: 0,
      };
      current.accounts += 1;
      current.movimientos += acc.movimientos.length;
      current.saldo += bankStatementBalance(acc);
      for (const m of acc.movimientos) {
        if (internalReasonOf(acc.cia, acc.cuenta, m) !== null) continue;
        if (m.tipoMovimiento === 'ABONO') current.abonos += m.importe;
        if (m.tipoMovimiento === 'CARGO') current.cargos += m.importe;
      }
      summaries.set(key, current);
    }
    return Array.from(summaries.entries())
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => b.saldo - a.saldo || a.label.localeCompare(b.label, 'es-MX'));
  }, [accountsView, internalReasonOf]);

  const hasFilters = bancoFilter !== 'all' || monedaFilter !== 'all' || tipoFilter !== 'all' || unidadFilter !== 'all' || roleFilter !== 'all' || searchTerm !== '';
  const clearFilters = () => {
    setBancoFilter('all');
    setMonedaFilter('all');
    setTipoFilter('all');
    setUnidadFilter('all');
    setRoleFilter('all');
    setSearchTerm('');
  };

  const exportCsv = () => {
    const header = ['cia','empresa','banco','cuenta','moneda','unidadNegocio','rolCuenta','flujoCuenta','razonSocialCuenta','conceptoCuenta','fechaOperacion','fechaValor','referencia','concepto','tipoMovimiento','importe','saldo'];
    const rows: string[] = [header.join(',')];
    accountsView.forEach(acc => {
      const empresaNombre = ciaNameMap.get(acc.cia) ?? '';
      const catalogEntry = accountCatalogEntry(acc);
      acc.movimientos.forEach(m => {
        rows.push([
          acc.cia, empresaNombre, acc.banco, acc.cuenta, acc.moneda,
          catalogEntry ? bankAccountBusinessUnitLabel(catalogEntry.unidadNegocio) : '',
          catalogEntry ? bankAccountRoleLabel(catalogEntry.role) : '',
          catalogEntry ? bankAccountFlowLabel(catalogEntry.flow) : '',
          catalogEntry?.razonSocial ?? '',
          catalogEntry?.concepto ?? '',
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
      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex h-9 min-w-[280px] flex-1 items-center gap-2 rounded-[var(--radius)] border border-[var(--gray-200)] bg-white px-3 shadow-sm">
          <Search className="w-3.5 h-3.5 text-[var(--gray-400)]" />
          <input
            type="text"
            placeholder="Buscar cuenta, CLABE, razón social, unidad, referencia..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--gray-300)]"
          />
          {searchTerm && <button onClick={() => setSearchTerm('')}><X className="w-3.5 h-3.5 text-[var(--gray-400)]" /></button>}
        </div>

        <select value={bancoFilter} onChange={e => setBancoFilter(e.target.value)}
          className="h-9 rounded-[var(--radius)] border border-[var(--gray-200)] bg-white px-3 text-[12px] text-[var(--gray-950)] shadow-sm cursor-pointer">
          <option value="all">Todos los bancos</option>
          {bancoOptions.map(b => <option key={b} value={b}>{b}</option>)}
        </select>

        <select value={unidadFilter} onChange={e => setUnidadFilter(e.target.value)}
          className="h-9 rounded-[var(--radius)] border border-[var(--gray-200)] bg-white px-3 text-[12px] text-[var(--gray-950)] shadow-sm cursor-pointer"
          title="Unidad de negocio">
          <option value="all">Todas las unidades</option>
          {unidadOptions.map(u => (
            <option key={u} value={u}>{u === '__uncatalogued__' ? 'Sin catálogo' : bankAccountBusinessUnitLabel(u)}</option>
          ))}
        </select>

        <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)}
          className="h-9 rounded-[var(--radius)] border border-[var(--gray-200)] bg-white px-3 text-[12px] text-[var(--gray-950)] shadow-sm cursor-pointer"
          title="Rol de cuenta">
          <option value="all">Todos los roles</option>
          {roleOptions.map(r => (
            <option key={r} value={r}>{r === '__uncatalogued__' ? 'Sin catálogo' : bankAccountRoleLabel(r)}</option>
          ))}
        </select>

        <select value={monedaFilter} onChange={e => setMonedaFilter(e.target.value)}
          className="h-9 rounded-[var(--radius)] border border-[var(--gray-200)] bg-white px-3 text-[12px] text-[var(--gray-950)] shadow-sm cursor-pointer">
          <option value="all">Todas las monedas</option>
          {monedaOptions.map(m => <option key={m} value={m}>{m}</option>)}
        </select>

        <select value={tipoFilter} onChange={e => setTipoFilter(e.target.value as TipoFilter)}
          className="h-9 rounded-[var(--radius)] border border-[var(--gray-200)] bg-white px-3 text-[12px] text-[var(--gray-950)] shadow-sm cursor-pointer">
          <option value="all">Cargos y abonos</option>
          <option value="ABONO">Solo abonos</option>
          <option value="CARGO">Solo cargos</option>
        </select>

        {hasFilters && (
          <button onClick={clearFilters} className="h-9 rounded-[var(--radius)] px-2 text-[12px] text-[var(--gray-500)] hover:bg-[var(--gray-100)] hover:text-[var(--primary)] flex items-center gap-1 transition">
            <Filter className="w-3 h-3" /> Limpiar filtros
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          <input
            ref={santanderInputRef}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.currentTarget.value = '';
              if (!file) return;
              await onUploadFile(file);
            }}
          />
          <button
            type="button"
            onClick={() => santanderInputRef.current?.click()}
            disabled={uploadingFile}
            className="h-8 rounded-full border border-[var(--gray-200)] bg-white px-3 text-[12px] font-medium text-[var(--gray-700)] hover:border-[var(--primary)] hover:text-[var(--primary)] flex items-center gap-1 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {uploadingFile ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />} Subir archivo
          </button>
          <button
            onClick={exportCsv}
            disabled={totalMovs === 0 || uploadingFile}
            className="text-[12px] text-[var(--gray-400)] hover:text-[var(--primary)] flex items-center gap-1 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Download className="w-3 h-3" /> Exportar CSV
          </button>
          <button
            onClick={onRefresh}
            disabled={refreshing || uploadingFile || !canRefresh}
            title={canRefresh ? 'Actualizar desde JDE' : refreshBlockedReason}
            className="text-[12px] text-[var(--gray-400)] hover:text-[var(--primary)] flex items-center gap-1 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {refreshing
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : canRefresh ? <RotateCcw className="w-3 h-3" /> : <Upload className="w-3 h-3" />} {canRefresh ? 'Actualizar' : 'Archivo cargado'}
          </button>
          <button onClick={onReset} disabled={uploadingFile} className="text-[12px] text-[var(--gray-400)] hover:text-[var(--danger)] flex items-center gap-1 transition disabled:opacity-40 disabled:cursor-not-allowed">
            <X className="w-3 h-3" /> Nueva consulta
          </button>
        </div>
      </div>

      {/* ── cia filter banner ── */}
      {selectedCia !== 'all' && (
        <div className="bg-[var(--primary-muted)] border border-[var(--primary)]/20 rounded-[var(--radius)] px-4 py-2.5 flex items-center gap-2 text-[13px] text-[var(--primary)] font-medium">
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
        <div className="bg-[var(--danger-muted)] border border-red-100 rounded-[var(--radius)] px-4 py-2.5 flex items-center gap-2 text-[13px] text-[var(--danger)] font-medium">
          <AlertCircle className="w-3.5 h-3.5" /> {refreshError}
        </div>
      )}

      {query.hasUploadedSantander && (
        <div className="bg-[var(--primary-muted)] border border-[var(--primary)]/20 rounded-[var(--radius)] px-4 py-2.5 flex items-center gap-2 text-[13px] text-[var(--primary)] font-medium">
          <Upload className="w-3.5 h-3.5" />
          {canRefresh
            ? 'Archivo Santander agregado al dataset actual.'
            : 'Archivo Santander cargado. Para actualizar los movimientos, sube un archivo nuevo o corre una consulta JDE.'}
        </div>
      )}

      {unitSummaries.length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {unitSummaries.map(unit => (
            <button
              key={unit.key}
              type="button"
              onClick={() => setUnidadFilter(unit.key)}
              className={`rounded-[var(--radius-lg)] border p-3 text-left transition ${
                unidadFilter === unit.key
                  ? 'border-[var(--primary)] bg-[var(--primary-muted)]'
                  : 'border-[var(--gray-200)] bg-white hover:border-[var(--gray-300)] hover:bg-[var(--gray-50)]'
              }`}
              title={`Filtrar por ${unit.label}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Building2 className="h-3.5 w-3.5 shrink-0 text-[var(--primary)]" />
                  <p className="truncate text-[12px] font-bold text-[var(--gray-950)]">{unit.label}</p>
                </div>
                <span className="shrink-0 text-[10px] font-medium text-[var(--gray-400)]">
                  {unit.accounts} cuenta{unit.accounts === 1 ? '' : 's'}
                </span>
              </div>
              <div className="mt-2 flex items-end justify-between gap-3">
                <div>
                  <p className="font-mono text-[14px] font-bold text-[var(--gray-950)]">{fmtCurrency(unit.saldo)}</p>
                  <p className="text-[10px] text-[var(--gray-400)]">{unit.movimientos.toLocaleString()} mov.</p>
                </div>
                <div className="text-right text-[10px] tabular-nums">
                  <p className="text-[var(--success)]">+{fmtCurrency(unit.abonos)}</p>
                  <p className="text-[var(--danger)]">-{fmtCurrency(unit.cargos)}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* ── KPI cards (hidden) ── */}
      {false && (
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          {
            label: 'Saldo Total',
            value: fmtCurrency(saldoTotal),
            sub: `${balanceCuentas} cuenta${balanceCuentas !== 1 ? 's' : ''} al corte${staleCuentas > 0 ? ` · ${staleCuentas} históricas fuera` : ''}`,
            icon: Wallet,
            color: hex.primary,
          },
          {
            label: 'Abonos',
            value: fmtCurrency(totalAbonos),
            sub: abonosBruto !== abonosReal
              ? `Bruto ${fmtCurrency(abonosBruto)} − internos ${fmtCurrency(abonosBruto - abonosReal)}`
              : 'Entradas',
            icon: ArrowDownCircle,
            color: hex.success,
          },
          {
            label: 'Cargos',
            value: fmtCurrency(totalCargos),
            sub: cargosBruto !== cargosReal
              ? `Bruto ${fmtCurrency(cargosBruto)} − internos ${fmtCurrency(cargosBruto - cargosReal)}`
              : 'Salidas',
            icon: ArrowUpCircle,
            color: hex.danger,
          },
          {
            label: 'Movimientos',
            value: totalMovs.toLocaleString(),
            sub: totalMovsInternal > 0
              ? `${totalMovsInternal.toLocaleString()} interno${totalMovsInternal === 1 ? '' : 's'} (excluido${totalMovsInternal === 1 ? '' : 's'})`
              : `Al ${query.fechaEstadoCuenta}`,
            icon: Receipt,
            color: 'var(--chart-4)',
          },
        ].map((kpi, i) => {
          const Icon = kpi.icon;
          return (
            <div
              key={i}
              className="rounded-[var(--radius-lg)] border border-[var(--skeuo-paper-edge)] p-4 skeuo-brackets"
              style={{
                background: 'var(--skeuo-paper)',
                boxShadow: 'var(--skeuo-emboss-md)',
              }}
            >
              <div className="flex items-center justify-between mb-2">
                <p className="text-[11px] font-medium text-[var(--gray-400)] uppercase tracking-[0.08em]">{kpi.label}</p>
                <div className="w-7 h-7 rounded-[var(--radius-md)] flex items-center justify-center" style={{ backgroundColor: kpi.color + '14' }}>
                  <Icon className="w-3.5 h-3.5" style={{ color: kpi.color }} />
                </div>
              </div>
              <p className="text-[22px] font-bold font-mono tracking-tight text-[var(--gray-950)]">{kpi.value}</p>
              <p className="text-[11px] text-[var(--gray-400)] mt-0.5 truncate" title={kpi.sub}>{kpi.sub}</p>
            </div>
          );
        })}
      </div>
      )}

      {/* ── Query chip (hidden) ── */}
      {false && (
      <div className="inline-flex items-center gap-2 text-[12px] text-[var(--gray-500)] bg-white border border-[var(--gray-200)] rounded-full px-3 py-1 shadow-sm w-fit">
        <Calendar className="w-3.5 h-3.5" />
        <span>Estado al <span className="text-[var(--gray-950)] font-medium">{query.fechaEstadoCuenta}</span></span>
        <span className="text-[var(--gray-300)]">·</span>
        <span>Formato <span className="text-[var(--gray-950)] font-medium">{formatSourceLabel(query.formatoElectronico, query.hasUploadedSantander)}</span></span>
      </div>
      )}

      {/* ── Accounts list ── */}
      <div
        className="rounded-[var(--radius-lg)] border border-[var(--skeuo-paper-edge)] overflow-hidden"
        style={{
          background: 'var(--skeuo-paper)',
          boxShadow: 'var(--skeuo-emboss-md)',
        }}
      >
        <div className="p-4 border-b border-[var(--gray-100)]">
          <h2 className="text-[15px] font-bold text-[var(--gray-950)]">
            Cuentas <span className="text-[var(--gray-400)] font-normal ml-1">({accountsView.length.toLocaleString()})</span>
          </h2>
        </div>

        {accountsView.length === 0 ? (
          <div className="p-10 text-center text-[13px] text-[var(--gray-400)]">
            No hay cuentas con los filtros actuales.
          </div>
        ) : (
          <div>
            {accountsByBank.map(([bankName, accs], bankIdx) => {
              const bankCollapsed = collapsedBanks.has(bankName);
              const currentAccs = currentBankStatements(accs, balanceDate);
              // Saldos por moneda (un banco puede tener cuentas MXN + USD).
              // Antes ocultábamos el total si había mezcla; ahora mostramos
              // un total por cada moneda para no perder la cifra.
              const totalsByMoneda = (() => {
                const m = new Map<string, number>();
                for (const a of accs) {
                  m.set(a.moneda, (m.get(a.moneda) ?? 0) + bankStatementBalance(a));
                }
                return Array.from(m.entries()).sort((x, y) => x[0].localeCompare(y[0]));
              })();
              const staleBankAccounts = Math.max(0, accs.length - currentAccs.length);
              return (
                <div key={bankName} className={bankIdx > 0 ? 'border-t border-[var(--gray-100)]' : ''}>
                  <button
                    onClick={() => {
                      setCollapsedBanks(prev => {
                        const next = new Set(prev);
                        if (next.has(bankName)) next.delete(bankName); else next.add(bankName);
                        return next;
                      });
                    }}
                    className="w-full flex items-center gap-3 px-4 py-3 bg-[var(--surface-alt)] hover:bg-[var(--gray-50)] transition text-left"
                  >
                    {bankCollapsed
                      ? <ChevronRight className="w-4 h-4 text-[var(--gray-400)]" />
                      : <ChevronDown className="w-4 h-4 text-[var(--gray-400)]" />}
                    <Landmark className="w-4 h-4 text-[var(--primary)] flex-shrink-0" />
                    <p className="text-[13px] font-bold text-[var(--gray-950)] truncate">
                      {bankName}
                      <span className="text-[var(--gray-400)] font-normal ml-2">({accs.length} cuenta{accs.length !== 1 ? 's' : ''})</span>
                    </p>
                    <div className="ml-auto text-right">
                      {totalsByMoneda.map(([moneda, total]) => (
                        <p key={moneda} className="text-[13px] font-mono font-bold text-[var(--gray-950)]">
                          {fmtCurrency(total, moneda)}
                          {totalsByMoneda.length > 1 && (
                            <span className="ml-1 text-[10px] font-normal text-[var(--gray-400)]">{moneda}</span>
                          )}
                        </p>
                      ))}
                      <p className="text-[10px] text-[var(--gray-400)]">
                        {accs.reduce((s, a) => s + a.movimientos.length, 0).toLocaleString()} mov.
                        {staleBankAccounts > 0 ? ` · ${staleBankAccounts} históricas fuera` : ''}
                      </p>
                    </div>
                  </button>

                  {!bankCollapsed && (
                    <div className="divide-y divide-[var(--gray-50)]">
                      {accs.map(acc => {
                        const key = `${acc.cia}::${acc.cuenta}::${acc.moneda}`;
                        const isExpanded = expanded === key;
                        const catalogEntry = accountCatalogEntry(acc);
                        const saldo = bankStatementBalance(acc);
                        const saldoIsDerived =
                          (acc.saldoFinal === undefined || acc.saldoFinal === 0)
                          && acc.saldoInicial !== undefined
                          && acc.movimientos.length > 0;
                        return (
                          <div key={key}>
                            <button
                              onClick={() => setExpanded(isExpanded ? null : key)}
                              className="w-full flex items-center gap-3 px-4 py-3 pl-10 hover:bg-[var(--surface-alt)] transition text-left"
                            >
                              {isExpanded
                                ? <ChevronDown className="w-4 h-4 text-[var(--gray-400)]" />
                                : <ChevronRight className="w-4 h-4 text-[var(--gray-400)]" />}

                              <div className="flex-1 min-w-0">
                                <p className="text-[13px] font-medium text-[var(--gray-950)] truncate">
                                  {acc.cuenta || 'Cuenta bancaria'}
                                  {acc.desc039 && (
                                    <span className="ml-2 text-[11px] font-normal text-[var(--gray-500)]">· {acc.desc039}</span>
                                  )}
                                </p>
                                <div className="flex items-center gap-2 mt-0.5">
                                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-[var(--gray-50)] text-[var(--gray-500)]">{acc.moneda}</span>
                                  {acc.cia && (
                                    <span className="text-[11px] text-[var(--gray-400)]">
                                      {ciaNameMap.get(acc.cia) ?? `Cia ${acc.cia}`}
                                    </span>
                                  )}
                                  <span className="text-[11px] text-[var(--gray-400)]">{acc.cia ? '· ' : ''}{acc.movimientos.length} mov.</span>
                                </div>
                                <div className="mt-1.5">
                                  <BankAccountBadges entry={catalogEntry} />
                                </div>
                              </div>

                              <div className="text-right w-36">
                                <p className="text-[13px] font-mono font-bold text-[var(--gray-950)]">{fmtCurrency(saldo, acc.moneda)}</p>
                                <p
                                  className="text-[10px] text-[var(--gray-400)]"
                                  title={saldoIsDerived ? 'Saldo final reportado fue 0/nulo; estimado desde saldoInicial + movimientos del periodo.' : undefined}
                                >
                                  {saldoIsDerived
                                    ? 'Estimado'
                                    : acc.saldoFinal !== undefined
                                      ? 'Saldo final'
                                      : acc.saldoInicial !== undefined
                                        ? 'Saldo inicial'
                                        : 'Sin saldo'}
                                </p>
                              </div>
                            </button>

                            {isExpanded && (
                              <BancosMovimientos
                                acc={acc}
                                internalReasonOf={internalReasonOf}
                                abonoEnrichmentIndex={abonoEnrichmentIndex}
                                cargoEnrichmentIndex={cargoEnrichmentIndex}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
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

const BancosMovimientos = ({
  acc,
  internalReasonOf,
  abonoEnrichmentIndex,
  cargoEnrichmentIndex,
}: {
  acc: BankAccountStatement & { movimientos: BankStatementLine[] };
  internalReasonOf: (cia: string, cuenta: string, mov: BankStatementLine) => InternalReason | null;
  abonoEnrichmentIndex?: Map<string, AbonoEnrichment>;
  cargoEnrichmentIndex?: Map<string, import('../domain/paymentReconciliationEngine').CargoPaymentEnrichment>;
}) => {
  if (acc.movimientos.length === 0) {
    return (
      <div className="bg-[var(--surface-alt)] px-4 py-6 text-center text-[12px] text-[var(--gray-400)]">
        Sin movimientos con los filtros actuales.
      </div>
    );
  }

  // Pre-clasifica para no llamar internalReasonOf dos veces por fila.
  const classified = acc.movimientos.map(m => ({
    m,
    internalReason: internalReasonOf(acc.cia, acc.cuenta, m),
  }));

  let abonosBruto = 0, abonosReal = 0, cargosBruto = 0, cargosReal = 0, internalCount = 0;
  for (const { m, internalReason } of classified) {
    const isInternal = internalReason !== null;
    if (isInternal) internalCount += 1;
    if (m.tipoMovimiento === 'CARGO') {
      cargosBruto += m.importe;
      if (!isInternal) cargosReal += m.importe;
    } else if (m.tipoMovimiento === 'ABONO') {
      abonosBruto += m.importe;
      if (!isInternal) abonosReal += m.importe;
    }
  }

  return (
    <div className="bg-[var(--surface-alt)] px-4 pb-3">
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-[var(--gray-100)]">
              <th className="text-left py-2 text-[var(--gray-400)] font-bold">Fecha</th>
              <th className="text-left py-2 text-[var(--gray-400)] font-bold">Referencia</th>
              <th className="text-left py-2 text-[var(--gray-400)] font-bold">Concepto</th>
              <th className="text-center py-2 text-[var(--gray-400)] font-bold">Tipo</th>
              <th className="text-right py-2 text-[var(--gray-400)] font-bold">Importe</th>
              <th className="text-right py-2 text-[var(--gray-400)] font-bold">Saldo</th>
            </tr>
          </thead>
          <tbody>
            {classified.map(({ m, internalReason }, i) => {
              const isCargo = m.tipoMovimiento === 'CARGO';
              const isInternal = internalReason !== null;
              const tooltip = isInternal ? INTERNAL_REASON_LABELS[internalReason] : m.concepto;
              const rowMuted = isInternal ? 'opacity-50' : '';
              const tipoColor = isInternal
                ? 'bg-[var(--gray-100)] text-[var(--gray-400)]'
                : isCargo ? 'bg-[var(--danger-muted)] text-[var(--danger)]' : 'bg-[var(--success-muted)] text-[var(--success)]';
              const importColor = isInternal
                ? 'text-[var(--gray-400)] line-through'
                : isCargo ? 'text-[var(--danger)]' : 'text-[var(--success)]';

              // ── Cobranza enrichment (ABONOs) ──
              // Solo aplica a ABONOs que NO sean traspaso interno.
              const enrichment = !isInternal && m.tipoMovimiento === 'ABONO' && abonoEnrichmentIndex
                ? abonoEnrichmentIndex.get(bankMovementKey(m))
                : undefined;
              // ── PagoProveedor enrichment (CARGOs) ──
              // Espejo egreso: revela qué pago a proveedor originó este CARGO.
              const cargoEnrichment = !isInternal && m.tipoMovimiento === 'CARGO' && cargoEnrichmentIndex
                ? cargoEnrichmentIndex.get(bankMovementKey(m))
                : undefined;
              return (
                <tr key={i} className={`border-b border-[var(--gray-50)] ${rowMuted}`} title={isInternal ? tooltip : undefined}>
                  <td className="py-1.5 text-[var(--gray-500)] whitespace-nowrap">{m.fechaOperacion}</td>
                  <td className="py-1.5 font-mono text-[var(--gray-950)]">{m.referencia || '—'}</td>
                  <td className="py-1.5 text-[var(--gray-500)] max-w-[320px] truncate" title={tooltip}>
                    {m.concepto || '—'}
                    {m.noRecibo && (
                      <span
                        className="ml-1.5 text-[9px] uppercase tracking-[0.08em] px-1 py-0.5 rounded bg-[var(--gray-100)] text-[var(--gray-600)] font-bold align-middle"
                        title={`No Recibo banco ${m.noRecibo}`}
                      >
                        Recibo {m.noRecibo}
                      </span>
                    )}
                    {isInternal && (
                      <span className="ml-1.5 text-[9px] uppercase tracking-[0.08em] px-1 py-0.5 rounded bg-[var(--gray-200)] text-[var(--gray-500)] font-bold align-middle">
                        Interno
                      </span>
                    )}
                    {enrichment?.status === 'factura-cobrada' && enrichment.facturas && enrichment.facturas.length > 0 && (
                      <span
                        className="ml-1.5 text-[9px] uppercase tracking-[0.08em] px-1 py-0.5 rounded bg-[var(--success-muted)] text-[var(--success)] font-bold align-middle"
                        title={enrichment.facturas
                          .map(f => `${f.cia} · ${f.noFactura} · ${f.nombreCliente}`)
                          .join('\n')}
                      >
                        ✓ Factura{enrichment.facturas.length > 1 ? `s ×${enrichment.facturas.length}` : ` ${enrichment.facturas[0].noFactura}`}
                      </span>
                    )}
                    {enrichment?.status === 'cobranza-sin-factura' && (
                      <span
                        className="ml-1.5 text-[9px] uppercase tracking-[0.08em] px-1 py-0.5 rounded bg-[var(--warning-muted,_#fef3c7)] text-[var(--warning)] font-bold align-middle"
                        title="ABONO no cruzó con ninguna factura JDE — probable anticipo o factura fuera del rango cargado."
                      >
                        Sin factura
                      </span>
                    )}
                    {cargoEnrichment?.status === 'MATCHED' && cargoEnrichment.payments && cargoEnrichment.payments.length > 0 && (
                      <span
                        className="ml-1.5 text-[9px] uppercase tracking-[0.08em] px-1 py-0.5 rounded bg-[var(--info-muted)] text-[var(--info)] font-bold align-middle"
                        title={cargoEnrichment.payments
                          .map(p => `${p.noPago} · ${p.nombreProveedor} · ${p.tier}`)
                          .join('\n')}
                      >
                        ✓ Pago{cargoEnrichment.payments.length > 1 ? `s ×${cargoEnrichment.payments.length}` : ` ${cargoEnrichment.payments[0].nombreProveedor.split(' ').slice(0, 2).join(' ')}`}
                      </span>
                    )}
                    {cargoEnrichment?.status === 'ORPHAN' && (
                      <span
                        className="ml-1.5 text-[9px] uppercase tracking-[0.08em] px-1 py-0.5 rounded bg-[var(--warning-muted,_#fef3c7)] text-[var(--warning)] font-bold align-middle"
                        title="CARGO sin pago a proveedor asociado — probable comisión, traspaso o pago fuera del rango cargado."
                      >
                        Sin pago
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 text-center">
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${tipoColor}`}>
                      {m.tipoMovimiento}
                    </span>
                  </td>
                  <td className={`py-1.5 text-right font-mono font-medium ${importColor}`}>
                    {isCargo ? '-' : '+'}{fmtCurrency(m.importe, acc.moneda)}
                  </td>
                  <td className="py-1.5 text-right font-mono text-[var(--gray-950)]">
                    {m.saldo !== undefined ? fmtCurrency(m.saldo, acc.moneda) : '—'}
                  </td>
                </tr>
              );
            })}
            <tr className="border-t-2 border-[var(--gray-200)] bg-[var(--gray-50)] font-bold">
              <td className="py-2" colSpan={3}>
                Totales visibles
                {internalCount > 0 && (
                  <span className="text-[10px] font-normal text-[var(--gray-400)] ml-2">
                    ({internalCount} interno{internalCount === 1 ? '' : 's'} excluido{internalCount === 1 ? '' : 's'})
                  </span>
                )}
              </td>
              <td className="py-2 text-center text-[var(--gray-400)] text-[10px]">—</td>
              <td className="py-2 text-right font-mono">
                <span className="text-[var(--success)]">+{fmtCurrency(abonosReal, acc.moneda)}</span>
                <span className="text-[var(--gray-300)] mx-1">/</span>
                <span className="text-[var(--danger)]">-{fmtCurrency(cargosReal, acc.moneda)}</span>
                {(abonosBruto !== abonosReal || cargosBruto !== cargosReal) && (
                  <span className="block text-[10px] text-[var(--gray-400)] font-normal mt-0.5">
                    Bruto: +{fmtCurrency(abonosBruto, acc.moneda)} / -{fmtCurrency(cargosBruto, acc.moneda)}
                  </span>
                )}
              </td>
              <td className="py-2 text-right font-mono text-[var(--gray-950)]">
                {fmtCurrency(bankStatementBalance(acc), acc.moneda)}
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
  supplementalStatements,
  onJdeStatementsChange,
  onSupplementalStatementsChange,
  lastQuery,
  onLastQueryChange,
  companies = [],
  abonoEnrichmentIndex,
  cargoEnrichmentIndex,
}: BancosProps) => {
  const [view, setView] = useState<BancosView>(
    statements.length > 0 && lastQuery ? 'dashboard' : 'form'
  );
  const [refreshing, setRefreshing] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const handleLoadedJde = useCallback(
    (result: BankAccountStatement[], q: BankQueryState) => {
      onJdeStatementsChange(result);
      onLastQueryChange({ ...q, hasUploadedSantander: supplementalStatements.length > 0 });
      setView('dashboard');
    },
    [onJdeStatementsChange, onLastQueryChange, supplementalStatements.length],
  );
  const handleLoadedFile = useCallback(
    (result: BankAccountStatement[], q: BankQueryState) => {
      const mergedSupplemental = mergeBankStatements(supplementalStatements, attachImportedStatementsToKnownCompanies(result, statements));
      onSupplementalStatementsChange(mergedSupplemental);
      if (lastQuery && lastQuery.formatoElectronico !== SANTANDER_FILE_FORMAT) {
        onLastQueryChange({ ...lastQuery, hasUploadedSantander: true });
      } else {
        onLastQueryChange(q);
      }
      setView('dashboard');
    },
    [lastQuery, onLastQueryChange, onSupplementalStatementsChange, statements, supplementalStatements],
  );

  // ── Switch to dashboard when data arrives from App-level fetch ──
  useEffect(() => {
    if (statements.length > 0 && lastQuery && view === 'form') {
      setView('dashboard');
    }
  }, [statements.length, lastQuery, view]);

  const handleReset = useCallback(() => {
    onJdeStatementsChange([]);
    onSupplementalStatementsChange([]);
    onLastQueryChange(null);
    setRefreshError(null);
    setView('form');
  }, [onJdeStatementsChange, onLastQueryChange, onSupplementalStatementsChange]);

  const handleUploadFile = useCallback(async (file: File) => {
    setUploadingFile(true);
    setRefreshError(null);
    try {
      const { statements: result, latestDate } = await readSantanderFile(file, selectedCia, statements);
      const mergedSupplemental = mergeBankStatements(supplementalStatements, result);
      onSupplementalStatementsChange(mergedSupplemental);
      if (lastQuery && lastQuery.formatoElectronico !== SANTANDER_FILE_FORMAT) {
        onLastQueryChange({ ...lastQuery, hasUploadedSantander: true });
      } else {
        onLastQueryChange({ fechaEstadoCuenta: latestDate, formatoElectronico: SANTANDER_FILE_FORMAT, hasUploadedSantander: true });
      }
      setView('dashboard');
    } catch (e) {
      setRefreshError(e instanceof Error ? e.message : 'Error al leer el archivo Santander');
    } finally {
      setUploadingFile(false);
    }
  }, [lastQuery, onLastQueryChange, onSupplementalStatementsChange, selectedCia, statements, supplementalStatements]);

  const handleRefresh = useCallback(async () => {
    if (lastQuery?.formatoElectronico === SANTANDER_FILE_FORMAT) {
      setRefreshError('Este dataset viene solo de archivo Santander. Corre una consulta JDE para sumar más cuentas.');
      return;
    }
    // Always refresh with today's date to get the latest data
    const queryToUse = {
      fechaEstadoCuenta: todayISO(),
      formatoElectronico: lastQuery?.formatoElectronico ?? 'SWIFT' as BankStatementFormat,
    };
    setRefreshing(true); setRefreshError(null);
    try {
      const res = await fetchBankStatements(queryToUse);
      onJdeStatementsChange(res);
      onLastQueryChange({ ...queryToUse, hasUploadedSantander: supplementalStatements.length > 0 });
    } catch (e) {
      if (e instanceof JdeApiError) {
        setRefreshError(`JDE ${e.status}: ${e.message}`);
      } else {
        setRefreshError(e instanceof Error ? e.message : 'Error al actualizar');
      }
    } finally {
      setRefreshing(false);
    }
  }, [lastQuery, onJdeStatementsChange, onLastQueryChange, supplementalStatements.length]);

  if (view === 'form' || !lastQuery) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center p-6">
        <BancosForm
          initial={lastQuery}
          selectedCia={selectedCia}
          onLoadedJde={handleLoadedJde}
          onLoadedFile={handleLoadedFile}
        />
      </div>
    );
  }

  return (
    <BancosDashboard
      statements={statements}
      query={lastQuery}
      selectedCia={selectedCia}
      onReset={handleReset}
      onUploadFile={handleUploadFile}
      onRefresh={handleRefresh}
      canRefresh={lastQuery.formatoElectronico !== SANTANDER_FILE_FORMAT}
      refreshing={refreshing}
      uploadingFile={uploadingFile}
      refreshError={refreshError}
      companies={companies}
      abonoEnrichmentIndex={abonoEnrichmentIndex}
      cargoEnrichmentIndex={cargoEnrichmentIndex}
    />
  );
};

export default Bancos;
