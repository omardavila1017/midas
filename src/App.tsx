import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react';
import { TabId, CashFlowOverrides } from './types';
import { Provider, Client, CashFlowAssumptions, ConfirmedPayment } from './domain/types';
import { MidasStore, loadStore, saveStore, saveLightStore, CXPRecord } from './domain/persistence';
import { saveHeavyRecords, type HeavyKey } from './services/heavyStoreIDB';
import { recomputeClientCreditDaysFromCobranza } from './domain/collectionCalendarEngine';
import { comprasToPurchaseReceipts } from './domain/comprasToPurchaseReceipts';
import { buildProviderSpendIndex, enrichProvidersWithRecentSpend } from './domain/providerRecentSpend';
import {
  forecastFutureCompras,
  DEFAULT_FORECAST_MODEL,
  type ForecastModelId,
} from './domain/comprasForecastModels';
import { clearAuth } from './components/Login';
import { fetchClientCatalog, fetchProviderCatalog } from './services/catalog.service';
import { primeDailyCache, getMaxCachedDay, nextIsoDay } from './services/dailyApiCache';
import {
  loadBankStatementsFromIDB,
  saveBankJdeStatementsToIDB,
  saveBankSupplementalStatementsToIDB,
} from './services/heavyStoreIDB';
import {
  fetchCompanies,
  fetchBankStatements,
  fetchBankStatementsRange,
  fetchAgedBalances,
  fetchCobranzaRange,
  fetchIndicadoresCobranzaRange,
  fetchComprasRange,
  fetchPagoProveedorRange,
  fetchNomina,
  type Company,
  type BankAccountStatement,
  type BankStatementFormat,
  type CobranzaPayment,
  type CobranzaRecord,
  type ComprasRecord,
  type PagoProveedorRecord,
} from './services/jde';

const FIXED_STARTING_BALANCE = 76_300_000;
// Lazy-loaded so the projection module's Recharts + canonical engine is
// not in the initial App bundle. This is the single largest chunk in the
// build — keeping it out of first paint cuts the dashboard's first
// interaction-time noticeably on cold loads.
const Providers = lazy(() => import('./components/Providers'));
const Clients = lazy(() => import('./components/Clients'));
const Dashboard = lazy(() => import('./components/Dashboard'));
const CashFlowDetail = lazy(() => import('./components/CashFlowDetail'));
const CXP = lazy(() => import('./components/CXP'));
const Compras = lazy(() => import('./components/Compras'));
const Pagos = lazy(() => import('./components/Pagos'));
const Bancos = lazy(() => import('./components/Bancos'));
const CollectionProjection = lazy(() => import('./components/CollectionProjection'));
const FideicomisoDashboard = lazy(() => import('./components/FideicomisoDashboard'));
const FinancialProjectionDashboard = lazy(() => import('./modules/financial-projection/pages/FinancialProjectionDashboard'));
const FinancialPlanningDashboard = lazy(() => import('./modules/financial-planning/pages/FinancialPlanningDashboard'));
const TaxDashboard = lazy(() => import('./modules/taxes/pages/TaxDashboard'));
const PayrollDashboard = lazy(() => import('./modules/payroll/pages/PayrollDashboard'));
import ErrorBoundary from './components/ErrorBoundary';
import MidasSplash, { type BootTask, type BootTaskStatus } from './components/MidasSplash';
import DarkModeToggle from './components/ui/DarkModeToggle';
import { ActivityFeedPanel } from './components/ActivityFeed';
import { useCommandPalette } from './components/CommandPalette';
import CommandPalette, { type CommandPaletteAction } from './components/CommandPalette';
import { loadPlanningScenarios, loadPlanningAdjustments } from './modules/financial-planning/services/financialPlanningStorage';
import { buildFinancialProjectionSourceData } from './modules/financial-projection/services/financialProjectionService';
import { NavigationProvider, type AppTabId, type NavTarget } from './modules/shared-finance/components/NavigationContext';
import DashboardLoadingShell from './modules/shared-finance/components/DashboardLoadingShell';
import type { PayrollCostRecord } from './modules/shared-finance/types';
import { isCacheFresh, mergeNominaBatch, nominaCacheKey } from './modules/payroll/services/payrollModuleService';
import { KeyboardShortcutsModal, useKeyboardShortcuts } from './components/KeyboardShortcuts';
import {
  LayoutDashboard,
  Users, UserSquare,
  Building2, Loader2, ChevronDown, AlertCircle, Landmark, Check,
  HandCoins, ChevronRight, BookUser, Activity, TrendingUp,
  Receipt, Wallet, FolderPlus, Pencil, Trash2, X, FolderOpen,
  LogOut, ClipboardList, BarChart3, ShieldCheck, CreditCard,
  type LucideIcon,
} from 'lucide-react';
import { CompanyGroup, loadCompanyGroups, saveCompanyGroups, newGroupId, GROUP_COLORS, resolveActiveCias } from './domain/companyGroups';
import {
  attachImportedStatementsToKnownCompanies,
  excludeBajio,
  mergeBankStatements,
  type BankQueryState,
} from './domain/bankStatements';
import { SANTANDER_FILE_FORMAT } from './domain/santanderCsv';
import {
  type AbonoEnrichment,
  type RealReconciliationMatch,
  type RealReconciliationResult,
} from './domain/realReconciliationEngine';
import { reconcilePayments } from './domain/paymentReconciliationEngine';
import {
  applyManualConfirmations,
  useConfirmedReviewKeys,
} from './domain/reconciliationConfirmations';
import { enrichReconciliationResult } from './domain/reconciliationCatalogEnrichment';
import type { RealReconciliationWorkerResponse } from './workers/realReconciliationWorkerTypes';
import {
  buildMatchSuggestions,
  rankClientsForAccount,
  suggestionToLink,
  type MatcherOutput,
  type OrphanNoCliente,
} from './domain/clientCobranzaMatcher';

// Umbral más laxo que AUTO_ACCEPT_THRESHOLD (0.85) — todo lo que cae aquí se
// adjunta solo a la cuenta del catálogo, sin pasar por wizard.
const AUTO_MERGE_THRESHOLD = 0.70;
// Regla de buckets por tipo de nombre (Santiago, 2026-05-12 v3):
//   Persona física (sin marcadores SA/CV/INC ni dígitos, 2-6 tokens) →
//     Viajes Especiales. Trato como viajero ad-hoc.
//   Empresa (marcador de razón social, dígitos, o no encaja como persona) →
//     grupo propio. Intenta colgar de un cliente existente parecido antes
//     de crear nuevo.
//   `manualGroupOverride === true` bloquea el reclassify; movimientos del
//   usuario en la UI se conservan.
const VIAJES_ESPECIALES_GROUP_ID = 'group-viajes-especiales';
const VIAJES_ESPECIALES_GROUP_NAME = 'Viajes Especiales';
// Para orphans <10 fac: umbral mínimo de similitud para colgarlos de un
// cliente existente vía rankClientsForAccount (que ignora REVIEW_THRESHOLD).
const FALLBACK_GROUP_THRESHOLD = 0.40;

// Normalización para comparar nombres de empresa (matcher-style, sin acentos,
// uppercase, alfanumérico). Compacta espacios para substring matching.
function normalizeCompanyName(s: string | undefined | null): string {
  if (!s) return '';
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/^\d{4,5}\s*[-–]\s*/, '') // strip "00011 - " prefix si viene del API
    .replace(/\b(SA|SAB|SAPI|SC|AC|RL|DE|CV|S\s*EN\s*C)\b/g, '')
    .replace(/[^A-Z0-9]/g, '')
    .trim();
}

function addMonthsIso(date: Date, months: number): string {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next.toISOString().slice(0, 10);
}

// Marcadores típicos de razón social mexicana — si aparece alguno en el
// nombre, asumimos empresa (no viajes especiales).
const COMPANY_MARKERS = new Set([
  // Razón social
  'SA', 'SAB', 'SAPI', 'SC', 'AC', 'RL', 'SRL', 'SADECV', 'CV',
  'COMPANIA', 'COMPANY', 'CORP', 'CORPORATION', 'CO',
  'INC', 'LLC', 'GMBH', 'LTD', 'LIMITED', 'BV', 'NV',
  // Tipos de negocio
  'GRUPO', 'INDUSTRIAS', 'INDUSTRIA', 'INDUSTRIAL',
  'SERVICIOS', 'SERVICIO', 'CONSTRUCTORA', 'COMERCIALIZADORA',
  'TRANSPORTES', 'AUTOTRANSPORTES', 'INMOBILIARIA', 'INMUEBLES',
  'DISTRIBUIDORA', 'DISTRIBUCION', 'SOLUCIONES', 'TECNOLOGIA', 'TECHNOLOGIES',
  'SISTEMAS', 'CONSULTORES', 'CONSULTORIA', 'INTERNACIONAL',
  'NACIONAL', 'MEXICANA', 'PRODUCTOS', 'OPERADORA', 'MANUFACTURAS',
  'COMERCIAL', 'EMPRESA', 'CORPORATIVO', 'AGROPECUARIA',
  'AUTOMOTRIZ', 'FERRETERA', 'HOTELERA', 'TURISTICA',
  'BANCO', 'BANCARIA', 'FINANCIERA', 'ASEGURADORA',
  // Industria viajes / transporte
  'VIAJES', 'AGENCIA', 'TURISMO', 'TOURS', 'TRAVEL',
  'BUS', 'BUSES', 'AUTOBUSES', 'AUTOBUS', 'TRANSPORTE',
  'FERROCARRIL', 'AEROLINEA', 'AEROPUERTO', 'PUERTO', 'TERMINAL',
  // Gobierno / instituciones
  'MUNICIPIO', 'GOBIERNO', 'AYUNTAMIENTO', 'SECRETARIA',
  'INSTITUTO', 'UNIVERSIDAD', 'ESCUELA', 'COLEGIO',
  'HOSPITAL', 'CLINICA', 'FUNDACION', 'ASOCIACION', 'PARTIDO',
  'COMISION', 'CONSEJO', 'DIRECCION',
  // Comercio
  'CADENA', 'COMERCIO', 'TIENDA', 'TIENDAS', 'CENTRAL', 'CENTRO',
  'CLUB', 'COOPERATIVA', 'PROMOTORA', 'CONSORCIO', 'HOLDING',
  'EDITORIAL', 'IMPRENTA', 'FABRICA', 'PLANTA',
  'SUPERMERCADOS', 'SUPERMERCADO', 'ALMACEN', 'ALMACENES',
  // Sufijos / términos genéricos de marca
  'SOLUTIONS', 'NETWORKS', 'NETWORK', 'SYSTEMS', 'GROUP',
  'INTERNACIONALES', 'NACIONALES', 'MEXICANO', 'MEXICANOS',
  'MEXICO', 'AMERICA', 'AMERICANA', 'AMERICAS', 'LATAM',
  'DESARROLLO', 'DESARROLLOS', 'PROYECTOS', 'PROYECTO',
  'GLOBAL', 'WORLD', 'WORLDWIDE', 'INTERAMERICANA',
]);

const PERSON_PARTICLES = new Set([
  'DE', 'DEL', 'LA', 'LOS', 'LAS', 'Y', 'VAN', 'DER', 'VON', 'MAC', 'MC', 'EL',
]);

function normalizeNameUpper(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    // Junta razones sociales con puntos sueltos: "S.A." → "SA", "S.A.B." → "SAB"
    .replace(/\b([A-Z])\.\s*([A-Z])\.\s*([A-Z])\.\b/g, '$1$2$3')
    .replace(/\b([A-Z])\.\s*([A-Z])\.\b/g, '$1$2')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isCompanyName(rawName: string | undefined): boolean {
  if (!rawName) return false;
  const norm = normalizeNameUpper(rawName);
  if (!norm) return false;
  if (/\d/.test(norm)) return true;
  for (const t of norm.split(' ')) {
    if (COMPANY_MARKERS.has(t)) return true;
  }
  return false;
}

function isPersonName(rawName: string | undefined): boolean {
  if (!rawName) return false;
  if (isCompanyName(rawName)) return false;
  const norm = normalizeNameUpper(rawName);
  if (!norm) return false;
  const tokens = norm.split(' ').filter(t => !PERSON_PARTICLES.has(t) && t.length >= 2);
  return tokens.length >= 2 && tokens.length <= 6;
}

const STORE_SAVE_DEBOUNCE_MS = 900;
const BANK_STORAGE_SAVE_DEBOUNCE_MS = 1200;
const COBRANZA_AUTO_REFRESH_TTL_MS = 6 * 60 * 60 * 1000;
const CXP_AUTO_REFRESH_TTL_MS = 6 * 60 * 60 * 1000;
const COMPRAS_AUTO_REFRESH_TTL_MS = 6 * 60 * 60 * 1000;
// Boot auto-fetch lookback. Con chunks de 1 día (requisito del usuario para
// alimentar el cache diario), 730 días históricos dan base suficiente al
// motor predictivo Holt-Winters (≥24 meses). Compras agrega además 3 meses
// futuros para OCs ya capturadas; PagoProveedor se queda histórico porque son
// pagos ejecutados. El cache IDB persistente sirve días pasados sin tocar JDE
// en boot subsecuentes — solo el primer arranque pega duro.
const COMPRAS_LOOKBACK_DAYS = 730;
const COMPRAS_FUTURE_LOOKAHEAD_MONTHS = 3;
const COMPRAS_CACHE_KEY = '__all__';
// Tabs que dependen del cruce JDE↔banco para mostrar números correctos.
// Proyección / Planeación / Impuestos consumen `cobranzaReconciliation`
// vía `buildFinancialProjectionSourceData` para no doblar facturas
// CXC ya cobradas. Si no se calcula al entrar a esos tabs, el primer
// render de la proyección queda con cobranza inflada hasta que el
// usuario regresa a Cobranza/Bancos/Dashboard.
const RECONCILIATION_TABS = new Set<TabId>([
  'dashboard',
  'collections',
  'bancos',
  'financialProjection',
  'financialPlanning',
  'taxes',
]);

type SectionId = 'catalogos' | 'operacion' | 'proyeccion';

/**
 * Section + tab order is the canonical sidebar/keyboard ordering.
 *
 * Mental model: treasury opens the Dashboard daily, drills into Operación
 * (Flujo Neto → CXP → Cobranza) when the numbers move, and only touches
 * Catálogos when onboarding new entities. So:
 *   - Proyección (daily workspace) first → numeric shortcuts 1-4
 *   - Operación (drilldowns) middle    → shortcuts 5-8
 *   - Catálogos (maintenance) last     → shortcuts 9-11
 * `TAB_IDS` is derived from SUB_TABS so the keyboard order can never drift
 * from the visible sidebar order again.
 */
const SECTIONS: { id: SectionId; label: string; icon: LucideIcon; description: string }[] = [
  { id: 'proyeccion', label: 'Proyección',  icon: TrendingUp,      description: 'Dashboard, pronóstico y escenarios' },
  { id: 'operacion',  label: 'Operación',   icon: Activity,        description: 'Flujo neto, CXP y cobranza' },
  { id: 'catalogos',  label: 'Catálogos',   icon: BookUser,        description: 'Clientes, proveedores y bancos' },
];

const SUB_TABS: Record<SectionId, { id: TabId; label: string; icon: LucideIcon }[]> = {
  proyeccion: [
    { id: 'dashboard',           label: 'Dashboard',             icon: LayoutDashboard },
    { id: 'financialProjection', label: 'Proyección Financiera', icon: BarChart3 },
    { id: 'financialPlanning',   label: 'Planeación Financiera', icon: ClipboardList },
    { id: 'taxes',               label: 'Impuestos',             icon: Landmark },
    { id: 'payroll',             label: 'Nómina',                icon: Users },
  ],
  operacion: [
    { id: 'netflow',     label: 'Flujo Neto',  icon: Wallet },
    { id: 'cxp',         label: 'CXP',         icon: Receipt },
    { id: 'compras',     label: 'Órdenes de Compras', icon: FolderOpen },
    { id: 'pagos',       label: 'Pagos',       icon: CreditCard },
    { id: 'collections', label: 'Cobranza',    icon: HandCoins },
    { id: 'fideicomiso', label: 'Fideicomiso', icon: ShieldCheck },
  ],
  catalogos: [
    { id: 'clients',   label: 'Clientes',     icon: UserSquare },
    { id: 'providers', label: 'Proveedores',  icon: Users },
    { id: 'bancos',    label: 'Bancos',       icon: Landmark },
  ],
};

const SECTION_FOR_TAB: Partial<Record<TabId, SectionId>> = {
  clients: 'catalogos', providers: 'catalogos', bancos: 'catalogos',
  netflow: 'operacion',
  cxp: 'operacion', compras: 'operacion', pagos: 'operacion', collections: 'operacion', fideicomiso: 'operacion',
  dashboard: 'proyeccion',
  financialProjection: 'proyeccion', financialPlanning: 'proyeccion', taxes: 'proyeccion',
  payroll: 'proyeccion',
};

const DEFAULT_TAB: Record<SectionId, TabId> = {
  catalogos: 'clients',
  operacion: 'netflow',
  proyeccion: 'dashboard',
};

/**
 * Identifica si el cache de bankStatements contiene registros demo/ficticios
 * que se hayan quedado de versiones anteriores del app. Los demo statements
 * legacy usaban referencias y conceptos muy específicos (TRF-001, PAG-055,
 * "PAGO PROVEEDORES DIESEL", etc.) que nunca aparecen en JDE real — basta con
 * detectar uno para descartar el cache completo y no mezclar ficticio con
 * real en el flujo.
 */
const DEMO_BANK_REFS = new Set([
  'TRF-001', 'TRF-002', 'TRF-003',
  'DEP-100', 'PAG-055',
  'COB-220', 'PAG-120',
  'WIRE-01', 'WIRE-02',
]);
const DEMO_BANK_CONCEPTS = [
  'PAGO CLIENTES NORTE',
  'PAGO NOMINA QUINCENAL',
  'COBRO FACTURA 2024-1150',
  'DEPOSITO COBRANZA SUR',
  'PAGO PROVEEDORES DIESEL',
  'COBRANZA CLIENTES CITI',
  'PAGO REFACCIONES',
  'COBRO CROSS-BORDER LAREDO',
  'PAGO SEGURO INTERNACIONAL',
];
/**
 * Quiet placeholder shown while a lazy-loaded tab module is fetched. Matches
 * the page chrome (header + KPI grid + section cards) so first paint after
 * code-split is layout-stable. No spinner, no marketing copy — just the
 * skeleton chassis the user is about to interact with.
 */
function LazyTabFallback({ label }: { label: string }) {
  // Delegates to the canonical shell so Suspense fallbacks and runtime
  // dashboard skeletons share one motion language.
  return <DashboardLoadingShell kpis={4} showFilterBar showChart label={`Cargando ${label}`} />;
}

function containsDemoBankData(statements: BankAccountStatement[] | undefined | null): boolean {
  if (!statements || statements.length === 0) return false;
  for (const acc of statements) {
    for (const mov of acc.movimientos ?? []) {
      const ref = (mov.referencia ?? '').trim();
      if (ref && DEMO_BANK_REFS.has(ref)) return true;
      const concepto = (mov.concepto ?? '').trim().toUpperCase();
      if (concepto && DEMO_BANK_CONCEPTS.includes(concepto)) return true;
    }
  }
  return false;
}

interface BankCacheLoad {
  bankJdeStatements: BankAccountStatement[];
  bankSupplementalStatements: BankAccountStatement[];
  bankLastQuery: BankQueryState | null;
}

// Carga los caches de bancos: bankLastQuery sigue en localStorage (es chico),
// pero bankJdeStatements y bankSupplementalStatements ahora viven en IDB
// (heavy-store) porque la cuota de localStorage (~5MB) se rompía con 2 años
// de movimientos y dejaba al usuario con un cache truncado.
//
// Migración: si hay datos en localStorage (legacy), los lee, los mueve a IDB
// y borra las llaves legacy. Idempotente — un boot post-migración encuentra
// IDB poblada y localStorage vacía.
async function loadBankCaches(): Promise<BankCacheLoad> {
  try {
    const rawQuery = localStorage.getItem('midas.bankLastQuery.v2');
    const parsedQuery = rawQuery ? (JSON.parse(rawQuery) as BankQueryState) : null;

    // IDB primero. Si está poblada, esa es la fuente de verdad.
    const idb = await loadBankStatementsFromIDB();
    let jdeFromIdb = idb.jde as BankAccountStatement[];
    let supplementalFromIdb = idb.supplemental as BankAccountStatement[];

    // Migración legacy: si IDB está vacía pero localStorage tiene datos,
    // mueve a IDB y borra localStorage.
    if (jdeFromIdb.length === 0 || supplementalFromIdb.length === 0) {
      const rawStatements = localStorage.getItem('midas.bankStatements.v2');
      const rawSupplemental = localStorage.getItem('midas.bankSupplementalStatements.v1');
      const legacyJde = rawStatements ? (JSON.parse(rawStatements) as BankAccountStatement[]) : [];
      const legacySupplemental = rawSupplemental ? (JSON.parse(rawSupplemental) as BankAccountStatement[]) : [];
      if (legacyJde.length > 0 && jdeFromIdb.length === 0) {
        // eslint-disable-next-line no-console
        console.info(`[loadBankCaches] migrando bankJdeStatements localStorage→IDB · ${legacyJde.length} accounts`);
        await saveBankJdeStatementsToIDB(legacyJde);
        jdeFromIdb = legacyJde;
      }
      if (legacySupplemental.length > 0 && supplementalFromIdb.length === 0) {
        // eslint-disable-next-line no-console
        console.info(`[loadBankCaches] migrando bankSupplementalStatements localStorage→IDB · ${legacySupplemental.length} accounts`);
        await saveBankSupplementalStatementsToIDB(legacySupplemental);
        supplementalFromIdb = legacySupplemental;
      }
      // Borra localStorage post-migración (idempotente — un boot futuro
      // encuentra IDB poblada y skippea esta rama).
      try { localStorage.removeItem('midas.bankStatements.v2'); } catch { /* ignore */ }
      try { localStorage.removeItem('midas.bankSupplementalStatements.v1'); } catch { /* ignore */ }
    }

    // Demo-data guard: si lo cargado coincide con un patrón de datos demo
    // viejos (cuentas hardcoded), limpiamos. Aplicar después de migrar.
    if (containsDemoBankData(jdeFromIdb)) {
      await saveBankJdeStatementsToIDB([]);
      jdeFromIdb = [];
      localStorage.removeItem('midas.bankLastQuery.v2');
    }
    if (containsDemoBankData(supplementalFromIdb)) {
      await saveBankSupplementalStatementsToIDB([]);
      supplementalFromIdb = [];
    }

    const isSantander = parsedQuery?.formatoElectronico === SANTANDER_FILE_FORMAT;
    const bankJdeStatements: BankAccountStatement[] = isSantander ? [] : jdeFromIdb;
    const bankSupplementalStatements: BankAccountStatement[] =
      supplementalFromIdb.length > 0 ? supplementalFromIdb : (isSantander ? jdeFromIdb : []);
    const bankLastQuery: BankQueryState | null = parsedQuery
      ? (isSantander || supplementalFromIdb.length > 0
          ? { ...parsedQuery, hasUploadedSantander: true }
          : parsedQuery)
      : null;

    return { bankJdeStatements, bankSupplementalStatements, bankLastQuery };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[loadBankCaches] failed:', err);
    return { bankJdeStatements: [], bankSupplementalStatements: [], bankLastQuery: null };
  }
}

function emptyRealReconciliationResult(): RealReconciliationResult {
  return {
    matches: [],
    abonoEnrichments: [],
    paymentReconciliations: [],
    summary: {
      totalFacturas: 0,
      facturasCobradasBanco: 0,
      facturasCobradasJdeSinBanco: 0,
      facturasPendientes: 0,
      totalSaldoBruto: 0,
      totalSaldoPendiente: 0,
      totalCobradoBanco: 0,
      totalAbonos: 0,
      totalAbonoMonto: 0,
      abonosFacturaCobrada: 0,
      abonosSinFactura: 0,
      abonosTraspasoInterno: 0,
      pctAbonosCruzados: 0,
      pctFacturasCruzadas: 0,
      ciaBreakdown: [],
    },
    reviewCandidates: [],
    bankCoverage: {
      loadedDates: [],
      totalMovements: 0,
      totalAbonos: 0,
    },
    timingsMs: {
      totalMs: 0,
      indexMs: 0,
      matchMs: 0,
    },
  };
}

function buildFacturaIndex(
  matches: RealReconciliationMatch[],
): Map<string, RealReconciliationMatch> {
  const map = new Map<string, RealReconciliationMatch>();
  for (const m of matches) {
    map.set(`${m.cia}::${m.noFactura}`, m);
  }
  return map;
}

function buildAbonoIndex(
  enrichments: AbonoEnrichment[],
): Map<string, AbonoEnrichment> {
  const map = new Map<string, AbonoEnrichment>();
  for (const e of enrichments) {
    map.set(e.movementKey, e);
  }
  return map;
}

function isFreshTimestamp(value: string | undefined, ttlMs: number): boolean {
  if (!value) return false;
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < ttlMs;
}

type IdleWindow = Window & {
  requestIdleCallback?: (cb: IdleRequestCallback, options?: IdleRequestOptions) => number;
  cancelIdleCallback?: (id: number) => void;
};

interface EnsureBankCoverageRequest {
  from: string;
  to: string;
  ciaFilter?: string[];
}

function scheduleIdleTask(callback: () => void, timeout = 2000): () => void {
  if (typeof window === 'undefined') {
    callback();
    return () => {};
  }
  const idleWindow = window as IdleWindow;
  let cancelled = false;
  if (idleWindow.requestIdleCallback) {
    const id = idleWindow.requestIdleCallback(() => {
      if (!cancelled) callback();
    }, { timeout });
    return () => {
      cancelled = true;
      idleWindow.cancelIdleCallback?.(id);
    };
  }
  const id = window.setTimeout(() => {
    if (!cancelled) callback();
  }, 0);
  return () => {
    cancelled = true;
    window.clearTimeout(id);
  };
}

export default function App() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [assumptions, setAssumptions] = useState<CashFlowAssumptions>({
    year: new Date().getFullYear(),
    globalCompliance: 1,
    factorajeDays: 30,
  });
  const [confirmedPayments, setConfirmedPayments] = useState<ConfirmedPayment[]>([]);
  // Sugerencias del matcher cliente↔cobranza pendientes de revisión.
  // No se persisten: se recomputan en cada cambio de clients/cobranzaRecords.
  const [matcherReview, setMatcherReview] = useState<MatcherOutput>({
    autoAccepted: [],
    needsReview: [],
    orphanNoClientes: [],
  });

  const [cxpRecords, setCxpRecords] = useState<CXPRecord[]>([]);
  const [cxpLoadedCias, setCxpLoadedCias] = useState<Record<string, string>>({});
  // Cobranza (CXC) — endpoint /JDEdwards/cobranza, liberado a
  // producción 2026-05-01. Mismo patrón que cxpRecords: cache en localStorage
  // a través de MidasStore (v8), refresh secuencial por cia, último año
  // (fechaInicial = hoy - 365d).
  const [cobranzaRecords, setCobranzaRecords] = useState<CobranzaRecord[]>([]);
  const [cobranzaLoadedCias, setCobranzaLoadedCias] = useState<Record<string, string>>({});
  const [cobranzaPayments, setCobranzaPayments] = useState<CobranzaPayment[]>([]);
  const [cobranzaPaymentsLoadedCias, setCobranzaPaymentsLoadedCias] = useState<Record<string, string>>({});
  // Compras (Órdenes de Compra) — endpoint /JDEdwards/compras,
  // liberado a producción 2026-05-08. Restricción del API: 30 días por
  // request → fetchComprasRange parte el rango en chunks. Cargamos 2 años
  // hacia atrás para entrenar predictor y 3 meses hacia adelante para ver
  // OCs futuras ya capturadas en JDE.
  const [comprasRecords, setComprasRecords] = useState<ComprasRecord[]>([]);
  const [comprasLoadedCias, setComprasLoadedCias] = useState<Record<string, string>>({});
  // PagoProveedor — endpoint /JDEdwards/pagoproveedor, liberado a
  // producción 2026-05-13. Pagos ya ejecutados (espejo egreso de cobranza).
  // Cierra el loop CXP↔OC↔banco mostrando qué facturas/OCs ya se pagaron y
  // contra qué cuenta bancaria. Mismo patrón de auto-fetch 60d que compras.
  const [pagoProveedorRecords, setPagoProveedorRecords] = useState<PagoProveedorRecord[]>([]);
  const [pagoProveedorLoadedCias, setPagoProveedorLoadedCias] = useState<Record<string, string>>({});
  // Nómina TRESS — cache aditivo. Auto-fetch al boot del mes en curso con
  // idEmpresa=99, tipoNomina=99 (1 request cubre todas las cías y tipos);
  // refreshes posteriores los dispara el módulo de Nómina.
  const [nominaRecords, setNominaRecords] = useState<PayrollCostRecord[]>([]);
  const [nominaLoadedKeys, setNominaLoadedKeys] = useState<Record<string, string>>({});
  // Status del auto/manual fetch de cobranza — se muestra en la pestaña
  // Cobranza para que el usuario sepa qué pasó si la lista llega vacía.
  // Antes los errores eran silenciados y resultaba imposible diagnosticar
  // 0% de cruce sin abrir DevTools.
  const [cobranzaError, setCobranzaError] = useState<string | null>(null);
  const [cobranzaRefreshing, setCobranzaRefreshing] = useState(false);
  const [cashFlowOverrides, setCashFlowOverrides] = useState<CashFlowOverrides>({});
  // Dashboard is the daily landing surface for treasury — opens to the same
  // numbers that match keyboard `1`. Previously defaulted to 'netflow' which
  // dropped users into a raw movements table on every boot.
  const [activeTab, setActiveTab] = useState<TabId>('dashboard');
  /**
   * Stable navigation handler.
   *
   * The previous inline arrow recreated `goTo` every parent render, which
   * churned the `NavigationProvider` context value on every keystroke /
   * background poll. Combined with the `<div key={pageKey}>` remount, that
   * caused descendants to receive a fresh context, re-Suspend, and (under
   * heavy compute on FinancialProjectionDashboard) eventually lock the
   * main thread. `useCallback` here + hoisting the provider above the
   * remount wrapper is the fix.
   */
  const goTo = useCallback((target: AppTabId | NavTarget) => {
    const next = typeof target === 'string' ? target : target.tab;
    const focus = typeof target === 'string' ? undefined : target.focus;
    setActiveTab(next as TabId);
    if (focus) {
      try {
        sessionStorage.setItem('midas.navFocus', `${next}:${focus}`);
      } catch {
        /* private mode */
      }
    }
  }, []);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  // Flag aparte de catalogLoaded — éste indica que loadStore() (light de
  // localStorage v12 + heavies de IDB) terminó de hidratar el state. Los boot
  // effects que necesitan saber si hay registros previos (compras, pago,
  // banks, cxp, cobranza) gatean en esto para no disparar fetches con state
  // vacío y luego sobreescribirlo. catalogLoaded se setea cuando los CSVs
  // de clients/providers terminan, no cuando loadStore terminó.
  const [storeHydrated, setStoreHydrated] = useState(false);

  // ── Boot splash state ──
  // All boot APIs (catalog, companies, banks, CXP, cobranza) run in parallel.
  // The artifact only renders once every task lands in `done` or `error`.
  const bootStartedAtRef = useRef<number>(Date.now());
  const [bootStatus, setBootStatus] = useState<{
    catalog: BootTaskStatus;
    companies: BootTaskStatus;
    banks: BootTaskStatus;
    cxp: BootTaskStatus;
    cobranza: BootTaskStatus;
    nomina: BootTaskStatus;
  }>({
    catalog: 'loading',
    companies: 'loading',
    banks: 'loading',
    cxp: 'pending',
    cobranza: 'pending',
    nomina: 'pending',
  });
  const [cxpBootProgress, setCxpBootProgress] = useState<{ done: number; total: number } | null>(null);
  const [cobranzaBootProgress, setCobranzaBootProgress] = useState<{ done: number; total: number } | null>(null);
  const setBootSlot = useCallback(
    (slot: 'catalog' | 'companies' | 'banks' | 'cxp' | 'cobranza' | 'nomina', status: BootTaskStatus) => {
      setBootStatus(prev => (prev[slot] === status ? prev : { ...prev, [slot]: status }));
    },
    [],
  );
  const [isBooted, setIsBooted] = useState(false);
  const [splashMounted, setSplashMounted] = useState(true);

  // ── JDE integration state ──
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companiesLoadedAt, setCompaniesLoadedAt] = useState<string | undefined>(undefined);
  // True una vez que el cache local hidrató companies. Permite a
  // loadCompanies() saber que no debe bloquear el splash con 'loading' aunque
  // se haya disparado antes de que React aplique el set del cache.
  const companiesHydratedFromCacheRef = useRef(false);
  const [companyGroups, setCompanyGroups] = useState<CompanyGroup[]>(() => loadCompanyGroups());
  const [selectedCia, setSelectedCia] = useState<string>(
    () => localStorage.getItem('midas.selectedCia') ?? 'all'
  );

  // Persist company groups
  useEffect(() => { saveCompanyGroups(companyGroups); }, [companyGroups]);
  const [companiesLoading, setCompaniesLoading] = useState(false);
  const [companiesError, setCompaniesError] = useState<string | null>(null);
  // Bank-statement caches start empty and hydrate from localStorage on idle
  // (see `bankCacheHydrationEffect` below). The splash screen masks any
  // first-paint where the data is still empty, so the lift moves the
  // multi-MB JSON.parse off the critical render path without a UX cost.
  const [bankJdeStatements, setBankJdeStatements] = useState<BankAccountStatement[]>([]);
  const [bankSupplementalStatements, setBankSupplementalStatements] = useState<BankAccountStatement[]>([]);
  const [bankLastQuery, setBankLastQuery] = useState<BankQueryState | null>(null);
  const [bankCacheLoaded, setBankCacheLoaded] = useState(false);
  // Hydrate bank caches on idle. Las statements (jde + supplemental) viven en
  // IDB heavy-store. bankLastQuery sigue en localStorage (es chico). Diferido
  // a idle para no bloquear LCP — el splash cubre la UI hasta que el boot de
  // bancos termina. Signal `bankCacheLoaded` para que el step 2 del backfill
  // sepa cuándo arrancar.
  useEffect(() => {
    return scheduleIdleTask(() => {
      void loadBankCaches().then((caches) => {
        if (caches.bankJdeStatements.length) setBankJdeStatements(caches.bankJdeStatements);
        if (caches.bankSupplementalStatements.length) setBankSupplementalStatements(caches.bankSupplementalStatements);
        if (caches.bankLastQuery) setBankLastQuery(caches.bankLastQuery);
        setBankCacheLoaded(true);
      });
    });
  }, []);
  const bankStatements = useMemo(
    () => mergeBankStatements(bankJdeStatements, bankSupplementalStatements),
    [bankJdeStatements, bankSupplementalStatements],
  );
  // BAJIO se exhibe en la pestaña Bancos pero no se contabiliza ni se proyecta:
  // el excedente cae siempre en Banamex, así que incluirlo duplica flujo.
  const accountableBankStatements = useMemo(
    () => excludeBajio(bankStatements),
    [bankStatements],
  );
  // ── Cruce pagos ↔ CXP ↔ banco (motor de PagoProveedor) ────────────────
  // Sincrónico: el matching es O(pagos × cxps_por_proveedor + pagos × cargos_por_cuenta)
  // — varios órdenes de magnitud menor que la conciliación de cobranza. Si en
  // el futuro escala a millones de movs, mover a idle como cobranza.
  const paymentReconciliation = useMemo(
    () => reconcilePayments({
      payments: pagoProveedorRecords,
      cxpRecords,
      bankStatements: accountableBankStatements,
    }),
    [pagoProveedorRecords, cxpRecords, accountableBankStatements],
  );
  // Set de CXPs pagadas — feed para excluirlas del egreso proyectado en
  // canonicalProjection. Solo `PAID` (cobertura completa); `PARTIAL` deja
  // que el residuo siga proyectándose.
  const paidCxpKeys = useMemo(() => {
    const out = new Set<string>();
    for (const [key, cov] of paymentReconciliation.cxpCoverage) {
      if (cov.status === 'PAID') out.add(key);
    }
    return out;
  }, [paymentReconciliation]);
  const nonInternalPagoProveedorRecords = useMemo(() => {
    const internalKeys = paymentReconciliation.internalPaymentKeys;
    if (internalKeys.size === 0) return pagoProveedorRecords;
    return pagoProveedorRecords.filter((record) => !internalKeys.has(`${record.cia}::${record.noPago}`));
  }, [pagoProveedorRecords, paymentReconciliation.internalPaymentKeys]);
  // ── Cruce cobranza ↔ bancos (compartido) ──────────────────────────────
  // Es un motor pesado (texto + subset-sum), así que no corre durante render.
  // Lo diferimos a idle y sólo cuando una pestaña lo necesita; así cargar JDE
  // no congela la plataforma ni bloquea el primer paint.
  const [rawCobranzaReconciliation, setCobranzaReconciliation] = useState<RealReconciliationResult>(
    () => emptyRealReconciliationResult(),
  );
  const confirmedReviewKeys = useConfirmedReviewKeys();
  const cobranzaReconciliation = useMemo(
    () => enrichReconciliationResult(
      applyManualConfirmations(rawCobranzaReconciliation, confirmedReviewKeys),
      clients,
    ),
    [rawCobranzaReconciliation, confirmedReviewKeys, clients],
  );
  const shouldComputeCobranzaReconciliation =
    (cobranzaRecords.length > 0 || cobranzaPayments.length > 0) && RECONCILIATION_TABS.has(activeTab);
  const activeReconciliationCias = useMemo(() => {
    if (selectedCia === 'all') return undefined;
    const allCias = companies.filter(c => c.activa !== false).map(c => c.cia);
    const resolved = resolveActiveCias(selectedCia, companyGroups, allCias);
    return resolved.length > 0 ? resolved : undefined;
  }, [selectedCia, companies, companyGroups]);
  const activeReconciliationCiaKey = activeReconciliationCias?.join('|') ?? 'all';
  const reconciliationWorkerRef = useRef<Worker | null>(null);
  const reconciliationJobRef = useRef(0);
  useEffect(() => {
    if (cobranzaRecords.length === 0 && cobranzaPayments.length === 0) {
      setCobranzaReconciliation(emptyRealReconciliationResult());
      return;
    }
    if (!shouldComputeCobranzaReconciliation) return;

    let cancelled = false;
    const jobId = ++reconciliationJobRef.current;
    const cancelIdle = scheduleIdleTask(() => {
      const runFallback = () => {
        void import('./domain/realReconciliationEngine')
          .then(({ reconcileRealCollections }) => {
            if (cancelled || reconciliationJobRef.current !== jobId) return;
            const result = reconcileRealCollections(cobranzaRecords, accountableBankStatements, {
              ciaFilter: activeReconciliationCias?.length ? new Set(activeReconciliationCias) : undefined,
              cobranzaPayments,
            });
            if (!cancelled && reconciliationJobRef.current === jobId) setCobranzaReconciliation(result);
          });
      };

      if (typeof Worker === 'undefined') {
        runFallback();
        return;
      }

      try {
        if (!reconciliationWorkerRef.current) {
          reconciliationWorkerRef.current = new Worker(
            new URL('./workers/realReconciliation.worker.ts', import.meta.url),
            { type: 'module' },
          );
        }
        const worker = reconciliationWorkerRef.current;
        worker.onmessage = (event: MessageEvent<RealReconciliationWorkerResponse>) => {
          if (cancelled || event.data.jobId !== reconciliationJobRef.current) return;
          if (event.data.result) setCobranzaReconciliation(event.data.result);
          else runFallback();
        };
        worker.onerror = () => {
          if (!cancelled && reconciliationJobRef.current === jobId) runFallback();
        };
        worker.postMessage({
          jobId,
          cobranzaRecords,
          cobranzaPayments,
          bankStatements: accountableBankStatements,
          ciaFilter: activeReconciliationCias,
        });
      } catch {
        runFallback();
      }
    }, 1500);

    return () => {
      cancelled = true;
      cancelIdle();
    };
  }, [cobranzaRecords, cobranzaPayments, accountableBankStatements, shouldComputeCobranzaReconciliation, activeReconciliationCiaKey]);
  useEffect(() => {
    return () => {
      reconciliationWorkerRef.current?.terminate();
      reconciliationWorkerRef.current = null;
    };
  }, []);
  const cobranzaFacturaIndex = useMemo(
    () => buildFacturaIndex(cobranzaReconciliation.matches),
    [cobranzaReconciliation],
  );
  const cobranzaAbonoIndex = useMemo(
    () => buildAbonoIndex(cobranzaReconciliation.abonoEnrichments),
    [cobranzaReconciliation],
  );
  // UI status for the auto/manual bank refresh — shown as a pill in Flujo Neto.
  const [bankFetchStatus, setBankFetchStatus] = useState<
    'idle' | 'priming' | 'ranging'
  >('idle');
  const [bankFetchProgress, setBankFetchProgress] = useState<
    { done: number; total: number } | null
  >(null);
  const [bankCoverageLoading, setBankCoverageLoading] = useState(false);

  // Caja inicial fija — decisión de negocio, no editable por el usuario.
  const effectiveStartingBalance = FIXED_STARTING_BALANCE;

  // OCs (Compras) traducidas a PurchaseReceiptRecord para alimentar el motor
  // canónico de proyección. Emite DOS tipos:
  //   - CONFIRMED: OC ya recibida, fecha de pago = recepción + díasCrédito.
  //   - PROJECTED: OC pedida sin recepción, fecha de pago estimada con lead
  //     time histórico por familia (alimenta forecast largo plazo).
  // Filtros: cancelados, workflow JDE cerrado (Edo_Sig), importes ≤ 0, fechas
  // pasadas. El motor canónico hace dedup vs CXP (no doble-conteo). Memoizado
  // por comprasRecords.
  const purchaseReceiptsFromCompras = useMemo(
    () => comprasToPurchaseReceipts(comprasRecords, {
      asOfDate: new Date().toISOString().slice(0, 10),
      includeProjected: true,
      excludePastUnexecuted: true,
      futureOrderLookaheadMonths: COMPRAS_FUTURE_LOOKAHEAD_MONTHS,
      cxpRecords,
      pagoProveedorRecords: nonInternalPagoProveedorRecords,
    }),
    [comprasRecords, cxpRecords, nonInternalPagoProveedorRecords],
  );

  // Promedio de gasto por proveedor en los últimos 3 meses calendario,
  // derivado de PagoProveedor real. Sobrescribe `montoPromedioPago` y
  // `gastoMinimoMensual` del catálogo para que el piso operativo refleje
  // el ritmo de pago vigente, no el promedio anual 2025.
  const providerSpendIndex = useMemo(
    () => buildProviderSpendIndex(nonInternalPagoProveedorRecords, { months: 3 }),
    [nonInternalPagoProveedorRecords],
  );
  // Sólo enriquecer cuando hay pagos reales para extraer historia. Si pagos
  // está vacío (splash en curso, sin data) devolvemos la referencia original
  // de providers — así la proyección no invalida su cache canónico en cada
  // render, lo que disparaba un recompute pesado y colgaba el navegador.
  const providersEnriched = useMemo(
    () => {
      if (nonInternalPagoProveedorRecords.length === 0) return providers;
      return enrichProvidersWithRecentSpend(providers, providerSpendIndex);
    },
    [providers, providerSpendIndex, nonInternalPagoProveedorRecords.length],
  );

  // Modelo de pronóstico para FUTURAS OCs (no ya emitidas). El usuario lo
  // elige en la barra de Proyección Financiera; lo persistimos en
  // localStorage para que sobreviva refresh.
  const [forecastModelId, setForecastModelIdState] = useState<ForecastModelId>(() => {
    try {
      const stored = localStorage.getItem('midas.projection.forecastModel.v1');
      if (stored === 'moving-avg' || stored === 'linear-trend' || stored === 'historical-cadence') {
        return stored as ForecastModelId;
      }
    } catch { /* ignore */ }
    return DEFAULT_FORECAST_MODEL;
  });
  const setForecastModelId = useCallback((id: ForecastModelId) => {
    setForecastModelIdState(id);
    try { localStorage.setItem('midas.projection.forecastModel.v1', id); } catch { /* ignore */ }
  }, []);

  // OCs futuras pronosticadas según el modelo seleccionado. Se concatenan
  // a las CONFIRMED + lead-time-projected para que la curva de egresos
  // proyectada cubra el horizonte completo y no solo lo que ya se pidió.
  const forecastedReceipts = useMemo(
    () => forecastFutureCompras(
      { comprasRecords, providers: providersEnriched, horizonMonths: 6, topProvidersByVolume: 80 },
      forecastModelId,
    ),
    [comprasRecords, providersEnriched, forecastModelId],
  );
  // NOTE: forecastedReceipts.receipts NO se concatena a `purchaseReceipts`
  // pasado a Proyección por ahora — feed pesado disparaba recompute del
  // canónico en cada render. El selector + KPI siguen funcionando
  // como vista previa hasta que se mueva el merge a un worker / cache stable.

  // Piso operativo de nómina = promedio mensual real, suavizado sobre 12 meses
  // cerrados. Por qué 12 y no 3:
  //   TRESS agrupa los registros por FechaPago, no por periodo. En la práctica
  //   los meses caen bimodalmente: meses "grandes" con 17M+ (varias quincenas
  //   + operadores) y meses "chicos" con ~1M (solo ejecutivos off-cycle). Un
  //   avg 3m agarra 1 grande + 2 chicos según el calendario actual y termina
  //   en ~5M — muy por debajo del piso real (~9M). Sumar 12 meses cerrados y
  //   dividir entre 12 cancela la asimetría y devuelve el verdadero costo
  //   mensual operativo proyectable a futuro.
  // Fórmula: (Σ_12m CASH_OUT − Σ_12m (DEDUCTION + WITHHOLDING_PAYABLE)) / 12.
  // Excluye el mes en curso (datos parciales). Filtra por cia si está activa.
  const payrollMonthlyActualJDE = useMemo(() => {
    if (nominaRecords.length === 0) return undefined;
    const ciaFilter = selectedCia && selectedCia !== 'all'
      ? selectedCia.replace(/\D/g, '').padStart(5, '0')
      : '';
    const grossByMonth = new Map<string, number>();
    const reducByMonth = new Map<string, number>();
    for (const r of nominaRecords) {
      if (ciaFilter && r.cia !== ciaFilter) continue;
      const key = `${r.year}-${String(r.month).padStart(2, '0')}`;
      if (r.cashTreatment === 'CASH_OUT') {
        grossByMonth.set(key, (grossByMonth.get(key) ?? 0) + r.amount);
      } else if (r.cashTreatment === 'DEDUCTION' || r.cashTreatment === 'WITHHOLDING_PAYABLE') {
        reducByMonth.set(key, (reducByMonth.get(key) ?? 0) + r.amount);
      }
    }
    const now = new Date();
    const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const closedMonths = Array.from(grossByMonth.keys())
      .filter((k) => grossByMonth.get(k)! > 0 && k !== currentKey)
      .sort()
      .reverse();
    if (closedMonths.length === 0) return undefined;
    const windowSize = Math.min(12, closedMonths.length);
    const window12 = closedMonths.slice(0, windowSize);
    let sumGross = 0;
    let sumReduc = 0;
    for (const k of window12) {
      sumGross += grossByMonth.get(k) ?? 0;
      sumReduc += reducByMonth.get(k) ?? 0;
    }
    const avg = Math.max(0, sumGross - sumReduc) / windowSize;
    return avg > 0 ? avg : undefined;
  }, [nominaRecords, selectedCia]);

  const confirmPayment = (p: ConfirmedPayment) => setConfirmedPayments(prev => [...prev, p]);
  const unconfirmPayment = (key: string) => setConfirmedPayments(prev => prev.filter(x => x.key !== key));

  // ── New UI features state ──
  const { open: cmdOpen, setOpen: setCmdOpen } = useCommandPalette();
  const [activityOpen, setActivityOpen] = useState(false);

  // Planning scenarios + adjustments for Cmd+K — refreshed on every palette open.
  const [paletteScenarios, setPaletteScenarios] = useState<{ id: string; name: string }[]>([]);
  const [paletteAdjustments, setPaletteAdjustments] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!cmdOpen) return;
    try {
      const scenarios = loadPlanningScenarios([]);
      setPaletteScenarios(
        scenarios
          .filter((s) => !s.archivedAt)
          .map((s) => ({ id: s.id, name: s.name })),
      );
      const adjustments = loadPlanningAdjustments([]);
      setPaletteAdjustments(adjustments.map((a) => ({ id: a.id, name: a.name })));
    } catch {
      setPaletteScenarios([]);
      setPaletteAdjustments([]);
    }
  }, [cmdOpen]);
  const paletteActions: CommandPaletteAction[] = useMemo(() => [
    {
      id: 'open-planning',
      label: 'Abrir Planeación Financiera',
      run: () => setActiveTab('financialPlanning'),
    },
    {
      id: 'create-draft',
      label: 'Nueva propuesta (borrador)',
      run: () => {
        setActiveTab('financialPlanning');
        window.dispatchEvent(new CustomEvent('midas:planning:createDraft'));
      },
    },
  ], []);

  // Derived from SUB_TABS in section order so keyboard shortcuts (1-N) always
  // match the sidebar order. Previously hardcoded — bancos at #4 was a
  // catálogos tab leaking into the operación block; fideicomiso/taxes were
  // unreachable by number entirely.
  // Atajos 1-N cambian sub-tabs DENTRO de la sección activa
  // (Proyección / Operación / Catálogos). Sección se deriva de activeTab.
  const { shortcutsOpen, setShortcutsOpen } = useKeyboardShortcuts({
    onTabSwitch: (n) => {
      const section = SECTION_FOR_TAB[activeTab] ?? 'proyeccion';
      const tabs = SUB_TABS[section];
      if (n >= 1 && n <= tabs.length) setActiveTab(tabs[n - 1].id);
    },
  });

  // Load from persistence on mount. Async desde v12: heavies
  // (cobranza/cxp/compras/pagoproveedor/nómina/payments) viven en IDB porque
  // localStorage tenía cuota ~5MB que se rompía y dejaba el store sin
  // persistir, causando refetch JDE en cada boot. Ver persistence.ts:saveStore.
  useEffect(() => {
    let cancelled = false;
    // CRÍTICO: storeHydrated debe dispararse SIEMPRE, aún si loadStore truena
    // o algún setter falla. Si no, los boot effects (compras/pago/banks/cxp/
    // cobranza/nomina) quedan deadlockeados esperando el flag y la app
    // congela en el splash. Por eso envolvemos cada setter en try/catch y
    // usamos .finally() para el flag. Fallback adicional de 8s por si la
    // promesa entera nunca resuelve (IDB locked + sin timeout efectivo).
    const fallbackTimer = window.setTimeout(() => {
      if (!cancelled) {
        // eslint-disable-next-line no-console
        console.warn('[loadStore] timeout 8s — disparando storeHydrated forzado para no congelar boot');
        setStoreHydrated(true);
      }
    }, 8000);
    const safeSet = <T,>(setter: (v: T) => void, value: T, name: string) => {
      try { setter(value); } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[loadStore] setter ${name} threw:`, err);
      }
    };
    void loadStore()
      .then((stored) => {
        if (cancelled) return;
        if (stored) {
          if (stored.providers.length) safeSet(setProviders, stored.providers, 'providers');
          if (stored.clients.length) safeSet(setClients, stored.clients, 'clients');
          if (stored.confirmedPayments.length) safeSet(setConfirmedPayments, stored.confirmedPayments, 'confirmedPayments');
          if (stored.cxpRecords.length) safeSet(setCxpRecords, stored.cxpRecords, 'cxpRecords');
          if (stored.cxpLoadedCias) safeSet(setCxpLoadedCias, stored.cxpLoadedCias, 'cxpLoadedCias');
          if (stored.cobranzaRecords?.length) safeSet(setCobranzaRecords, stored.cobranzaRecords, 'cobranzaRecords');
          if (stored.cobranzaLoadedCias) safeSet(setCobranzaLoadedCias, stored.cobranzaLoadedCias, 'cobranzaLoadedCias');
          if (stored.cobranzaPayments?.length) safeSet(setCobranzaPayments, stored.cobranzaPayments, 'cobranzaPayments');
          if (stored.cobranzaPaymentsLoadedCias) safeSet(setCobranzaPaymentsLoadedCias, stored.cobranzaPaymentsLoadedCias, 'cobranzaPaymentsLoadedCias');
          if (stored.comprasRecords?.length) safeSet(setComprasRecords, stored.comprasRecords, 'comprasRecords');
          if (stored.comprasLoadedCias) safeSet(setComprasLoadedCias, stored.comprasLoadedCias, 'comprasLoadedCias');
          if (stored.pagoProveedorRecords?.length) safeSet(setPagoProveedorRecords, stored.pagoProveedorRecords, 'pagoProveedorRecords');
          if (stored.pagoProveedorLoadedCias) safeSet(setPagoProveedorLoadedCias, stored.pagoProveedorLoadedCias, 'pagoProveedorLoadedCias');
          if (stored.nominaRecords?.length) safeSet(setNominaRecords, stored.nominaRecords, 'nominaRecords');
          if (stored.nominaLoadedKeys) safeSet(setNominaLoadedKeys, stored.nominaLoadedKeys, 'nominaLoadedKeys');
          if (stored.cashFlowOverrides) safeSet(setCashFlowOverrides, stored.cashFlowOverrides, 'cashFlowOverrides');
          safeSet(setAssumptions, stored.assumptions, 'assumptions');
          // eslint-disable-next-line no-console
          console.info(`[loadStore] hidratado · cobranza=${stored.cobranzaRecords?.length ?? 0} · cxp=${stored.cxpRecords?.length ?? 0} · compras=${stored.comprasRecords?.length ?? 0} · pagoProv=${stored.pagoProveedorRecords?.length ?? 0} · nomina=${stored.nominaRecords?.length ?? 0} · companies=${stored.companies?.length ?? 0}`);
          // Hidratar companies desde cache antes de que JDE responda. Esto
          // desbloquea el splash inmediatamente (boot slot 'companies' = done)
          // y permite que CXP/Cobranza auto-fetch arranquen contra el catálogo
          // conocido sin esperar el /empresas en frío (~60s).
          if (stored.companies?.length) {
            companiesHydratedFromCacheRef.current = true;
            safeSet(setCompanies, stored.companies, 'companies');
            safeSet(setCompaniesLoadedAt, stored.companiesLoadedAt, 'companiesLoadedAt');
            setBootSlot('companies', 'done');
          }
        } else {
          // eslint-disable-next-line no-console
          console.info('[loadStore] sin datos previos · cold boot, todo se fetchea de JDE');
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[loadStore] falló:', err);
      })
      .finally(() => {
        window.clearTimeout(fallbackTimer);
        if (!cancelled) {
          setStoreHydrated(true);
        }
      });
    return () => {
      cancelled = true;
      window.clearTimeout(fallbackTimer);
    };
  }, []);

  // ── Auto-resolución total matcher cliente↔cobranza ──────────────────────
  // Regla de negocio (Santiago, 2026-05-12):
  //   • Match ≥70% confianza → adjuntar JDE link a cliente existente.
  //   • Resto → crear cliente nuevo. Si tiene <10 facturas YTD se manda al
  //     grupo "Viajes Especiales"; si ≥10 queda como cliente recurrente.
  //   • Cliente del cubo Viajes Especiales que brinca el umbral se promueve
  //     (sale del grupo) en la pasada siguiente.
  // No deja nada para revisar manual — el wizard queda como override.
  const matcherLastSig = useRef<string>('');
  useEffect(() => {
    if (clients.length === 0 || cobranzaRecords.length === 0) return;
    const accountKeys = new Set<string>();
    for (const r of cobranzaRecords) accountKeys.add(`${r.cia}::${r.noCliente}`);
    const sig = `${clients.length}|${accountKeys.size}|${cobranzaRecords.length}|${companies.length}`;
    if (sig === matcherLastSig.current) return;
    matcherLastSig.current = sig;

    // Blocklist intercompañía: nombres/RFCs de empresas nuestras (catálogo JDE
    // /empresas). Sirve para no contaminar el catálogo de clientes con cuentas
    // que en realidad son operaciones inter-cía.
    const intercoNameSet = new Set<string>();
    const intercoRfcSet = new Set<string>();
    for (const co of companies) {
      const n = normalizeCompanyName(co.nombre);
      if (n.length >= 4) intercoNameSet.add(n);
      const rfc = co.rfc?.toUpperCase().trim();
      if (rfc) intercoRfcSet.add(rfc);
    }
    const isInterco = (name: string | undefined, rfc: string | undefined): boolean => {
      if (rfc && intercoRfcSet.has(rfc.toUpperCase().trim())) return true;
      const norm = normalizeCompanyName(name);
      if (!norm) return false;
      for (const block of intercoNameSet) {
        if (norm === block) return true;
        if (norm.length >= 6 && block.length >= 6 && (norm.includes(block) || block.includes(norm))) return true;
      }
      return false;
    };

    const out = buildMatchSuggestions(clients, cobranzaRecords);

    const toAttach = [
      ...out.autoAccepted,
      ...out.needsReview.filter(s => s.confidence >= AUTO_MERGE_THRESHOLD),
    ].filter(s => !isInterco(s.nombreCliente, s.rfc));
    const toCreate: OrphanNoCliente[] = [
      ...out.orphanNoClientes,
      ...out.needsReview
        .filter(s => s.confidence < AUTO_MERGE_THRESHOLD)
        .map(s => ({
          cia: s.cia,
          noCliente: s.noCliente,
          nombreCliente: s.nombreCliente,
          rfc: s.rfc,
          invoiceCount: s.invoiceCount,
          bestGuess: s,
        } as OrphanNoCliente)),
    ].filter(o => !isInterco(o.nombreCliente, o.rfc));

    const attachByClient = new Map<string, ReturnType<typeof suggestionToLink>[]>();
    for (const s of toAttach) {
      const link = suggestionToLink(s, 'auto');
      const arr = attachByClient.get(s.clientId) ?? [];
      arr.push(link);
      attachByClient.set(s.clientId, arr);
    }

    // Calculamos el resultado completo aquí (sin setState updater) para que los
    // contadores reflejen lo que realmente se aplicó antes de loguear.
    let intercoRemoved = 0;
    const filtered = clients.filter(c => {
      if (isInterco(c.name, c.rfc) || isInterco(c.legalName, c.rfc)) {
        intercoRemoved++;
        return false;
      }
      return true;
    });
    const existingIds = new Set(filtered.map(c => c.id));

    // Retroactivo: re-clasifica clientes auto-* según la regla nueva por nombre.
    //   - persona física → Viajes Especiales
    //   - empresa        → grupo propio (limpia commercialGroupId/Name si caía
    //                      en Viajes; deja al grouping engine asignarle grupo).
    //   Respeta `manualGroupOverride === true` (movimientos del usuario).
    let reclassifiedOutOfViajes = 0;
    let reclassifiedIntoViajes = 0;
    const reconciled = filtered.map(c => {
      let updated = c;
      const additions = attachByClient.get(c.id);
      if (additions && additions.length > 0) {
        const existingKeys = new Set((updated.jdeAccounts ?? []).map(l => `${l.cia}::${l.noCliente}`));
        const fresh = additions.filter(l => !existingKeys.has(`${l.cia}::${l.noCliente}`));
        if (fresh.length > 0) {
          updated = { ...updated, jdeAccounts: [...(updated.jdeAccounts ?? []), ...fresh] };
        }
      } else if (updated.jdeAccounts === undefined) {
        updated = { ...updated, jdeAccounts: [] };
      }
      if (updated.id.startsWith('auto-') && updated.manualGroupOverride !== true) {
        const isInViajes = updated.commercialGroupId === VIAJES_ESPECIALES_GROUP_ID;
        const shouldBeViaje = isPersonName(updated.name);
        if (shouldBeViaje && !isInViajes) {
          reclassifiedIntoViajes++;
          updated = {
            ...updated,
            commercialGroupId: VIAJES_ESPECIALES_GROUP_ID,
            commercialGroupName: VIAJES_ESPECIALES_GROUP_NAME,
          };
        } else if (!shouldBeViaje && isInViajes) {
          reclassifiedOutOfViajes++;
          updated = { ...updated, commercialGroupId: undefined, commercialGroupName: undefined };
        }
      }
      return updated;
    });

    // Para orphans empresa: intenta colgarlos de un cliente similar (catálogo
    // o auto-*) antes de crear; si no hay match → cliente individual.
    // Para orphans persona: directo a Viajes Especiales.
    const extraAttach = new Map<string, ReturnType<typeof suggestionToLink>[]>();
    let createdRecurrentes = 0;
    let createdViajes = 0;
    let attachedByFallback = 0;
    const created: Client[] = [];
    for (const o of toCreate) {
      const id = `auto-${o.cia}-${o.noCliente}`;
      if (existingIds.has(id)) continue;
      const goesToViajes = isPersonName(o.nombreCliente);

      // Empresas: intenta colgarlas de un cliente existente parecido (fallback)
      if (!goesToViajes) {
        const ranked = rankClientsForAccount(
          { cia: o.cia, noCliente: o.noCliente, nombreCliente: o.nombreCliente, rfc: o.rfc, invoiceCount: o.invoiceCount },
          reconciled,
          1,
        );
        const top = ranked[0];
        if (top && top.confidence >= FALLBACK_GROUP_THRESHOLD) {
          const link = suggestionToLink(
            { ...top, cia: o.cia, noCliente: o.noCliente, nombreCliente: o.nombreCliente, rfc: o.rfc, invoiceCount: o.invoiceCount },
            'auto',
          );
          const arr = extraAttach.get(top.clientId) ?? [];
          arr.push(link);
          extraAttach.set(top.clientId, arr);
          attachedByFallback++;
          continue;
        }
      }

      if (goesToViajes) createdViajes++; else createdRecurrentes++;
      created.push({
        id,
        name: o.nombreCliente,
        rfc: o.rfc,
        monthlyBilling: new Array(12).fill(0),
        frequency: 'Mensual',
        creditDays: 30,
        paymentDay: { kind: 'ANY' },
        commercialGroupName: goesToViajes ? VIAJES_ESPECIALES_GROUP_NAME : undefined,
        commercialGroupId: goesToViajes ? VIAJES_ESPECIALES_GROUP_ID : undefined,
        jdeAccounts: [{
          cia: o.cia,
          noCliente: o.noCliente,
          nombreCliente: o.nombreCliente,
          rfc: o.rfc,
          matchedAt: new Date().toISOString(),
          matchedBy: 'auto',
          confidence: o.bestGuess?.confidence,
          tier: o.bestGuess?.tier,
        }],
      });
    }

    // Aplica los extraAttach del fallback sobre reconciled.
    const reconciledWithExtras = extraAttach.size === 0
      ? reconciled
      : reconciled.map(c => {
          const extras = extraAttach.get(c.id);
          if (!extras || extras.length === 0) return c;
          const existingKeys = new Set((c.jdeAccounts ?? []).map(l => `${l.cia}::${l.noCliente}`));
          const fresh = extras.filter(l => !existingKeys.has(`${l.cia}::${l.noCliente}`));
          if (fresh.length === 0) return c;
          return { ...c, jdeAccounts: [...(c.jdeAccounts ?? []), ...fresh] };
        });

    const totalChanged =
      intercoRemoved > 0 ||
      reclassifiedIntoViajes > 0 ||
      reclassifiedOutOfViajes > 0 ||
      created.length > 0 ||
      toAttach.length > 0 ||
      attachedByFallback > 0;
    if (totalChanged) {
      setClients(created.length > 0 ? [...reconciledWithExtras, ...created] : reconciledWithExtras);
    }
    // Todo resuelto → wizard queda vacío (sirve solo como override manual).
    setMatcherReview({ autoAccepted: [], needsReview: [], orphanNoClientes: [] });
    // eslint-disable-next-line no-console
    console.info(
      `[matcher] auto-resolve: ${toAttach.length} adjuntos · ${attachedByFallback} fallback adj · ${createdRecurrentes} cli. nuevos · ${createdViajes} viajes · ${reclassifiedIntoViajes} →viajes · ${reclassifiedOutOfViajes} ←viajes · ${intercoRemoved} interco quitados`,
    );
  }, [clients, cobranzaRecords, companies]);

  // Auto-actualiza `creditDays` por cliente con el lag observado de pagos
  // reales (fechaCobro - fechaFactura). El cliente queda igual cuando no hay
  // facturas pagadas o el promedio coincide con el valor previo.
  useEffect(() => {
    if (cobranzaRecords.length === 0) return;
    setClients(prev => recomputeClientCreditDaysFromCobranza(prev, cobranzaRecords));
  }, [cobranzaRecords]);

  // Catalog bootstrap tracking — splash waits for both bundled CSVs to settle.
  const [clientsCatalogDone, setClientsCatalogDone] = useState(false);
  const [clientsCatalogError, setClientsCatalogError] = useState(false);
  const [providersCatalogDone, setProvidersCatalogDone] = useState(false);
  const [providersCatalogError, setProvidersCatalogError] = useState(false);
  useEffect(() => {
    if (clientsCatalogDone && providersCatalogDone) {
      setCatalogLoaded(true);
      const bothFailed = clientsCatalogError && providersCatalogError;
      setBootSlot('catalog', bothFailed ? 'error' : 'done');
    }
  }, [clientsCatalogDone, providersCatalogDone, clientsCatalogError, providersCatalogError, setBootSlot]);

  // Load clients from catalog if no clients exist yet
  useEffect(() => {
    if (catalogLoaded || clients.length > 0) {
      setClientsCatalogDone(true);
      return;
    }
    fetchClientCatalog()
      .then(loaded => {
        if (loaded.length > 0) {
          setClients(loaded);
          setCatalogLoaded(true);
        }
      })
      .catch(() => { setClientsCatalogError(true); })
      .finally(() => setClientsCatalogDone(true));
  }, [catalogLoaded, clients.length]);

  // Load/merge providers from the bundled catalog. The local catalog includes
  // Romo's provider type classification plus flexibility/DTI metadata.
  const providerCatalogMerged = useRef(false);
  useEffect(() => {
    if (providerCatalogMerged.current) return;
    providerCatalogMerged.current = true;
    fetchProviderCatalog()
      .then((loaded) => {
      if (loaded.length === 0) return;
      setProviders((current) => {
        if (current.length === 0) return loaded;

        const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toUpperCase();

        // Remove catalog-sourced providers that no longer exist in the updated
        // catalog (e.g. unclassified providers that were purged from the catalog).
        const catalogNames = new Set(loaded.map(p => normalize(p.name)));
        const filtered = current.filter(
          p => !p.id.startsWith('catalog-prov-') || catalogNames.has(normalize(p.name))
        );

        const filteredByName = new Map(filtered.map((provider, index) => [normalize(provider.name), { provider, index }]));
        const merged = [...filtered];
        let changed = filtered.length !== current.length;

        for (const catalogProvider of loaded) {
          const existing = filteredByName.get(normalize(catalogProvider.name));
          if (!existing) {
            merged.push(catalogProvider);
            changed = true;
            continue;
          }

          const currentType = existing.provider.type?.trim();
          const catalogType = catalogProvider.type?.trim();
          const isCatalogManaged = existing.provider.id.startsWith('catalog-prov-');
          const nextProvider = {
            ...existing.provider,
            type: (isCatalogManaged || !currentType || currentType === 'Otro' || currentType === 'Sin clasificar') && catalogType
              ? catalogType
              : existing.provider.type,
            risk: catalogProvider.risk,
            riskComment: catalogProvider.riskComment,
            paymentPeriod: catalogProvider.paymentPeriod,
            flexibility: catalogProvider.flexibility,
            flexibilityComment: catalogProvider.flexibilityComment,
            creditLimit: catalogProvider.creditLimit ?? existing.provider.creditLimit,
            lastUpdatedAt: catalogProvider.lastUpdatedAt,
            dtiArea: catalogProvider.dtiArea ?? existing.provider.dtiArea,
            dtiCriticidad: catalogProvider.dtiCriticidad ?? existing.provider.dtiCriticidad,
            clasificacionAlberto: catalogProvider.clasificacionAlberto,
            clasificacionAlbertoRaw: catalogProvider.clasificacionAlbertoRaw,
            clasificacionAutomatica: catalogProvider.clasificacionAutomatica,
            score: catalogProvider.score,
            scoreCriterios: catalogProvider.scoreCriterios,
            numProveedorJDE: catalogProvider.numProveedorJDE ?? existing.provider.numProveedorJDE,
            frecuenciaHistorica: catalogProvider.frecuenciaHistorica,
            montoPromedioPago: catalogProvider.montoPromedioPago,
            numPagos2025: catalogProvider.numPagos2025,
            montoTotal2025: catalogProvider.montoTotal2025,
            gastoMinimoMensual: catalogProvider.gastoMinimoMensual,
          };

          if (JSON.stringify(nextProvider) !== JSON.stringify(existing.provider)) {
            merged[existing.index] = nextProvider;
            changed = true;
          }
        }

        return changed ? merged : current;
      });
    })
      .catch(() => { setProvidersCatalogError(true); })
      .finally(() => setProvidersCatalogDone(true));
  }, []);

  // Save state changes — strategy v2 (post Page-Unresponsive fix):
  //
  // ANTES: una sola useEffect con TODOS los heavies como deps. Cada cambio
  // en cualquiera (cobranza, compras, nómina, etc.) disparaba saveStore que
  // reserializa TODOS los heavies a IDB. Compras=334k records × clone IDB
  // por cada save = main thread bloqueado segundos durante el storm de boot
  // → Chrome muestra "Page Unresponsive".
  //
  // AHORA: split en effects por-tipo:
  //   - Light effect (providers, clients, assumptions, etc.) → solo localStorage,
  //     fast porque payload chico.
  //   - Per-heavy effects (uno por key) → solo escribe SU heavy a IDB cuando
  //     ESE heavy cambió. No re-serializa los otros.
  //
  // latestStoreRef sigue siendo el snapshot completo para el flush en
  // beforeunload (caso edge: usuario cierra antes que dispare debounce).
  const latestStoreRef = useRef<MidasStore | null>(null);
  useEffect(() => {
    latestStoreRef.current = {
      providers, clients,
      assumptions, confirmedPayments, cxpRecords, cxpLoadedCias,
      cobranzaRecords, cobranzaLoadedCias,
      cobranzaPayments, cobranzaPaymentsLoadedCias,
      comprasRecords, comprasLoadedCias,
      pagoProveedorRecords, pagoProveedorLoadedCias,
      companies, companiesLoadedAt,
      nominaRecords, nominaLoadedKeys,
      cashFlowOverrides,
      lastSaved: new Date().toISOString(),
    };
  });

  // Light save: localStorage only. Deps son solo light fields → no re-fires
  // por cambios en heavies.
  useEffect(() => {
    if (latestStoreRef.current === null) return;
    const snapshot = latestStoreRef.current;
    let cancelIdle: (() => void) | null = null;
    const timer = window.setTimeout(() => {
      cancelIdle = scheduleIdleTask(() => saveLightStore(snapshot), 2500);
    }, STORE_SAVE_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      cancelIdle?.();
    };
  }, [
    providers, clients, assumptions, confirmedPayments,
    cxpLoadedCias, cobranzaLoadedCias, cobranzaPaymentsLoadedCias,
    comprasLoadedCias, pagoProveedorLoadedCias,
    companies, companiesLoadedAt, nominaLoadedKeys, cashFlowOverrides,
  ]);

  // Per-heavy saves: cada uno solo dispara cuando su key cambia. saveHeavyRecords
  // hace UN solo put de UN solo array, no re-serializa los 6.
  const useHeavySaver = (key: HeavyKey, records: unknown[]) => {
    useEffect(() => {
      let cancelIdle: (() => void) | null = null;
      const timer = window.setTimeout(() => {
        cancelIdle = scheduleIdleTask(() => {
          // Anti-wipe: skip si records vacío (state probablemente en tránsito
          // durante boot, no queremos pisar IDB existente).
          if (records.length === 0) return;
          void saveHeavyRecords(key, records);
        }, 2500);
      }, STORE_SAVE_DEBOUNCE_MS);
      return () => {
        window.clearTimeout(timer);
        cancelIdle?.();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [records]);
  };
  useHeavySaver('cxpRecords', cxpRecords);
  useHeavySaver('cobranzaRecords', cobranzaRecords);
  useHeavySaver('cobranzaPayments', cobranzaPayments);
  useHeavySaver('comprasRecords', comprasRecords);
  useHeavySaver('pagoProveedorRecords', pagoProveedorRecords);
  useHeavySaver('nominaRecords', nominaRecords);

  useEffect(() => {
    const flush = () => {
      if (latestStoreRef.current) saveStore(latestStoreRef.current);
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  // ── JDE: load companies on mount (sin fallback demo) ──
  // Si el cache local ya hidrató la lista, el boot slot ya está en 'done' y
  // el fetch a JDE corre en background sin volver a bloquear el splash.
  // Errores en ese caso se reflejan en `companiesError` pero no degradan el
  // slot — el usuario ya está dentro de la app.
  const loadCompanies = useCallback(async () => {
    setCompaniesLoading(true);
    setCompaniesError(null);
    const hadCache = companiesHydratedFromCacheRef.current;
    if (!hadCache) setBootSlot('companies', 'loading');
    try {
      const list = await fetchCompanies();
      if (list.length === 0) {
        setCompaniesError('JDE respondió vacío. Revisa conectividad con srv-desarrollo.');
        if (!hadCache) {
          setCompanies([]);
          setBootSlot('companies', 'error');
        }
      } else {
        setCompanies(list);
        setCompaniesLoadedAt(new Date().toISOString());
        setBootSlot('companies', 'done');
      }
    } catch (e) {
      setCompaniesError(e instanceof Error ? e.message : 'No se pudo contactar JDE.');
      if (!hadCache) {
        setCompanies([]);
        setBootSlot('companies', 'error');
      }
    } finally {
      setCompaniesLoading(false);
    }
  }, [setBootSlot]);

  useEffect(() => { loadCompanies(); }, [loadCompanies]);

  // ── Boot orchestrator ──
  // Artifact renders only when every boot task (catalog, companies, banks, CXP,
  // cobranza) has settled (done or error). All five run in parallel; per-cía
  // fetches (CXP, cobranza) use bounded concurrency to respect JDE rate limits
  // without serializing every request.
  const bootTasks = useMemo<BootTask[]>(
    () => [
      { id: 'catalog', label: 'Catálogos · clientes y proveedores', status: bootStatus.catalog },
      { id: 'companies', label: 'JDE · empresas', status: bootStatus.companies },
      { id: 'banks', label: 'Bancos · estado reciente', status: bootStatus.banks, progress: bankFetchProgress },
      { id: 'cxp', label: 'CXP · antigüedad de saldos', status: bootStatus.cxp, progress: cxpBootProgress },
      { id: 'cobranza', label: 'Cobranza · cartera y pagos', status: bootStatus.cobranza, progress: cobranzaBootProgress },
      { id: 'nomina', label: 'Nómina · TRESS mes en curso', status: bootStatus.nomina },
    ],
    [bootStatus, bankFetchProgress, cxpBootProgress, cobranzaBootProgress],
  );
  useEffect(() => {
    if (isBooted) return;
    const allSettled = bootTasks.every(t => t.status === 'done' || t.status === 'error');
    if (allSettled) {
      const t = setTimeout(() => setIsBooted(true), 240);
      return () => clearTimeout(t);
    }
  }, [bootTasks, isBooted]);

  // Hard timeout — never trap the user behind the splash si JDE cuelga. 4 min
  // basta para CXP + Cobranza paralelas; pasado eso, asumimos que algo está
  // mal aguas arriba y renderizamos con lo que tengamos.
  useEffect(() => {
    const t = setTimeout(() => setIsBooted(true), 240000);
    return () => clearTimeout(t);
  }, []);

  // Unmount splash after fade-out.
  useEffect(() => {
    if (!isBooted) return;
    const t = setTimeout(() => setSplashMounted(false), 280);
    return () => clearTimeout(t);
  }, [isBooted]);

  // Pre-warm the projection / planning source cache once boot data is in.
  // The canonical projection (clients × months × CXP) is the single most
  // expensive thing those dashboards do. Building it during idle time after
  // boot means the first navigation into Proyección or Planeación gets a
  // cache hit for the source layer — saves ~250ms of main-thread work and
  // (more importantly) means the warmup shell doesn't need to wait for the
  // canonical pass to finish before mounting the inner dashboard.
  //
  // Wait longer (3 s) and yield before compute so the warmup is genuinely
  // backgrounded — earlier versions fired ~1.5 s after boot and could
  // collide with the user's first dashboard interaction, locking the main
  // thread mid-click.
  useEffect(() => {
    if (!isBooted) return;
    const idleWindow = window as IdleWindow;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      const channel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
      const fire = () => {
        if (cancelled) return;
        try {
          buildFinancialProjectionSourceData({
            companyCode: selectedCia,
            bankStatements: accountableBankStatements,
            clients,
            providers,
            cxpRecords,
            cobranzaRecords,
            cobranzaReconciliation,
            paidCxpKeys,
            cargoEnrichments: paymentReconciliation.cargoEnrichments,
            // Planning pasa purchaseReceipts + payrollCosts; el prewarm DEBE
            // incluirlos para que el cache key empate (refId() los suma). Sin
            // esto, planning entra en cache miss, rebuildea canonical sync en
            // idle y congela el primer frame del módulo.
            purchaseReceipts: purchaseReceiptsFromCompras,
            payrollCosts: nominaRecords,
            assumptions,
            budget: null,
            startingBalance: effectiveStartingBalance,
          });
        } catch {
          /* pre-warm is best-effort — never block the user on a cache miss */
        }
      };
      if (channel) {
        channel.port1.onmessage = () => { channel.port1.close(); fire(); };
        channel.port2.postMessage(null);
      } else {
        window.setTimeout(fire, 0);
      }
    };
    let idleHandle: number | null = null;
    const debounceId = window.setTimeout(() => {
      if (cancelled) return;
      if (idleWindow.requestIdleCallback) {
        idleHandle = idleWindow.requestIdleCallback(run, { timeout: 3000 });
      } else {
        idleHandle = window.setTimeout(run, 0);
      }
    }, 3000);
    return () => {
      cancelled = true;
      window.clearTimeout(debounceId);
      if (idleHandle !== null) {
        if (idleWindow.cancelIdleCallback) idleWindow.cancelIdleCallback(idleHandle);
        else window.clearTimeout(idleHandle);
      }
    };
  }, [
    isBooted,
    selectedCia,
    accountableBankStatements,
    clients,
    providers,
    cxpRecords,
    cobranzaRecords,
    cobranzaReconciliation,
    paidCxpKeys,
    paymentReconciliation,
    purchaseReceiptsFromCompras,
    nominaRecords,
    assumptions,
    effectiveStartingBalance,
  ]);

  // ── Auto-load CXP (antigüedad de saldos) durante el boot ──
  // Concurrencia limitada a 3 — JDE revienta con paralelismo total contra
  // /antiguedadsaldos, pero 3 paralelas es estable y reduce el tiempo total
  // a ~1/3 vs la versión secuencial anterior.
  const cxpAutoFetchDone = useRef(false);
  useEffect(() => {
    if (cxpAutoFetchDone.current) return;
    if (!storeHydrated) return;
    if (companies.length === 0) return;
    const activeCias = companies.filter(c => c.activa !== false).map(c => c.cia);
    if (activeCias.length === 0) {
      cxpAutoFetchDone.current = true;
      setBootSlot('cxp', 'done');
      return;
    }
    const ciasToFetch = activeCias.filter(cia => !isFreshTimestamp(cxpLoadedCias[cia], CXP_AUTO_REFRESH_TTL_MS));
    // eslint-disable-next-line no-console
    console.info(`[cxp] boot sync · ${ciasToFetch.length}/${activeCias.length} cías necesitan refresh (TTL ${Math.round(CXP_AUTO_REFRESH_TTL_MS / 3600000)}h) · hydratedRecords=${cxpRecords.length}`);
    if (ciasToFetch.length === 0) {
      cxpAutoFetchDone.current = true;
      setBootSlot('cxp', 'done');
      return;
    }
    cxpAutoFetchDone.current = true;
    setBootSlot('cxp', 'loading');
    setCxpBootProgress({ done: 0, total: ciasToFetch.length });
    // Sin `cancelled` mid-flight: en StrictMode el cleanup dispara antes de
    // que JDE responda y matar los workers ahí deja CXP atorado en 0/N para
    // siempre. El ref `cxpAutoFetchDone` ya evita re-entrada al re-mount.
    (async () => {
      const fetchedRecords: CXPRecord[] = [];
      const fetchedCias: string[] = [];
      const fetchedTimestamps: Record<string, string> = {};
      let errors = 0;
      let completed = 0;
      let cursor = 0;
      const concurrency = Math.min(3, ciasToFetch.length);
      const worker = async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= ciasToFetch.length) return;
          const cia = ciasToFetch[idx];
          try {
            const data = await fetchAgedBalances({ cia });
            const stamped = (data as CXPRecord[]).map(r => ({ ...r, cia }));
            fetchedRecords.push(...stamped);
            fetchedCias.push(cia);
            fetchedTimestamps[cia] = new Date().toISOString();
          } catch {
            errors += 1;
          } finally {
            completed += 1;
            setCxpBootProgress({ done: completed, total: ciasToFetch.length });
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      if (fetchedCias.length > 0) {
        const fetchedSet = new Set(fetchedCias);
        setCxpRecords(prev => [...prev.filter(r => !fetchedSet.has(r.cia)), ...fetchedRecords]);
        setCxpLoadedCias(prev => ({ ...prev, ...fetchedTimestamps }));
      }
      setBootSlot('cxp', errors === ciasToFetch.length ? 'error' : 'done');
    })();
  }, [storeHydrated, companies, cxpLoadedCias, setBootSlot]);

  // ── Auto-load Compras (Órdenes de Compra) durante el boot ──
  // Endpoint global (no por cia, no listado en /empresas). Cargamos los últimos
  // COMPRAS_LOOKBACK_DAYS hacia atrás + 3 meses a futuro vía fetchComprasRange. No
  // bloquea el splash — corre en segundo plano una vez que companies cargó
  // (para reusar el mismo signal de "boot avanzado").
  const comprasAutoFetchDone = useRef(false);
  useEffect(() => {
    if (comprasAutoFetchDone.current) return;
    if (!storeHydrated) return;
    if (companies.length === 0) return;
    if (isFreshTimestamp(comprasLoadedCias[COMPRAS_CACHE_KEY], COMPRAS_AUTO_REFRESH_TTL_MS)) {
      comprasAutoFetchDone.current = true;
      return;
    }
    comprasAutoFetchDone.current = true;
    const today = new Date();
    const fechaFinal = addMonthsIso(today, COMPRAS_FUTURE_LOOKAHEAD_MONTHS);
    const lookback = new Date(today);
    lookback.setUTCDate(lookback.getUTCDate() - COMPRAS_LOOKBACK_DAYS);
    const lookbackStart = lookback.toISOString().slice(0, 10);
    (async () => {
      try {
        // Delta sync: primero revisamos qué tenemos en IDB. Si el último día
        // cacheado es reciente y el store ya hidrató registros, sólo pedimos
        // a JDE desde (maxCached+1) hasta hoy. Sin cache o store vacío → full
        // backfill (lookback completo). El cache diario por día sirve días
        // pasados sin tocar la red en cualquier caso, pero el delta también
        // evita iterar 730 días para confirmar cache hits.
        await primeDailyCache();
        const maxCached = getMaxCachedDay('compras');
        const hasHydratedRecords = comprasRecords.length > 0;
        const candidateFrom = maxCached ? nextIsoDay(maxCached) : lookbackStart;
        const fechaInicial = (hasHydratedRecords && maxCached && candidateFrom >= lookbackStart)
          ? candidateFrom
          : lookbackStart;
        // eslint-disable-next-line no-console
        console.info(`[compras] boot sync · maxCachedIDB=${maxCached ?? 'none'} · hydratedState=${comprasRecords.length} · fetch ${fechaInicial}→${fechaFinal} (${fechaInicial === lookbackStart ? 'FULL' : 'DELTA'})`);

        if (fechaInicial > fechaFinal) {
          // Nada que sincronizar: el cache ya cubre hasta hoy.
          // eslint-disable-next-line no-console
          console.info('[compras] boot sync · nada nuevo, cache cubre hasta hoy');
          setComprasLoadedCias({ [COMPRAS_CACHE_KEY]: new Date().toISOString() });
          return;
        }

        const fetched = await fetchComprasRange(fechaInicial, fechaFinal, { concurrency: 2 });
        if (fetched.length > 0) {
          // Siempre merge — nunca reemplazar. Si loadStore.then() hidrató
          // registros viejos (fuera de la ventana de lookback actual) durante
          // el fetch, no los queremos perder. La ventana solo determina QUÉ
          // se pide a JDE, no qué se conserva en state.
          setComprasRecords(prev => {
            const map = new Map<string, ComprasRecord>();
            for (const r of prev) map.set(`${r.cia}::${r.noOrden}::${r.lineaOrden}`, r);
            for (const r of fetched) map.set(`${r.cia}::${r.noOrden}::${r.lineaOrden}`, r);
            return Array.from(map.values());
          });
        }
        setComprasLoadedCias({ [COMPRAS_CACHE_KEY]: new Date().toISOString() });
      } catch (err) {
        // Reset the guard so el usuario puede reintentar manualmente desde la
        // pestaña Compras sin reload. Loggeamos para que la falla no quede
        // muda — el silencio anterior dejaba "no muestra nada" sin pista.
        comprasAutoFetchDone.current = false;
        console.error('[compras] auto-fetch falló', err);
      }
    })();
  }, [storeHydrated, companies, comprasLoadedCias, comprasRecords.length]);

  // ── Auto-load PagoProveedor durante el boot ──
  // Endpoint global (no filtra por cia, igual que /compras). Cargamos los
  // últimos 2 años — mismo lookback histórico que compras, para que la ventana de
  // conciliación pagos↔CXP↔banco sea coherente. Reusa COMPRAS_* constants:
  // el endpoint tiene la misma forma de cache + TTL.
  const pagoProveedorAutoFetchDone = useRef(false);
  useEffect(() => {
    if (pagoProveedorAutoFetchDone.current) return;
    if (!storeHydrated) return;
    if (companies.length === 0) return;
    if (isFreshTimestamp(pagoProveedorLoadedCias[COMPRAS_CACHE_KEY], COMPRAS_AUTO_REFRESH_TTL_MS)) {
      pagoProveedorAutoFetchDone.current = true;
      return;
    }
    pagoProveedorAutoFetchDone.current = true;
    const today = new Date();
    const fechaFinal = today.toISOString().slice(0, 10);
    const lookback = new Date(today);
    lookback.setUTCDate(lookback.getUTCDate() - COMPRAS_LOOKBACK_DAYS);
    const lookbackStart = lookback.toISOString().slice(0, 10);
    (async () => {
      try {
        // Delta sync — mismo patrón que Compras. Ver comentario allá.
        await primeDailyCache();
        const maxCached = getMaxCachedDay('pagoproveedor');
        const hasHydratedRecords = pagoProveedorRecords.length > 0;
        const candidateFrom = maxCached ? nextIsoDay(maxCached) : lookbackStart;
        const fechaInicial = (hasHydratedRecords && maxCached && candidateFrom >= lookbackStart)
          ? candidateFrom
          : lookbackStart;
        // eslint-disable-next-line no-console
        console.info(`[pagoproveedor] boot sync · maxCachedIDB=${maxCached ?? 'none'} · hydratedState=${pagoProveedorRecords.length} · fetch ${fechaInicial}→${fechaFinal} (${fechaInicial === lookbackStart ? 'FULL' : 'DELTA'})`);

        if (fechaInicial > fechaFinal) {
          // eslint-disable-next-line no-console
          console.info('[pagoproveedor] boot sync · nada nuevo, cache cubre hasta hoy');
          setPagoProveedorLoadedCias({ [COMPRAS_CACHE_KEY]: new Date().toISOString() });
          return;
        }

        const fetched = await fetchPagoProveedorRange(fechaInicial, fechaFinal, { concurrency: 2 });
        if (fetched.length > 0) {
          // Siempre merge para preservar historia hidratada desde el store.
          setPagoProveedorRecords(prev => {
            const map = new Map<string, PagoProveedorRecord>();
            for (const r of prev) map.set(`${r.cia}::${r.noPago}`, r);
            for (const r of fetched) map.set(`${r.cia}::${r.noPago}`, r);
            return Array.from(map.values());
          });
        }
        setPagoProveedorLoadedCias({ [COMPRAS_CACHE_KEY]: new Date().toISOString() });
      } catch (err) {
        pagoProveedorAutoFetchDone.current = false;
        console.error('[pagoproveedor] auto-fetch falló', err);
      }
    })();
  }, [storeHydrated, companies, pagoProveedorLoadedCias, pagoProveedorRecords.length]);

  // ── Cargador unificado de Cobranza (CXC) ───────────────────────────────
  // Endpoint: POST /JDEdwards/cobranza (productivo desde 2026-05-01).
  //
  // Concurrencia: 3 cías en paralelo, y dentro de cada cía /cobranza y
  // /cobranzaindicadores corren en paralelo. Mandar todas las cías juntas
  // (ciasToFetch.join(',')) sigue rompiendo el upstream con
  // InternalServerErrorException; lo que JDE tolera es una llamada por cía
  // con concurrencia acotada.
  const refreshCobranza = useCallback(
    async (force = true, progressSlot?: 'cobranza') => {
      if (companies.length === 0) {
        setCobranzaError('No hay compañías cargadas todavía. Espera a que /empresas responda.');
        return;
      }
      const activeCias = companies.filter(c => c.activa !== false).map(c => c.cia);
      if (activeCias.length === 0) {
        setCobranzaError('No hay compañías activas en el catálogo.');
        return;
      }
      const ciasToFetch = force
        ? activeCias
        : activeCias.filter(cia =>
          !isFreshTimestamp(cobranzaLoadedCias[cia], COBRANZA_AUTO_REFRESH_TTL_MS)
          || !isFreshTimestamp(cobranzaPaymentsLoadedCias[cia], COBRANZA_AUTO_REFRESH_TTL_MS)
        );
      // eslint-disable-next-line no-console
      console.info(`[cobranza] sync · ${ciasToFetch.length}/${activeCias.length} cías necesitan refresh (force=${force}, TTL ${Math.round(COBRANZA_AUTO_REFRESH_TTL_MS / 3600000)}h) · hydratedRecords=${cobranzaRecords.length}`);
      if (ciasToFetch.length === 0) return;

      setCobranzaRefreshing(true);
      setCobranzaError(null);
      if (progressSlot === 'cobranza') {
        setCobranzaBootProgress({ done: 0, total: ciasToFetch.length });
      }

      const today = new Date();
      const fechaFinal = today.toISOString().slice(0, 10);
      // 2 años de historia para alimentar modelos predictivos estacionales
      // (Holt-Winters requiere ≥24 meses para detectar pauta anual).
      const twoYearsAgo = new Date(today);
      twoYearsAgo.setUTCDate(twoYearsAgo.getUTCDate() - 730);
      const fechaInicial = twoYearsAgo.toISOString().slice(0, 10);

      const errors: string[] = [];
      let totalRecords = 0;
      const fetchedRecords: CobranzaRecord[] = [];
      const fetchedCias: string[] = [];
      const fetchedTimestamps: Record<string, string> = {};
      const fetchedPayments: CobranzaPayment[] = [];
      const fetchedPaymentCias: string[] = [];
      const fetchedPaymentTimestamps: Record<string, string> = {};

      let completed = 0;
      let cursor = 0;
      const concurrency = Math.min(3, ciasToFetch.length);
      const worker = async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= ciasToFetch.length) return;
          const cia = ciasToFetch[idx];
          const [recordsResult, paymentsResult] = await Promise.allSettled([
            fetchCobranzaRange(cia, fechaInicial, fechaFinal, { concurrency: 4 }),
            fetchIndicadoresCobranzaRange(cia, fechaInicial, fechaFinal, { concurrency: 4 }),
          ]);
          if (recordsResult.status === 'fulfilled') {
            const stamped = recordsResult.value.map(r => ({ ...r, cia: r.cia || cia }));
            fetchedRecords.push(...stamped);
            fetchedCias.push(cia);
            fetchedTimestamps[cia] = new Date().toISOString();
            totalRecords += stamped.length;
          } else {
            const msg = recordsResult.reason instanceof Error ? recordsResult.reason.message : String(recordsResult.reason);
            errors.push(`${cia}: ${msg}`);
          }
          if (paymentsResult.status === 'fulfilled') {
            fetchedPayments.push(...paymentsResult.value);
            fetchedPaymentCias.push(cia);
            fetchedPaymentTimestamps[cia] = new Date().toISOString();
          } else {
            const msg = paymentsResult.reason instanceof Error ? paymentsResult.reason.message : String(paymentsResult.reason);
            errors.push(`indicadores ${cia}: ${msg}`);
          }
          completed += 1;
          if (progressSlot === 'cobranza') {
            setCobranzaBootProgress({ done: completed, total: ciasToFetch.length });
          }
        }
      };

      try {
        await Promise.all(Array.from({ length: concurrency }, worker));

        if (fetchedPaymentCias.length > 0) {
          const fetchedSet = new Set(fetchedPaymentCias);
          setCobranzaPayments(prev => [
            ...prev.filter(p => !fetchedSet.has(p.cia)),
            ...fetchedPayments,
          ]);
          setCobranzaPaymentsLoadedCias(prev => ({
            ...prev,
            ...fetchedPaymentTimestamps,
          }));
        }

        if (fetchedCias.length > 0) {
          const fetchedSet = new Set(fetchedCias);
          setCobranzaRecords(prev => [
            ...prev.filter(r => !fetchedSet.has(r.cia)),
            ...fetchedRecords,
          ]);
          setCobranzaLoadedCias(prev => ({ ...prev, ...fetchedTimestamps }));
        }

        if (errors.length > 0) {
          setCobranzaError(`Errores en ${errors.length}/${ciasToFetch.length} cías: ${errors.slice(0, 2).join('; ')}${errors.length > 2 ? '…' : ''}`);
        } else if (totalRecords === 0) {
          setCobranzaError(`Todas las ${ciasToFetch.length} cías consultadas respondieron VACÍO. Revisa el token productivo y permisos JDE para /cobranza. (Detalles en consola con prefix [cobranza].)`);
        }
        return {
          totalRecords,
          failedCias: errors.length,
          totalCias: ciasToFetch.length,
        };
      } finally {
        setCobranzaRefreshing(false);
      }
    },
    [companies, cobranzaLoadedCias, cobranzaPaymentsLoadedCias],
  );

  // Cobranza ya forma parte de la ruta crítica del boot — no esperamos a que
  // el usuario abra el tab de Cobranza, lo jalamos en paralelo con CXP.
  const cobranzaAutoFetchDone = useRef(false);
  useEffect(() => {
    if (cobranzaAutoFetchDone.current) return;
    if (!storeHydrated) return;
    if (companies.length === 0) return;
    const activeCias = companies.filter(c => c.activa !== false);
    if (activeCias.length === 0) {
      cobranzaAutoFetchDone.current = true;
      setBootSlot('cobranza', 'done');
      return;
    }
    cobranzaAutoFetchDone.current = true;
    setBootSlot('cobranza', 'loading');
    (async () => {
      try {
        const summary = await refreshCobranza(false, 'cobranza');
        if (!summary) {
          setBootSlot('cobranza', 'done');
          return;
        }
        const allFailed = summary.failedCias >= summary.totalCias * 2;
        setBootSlot('cobranza', allFailed ? 'error' : 'done');
      } catch {
        setBootSlot('cobranza', 'error');
      }
    })();
  }, [storeHydrated, companies, refreshCobranza, setBootSlot]);

  // Si JDE no devuelve compañías (companies en error), CXP y cobranza nunca
  // se dispararon — marcamos los slots como error para destrabar el boot.
  useEffect(() => {
    if (bootStatus.companies !== 'error') return;
    if (bootStatus.cxp === 'pending') setBootSlot('cxp', 'error');
    if (bootStatus.cobranza === 'pending') setBootSlot('cobranza', 'error');
    if (bootStatus.nomina === 'pending') setBootSlot('nomina', 'error');
  }, [bootStatus.companies, bootStatus.cxp, bootStatus.cobranza, bootStatus.nomina, setBootSlot]);

  // ── Nómina (TRESS): boot fetch del mes en curso ──
  // 1 request con `idEmpresa=99, tipoNomina=99` cubre todas las cías y ambos
  // tipos de nómina. Más barato que iterar por cía (a diferencia de CXP /
  // cobranza). Si la llave de cache ya está fresca, skip silencioso. El error
  // no bloquea el boot — el módulo de Nómina permite refrescar manualmente.
  //
  // Ref guard `nominaBootDone` evita doble ejecución por StrictMode (dev) o
  // por cambios subsecuentes en companies (fetch JDE → store hydrate, etc.).
  // Sin guard, dos fetch loops concurrentes interfieren: la última respuesta
  // de TRESS reemplaza fingerprints, haciendo oscilar el conteo de records
  // (11189 → 14437 → 13879 → 11189) y persistiendo el snapshot equivocado.
  const nominaBootDone = useRef(false);
  useEffect(() => {
    if (nominaBootDone.current) return;
    if (!storeHydrated) return;
    if (companies.length === 0) return;
    nominaBootDone.current = true;
    // Fetch últimos 24 meses de nómina TRESS para alimentar predictor
    // estacional Y el piso operativo (avg 3m de meses cerrados). Iteramos
    // (año, mes) hacia atrás; cada mes ya cargado se skippea sin red.
    // SIN early-return — antes el guard sobre el mes actual saltaba el
    // batch entero aunque los meses previos no estuvieran cargados,
    // forzando al usuario a "Refrescar TRESS" manualmente.
    const today = new Date();
    setBootSlot('nomina', 'loading');
    (async () => {
      try {
        const monthsToFetch: Array<{ anio: number; mes: number; cacheKey: string }> = [];
        for (let i = 0; i < 24; i++) {
          const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
          const anio = d.getFullYear();
          const mes = d.getMonth() + 1;
          const cacheKey = nominaCacheKey({ idEmpresa: 99, tipoNomina: 99, anio, mes });
          const loadedAt = nominaLoadedKeys[cacheKey];
          // Mes en curso (i=0): siempre refetch. El mes vivo cambia
          // intra-día; cache de ayer reflejaba un mes parcial y dejaba
          // al usuario con datos incompletos hasta que pulsara "Refrescar
          // TRESS" manualmente.
          // Mes anterior (i=1): refetch si cache > 6h. Late entries
          // siguen cayendo durante la primera semana de cierre.
          // Meses cerrados (i ≥ 2): el cache es definitivo, skip.
          if (i === 0) {
            monthsToFetch.push({ anio, mes, cacheKey });
            continue;
          }
          if (i === 1 && !isCacheFresh(loadedAt, 6 * 60 * 60 * 1000)) {
            monthsToFetch.push({ anio, mes, cacheKey });
            continue;
          }
          if (loadedAt) continue;
          monthsToFetch.push({ anio, mes, cacheKey });
        }
        if (monthsToFetch.length === 0) {
          setBootSlot('nomina', 'done');
          return;
        }
        // Chunks paralelos (no sequential await). Antes: 24 awaits en serie
        // tardaban minutos; el usuario abría Nómina antes de que terminara y
        // veía datos parciales → avg 3m mal calculado. Bajamos a 2 porque 4
        // saturaba el upstream y provocaba 504s en cadena (cobranza/nomina/
        // antiguedades compiten por el mismo gateway). Con retry+backoff en
        // jdeClient esto es suficiente.
        const CONCURRENCY = 2;
        const newKeys: Record<string, string> = {};
        for (let i = 0; i < monthsToFetch.length; i += CONCURRENCY) {
          const chunk = monthsToFetch.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(
            chunk.map(({ anio, mes }) =>
              fetchNomina({ idEmpresa: 99, tipoNomina: 99, anio, mes }),
            ),
          );
          const ts = new Date().toISOString();
          let chunkMerged: PayrollCostRecord[] = [];
          results.forEach((res, idx) => {
            const { cacheKey, anio, mes } = chunk[idx];
            if (res.status === 'fulfilled') {
              chunkMerged = mergeNominaBatch(chunkMerged, res.value);
              newKeys[cacheKey] = ts;
            } else {
              console.error(`[nomina] auto-fetch ${anio}-${String(mes).padStart(2, '0')} falló`, res.reason);
            }
          });
          if (chunkMerged.length > 0) {
            setNominaRecords(prev => mergeNominaBatch(prev, chunkMerged));
          }
        }
        if (Object.keys(newKeys).length > 0) {
          setNominaLoadedKeys(prev => ({ ...prev, ...newKeys }));
        }
        setBootSlot('nomina', 'done');
      } catch {
        setBootSlot('nomina', 'error');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeHydrated, companies.length]);

  // Persist selected cia (clear to 'all' if it disappears from the catalog)
  useEffect(() => {
    localStorage.setItem('midas.selectedCia', selectedCia);
  }, [selectedCia]);
  useEffect(() => {
    if (companies.length > 0 && selectedCia !== 'all'
        && !companies.some(c => c.cia === selectedCia)
        && !companyGroups.some(g => g.id === selectedCia)) {
      setSelectedCia('all');
    }
  }, [companies, selectedCia, companyGroups]);

  // Persist bank statements (JDE + supplemental) → IDB heavy-store.
  // Antes vivían en localStorage `midas.bankStatements.v2` y
  // `midas.bankSupplementalStatements.v1` pero la cuota ~5MB se rompía con
  // 2 años de movimientos y dejaba el state truncado. IDB tiene cuota
  // dinámica en GB.
  useEffect(() => {
    let cancelIdle: (() => void) | null = null;
    const timer = window.setTimeout(() => {
      cancelIdle = scheduleIdleTask(() => {
        void saveBankJdeStatementsToIDB(bankJdeStatements);
      }, 2500);
    }, BANK_STORAGE_SAVE_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      cancelIdle?.();
    };
  }, [bankJdeStatements]);
  useEffect(() => {
    let cancelIdle: (() => void) | null = null;
    const timer = window.setTimeout(() => {
      cancelIdle = scheduleIdleTask(() => {
        void saveBankSupplementalStatementsToIDB(bankSupplementalStatements);
      }, 2500);
    }, BANK_STORAGE_SAVE_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      cancelIdle?.();
    };
  }, [bankSupplementalStatements]);
  useEffect(() => {
    if (bankJdeStatements.length === 0 || bankSupplementalStatements.length === 0) return;
    setBankSupplementalStatements((current) => {
      const aligned = attachImportedStatementsToKnownCompanies(current, bankJdeStatements);
      const changed = aligned.some((statement, index) => {
        const previous = current[index];
        return previous?.cia !== statement.cia || previous?.movimientos.some((movement, mIndex) => movement.cia !== statement.movimientos[mIndex]?.cia);
      });
      return changed ? aligned : current;
    });
  }, [bankJdeStatements, bankSupplementalStatements.length]);
  useEffect(() => {
    try {
      if (bankLastQuery) localStorage.setItem('midas.bankLastQuery.v2', JSON.stringify(bankLastQuery));
      else localStorage.removeItem('midas.bankLastQuery.v2');
    } catch { /* ignore */ }
  }, [bankLastQuery]);

  // ── JDE: fetch bank statements ──
  // Boot sólo hace prime corto. El backfill año-a-la-fecha queda para refresh
  // manual; hacerlo automáticamente congelaba la app por red + renders +
  // persistencia de un dataset grande.
  const refreshBankStatementsRange = useCallback(async (
    force: boolean = false,
    includeRange: boolean = false,
  ) => {
    const today = new Date().toISOString().slice(0, 10);
    // 2 años hacia atrás para alimentar Holt-Winters seasonal (≥24m).
    // Antes era year-start (≤365d) → predictor caía a naive-mean (flat).
    const twoYearsAgo = new Date();
    twoYearsAgo.setUTCDate(twoYearsAgo.getUTCDate() - 730);
    const yearStart = twoYearsAgo.toISOString().slice(0, 10);
    const defaultFormat: BankStatementFormat = 'SWIFT';

    // Cache hit: skip unless forced.
    if (!force) {
      const distinctDates = new Set<string>();
      for (const acc of bankJdeStatements) {
        for (const mov of acc.movimientos) distinctDates.add(mov.fechaOperacion);
      }
      const cacheIsFresh =
        bankLastQuery?.formatoElectronico !== SANTANDER_FILE_FORMAT &&
        bankLastQuery?.fechaEstadoCuenta === today &&
        distinctDates.size >= 30;
      if (cacheIsFresh) {
        return { primed: true, ranged: includeRange };
      }
    }

    // Prime: hoy + últimos 5 días hábiles
    const tryDates = [today];
    const d = new Date();
    for (let i = 0; i < 5; i++) {
      d.setDate(d.getDate() - 1);
      tryDates.push(d.toISOString().slice(0, 10));
    }

    setBankFetchStatus('priming');

    // ── Step 1: Prime paralelo — dispara las 6 fechas a la vez, conserva
    //           la primera (más reciente) que devuelva datos. JDE tolera
    //           6 paralelas a /bancos (mismo nivel que el backfill anual).
    let primed = !force && bankJdeStatements.length > 0;
    if (!primed) {
      const settled = await Promise.allSettled(
        tryDates.map(fecha =>
          fetchBankStatements({
            fechaEstadoCuenta: fecha,
            formatoElectronico: defaultFormat,
          }).then(res => ({ fecha, res })),
        ),
      );
      for (let i = 0; i < settled.length; i++) {
        const entry = settled[i];
        if (entry.status === 'fulfilled' && entry.value.res.length > 0) {
          setBankJdeStatements(entry.value.res);
          setBankLastQuery({
            fechaEstadoCuenta: entry.value.fecha,
            formatoElectronico: defaultFormat,
            hasUploadedSantander: bankSupplementalStatements.length > 0,
          });
          primed = true;
          break;
        }
      }
    }

    if (!includeRange) {
      setBankFetchStatus('idle');
      setBankFetchProgress(null);
      return { primed, ranged: false };
    }

    // ── Step 2: Backfill año-a-la-fecha (siempre full range) ──
    // NO usamos delta aquí: bankJdeStatements vive en localStorage v2, que
    // tiene cuota ~5MB y se trunca con 2 años de movimientos. Un boot con
    // state truncado seguido de delta dejaría la app con sólo los días
    // recientes. En cambio, el IDB daily cache (`midas-daily-cache` keys
    // `banks.SWIFT.YYYY-MM-DD`) absorbe el rango entero sin tocar JDE para
    // días pasados, así que el "full" range es rápido. Merge con prev para
    // no perder lo que ya estaba hidratado.
    setBankFetchStatus('ranging');
    setBankFetchProgress({ done: 0, total: 0 });
    let ranged = false;
    let lastTotal = 0;
    let lastProgressPaint = 0;
    try {
      await primeDailyCache();
      const maxCachedBanks = getMaxCachedDay(`banks.${defaultFormat}`);
      // eslint-disable-next-line no-console
      console.info(`[banks] backfill sync · maxCachedIDB=${maxCachedBanks ?? 'none'} · hydratedState=${bankJdeStatements.length} · force=${force} · range ${yearStart}→${today} (FULL via daily cache)`);

      const full = await fetchBankStatementsRange(
        yearStart,
        today,
        defaultFormat,
        {
          concurrency: 6,
          onProgress: (done, total) => {
            lastTotal = total;
            const now = performance.now();
            if (done === total || now - lastProgressPaint > 250) {
              lastProgressPaint = now;
              setBankFetchProgress({ done, total });
            }
          },
        },
      );
      if (full.length > 0) {
        // Merge en lugar de replace: preserva cualquier statement adicional
        // que loadStore haya hidratado, y dedupea movimientos por (cia,
        // cuenta, moneda).
        setBankJdeStatements(prev => mergeBankStatements(prev, full));
        setBankLastQuery({
          fechaEstadoCuenta: today,
          formatoElectronico: defaultFormat,
          hasUploadedSantander: bankSupplementalStatements.length > 0,
        });
        ranged = true;
      }
    } catch {
      // Keep the last known state visible when the range refresh fails.
    }

    // Snap bar to 100% and wait for the CSS transition so the user sees the
    // fill complete before the splash dismisses. Without this, fast JDE
    // responses finish before the bar visually fills.
    if (lastTotal > 0) {
      setBankFetchProgress({ done: lastTotal, total: lastTotal });
      await new Promise((r) => setTimeout(r, 420));
    }

    setBankFetchStatus('idle');
    setBankFetchProgress(null);
    return { primed, ranged };
  }, [bankJdeStatements, bankLastQuery, bankSupplementalStatements.length]);

  const ensureBankCoverageForCollections = useCallback(async ({
    from,
    to,
    ciaFilter,
  }: EnsureBankCoverageRequest) => {
    setBankCoverageLoading(true);
    const defaultFormat: BankStatementFormat = 'SWIFT';
    try {
      const fetched = await fetchBankStatementsRange(from, to, defaultFormat, {
        concurrency: 6,
      });
      const scoped = ciaFilter?.length
        ? fetched.filter(statement => ciaFilter.includes(statement.cia))
        : fetched;
      if (scoped.length > 0) {
        setBankJdeStatements(prev => mergeBankStatements(prev, scoped));
        setBankLastQuery({
          fechaEstadoCuenta: to,
          formatoElectronico: defaultFormat,
          hasUploadedSantander: bankSupplementalStatements.length > 0,
        });
      }
    } finally {
      setBankCoverageLoading(false);
    }
  }, [bankSupplementalStatements.length]);

  const banksBootDone = useRef(false);
  useEffect(() => {
    if (banksBootDone.current) return;
    if (!storeHydrated) return;
    if (!bankCacheLoaded) return;
    banksBootDone.current = true;
    (async () => {
      // Backfill anual al boot. force=false para que la lógica delta-aware
      // dentro de refreshBankStatementsRange decida qué pedir: si tenemos
      // cache hasta ayer, sólo pega JDE para hoy en vez de los 730 días.
      // includeRange=true dispara el rango año-a-la-fecha con concurrencia 6.
      // Gateado en storeHydrated + bankCacheLoaded para que bankJdeStatements
      // ya esté hidratado desde localStorage antes de evaluar la rama delta.
      setBootSlot('banks', 'loading');
      try {
        await refreshBankStatementsRange(false, true);
        setBootSlot('banks', 'done');
      } catch {
        setBootSlot('banks', 'error');
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeHydrated, bankCacheLoaded]);

  /* ── Animated page key for re-mount on tab change ── */
  const [pageKey, setPageKey] = useState(0);
  const prevTab = useRef(activeTab);
  useEffect(() => {
    if (prevTab.current !== activeTab) { setPageKey(k => k + 1); prevTab.current = activeTab; }
  }, [activeTab]);

  // Los handlers de propuestas/escenarios ahora viven dentro de CashFlowView;
  // App sólo expone los setters directos al componente.

  // ── CXP per-cia cache management ──
  const mergeCxpForCia = useCallback((cia: string, records: CXPRecord[]) => {
    setCxpRecords(prev => [...prev.filter(r => r.cia !== cia), ...records]);
    setCxpLoadedCias(prev => ({ ...prev, [cia]: new Date().toISOString() }));
  }, []);
  const replaceAllCxp = useCallback((records: CXPRecord[], cias: string[]) => {
    setCxpRecords(records);
    const now = new Date().toISOString();
    setCxpLoadedCias(cias.reduce<Record<string, string>>((acc, c) => { acc[c] = now; return acc; }, {}));
  }, []);
  const resetCxp = useCallback(() => {
    setCxpRecords([]);
    setCxpLoadedCias({});
  }, []);

  const addProvider = (p: Provider) => setProviders(prev => [...prev, p]);
  const updateProvider = (p: Provider) => setProviders(prev => prev.map(x => x.id === p.id ? p : x));
  const deleteProvider = (id: string) => setProviders(prev => prev.filter(x => x.id !== id));

  const addClient = (c: Client) => setClients(prev => [...prev, c]);
  const updateClient = (c: Client) => setClients(prev => prev.map(x => x.id === c.id ? c : x));
  const deleteClient = (id: string) => setClients(prev => prev.filter(x => x.id !== id));

  const activeSection = SECTION_FOR_TAB[activeTab] ?? 'operacion';
  const subTabs = SUB_TABS[activeSection];

  const switchSection = (s: SectionId) => {
    if (s === activeSection) return;
    setActiveTab(DEFAULT_TAB[s]);
  };

  return (
    <div className="min-h-screen" style={{ background: 'var(--background)' }}>
      {splashMounted && (
        <MidasSplash
          visible={!isBooted}
          tasks={bootTasks}
          startedAt={bootStartedAtRef.current}
        />
      )}
      <div
        style={{
          opacity: isBooted ? 1 : 0,
          transition: 'opacity 240ms var(--ease-smooth)',
        }}
        aria-hidden={!isBooted}
      >
      {/* Skip link — keyboard-only shortcut to main content */}
      <a href="#main-content" className="skip-link">Saltar al contenido</a>

      {/* ─── HEADER (Midas — light shell after dark-mode removal) ─── */}
      <header
        role="banner"
        className="border-b sticky top-0 z-50"
        style={{
          borderColor: 'var(--gray-200)',
          background: 'var(--surface)',
          boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)',
        }}
      >
        <div className="max-w-[1400px] mx-auto px-8 h-14 flex items-center justify-between gap-4">
          {/* Brand lockup — Senda (white, inverted on dark) + divider + Midas */}
          <div
            className="flex items-center gap-3 flex-shrink-0 cursor-pointer senda-lockup-dark"
            onClick={() => setActiveTab('netflow')}
            aria-label="Midas · Senda corporativo"
          >
            <img
              src="/logos/senda-corporativo.svg"
              alt="Senda"
              className="senda-mark-inverted"
              style={{ height: 22, width: 'auto', display: 'block' }}
            />
            <span
              aria-hidden="true"
              style={{ display: 'inline-block', width: 1, height: 22, background: 'var(--shell-border)' }}
            />
            <span
              style={{
                fontSize: '22px',
                fontWeight: 700,
                letterSpacing: 0,
                lineHeight: 1,
                color: 'var(--shell-text)',
              }}
            >
              Midas
            </span>
          </div>

          {/* Section nav */}
          <nav
            role="navigation"
            aria-label="Secciones principales"
            className="flex items-center rounded-[var(--radius-md)] p-0.5 gap-0.5"
            style={{ background: 'var(--gray-50)', border: '1px solid var(--gray-200)' }}
          >
            {SECTIONS.map(s => {
              const isActive = activeSection === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => switchSection(s.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className="flex items-center justify-center gap-2 rounded-md border px-3.5 py-1.5 text-[13px] font-medium transition-colors duration-150 whitespace-nowrap"
                  style={{
                    background: isActive ? 'var(--card)' : 'transparent',
                    color: isActive ? 'var(--gray-950)' : 'var(--shell-text-muted)',
                    borderColor: isActive ? 'transparent' : 'transparent',
                  }}
                  title={s.description}
                >
                  <s.icon
                    className="w-4 h-4"
                    strokeWidth={1.5}
                    style={{ color: isActive ? 'var(--primary)' : 'currentColor' }}
                  />
                  {s.label}
                </button>
              );
            })}
          </nav>

          {/* Actions */}
          <div className="flex items-center gap-1.5">
            <DarkModeToggle />
            <CompanySelector
              companies={companies}
              selectedCia={selectedCia}
              loading={companiesLoading}
              error={companiesError}
              onSelect={setSelectedCia}
              onRetry={loadCompanies}
              groups={companyGroups}
              onGroupsChange={setCompanyGroups}
            />
            <button
              onClick={() => {
                clearAuth();
                window.location.reload();
              }}
              title="Cerrar sesión"
              aria-label="Cerrar sesión"
              className="shell-icon-btn flex items-center justify-center w-9 h-9 rounded-[var(--radius-md)] flex-shrink-0 transition-colors duration-150"
            >
              <LogOut className="w-4 h-4" strokeWidth={1.5} />
            </button>
          </div>
        </div>
      </header>

      {/* ─── SUB-TABS with context breadcrumb (light shell) ─── */}
      {subTabs.length > 0 && (
        <div className="border-b" style={{ background: 'var(--gray-50)', borderColor: 'var(--gray-200)' }}>
          <div className="max-w-[1400px] mx-auto px-8">
            <div className="flex items-center gap-1 py-1.5">
              {/* Breadcrumb context */}
              <span className="text-[12px] font-medium mr-2 flex items-center gap-1" style={{ color: 'var(--gray-500)' }}>
                {SECTIONS.find(s => s.id === activeSection)?.label}
                <ChevronRight className="w-3 h-3" strokeWidth={1.5} />
              </span>
              {subTabs.map(t => {
                const isActive = activeTab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setActiveTab(t.id)}
                    aria-current={isActive ? 'page' : undefined}
                    className="min-h-9 px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors duration-150"
                    style={{
                      background: isActive ? 'var(--surface)' : 'transparent',
                      color: isActive ? 'var(--gray-950)' : 'var(--gray-500)',
                      border: isActive ? '1px solid var(--gray-200)' : '1px solid transparent',
                      boxShadow: isActive ? '0 1px 2px rgba(15, 23, 42, 0.04)' : 'none',
                    }}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ─── MAIN CONTENT ───
         NavigationProvider is hoisted ABOVE the `key={pageKey}` remount
         wrapper so cross-module navigation does not lose its context value
         every time the user switches tabs. The previous nesting plus an
         inline `goTo` arrow caused a re-render loop and ~minute-long crash
         under heavy projection compute. */}
      <main id="main-content" role="main" className="max-w-[1400px] mx-auto px-8 py-4">
        <NavigationProvider goTo={goTo}>
          <div key={pageKey} className="animate-page-in">
          <ErrorBoundary fallbackLabel={subTabs.find(t => t.id === activeTab)?.label ?? activeTab}>
            {activeTab === 'dashboard' && (
              <Suspense fallback={<LazyTabFallback label="Dashboard" />}>
                <Dashboard
                  companyCode={selectedCia}
                  bankStatements={accountableBankStatements}
                  clients={clients}
                  providers={providers}
                  cxpRecords={cxpRecords}
                  assumptions={assumptions}
                  budget={null}
                  onOpenFlow={() => setActiveTab('financialPlanning')}
                  startingBalance={effectiveStartingBalance}
                  cobranzaReconciliation={cobranzaReconciliation}
                  payrollMonthlyActualJDE={payrollMonthlyActualJDE}
                />
              </Suspense>
            )}
            {activeTab === 'financialProjection' && (
              <Suspense fallback={<LazyTabFallback label="Proyección Financiera" />}>
                <FinancialProjectionDashboard
                  companyCode={selectedCia}
                  bankStatements={accountableBankStatements}
                  clients={clients}
                  providers={providers}
                  cxpRecords={cxpRecords}
                  cobranzaRecords={cobranzaRecords}
                  cobranzaPayments={cobranzaPayments}
                  cobranzaReconciliation={cobranzaReconciliation}
                  paidCxpKeys={paidCxpKeys}
                  cargoEnrichments={paymentReconciliation.cargoEnrichments}
                  purchaseReceipts={purchaseReceiptsFromCompras}
                  payrollCosts={nominaRecords}
                  assumptions={assumptions}
                  budget={null}
                  startingBalance={effectiveStartingBalance}
                  onNavigateToTax={() => setActiveTab('taxes')}
                  forecastModelId={forecastModelId}
                  onForecastModelChange={setForecastModelId}
                  forecastSummary={forecastedReceipts}
                />
              </Suspense>
            )}
            {activeTab === 'financialPlanning' && (
              <Suspense fallback={<LazyTabFallback label="Planeación Financiera" />}>
                <FinancialPlanningDashboard
                  companyCode={selectedCia}
                  bankStatements={accountableBankStatements}
                  clients={clients}
                  providers={providers}
                  cxpRecords={cxpRecords}
                  cobranzaRecords={cobranzaRecords}
                  cobranzaReconciliation={cobranzaReconciliation}
                  paidCxpKeys={paidCxpKeys}
                  cargoEnrichments={paymentReconciliation.cargoEnrichments}
                  purchaseReceipts={purchaseReceiptsFromCompras}
                  payrollCosts={nominaRecords}
                  assumptions={assumptions}
                  budget={null}
                  startingBalance={effectiveStartingBalance}
                />
              </Suspense>
            )}
            {activeTab === 'taxes' && (
              <Suspense fallback={<LazyTabFallback label="Impuestos" />}>
                <TaxDashboard
                  companyCode={selectedCia}
                  bankStatements={accountableBankStatements}
                  clients={clients}
                  providers={providers}
                  cxpRecords={cxpRecords}
                  cobranzaRecords={cobranzaRecords}
                  cobranzaPayments={cobranzaPayments}
                  cobranzaReconciliation={cobranzaReconciliation}
                  paidCxpKeys={paidCxpKeys}
                  cxpPaymentCoverage={paymentReconciliation.cxpCoverage}
                  cargoEnrichments={paymentReconciliation.cargoEnrichments}
                  purchaseReceipts={purchaseReceiptsFromCompras}
                  payrollCosts={nominaRecords}
                  assumptions={assumptions}
                  budget={null}
                  startingBalance={effectiveStartingBalance}
                />
              </Suspense>
            )}
            {activeTab === 'payroll' && (
              <Suspense fallback={<LazyTabFallback label="Nómina" />}>
                <PayrollDashboard
                  companyCode={selectedCia}
                  nominaRecords={nominaRecords}
                  nominaLoadedKeys={nominaLoadedKeys}
                  onNominaFetched={(merged, freshKeys) => {
                    setNominaRecords(merged);
                    setNominaLoadedKeys(prev => ({ ...prev, ...freshKeys }));
                  }}
                />
              </Suspense>
            )}
            {activeTab === 'clients' && (
              <Suspense fallback={<LazyTabFallback label="Clientes" />}>
                <Clients
                  clients={clients}
                  assumptions={assumptions}
                  confirmedPayments={confirmedPayments}
                  cobranzaRecords={cobranzaRecords}
                  matcherReview={matcherReview}
                  onReplace={setClients}
                  onAdd={addClient}
                  onUpdate={updateClient}
                  onDelete={deleteClient}
                  onConfirmMatch={(s, targetClientId) => {
                    const clientId = targetClientId ?? s.clientId;
                    setClients(prev => prev.map(c => {
                      if (c.id !== clientId) return c;
                      const existing = c.jdeAccounts ?? [];
                      if (existing.some(a => a.cia === s.cia && a.noCliente === s.noCliente)) return c;
                      return { ...c, jdeAccounts: [...existing, suggestionToLink(s, 'user')] };
                    }));
                    setMatcherReview(prev => ({
                      autoAccepted: prev.autoAccepted,
                      needsReview: prev.needsReview.filter(x => !(x.cia === s.cia && x.noCliente === s.noCliente)),
                      orphanNoClientes: prev.orphanNoClientes.filter(o => !(o.cia === s.cia && o.noCliente === s.noCliente)),
                    }));
                  }}
                  onIgnoreOrphan={(cia, noCliente) => {
                    setMatcherReview(prev => ({
                      autoAccepted: prev.autoAccepted,
                      needsReview: prev.needsReview.filter(x => !(x.cia === cia && x.noCliente === noCliente)),
                      orphanNoClientes: prev.orphanNoClientes.filter(o => !(o.cia === cia && o.noCliente === noCliente)),
                    }));
                  }}
                  onCreateClientFromOrphan={(o) => {
                    const slug = o.nombreCliente.slice(0, 20).replace(/\s+/g, '-').toLowerCase();
                    const newClient: Client = {
                      id: `manual-${o.cia}-${o.noCliente}-${slug}`,
                      name: o.nombreCliente,
                      rfc: o.rfc,
                      monthlyBilling: new Array(12).fill(0),
                      frequency: 'Mensual',
                      creditDays: 30,
                      paymentDay: { kind: 'ANY' },
                      jdeAccounts: [{
                        cia: o.cia,
                        noCliente: o.noCliente,
                        nombreCliente: o.nombreCliente,
                        rfc: o.rfc,
                        matchedAt: new Date().toISOString(),
                        matchedBy: 'user',
                        confidence: 1,
                      }],
                    };
                    setClients(prev => prev.some(c => c.id === newClient.id) ? prev : [...prev, newClient]);
                    setMatcherReview(prev => ({
                      autoAccepted: prev.autoAccepted,
                      needsReview: prev.needsReview.filter(x => !(x.cia === o.cia && x.noCliente === o.noCliente)),
                      orphanNoClientes: prev.orphanNoClientes.filter(x => !(x.cia === o.cia && x.noCliente === o.noCliente)),
                    }));
                  }}
                />
              </Suspense>
            )}
            {activeTab === 'collections' && (
              <Suspense fallback={<LazyTabFallback label="Cobranza" />}>
                <CollectionProjection
                  clients={clients}
                  assumptions={assumptions}
                  onAssumptionsChange={setAssumptions}
                  confirmedPayments={confirmedPayments}
                  onConfirm={confirmPayment}
                  onUnconfirm={unconfirmPayment}
                  cxpRecords={cxpRecords}
                  bankStatements={accountableBankStatements}
                  companies={companies}
                  cobranzaRecords={cobranzaRecords}
                  cobranzaPayments={cobranzaPayments}
                  cobranzaLoadedCias={cobranzaLoadedCias}
                  cobranzaReconciliation={cobranzaReconciliation}
                  cobranzaFacturaIndex={cobranzaFacturaIndex}
                  cobranzaError={cobranzaError}
                  onRefreshCobranza={refreshCobranza}
                  cobranzaRefreshing={cobranzaRefreshing}
                  selectedCia={selectedCia}
                  onEnsureBankCoverage={ensureBankCoverageForCollections}
                  bankCoverageLoading={bankCoverageLoading}
                />
              </Suspense>
            )}
            {activeTab === 'fideicomiso' && (
              <Suspense fallback={<LazyTabFallback label="Fideicomiso" />}>
                <FideicomisoDashboard
                  bankStatements={bankStatements}
                  cobranzaRecords={cobranzaRecords}
                  cobranzaPayments={cobranzaPayments}
                  companies={companies}
                  selectedCia={selectedCia}
                  onRefreshBanks={() => refreshBankStatementsRange(true, true)}
                  onRefreshCobranza={refreshCobranza}
                  bankFetchStatus={bankFetchStatus}
                  cobranzaRefreshing={cobranzaRefreshing}
                />
              </Suspense>
            )}
            {activeTab === 'providers' && (
              <Suspense fallback={<LazyTabFallback label="Proveedores" />}>
                <Providers
                  providers={providers}
                  spendIndex={providerSpendIndex}
                  cxpRecords={cxpRecords}
                  onReplace={setProviders}
                  onAdd={addProvider}
                  onUpdate={updateProvider}
                  onDelete={deleteProvider}
                />
              </Suspense>
            )}
            {activeTab === 'cxp' && (
              <Suspense fallback={<LazyTabFallback label="CXP" />}>
                <CXP
                  records={cxpRecords}
                  loadedCias={cxpLoadedCias}
                  companies={companies}
                  selectedCia={selectedCia}
                  providers={providers}
                  clients={clients}
                  assumptions={assumptions}
                  bankStatements={accountableBankStatements}
                  paymentCoverage={paymentReconciliation.cxpCoverage}
                  budget={null}
                  onMergeCia={mergeCxpForCia}
                  onReplaceAll={replaceAllCxp}
                  onReset={resetCxp}
                />
              </Suspense>
            )}
            {activeTab === 'compras' && (
              <Suspense fallback={<LazyTabFallback label="Órdenes de Compras" />}>
                <Compras
                  comprasRecords={comprasRecords}
                  comprasLoadedCias={comprasLoadedCias}
                  selectedCia={selectedCia}
                  providers={providers}
                />
              </Suspense>
            )}
            {activeTab === 'pagos' && (
              <Suspense fallback={<LazyTabFallback label="Pagos a Proveedores" />}>
                <Pagos
                  pagoProveedorRecords={pagoProveedorRecords}
                  pagoProveedorLoadedCias={pagoProveedorLoadedCias}
                  selectedCia={selectedCia}
                  providers={providers}
                  internalPaymentKeys={paymentReconciliation.internalPaymentKeys}
                />
              </Suspense>
            )}
            {activeTab === 'bancos' && (
              <Suspense fallback={<LazyTabFallback label="Bancos" />}>
                <Bancos
                  selectedCia={selectedCia}
                  statements={bankStatements}
                  supplementalStatements={bankSupplementalStatements}
                  onJdeStatementsChange={setBankJdeStatements}
                  onSupplementalStatementsChange={setBankSupplementalStatements}
                  lastQuery={bankLastQuery}
                  onLastQueryChange={setBankLastQuery}
                  companies={companies}
                  abonoEnrichmentIndex={cobranzaAbonoIndex}
                  cargoEnrichmentIndex={paymentReconciliation.cargoEnrichments}
                />
              </Suspense>
            )}
            {activeTab === 'netflow' && (
              <Suspense fallback={<LazyTabFallback label="Flujo Neto" />}>
                <CashFlowDetail
                  clients={clients}
                  cxpRecords={cxpRecords}
                  assumptions={assumptions}
                  confirmedPayments={confirmedPayments}
                  bankStatements={accountableBankStatements}
                  companies={companies}
                  bankFetchStatus={bankFetchStatus}
                  bankFetchProgress={bankFetchProgress}
                  onRefreshBanks={() => refreshBankStatementsRange(true, true)}
                  startingBalance={effectiveStartingBalance}
                />
              </Suspense>
            )}
            {/* Forecast tab fused into Dashboard — no longer standalone */}
          </ErrorBoundary>
          </div>
        </NavigationProvider>
      </main>

      {/* ── Global overlays ── */}
      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        onNavigate={(tabId) => { setActiveTab(tabId as TabId); setCmdOpen(false); }}
        clients={clients.map(c => ({ id: c.id, name: c.name }))}
        providers={providers.map(p => ({ id: p.id, name: p.name }))}
        simulations={paletteAdjustments}
        scenarios={paletteScenarios}
        actions={paletteActions}
      />
      <ActivityFeedPanel
        open={activityOpen}
        onClose={() => setActivityOpen(false)}
        onNavigate={(tabId) => { setActiveTab(tabId as TabId); setActivityOpen(false); }}
      />
      <KeyboardShortcutsModal
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />
      </div>
    </div>
  );
}

function CompanySelector({
  companies,
  selectedCia,
  loading,
  error,
  onSelect,
  onRetry,
  groups,
  onGroupsChange,
}: {
  companies: Company[];
  selectedCia: string;
  loading: boolean;
  error: string | null;
  onSelect: (cia: string) => void;
  onRetry: () => void;
  groups: CompanyGroup[];
  onGroupsChange: (groups: CompanyGroup[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'select' | 'create' | 'edit'>('select');
  const [editGroupId, setEditGroupId] = useState<string | null>(null);
  const [groupName, setGroupName] = useState('');
  const [groupCias, setGroupCias] = useState<Set<string>>(new Set());
  const [groupColor, setGroupColor] = useState<string>(GROUP_COLORS[0]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (!open) { setMode('select'); setEditGroupId(null); }
  }, [open]);

  const activeGroup = groups.find(g => g.id === selectedCia);
  const active = companies.find(c => c.cia === selectedCia);
  const label = selectedCia === 'all'
    ? 'Todas las compañías'
    : activeGroup
      ? `${activeGroup.name} (${activeGroup.cias.length})`
      : active ? `${active.cia} — ${active.nombre}` : selectedCia;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); }
  };

  const startCreate = () => {
    setMode('create');
    setGroupName('');
    setGroupCias(new Set());
    setGroupColor(GROUP_COLORS[groups.length % GROUP_COLORS.length]);
    setEditGroupId(null);
  };

  const startEdit = (g: CompanyGroup) => {
    setMode('edit');
    setGroupName(g.name);
    setGroupCias(new Set(g.cias));
    setGroupColor(g.color ?? GROUP_COLORS[0]);
    setEditGroupId(g.id);
  };

  const saveGroup = () => {
    if (!groupName.trim() || groupCias.size === 0) return;
    if (mode === 'edit' && editGroupId) {
      onGroupsChange(groups.map(g => g.id === editGroupId
        ? { ...g, name: groupName.trim(), cias: Array.from(groupCias), color: groupColor }
        : g
      ));
    } else {
      const newGroup: CompanyGroup = {
        id: newGroupId(),
        name: groupName.trim(),
        cias: Array.from(groupCias),
        color: groupColor,
        createdAt: new Date().toISOString(),
      };
      onGroupsChange([...groups, newGroup]);
    }
    setMode('select');
    setEditGroupId(null);
  };

  const deleteGroup = (id: string) => {
    onGroupsChange(groups.filter(g => g.id !== id));
    if (selectedCia === id) onSelect('all');
  };

  const toggleCia = (cia: string) => {
    const next = new Set(groupCias);
    next.has(cia) ? next.delete(cia) : next.add(cia);
    setGroupCias(next);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        onKeyDown={handleKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Compañía activa: ${label}. Filtra datos globalmente.`}
        className="shell-picker-btn flex items-center gap-1.5 h-9 px-3 rounded-[var(--radius-md)] text-[13px] font-medium transition-colors duration-150 max-w-[300px]"
        style={{
          background: activeGroup ? `${activeGroup.color}20` : 'rgba(255,255,255,0.08)',
          color: 'var(--shell-text)',
          border: '1px solid var(--shell-border)',
        }}
        title="Compañía o grupo activo — filtra los datos de todas las pestañas"
      >
        {activeGroup
          ? <FolderOpen className="w-4 h-4 flex-shrink-0" strokeWidth={1.5} style={{ color: activeGroup.color ?? 'var(--shell-text)' }} />
          : <Building2 className="w-4 h-4 flex-shrink-0" strokeWidth={1.5} style={{ color: 'var(--shell-text-muted)' }} />
        }
        <span className="truncate">{loading ? 'Cargando…' : label}</span>
        {loading
          ? <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" strokeWidth={1.5} style={{ color: 'var(--shell-text-muted)' }} />
          : <ChevronDown className={`w-3.5 h-3.5 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} strokeWidth={1.5} style={{ color: 'var(--shell-text-muted)' }} />
        }
      </button>

      {open && (
        <div
          className="absolute right-0 top-11 w-[360px] rounded-[var(--radius-md)] border p-1.5 z-50 max-h-[520px] overflow-y-auto animate-slide-down"
          style={{ background: 'var(--surface)', borderColor: 'var(--gray-200)', boxShadow: 'var(--shadow-md)' }}
        >
          {error ? (
            <div className="p-3">
              <div className="flex items-start gap-2 mb-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} />
                <p className="text-[12px] leading-snug" style={{ color: 'var(--gray-500)' }}>{error}</p>
              </div>
              <button onClick={() => { onRetry(); }} className="text-[12px] font-medium" style={{ color: 'var(--primary)' }}>Reintentar</button>
            </div>
          ) : mode === 'select' ? (
            <>
              {/* All companies */}
              <button
                role="option"
                aria-selected={selectedCia === 'all'}
                onClick={() => { onSelect('all'); setOpen(false); }}
                className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-[var(--radius-md)] text-[13px] text-left transition"
                style={{ background: selectedCia === 'all' ? 'var(--primary-muted)' : undefined, color: selectedCia === 'all' ? 'var(--primary)' : 'var(--gray-950)' }}
              >
                <span className="font-medium">Todas las compañías</span>
                {selectedCia === 'all' && <Check className="w-3.5 h-3.5" />}
              </button>

              {/* Groups section */}
              {groups.length > 0 && (
                <div className="mt-2 mb-1">
                  <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--gray-400)] px-3 py-1 font-medium">Grupos</div>
                  {groups.map(g => {
                    const isActive = selectedCia === g.id;
                    return (
                      <div key={g.id} className="flex items-center group">
                        <button
                          onClick={() => { onSelect(g.id); setOpen(false); }}
                          className="flex-1 flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] text-[13px] text-left transition"
                          style={{ background: isActive ? `${g.color}15` : undefined, color: isActive ? g.color : 'var(--gray-950)' }}
                        >
                          <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: g.color }} />
                          <div className="min-w-0 flex-1">
                            <p className="font-medium truncate">{g.name}</p>
                            <p className="text-[11px] truncate" style={{ color: 'var(--gray-400)' }}>
                              {g.cias.map(cia => {
                                const c = companies.find(co => co.cia === cia);
                                return c?.nombre ?? cia;
                              }).join(', ')}
                            </p>
                          </div>
                          {isActive && <Check className="w-3.5 h-3.5 flex-shrink-0" />}
                        </button>
                        <div className="flex gap-0.5 pr-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={(e) => { e.stopPropagation(); startEdit(g); }}
                            className="p-1 rounded hover:bg-[var(--gray-100)] text-[var(--gray-400)] hover:text-[var(--gray-700)]"
                            title="Editar grupo"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); deleteGroup(g.id); }}
                            className="p-1 rounded hover:bg-[var(--danger)]/10 text-[var(--gray-400)] hover:text-[var(--danger)]"
                            title="Eliminar grupo"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Create group button */}
              <button
                onClick={startCreate}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] text-[13px] text-left transition hover:bg-[var(--gray-50)]"
                style={{ color: 'var(--primary)' }}
              >
                <FolderPlus className="w-4 h-4" />
                <span className="font-medium">Crear grupo de empresas</span>
              </button>

              {/* Divider */}
              <div className="h-px bg-[var(--gray-100)] my-1.5" />

              {/* Individual companies */}
              <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--gray-400)] px-3 py-1 font-medium">Empresas individuales</div>
              {companies.length === 0 && !loading && (
                <p className="text-[12px] px-3 py-2" style={{ color: 'var(--gray-400)' }}>Sin compañías disponibles.</p>
              )}
              {companies
                .filter(c => c.activa !== false)
                .map(c => {
                  const isActive = selectedCia === c.cia;
                  return (
                    <button
                      key={c.cia}
                      onClick={() => { onSelect(c.cia); setOpen(false); }}
                      className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-[var(--radius-md)] text-[13px] text-left transition"
                      style={{ background: isActive ? 'var(--primary-muted)' : undefined, color: isActive ? 'var(--primary)' : 'var(--gray-950)' }}
                    >
                      <div className="min-w-0">
                        <p className="font-medium truncate">{c.cia} — {c.nombre}</p>
                        {c.rfc && <p className="text-[11px] truncate" style={{ color: 'var(--gray-400)' }}>{c.rfc}</p>}
                      </div>
                      {isActive && <Check className="w-3.5 h-3.5 flex-shrink-0" />}
                    </button>
                  );
                })}
            </>
          ) : (
            /* ── Create / Edit Group form ── */
            <div className="p-3 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-[14px] font-bold text-[var(--gray-950)]">
                  {mode === 'edit' ? 'Editar grupo' : 'Nuevo grupo'}
                </h3>
                <button onClick={() => setMode('select')} className="p-1 rounded hover:bg-[var(--gray-100)] text-[var(--gray-400)]">
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Name input */}
              <div>
                <label className="text-[11px] text-[var(--gray-400)] mb-1 block">Nombre del grupo</label>
                <input
                  type="text"
                  value={groupName}
                  onChange={e => setGroupName(e.target.value)}
                  placeholder="Ej: Grupo Norte, Pasaje Lujo..."
                  className="input w-full"
                  autoFocus
                />
              </div>

              {/* Color picker */}
              <div>
                <label className="text-[11px] text-[var(--gray-400)] mb-1 block">Color</label>
                <div className="flex gap-1.5">
                  {GROUP_COLORS.map(c => (
                    <button
                      key={c}
                      onClick={() => setGroupColor(c)}
                      className={`w-7 h-7 rounded-full transition-shadow ${groupColor === c ? 'ring-2 ring-offset-2 ring-[var(--gray-300)]' : 'hover:ring-2 hover:ring-offset-1 hover:ring-[var(--gray-200)]'}`}
                      style={{ background: c }}
                    />
                  ))}
                </div>
              </div>

              {/* Company checkboxes */}
              <div>
                <label className="text-[11px] text-[var(--gray-400)] mb-1 block">
                  Empresas ({groupCias.size} seleccionadas)
                </label>
                <div className="space-y-1 max-h-48 overflow-y-auto border border-[var(--gray-200)] rounded-[var(--radius-md)] p-1.5">
                  {companies.filter(c => c.activa !== false).map(c => {
                    const checked = groupCias.has(c.cia);
                    return (
                      <button
                        key={c.cia}
                        onClick={() => toggleCia(c.cia)}
                        className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-[var(--radius-md)] text-[12px] text-left transition ${
                          checked ? 'bg-[var(--primary-muted)]' : 'hover:bg-[var(--gray-50)]'
                        }`}
                      >
                        <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition ${
                          checked ? 'bg-[var(--primary)] border-[var(--primary)]' : 'border-[var(--gray-300)]'
                        }`}>
                          {checked && <Check className="w-3 h-3 text-white" strokeWidth={1.5} />}
                        </div>
                        <span className={checked ? 'text-[var(--primary)] font-medium' : 'text-[var(--gray-700)]'}>
                          {c.cia} — {c.nombre}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => setMode('select')}
                  className="flex-1 h-9 rounded-[var(--radius-md)] border border-[var(--gray-200)] text-[13px] text-[var(--gray-500)] hover:bg-[var(--gray-50)]"
                >
                  Cancelar
                </button>
                <button
                  onClick={saveGroup}
                  disabled={!groupName.trim() || groupCias.size === 0}
                  className="flex-1 h-9 rounded-[var(--radius-md)] text-white text-[13px] font-medium hover-press disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: groupColor }}
                >
                  {mode === 'edit' ? 'Guardar cambios' : 'Crear grupo'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
