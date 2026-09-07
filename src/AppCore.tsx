import { startTransition, useState, useEffect, useRef, useCallback, useMemo, useDeferredValue, lazy, Suspense, type ReactNode } from 'react';
import { TabId, CashFlowOverrides } from './types';
import { todayISO } from './formatters';
import { Provider, Client, CashFlowAssumptions, ConfirmedPayment } from './domain/types';
import { MidasStore, loadLightStore, saveLightStore, CXPRecord, type AuxiliarIvaLoadedCiaMeta } from './domain/persistence';
import { CACHE_LOADED_AT_KEY, clearCacheStorageOnEntry } from './domain/storageRegistry';
import { loadHeavyRecords, saveHeavyRecords, type HeavyKey } from './services/heavyStoreIDB';
import {
  getLocalSnapshotVersion,
  getSnapshotPointer,
  hydrateHeavyStoreFromSnapshot,
  isSnapshotEnabled,
} from './services/snapshotRemoteSync';
import { recomputeClientCreditDaysFromCobranza } from './domain/collectionCalendarEngine';
import { comprasToPurchaseReceipts } from './domain/comprasToPurchaseReceipts';
import { compraEstado } from './domain/comprasInsights';
import { selectComprasForProjection } from './modules/financial-projection/services/comprasProjectionFilter';
import { subscribeProjectionFirstPaint } from './modules/financial-projection/services/projectionBootSignal';
import { buildProviderSpendIndex } from './domain/providerRecentSpend';
import { computePayrollMonthlyFloor } from './domain/payrollOperatingFloor';
import { deriveProvidersFromJde } from './domain/providerDerivation';
import {
  nextProviderDerivationJobId,
  postToProviderDerivationWorker,
  subscribeProviderDerivationWorker,
} from './workers/sharedProviderDerivationWorker';
import { loadProviderScoreOverlay } from './domain/loadProvidersCatalog';
import { setProviderCatalogForCategoryLookup } from './modules/financial-planning/services/providerCategoryGeneralization';
import { clearAuth } from './components/Login';
import { fetchClientCatalog } from './services/catalog.service';
import { primeDailyCache, getMaxCachedDay, nextIsoDay, isoDaysBefore, isDailyCachePersistent, dailyCacheStats, clearAllDailyCache } from './services/dailyApiCache';
import { publishDataHealthDiagnostics, getDataGaps, clearDataLakeMarkers, reportDataGap } from './services/dataHealth';
import { DataHealthPanel, type DataHealthDatasetRow } from './components/DataHealthPanel';
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
  fetchRolRange,
  fetchViajesEspecialesRange,
  fetchAuxiliarContableRange,
  fetchAuxiliarContableIvaRange,
  AUX_IVA_LEDGER_VERSION,
  type Company,
  type AuxiliarContableRecord,
  type BankAccountStatement,
  type BankStatementFormat,
  type CobranzaPayment,
  type CobranzaRecord,
  type ComprasRecord,
  type PagoProveedorRecord,
  type RolRecord,
  type ViajeEspecialRecord,
} from './services/jde';
import { AUX_RECON_PARAMS, isAuxiliarAllowlistedCia } from './domain/auxiliarReconciliationConfig';
import {
  summarizeIvaAccounts,
  buildIvaLedgerByPeriod,
  groupIvaAccountsByKind,
  missingIvaKindsByCia,
} from './domain/ivaLedger';
import {
  reconcileAuxiliar,
  emptyAuxiliarReconResult,
  type AuxiliarReconResult,
} from './domain/auxiliarReconciliationEngine';
import type { AuxiliarReconciliationWorkerResponse } from './workers/auxiliarReconciliationWorkerTypes';

// Lazy-loaded so the projection module's Recharts + canonical engine is
// not in the initial App bundle. This is the single largest chunk in the
// build — keeping it out of first paint cuts the dashboard's first
// interaction-time noticeably on cold loads.
const Providers = lazy(() => import('./components/Providers'));
const Clients = lazy(() => import('./components/Clients'));
const CashFlowDetail = lazy(() => import('./components/CashFlowDetail'));
const CXP = lazy(() => import('./components/CXP'));
const Compras = lazy(() => import('./components/Compras'));
const PasivoDistribuir = lazy(() => import('./components/PasivoDistribuir'));
const Pagos = lazy(() => import('./components/Pagos'));
const Bancos = lazy(() => import('./components/Bancos'));
const CollectionProjection = lazy(() => import('./components/CollectionProjection'));
const FideicomisoDashboard = lazy(() => import('./components/FideicomisoDashboard'));
const FinancialProjectionDashboard = lazy(() => import('./modules/financial-projection/pages/FinancialProjectionDashboard'));
const FinancialPlanningDashboard = lazy(() => import('./modules/financial-planning/pages/FinancialPlanningDashboard'));
const TaxDashboard = lazy(() => import('./modules/taxes/pages/TaxDashboard'));
const PayrollDashboard = lazy(() => import('./modules/payroll/pages/PayrollDashboard'));
const ConcursoMercantilDashboard = lazy(() => import('./modules/concurso-mercantil/pages/ConcursoMercantilDashboard'));
const KpisObjectivesDashboard = lazy(() => import('./modules/kpis-objectives/pages/KpisObjectivesDashboard'));
const UsersDashboard = lazy(() => import('./modules/users/pages/UsersDashboard'));
const PermissionsDashboard = lazy(() => import('./modules/users/pages/PermissionsDashboard'));
const SalesCalendarDashboard = lazy(() => import('./modules/sales/pages/SalesCalendarDashboard'));
// TEMPORAL fuentes-datos (2026-07-10): dashboard del tab de diagnóstico
// "Fuentes y Datos". Quitar junto con src/modules/data-sources/.
const DataSourcesDashboard = lazy(() => import('./modules/data-sources/pages/DataSourcesDashboard'));
import ErrorBoundary from './components/ErrorBoundary';
import MidasSplash, { type BootTask, type BootTaskStatus } from './components/MidasSplash';
import ChangePasswordModal from './components/ChangePasswordModal';
import DarkModeToggle from './components/ui/DarkModeToggle';
import { ActivityFeedPanel } from './components/ActivityFeed';
import { useCommandPalette } from './components/CommandPalette';
import CommandPalette, { type CommandPaletteAction } from './components/CommandPalette';
import { loadPlanningScenarios, loadPlanningAdjustments, listHeaderScenarios } from './modules/financial-planning/services/financialPlanningStorage';
import { NavigationProvider, type AppTabId, type NavTarget } from './modules/shared-finance/components/NavigationContext';
import { ScenarioSelectionProvider, useScenarioSelection } from './modules/shared-finance/components/ScenarioSelectionContext';
import DashboardLoadingShell from './modules/shared-finance/components/DashboardLoadingShell';
import type { PayrollCostRecord, FinancialScenario } from './modules/shared-finance/types';
import { deriveNominaLoadedKeysFromRecords, findSuspectMonths, mergeNominaBatch, nominaCacheKey, refineBatch } from './modules/payroll/services/payrollModuleService';
import { KeyboardShortcutsModal, useKeyboardShortcuts } from './components/KeyboardShortcuts';
import {
  Users, UserSquare, UserCog,
  ChevronDown, Landmark, Check, GitBranch, Lock,
  HandCoins, ChevronRight, BookUser, TrendingUp,
  Receipt, Wallet, FolderOpen, PackageOpen,
  LogOut, ClipboardList, BarChart3, ShieldCheck, CreditCard, Scale,
  Target, KeyRound,
  ShoppingCart, SlidersHorizontal,
  Menu, X, Activity,
  Database, Truck,
  type LucideIcon,
} from 'lucide-react';
import { filterActiveCompanies, matchesExclusionIdentity } from './domain/companyExclusion';
import { applyViajesEspecialesGroup } from './domain/viajesEspecialesCatalog';
import {
  attachImportedStatementsToKnownCompanies,
  isBajioStatement,
  latestStatementDate,
  mergeBankStatements,
  type BankQueryState,
} from './domain/bankStatements';
import { summarizeBankFreshnessByCompany, summarizeManualBankFreshness } from './domain/bankSourceFreshness';
import { summarizeSourceDataFreshness } from './domain/sourceDataFreshness';
import { SANTANDER_FILE_FORMAT } from './domain/santanderCsv';
import {
  type AbonoEnrichment,
  type RealReconciliationMatch,
  type RealReconciliationResult,
} from './domain/realReconciliationEngine';
import { emptyRealReconciliationResult } from './domain/emptyRealReconciliationResult';
import { reconcilePayments, emptyPaymentReconciliationResult, type PaymentReconciliationResult } from './domain/paymentReconciliationEngine';
import type { PaymentReconciliationWorkerResponse } from './workers/paymentReconciliationWorkerTypes';
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
import {
  planCobranzaRefresh,
  mergeCobranzaRevalidationWindow,
  mergeCobranzaBackfillRange,
  COBRANZA_LOOKBACK_DAYS,
  COBRANZA_REVALIDATE_DAYS,
} from './domain/cobranzaRefreshWindow';
import { glConfirmedInvoiceKeysFromSourceConfirmation } from './domain/cobranzaBankCuadre';
import {
  defaultWindowFloor,
  defaultWindowMonths,
  previousIsoDay,
  yearStartISO,
} from './domain/dataWindow';
import { DataWindowProvider, type DataWindowValue } from './contexts/DataWindowContext';
import { useToast } from './components/Toast';
import { useAuth } from './contexts/AuthContext';
import {
  consumePurgeNotice,
  markBootComplete,
  purgeReasonMessage,
} from './services/storageHealthGuard';
import { trackNavigation, onMemoryPressure, onMemoryEmergency } from './services/runtimeGuardian';
import { clearProjectionSourceCache } from './modules/financial-projection/services/financialProjectionService';
import { PROVIDER_CACHE_KEY_FIELDS, sameByCacheKeyFields } from './modules/financial-projection/services/projectionCacheFingerprint';
import { clearProjectionRunCache } from './modules/financial-projection/services/projectionCache';
import { resetScenarioRunWorker } from './modules/shared-finance/hooks/useScenarioRunWorker';

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
// Clear-on-entry guard: garantiza que el borrado+recarga de caches corra a lo
// más UNA vez por carga de página (no por remount del componente raíz). Un
// reload del navegador es un nuevo contexto JS → vuelve a false → re-limpia.
let cacheEntryHandled = false;
// Boot slots que RETIENEN el splash. Regla (petición de producto): el splash
// dura hasta que la información esté 100% cargada; si no, la app NO abre. Por eso
// TODOS los datasets gatean — incluidos ROL (día-por-día, "toma horas") y Auxiliar
// Contable (~3,500 requests, "20-30 min" en frío), que antes cargaban detrás del
// dashboard (Fase 0). "100%" es RELATIVO A LA VISIBILIDAD DEL USUARIO: los datasets
// que un `user` no puede ver no son relevantes y NO gatean — el escape de
// `allowedDatasets` (más abajo) los marca 'done' de inmediato, así que el gate sólo
// espera por lo que ese usuario realmente carga. En modo snapshot (ver clear-on-entry
// selector) los slots cubiertos se marcan 'done' tras la descarga. Nota de trade-off:
// bajo clear-on-entry un cold boot puede sostener el splash 20-30+ min; es el costo
// aceptado de "esperar al 100%". El release exige TODOS 'done' (un 'error' bloquea
// la app en vez de abrirla degradada — ver el efecto de release).
const GATING_BOOT_IDS = new Set<string>([
  'catalog', 'companies', 'banks', 'cxp', 'cobranza', 'compras', 'pagos', 'nomina', 'rol', 'auxiliar', 'projection',
]);
// Slots que el snapshot compartido cubre. En modo snapshot (ver el selector de
// clear-on-entry) se marcan 'done' apenas termina la descarga y se CONGELAN ahí:
// los auto-fetch delta corren detrás del dashboard sin re-abrir el gate del splash.
// `catalog`/`companies`/`banks`/`projection` NO están aquí — tienen su propio path
// rápido (cache-first / first-paint).
const SNAPSHOT_COVERED_SLOTS = new Set<string>([
  'cxp', 'cobranza', 'compras', 'pagos', 'nomina', 'rol', 'auxiliar',
]);
const COBRANZA_AUTO_REFRESH_TTL_MS = 6 * 60 * 60 * 1000;
const CXP_AUTO_REFRESH_TTL_MS = 6 * 60 * 60 * 1000;
const COMPRAS_AUTO_REFRESH_TTL_MS = 6 * 60 * 60 * 1000;
// Boot auto-fetch de Compras/Pagos. El piso base es `defaultWindowFloor` (año
// en curso + 12 meses atrás, uniforme con el resto de datasets) — cubre el año
// fiscal de compras que la auditoría Pago↔CXP↔OC necesita (un pago de Mar-2026
// puede cubrir CXPs emitidas en Oct/Nov-2025). OCs previas se cargan bajo
// demanda (DataWindowContext). El filtro `selectComprasForProjection` (drop
// fechaPago < hoy) sigue recortando para proyección. Las OCs aún ABIERTAS más
// viejas que el piso se re-piden aparte vía COMPRAS_MAX_REVALIDATE_LOOKBACK_DAYS
// (siguen siendo pasivos vivos). Futuro: +3 meses vía COMPRAS_FUTURE_LOOKAHEAD_MONTHS.
const COMPRAS_FUTURE_LOOKAHEAD_MONTHS = 3;
const COMPRAS_CACHE_KEY = '__all__';
// Frescura de datos (Etapa 1). El cache mensual sirve meses pasados sin red,
// así que una OC que cambia de estado DESPUÉS de cachearse (creada → recibida
// → facturada, o el importe corregido por el SP) quedaba stale para siempre.
// En cada sync re-validamos: (a) los últimos N meses calendario, y (b) el mes
// de CUALQUIER OC aún en estado no-terminal (sinEntrada/porPagar) — esas son
// las que todavía pueden moverse. El piso evita extender el fetch a años atrás
// por una OC vieja olvidada en estado abierto.
const COMPRAS_REVALIDATE_MONTHS = 3;
const COMPRAS_MAX_REVALIDATE_LOOKBACK_DAYS = 540;
// Días recientes que PagoProveedor re-pide en cada sync aunque ya estén
// cacheados — cubre pagos capturados con atraso sobre un día ya consultado.
const PAGOS_REVALIDATE_DAYS = 21;
// Ventana de revalidación de días bancarios vacíos en el backfill de boot.
// Tesorería sube Bajío/Santander MANUALMENTE con semanas de atraso (cargas
// observadas: 5/15-may, 10-jun), así que los 14d de la ruta single-day no
// alcanzan para sanear "28-abril". 45d cubre el atraso típico de carga manual
// a costa de ~pocas requests extra de días genuinamente vacíos por boot.
const BANKS_BACKFILL_REVALIDATE_DAYS = 45;
// Ventana de revalidación de días PARCIALES de bancos (días CON datos que se
// re-piden por si JDE recibió movimientos con atraso → conteo divergente entre
// equipos). Más corta que la de vacíos porque cada día no-vacío cuesta una
// request por boot; el atraso de captura es de días.
const BANKS_PARTIAL_REVALIDATE_DAYS = 14;
// Ventana de revalidación de días parciales del Auxiliar Contable (pólizas
// posteadas con atraso). Mismo razonamiento que bancos.
const AUX_PARTIAL_REVALIDATE_DAYS = 14;
// El backfill de historia trabaja con slots de dataset (`DatasetKey`), pero los
// huecos por día/mes/chunk de `jde.ts` se registran con el namespace del cache.
// Alinear los dos nombres mantiene `__midas__.dataHealth.gaps()` filtrable por
// un solo dataset (mismo criterio que los gaps por cía de los boot loaders).
const BACKFILL_GAP_DATASET: Record<string, string> = {
  pagos: 'pagoproveedor',
  auxiliar: 'auxiliarcontable',
};
// Whitelist explícito de cías que SÍ generan órdenes de compra relevantes.
// El resto del catálogo JDE (subsidiarias dormidas, holdings, etc.) devuelve
// OCs vacías o irrelevantes — pedirlas era ~17 cías × 13 meses ≈ 220 requests
// inútiles por boot. 00033 (Multicarga) queda fuera por exclusión global —
// ver src/domain/companyExclusion.ts.
const COMPRAS_ALLOWED_CIAS = new Set<string>([
  '00001', '00011', '00029', '00030', '00036',
  '00038', '00042', '00043', '00046', '00057',
]);
// Tabs que dependen del cruce JDE↔banco para mostrar números correctos.
// Proyección / Planeación / Impuestos consumen `cobranzaReconciliation`
// vía `buildFinancialProjectionSourceData` para no doblar facturas
// CXC ya cobradas. Si no se calcula al entrar a esos tabs, el primer
// render de la proyección queda con cobranza inflada hasta que el
// usuario regresa a Cobranza/Bancos/Dashboard.
const RECONCILIATION_TABS = new Set<TabId>([
  'collections',
  'bancos',
  'financialProjection',
  'financialPlanning',
  'taxes',
]);

type DatasetKey = 'cxp' | 'cobranza' | 'compras' | 'pagos' | 'nomina' | 'rol' | 'banks' | 'auxiliar';
type DatasetStatus = 'idle' | 'loading' | 'ready' | 'stale' | 'error';

// Datasets each tab's component actually consumes. This is the REAL data
// contract: allowedDatasets (permission gating) is the union over permitted
// tabs, so a tab that under-declares leaves scoped users with silently
// incomplete numbers (taxes/concurso/pagos without banks → IVA=$0, empty Pagos).
// Keep in sync with each tab's render props below.
const TAB_DATASETS: Partial<Record<TabId, DatasetKey[]>> = {
  netflow: ['banks'],
  bancos: ['banks'],
  cxp: ['cxp', 'pagos'],
  concursoMercantil: ['cxp', 'banks'],
  venta: ['cobranza', 'rol'],
  collections: ['cobranza', 'banks', 'rol'],
  fideicomiso: ['banks'],
  compras: ['compras'],
  pasivoDistribuir: ['compras'],
  pagos: ['pagos', 'banks', 'compras'],
  payroll: ['nomina'],
  financialProjection: ['cxp', 'cobranza', 'compras', 'pagos', 'nomina', 'rol', 'auxiliar'],
  financialPlanning: ['cxp', 'cobranza', 'compras', 'pagos', 'nomina', 'rol', 'auxiliar'],
  taxes: ['cxp', 'cobranza', 'compras', 'pagos', 'nomina', 'auxiliar', 'banks'],
  providers: [],
  clients: [],
  // Declares everything KpisObjectivesDashboard consumes (auxiliar/rol/compras/
  // nomina feed the auto-calculated KPIs) so a kpis-scoped user gets complete
  // numbers, not just the admin who happens to hold every permission.
  kpisObjectives: ['cxp', 'cobranza', 'banks', 'compras', 'nomina', 'rol', 'auxiliar'],
  // TEMPORAL fuentes-datos: cada sub-tab declara solo lo que su vista lee,
  // para no obligar a un usuario con un solo sub-tab a bajar todo el lake.
  fuentesBancos: ['banks'],
  fuentesJde: ['cxp', 'cobranza', 'compras', 'pagos', 'banks', 'auxiliar'],
  fuentesTress: ['nomina'],
  fuentesRol: ['rol'],
};

const KEEP_ALIVE_TABS = new Set<TabId>(['financialProjection', 'financialPlanning']);


// TEMPORAL fuentes-datos (2026-07-10): la sección `fuentes` es un tab de
// diagnóstico de frescura por fuente (Bancos/JDE/TRESS/ROL). Se retira
// completo poniendo el flag en `false` (lo oculta de la navegación) y después
// borrando los puntos marcados "TEMPORAL fuentes-datos" en este archivo,
// `types.ts`, `NavigationContext.tsx`, `appTabs.ts` y `src/modules/data-sources/`.
const FUENTES_DATOS_TEMP_ENABLED = true;

type SectionId = 'catalogos' | 'porPagar' | 'cobranza' | 'proyeccion' | 'objetivos' | 'fuentes' | 'admin';

/**
 * Section + tab order is the canonical sidebar ordering, grouped by money flow.
 *
 * Mental model (rename 2026-06-05):
 *   - Dashboard (forecast/escenarios + compromisos estructurados) — landing
 *     diario; Concurso Mercantil y Fideicomiso Dina viven aquí como
 *     compromisos contractuales junto a la proyección.
 *   - Ingresos (venta + cobranza + flujo neto) — va ANTES que Egresos.
 *   - Egresos (CXP, OC, pagos, nómina, impuestos).
 *   - Catálogos (datos maestros).
 * `SectionId` conserva sus ids internos (`proyeccion`/`cobranza`/`porPagar`)
 * para no romper consumidores; solo cambian las etiquetas visibles y el orden.
 */
const SECTIONS: { id: SectionId; label: string; icon: LucideIcon; description: string }[] = [
  { id: 'proyeccion', label: 'Dashboard',           icon: TrendingUp, description: 'Pronóstico, escenarios y compromisos' },
  { id: 'cobranza',   label: 'Ingresos',            icon: HandCoins,  description: 'Venta, cobranza y flujo neto' },
  { id: 'porPagar',   label: 'Egresos',             icon: CreditCard, description: 'CXP, órdenes, pagos, nómina e impuestos' },
  { id: 'catalogos',  label: 'Catálogos',           icon: BookUser,   description: 'Clientes, proveedores y bancos' },
  { id: 'objetivos',  label: 'Objetivos',           icon: Target,     description: 'KPIs y metas con seguimiento' },
  // TEMPORAL fuentes-datos: se quita de la navegación con el flag.
  ...(FUENTES_DATOS_TEMP_ENABLED
    ? [{ id: 'fuentes' as SectionId, label: 'Fuentes y Datos', icon: Database, description: 'Qué tan actualizada está cada fuente' }]
    : []),
  { id: 'admin',      label: 'Administración',      icon: UserCog,    description: 'Usuarios y permisos' },
];

const SUB_TABS: Record<SectionId, { id: TabId; label: string; icon: LucideIcon }[]> = {
  proyeccion: [
    { id: 'financialProjection', label: 'Proyección Financiera', icon: BarChart3 },
    { id: 'financialPlanning',   label: 'Planeación Financiera', icon: ClipboardList },
    { id: 'concursoMercantil',   label: 'Concurso Mercantil',    icon: Scale },
    { id: 'fideicomiso',         label: 'Fideicomiso Dina',      icon: ShieldCheck },
  ],
  cobranza: [
    { id: 'netflow',     label: 'Flujo Neto', icon: Wallet },
    { id: 'venta',       label: 'Venta',      icon: ShoppingCart },
    { id: 'collections', label: 'Cobranza',   icon: HandCoins },
  ],
  porPagar: [
    { id: 'cxp',     label: 'Antigüedad de Saldo', icon: Receipt },
    { id: 'compras', label: 'Órdenes de Compras',  icon: FolderOpen },
    { id: 'pasivoDistribuir', label: 'Pasivo por Distribuir', icon: PackageOpen },
    { id: 'pagos',   label: 'Pagos',               icon: CreditCard },
    { id: 'payroll', label: 'Nómina',              icon: Users },
    { id: 'taxes',   label: 'Impuestos', icon: Landmark },
  ],
  catalogos: [
    { id: 'clients',   label: 'Clientes',     icon: UserSquare },
    { id: 'providers', label: 'Proveedores',  icon: Users },
    { id: 'bancos',    label: 'Bancos',       icon: Landmark },
  ],
  objetivos: [
    { id: 'kpisObjectives', label: 'KPIs y Objetivos', icon: Target },
  ],
  // TEMPORAL fuentes-datos: un sub-tab por fuente externa.
  fuentes: [
    { id: 'fuentesBancos', label: 'Bancos',      icon: Landmark },
    { id: 'fuentesJde',    label: 'JDE',         icon: Database },
    { id: 'fuentesTress',  label: 'TRESS',       icon: Users },
    { id: 'fuentesRol',    label: 'ROL (CITI)',  icon: Truck },
  ],
  admin: [
    { id: 'users',    label: 'Usuarios', icon: UserCog },
    { id: 'permisos', label: 'Permisos', icon: SlidersHorizontal },
  ],
};

const SECTION_FOR_TAB: Partial<Record<TabId, SectionId>> = {
  clients: 'catalogos', providers: 'catalogos', bancos: 'catalogos',
  cxp: 'porPagar', compras: 'porPagar', pasivoDistribuir: 'porPagar', pagos: 'porPagar', payroll: 'porPagar', taxes: 'porPagar',
  netflow: 'cobranza', venta: 'cobranza', collections: 'cobranza',
  financialProjection: 'proyeccion', financialPlanning: 'proyeccion',
  concursoMercantil: 'proyeccion', fideicomiso: 'proyeccion',
  kpisObjectives: 'objetivos',
  // TEMPORAL fuentes-datos
  fuentesBancos: 'fuentes', fuentesJde: 'fuentes', fuentesTress: 'fuentes', fuentesRol: 'fuentes',
  users: 'admin', permisos: 'admin',
};

const DEFAULT_TAB: Record<SectionId, TabId> = {
  catalogos: 'clients',
  porPagar: 'cxp',
  cobranza: 'netflow',
  proyeccion: 'financialProjection',
  objetivos: 'kpisObjectives',
  fuentes: 'fuentesBancos', // TEMPORAL fuentes-datos
  admin: 'users',
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
    let bankLastQuery: BankQueryState | null = parsedQuery
      ? (isSantander || supplementalFromIdb.length > 0
          ? { ...parsedQuery, hasUploadedSantander: true }
          : parsedQuery)
      : null;

    // Synthesize a fallback lastQuery if IDB tiene statements pero localStorage
    // perdió `midas.bankLastQuery.v2` (cuota, reset, otra pestaña). Sin esto,
    // Bancos chequea `statements.length > 0 && lastQuery` y muestra el form
    // vacío aunque tengamos cientos de stmts hidratados.
    if (!bankLastQuery && bankJdeStatements.length > 0) {
      const latest = latestStatementDate(bankJdeStatements) ?? todayISO();
      bankLastQuery = {
        fechaEstadoCuenta: latest,
        formatoElectronico: 'SWIFT',
        hasUploadedSantander: bankSupplementalStatements.length > 0,
      };
      // eslint-disable-next-line no-console
      console.info(`[loadBankCaches] lastQuery synth desde IDB · fecha=${latest} · ${bankJdeStatements.length} stmts`);
    }

    return { bankJdeStatements, bankSupplementalStatements, bankLastQuery };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[loadBankCaches] failed:', err);
    return { bankJdeStatements: [], bankSupplementalStatements: [], bankLastQuery: null };
  }
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

type LoadedCiasSetter = (updater: (prev: Record<string, string>) => Record<string, string>) => void;

function validLoadedAt(value: string | undefined): string {
  if (value && Number.isFinite(new Date(value).getTime())) return value;
  return new Date().toISOString();
}

function patchLoadedCiasFromRecords<T extends { cia?: string }>(
  setter: LoadedCiasSetter,
  records: T[],
  loadedAt?: string,
): void {
  const cias = new Set(records.map(r => r.cia).filter((cia): cia is string => !!cia));
  if (cias.size === 0) return;
  const stamp = validLoadedAt(loadedAt);
  setter(prev => {
    let changed = false;
    const next = { ...prev };
    for (const cia of cias) {
      if (!next[cia]) {
        next[cia] = stamp;
        changed = true;
      }
    }
    return changed ? next : prev;
  });
}


function patchRolLoadedKeysFromRecords(
  setter: LoadedCiasSetter,
  records: RolRecord[],
  loadedAt?: string,
): void {
  const currentYear = new Date().getUTCFullYear();
  if (!records.some(record => record.anio === currentYear)) return;
  const key = `${currentYear}:full`;
  const stamp = validLoadedAt(loadedAt);
  setter(prev => (prev[key] ? prev : { ...prev, [key]: stamp }));
}

function useFrozenWhenInactive<T>(value: T, active: boolean): T {
  const ref = useRef(value);
  if (active) ref.current = value;
  return active ? value : ref.current;
}

function KeepAlivePanel({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div
      hidden={!active}
      aria-hidden={!active}
      style={{ display: active ? undefined : 'none' }}
    >
      {children}
    </div>
  );
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
  // StorageHealthGuard wiring (ver services/storageHealthGuard.ts).
  // El guard ya corrió síncrono en main.tsx antes de montar React; aquí solo
  // (a) leemos el flag si purgó este boot para informar al usuario, y (b)
  // marcamos boot complete cuando isBooted se vuelve true para que el
  // watchdog de la próxima sesión sepa que la app cerró bien.
  const toast = useToast();
  // RBAC: identidad + permisos del usuario actual. `can(tab)` decide qué
  // módulos se muestran. Ver src/contexts/AuthContext.tsx y src/config/roles.ts.
  const { can: canAccessTab, role: userRole, email: userEmail } = useAuth();
  // Datasets (APIs JDE/TRESS/bancos) que el usuario REALMENTE necesita = unión
  // de `TAB_DATASETS` sobre los tabs a los que tiene acceso. Un admin ve todos
  // los tabs → todos los datasets; un `user` sólo baja las APIs de sus módulos
  // (no cargar lo que no puede ver — ahorra red y memoria). `AppCore` sólo monta
  // tras el AuthGate, así que `canAccessTab` ya es correcto en el primer render.
  const allowedDatasets = useMemo(() => {
    const set = new Set<DatasetKey>();
    for (const tab of Object.keys(TAB_DATASETS) as TabId[]) {
      if (!canAccessTab(tab as AppTabId)) continue;
      for (const dataset of TAB_DATASETS[tab] ?? []) set.add(dataset);
    }
    return set;
  }, [canAccessTab]);
  // Ref espejo para leer el set actual desde callbacks estables (requestDatasets,
  // boot effects de bancos) sin invalidar su identidad en cada cambio de auth.
  const allowedDatasetsRef = useRef(allowedDatasets);
  useEffect(() => { allowedDatasetsRef.current = allowedDatasets; }, [allowedDatasets]);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  // Mobile navigation drawer (off-canvas). Desktop (lg+) renders the inline
  // section nav + sub-tab strip; below lg the sections collapse behind a
  // hamburger so the header never overflows a phone viewport.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  useEffect(() => {
    const notice = consumePurgeNotice();
    if (notice) {
      toast.info(purgeReasonMessage(notice.reason), { duration: 7000 });
    }
  }, [toast]);

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
  // request → fetchComprasRange parte el rango en chunks. Cargamos desde el
  // piso `defaultWindowFloor` (año en curso + 12 meses atrás) — cubre las OCs
  // aún abiertas dentro del crédito máximo de proveedor — y 3 meses hacia
  // adelante para ver OCs futuras ya capturadas en JDE.
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
  const [nominaHeavyHydrated, setNominaHeavyHydrated] = useState(false);
  // ROL CITI — viajes ejecutados (Senda Citi). Endpoint
  // http://srv-desarrollo:92/CITI/RolDiario liberado 2026-05-14. Auto-fetch
  // al boot desde 1° de enero del año en curso hasta hoy; alimenta
  // proyección de ingresos a corto plazo y cross-ref con cobranza por
  // `Factura`/`UUID_Fiscal` cuando el viaje ya se facturó.
  const [rolRecords, setRolRecords] = useState<RolRecord[]>([]);
  const [rolLoadedKeys, setRolLoadedKeys] = useState<Record<string, string>>({});
  // Viajes Especiales — API dev http://srv-desarrollo:95/ViajesEspeciales.
  // Trae viajes ad-hoc con Factura_JDE + Fecha_Factura + Dias_Credito por
  // viaje (no por catálogo). Auto-fetch al boot, mismo año base que ROL.
  // Sirve para (1) auto-poblar el grupo Viajes Especiales del catálogo y
  // (2) proyectar cobros que cobranza JDE aún no expone (`cxc:especial:`).
  const [viajesEspecialesRecords, setViajesEspecialesRecords] = useState<ViajeEspecialRecord[]>([]);
  const [viajesEspecialesLoadedKeys, setViajesEspecialesLoadedKeys] = useState<Record<string, string>>({});
  // Auxiliar contable JDE — endpoint /JDEdwards/AuxiliarContable. Libro
  // mayor posteado contra cuentas de banco/caja (objeto 1010-1020). Fuente
  // del motor de conciliación histórica banco↔ERP. Auto-fetch por-cía al
  // boot, desde 1° de enero del año en curso (misma ventana que bancos).
  const [auxiliarContableRecords, setAuxiliarContableRecords] = useState<AuxiliarContableRecord[]>([]);
  const [auxiliarContableLoadedCias, setAuxiliarContableLoadedCias] = useState<Record<string, string>>({});
  // Libro mayor de cuentas de IVA (acreditable + causado) — fetch SEPARADO con
  // descubrimiento por nombre de cuenta (ver fetchAuxiliarContableIvaRange).
  // Fuente del IVA REAL autoritativo del módulo de Impuestos.
  const [auxiliarIvaRecords, setAuxiliarIvaRecords] = useState<AuxiliarContableRecord[]>([]);
  const [auxiliarIvaLoadedCias, setAuxiliarIvaLoadedCias] = useState<Record<string, AuxiliarIvaLoadedCiaMeta>>({});
  // Status del auto/manual fetch de cobranza — se muestra en la pestaña
  // Cobranza para que el usuario sepa qué pasó si la lista llega vacía.
  // Antes los errores eran silenciados y resultaba imposible diagnosticar
  // 0% de cruce sin abrir DevTools.
  const [cobranzaError, setCobranzaError] = useState<string | null>(null);
  const [cobranzaRefreshing, setCobranzaRefreshing] = useState(false);
  const [cashFlowOverrides, setCashFlowOverrides] = useState<CashFlowOverrides>({});
  // Proyección Financiera is the daily landing surface for treasury (the old
  // Dashboard tab was merged into it). Opens to the same numbers that match
  // keyboard `1`.
  const [activeTab, setActiveTab] = useState<TabId>('financialProjection');
  /**
   * Stable navigation handler.
   *
   * The previous inline arrow recreated `goTo` every parent render, which
   * churned the `NavigationProvider` context value on every keystroke /
   * background poll. `useCallback` here keeps the navigation context stable
   * while heavy dashboards warm in workers.
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
  // Track navigation transitions for runtime diagnostics. `setActiveTab` is
  // called from many sites — a single effect on `activeTab` catches all of
  // them and records heap usage at the moment of transition. Helps correlate
  // crashes/freezes with the user's last module switch.
  const prevTabRef = useRef<TabId | null>(null);
  useEffect(() => {
    const prev = prevTabRef.current;
    if (prev !== activeTab) {
      trackNavigation(activeTab, prev ?? undefined);
      prevTabRef.current = activeTab;
    }
  }, [activeTab]);

  // ── Defensa de memoria a nivel app (siempre viva) ─────────────────────────
  // Hueco que cerramos: los pressure handlers de los dashboards financieros solo
  // existen mientras esos paneles están montados, y el keep-alive está capado a
  // UN tab pesado. Al entrar a Nómina (u otro módulo) NO quedaba NADIE
  // registrado para liberar memoria → el OOM ganaba. Este handler vive en el
  // shell, así que libera sin importar el tab activo. Se registra una sola vez.
  const activeTabRef = useRef<TabId>(activeTab);
  activeTabRef.current = activeTab;
  useEffect(() => {
    const releaseRebuildable = () => {
      // Orden: primero las corridas (más gordas y más baratas de reconstruir),
      // luego el source canónico, luego el worker (suelta su copia del heavy
      // bundle ~100k movimientos + pipelines). Todo es rebuildable desde el
      // state ya hidratado — pagamos un recompute (segundos) y evitamos el OOM.
      try { clearProjectionRunCache(); } catch { /* ignore */ }
      try { clearProjectionSourceCache(); } catch { /* ignore */ }
      try { resetScenarioRunWorker(); } catch { /* ignore */ }
    };
    const unsubPressure = onMemoryPressure(releaseRebuildable);
    const unsubEmergency = onMemoryEmergency(() => {
      // Última línea de defensa: ya liberamos caches y el heap SIGUE >90%.
      // Degradamos la UI controladamente — mejor que Chrome mate la pestaña.
      releaseRebuildable();
      const HEAVY_TABS = new Set<TabId>(['financialProjection', 'financialPlanning', 'payroll']);
      if (HEAVY_TABS.has(activeTabRef.current)) {
        setActiveTab('bancos'); // desmonta el árbol pesado del tab actual
        try {
          toast.info(
            'Liberé memoria para evitar un cierre inesperado. Vuelve al módulo cuando quieras.',
            { duration: 8000 },
          );
        } catch { /* ignore */ }
      }
    });
    return () => { unsubPressure(); unsubEmergency(); };
  }, [toast]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  // Flag aparte de catalogLoaded — éste indica que loadStore() (light de
  // localStorage v12 + heavies de IDB) terminó de hidratar el state. Los boot
  // effects que necesitan saber si hay registros previos (compras, pago,
  // banks, cxp, cobranza) gatean en esto para no disparar fetches con state
  // vacío y luego sobreescribirlo. catalogLoaded se setea cuando los CSVs
  // de clients/providers terminan, no cuando loadStore terminó.
  const [storeHydrated, setStoreHydrated] = useState(false);
  // Clear-on-entry gate: la hidratación del store + el load de caches de banco
  // esperan a que esto sea true, para no leer un store que está por borrarse.
  const [cacheCleared, setCacheCleared] = useState(false);

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
    compras: BootTaskStatus;
    pagos: BootTaskStatus;
    nomina: BootTaskStatus;
    rol: BootTaskStatus;
    auxiliar: BootTaskStatus;
    projection: BootTaskStatus;
  }>({
    catalog: 'loading',
    companies: 'loading',
    banks: 'loading',
    cxp: 'pending',
    cobranza: 'pending',
    compras: 'pending',
    pagos: 'pending',
    nomina: 'pending',
    rol: 'pending',
    auxiliar: 'pending',
    projection: 'loading',
  });
  const [, setCxpBootProgress] = useState<{ done: number; total: number } | null>(null);
  const [, setCobranzaBootProgress] = useState<{ done: number; total: number } | null>(null);
  const [, setRolBootProgress] = useState<{ done: number; total: number } | null>(null);
  // Modo snapshot: cuando el arranque hidrató desde el snapshot compartido, los
  // slots cubiertos quedan 'done' y no deben re-abrirse por los auto-fetch delta
  // (que corren detrás del dashboard). Ref (síncrono) para que el guard de
  // `setBootSlot` lo lea sin re-crear el callback.
  const snapshotActiveRef = useRef(false);
  const setBootSlot = useCallback(
    (slot: 'catalog' | 'companies' | 'banks' | 'cxp' | 'cobranza' | 'compras' | 'pagos' | 'nomina' | 'rol' | 'auxiliar' | 'projection', status: BootTaskStatus) => {
      // En modo snapshot los slots cubiertos están congelados en 'done': ignoramos
      // cualquier transición de los auto-fetch delta para no re-gatear el splash.
      if (snapshotActiveRef.current && SNAPSHOT_COVERED_SLOTS.has(slot)) return;
      setBootStatus(prev => (prev[slot] === status ? prev : { ...prev, [slot]: status }));
    },
    [],
  );
  const [isBooted, setIsBooted] = useState(false);
  const [splashMounted, setSplashMounted] = useState(true);
  const [requestedDatasets, setRequestedDatasets] = useState<Set<DatasetKey>>(() => new Set(['banks']));
  const [datasetStatus, setDatasetStatus] = useState<Record<DatasetKey, DatasetStatus>>({
    cxp: 'idle',
    cobranza: 'idle',
    compras: 'idle',
    pagos: 'idle',
    nomina: 'idle',
    rol: 'idle',
    banks: 'loading',
    auxiliar: 'idle',
  });
  const requestDatasets = useCallback((keys: DatasetKey[]) => {
    // Sólo se piden datasets que el usuario necesita según sus módulos visibles.
    // Un `user` sin acceso a un módulo NO dispara la API de ese módulo.
    const allowed = allowedDatasetsRef.current;
    const filtered = keys.filter(key => allowed.has(key));
    if (filtered.length === 0) return;
    setRequestedDatasets(prev => {
      let changed = false;
      const next = new Set(prev);
      for (const key of filtered) {
        if (!next.has(key)) {
          next.add(key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);
  const setDatasetSlot = useCallback((key: DatasetKey, status: DatasetStatus) => {
    setDatasetStatus(prev => (prev[key] === status ? prev : { ...prev, [key]: status }));
  }, []);
  // Datasets cuya hidratación desde IDB ya terminó. Los auto-fetch de boot
  // (cxp/cobranza/compras/pagos/rol) DEBEN esperar este flag antes de decidir si
  // refetchear: si corren antes, ven los records en 0 y disparan un fetch JDE
  // completo aunque IDB tuviera la cache. Ver hydrateDataset() + boot effects.
  const [idbHydratedDatasets, setIdbHydratedDatasets] = useState<Set<DatasetKey>>(() => new Set());

  // ── Carga diferida de años históricos (DataWindowContext) ──────────────
  // El boot baja SÓLO la ventana por defecto (`defaultWindowFloor`: año en
  // curso + 12 meses atrás). Cuando una vista con navegación por año consulta
  // un año MÁS ANTIGUO que ese piso, llama `ensureYearLoaded(year, datasets)`;
  // el controlador de backfill (abajo) fetchea ese rango, lo mergea al
  // heavy-store y re-renderiza. Es session-scoped: bajo el default
  // `clear-on-entry` cada ingreso re-baja la ventana por defecto de todas
  // formas, así que no persistimos el piso solicitado.
  const dataWindowDefaultFloor = useMemo(() => defaultWindowFloor(), []);
  const [historicalFloorByDataset, setHistoricalFloorByDataset] = useState<Record<string, string>>({});
  const [historicalLoadingByDataset, setHistoricalLoadingByDataset] = useState<Record<string, boolean>>({});
  const [backfillTick, setBackfillTick] = useState(0);
  const ensureYearLoaded = useCallback((year: number, datasets: string[]) => {
    const target = yearStartISO(year);
    // El año ya cae dentro de la ventana por defecto → nada que bajar.
    if (target >= dataWindowDefaultFloor) return;
    const allowed = allowedDatasetsRef.current;
    // Un rango que FALLÓ (marcado por el controlador de backfill) se
    // desbloquea cuando la vista vuelve a pedir el año — reintento deliberado.
    let clearedFailure = false;
    for (const ds of datasets) {
      if (!allowed.has(ds as DatasetKey)) continue;
      if (backfillFailedFloorRef.current[ds] !== undefined) {
        delete backfillFailedFloorRef.current[ds];
        clearedFailure = true;
      }
    }
    if (clearedFailure) setBackfillTick(t => t + 1);
    setHistoricalFloorByDataset(prev => {
      let changed = false;
      const next = { ...prev };
      for (const ds of datasets) {
        if (!allowed.has(ds as DatasetKey)) continue; // no bajes lo que el usuario no ve
        const current = next[ds] ?? dataWindowDefaultFloor;
        if (target < current) { next[ds] = target; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [dataWindowDefaultFloor]);
  const isLoadingHistorical = useCallback(
    (datasets: string[]) => datasets.some(ds => historicalLoadingByDataset[ds]),
    [historicalLoadingByDataset],
  );
  // Timestamp del light store cargado desde localStorage. Sirve para reparar
  // mapas de TTL faltantes cuando el heavy sí existe en IDB pero el light quedó
  // incompleto/stale por un cierre durante boot. No actualiza timestamps viejos:
  // sólo rellena huecos para evitar refetch perpetuo de caches válidos.
  const lightStoreLastSavedRef = useRef<string | undefined>(undefined);

  // ── JDE integration state ──
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companiesLoadedAt, setCompaniesLoadedAt] = useState<string | undefined>(undefined);
  // True una vez que el cache local hidrató companies. Permite a
  // loadCompanies() saber que no debe bloquear el splash con 'loading' aunque
  // se haya disparado antes de que React aplique el set del cache.
  const companiesHydratedFromCacheRef = useRef(false);
  // Company filtering was removed app-wide (replaced by the global scenario
  // selector in the header). `selectedCia` is pinned to 'all' so the ~39
  // downstream consumers (`companyCode={selectedCia}` / `selectedCia=…`) keep
  // working unchanged — every module just shows all companies now. The
  // company *catalog* (`companies`) is still loaded; boot per-cia fetch loops
  // need it. Only the user-facing filter UI + company groups are gone.
  const selectedCia = 'all';
  // Getters unused since the company selector was removed; setters still
  // fire from loadCompanies()/boot so the catalog fetch keeps its state.
  const [, setCompaniesLoading] = useState(false);
  const [, setCompaniesError] = useState<string | null>(null);
  // Bank-statement caches start empty and hydrate from localStorage on idle
  // (see `bankCacheHydrationEffect` below). The splash screen masks any
  // first-paint where the data is still empty, so the lift moves the
  // multi-MB JSON.parse off the critical render path without a UX cost.
  const [bankJdeStatements, setBankJdeStatements] = useState<BankAccountStatement[]>([]);
  const [bankSupplementalStatements, setBankSupplementalStatements] = useState<BankAccountStatement[]>([]);
  const [bankLastQuery, setBankLastQuery] = useState<BankQueryState | null>(null);
  // Timestamp de la última sincronización exitosa de bancos (solo para la UI
  // de Salud de datos — bancos no lleva mapa `*LoadedCias` por-cía).
  const [banksLastSync, setBanksLastSync] = useState<string | null>(null);
  const [bankCacheLoaded, setBankCacheLoaded] = useState(false);
  // Hydrate bank caches on idle. Las statements (jde + supplemental) viven en
  // IDB heavy-store. bankLastQuery sigue en localStorage (es chico). Diferido
  // a idle para no bloquear LCP — el splash cubre la UI hasta que el boot de
  // bancos termina. Signal `bankCacheLoaded` para que el step 2 del backfill
  // sepa cuándo arrancar.
  // PERF: prefetch de bundles después del boot. Los módulos están bajo
  // `lazy()` (líneas 52-65) — sin prefetch, el primer click en cada tab
  // descarga + parsea + evalúa el chunk en el camino crítico de navegación.
  // Disparamos `import()` para los 4 más usados en idle post-boot. El cache
  // del navegador y el módulo de Vite reusan el chunk en el render real, así
  // que el click final sólo paga el costo del montaje React, no la red.
  useEffect(() => {
    if (!isBooted) return;
    return scheduleIdleTask(() => {
      // Best-effort: si un chunk no baja (offline / redeploy), el lazy() real
      // reintenta al click — el prefetch fallido no debe ser unhandled rejection.
      const swallow = () => {};
      void import('./modules/financial-projection/pages/FinancialProjectionDashboard').catch(swallow);
      void import('./modules/financial-planning/pages/FinancialPlanningDashboard').catch(swallow);
      void import('./components/CXP').catch(swallow);
      void import('./components/Bancos').catch(swallow);
      void import('./components/CollectionProjection').catch(swallow);
    }, 5000);
  }, [isBooted]);

  useEffect(() => {
    if (!cacheCleared) return;
    return scheduleIdleTask(() => {
      void loadBankCaches().then((caches) => {
        // PERF: wrap los set-state en startTransition. Los arrays bancarios
        // hidratados desde IDB son grandes (multi-MB) y disparan re-render +
        // merge + N memos downstream — todo en una sola tarea sync. Sin
        // startTransition esa cascada competía con el LCP cuando el idle
        // callback corría temprano. Con la transición React procesa el set
        // como work interrumpible y deja pintar primero. `bankCacheLoaded`
        // sigue urgente (gates de UI dependen de él).
        startTransition(() => {
          if (caches.bankJdeStatements.length) setBankJdeStatements(caches.bankJdeStatements);
          if (caches.bankSupplementalStatements.length) setBankSupplementalStatements(caches.bankSupplementalStatements);
          if (caches.bankLastQuery) setBankLastQuery(caches.bankLastQuery);
          setBankCacheLoaded(true);
        });
      });
    });
  }, [cacheCleared]);
  // Drop globally-excluded accounts (empresa 33 / multicarga) here, not only at
  // the JDE fetch layer: stale IDB/localStorage bank caches hydrated at boot
  // (loadBankCaches), the daily-cache path and manual uploads all feed this
  // memo without passing through fetchBankStatements. This is the single
  // chokepoint every bank consumer reads from (same spot as excludeBajio).
  //
  // PERF: defer the raw arrays BEFORE the merge. `mergeBankStatements` sorts +
  // dedupes potentially years of movements × N accounts and was running inside
  // the LCP-blocking task at boot. Deferring the inputs reagenda el merge
  // como work de baja prioridad — el LCP pinta primero, el merge se computa
  // mientras el thread está libre. Mismo patrón que ya usa cxpRecordsDeferred /
  // pagoProveedorRecordsDeferred más abajo.
  const bankJdeStatementsDeferred = useDeferredValue(bankJdeStatements);
  const bankSupplementalStatementsDeferred = useDeferredValue(bankSupplementalStatements);
  const bankStatements = useMemo(
    () => {
      try { performance.mark?.('bankStatements:merge:start'); } catch { /* noop */ }
      const merged = mergeBankStatements(bankJdeStatementsDeferred, bankSupplementalStatementsDeferred).filter(
        s => !matchesExclusionIdentity({ cia: s.cia }),
      );
      try {
        performance.mark?.('bankStatements:merge:end');
        performance.measure?.('bankStatements:merge', 'bankStatements:merge:start', 'bankStatements:merge:end');
      } catch { /* noop */ }
      return merged;
    },
    [bankJdeStatementsDeferred, bankSupplementalStatementsDeferred],
  );
  // BAJIO ahora SÍ se contabiliza y se proyecta (decisión 2026-06-04): el
  // barrido Bajío→Banamex trae su propio egreso, que empata con el ingreso en
  // Banamex, así que incluir ambos lados netea solo. `accountableBankStatements`
  // == todos los estados (ya sin Multicarga/empresa 33 vía EXCLUSION_RULES).
  const accountableBankStatements = bankStatements;
  // Bajío se separa aquí (además de contar en accountable) porque el módulo de
  // planeación lo sigue usando para re-inyectar el flujo del fideicomiso Dina.
  const bajioStatements = useMemo(
    () => bankStatements.filter(isBajioStatement),
    [bankStatements],
  );
  // PERF (2026-05-14): los heavy memos (paymentReconciliation,
  // payrollMonthlyActualJDE, etc.) iteran cientos de miles
  // de records por commit de boot. Sin deferred React procesa el memo dentro
  // del mismo paint que el setState, pinea el thread 200-500ms+ y bloquea
  // clicks/scroll. Con `useDeferredValue` el memo se reagenda como work de
  // baja prioridad — clicks y scroll responden mientras el cómputo avanza
  // detrás. El valor diferido converge al actual cuando el thread está libre.
  const cxpRecordsDeferred = useDeferredValue(cxpRecords);
  const pagoProveedorRecordsDeferred = useDeferredValue(pagoProveedorRecords);
  // Recon de pagos SÍ ve Bajío: las amortizaciones AFP del fideicomiso DINA
  // salen por la cuenta BanBajio 33850201 y sin estos statements los pagos
  // quedan huérfanos. El engine matchea por banco-sentinel "BANBAJIO" cuando
  // detecta cuenta no-numérica. No afecta proyección ni Bancos UI — esos
  // siguen usando `accountableBankStatements`.
  const reconBankStatements = useMemo(() => bankStatements, [bankStatements]);
  const reconBankStatementsDeferred = useDeferredValue(reconBankStatements);
  const nominaRecordsDeferred = useDeferredValue(nominaRecords);
  const comprasRecordsDeferred = useDeferredValue(comprasRecords);
  // ── Cruce pagos ↔ CXP ↔ banco (motor de PagoProveedor) ────────────────
  // PERF (2026-05-14): antes corría sync en useMemo sobre 39k pagos × 9.5k
  // CXP × bankStmts → 2-10s de main thread pinned por cada commit de boot.
  // Ahora vive en Web Worker; el render no espera. Mientras se calcula,
  // downstream usa `emptyPaymentReconciliationResult()` (no rompe nada — el
  // canonical filtra paidCxpKeys vacío, mostrando todas las CXP como
  // pendientes, lo que es OK durante boot ya que planning espera a isBooted).
  const [paymentReconciliation, setPaymentReconciliation] = useState<PaymentReconciliationResult>(
    () => emptyPaymentReconciliationResult(),
  );
  const paymentReconWorkerRef = useRef<Worker | null>(null);
  const paymentReconJobRef = useRef(0);
  useEffect(() => {
    // No correr durante boot — los datos llegan en stream y dispararíamos
    // el worker N veces con datos parciales, pinando el cascade downstream.
    // Sólo después de que el splash dismiss disparamos UNA corrida con todo
    // el dataset en su sitio.
    if (!isBooted) return;
    if (
      pagoProveedorRecordsDeferred.length === 0 ||
      cxpRecordsDeferred.length === 0 ||
      reconBankStatementsDeferred.length === 0
    ) {
      setPaymentReconciliation(emptyPaymentReconciliationResult());
      return;
    }

    let cancelled = false;
    const jobId = ++paymentReconJobRef.current;

    const runFallback = () => {
      const t0 = performance.now();
      try {
        const result = reconcilePayments({
          payments: pagoProveedorRecordsDeferred,
          cxpRecords: cxpRecordsDeferred,
          bankStatements: reconBankStatementsDeferred,
        });
        if (!cancelled && paymentReconJobRef.current === jobId) {
          setPaymentReconciliation(result);
        }
      } catch (err) {
        console.warn('[paymentRecon] fallback failed', err);
      }
      // eslint-disable-next-line no-console
      console.info(`[paymentRecon] fallback sync ${(performance.now() - t0).toFixed(0)}ms`);
    };

    // Debounce 600ms para colapsar bursts de boot (cxp commit + pagoProveedor
    // commit + banks commit caen casi juntos → 1 sola corrida del worker).
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      if (typeof Worker === 'undefined') {
        runFallback();
        return;
      }
      try {
        if (!paymentReconWorkerRef.current) {
          paymentReconWorkerRef.current = new Worker(
            new URL('./workers/paymentReconciliation.worker.ts', import.meta.url),
            { type: 'module' },
          );
        }
        const worker = paymentReconWorkerRef.current;
        worker.onmessage = (event: MessageEvent<PaymentReconciliationWorkerResponse>) => {
          if (cancelled || event.data.jobId !== paymentReconJobRef.current) return;
          if (event.data.result) {
            setPaymentReconciliation(event.data.result);
          } else if (event.data.error) {
            console.warn('[paymentRecon] worker error, fallback', event.data.error);
            runFallback();
          }
        };
        worker.onerror = (event) => {
          if (cancelled) return;
          console.warn('[paymentRecon] worker exception, fallback', event.message);
          runFallback();
        };
        worker.postMessage({
          jobId,
          payments: pagoProveedorRecordsDeferred,
          cxpRecords: cxpRecordsDeferred,
          bankStatements: reconBankStatementsDeferred,
        });
      } catch (err) {
        console.warn('[paymentRecon] worker spawn failed, fallback', err);
        runFallback();
      }
    }, 600);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isBooted, pagoProveedorRecordsDeferred, cxpRecordsDeferred, reconBankStatementsDeferred]);

  useEffect(() => {
    return () => {
      paymentReconWorkerRef.current?.terminate();
      paymentReconWorkerRef.current = null;
    };
  }, []);
  // PERF (2026-05-14): defiero también el resultado del worker para que el
  // cascade downstream (paidCxpKeys → nonInternalPagoProveedor →
  // purchaseReceiptsFromCompras) no se dispare sync dentro del mismo paint
  // que setPaymentReconciliation.
  const paymentReconciliationDeferred = useDeferredValue(paymentReconciliation);
  const nonInternalPagoProveedorRecords = useMemo(() => {
    const internalKeys = paymentReconciliationDeferred.internalPaymentKeys;
    if (internalKeys.size === 0) return pagoProveedorRecordsDeferred;
    return pagoProveedorRecordsDeferred.filter((record) => !internalKeys.has(`${record.cia}::${record.noPago}`));
  }, [pagoProveedorRecordsDeferred, paymentReconciliationDeferred]);
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
  // Company filter removed → reconciliation always runs over all cias.
  const activeReconciliationCias: string[] | undefined = undefined;
  const activeReconciliationCiaKey = 'all';
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
              ciaFilter: undefined,
              cobranzaPayments,
            });
            if (!cancelled && reconciliationJobRef.current === jobId) setCobranzaReconciliation(result);
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.warn('[reconciliation] fallback no disponible (chunk/compute falló)', err);
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

  // ── Cruce AuxiliarContable ↔ bancos (conciliación histórica) ──────────
  // Motor nuevo: cruza el libro mayor JDE contra el estado de cuenta. Corre
  // en su propio worker, diferido a idle, solo cuando una pestaña que lo
  // consume está activa. Alimenta la pantalla Conciliación y, vía
  // `adaptAuxiliarForProjection`, la validación de cobrado/pagado de la
  // proyección.
  const [auxiliarReconciliation, setAuxiliarReconciliation] = useState<AuxiliarReconResult>(
    () => emptyAuxiliarReconResult(),
  );
  const shouldComputeAuxiliarReconciliation =
    auxiliarContableRecords.length > 0 && RECONCILIATION_TABS.has(activeTab);
  // Facturas confirmadas como cobradas en el Auxiliar Contable — corroboración
  // GL (best-effort) para el panel de cuadre cobranza-aplicada↔banco. Vacío si
  // el auxiliar no está cargado en este tab (no se fuerza su carga).
  const cobranzaGlConfirmedKeys = useMemo(
    () => glConfirmedInvoiceKeysFromSourceConfirmation(auxiliarReconciliation.sourceConfirmation),
    [auxiliarReconciliation],
  );
  const auxiliarReconWorkerRef = useRef<Worker | null>(null);
  const auxiliarReconJobRef = useRef(0);
  useEffect(() => {
    if (auxiliarContableRecords.length === 0) {
      setAuxiliarReconciliation(emptyAuxiliarReconResult());
      return;
    }
    if (!shouldComputeAuxiliarReconciliation) return;

    let cancelled = false;
    const jobId = ++auxiliarReconJobRef.current;
    const cancelIdle = scheduleIdleTask(() => {
      const runFallback = () => {
        if (cancelled || auxiliarReconJobRef.current !== jobId) return;
        const result = reconcileAuxiliar(auxiliarContableRecords, accountableBankStatements);
        if (!cancelled && auxiliarReconJobRef.current === jobId) setAuxiliarReconciliation(result);
      };

      if (typeof Worker === 'undefined') {
        runFallback();
        return;
      }

      try {
        if (!auxiliarReconWorkerRef.current) {
          auxiliarReconWorkerRef.current = new Worker(
            new URL('./workers/auxiliarReconciliation.worker.ts', import.meta.url),
            { type: 'module' },
          );
        }
        const worker = auxiliarReconWorkerRef.current;
        worker.onmessage = (event: MessageEvent<AuxiliarReconciliationWorkerResponse>) => {
          if (cancelled || event.data.jobId !== auxiliarReconJobRef.current) return;
          if (event.data.result) setAuxiliarReconciliation(event.data.result);
          else runFallback();
        };
        worker.onerror = () => {
          if (!cancelled && auxiliarReconJobRef.current === jobId) runFallback();
        };
        worker.postMessage({
          jobId,
          records: auxiliarContableRecords,
          bankStatements: accountableBankStatements,
        });
      } catch {
        runFallback();
      }
    }, 1500);

    return () => {
      cancelled = true;
      cancelIdle();
    };
  }, [auxiliarContableRecords, accountableBankStatements, shouldComputeAuxiliarReconciliation]);
  useEffect(() => {
    return () => {
      auxiliarReconWorkerRef.current?.terminate();
      auxiliarReconWorkerRef.current = null;
    };
  }, []);
  // UI status for the auto/manual bank refresh — shown as a pill in Flujo Neto.
  const [bankFetchStatus, setBankFetchStatus] = useState<
    'idle' | 'priming' | 'ranging'
  >('idle');
  const [bankFetchProgress, setBankFetchProgress] = useState<
    { done: number; total: number } | null
  >(null);
  const [bankCoverageLoading, setBankCoverageLoading] = useState(false);

  // Caja inicial = Σ saldoInicial bancario real (incluye Bajío). Antes había un
  // ancla hardcoded de 76.3M para "principio de año"; obsoleto desde que toda
  // la información bancaria está cargada. `calculateInitialCash` con
  // `startingBalance=undefined` cae a sumar saldoInicial de los estados de
  // cuenta provistos.

  // OCs (Compras) traducidas a PurchaseReceiptRecord para alimentar el motor
  // canónico de proyección. Emite DOS tipos:
  //   - CONFIRMED: OC ya recibida, fecha de pago = recepción + díasCrédito.
  //   - PROJECTED: OC pedida sin recepción, fecha de pago estimada con lead
  //     time histórico por familia (alimenta forecast largo plazo).
  // Filtros: cancelados, workflow JDE cerrado (Edo_Sig), importes ≤ 0, fechas
  // pasadas. El motor canónico hace dedup vs CXP (no doble-conteo). Memoizado
  // por comprasRecords.
  // PERF (2026-05-14): comprasToPurchaseReceipts itera comprasRecords ×
  // (cxpRecords + pagoProveedorRecords) sync — varios cientos de ms con data
  // real. Antes de isBooted devolvemos [] vacío para que el splash no se pegue
  // con esta cascada; planning espera a isBooted para montarse, así que el
  // gate no afecta UX. Después de boot, corre con deferred values (low prio).
  // OOM ROOT CAUSE (data real: 332,586 comprasRecords / 2 años). The two
  // heavy consumers below iterate ALL compras on the main thread + build
  // lead-time stats + credit overlay over the full set → renderer OOM
  // ("Aw Snap code 5") while idle once the heavy store hydrates. A forward
  // cash projection cannot use OCs whose payment is long past (they're
  // dropped downstream as dueDate < asOfDate anyway) and recent lead-time /
  // cadence is more representative than 2-year-old history. Window to the
  // last ~270 days + everything forward-dated. State stays full (Compras /
  // taxes views untouched) — only the projection path sees the slice.
  // Business rule (user): an OC whose PROJECTED PAYMENT date (fechaPagoProyectada,
  // API COMPRAS) is before today must NOT appear — a forward cash projection
  // never shows already-past projected payments. This is also the structural
  // volume fix: with 332k historical OCs, dropping every past-pay one cuts the
  // canonical from ~210k movements to a fraction → every rebuild/clone cheap,
  // ends the OOM across all triggers. OCs without fechaPagoProyectada are
  // not-yet-received PROJECTED orders (payment is future by construction) — kept.
  // State stays full (Compras / taxes views untouched); only the projection slice.
  const comprasForProjection = useMemo(() => {
    if (!isBooted) return comprasRecordsDeferred;
    const today = todayISO();
    const src = comprasRecordsDeferred;
    const out = selectComprasForProjection(src, today);
    // eslint-disable-next-line no-console
    console.info(`[compras] projection: ${out.length}/${src.length} (drop fechaPagoProyectada < ${today})`);
    return out;
  }, [isBooted, comprasRecordsDeferred]);

  const purchaseReceiptsFromCompras = useMemo(
    () => {
      if (!isBooted) return [];
      return comprasToPurchaseReceipts(comprasForProjection, {
        asOfDate: todayISO(),
        includeProjected: true,
        excludePastUnexecuted: true,
        futureOrderLookaheadMonths: COMPRAS_FUTURE_LOOKAHEAD_MONTHS,
        cxpRecords: cxpRecordsDeferred,
        pagoProveedorRecords: nonInternalPagoProveedorRecords,
      });
    },
    [isBooted, comprasForProjection, cxpRecordsDeferred, nonInternalPagoProveedorRecords],
  );

  const purchaseReceiptsForTaxes = useMemo(
    () => {
      if (!isBooted) return [];
      const today = todayISO();
      const fiscalYearStart = `${today.slice(0, 4)}-01-01`;
      const paidAuxOcKeys = new Set<string>();
      for (const [key, confirmation] of auxiliarReconciliation.sourceConfirmation) {
        if (!confirmation.confirmed || confirmation.flujo !== 'egreso') continue;
        if (!key.startsWith('oc:')) continue;
        paidAuxOcKeys.add(key.slice('oc:'.length));
      }
      for (const line of auxiliarReconciliation.lines) {
        if (line.flujo !== 'egreso' || line.source.kind !== 'oc') continue;
        if (
          line.matchTier !== 'jde-reconciled'
          && line.matchTier !== 'exact'
          && line.matchTier !== 'tolerance'
          && line.matchTier !== 'cross-account'
        ) continue;
        paidAuxOcKeys.add(`${line.cia}::${line.source.ref}`);
      }
      const comprasFiscalSlice = comprasRecordsDeferred.filter((record) => {
        const pay = record.fechaPagoProyectada ? String(record.fechaPagoProyectada).slice(0, 10) : '';
        const receipt = record.fechaRecepcion ? String(record.fechaRecepcion).slice(0, 10) : '';
        const order = record.fechaPedido ? String(record.fechaPedido).slice(0, 10) : '';
        const paidByAux = record.noOrden ? paidAuxOcKeys.has(`${record.cia}::${record.noOrden}`) : false;
        return (pay && pay >= fiscalYearStart)
          || (receipt && receipt >= fiscalYearStart)
          || paidByAux
          || (!pay && order && order >= fiscalYearStart);
      });
      return comprasToPurchaseReceipts(comprasFiscalSlice, {
        asOfDate: today,
        includeProjected: false,
        excludePastUnexecuted: false,
        includePastConfirmed: true,
        cxpRecords: cxpRecordsDeferred,
        pagoProveedorRecords: nonInternalPagoProveedorRecords,
      });
    },
    [isBooted, auxiliarReconciliation, comprasRecordsDeferred, cxpRecordsDeferred, nonInternalPagoProveedorRecords],
  );

  // Promedio de gasto por proveedor en los últimos 3 meses calendario,
  // derivado de PagoProveedor real. Sobrescribe `montoPromedioPago` y
  // `gastoMinimoMensual` del catálogo para que el piso operativo refleje
  // el ritmo de pago vigente, no el promedio anual 2025.
  const providerSpendIndex = useMemo(
    () => buildProviderSpendIndex(isBooted ? nonInternalPagoProveedorRecords : [], { months: 3 }),
    [isBooted, nonInternalPagoProveedorRecords],
  );

  // Piso operativo de nómina = promedio mensual real sobre los últimos 3 meses
  // cerrados. Excluye el mes en curso (datos parciales). Filtra por cia si está
  // activa.
  // Fórmula: Σ_3m CASH_OUT / 3 (= Σ Percepciones, "Nómina Bruta" del KPI).
  //
  // Usamos gross y no neto porque éste es el "piso operativo" en términos de
  // costo de nómina contratado; coincide con el KPI "Nómina Bruta" que el
  // usuario lee en el módulo de Nómina mes a mes.
  //
  // Filtra meses con carga parcial usando `reducCount / cashCount`. Una
  // nómina real tiene ~1 deducción por cada percepción (ISR + IMSS empleado
  // + préstamos); ratio < 0.3 indica que el response solo trajo una quincena
  // o llegó truncado. Sin este filtro los parciales tiraban el promedio.
  const payrollMonthlyActualJDE = useMemo(() => {
    if (!isBooted) return undefined;
    if (nominaRecordsDeferred.length === 0) return undefined;
    // Piso de nómina = promedio de las últimas 4 semanas CERRADAS × 4.33.
    // Antes era UNA sola semana, pero la nómina alterna semana normal / semana
    // con quincena, así que el piso oscilaba ~$41M–$65M según el día en que se
    // abría la app contra un gasto real de ~$49.7M/mes. El detalle (con las
    // cifras medidas en BD) vive en `payrollOperatingFloor.ts`.
    // Company filter removed → never scope payroll by cia (all companies).
    return computePayrollMonthlyFloor(nominaRecordsDeferred, {
      todayIso: todayISO(),
      ciaFilter: '',
    }).monthly;
  }, [isBooted, nominaRecordsDeferred, selectedCia]);

  const confirmPayment = (p: ConfirmedPayment) => setConfirmedPayments(prev => [...prev, p]);
  const unconfirmPayment = (key: string) => setConfirmedPayments(prev => prev.filter(x => x.key !== key));

  // ── New UI features state ──
  const { open: cmdOpen, setOpen: setCmdOpen } = useCommandPalette();
  const [activityOpen, setActivityOpen] = useState(false);
  const [dataHealthOpen, setDataHealthOpen] = useState(false);
  const [resyncing, setResyncing] = useState(false);

  // Filas de la UI de Salud de datos: frescura por módulo. La última
  // sincronización sale del máximo timestamp de los mapas `*LoadedCias` (se
  // sella aunque la cía regrese vacía); bancos usa `banksLastSync`.
  // Frescura de las fuentes bancarias MANUALES (Bajío/Santander): sus espejos
  // de BD están muertos y el CSV llega con atraso — se confiesa en Salud de
  // datos como filas propias (auditoría BD 2026-07-22).
  const manualBankHealthRows = useMemo<DataHealthDatasetRow[]>(
    () => summarizeManualBankFreshness(bankStatements, todayISO()).map((f) => ({
      key: `banks-${f.source}`,
      label: f.label,
      status: f.status === 'fresh' ? 'ready' : f.status === 'aging' ? 'stale' : 'error',
      lastSync: f.lastMovementDate ?? undefined,
    })),
    [bankStatements],
  );

  // Frescura bancaria por EMPRESA sobre TODO el set cargado (incluye los feeds
  // JDE, que `manualBankHealthRows` no mira). Medido el 2026-09-07: cías 29, 30,
  // 41 y 46 llevaban entre 3 y 25 SEMANAS sin un solo movimiento bancario, con
  // todas sus cuentas calladas a la vez y cero aviso en la UI. La caja histórica
  // se ancla al estado de cuenta, así que sin feed el saldo de esa cía se
  // congela y MOTOR 1 se pasa en silencio a los sintéticos históricos.
  //
  // Sólo se emiten las cías REZAGADAS: una fila por cada empresa al día sería
  // ruido que entrena al usuario a ignorar el panel.
  const companyBankHealthRows = useMemo<DataHealthDatasetRow[]>(
    () => summarizeBankFreshnessByCompany(bankStatements, todayISO())
      .filter((f) => f.status !== 'fresh')
      .map((f) => ({
        key: `banks-cia-${f.cia}`,
        label: `Bancos · empresa ${f.cia}${f.accountCount > 1 ? ` (${f.accountCount} cuentas)` : ''}`,
        status: f.status === 'aging' ? ('stale' as const) : ('error' as const),
        lastSync: f.lastMovementDate ?? undefined,
      })),
    [bankStatements],
  );

  // Antigüedad del DATO (no de la consulta) de los datasets JDE fechados. La
  // fila normal de cada dataset reporta `lastSync` = cuándo Midas pidió, así
  // que una fuente MUERTA se ve "al día". Medido el 2026-09-07:
  // `jde.Antiguedad_Saldos` llevaba 6 días sin insertar una fila y el CXP de
  // Midas terminaba el 31-ago, sin un solo aviso. Hermana de
  // `companyBankHealthRows`, que cerró lo mismo del lado banco.
  //
  // Sólo se emite la fila cuando la fuente está REZAGADA: una por dataset al
  // día sería ruido que entrena al usuario a ignorar el panel.
  const staleSourceHealthRows = useMemo<DataHealthDatasetRow[]>(() => {
    const today = todayISO();
    const rows: DataHealthDatasetRow[] = [];
    const push = (key: string, label: string, dates: Iterable<string | undefined>) => {
      const f = summarizeSourceDataFreshness(dates, today);
      // `no-data` sin registros = el dataset simplemente no se ha cargado; eso
      // ya lo dice su propia fila de estado. Sólo hablamos de fuente rezagada.
      if (f.status === 'fresh' || (f.status === 'no-data' && !f.lastDataDate)) return;
      rows.push({ key, label, status: f.status === 'aging' ? 'stale' : 'error', lastSync: f.lastDataDate ?? undefined });
    };
    if (cxpRecords.length > 0) {
      push('cxp-data-age', 'CXP · dato más reciente en la fuente', cxpRecords.map((r) => r.fechaFactura));
    }
    if (cobranzaRecords.length > 0) {
      push('cobranza-data-age', 'Cobranza · dato más reciente en la fuente',
        cobranzaRecords.flatMap((r) => [r.fechaFactura, r.fechaCobro]));
    }
    return rows;
  }, [cxpRecords, cobranzaRecords]);

  const dataHealthRows = useMemo<DataHealthDatasetRow[]>(() => {
    const maxTs = (...maps: Record<string, string>[]): string | undefined => {
      let max: string | undefined;
      for (const map of maps) {
        for (const v of Object.values(map)) {
          if (typeof v === 'string' && (!max || v > max)) max = v;
        }
      }
      return max;
    };
    return [
      { key: 'banks', label: 'Bancos', status: datasetStatus.banks, lastSync: banksLastSync ?? undefined },
      ...manualBankHealthRows,
      ...companyBankHealthRows,
      { key: 'cxp', label: 'CXP · Antigüedad de saldos', status: datasetStatus.cxp, lastSync: maxTs(cxpLoadedCias) },
      ...staleSourceHealthRows,
      { key: 'cobranza', label: 'Cobranza', status: datasetStatus.cobranza, lastSync: maxTs(cobranzaLoadedCias, cobranzaPaymentsLoadedCias) },
      { key: 'compras', label: 'Compras (OCs)', status: datasetStatus.compras, lastSync: maxTs(comprasLoadedCias) },
      { key: 'pagos', label: 'Pagos a proveedores', status: datasetStatus.pagos, lastSync: maxTs(pagoProveedorLoadedCias) },
      { key: 'auxiliar', label: 'Auxiliar contable', status: datasetStatus.auxiliar, lastSync: maxTs(auxiliarContableLoadedCias) },
      { key: 'nomina', label: 'Nómina (TRESS)', status: datasetStatus.nomina, lastSync: maxTs(nominaLoadedKeys) },
      { key: 'rol', label: 'ROL · Viajes', status: datasetStatus.rol, lastSync: maxTs(rolLoadedKeys) },
    ];
  }, [
    datasetStatus, banksLastSync, manualBankHealthRows, companyBankHealthRows,
    staleSourceHealthRows, cxpLoadedCias, cobranzaLoadedCias,
    cobranzaPaymentsLoadedCias, comprasLoadedCias, pagoProveedorLoadedCias,
    auxiliarContableLoadedCias, nominaLoadedKeys, rolLoadedKeys,
  ]);

  // Punto ámbar del header: huecos de carga de esta sesión. Lee el arreglo de
  // módulo en cada render (los cambios de datasetStatus durante el boot
  // disparan re-render suficientes para refrescar el hint).
  const dataHealthGapCount = getDataGaps().length;

  // Resincronización total: borra el caché diario + markers de saneo y recarga
  // → re-pull completo desde JDE. Para cuando el usuario sospecha divergencia
  // con otro equipo y quiere reconverger desde cero.
  const resyncDataLake = useCallback(async () => {
    setResyncing(true);
    try {
      clearDataLakeMarkers();
      await clearAllDailyCache();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[data-health] resync falló al limpiar caché', err);
    } finally {
      window.location.reload();
    }
  }, []);

  // Publica window.__midas__.dataHealth (gaps/coverage/counts) para soporte.
  useEffect(() => { publishDataHealthDiagnostics(); }, []);

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

  // Clear-on-entry (decisión 2026-06-23): en cada ingreso a la app se borran los
  // caches JDE/TRESS (heavy store + cache diario + cache de proyección + estados
  // de cuenta JDE) y se recarga TODO fresco del servidor — matando la deriva
  // por-navegador (días envenenados, OCs/movimientos staleados). El trabajo
  // capturado por el usuario + las cargas manuales se PRESERVAN. Corre a lo más
  // una vez por carga de página (`cacheEntryHandled`). La hidratación del store
  // y el load de caches de banco esperan a `cacheCleared`, así que nada lee un
  // store que está por borrarse. Cadencia configurable con VITE_CACHE_MAX_AGE_MIN
  // (default 0 = cada ingreso; >0 = sólo si pasó esa ventana desde la última).
  useEffect(() => {
    if (cacheEntryHandled) { setCacheCleared(true); return; }
    cacheEntryHandled = true;
    let cancelled = false;
    const run = async () => {
      try {
        // ── Rama SNAPSHOT ──────────────────────────────────────────────────
        // Si el store está encendido y hay un snapshot compartido, se DESCARGA a
        // IDB (no se borra nada): todos los navegadores convergen al MISMO dato
        // (cero deriva) y el arranque es una descarga, no un storm de miles de
        // llamadas a JDE (<1 min). El delta reciente lo cubren los auto-fetch
        // (forward desde `builtAt`), que corren detrás del dashboard.
        if (isSnapshotEnabled()) {
          const pointer = await getSnapshotPointer();
          if (pointer) {
            // Sólo se activa el modo snapshot si la hidratación fue COMPLETA:
            // una hidratación parcial (colecciones fallidas conservan el IDB
            // por-navegador previo) presentada como 'done' es exactamente la
            // deriva que el clear-on-entry existe para matar. En parcial se cae
            // al clear-on-entry (el marker de versión ya queda retenido por
            // hydrateHeavyStoreFromSnapshot, así que el siguiente boot reintenta).
            let snapshotComplete = true;
            if (pointer.version !== getLocalSnapshotVersion()) {
              const result = await hydrateHeavyStoreFromSnapshot(pointer);
              snapshotComplete = result.failed.length === 0;
              if (!snapshotComplete) {
                // eslint-disable-next-line no-console
                console.warn(`[snapshot] hidratación PARCIAL (fallaron: ${result.failed.join(', ')}) — se cae al clear-on-entry`);
              }
            } else {
              // eslint-disable-next-line no-console
              console.info(`[snapshot] version ${pointer.version} ya en IDB — se omite la re-descarga`);
            }
            if (snapshotComplete) {
              // Congelar los slots cubiertos en 'done': el dato ya está en IDB; el
              // delta corre detrás del dashboard sin re-gatear el splash. El guard
              // de setBootSlot (via snapshotActiveRef) mantiene el congelado.
              setBootStatus(prev => ({
                ...prev,
                cxp: 'done', cobranza: 'done', compras: 'done',
                pagos: 'done', nomina: 'done', rol: 'done', auxiliar: 'done',
              }));
              snapshotActiveRef.current = true;
              // eslint-disable-next-line no-console
              console.info('[snapshot] modo snapshot activo — arranque desde el snapshot compartido');
              return; // NO borrar el cache local
            }
          }
          // Store ON pero sin snapshot publicado (o hidratación parcial) → cae
          // al clear-on-entry.
        }
        // ── Rama FALLBACK (OFF / sin snapshot): comportamiento de hoy ────────
        const raw = (import.meta.env.VITE_CACHE_MAX_AGE_MIN as string | undefined) ?? '0';
        const maxAgeMin = Number.parseInt(raw, 10);
        let fresh = false;
        if (Number.isFinite(maxAgeMin) && maxAgeMin > 0) {
          try {
            const last = localStorage.getItem(CACHE_LOADED_AT_KEY);
            if (last) fresh = Date.now() - new Date(last).getTime() < maxAgeMin * 60_000;
          } catch { /* ignore */ }
        }
        if (!fresh) {
          await clearCacheStorageOnEntry();
          try { localStorage.setItem(CACHE_LOADED_AT_KEY, new Date().toISOString()); } catch { /* ignore */ }
          // eslint-disable-next-line no-console
          console.info('[clear-on-entry] caches JDE/TRESS borrados — recargando fresco del servidor');
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[clear-on-entry] falló — se continúa con el cache local:', err);
      }
    };
    // Tope duro: aunque las clears tienen sus propios timeouts de apertura de
    // IDB (resuelven solas), un fallback evita congelar el boot ante lo
    // imprevisto. En modo snapshot la descarga de ~90MB (pointer + ~40-60 shards)
    // puede tardar decenas de segundos, así que el fallback es más generoso (60s)
    // para no soltar el gate a media hidratación; fuera de snapshot, 10s.
    const fallbackMs = isSnapshotEnabled() ? 60000 : 10000;
    const fallback = window.setTimeout(() => { if (!cancelled) setCacheCleared(true); }, fallbackMs);
    void run().finally(() => {
      window.clearTimeout(fallback);
      if (!cancelled) setCacheCleared(true);
    });
    return () => { cancelled = true; window.clearTimeout(fallback); };
  }, []);

  // Load from persistence on mount. Async desde v12: heavies
  // (cobranza/cxp/compras/pagoproveedor/nómina/payments) viven en IDB porque
  // localStorage tenía cuota ~5MB que se rompía y dejaba el store sin
  // persistir, causando refetch JDE en cada boot. Ver persistence.ts:saveStore.
  useEffect(() => {
    if (!cacheCleared) return;
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
    void loadLightStore()
      .then((stored) => {
        if (cancelled) return;
        if (stored) {
          lightStoreLastSavedRef.current = stored.lastSaved;
          if (stored.providers.length) safeSet(setProviders, stored.providers, 'providers');
          if (stored.clients.length) safeSet(setClients, stored.clients, 'clients');
          if (stored.confirmedPayments.length) safeSet(setConfirmedPayments, stored.confirmedPayments, 'confirmedPayments');
          if (stored.cxpLoadedCias) safeSet(setCxpLoadedCias, stored.cxpLoadedCias, 'cxpLoadedCias');
          if (stored.cobranzaLoadedCias) safeSet(setCobranzaLoadedCias, stored.cobranzaLoadedCias, 'cobranzaLoadedCias');
          if (stored.cobranzaPaymentsLoadedCias) safeSet(setCobranzaPaymentsLoadedCias, stored.cobranzaPaymentsLoadedCias, 'cobranzaPaymentsLoadedCias');
          if (stored.comprasLoadedCias) safeSet(setComprasLoadedCias, stored.comprasLoadedCias, 'comprasLoadedCias');
          if (stored.pagoProveedorLoadedCias) safeSet(setPagoProveedorLoadedCias, stored.pagoProveedorLoadedCias, 'pagoProveedorLoadedCias');
          if (stored.nominaLoadedKeys) safeSet(setNominaLoadedKeys, stored.nominaLoadedKeys, 'nominaLoadedKeys');
          if (stored.rolLoadedKeys) safeSet(setRolLoadedKeys, stored.rolLoadedKeys, 'rolLoadedKeys');
          if (stored.auxiliarContableLoadedCias) safeSet(setAuxiliarContableLoadedCias, stored.auxiliarContableLoadedCias, 'auxiliarContableLoadedCias');
          if (stored.auxiliarIvaLoadedCias) safeSet(setAuxiliarIvaLoadedCias, stored.auxiliarIvaLoadedCias, 'auxiliarIvaLoadedCias');
          if (stored.cashFlowOverrides) safeSet(setCashFlowOverrides, stored.cashFlowOverrides, 'cashFlowOverrides');
          safeSet(setAssumptions, stored.assumptions, 'assumptions');
          // eslint-disable-next-line no-console
          console.info(`[loadStore] light hidratado · companies=${stored.companies?.length ?? 0} · heavy=on-demand`);
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
  }, [cacheCleared]);

  useEffect(() => {
    requestDatasets(TAB_DATASETS[activeTab] ?? []);
  }, [activeTab, requestDatasets]);

  // Prefetch TODOS los datasets — no sólo los del tab activo. Antes el
  // dashboard pedía `[]` y cada módulo disparaba su fetch JDE al abrirlo, así
  // que el usuario esperaba en cada entrada. Ahora se piden todos, pero:
  //   - DIFERIDO a idle tras hidratar (no compite con el primer paint ni con
  //     el tab activo, que ya se pide en el efecto de arriba).
  //   - ESCALONADO en dos tandas para no meter 6 heavies a estado React en el
  //     mismo tick (eso disparaba un recompute sincrónico que congelaba el
  //     hilo cuando todo resolvía a la vez).
  // El semáforo global de jdeClient acota el paralelismo de red, los
  // auto-fetch saltan cías frescas por TTL y los per-heavy savers persisten a
  // IDB → el siguiente boot hidrata instantáneo.
  useEffect(() => {
    if (!storeHydrated) return;
    const firstWave: DatasetKey[] = ['banks', 'cxp', 'cobranza'];
    const secondWave: DatasetKey[] = ['compras', 'pagos', 'nomina', 'rol', 'auxiliar'];
    const cancel1 = scheduleIdleTask(() => requestDatasets(firstWave), 1200);
    const cancel2 = scheduleIdleTask(() => requestDatasets(secondWave), 3500);
    return () => { cancel1?.(); cancel2?.(); };
  }, [storeHydrated, requestDatasets]);

  // Un `user` sin permiso a un módulo NO pide su dataset (requestDatasets
  // filtra por allowedDatasets), pero los slots del splash arrancan 'pending'
  // y sólo su auto-fetch los saca de ahí → sin este escape, un usuario
  // restringido dejaba cxp/compras/pagos/nomina en 'pending' para siempre y
  // el splash quedaba atorado hasta el hard-timeout de 30 min. Espejo del
  // escape que `banks` ya tenía en su boot effect. Si un admin concede el tab
  // a media sesión, el slot ya quedó 'done' (el splash ya cerró) y el loader
  // corre al navegar al tab vía requestDatasets, igual que banks.
  useEffect(() => {
    const datasetSlots = ['cxp', 'cobranza', 'compras', 'pagos', 'nomina', 'rol', 'auxiliar'] as const;
    for (const slot of datasetSlots) {
      if (!allowedDatasets.has(slot)) setBootSlot(slot, 'done');
    }
  }, [allowedDatasets, setBootSlot]);

  // El slot `projection` es una señal de RENDER (first-paint del dashboard de
  // Proyección), no un dataset: sólo se emite si el tab se monta. Un `user`
  // sin acceso a `financialProjection` nunca lo monta (el guard lo redirige a
  // su primer tab permitido), así que sin este escape su splash esperaba el
  // timeout de 60s del slot con los datos ya listos.
  useEffect(() => {
    if (!canAccessTab('financialProjection')) setBootSlot('projection', 'done');
  }, [canAccessTab, setBootSlot]);

  useEffect(() => {
    if (bankCacheLoaded) setDatasetSlot('banks', 'ready');
  }, [bankCacheLoaded, setDatasetSlot]);

  const hydratedDatasetsRef = useRef<Set<DatasetKey>>(new Set());
  const hydrationPromisesRef = useRef<Partial<Record<DatasetKey, Promise<void>>>>({});
  const hydrateDataset = useCallback((dataset: DatasetKey): Promise<void> => {
    if (dataset === 'banks') return Promise.resolve();
    if (hydratedDatasetsRef.current.has(dataset)) return Promise.resolve();
    const existing = hydrationPromisesRef.current[dataset];
    if (existing) return existing;

    setDatasetSlot(dataset, 'loading');
    const promise = (async () => {
      try {
        if (dataset === 'cxp') {
          const records = await loadHeavyRecords('cxpRecords');
          if (records.length > 0) {
            setCxpRecords(records);
            patchLoadedCiasFromRecords(setCxpLoadedCias, records, lightStoreLastSavedRef.current);
          }
        } else if (dataset === 'cobranza') {
          const [records, payments] = await Promise.all([
            loadHeavyRecords('cobranzaRecords'),
            loadHeavyRecords('cobranzaPayments'),
          ]);
          if (records.length > 0) {
            setCobranzaRecords(records);
            patchLoadedCiasFromRecords(setCobranzaLoadedCias, records, lightStoreLastSavedRef.current);
          }
          if (payments.length > 0) {
            setCobranzaPayments(payments);
            patchLoadedCiasFromRecords(setCobranzaPaymentsLoadedCias, payments, lightStoreLastSavedRef.current);
          }
        } else if (dataset === 'compras') {
          const records = await loadHeavyRecords('comprasRecords');
          if (records.length > 0) setComprasRecords(records);
        } else if (dataset === 'pagos') {
          const records = await loadHeavyRecords('pagoProveedorRecords');
          if (records.length > 0) setPagoProveedorRecords(records);
        } else if (dataset === 'nomina') {
          const records = await loadHeavyRecords('nominaRecords');
          if (records.length > 0) {
            setNominaRecords(records);
            setNominaLoadedKeys(prev => deriveNominaLoadedKeysFromRecords(records, prev));
          }
        } else if (dataset === 'rol') {
          // Viajes Especiales se hidrata DENTRO del slot 'rol' (no agrega
          // boot status nuevo). Ambos APIs son trip-level CITI; comparten
          // ciclo de vida lógico desde la perspectiva del usuario.
          const [rolRecs, viajesRecs] = await Promise.all([
            loadHeavyRecords('rolRecords'),
            loadHeavyRecords('viajesEspecialesRecords'),
          ]);
          if (rolRecs.length > 0) {
            setRolRecords(rolRecs);
            patchRolLoadedKeysFromRecords(setRolLoadedKeys, rolRecs, lightStoreLastSavedRef.current);
          }
          if (viajesRecs.length > 0) {
            setViajesEspecialesRecords(viajesRecs);
            // Marcar año actual como ya cargado (la ventana fija es Y-01-01..hoy).
            const year = new Date().getUTCFullYear();
            setViajesEspecialesLoadedKeys(prev => ({
              ...prev,
              [`${year}:full`]: lightStoreLastSavedRef.current ?? new Date().toISOString(),
            }));
          }
        } else if (dataset === 'auxiliar') {
          const [records, ivaRecords] = await Promise.all([
            loadHeavyRecords('auxiliarContableRecords'),
            loadHeavyRecords('auxiliarIvaRecords'),
          ]);
          if (records.length > 0) setAuxiliarContableRecords(records);
          if (ivaRecords.length > 0) setAuxiliarIvaRecords(ivaRecords);
        }
        hydratedDatasetsRef.current.add(dataset);
        setDatasetSlot(dataset, 'ready');
      } catch (err) {
        console.warn(`[dataset:${dataset}] hydrate failed`, err);
        setDatasetSlot(dataset, 'error');
      } finally {
        if (dataset === 'nomina') setNominaHeavyHydrated(true);
        // Desbloquea los auto-fetch de boot — incluso si la hidratación falló,
        // para que puedan caer al fetch JDE en vez de quedarse atorados.
        setIdbHydratedDatasets(prev => (prev.has(dataset) ? prev : new Set(prev).add(dataset)));
        delete hydrationPromisesRef.current[dataset];
      }
    })();
    hydrationPromisesRef.current[dataset] = promise;
    return promise;
  }, [setDatasetSlot]);

  useEffect(() => {
    if (!storeHydrated) return;
    const priority: DatasetKey[] = ['cxp', 'pagos', 'cobranza', 'rol', 'nomina', 'compras'];
    // indexOf(-1) sorted unlisted datasets (auxiliar, the heaviest) FIRST,
    // inverting the staggering — rank them after every listed one instead.
    const rank = (k: DatasetKey) => {
      const i = priority.indexOf(k);
      return i === -1 ? priority.length : i;
    };
    const requested = Array.from(requestedDatasets)
      .filter((dataset) => dataset !== 'banks')
      .sort((a, b) => rank(a) - rank(b));
    const cancelers = requested.map((dataset, index) => {
      let cancelIdle: (() => void) | null = null;
      const timer = window.setTimeout(() => {
        cancelIdle = scheduleIdleTask(() => {
          void hydrateDataset(dataset);
        }, 2500);
      }, index * 450);
      return () => {
        window.clearTimeout(timer);
        cancelIdle?.();
      };
    });
    return () => {
      for (const cancel of cancelers) cancel();
    };
  }, [requestedDatasets, hydrateDataset, storeHydrated]);

  // (Retirado 2026-06-15) El "repair" que rellenaba TODAS las cías activas con
  // el timestamp global del store cuando el snapshot heavy existía marcaba como
  // "frescas" también a las cías NUEVAS (agregadas al catálogo después del
  // último sync) → nunca se consultaban y quedaban vacías para siempre, con
  // navegadores divergentes. Su único efecto legítimo (no re-consultar cías que
  // regresaron vacío) ya está cubierto: el stamp por-cía se persiste aunque la
  // respuesta venga vacía. El caso raro de pérdida de stamps en localStorage
  // con IDB sobreviviente se auto-cura re-consultando esas cías una vez.

  // ── Auto-resolución total matcher cliente↔cobranza ──────────────────────
  // Regla de negocio (Santiago, 2026-05-12):
  //   • Match ≥70% confianza → adjuntar JDE link a cliente existente.
  //   • Resto → crear cliente nuevo. Si tiene <10 facturas YTD se manda al
  //     grupo "Viajes Especiales"; si ≥10 queda como cliente recurrente.
  //   • Cliente del cubo Viajes Especiales que brinca el umbral se promueve
  //     (sale del grupo) en la pasada siguiente.
  // No deja nada para revisar manual — el wizard queda como override.
  //
  // PERF (2026-05-14): este useEffect itera `cobranzaRecords` (decenas de
  // miles) en main thread y crea `Set<accountKeys>`. Durante boot, cobranza
  // se hidrata en stream (29 cías una a una) → ref nuevo cada cía → matcher
  // re-corre 29× y satura el event loop, impidiendo que el splash hard
  // timeout (240s) dispare. Gateamos a que `cobranza` y `cxp` boot slots
  // estén `done`/`error` y debounceamos 800ms para colapsar bursts.
  const matcherLastSig = useRef<string>('');
  useEffect(() => {
    if (clients.length === 0 || cobranzaRecords.length === 0) return;
    const cobranzaSettled = bootStatus.cobranza === 'done' || bootStatus.cobranza === 'error';
    const cxpSettled = bootStatus.cxp === 'done' || bootStatus.cxp === 'error';
    if (!cobranzaSettled || !cxpSettled) return;
    const accountKeys = new Set<string>();
    for (const r of cobranzaRecords) accountKeys.add(`${r.cia}::${r.noCliente}`);
    const sig = `${clients.length}|${accountKeys.size}|${cobranzaRecords.length}|${companies.length}`;
    if (sig === matcherLastSig.current) return;

    const handle = window.setTimeout(() => {
      matcherLastSig.current = sig;
      runMatcher();
    }, 800);
    return () => window.clearTimeout(handle);

    function runMatcher() {

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
    // Wizard queda vacío sólo si quedaba algo viejo. Evita re-render innecesario.
    setMatcherReview(prev =>
      prev.autoAccepted.length === 0 && prev.needsReview.length === 0 && prev.orphanNoClientes.length === 0
        ? prev
        : { autoAccepted: [], needsReview: [], orphanNoClientes: [] }
    );
    // eslint-disable-next-line no-console
    console.info(
      `[matcher] auto-resolve: ${toAttach.length} adjuntos · ${attachedByFallback} fallback adj · ${createdRecurrentes} cli. nuevos · ${createdViajes} viajes · ${reclassifiedIntoViajes} →viajes · ${reclassifiedOutOfViajes} ←viajes · ${intercoRemoved} interco quitados`,
    );
    } // end runMatcher
  }, [clients, cobranzaRecords, companies, bootStatus.cobranza, bootStatus.cxp]);

  // Auto-actualiza `creditDays` por cliente con el lag observado de pagos
  // reales (fechaCobro - fechaFactura). El cliente queda igual cuando no hay
  // facturas pagadas o el promedio coincide con el valor previo.
  // Gateado igual que el matcher: durante el stream de 29 cías de cobranza,
  // recomputar 46k records por cía pinea el main thread.
  useEffect(() => {
    if (cobranzaRecords.length === 0) return;
    if (bootStatus.cobranza !== 'done' && bootStatus.cobranza !== 'error') return;
    const handle = window.setTimeout(() => {
      setClients(prev => recomputeClientCreditDaysFromCobranza(prev, cobranzaRecords));
    }, 800);
    return () => window.clearTimeout(handle);
  }, [cobranzaRecords, bootStatus.cobranza]);

  // Catalog bootstrap tracking — splash waits for both bundled CSVs to settle.
  const [clientsCatalogDone, setClientsCatalogDone] = useState(false);
  const [clientsCatalogError, setClientsCatalogError] = useState(false);
  const [providersCatalogDone, setProvidersCatalogDone] = useState(false);
  useEffect(() => {
    if (clientsCatalogDone && providersCatalogDone) {
      setCatalogLoaded(true);
      // Providers no tiene path de error: el overlay carga sync desde bundle.
      // Si clients falló, ese es el único motivo de fallback.
      setBootSlot('catalog', clientsCatalogError ? 'error' : 'done');
    }
  }, [clientsCatalogDone, providersCatalogDone, clientsCatalogError, setBootSlot]);

  // Load clients from catalog if no clients exist yet
  useEffect(() => {
    if (catalogLoaded || clients.length > 0) {
      setClientsCatalogDone(true);
      return;
    }
    // The IDB store hydration can land while this fetch is in flight; without
    // both guards the resolved catalog would clobber the persisted clients
    // (manual group overrides, API-patched credit days) and the autosave
    // would persist the loss.
    let cancelled = false;
    fetchClientCatalog()
      .then(loaded => {
        if (cancelled || loaded.length === 0) return;
        setClients(prev => (prev.length > 0 ? prev : loaded));
        setCatalogLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        // Antes este path era inalcanzable (loadClientsCatalog se tragaba todo
        // error y regresaba []), así que un catálogo que no cargaba booteaba en
        // silencio con cero clientes. Ahora el fallo real llega aquí: lo
        // marcamos (boot slot 'catalog' → 'error', visible en Salud de datos) y
        // lo logueamos para diagnóstico.
        // eslint-disable-next-line no-console
        console.error('[catalog] no se pudo cargar clientes-db.json:', err);
        setClientsCatalogError(true);
      })
      .finally(() => setClientsCatalogDone(true));
    return () => { cancelled = true; };
  }, [catalogLoaded, clients.length]);

  // Providers — catálogo derivado en tiempo real desde las fuentes JDE
  // (antigüedad de saldos, compras, pagoProveedor). NO hay registros manuales.
  // El JSON de Alberto sobrevive sólo como overlay de `score` para juzgar
  // negociabilidad; proveedores sin match en el overlay quedan SIN SCORE.
  //
  // El overlay se construye una sola vez (sync desde bundle). El catálogo se
  // recompone cuando cambian los records JDE — same pattern que
  // `recomputeClientCreditDaysFromCobranza` para clientes.
  const scoreOverlay = useMemo(() => loadProviderScoreOverlay(), []);
  useEffect(() => {
    // Provider catalog gate: el overlay ya está listo (sync), así que la
    // splash puede continuar incluso antes de que carguen los records JDE.
    setProvidersCatalogDone(true);
  }, []);
  useEffect(() => {
    // No tocar providers hasta que termine boot mínimo (catalogos + companies).
    // De lo contrario el primer setProviders pisa el restore del store local.
    if (!isBooted) return;
    // Si no hay ningún record JDE todavía, deja providers vacío en lugar de
    // pisar con un set sintético — facilita debug y evita falsos positivos.
    const hasAnyData =
      cxpRecords.length > 0 || comprasRecords.length > 0 || pagoProveedorRecords.length > 0;
    if (!hasAnyData) return;
    // Derivación en idle: O(N) sobre todos los records es no-trivial (~334k
    // CXP). Correrlo síncrono en el effect bloqueaba main durante boot storm
    // (cada hidratación de records re-disparaba el efecto). idle + debounce
    // de 800ms colapsa la cascada en una sola recomputación post-boot.
    //
    // PERF (worker): la derivación itera CXP + compras + pagos para inferir
    // categoría / score / volumen — varios cientos de ms en main thread post
    // boot. Lo movimos al worker compartido (sharedProviderDerivationWorker).
    // Si el worker no está disponible (jsdom / spawn falla) caemos a la
    // versión sync inline, así los tests y SSR siguen funcionando.
    let cancelled = false;
    const jobId = nextProviderDerivationJobId();
    const applyResult = (derived: ReturnType<typeof deriveProvidersFromJde>) => {
      if (cancelled) return;
      // Commit IDEMPOTENTE (2026-07-31). La derivación es determinista sobre
      // los mismos records, así que las olas post-boot (identidad nueva del
      // array de records, contenido igual) producían un catálogo IDÉNTICO cuyo
      // commit movía la identidad de `providers`. Eso basta para tirar todo el
      // camino caliente aguas abajo: `SOURCE_CACHE` está llaveado por refId de
      // los arrays (financialProjectionService), así que identidad nueva =
      // miss = re-lectura de IDB o, en frío, debounce de 12 s + rebuild del
      // canónico (~20 s) con los números ya pintados en pantalla. Ver
      // "INVARIANTE DE ESTABILIDAD de los tableros financieros" en CLAUDE.md.
      //
      // Comparamos EXACTAMENTE los campos que hashea la llave del cache de
      // proyección (misma lista, mismo módulo → no se pueden desincronizar).
      // Trade-off consciente: un cambio que sólo toque campos FUERA de la
      // llave (montoTotal2025, numPagos2025, frecuenciaHistorica…) no
      // re-commitea el estado — no puede alterar ninguna cifra del motor y el
      // siguiente cambio real lo re-sincroniza.
      setProviders(prev => (
        sameByCacheKeyFields(prev, derived, PROVIDER_CACHE_KEY_FIELDS) ? prev : derived
      ));
      // Empuja al módulo de Planeación para que `bucketForMovement` resuelva
      // categoría sin tener que recibir providers por argumento en cada render.
      // Va SIEMPRE (no depende del guard): es un registro fuera de React que
      // sí consume los campos de categoría que la llave no hashea.
      setProviderCatalogForCategoryLookup(derived);
    };
    const cancelIdle = scheduleIdleTask(() => {
      const inputs = {
        agedBalanceRecords: cxpRecords,
        comprasRecords,
        pagoProveedorRecords,
        scoreOverlay,
      };
      const posted = postToProviderDerivationWorker({ jobId, ...inputs });
      if (!posted) {
        // No worker → sync fallback (jsdom / Worker spawn fail).
        applyResult(deriveProvidersFromJde(inputs));
      }
    }, 800);
    const unsubscribe = subscribeProviderDerivationWorker((data) => {
      if (data.jobId !== jobId) return;
      if (data.result) {
        applyResult(data.result);
      } else if (data.error) {
        // eslint-disable-next-line no-console
        console.warn('[providerDerivation] worker failed, sync fallback', data.error);
        applyResult(deriveProvidersFromJde({
          agedBalanceRecords: cxpRecords,
          comprasRecords,
          pagoProveedorRecords,
          scoreOverlay,
        }));
      }
    });
    return () => {
      cancelled = true;
      cancelIdle();
      unsubscribe();
    };
  }, [isBooted, cxpRecords, comprasRecords, pagoProveedorRecords, scoreOverlay]);

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
      rolRecords, rolLoadedKeys,
      viajesEspecialesRecords, viajesEspecialesLoadedKeys,
      auxiliarContableRecords, auxiliarContableLoadedCias,
      auxiliarIvaRecords, auxiliarIvaLoadedCias,
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
    companies, companiesLoadedAt, nominaLoadedKeys, rolLoadedKeys,
    auxiliarContableLoadedCias, auxiliarIvaLoadedCias, cashFlowOverrides,
  ]);

  // Per-heavy saves: cada uno solo dispara cuando su key cambia. saveHeavyRecords
  // hace UN solo put de UN solo array, no re-serializa los 6.
  const dirtyHeavyKeysRef = useRef<Set<HeavyKey>>(new Set());
  const latestHeavyRecordsRef = useRef<Record<HeavyKey, unknown[]>>({
    cxpRecords,
    cobranzaRecords,
    cobranzaPayments,
    comprasRecords,
    pagoProveedorRecords,
    nominaRecords,
    rolRecords,
    viajesEspecialesRecords,
    auxiliarContableRecords,
    auxiliarIvaRecords,
  });
  latestHeavyRecordsRef.current = {
    cxpRecords,
    cobranzaRecords,
    cobranzaPayments,
    comprasRecords,
    pagoProveedorRecords,
    nominaRecords,
    rolRecords,
    viajesEspecialesRecords,
    auxiliarContableRecords,
    auxiliarIvaRecords,
  };
  const useHeavySaver = (key: HeavyKey, records: unknown[]) => {
    useEffect(() => {
      if (records.length > 0) dirtyHeavyKeysRef.current.add(key);
      let cancelIdle: (() => void) | null = null;
      const timer = window.setTimeout(() => {
        cancelIdle = scheduleIdleTask(() => {
          // Anti-wipe: skip si records vacío (state probablemente en tránsito
          // durante boot, no queremos pisar IDB existente).
          if (records.length === 0) return;
          void saveHeavyRecords(key, records).then(() => {
            if (latestHeavyRecordsRef.current[key] === records) {
              dirtyHeavyKeysRef.current.delete(key);
            }
          });
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
  useHeavySaver('rolRecords', rolRecords);
  useHeavySaver('viajesEspecialesRecords', viajesEspecialesRecords);
  useHeavySaver('auxiliarContableRecords', auxiliarContableRecords);
  useHeavySaver('auxiliarIvaRecords', auxiliarIvaRecords);

  useEffect(() => {
    const flush = () => {
      // Persistir el light store sin clonar todos los heavies. Los arrays
      // pesados se guardan por-key y solo si aún están dirty.
      if (latestStoreRef.current) saveLightStore(latestStoreRef.current);
      for (const key of dirtyHeavyKeysRef.current) {
        const records = latestHeavyRecordsRef.current[key];
        if (records.length > 0) void saveHeavyRecords(key, records);
      }
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
  // Splash gates on boot data fetches plus the first real Proyección run, so
  // the landing screen never opens with zeroed KPIs from an empty source.
  const bootTasks = useMemo<BootTask[]>(
    () => [
      { id: 'catalog', label: 'Catálogos · clientes y proveedores', status: bootStatus.catalog },
      { id: 'companies', label: 'JDE · empresas', status: bootStatus.companies },
      { id: 'banks', label: 'Bancos · estados de cuenta', status: bootStatus.banks },
      { id: 'cxp', label: 'CXP · antigüedad de saldos', status: bootStatus.cxp },
      { id: 'cobranza', label: 'Cobranza · CXC', status: bootStatus.cobranza },
      { id: 'compras', label: 'Compras · órdenes de compra', status: bootStatus.compras },
      { id: 'pagos', label: 'Pagos a proveedores', status: bootStatus.pagos },
      { id: 'nomina', label: 'TRESS · nómina', status: bootStatus.nomina },
      { id: 'rol', label: 'CITI · rol de viajes', status: bootStatus.rol },
      { id: 'auxiliar', label: 'Auxiliar contable · libro mayor', status: bootStatus.auxiliar },
      { id: 'projection', label: 'Proyección · escenario activo', status: bootStatus.projection },
    ],
    [
      bootStatus.catalog,
      bootStatus.companies,
      bootStatus.banks,
      bootStatus.cxp,
      bootStatus.cobranza,
      bootStatus.compras,
      bootStatus.pagos,
      bootStatus.nomina,
      bootStatus.rol,
      bootStatus.auxiliar,
      bootStatus.projection,
    ],
  );
  useEffect(() => {
    return subscribeProjectionFirstPaint(() => {
      setBootSlot('projection', 'done');
    });
  }, [setBootSlot]);
  // Slots del gate que fallaron (status 'error'). Un dataset no permitido al
  // usuario nunca llega a 'error' (el escape de allowedDatasets lo fuerza a
  // 'done' y su loader ni corre), así que esto sólo refleja fallos de datasets
  // que el usuario SÍ carga. No-vacío ⇒ boot bloqueado: la app no abre.
  const failedGatingTasks = useMemo(
    () => bootTasks.filter(t => GATING_BOOT_IDS.has(t.id) && t.status === 'error'),
    [bootTasks],
  );
  const bootBlocked = !isBooted && failedGatingTasks.length > 0;

  useEffect(() => {
    if (isBooted) return;
    // Regla de producto: el splash dura hasta que la información esté 100%
    // cargada. La app abre SÓLO cuando TODOS los slots del gate están 'done'.
    // Un 'error' NO abre la app degradada — deja el splash arriba (estado
    // bloqueado con "Reintentar"). GATING_BOOT_IDS ya excluye lo que el usuario
    // no ve (esos slots quedan 'done' vía el escape de allowedDatasets), así que
    // "100%" es relativo a la visibilidad del usuario.
    const allDone = bootTasks
      .filter(t => GATING_BOOT_IDS.has(t.id))
      .every(t => t.status === 'done');
    if (allDone) {
      const t = setTimeout(() => {
        setIsBooted(true);
        // Boot terminó sin matar la pestaña: limpia el watchdog para que
        // un F5 normal no se interprete como crash en el próximo arranque.
        markBootComplete();
      }, 240);
      return () => clearTimeout(t);
    }
  }, [bootTasks, isBooted]);

  // NO hay hard-timeout que fuerce la apertura de la app. Por diseño (petición
  // de producto) el splash espera al 100%: si la información no está completa la
  // app no carga. Un cold boot legítimo puede tardar 20-30+ min (ROL día-por-día
  // "toma horas", Auxiliar ~3,500 requests) y debe esperarse. No puede quedar en
  // un spinner infinito silencioso: cada fetch está acotado por el timeout de
  // jdeClient (120s × reintentos), así que todo slot termina en 'done' o 'error';
  // si algún dataset visible falla, `bootBlocked` muestra el estado con
  // "Reintentar" (recarga) en vez de abrir la app a medias.

  // Projection slot escape — the `projection` boot slot only closes when
  // FinancialProjectionDashboard emits its first-paint signal
  // (subscribeProjectionFirstPaint). If that signal path stalls — worker
  // convergence race, dashboard stuck on its warmup shell — `projection` could
  // hold the splash forever (there is no hard-timeout force-open anymore). A
  // stalled first-paint is a RENDER race, not missing data: by 60s the data
  // slots that feed the projection are already loaded, so mark the slot 'done'
  // (NOT 'error' — an error would trip `bootBlocked` and wrongly block the app);
  // the dashboard finishes computing behind its own loading shell.
  useEffect(() => {
    if (isBooted) return;
    if (bootStatus.projection === 'done' || bootStatus.projection === 'error') return;
    const t = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.warn('[boot] projection first-paint stalled 60s — releasing the projection slot; dashboard settles behind its own shell');
      setBootSlot('projection', 'done');
    }, 60000);
    return () => clearTimeout(t);
  }, [isBooted, bootStatus.projection, setBootSlot]);

  // Unmount splash after fade-out.
  useEffect(() => {
    if (!isBooted) return;
    const t = setTimeout(() => setSplashMounted(false), 280);
    return () => clearTimeout(t);
  }, [isBooted]);

  // PERF (2026-05-14): el prewarm proactivo de buildFinancialProjectionSourceData
  // se eliminó. Antes corría sync sobre 142k records ~5s después de isBooted,
  // pinando el thread justo cuando el usuario ya veía el dashboard ("despliega
  // la información en el dashboard pero después todo el app se congela").
  // Planning module ya tiene su propio cache + PlanningWarmupShell que computa
  // on-demand cuando el usuario navega a Planeación. Trade-off aceptado: la
  // primera nav a Planning paga ~1-3s de cómputo VISIBLE (con shell), en vez
  // de pinear el thread invisible 5s post-boot.

  // ── Auto-load CXP (antigüedad de saldos) durante el boot ──
  // Concurrencia limitada a 3 — JDE revienta con paralelismo total contra
  // /antiguedadsaldos, pero 3 paralelas es estable y reduce el tiempo total
  // a ~1/3 vs la versión secuencial anterior.
  const cxpAutoFetchDone = useRef(false);
  useEffect(() => {
    if (cxpAutoFetchDone.current) return;
    if (!requestedDatasets.has('cxp')) return;
    if (!storeHydrated) return;
    if (companies.length === 0) return;
    // Esperar la hidratación IDB: sin esto cxpRecords está vacío y el sync
    // concluye "28/28 necesitan refresh" aunque la cache exista.
    if (!idbHydratedDatasets.has('cxp')) return;
    const activeCias = filterActiveCompanies(companies).map(c => c.cia);
    if (activeCias.length === 0) {
      cxpAutoFetchDone.current = true;
      setBootSlot('cxp', 'done');
      setDatasetSlot('cxp', 'ready');
      return;
    }
    // Desync guard (mismo hardening que cobranza/nómina): si el heavy store
    // (IDB) hidrató VACÍO pero `cxpLoadedCias` (light, localStorage) sigue
    // "fresco", el delta-sync skippea toda cía → CXP queda vacío y "no carga
    // histórico" hasta refresh manual. Sin records hidratados → refetch full.
    //
    // NO usamos el timestamp global del store como fallback por cía: una cía
    // SIN timestamp propio es una cía nueva (agregada al catálogo después del
    // último sync) que NUNCA se consultó — marcarla "fresca" con el `lastSaved`
    // global la dejaba vacía PARA SIEMPRE y producía divergencia entre
    // navegadores (uno la trae, otro no). Las cías que regresaron vacío ya
    // tienen su stamp por-cía persistido (se sella aunque `data` venga vacía).
    const cxpHeavyHydrated = cxpRecords.length > 0;
    const ciasToFetch = cxpHeavyHydrated
      ? activeCias.filter(cia =>
          !isFreshTimestamp(cxpLoadedCias[cia], CXP_AUTO_REFRESH_TTL_MS)
        )
      : activeCias;
    // eslint-disable-next-line no-console
    console.info(`[cxp] boot sync · ${ciasToFetch.length}/${activeCias.length} cías necesitan refresh (TTL ${Math.round(CXP_AUTO_REFRESH_TTL_MS / 3600000)}h) · hydratedRecords=${cxpRecords.length}`);
    if (ciasToFetch.length === 0) {
      cxpAutoFetchDone.current = true;
      setBootSlot('cxp', 'done');
      setDatasetSlot('cxp', 'ready');
      return;
    }
    cxpAutoFetchDone.current = true;
    setBootSlot('cxp', 'loading');
    setDatasetSlot('cxp', 'loading');
    setCxpBootProgress({ done: 0, total: ciasToFetch.length });
    // Sin `cancelled` mid-flight: en StrictMode el cleanup dispara antes de
    // que JDE responda y matar los workers ahí deja CXP atorado en 0/N para
    // siempre. El ref `cxpAutoFetchDone` ya evita re-entrada al re-mount.
    (async () => {
      const fetchedRecords: CXPRecord[] = [];
      const fetchedCias: string[] = [];
      const fetchedTimestamps: Record<string, string> = {};
      let errors = 0;
      let succeeded = 0;
      let completed = 0;
      let cursor = 0;
      // AgedBalanceRequest (jdeTypes): N paralelos por cía → 500 por
      // contención (validado prod 2026-04-20). 10 paralelos es agresivo
      // contra JDE pero el retry por-cía con backoff cubre los 500
      // transitorios. Revisar si vuelven a aparecer fallos silenciosos.
      const concurrency = Math.min(10, ciasToFetch.length);
      const failedCias: string[] = [];
      const fetchCiaWithRetry = async (cia: string): Promise<CXPRecord[]> => {
        const MAX_ATTEMPTS = 3;
        let lastErr: unknown;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          try {
            return (await fetchAgedBalances({ cia })) as CXPRecord[];
          } catch (err) {
            lastErr = err;
            if (attempt === MAX_ATTEMPTS) break;
            await new Promise(r => setTimeout(r, 800 * 2 ** (attempt - 1)));
          }
        }
        throw lastErr;
      };
      // Coalescer setCxpRecords a 2 commits: uno tras la 1ª cía (el skeleton
      // se va rápido + paint) y el final tras Promise.all. Cada setState de
      // un heavy-record muta `cacheProbeInput` → rebuild del source +
      // re-spawn de los workers (mismo motivo por el que el backfill de
      // nómina coalesce a 1 commit). El commit por-cía (~28) reventaba en
      // parpadeo y miles de re-fetch de scripts de worker.
      const commitEarly = (cia: string, recs: CXPRecord[], ts: string) => {
        setCxpRecords(prev => [...prev.filter(r => r.cia !== cia), ...recs]);
        setCxpLoadedCias(prev => ({ ...prev, [cia]: ts }));
        setDatasetSlot('cxp', 'ready');
      };
      const worker = async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= ciasToFetch.length) return;
          const cia = ciasToFetch[idx];
          try {
            const data = await fetchCiaWithRetry(cia);
            const stamped = data.map(r => ({ ...r, cia }));
            const ts = new Date().toISOString();
            fetchedRecords.push(...stamped);
            fetchedCias.push(cia);
            fetchedTimestamps[cia] = ts;
            succeeded += 1;
            if (succeeded === 1) commitEarly(cia, stamped, ts);
          } catch {
            errors += 1;
            failedCias.push(cia);
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
      if (failedCias.length > 0) {
        console.error(
          `[cxp] ${failedCias.length}/${ciasToFetch.length} cías fallaron tras retries: ${failedCias.join(', ')}`,
        );
        // El slot del boot sólo marca 'error' si fallaron TODAS, así que el
        // splash abre la app con estas cías faltando y sin señal para el
        // usuario. Registrarlas como hueco de sesión las hace visibles en
        // "Salud de datos" (no cambia el gate ni los datos cargados).
        for (const cia of failedCias) reportDataGap('cxp', 'cia-failed', cia);
      }
      const allFailed = errors === ciasToFetch.length;
      setBootSlot('cxp', allFailed ? 'error' : 'done');
      setDatasetSlot('cxp', allFailed ? 'error' : 'ready');
    })();
  }, [requestedDatasets, storeHydrated, companies, cxpRecords, cxpLoadedCias, idbHydratedDatasets, setBootSlot, setDatasetSlot]);

  // ── Auto-load Compras (Órdenes de Compra) durante el boot ──
  // Cambio JDE (dev 2026-05-19): /compras ahora exige `cia` en el body — UNA
  // compañía por request (antes era global). Recorremos las cías activas con
  // un pool de concurrencia acotado (espejo del loader de Cobranza). Cada cía
  // hace su propio delta-sync contra el cache diario por cía y guarda su
  // timestamp en comprasLoadedCias[cia]; además dejamos un agregado bajo
  // COMPRAS_CACHE_KEY ('__all__') para la pestaña Compras que muestra "última
  // carga". No bloquea el splash — corre en segundo plano una vez que
  // companies cargó.
  const comprasAutoFetchDone = useRef(false);
  useEffect(() => {
    if (comprasAutoFetchDone.current) return;
    if (!requestedDatasets.has('compras')) return;
    if (!storeHydrated) return;
    if (companies.length === 0) return;
    // Esperar la hidratación IDB: sin esto comprasRecords está vacío y el sync
    // hace un backfill FULL aunque la cache exista.
    if (!idbHydratedDatasets.has('compras')) return;
    // Doble filtro: exclusión global (filterActiveCompanies tira 33 y
    // cualquier multicarga) + whitelist explícito de cías con OCs reales.
    const activeCias = filterActiveCompanies(companies)
      .map(c => c.cia)
      .filter(cia => COMPRAS_ALLOWED_CIAS.has(cia));
    if (activeCias.length === 0) {
      comprasAutoFetchDone.current = true;
      setBootSlot('compras', 'done');
      setDatasetSlot('compras', 'ready');
      return;
    }
    const hasHydratedRecords = comprasRecords.length > 0;
    const ciasToFetch = hasHydratedRecords
      ? activeCias.filter(cia => !isFreshTimestamp(comprasLoadedCias[cia], COMPRAS_AUTO_REFRESH_TTL_MS))
      : activeCias;
    if (ciasToFetch.length === 0) {
      comprasAutoFetchDone.current = true;
      setBootSlot('compras', 'done');
      setDatasetSlot('compras', 'ready');
      return;
    }
    comprasAutoFetchDone.current = true;
    setBootSlot('compras', 'loading');
    setDatasetSlot('compras', 'loading');
    const today = new Date();
    // Tope superior = hoy. NO pedimos días futuros — el API solo indexa OCs
    // ya emitidas/recibidas, así que cualquier `fechaFinal > today` devuelve
    // `data: []`. En esta branch (no-long-term-projection) NO se proyectan
    // OCs futuras no emitidas: el egreso de compras es solo OC real
    // (F_Recepcion + D_Credito) + CXP abierto.
    const fechaFinal = today.toISOString().slice(0, 10);
    // Ventana por defecto uniforme (año en curso + 12 meses atrás). Cubre el
    // año fiscal de compras que la auditoría Pago↔CXP↔OC necesita; OCs previas
    // se cargan bajo demanda (DataWindowContext). El piso de OCs aún ABIERTAS
    // se extiende aparte vía COMPRAS_MAX_REVALIDATE_LOOKBACK_DAYS (siguen vivas).
    const lookbackStart = defaultWindowFloor(today);
    (async () => {
      try {
        // El cache mensual (M:compras.{cia}.{YYYY-MM}) hace el delta-sync
        // implícito: meses pasados ya cacheados se sirven sin red, mes en
        // curso se re-fetch. Por eso pasamos siempre [lookbackStart, today];
        // el helper decide qué meses pedir.
        await primeDailyCache();
        const fetchedTimestamps: Record<string, string> = {};
        const fetchedByCia = new Map<string, ComprasRecord[]>();
        const errors: string[] = [];

        // ── Frescura de datos (Etapa 1) ──
        // El cache mensual sirve meses pasados sin red, así que una OC que
        // cambia de estado/importe DESPUÉS de cachearse quedaba stale. Por cía
        // re-validamos: (a) los últimos COMPRAS_REVALIDATE_MONTHS meses, y (b)
        // el mes de CADA OC aún en estado no-terminal (sinEntrada/porPagar) —
        // las únicas que todavía pueden moverse. Conjunto explícito (no umbral)
        // para no re-pedir todo el histórico por una OC abierta vieja.
        const revalidateFloorDay = isoDaysBefore(fechaFinal, COMPRAS_MAX_REVALIDATE_LOOKBACK_DAYS);
        const revalidateFloorMonth = revalidateFloorDay.slice(0, 7);
        const lookbackMonth = lookbackStart.slice(0, 7);
        const recentMonths: string[] = [];
        // Mes actual + (COMPRAS_REVALIDATE_MONTHS − 1) previos = N meses.
        for (let m = 0; m < COMPRAS_REVALIDATE_MONTHS; m++) {
          const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - m, 1));
          recentMonths.push(d.toISOString().slice(0, 7));
        }
        const openMonthsByCia = new Map<string, Set<string>>();
        for (const r of comprasRecords) {
          const estado = compraEstado(r);
          if (estado !== 'sinEntrada' && estado !== 'porPagar') continue;
          const month = (r.fechaPedido || r.fechaRecepcion || '').slice(0, 7);
          if (month.length !== 7 || month < revalidateFloorMonth) continue;
          let set = openMonthsByCia.get(r.cia);
          if (!set) { set = new Set<string>(); openMonthsByCia.set(r.cia, set); }
          set.add(month);
        }

        let cursor = 0;
        const concurrency = Math.min(10, ciasToFetch.length);
        const worker = async () => {
          while (true) {
            const idx = cursor++;
            if (idx >= ciasToFetch.length) return;
            const cia = ciasToFetch[idx];
            // Meses a revalidar de esta cía = ventana reciente + meses con OCs
            // abiertas. Extendemos `from` para que los meses más viejos que el
            // lookback estándar entren al rango (los intermedios salen del
            // cache, baratos).
            const revalidateMonths = new Set<string>(recentMonths);
            const openSet = openMonthsByCia.get(cia);
            if (openSet) for (const m of openSet) revalidateMonths.add(m);
            let minRevalidateMonth = lookbackMonth;
            for (const m of revalidateMonths) if (m < minRevalidateMonth) minRevalidateMonth = m;
            const ciaFrom = minRevalidateMonth < lookbackMonth
              ? (`${minRevalidateMonth}-01` < revalidateFloorDay ? revalidateFloorDay : `${minRevalidateMonth}-01`)
              : lookbackStart;
            try {
              const fetched = await fetchComprasRange(cia, ciaFrom, fechaFinal, { concurrency: 4, revalidateMonths });
              fetchedByCia.set(cia, fetched);
              fetchedTimestamps[cia] = new Date().toISOString();
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              errors.push(`${cia}: ${msg}`);
              reportDataGap('compras', 'cia-failed', `${cia}: ${msg}`);
            }
          }
        };
        await Promise.all(Array.from({ length: concurrency }, worker));

        const fetchedAll: ComprasRecord[] = [];
        for (const recs of fetchedByCia.values()) fetchedAll.push(...recs);
        const openOcMonths = Array.from(openMonthsByCia.values()).reduce((acc, s) => acc + s.size, 0);
        // eslint-disable-next-line no-console
        console.info(`[compras] boot sync · ${ciasToFetch.length} cías · ${fetchedAll.length} OCs · ${errors.length} errores · revalidando ${recentMonths.length} meses recientes + ${openOcMonths} mes(es) con OCs abiertas en ${openMonthsByCia.size} cías`);
        if (fetchedAll.length > 0) {
          // Siempre merge — nunca reemplazar. El delta sólo pide días nuevos;
          // los históricos hidratados desde el store deben preservarse. La
          // llave incluye cia, así que no hay colisión entre compañías.
          setComprasRecords(prev => {
            const map = new Map<string, ComprasRecord>();
            for (const r of prev) map.set(`${r.cia}::${r.noOrden}::${r.lineaOrden}`, r);
            for (const r of fetchedAll) map.set(`${r.cia}::${r.noOrden}::${r.lineaOrden}`, r);
            return Array.from(map.values());
          });
        }
        if (Object.keys(fetchedTimestamps).length > 0) {
          const aggregate = new Date().toISOString();
          setComprasLoadedCias(prev => ({ ...prev, ...fetchedTimestamps, [COMPRAS_CACHE_KEY]: aggregate }));
        }
        if (errors.length > 0 && fetchedAll.length === 0) {
          comprasAutoFetchDone.current = false;
          setBootSlot('compras', 'error');
          setDatasetSlot('compras', 'error');
          console.error('[compras] auto-fetch falló en todas las cías', errors.slice(0, 3).join('; '));
        } else {
          setBootSlot('compras', 'done');
          setDatasetSlot('compras', 'ready');
        }
      } catch (err) {
        // Reset the guard so el usuario puede reintentar manualmente desde la
        // pestaña Compras sin reload. Loggeamos para que la falla no quede
        // muda — el silencio anterior dejaba "no muestra nada" sin pista.
        comprasAutoFetchDone.current = false;
        setBootSlot('compras', 'error');
        setDatasetSlot('compras', 'error');
        console.error('[compras] auto-fetch falló', err);
      }
    })();
  }, [requestedDatasets, storeHydrated, companies, comprasLoadedCias, comprasRecords.length, idbHydratedDatasets, setBootSlot, setDatasetSlot]);

  // ── Auto-load Auxiliar Contable durante el boot ──
  // Libro mayor JDE posteado contra cuentas de banco/caja (objeto 1010-1020).
  // Fuente del motor de conciliación histórica banco↔ERP. UNA compañía por
  // request — recorremos las cías activas con un pool acotado (espejo del
  // loader de Compras). Ventana = 1° de enero del año en curso → hoy, la
  // misma que el backfill de bancos, para que ambos lados del cruce cubran
  // el mismo rango. NO gatea el splash: corre en segundo plano.
  const auxiliarAutoFetchDone = useRef(false);
  useEffect(() => {
    if (auxiliarAutoFetchDone.current) return;
    if (!requestedDatasets.has('auxiliar')) return;
    if (!storeHydrated) return;
    if (companies.length === 0) return;
    if (!idbHydratedDatasets.has('auxiliar')) return;
    // Allowlist explícita para auxiliar contable (auxiliarReconciliationConfig).
    // Cía 33 (multicarga) salió de la allowlist el 2026-08-05 junto con la
    // reactivación de su exclusión global — ya no se fetchea en ningún módulo.
    const activeCias = companies
      .filter(c => c.activa !== false && isAuxiliarAllowlistedCia(c.cia))
      .map(c => c.cia);
    if (activeCias.length === 0) {
      auxiliarAutoFetchDone.current = true;
      setBootSlot('auxiliar', 'done');
      setDatasetSlot('auxiliar', 'ready');
      return;
    }
    const hasHydratedRecords = auxiliarContableRecords.length > 0;
    // Cobertura YTD por cía: refetch si hay agujero entre el floor del año
    // y hoy. TTL fresh sólo significa "ya refresqué este boot", no "ventana
    // completa". Floor = inicio del año en curso (KPIs YTD del dashboard).
    //
    // Detección de agujero: cualquier cía con `maxDate < today` necesita
    // delta-sync (días recientes); cualquier cía con `minDate > floor`
    // necesita backfill (días viejos de la ventana). Ambos → refetch.
    // Floor = ventana por defecto uniforme (año en curso + 12 meses atrás).
    const expectedFloorDate = defaultWindowFloor();
    const expectedTopDate = new Date().toISOString().slice(0, 10);
    const minDateByCia = new Map<string, string>();
    const maxDateByCia = new Map<string, string>();
    for (const r of auxiliarContableRecords) {
      if (r.cuentaObjeto !== '1020') continue;
      const minP = minDateByCia.get(r.cia);
      if (!minP || r.fechaContable < minP) minDateByCia.set(r.cia, r.fechaContable);
      const maxP = maxDateByCia.get(r.cia);
      if (!maxP || r.fechaContable > maxP) maxDateByCia.set(r.cia, r.fechaContable);
    }
    const ciasToFetch = hasHydratedRecords
      ? activeCias.filter(cia => {
          if (!isFreshTimestamp(auxiliarContableLoadedCias[cia], COMPRAS_AUTO_REFRESH_TTL_MS)) return true;
          const minDate = minDateByCia.get(cia);
          const maxDate = maxDateByCia.get(cia);
          // Sin records → necesita fetch (cía nueva).
          if (!minDate || !maxDate) return true;
          // Cobertura insuficiente del YTD por el lado viejo → backfill.
          if (minDate > expectedFloorDate) return true;
          // Cobertura stale por el lado nuevo → delta sync.
          if (maxDate < expectedTopDate) return true;
          return false;
        })
      : activeCias;
    if (ciasToFetch.length === 0) {
      auxiliarAutoFetchDone.current = true;
      setBootSlot('auxiliar', 'done');
      setDatasetSlot('auxiliar', 'ready');
      return;
    }
    auxiliarAutoFetchDone.current = true;
    setBootSlot('auxiliar', 'loading');
    setDatasetSlot('auxiliar', 'loading');
    const today = new Date();
    const fechaFinal = today.toISOString().slice(0, 10);
    // Piso = ventana por defecto uniforme (`defaultWindowFloor`: año en curso +
    // 12 meses atrás). Antes bajaba hasta 2 años con piso duro 2025-01-01;
    // ahora arranca en el piso compartido y los libros previos se cargan bajo
    // demanda (DataWindowContext). El clamp `bootClampStart` (abajo) usa el
    // mismo piso, así que la ventana efectiva por cía es [piso, hoy].
    const lookbackStart = defaultWindowFloor(today);
    (async () => {
      try {
        await primeDailyCache();
        // Delta sync per-cia (mismo patrón que pagos/compras). Antes hacíamos
        // backfill FULL 1.5yr en cada cia cuando TTL expiraba — el chunked
        // daily-cache filtra chunks ya cacheados pero los gaps fuerzan
        // cientos de requests por boot. Con delta: arrancamos en
        // `lastSeen + 1` por cia, sólo el delta pega el API.
        //
        // `lastSeen` = MÁX entre daily-cache IDB y heavy-store
        // (`auxiliarContableRecords[].fechaContable`). Necesitamos ambos: el
        // daily-cache se vacía/poda y el heavy-store sobrevive (cuota
        // dinámica IDB) — sin leer heavy-store un cache wipe nos manda al
        // full backfill aunque el histórico ya esté hidratado en estado.
        const maxStateByCia = new Map<string, string>();
        for (const r of auxiliarContableRecords) {
          const prev = maxStateByCia.get(r.cia);
          if (!prev || r.fechaContable > prev) maxStateByCia.set(r.cia, r.fechaContable);
        }
        // Boot clamp: lookback dinámico hasta el piso de la ventana por defecto
        // (`defaultWindowFloor`: año en curso + 12 meses atrás). Antes era fijo
        // 7 días → la conciliación cruzaba 96% sobre 8 días vs YTD banco 5 meses
        // ⇒ solo 6% de los ingresos YTD aparecían cruzados. Libros previos al
        // piso se cargan bajo demanda (DataWindowContext).
        //
        // Riesgo mitigado: el chunked-daily-cache filtra días ya hidratados
        // (IDB `auxiliarcontable.{cia}.{YYYY-MM-DD}`), así que un boot warm
        // solo pide los días faltantes. Timeout JDE subido a 240s para
        // cierre-de-mes pesados. NO gatea el splash — el splash gatea por
        // `done|error` no por tiempo, y la pestaña Conciliación tolera
        // resultados vacíos hasta que llegue.
        const bootClampStart = defaultWindowFloor(today);
        // Revalidación de días PARCIALES del auxiliar: pólizas se postean con
        // atraso, así que re-pedimos los días recientes aunque estén cacheados
        // (main no revalidaba el cache chunked). Floor del rango a la ventana +
        // `revalidateSince` al fetcher para forzar el re-fetch de esos días.
        const auxRevalidateSince = isoDaysBefore(fechaFinal, AUX_PARTIAL_REVALIDATE_DAYS);
        const perCiaFechaInicial = new Map<string, string>();
        for (const cia of ciasToFetch) {
          const maxCached = getMaxCachedDay('auxiliarcontable', cia);
          const maxState = maxStateByCia.get(cia) ?? null;
          const lastSeen = maxCached && maxState
            ? (maxCached > maxState ? maxCached : maxState)
            : (maxCached ?? maxState);
          const candidateFrom = lastSeen ? nextIsoDay(lastSeen) : lookbackStart;
          const flooredFrom = candidateFrom < lookbackStart ? lookbackStart : candidateFrom;
          // Clamp al inicio del año en curso — refleja la ventana YTD de los KPIs.
          let clamped = flooredFrom < bootClampStart ? bootClampStart : flooredFrom;
          // Bajar el piso a la ventana de revalidación (sin pasar del año YTD)
          // para que los días recientes cacheados entren al rango.
          if (clamped > auxRevalidateSince) {
            clamped = auxRevalidateSince < bootClampStart ? bootClampStart : auxRevalidateSince;
          }
          perCiaFechaInicial.set(cia, clamped);
        }
        const errors: string[] = [];
        let successCount = 0;
        let totalLines = 0;

        // Persistencia incremental PER-DÍA. Antes esperábamos a que la cía
        // entera completara sus ~520 días para hacer save — para la primera
        // cía eso son decenas de minutos (peor en cold boot). Ahora cada día
        // exitoso (cache hit o fresh fetch) llama `onDay`; mergeamos al Map
        // compartido y un throttler escribe IDB cada 3s si está sucio.
        // 28 cías × 520 días × 1 write c/u sería ~14k writes — el throttler
        // colapsa ráfagas a 1 write por intervalo, así que en práctica son
        // pocas decenas durante toda la carga.
        // Sólo llaves NUEVAS de este fetch en el Map + commit FUNCIONAL
        // (2026-07-15, espejo del fix de rol/cobranza): sembrar el Map del
        // estado y commitear el snapshot completo pisaba (estado + IDB) las
        // llaves que backfillAuxiliar hubiera commiteado mientras este loader
        // seguía en vuelo. `seenKeys` conserva el dedup contra lo ya
        // hidratado; el overlay funcional sobre `prev` conserva lo ajeno.
        const keyOf = (r: AuxiliarContableRecord) =>
          `${r.cia}::${r.idCuenta}::${r.noDocto}::${r.tipoDocto}`;
        const seenKeys = new Set<string>();
        for (const r of auxiliarContableRecords) {
          seenKeys.add(keyOf(r));
        }
        const mergedByKey = new Map<string, AuxiliarContableRecord>();
        let dirty = false;
        const flush = (label: string) => {
          if (!dirty) return;
          dirty = false;
          // eslint-disable-next-line no-console
          console.info(`[auxiliarcontable] flush (${label}) · merging ${mergedByKey.size} new keys`);
          setAuxiliarContableRecords(prev => {
            const byKey = new Map<string, AuxiliarContableRecord>();
            for (const r of prev) byKey.set(keyOf(r), r);
            for (const [k, r] of mergedByKey) byKey.set(k, r);
            const snapshot = Array.from(byKey.values());
            void saveHeavyRecords('auxiliarContableRecords', snapshot);
            return snapshot;
          });
        };
        const flushInterval = window.setInterval(() => flush('throttle'), 3000);

        const onDay = (batch: AuxiliarContableRecord[]) => {
          for (const r of batch) {
            const k = keyOf(r);
            if (!seenKeys.has(k) && !mergedByKey.has(k)) {
              mergedByKey.set(k, r);
              dirty = true;
            }
          }
        };

        let cursor = 0;
        const concurrency = Math.min(10, ciasToFetch.length);
        const worker = async () => {
          while (true) {
            const idx = cursor++;
            if (idx >= ciasToFetch.length) return;
            const cia = ciasToFetch[idx];
            const fechaInicial = perCiaFechaInicial.get(cia) ?? lookbackStart;
            if (fechaInicial > fechaFinal) {
              // Cache cubre hasta hoy — nada nuevo que traer. Marca timestamp
              // para que el TTL de 6h corra y no re-evaluemos este boot.
              successCount += 1;
              setAuxiliarContableLoadedCias(prev => ({ ...prev, [cia]: new Date().toISOString() }));
              // eslint-disable-next-line no-console
              console.info(`[auxiliarcontable] ${cia} · cache cubre hasta ${fechaFinal}, skip`);
              continue;
            }
            try {
              // eslint-disable-next-line no-console
              console.info(`[auxiliarcontable] ${cia} · fetch ${fechaInicial}→${fechaFinal} (${fechaInicial === lookbackStart ? 'FULL' : 'DELTA'})`);
              const fetched = await fetchAuxiliarContableRange(
                cia, fechaInicial, fechaFinal, AUX_RECON_PARAMS,
                { concurrency: 4, onDay, revalidateSince: auxRevalidateSince },
              );
              successCount += 1;
              totalLines += fetched.length;
              const timestamp = new Date().toISOString();
              // eslint-disable-next-line no-console
              console.info(`[auxiliarcontable] ${cia} · ${fetched.length} líneas · nuevas acumuladas=${mergedByKey.size}`);
              setAuxiliarContableLoadedCias(prev => ({ ...prev, [cia]: timestamp }));
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              errors.push(`${cia}: ${msg}`);
              reportDataGap('auxiliarcontable', 'cia-failed', `${cia}: ${msg}`);
              // eslint-disable-next-line no-console
              console.warn(`[auxiliarcontable] ${cia} fail: ${msg}`);
            }
          }
        };
        try {
          await Promise.all(Array.from({ length: concurrency }, worker));
        } finally {
          window.clearInterval(flushInterval);
          flush('final');
        }

        // eslint-disable-next-line no-console
        console.info(`[auxiliarcontable] boot sync · ${ciasToFetch.length} cías · ${totalLines} líneas nuevas · ${errors.length} errores · llaves nuevas=${mergedByKey.size}`);
        if (errors.length > 0 && successCount === 0) {
          auxiliarAutoFetchDone.current = false;
          setBootSlot('auxiliar', 'error');
          setDatasetSlot('auxiliar', 'error');
          console.error('[auxiliarcontable] auto-fetch falló en todas las cías', errors.slice(0, 3).join('; '));
        } else {
          setBootSlot('auxiliar', 'done');
          setDatasetSlot('auxiliar', 'ready');
        }
      } catch (err) {
        auxiliarAutoFetchDone.current = false;
        setBootSlot('auxiliar', 'error');
        setDatasetSlot('auxiliar', 'error');
        console.error('[auxiliarcontable] auto-fetch falló', err);
      }
    })();
  }, [requestedDatasets, storeHydrated, companies, auxiliarContableLoadedCias, auxiliarContableRecords.length, idbHydratedDatasets, setBootSlot, setDatasetSlot]);

  // ── Auto-load cuentas de IVA del libro mayor durante el boot ──
  // Fetch SEPARADO (cache `auxiliarcontable-iva`) con descubrimiento por nombre
  // de cuenta — alimenta el IVA REAL autoritativo del módulo de Impuestos. NO
  // toca la conciliación banco↔ERP (objeto 1010-1020). Corre en segundo plano,
  // falla suave (no gatea splash ni boot slot — cuelga del dataset 'auxiliar').
  const auxiliarIvaAutoFetchDone = useRef(false);
  useEffect(() => {
    if (auxiliarIvaAutoFetchDone.current) return;
    if (!requestedDatasets.has('auxiliar')) return;
    if (!storeHydrated) return;
    if (companies.length === 0) return;
    if (!idbHydratedDatasets.has('auxiliar')) return;
    const activeCias = companies
      .filter(c => c.activa !== false && isAuxiliarAllowlistedCia(c.cia))
      .map(c => c.cia);
    if (activeCias.length === 0) {
      auxiliarIvaAutoFetchDone.current = true;
      return;
    }
    const now = new Date();
    const expectedFloorDate = `${now.getUTCFullYear()}-01-01`;
    const expectedTopDate = now.toISOString().slice(0, 10);
    const ciasToFetch = activeCias.filter(cia => {
      const meta = auxiliarIvaLoadedCias[cia];
      if (!meta || meta.version !== AUX_IVA_LEDGER_VERSION) return true;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.loadedThrough)) return true;
      return meta.loadedThrough < expectedTopDate;
    });
    if (ciasToFetch.length === 0) {
      auxiliarIvaAutoFetchDone.current = true;
      return;
    }
    auxiliarIvaAutoFetchDone.current = true;
    const fechaFinal = expectedTopDate;
    const AUX_HARD_FLOOR = '2025-01-01';
    const bootClampStart = expectedFloorDate < AUX_HARD_FLOOR ? AUX_HARD_FLOOR : expectedFloorDate;

    const publishDiagnostic = (snapshot: AuxiliarContableRecord[]) => {
      try {
        const accounts = summarizeIvaAccounts(snapshot);
        const byPeriod = buildIvaLedgerByPeriod(snapshot);
        const periodsWithCaused = Array.from(byPeriod.values())
          .filter((period) => period.caused > 0)
          .map((period) => period.period)
          .sort();
        const periodsWithCreditable = Array.from(byPeriod.values())
          .filter((period) => period.creditable > 0)
          .map((period) => period.period)
          .sort();
        const w = window as unknown as { __midas__?: Record<string, unknown> };
        w.__midas__ = {
          ...(w.__midas__ ?? {}),
          ivaLedger: {
            recordCount: snapshot.length,
            version: AUX_IVA_LEDGER_VERSION,
            accounts,
            accountsByKind: groupIvaAccountsByKind(accounts),
            missingKindsByCia: missingIvaKindsByCia(accounts),
            periodsWithCaused,
            periodsWithCreditable,
            byPeriod: Object.fromEntries(byPeriod),
          },
        };
      } catch { /* diagnóstico best-effort */ }
    };

    (async () => {
      try {
        await primeDailyCache();
        // Floor del rango a la ventana de revalidación de días parciales
        // (espejo del loader del auxiliar principal): `revalidateSince` sólo
        // re-pide días DENTRO de [from..to], así que sin bajar el `from` el
        // watermark steady-state (loadedThrough = ayer) deja los días
        // recientes cacheados PARCIALES fuera del rango para siempre.
        const ivaRevalidateSince = isoDaysBefore(fechaFinal, AUX_PARTIAL_REVALIDATE_DAYS);
        const perCiaFechaInicial = new Map<string, string>();
        for (const cia of ciasToFetch) {
          const meta = auxiliarIvaLoadedCias[cia];
          const lastSeen = meta?.version === AUX_IVA_LEDGER_VERSION ? meta.loadedThrough : null;
          const candidateFrom = lastSeen ? nextIsoDay(lastSeen) : bootClampStart;
          let clamped = candidateFrom < bootClampStart ? bootClampStart : candidateFrom;
          if (clamped > ivaRevalidateSince) {
            clamped = ivaRevalidateSince < bootClampStart ? bootClampStart : ivaRevalidateSince;
          }
          perCiaFechaInicial.set(cia, clamped);
        }

        // Sólo llaves NUEVAS de este fetch en el Map + commit FUNCIONAL
        // (espejo del fix del auxiliar de conciliación): sembrar el Map del
        // estado y commitear el snapshot completo pisaría (estado + IDB) lo
        // que cualquier escritor concurrente commitee mientras este loader
        // sigue en vuelo. `seenKeys` conserva el dedup contra lo hidratado.
        const keyOf = (r: AuxiliarContableRecord) =>
          `${r.cia}::${r.idCuenta}::${r.noDocto}::${r.tipoDocto}`;
        const seenKeys = new Set<string>();
        for (const r of auxiliarIvaRecords) seenKeys.add(keyOf(r));
        const mergedByKey = new Map<string, AuxiliarContableRecord>();
        let dirty = false;
        const flush = () => {
          if (!dirty) return;
          dirty = false;
          setAuxiliarIvaRecords(prev => {
            const byKey = new Map<string, AuxiliarContableRecord>();
            for (const r of prev) byKey.set(keyOf(r), r);
            for (const [k, r] of mergedByKey) byKey.set(k, r);
            const snapshot = Array.from(byKey.values());
            void saveHeavyRecords('auxiliarIvaRecords', snapshot);
            publishDiagnostic(snapshot);
            return snapshot;
          });
        };
        const flushInterval = window.setInterval(flush, 3000);
        const onDay = (batch: AuxiliarContableRecord[]) => {
          for (const r of batch) {
            const k = keyOf(r);
            if (!seenKeys.has(k) && !mergedByKey.has(k)) {
              mergedByKey.set(k, r);
              dirty = true;
            }
          }
        };

        let cursor = 0;
        const concurrency = Math.min(6, ciasToFetch.length);
        const worker = async () => {
          while (true) {
            const idx = cursor++;
            if (idx >= ciasToFetch.length) return;
            const cia = ciasToFetch[idx];
            const fechaInicial = perCiaFechaInicial.get(cia) ?? bootClampStart;
            if (fechaInicial > fechaFinal) {
              setAuxiliarIvaLoadedCias(prev => ({
                ...prev,
                [cia]: {
                  version: AUX_IVA_LEDGER_VERSION,
                  loadedThrough: fechaFinal,
                  refreshedAt: new Date().toISOString(),
                },
              }));
              continue;
            }
            try {
              // Misma ventana de revalidación de días parciales que el
              // auxiliar de conciliación: las pólizas de IVA se postean con
              // atraso y el namespace de IVA no revalidaba.
              await fetchAuxiliarContableIvaRange(cia, fechaInicial, fechaFinal, {
                onDay,
                revalidateSince: ivaRevalidateSince,
              });
              setAuxiliarIvaLoadedCias(prev => ({
                ...prev,
                [cia]: {
                  version: AUX_IVA_LEDGER_VERSION,
                  loadedThrough: fechaFinal,
                  refreshedAt: new Date().toISOString(),
                },
              }));
            } catch (err) {
              console.warn(`[iva-ledger] ${cia} fail: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        };
        // Vista local hidratado+nuevo para diagnóstico/logs (no toca estado;
        // el flush funcional ya publicó el snapshot real via el updater).
        const finalByKey = new Map<string, AuxiliarContableRecord>();
        try {
          await Promise.all(Array.from({ length: concurrency }, worker));
        } finally {
          window.clearInterval(flushInterval);
          flush();
          for (const r of auxiliarIvaRecords) finalByKey.set(keyOf(r), r);
          for (const [k, r] of mergedByKey) finalByKey.set(k, r);
          publishDiagnostic(Array.from(finalByKey.values()));
        }
        // eslint-disable-next-line no-console
        console.info(`[iva-ledger] boot sync · ${ciasToFetch.length} cías · total=${finalByKey.size} · nuevas=${mergedByKey.size} · window.__midas__.ivaLedger`);
        const accounts = summarizeIvaAccounts(Array.from(finalByKey.values()));
        const hasCreditableByCia = new Set(accounts.filter((account) => account.kind === 'creditable').map((account) => account.cia));
        const missing = missingIvaKindsByCia(accounts);
        for (const [cia, kinds] of Object.entries(missing)) {
          if (hasCreditableByCia.has(cia) && kinds.includes('caused')) {
            console.warn(`[iva-ledger] ${cia} tiene IVA acreditable/otros pero cero cuentas de IVA causado detectadas; revisar window.__midas__.ivaLedger.accountsByKind y VITE_AUX_IVA_OBJETOS.`);
          }
        }
      } catch (err) {
        auxiliarIvaAutoFetchDone.current = false;
        console.warn('[iva-ledger] auto-fetch falló', err);
      }
    })();
  }, [requestedDatasets, storeHydrated, companies, auxiliarIvaLoadedCias, auxiliarIvaRecords.length, idbHydratedDatasets]);

  // ── Auto-load PagoProveedor durante el boot ──
  // Endpoint global (no filtra por cia, igual que /compras). Mismo lookback
  // que compras (COMPRAS_LOOKBACK_DAYS=180) para que la ventana de
  // conciliación pagos↔CXP↔banco sea coherente con las OCs aún abiertas.
  // Reusa COMPRAS_* constants: misma forma de cache + TTL.
  const pagoProveedorAutoFetchDone = useRef(false);
  useEffect(() => {
    if (pagoProveedorAutoFetchDone.current) return;
    if (!requestedDatasets.has('pagos')) return;
    if (!storeHydrated) return;
    if (companies.length === 0) return;
    // Esperar la hidratación IDB: sin esto pagoProveedorRecords está vacío y el
    // sync hace un backfill FULL aunque la cache exista.
    if (!idbHydratedDatasets.has('pagos')) return;
    if (pagoProveedorRecords.length > 0 && isFreshTimestamp(pagoProveedorLoadedCias[COMPRAS_CACHE_KEY], COMPRAS_AUTO_REFRESH_TTL_MS)) {
      pagoProveedorAutoFetchDone.current = true;
      setBootSlot('pagos', 'done');
      setDatasetSlot('pagos', 'ready');
      return;
    }
    pagoProveedorAutoFetchDone.current = true;
    setBootSlot('pagos', 'loading');
    setDatasetSlot('pagos', 'loading');
    const today = new Date();
    const fechaFinal = today.toISOString().slice(0, 10);
    // Ventana por defecto uniforme (año en curso + 12 meses atrás); pagos
    // previos se cargan bajo demanda (DataWindowContext).
    const lookbackStart = defaultWindowFloor(today);
    (async () => {
      try {
        // Delta sync — mismo patrón que Compras. Ver comentario allá.
        await primeDailyCache();
        const maxCached = getMaxCachedDay('pagoproveedor');
        const hasHydratedRecords = pagoProveedorRecords.length > 0;
        const candidateFrom = maxCached ? nextIsoDay(maxCached) : lookbackStart;
        // Frescura (Etapa 1): re-validar los últimos PAGOS_REVALIDATE_DAYS días
        // aunque el watermark ya los cubra — un pago capturado con atraso entra
        // a JDE sobre un día que el navegador ya cacheó, y el delta lo saltaría
        // para siempre. La ventana baja el `from` y `revalidateSince` fuerza el
        // re-fetch de esos días cacheados.
        const revalidateSince = isoDaysBefore(fechaFinal, PAGOS_REVALIDATE_DAYS);
        let fechaInicial = (hasHydratedRecords && maxCached && candidateFrom >= lookbackStart)
          ? candidateFrom
          : lookbackStart;
        if (fechaInicial > revalidateSince && revalidateSince >= lookbackStart) {
          fechaInicial = revalidateSince;
        }
        // eslint-disable-next-line no-console
        console.info(`[pagoproveedor] boot sync · maxCachedIDB=${maxCached ?? 'none'} · hydratedState=${pagoProveedorRecords.length} · fetch ${fechaInicial}→${fechaFinal} (${fechaInicial === lookbackStart ? 'FULL' : 'DELTA'}) · revalidateSince=${revalidateSince}`);

        if (fechaInicial > fechaFinal) {
          // eslint-disable-next-line no-console
          console.info('[pagoproveedor] boot sync · nada nuevo, cache cubre hasta hoy');
          setPagoProveedorLoadedCias({ [COMPRAS_CACHE_KEY]: new Date().toISOString() });
          setBootSlot('pagos', 'done');
          setDatasetSlot('pagos', 'ready');
          return;
        }

        const fetched = await fetchPagoProveedorRange(fechaInicial, fechaFinal, { concurrency: 10, revalidateSince });
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
        setBootSlot('pagos', 'done');
        setDatasetSlot('pagos', 'ready');
      } catch (err) {
        pagoProveedorAutoFetchDone.current = false;
        setBootSlot('pagos', 'error');
        setDatasetSlot('pagos', 'error');
        console.error('[pagoproveedor] auto-fetch falló', err);
      }
    })();
  }, [requestedDatasets, storeHydrated, companies, pagoProveedorLoadedCias, pagoProveedorRecords.length, idbHydratedDatasets, setBootSlot, setDatasetSlot]);

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
      const activeCias = filterActiveCompanies(companies).map(c => c.cia);
      if (activeCias.length === 0) {
        setCobranzaError('No hay compañías activas en el catálogo.');
        return;
      }
      const heavyHydrated = cobranzaRecords.length > 0 || cobranzaPayments.length > 0;
      // Desync guard (mismo hardening que nómina `shouldSkip`): si el heavy
      // store (IDB, 2 años de historia) hidrató VACÍO — open-timeout de 5s,
      // sesión previa muerta a mitad del backfill antes del save debounced, o
      // evicción — los timestamps light de localStorage (`cobranzaLoadedCias`)
      // siguen "frescos" y el delta-sync skippea toda cía → cobranza queda
      // vacía para siempre y "no carga histórico" hasta un refresh manual.
      // Si no hay records hidratados, NO confíes en los timestamps: refetch
      // completo (2 años, todas las cías) en vez de quedarte en vacío.
      //
      // Tampoco usamos el `lastSaved` global como fallback por cía: una cía sin
      // timestamp propio es nueva (nunca consultada) y debe cargarse — marcarla
      // fresca con el global la dejaba vacía para siempre (divergencia entre
      // navegadores). Las cías que regresaron vacío ya tienen su stamp.
      // Plan por cía: `full` (histórico completo, REPLACE + re-estampa) vs
      // `revalidate` (sólo la ventana reciente, merge date-particionado, NO
      // re-estampa). Cierra el hueco "faltan facturas recién dadas de alta en
      // una cía fresca" (caso 6-jul) espejando la revalidación de días
      // recientes de Pagos/Bancos. En el default (`clear-on-entry`) el
      // heavy-store arranca vacío → todas salen `full` (comportamiento igual).
      const plans = planCobranzaRefresh({
        activeCias,
        force,
        heavyHydrated,
        recordsLoadedCias: cobranzaLoadedCias,
        paymentsLoadedCias: cobranzaPaymentsLoadedCias,
        nowMs: Date.now(),
        ttlMs: COBRANZA_AUTO_REFRESH_TTL_MS,
        lookbackDays: COBRANZA_LOOKBACK_DAYS,
        revalidateDays: COBRANZA_REVALIDATE_DAYS,
        // Ventana por defecto uniforme: año en curso + 12 meses atrás. La
        // historia previa a este piso se carga bajo demanda al consultar años
        // previos (DataWindowContext). Antes el `full` bajaba 24 meses fijos.
        fullFrom: defaultWindowFloor(),
      });
      const fullCiasCount = plans.filter(p => p.mode === 'full').length;
      // eslint-disable-next-line no-console
      console.info(`[cobranza] sync · ${plans.length}/${activeCias.length} cías (${fullCiasCount} full · ${plans.length - fullCiasCount} revalida ${COBRANZA_REVALIDATE_DAYS}d) · force=${force} · TTL ${Math.round(COBRANZA_AUTO_REFRESH_TTL_MS / 3600000)}h · hydratedRecords=${cobranzaRecords.length}`);
      if (plans.length === 0) return;
      setCobranzaRefreshing(true);
      setCobranzaError(null);
      if (progressSlot === 'cobranza') {
        setCobranzaBootProgress({ done: 0, total: plans.length });
      }

      const errors: string[] = [];
      let totalRecords = 0;
      // Cold-boot OOM hardening (2026-05-20): commit per-cia inside the worker
      // instead of accumulating ALL 30 cias × 2 years in transient arrays
      // before the final setState. Cold boot was OOMing at ~2GB Main because
      // the closure held the entire pre-commit dataset + the per-call response
      // arrays simultaneously. Per-cia commit lets the response array go
      // GC-eligible as soon as it lands in React state.
      //
      // Persistencia EAGER per-cia a IDB (2026-05-26): el reactive
      // `useHeavySaver` debouncea 3.4s. Si el usuario refresca a media carga
      // (28 cías × 2 años, decenas de minutos), las payments/records ya
      // commiteados en React se pierden del heavy-store al recargar — mismo
      // síntoma que aux/rol antes del fix 88746b5. Disparamos
      // `saveHeavyRecords` tras cada cía; el saveQueues interno de
      // heavyStoreIDB serializa los writes, así que 28 cías × 2 keys no
      // compiten.
      //
      // Commits FUNCIONALES sobre `prev` (2026-07-11): antes se sembraba un
      // Map local del estado al ARRANCAR y cada cía commiteaba el flatten
      // completo (`setX(snapshot)` no-funcional) — un backfill de años
      // históricos (DataWindowContext) que commiteara mientras este refresh
      // estaba en vuelo era pisado por el siguiente snapshot y PERSISTIDO
      // fuera de IDB. Mergear dentro del updater (mismo patrón que
      // backfillCobranza) hace ambos flujos conmutativos y preserva el
      // commit per-cía del hardening OOM.
      let completed = 0;
      let cursor = 0;
      const concurrency = Math.min(10, plans.length);
      const worker = async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= plans.length) return;
          const { cia, mode, from, to } = plans[idx];
          const [recordsResult, paymentsResult] = await Promise.allSettled([
            fetchCobranzaRange(cia, from, to, { concurrency: 10 }),
            fetchIndicadoresCobranzaRange(cia, from, to, { concurrency: 10 }),
          ]);
          if (recordsResult.status === 'fulfilled') {
            const stamped = recordsResult.value.map(r => ({ ...r, cia: r.cia || cia }));
            totalRecords += stamped.length;
            // AMBOS modos hacen merge date-particionado sobre lo ya cargado:
            // `full` reemplaza en bloque SU ventana [fullFrom, hoy] (purga
            // cancelaciones/fantasmas dentro de ella) pero CONSERVA la
            // historia anterior al piso — los años previos backfilleados por
            // DataWindowContext viven antes de `fullFrom` y un REPLACE seco
            // los borraba de estado + IDB mientras el controlador de backfill
            // seguía creyéndolos cubiertos (el año navegado quedaba vacío el
            // resto de la sesión). Con el heavy-store vacío (default
            // clear-on-entry) el merge sobre [] es idéntico al replace.
            // Commit this cia's records immediately; React 18 batches the
            // setState calls across the concurrency pool, so 30 calls don't
            // turn into 30 renders.
            setCobranzaRecords(prev => {
              const rest: CobranzaRecord[] = [];
              const base: CobranzaRecord[] = [];
              for (const r of prev) (r.cia === cia ? base : rest).push(r);
              const merged = rest.concat(mergeCobranzaRevalidationWindow(base, stamped, from));
              void saveHeavyRecords('cobranzaRecords', merged);
              return merged;
            });
            // Sólo `full` re-estampa el watermark: si `revalidate` lo tocara,
            // la cía quedaría "fresca" para siempre y el REPLACE correctivo
            // (que sanea cancelaciones/pagos de facturas viejas fuera de la
            // ventana) nunca correría → facturas fantasma.
            if (mode === 'full') {
              const ts = new Date().toISOString();
              setCobranzaLoadedCias(prev => ({ ...prev, [cia]: ts }));
            }
          } else {
            const msg = recordsResult.reason instanceof Error ? recordsResult.reason.message : String(recordsResult.reason);
            errors.push(`${cia}: ${msg}`);
            reportDataGap('cobranza', 'cia-failed', `${cia}: ${msg}`);
          }
          if (paymentsResult.status === 'fulfilled') {
            const payments = paymentsResult.value;
            // Merge por cia::idPago (lo fetcheado gana) en vez de replace:
            // fetchIndicadoresCobranzaRange tolera ventanas mensuales fallidas
            // y regresa un set PARCIAL — un replace destruía (y persistía vía
            // saveHeavyRecords) los meses de pagos que sí teníamos, rompiendo
            // el invariante "nunca degrada" de la capa de revalidación. La
            // llave lleva `cia` porque idPago NO es único global (JDE lo
            // secuencia por compañía; taxes ya llavea `cia:idPago`).
            setCobranzaPayments(prev => {
              const mergedPayments = new Map<string, CobranzaPayment>();
              for (const p of prev) mergedPayments.set(`${p.cia}::${p.idPago}`, p);
              for (const p of payments) mergedPayments.set(`${p.cia}::${p.idPago}`, p);
              const merged = Array.from(mergedPayments.values());
              void saveHeavyRecords('cobranzaPayments', merged);
              return merged;
            });
            // Mismo criterio que records: sólo `full` re-estampa (el merge de
            // pagos es aditivo por idPago y se refresca al expirar el TTL).
            if (mode === 'full') {
              const ts = new Date().toISOString();
              setCobranzaPaymentsLoadedCias(prev => ({ ...prev, [cia]: ts }));
            }
          } else {
            const msg = paymentsResult.reason instanceof Error ? paymentsResult.reason.message : String(paymentsResult.reason);
            errors.push(`indicadores ${cia}: ${msg}`);
            reportDataGap('cobranza-pagos', 'cia-failed', `${cia}: ${msg}`);
          }
          completed += 1;
          if (progressSlot === 'cobranza') {
            setCobranzaBootProgress({ done: completed, total: plans.length });
          }
        }
      };

      try {
        await Promise.all(Array.from({ length: concurrency }, worker));

        if (errors.length > 0) {
          setCobranzaError(`Errores en ${errors.length}/${plans.length} cías: ${errors.slice(0, 2).join('; ')}${errors.length > 2 ? '…' : ''}`);
        } else if (fullCiasCount > 0 && totalRecords === 0) {
          // Sólo alarma cuando hubo refetch `full` y NADA (ni full ni ventanas
          // revalidate) devolvió registros → token/permisos. Un boot 100%
          // revalidate con ventanas vacías es normal y no dispara el error.
          setCobranzaError(`Las cías consultadas respondieron VACÍO (incluye ${fullCiasCount} en modo full). Revisa el token productivo y permisos JDE para /cobranza. (Detalles en consola con prefix [cobranza].)`);
        }
        return {
          totalRecords,
          failedCias: errors.length,
          totalCias: plans.length,
        };
      } finally {
        setCobranzaRefreshing(false);
      }
    },
    [companies, cobranzaRecords, cobranzaPayments, cobranzaLoadedCias, cobranzaPaymentsLoadedCias],
  );

  // Cobranza ya forma parte de la ruta crítica del boot — no esperamos a que
  // el usuario abra el tab de Cobranza, lo jalamos en paralelo con CXP.
  const cobranzaAutoFetchDone = useRef(false);
  useEffect(() => {
    if (cobranzaAutoFetchDone.current) return;
    if (!requestedDatasets.has('cobranza')) return;
    if (!storeHydrated) return;
    if (companies.length === 0) return;
    // Esperar la hidratación IDB: sin esto cobranzaRecords está vacío y el sync
    // concluye "28/28 necesitan refresh" aunque la cache exista.
    if (!idbHydratedDatasets.has('cobranza')) return;
    const activeCias = filterActiveCompanies(companies);
    if (activeCias.length === 0) {
      cobranzaAutoFetchDone.current = true;
      setBootSlot('cobranza', 'done');
      setDatasetSlot('cobranza', 'ready');
      return;
    }
    cobranzaAutoFetchDone.current = true;
    setBootSlot('cobranza', 'loading');
    setDatasetSlot('cobranza', 'loading');
    (async () => {
      try {
        const summary = await refreshCobranza(false, 'cobranza');
        if (!summary) {
          setBootSlot('cobranza', 'done');
          setDatasetSlot('cobranza', 'ready');
          return;
        }
        const allFailed = summary.failedCias >= summary.totalCias * 2;
        setBootSlot('cobranza', allFailed ? 'error' : 'done');
        setDatasetSlot('cobranza', allFailed ? 'error' : 'ready');
      } catch {
        setBootSlot('cobranza', 'error');
        setDatasetSlot('cobranza', 'error');
      }
    })();
  }, [requestedDatasets, storeHydrated, companies, refreshCobranza, idbHydratedDatasets, setBootSlot, setDatasetSlot]);

  // ── ROL CITI: viajes ejecutados ─────────────────────────────────────────
  // Fetcheamos desde el 1° de enero del año en curso hasta hoy. El service
  // trocea el rango en ventanas diarias para que el API CITI no se vaya por
  // timeout. El resultado se persiste en IDB heavy-store y queda disponible
  // para cruzar contra cobranza por `factura`/`uuidFiscal` en flujos futuros.
  const refreshRol = useCallback(
    async (force = true, progressSlot?: 'rol') => {
      const today = new Date();
      const year = today.getUTCFullYear();
      // Ventana por defecto uniforme (año en curso + 12 meses atrás). Antes
      // ROL sólo bajaba el año en curso (`${year}-01-01`); ahora arranca en el
      // piso compartido para que Venta/Cobranza tengan 12 meses atrás por
      // defecto. Años previos → carga diferida (DataWindowContext). ROL corre
      // detrás del splash (Fase 0), así que el rango extra no retrasa el boot.
      const yearStart = defaultWindowFloor(today);
      const fechaFinal = today.toISOString().slice(0, 10);
      const cacheKey = `${year}:full`;
      // Refresh si force=true, si no hay cache aún, o si el timestamp es viejo.
      const lastFetch = rolLoadedKeys[cacheKey];
      if (!force && rolRecords.length > 0 && lastFetch && isFreshTimestamp(lastFetch, COBRANZA_AUTO_REFRESH_TTL_MS)) {
        return { totalRecords: rolRecords.length, totalCias: 1, failedCias: 0 };
      }
      // Delta sync: heavy-store rolRecords[].fechaViaje da el último día con
      // viajes hidratados. fetchRolRange parte el rango en ventanas DIARIAS
      // sin cache (cada día = 1 request a CITI). Sin delta, cada boot TTL-
      // expirado dispara ~145 ventanas Jan 1→today. Con delta arrancamos en
      // `lastSeen + 1`. force=true (refresh manual) mantiene full range.
      let maxState: string | null = null;
      for (const r of rolRecords) {
        if (r.fechaViaje && (!maxState || r.fechaViaje > maxState)) {
          maxState = r.fechaViaje;
        }
      }
      const fechaInicial = (!force && maxState && maxState >= yearStart)
        ? nextIsoDay(maxState)
        : yearStart;
      if (fechaInicial > fechaFinal) {
        // eslint-disable-next-line no-console
        console.info(`[rol] sync · heavy-store cubre hasta ${maxState}, skip (today=${fechaFinal})`);
        setRolLoadedKeys(prev => ({ ...prev, [cacheKey]: new Date().toISOString() }));
        return { totalRecords: rolRecords.length, totalCias: 1, failedCias: 0 };
      }

      if (progressSlot === 'rol') setRolBootProgress({ done: 0, total: 1 });

      try {
        // Upsert — NUNCA encoger la historia hidratada. Misma regla que
        // cobranza/compras: merge por llave, el fresco gana (un viaje que
        // adquiere `factura` actualiza → predicted→invoiced).
        const rolKey = (r: RolRecord) =>
          `${r.cia}::${r.kCliente}::${r.anio}::${r.semana}::${r.ruta}::${r.tipoViaje}`;

        // Persistencia incremental per-ventana: fetchRolRange procesa días
        // uno por uno (concurrency=2). Esperar al Promise.all final pierde
        // todo si el usuario recarga a media carga (~horas para un año).
        // El callback `onPartialBatch` dispara tras cada ventana exitosa;
        // mergeamos al Map compartido, setState y saveHeavyRecords. El
        // saveQueues interno de heavyStoreIDB serializa los writes.
        // Sólo llaves tocadas por ESTE refresh (2026-07-13): sembrar el Map
        // del estado inicial hacía que cada flush re-aplicara ese snapshot
        // stale COMPLETO sobre `prev`, pisando llaves que backfillRol hubiera
        // refrescado (estado + IDB) mientras este fetch estaba en vuelo —
        // clobber inverso al corregido el 2026-07-11. Las llaves no tocadas
        // las conserva el overlay funcional sobre `prev`.
        const mergedByKey = new Map<string, RolRecord>();
        const initialSize = rolRecords.length;
        // Flush con throttle temporal: en un refresh force sobre datos ya
        // hidratados TODO record refetcheado es un objeto nuevo (referencia
        // distinta) — persistir el array completo por cada ventana (~185 en
        // rango anual) era una tormenta de writes IDB + setState. El
        // throttle colapsa ráfagas a 1 write por intervalo; el flush final
        // (force) garantiza que nada quede sin persistir.
        let dirty = false;
        let lastFlushAt = 0;
        const flush = (force = false) => {
          if (!dirty) return;
          const now = Date.now();
          if (!force && now - lastFlushAt < 3000) return;
          dirty = false;
          lastFlushAt = now;
          // Commit funcional (2026-07-11): overlay del Map local sobre `prev`
          // en vez de reemplazar el estado con el snapshot — un backfill de
          // años previos (backfillRol) que commitee mientras este refresh
          // está en vuelo aportaba llaves que el Map (sembrado al arrancar)
          // no conoce y el snapshot las pisaba y las persistía fuera de IDB.
          setRolRecords(prev => {
            const byKey = new Map<string, RolRecord>();
            for (const r of prev) byKey.set(rolKey(r), r);
            for (const [k, r] of mergedByKey) byKey.set(k, r);
            const snapshot = Array.from(byKey.values());
            void saveHeavyRecords('rolRecords', snapshot);
            return snapshot;
          });
        };

        const records = await fetchRolRange(fechaInicial, fechaFinal, {
          onProgress: progressSlot === 'rol'
            ? (done, total) => setRolBootProgress({ done, total })
            : undefined,
          onPartialBatch: (batch) => {
            for (const r of batch) {
              const k = rolKey(r);
              if (mergedByKey.get(k) !== r) {
                mergedByKey.set(k, r);
                dirty = true;
              }
            }
            flush();
          },
        });

        // Reconciliación final contra el retorno de fetchRolRange, que ya
        // viene dedupeado LAST-WINS por ORDEN DE DÍA (slot), no por orden de
        // llegada: con concurrency 2 una ventana más vieja puede terminar
        // DESPUÉS y pisar en mergedByKey el snapshot más nuevo de la misma
        // semana ISO (viaje que ya adquirió factura). `records` es la verdad
        // para el rango fetcheado; fuera del rango manda lo hidratado.
        for (const r of records) {
          const k = rolKey(r);
          if (mergedByKey.get(k) !== r) {
            mergedByKey.set(k, r);
            dirty = true;
          }
        }
        flush(true);

        if (records.length > 0) {
          setRolLoadedKeys(prev => ({ ...prev, [cacheKey]: new Date().toISOString() }));
        }
        // eslint-disable-next-line no-console
        console.info(`[rol] sync · fetched=${records.length} viajes ${fechaInicial}..${fechaFinal} · llaves tocadas=${mergedByKey.size} · estado previo=${initialSize}`);
        return { totalRecords: records.length, totalCias: 1, failedCias: 0 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn('[rol] fetch falló:', msg);
        if (progressSlot === 'rol') setRolBootProgress({ done: 1, total: 1 });
        return { totalRecords: 0, totalCias: 1, failedCias: 1 };
      }
    },
    [rolLoadedKeys, rolRecords.length],
  );

  // Auto-fetch ROL al boot. No gatea en `companies` porque ROL no es por-cia
  // (mismo upstream para todas las cías Senda Citi); solo espera a que el
  // store hidrate.
  const rolAutoFetchDone = useRef(false);
  useEffect(() => {
    if (rolAutoFetchDone.current) return;
    if (!requestedDatasets.has('rol')) return;
    if (!storeHydrated) return;
    // Esperar la hidratación IDB: sin esto rolRecords está vacío y se fetchea
    // día por día desde enero aunque el heavy cache ya exista.
    if (!idbHydratedDatasets.has('rol')) return;
    rolAutoFetchDone.current = true;
    setBootSlot('rol', 'loading');
    setDatasetSlot('rol', 'loading');
    (async () => {
      try {
        const summary = await refreshRol(false, 'rol');
        const status = summary && summary.failedCias > 0 ? 'error' : 'done';
        setBootSlot('rol', status);
        setDatasetSlot('rol', status === 'error' ? 'error' : 'ready');
      } catch {
        setBootSlot('rol', 'error');
        setDatasetSlot('rol', 'error');
      }
    })();
  }, [requestedDatasets, storeHydrated, refreshRol, idbHydratedDatasets, setBootSlot, setDatasetSlot]);

  // ── Viajes Especiales: viajes ad-hoc con Factura_JDE/Fecha_Factura/Dias_Credito.
  // Auto-fetch año en curso. Corre EN PARALELO con ROL (mismo dataset slot),
  // no agrega boot status nuevo — falla silenciosa para no bloquear boot.
  // Misma lógica de delta-sync que ROL: fechaFactura/fSalidaPrimera más alto
  // como cursor; sin él, full backfill desde 1°-ene.
  const refreshViajesEspeciales = useCallback(
    async (force = true) => {
      const today = new Date();
      const year = today.getUTCFullYear();
      // Ventana por defecto uniforme (año en curso + 12 meses atrás); años
      // previos se cargan bajo demanda (DataWindowContext).
      const yearStart = defaultWindowFloor(today);
      const fechaFinal = today.toISOString().slice(0, 10);
      const cacheKey = `${year}:full`;
      const lastFetch = viajesEspecialesLoadedKeys[cacheKey];
      if (!force && viajesEspecialesRecords.length > 0 && lastFetch && isFreshTimestamp(lastFetch, COBRANZA_AUTO_REFRESH_TTL_MS)) {
        return { totalRecords: viajesEspecialesRecords.length };
      }
      let maxState: string | null = null;
      for (const v of viajesEspecialesRecords) {
        const d = v.fechaFactura || v.fSalidaPrimera;
        if (d && (!maxState || d > maxState)) maxState = d;
      }
      const fechaInicial = (!force && maxState && maxState >= yearStart)
        ? nextIsoDay(maxState)
        : yearStart;
      if (fechaInicial > fechaFinal) {
        // eslint-disable-next-line no-console
        console.info(`[viajes-esp] sync · heavy-store cubre hasta ${maxState}, skip`);
        setViajesEspecialesLoadedKeys(prev => ({ ...prev, [cacheKey]: new Date().toISOString() }));
        return { totalRecords: viajesEspecialesRecords.length };
      }
      try {
        // Sólo llaves tocadas por ESTE refresh (espejo de ROL, 2026-07-13):
        // sembrar del estado inicial re-aplicaba un snapshot stale sobre
        // llaves refrescadas por el backfill en vuelo; el overlay funcional
        // sobre `prev` ya conserva las llaves no tocadas.
        const mergedByKey = new Map<number, ViajeEspecialRecord>();
        const initialSize = viajesEspecialesRecords.length;
        // Flush con throttle temporal (espejo de ROL): en refresh force todo
        // record refetcheado es referencia nueva — sin throttle cada ventana
        // no vacía persistía el array completo (tormenta IDB + setState).
        let dirty = false;
        let lastFlushAt = 0;
        const flush = (force = false) => {
          if (!dirty) return;
          const now = Date.now();
          if (!force && now - lastFlushAt < 3000) return;
          dirty = false;
          lastFlushAt = now;
          // Commit funcional (espejo de ROL, 2026-07-11): overlay sobre
          // `prev` para no pisar el backfill de años previos en vuelo.
          setViajesEspecialesRecords(prev => {
            const byKey = new Map<number, ViajeEspecialRecord>();
            for (const v of prev) byKey.set(v.kRenta, v);
            for (const [k, v] of mergedByKey) byKey.set(k, v);
            const snapshot = Array.from(byKey.values());
            void saveHeavyRecords('viajesEspecialesRecords', snapshot);
            return snapshot;
          });
        };
        const records = await fetchViajesEspecialesRange(fechaInicial, fechaFinal, {
          onPartialBatch: (batch) => {
            for (const v of batch) {
              // Fresh-wins (espejo del merge de ROL): un viaje que adquiere
              // `facturaJDE` DEBE actualizar el record hidratado. Con
              // first-wins el viaje quedaba sin factura para siempre → el
              // cruce lo emitía como sintético cxc:especial:viaje: DUPLICANDO
              // el cxc: real de cobranza en Base.
              if (mergedByKey.get(v.kRenta) !== v) {
                mergedByKey.set(v.kRenta, v);
                dirty = true;
              }
            }
            flush();
          },
        });
        // Safety net SOLO-ADD: fetchViajesEspecialesRange dedup-ea FIRST-wins
        // (kRenta es id único; duplicado cross-ventana "no debería pasar"),
        // así que sobrescribir por referencia contra `records` REVERTIRÍA al
        // snapshot de la ventana más vieja. Sólo agrega llaves que
        // onPartialBatch no vio (defensa; no debería ocurrir).
        for (const v of records) {
          if (!mergedByKey.has(v.kRenta)) {
            mergedByKey.set(v.kRenta, v);
            dirty = true;
          }
        }
        flush(true);
        if (records.length > 0) {
          setViajesEspecialesLoadedKeys(prev => ({ ...prev, [cacheKey]: new Date().toISOString() }));
        }
        // eslint-disable-next-line no-console
        console.info(`[viajes-esp] sync · fetched=${records.length} ${fechaInicial}..${fechaFinal} · llaves tocadas=${mergedByKey.size} · estado previo=${initialSize}`);
        return { totalRecords: records.length };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn('[viajes-esp] fetch falló:', msg);
        return { totalRecords: 0 };
      }
    },
    [viajesEspecialesLoadedKeys, viajesEspecialesRecords],
  );

  const viajesEspecialesAutoFetchDone = useRef(false);
  useEffect(() => {
    if (viajesEspecialesAutoFetchDone.current) return;
    if (!requestedDatasets.has('rol')) return;
    if (!storeHydrated) return;
    if (!idbHydratedDatasets.has('rol')) return;
    viajesEspecialesAutoFetchDone.current = true;
    void refreshViajesEspeciales(false);
  }, [requestedDatasets, storeHydrated, idbHydratedDatasets, refreshViajesEspeciales]);

  // Auto-poblado: cuando Viajes Especiales API trae rows, promueve los
  // clientes correspondientes al grupo `group-viajes-especiales` automá-
  // ticamente. Respeta `manualGroupOverride === true`. Se dispara cuando
  // cambian (clients, viajesEspecialesRecords); el helper devuelve la
  // misma ref si no hay cambios para evitar loops de setState.
  const lastViajesPromotionRef = useRef<{ clientsRef: unknown; recordsRef: unknown } | null>(null);
  useEffect(() => {
    if (viajesEspecialesRecords.length === 0) return;
    if (clients.length === 0) return;
    const guard = lastViajesPromotionRef.current;
    if (guard && guard.clientsRef === clients && guard.recordsRef === viajesEspecialesRecords) return;
    const { clients: next, promotedCount, unmatchedClaveJdeCount } =
      applyViajesEspecialesGroup(clients, viajesEspecialesRecords);
    lastViajesPromotionRef.current = { clientsRef: next, recordsRef: viajesEspecialesRecords };
    if (next === clients) return;
    setClients(next);
    if (promotedCount > 0 || unmatchedClaveJdeCount > 0) {
      // eslint-disable-next-line no-console
      console.info(
        `[viajes-esp-catalog] promovidos=${promotedCount} clientes a Viajes Especiales · `
        + `K_Cliente sin match en catálogo=${unmatchedClaveJdeCount}`,
      );
    }
  }, [clients, viajesEspecialesRecords]);

  // Si JDE no devuelve compañías (companies en error), CXP/cobranza/compras/
  // pagos/nómina/auxiliar nunca se dispararon — marcamos los slots como error
  // para destrabar el boot. ROL no depende de companies (es global CITI).
  useEffect(() => {
    if (bootStatus.companies !== 'error') return;
    if (bootStatus.cxp === 'pending') setBootSlot('cxp', 'error');
    if (bootStatus.cobranza === 'pending') setBootSlot('cobranza', 'error');
    if (bootStatus.compras === 'pending') setBootSlot('compras', 'error');
    if (bootStatus.pagos === 'pending') setBootSlot('pagos', 'error');
    if (bootStatus.nomina === 'pending') setBootSlot('nomina', 'error');
    // El loader de auxiliar también exige companies.length > 0; sin esta
    // propagación su slot (ahora en GATING_BOOT_IDS) giraba en 'pending'
    // para siempre y su fila no aparecía en el panel de boot bloqueado.
    if (bootStatus.auxiliar === 'pending') setBootSlot('auxiliar', 'error');
  }, [bootStatus.companies, bootStatus.cxp, bootStatus.cobranza, bootStatus.compras, bootStatus.pagos, bootStatus.nomina, bootStatus.auxiliar, setBootSlot]);

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
  const nominaPartialNoticeLogged = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (nominaBootDone.current) return;
    if (!requestedDatasets.has('nomina')) return;
    if (!storeHydrated) return;
    if (!nominaHeavyHydrated) return;
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
    setDatasetSlot('nomina', 'loading');
    (async () => {
      // true una vez que el fast path reportó 'done' — a partir de ahí el
      // resto del try es backfill de FONDO y no debe re-abrir el gate.
      let bootReleased = false;
      try {
        // Re-refine pass sobre records persistidos. La tabla de clasificación
        // de `cashTreatment` evolucionó; refinar ahora actualiza sin refetch.
        let workingRecords = refineBatch(nominaRecords);
        let workingLoadedKeys = deriveNominaLoadedKeysFromRecords(workingRecords, nominaLoadedKeys);
        if (workingRecords.length > 0) setNominaRecords(workingRecords);
        if (workingLoadedKeys !== nominaLoadedKeys) setNominaLoadedKeys(workingLoadedKeys);

        // Purga registros parciales persistidos (firma: records>0 sin
        // Deducciones ni Aportaciones — truncamiento upstream AWS API Gateway).
        // DIAG: qué hidrató IDB al arrancar el boot effect (antes de fetch).
        {
          const byM = new Map<string, { recs: number; cashOut: number; apor: number }>();
          for (const r of workingRecords) {
            if (!r.year || !r.month) continue;
            const k = `${r.year}-${String(r.month).padStart(2, '0')}`;
            const e = byM.get(k) ?? { recs: 0, cashOut: 0, apor: 0 };
            e.recs += 1;
            if (r.cashTreatment === 'CASH_OUT') e.cashOut += r.amount;
            if (r.cashTreatment === 'EMPLOYER_TAX') e.apor += r.amount;
            byM.set(k, e);
          }
          // eslint-disable-next-line no-console
          console.info(
            `[nomina-diag] boot-effect IDB snapshot · total=${workingRecords.length} · ${
              Array.from(byM.entries())
                .sort()
                .map(([k, v]) => `${k}:recs=${v.recs},cashOut=${Math.round(v.cashOut)},apor=${Math.round(v.apor)}`)
                .join(' · ') || '(vacío)'
            }`,
          );
        }
        const suspectMonths = findSuspectMonths(workingRecords);
        const logPartialNominaMonths = (
          months: Array<{ year: number; month: number }>,
          source: 'cache' | 'fetch',
        ) => {
          const unseen = months
            .map(m => `${m.year}-${String(m.month).padStart(2, '0')}`)
            .filter(key => !nominaPartialNoticeLogged.current.has(`${source}:${key}`));
          if (unseen.length === 0) return;
          for (const key of unseen) nominaPartialNoticeLogged.current.add(`${source}:${key}`);
          // eslint-disable-next-line no-console
          console.info(
            `[nomina] ${source === 'cache' ? 'limpiando cache parcial' : 'ignorando respuesta parcial'}: ${unseen.join(', ')}`,
          );
        };
        if (suspectMonths.length > 0) {
          logPartialNominaMonths(suspectMonths, 'cache');
          const suspectFps = new Set(suspectMonths.map(m => `${m.year}|${m.month}`));
          workingRecords = workingRecords.filter(r => !suspectFps.has(`${r.year}|${r.month}`));
          const nextLoadedKeys = { ...workingLoadedKeys };
          for (const { year, month } of suspectMonths) {
            const key = nominaCacheKey({ idEmpresa: 99, tipoNomina: 99, anio: year, mes: month });
            delete nextLoadedKeys[key];
          }
          workingLoadedKeys = nextLoadedKeys;
          setNominaRecords(workingRecords);
          setNominaLoadedKeys(workingLoadedKeys);
        }
        // Llaves de meses con firma parcial — el purge de arriba borra su key
        // vía setState (async, no visible en este closure). Las recolectamos
        // localmente para forzar su refetch aunque `nominaLoadedKeys` (closure
        // pre-purge) todavía las muestre como cargadas.
        const suspectKeys = new Set(
          suspectMonths.map(m =>
            nominaCacheKey({ idEmpresa: 99, tipoNomina: 99, anio: m.year, mes: m.month }),
          ),
        );

        // Meses realmente presentes en `nominaRecords` (snapshot del closure).
        // `nominaLoadedKeys` (localStorage, light) y `nominaRecords` (IDB,
        // heavy) se DESYNCEAN: el flush de unload escribe localStorage síncrono
        // pero IDB async (se pierde si la pestaña muere antes del commit). Tras
        // ese desync las llaves dicen "cargado" pero los records están vacíos.
        // Guardar solo por llave hacía que el boot SKIPPEARA el fetch y no
        // cargara nada. Skip solo si la llave está Y el mes está de verdad en
        // records Y no es sospechoso. Si records no está (desync / aún no
        // hidratado), refetch — correcto sobre la optimización de skip.
        const buildPresentMonths = (): Set<string> => {
          const presentMonths = new Set<string>();
          for (const r of workingRecords) {
            if (r.year && r.month) presentMonths.add(`${r.year}|${r.month}`);
          }
          return presentMonths;
        };
        const shouldSkip = (p: { anio: number; mes: number; cacheKey: string }): boolean => {
          if (suspectKeys.has(p.cacheKey)) return false;
          if (!workingLoadedKeys[p.cacheKey]) return false;
          return buildPresentMonths().has(`${p.anio}|${p.mes}`);
        };

        // Construye plan: últimos 4 meses (fast path, igual que el botón
        // manual) + meses históricos hasta 24 atrás (background).
        const plan = (count: number): Array<{ anio: number; mes: number; cacheKey: string }> => {
          const out: Array<{ anio: number; mes: number; cacheKey: string }> = [];
          for (let i = 0; i < count; i++) {
            const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
            const anio = d.getFullYear();
            const mes = d.getMonth() + 1;
            out.push({ anio, mes, cacheKey: nominaCacheKey({ idEmpresa: 99, tipoNomina: 99, anio, mes }) });
          }
          return out;
        };

        // `commit=false` fetchea+mergea SIN tocar React state (devuelve los
        // records). El backfill histórico (10+ chunks) lo usa para acumular y
        // hacer UN solo setNominaRecords al final: cada setNominaRecords muta
        // `cacheProbeInput` → re-dispara el build del source. 10 chunks = 10
        // rebuilds + 10 re-merges de arrays crecientes durante el boot = el
        // pico de RAM que crasheaba máquinas con poca memoria (jobId 3→6→18).
        const fetchAndMerge = async (
          targets: Array<{ anio: number; mes: number; cacheKey: string }>,
          commit = true,
        ): Promise<{ keys: Record<string, string>; merged: PayrollCostRecord[] }> => {
          const results = await Promise.allSettled(
            targets.map(({ anio, mes }) =>
              fetchNomina({ idEmpresa: 99, tipoNomina: 99, anio, mes }),
            ),
          );
          const ts = new Date().toISOString();
          let mergedBatch: PayrollCostRecord[] = [];
          const keys: Record<string, string> = {};
          results.forEach((res, idx) => {
            const { cacheKey, anio, mes } = targets[idx];
            if (res.status === 'fulfilled') {
              const recs = refineBatch(res.value);
              const fetchedSuspects = findSuspectMonths(recs)
                .filter(m => m.year === anio && m.month === mes);
              let cashOut = 0;
              let apor = 0;
              for (const r of recs) {
                if (r.cashTreatment === 'CASH_OUT') cashOut += r.amount;
                if (r.cashTreatment === 'EMPLOYER_TAX') apor += r.amount;
              }
              if (fetchedSuspects.length > 0) {
                logPartialNominaMonths(fetchedSuspects, 'fetch');
              }
              // eslint-disable-next-line no-console
              console.info(
                `[nomina-diag] fetch ${anio}-${String(mes).padStart(2, '0')} OK · recs=${recs.length} · cashOut=${Math.round(cashOut)} · apor=${Math.round(apor)}${apor === 0 && recs.length > 0 ? ' ⚠️TRUNCADO(apor=0)' : ''}`,
              );
              // Mergeamos best-effort para que algo se pinte, PERO solo marcamos
              // la llave como cargada si la respuesta NO es parcial. Si llegó
              // truncada (incl. apor=0, Firma 3), la dejamos sin llave para que
              // un boot posterior la reintente y `shouldSkip` no la trustee. Sin
              // esto, una respuesta truncada del boot se persistía como
              // "cargada" y el usuario tenía que "Refrescar TRESS" a mano.
              mergedBatch = mergeNominaBatch(mergedBatch, recs);
              if (fetchedSuspects.length === 0) {
                keys[cacheKey] = ts;
              }
            } else {
              console.error(`[nomina] auto-fetch ${anio}-${String(mes).padStart(2, '0')} falló`, res.reason);
            }
          });
          if (commit && mergedBatch.length > 0) {
            workingRecords = mergeNominaBatch(workingRecords, mergedBatch);
            // Commit FUNCIONAL (2026-07-15): mergear el batch sobre `prev` en
            // vez de commitear el snapshot `workingRecords` — un writer
            // concurrente (onNominaFetched del tab de Nómina, backfillNomina)
            // que haya commiteado durante el await del fetch aportó records
            // que el snapshot no conoce y el commit los pisaba (estado + IDB
            // vía el saver reactivo). `workingRecords` sigue como bookkeeping
            // local para shouldSkip/presentMonths.
            const batch = mergedBatch;
            setNominaRecords(prev => {
              const merged = mergeNominaBatch(prev, batch);
              void saveHeavyRecords('nominaRecords', merged);
              return merged;
            });
          }
          return { keys, merged: mergedBatch };
        };

        // FAST PATH: TODO el año-a-la-fecha (enero→mes actual), mínimo 4 meses
        // para continuidad sobre el cambio de año / piso 3m. Refetch SIEMPRE,
        // SIN `shouldSkip` — igual que el botón "Refrescar TRESS".
        //
        // Causa raíz (corregida en bloque, dejó de ser parche-por-parche): el
        // boot sólo refetcheaba 4 meses; meses YTD anteriores (típico: enero)
        // caían al backfill histórico guardado por `shouldSkip`, que los
        // saltaba si su copia poisoned/parcial de IDB tenía llave + estaba
        // "presente" y `findSuspectMonths` (heurística estrecha) no la
        // detectaba. Esos meses se re-persistían poisoned cada boot → la
        // pantalla mostraba YTD incorrecto hasta un refresh manual. La regla
        // ahora es estructural, no heurística: NO confiamos en IDB para la
        // ventana que el usuario debe ver correcta (YTD). `mergeNominaBatch`
        // reemplaza por (year|month|cia|payrollType) → el fetch correcto
        // sobrescribe cualquier poison YTD. Meses cerrados anteriores a
        // enero-de-este-año conservan el guard de cache (no refetch de 24
        // meses cada boot — perf, ver CLAUDE.md).
        const monthsYtd = today.getMonth() + 1;
        const recent = plan(Math.max(4, monthsYtd));
        const recentPresentMonths = buildPresentMonths();
        for (const p of recent) {
          // eslint-disable-next-line no-console
          console.info(
            `[nomina-diag] recent ${p.anio}-${String(p.mes).padStart(2, '0')} · loadedKey=${!!workingLoadedKeys[p.cacheKey]} · presentInRecords=${recentPresentMonths.has(`${p.anio}|${p.mes}`)} · suspect=${suspectKeys.has(p.cacheKey)} · wouldSkip=${shouldSkip(p)}`,
          );
        }
        const recentToFetch = recent;
        if (recentToFetch.length > 0) {
          // Fast path: commit inmediato (UX — los 4 meses recientes pintan ya).
          // IDB se escribe dentro del updater funcional de fetchAndMerge (el
          // antiguo `await persistNomina()` snapshot ya no hace falta y podía
          // pisar en IDB lo que un writer concurrente hubiera persistido).
          const { keys: recentKeys } = await fetchAndMerge(recentToFetch);
          if (Object.keys(recentKeys).length > 0) {
            workingLoadedKeys = { ...workingLoadedKeys, ...recentKeys };
            setNominaLoadedKeys(workingLoadedKeys);
          }
        }
        setBootSlot('nomina', 'done');
        setDatasetSlot('nomina', 'ready');
        bootReleased = true;

        // BACKGROUND: meses previos hasta el piso de la ventana por defecto
        // (`defaultWindowMonths`: año en curso + 12 meses atrás = 13 meses).
        // Antes bajaba 24 meses para el predictor estacional; ahora es uniforme
        // con el resto de datasets y la historia previa se carga bajo demanda
        // (el predictor estacional degrada a lineal hasta entonces). Solo los
        // que no estén cacheados ni fueron parte del fast path.
        const recentKeysSet = new Set(recent.map(r => r.cacheKey));
        const historical = plan(defaultWindowMonths(today)).filter(p => {
          if (recentKeysSet.has(p.cacheKey)) return false;
          return !shouldSkip(p);
        });
        if (historical.length === 0) return;
        const CONCURRENCY = 2;
        // Acumular SIN setState por chunk (commit=false). Antes cada chunk
        // hacía setNominaRecords → 10+ rebuilds del source + 10 re-merges de
        // arrays crecientes durante el boot = pico de RAM que crasheaba
        // máquinas con poca memoria. Las llaves (light, localStorage, NO en
        // cacheProbeInput) sí se setean por chunk para no perder progreso si
        // la pestaña muere; sólo el heavy nominaRecords se coalesce a 1 commit.
        let histAccum: PayrollCostRecord[] = [];
        for (let i = 0; i < historical.length; i += CONCURRENCY) {
          const chunk = historical.slice(i, i + CONCURRENCY);
          const { keys, merged } = await fetchAndMerge(chunk, false);
          if (merged.length > 0) {
            histAccum = mergeNominaBatch(histAccum, merged);
            // Persist a IDB per-chunk SIN setState. Antes IDB se escribía solo
            // al final del backfill (await persistNomina abajo) mientras
            // nominaLoadedKeys (localStorage) sí avanzaba per-chunk. Si el
            // usuario recargaba mid-backfill (común, el loop tarda ~5-10 min),
            // localStorage decía "2024-12 cargado" pero IDB no tenía esos
            // records → shouldSkip ve key+no record → refetch en cada boot
            // → loop infinito. Con esta save sincrónica, IDB y localStorage
            // quedan en sync después de cada chunk. setState sigue coalescido
            // al final (preserva la optimización de RAM, ver comment arriba).
            // Limitación aceptada: este save es un snapshot (no ve commits
            // concurrentes de onNominaFetched/backfillNomina); una pisada
            // transitoria en IDB se repara con el commit funcional final del
            // loop y, si la pestaña muere antes, shouldSkip refetchea el mes.
            await saveHeavyRecords(
              'nominaRecords',
              mergeNominaBatch(workingRecords, histAccum),
            );
          }
          if (Object.keys(keys).length > 0) {
            workingLoadedKeys = { ...workingLoadedKeys, ...keys };
            setNominaLoadedKeys(workingLoadedKeys);
          }
        }
        if (histAccum.length > 0) {
          // Commit + persist FUNCIONAL final: mergear histAccum sobre `prev`
          // (no el snapshot `workingRecords`) conserva lo que onNominaFetched /
          // backfillNomina hayan commiteado durante los ~5-10 min del loop, y
          // re-persiste el merge real (repara cualquier pisada transitoria de
          // los saves per-chunk snapshot de arriba).
          const batch = histAccum;
          setNominaRecords(prev => {
            const merged = mergeNominaBatch(prev, batch);
            void saveHeavyRecords('nominaRecords', merged);
            return merged;
          });
        }
      } catch (err) {
        // No degradar un boot ya liberado: el slot reportó 'done' con el fast
        // path y el splash (que ahora bloquea en 'error') pudo estar aún
        // arriba esperando rol/auxiliar — un fallo del backfill histórico de
        // fondo (p.ej. write de IDB) reescribía 'done'→'error' y bloqueaba la
        // app con los datos del boot ya cargados.
        if (bootReleased) {
          // eslint-disable-next-line no-console
          console.warn('[nomina] backfill histórico de fondo falló (boot ya liberado; queda visible en Salud de datos)', err);
          return;
        }
        setBootSlot('nomina', 'error');
        setDatasetSlot('nomina', 'error');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedDatasets, storeHydrated, nominaHeavyHydrated, companies.length, setDatasetSlot]);

  // ── Backfill de historia bajo demanda (DataWindowContext) ──────────────
  // Fetch de un rango [from, to] ESTRICTAMENTE anterior a la ventana ya
  // cargada, con la misma lógica de merge (upsert/append, nunca encoge) de los
  // boot effects. Persiste a IDB para sobrevivir reload en configs con cache
  // persistente. Disparado por `ensureYearLoaded` cuando una vista consulta un
  // año previo al piso por defecto. El rango es DISJUNTO (más viejo) de lo ya
  // cargado, así que Cobranza hace APPEND sin re-key por folio (no colapsa
  // facturas multi-línea); el resto hace upsert por su llave única.
  const backfilledFloorRef = useRef<Record<string, string>>({});
  const backfillInFlightRef = useRef<Set<string>>(new Set());
  // Piso cuyo backfill FALLÓ (fetch rechazado / cía incompleta). Bloquea el
  // auto-reintento inmediato del tick (con JDE caído sería un hot-loop);
  // `ensureYearLoaded` lo limpia cuando la vista vuelve a pedir el año
  // (re-navegación / remonta) → reintento deliberado, acotado por acción
  // del usuario.
  const backfillFailedFloorRef = useRef<Record<string, string>>({});

  // Cada backfiller regresa `true` si TODOS sus fetches respondieron; `false`
  // si alguno falló (el controlador hace rollback del claim para permitir
  // reintento — antes los fallos se tragaban en allSettled/catch internos y
  // el rango fallido quedaba "cubierto" para siempre: el año navegado se
  // pintaba como $0 legítimo sin reintento posible).
  const backfillCobranza = useCallback(async (from: string, to: string): Promise<boolean> => {
    const activeCias = filterActiveCompanies(companies).map(c => c.cia);
    if (activeCias.length === 0) return true;
    const olderRecords: CobranzaRecord[] = [];
    const olderPayments: CobranzaPayment[] = [];
    const fetchedCias = new Set<string>();
    let anyFailed = false;
    let cursor = 0;
    const concurrency = Math.min(10, activeCias.length);
    const worker = async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= activeCias.length) return;
        const cia = activeCias[idx];
        const [recordsResult, paymentsResult] = await Promise.allSettled([
          fetchCobranzaRange(cia, from, to, { concurrency: 10 }),
          fetchIndicadoresCobranzaRange(cia, from, to, { concurrency: 10 }),
        ]);
        if (recordsResult.status === 'fulfilled') {
          fetchedCias.add(cia);
          for (const r of recordsResult.value) olderRecords.push({ ...r, cia: r.cia || cia });
        } else {
          anyFailed = true;
        }
        if (paymentsResult.status === 'fulfilled') {
          for (const p of paymentsResult.value) olderPayments.push(p);
        } else {
          anyFailed = true;
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (fetchedCias.size > 0) {
      setCobranzaRecords(prev => {
        // Merge acotado al rango (no append ciego): dedup de facturas que el
        // upstream cuele fuera de [from, to] + REPLACE por cía fetcheada para
        // que un reintento tras fallo parcial no duplique. Ver el helper.
        const merged = mergeCobranzaBackfillRange(prev, olderRecords, fetchedCias, from, to);
        void saveHeavyRecords('cobranzaRecords', merged);
        return merged;
      });
    }
    if (olderPayments.length > 0) {
      setCobranzaPayments(prev => {
        // Llave cia::idPago — idPago NO es único global (misma razón que el
        // merge del loader de cobranza).
        const map = new Map<string, CobranzaPayment>();
        for (const p of prev) map.set(`${p.cia}::${p.idPago}`, p);
        for (const p of olderPayments) map.set(`${p.cia}::${p.idPago}`, p);
        const merged = Array.from(map.values());
        void saveHeavyRecords('cobranzaPayments', merged);
        return merged;
      });
    }
    return !anyFailed;
  }, [companies]);

  const backfillRol = useCallback(async (from: string, to: string): Promise<boolean> => {
    const rolKey = (r: RolRecord) =>
      `${r.cia}::${r.kCliente}::${r.anio}::${r.semana}::${r.ruta}::${r.tipoViaje}`;
    const [rolResult, viajesResult] = await Promise.allSettled([
      fetchRolRange(from, to, {}),
      fetchViajesEspecialesRange(from, to, {}),
    ]);
    if (rolResult.status === 'fulfilled' && rolResult.value.length > 0) {
      setRolRecords(prev => {
        const map = new Map<string, RolRecord>();
        for (const r of prev) map.set(rolKey(r), r);
        for (const r of rolResult.value) map.set(rolKey(r), r);
        const merged = Array.from(map.values());
        void saveHeavyRecords('rolRecords', merged);
        return merged;
      });
    }
    if (viajesResult.status === 'fulfilled' && viajesResult.value.length > 0) {
      setViajesEspecialesRecords(prev => {
        const map = new Map<number, ViajeEspecialRecord>();
        for (const v of prev) map.set(v.kRenta, v);
        for (const v of viajesResult.value) map.set(v.kRenta, v);
        const merged = Array.from(map.values());
        void saveHeavyRecords('viajesEspecialesRecords', merged);
        return merged;
      });
    }
    // Merge por llave (upsert) → un reintento del rango es idempotente.
    return rolResult.status === 'fulfilled' && viajesResult.status === 'fulfilled';
  }, []);

  const backfillCompras = useCallback(async (from: string, to: string): Promise<boolean> => {
    const activeCias = filterActiveCompanies(companies).map(c => c.cia);
    if (activeCias.length === 0) return true;
    await primeDailyCache();
    const fetchedAll: ComprasRecord[] = [];
    let anyFailed = false;
    let cursor = 0;
    const concurrency = Math.min(10, activeCias.length);
    const worker = async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= activeCias.length) return;
        const cia = activeCias[idx];
        try {
          const fetched = await fetchComprasRange(cia, from, to, { concurrency: 4 });
          for (const r of fetched) fetchedAll.push(r);
        } catch { anyFailed = true; /* best-effort; el resto de cías sigue */ }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (fetchedAll.length > 0) {
      setComprasRecords(prev => {
        const map = new Map<string, ComprasRecord>();
        for (const r of prev) map.set(`${r.cia}::${r.noOrden}::${r.lineaOrden}`, r);
        for (const r of fetchedAll) map.set(`${r.cia}::${r.noOrden}::${r.lineaOrden}`, r);
        const merged = Array.from(map.values());
        void saveHeavyRecords('comprasRecords', merged);
        return merged;
      });
    }
    return !anyFailed;
  }, [companies]);

  const backfillPagos = useCallback(async (from: string, to: string): Promise<boolean> => {
    await primeDailyCache();
    const fetched = await fetchPagoProveedorRange(from, to, { concurrency: 10 });
    if (fetched.length > 0) {
      setPagoProveedorRecords(prev => {
        const map = new Map<string, PagoProveedorRecord>();
        for (const r of prev) map.set(`${r.cia}::${r.noPago}`, r);
        for (const r of fetched) map.set(`${r.cia}::${r.noPago}`, r);
        const merged = Array.from(map.values());
        void saveHeavyRecords('pagoProveedorRecords', merged);
        return merged;
      });
    }
    // fetchPagoProveedorRange traga fallos por día internamente (quedan en
    // Salud de datos vía reportDataGap); aquí no hay señal barata de fallo.
    return true;
  }, []);

  const backfillAuxiliar = useCallback(async (from: string, to: string): Promise<boolean> => {
    const activeCias = companies
      .filter(c => c.activa !== false && isAuxiliarAllowlistedCia(c.cia))
      .map(c => c.cia);
    if (activeCias.length === 0) return true;
    await primeDailyCache();
    const keyOf = (r: AuxiliarContableRecord) =>
      `${r.cia}::${r.idCuenta}::${r.noDocto}::${r.tipoDocto}`;
    const fetchedAll: AuxiliarContableRecord[] = [];
    let anyFailed = false;
    let cursor = 0;
    const concurrency = Math.min(10, activeCias.length);
    const worker = async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= activeCias.length) return;
        const cia = activeCias[idx];
        try {
          const fetched = await fetchAuxiliarContableRange(cia, from, to, AUX_RECON_PARAMS, { concurrency: 4 });
          for (const r of fetched) fetchedAll.push(r);
        } catch { anyFailed = true; /* best-effort */ }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (fetchedAll.length > 0) {
      setAuxiliarContableRecords(prev => {
        const map = new Map<string, AuxiliarContableRecord>();
        for (const r of prev) map.set(keyOf(r), r);
        for (const r of fetchedAll) map.set(keyOf(r), r);
        const merged = Array.from(map.values());
        void saveHeavyRecords('auxiliarContableRecords', merged);
        return merged;
      });
    }
    return !anyFailed;
  }, [companies]);

  const backfillBanks = useCallback(async (from: string, to: string): Promise<boolean> => {
    await primeDailyCache();
    const defaultFormat: BankStatementFormat = 'SWIFT';
    const fetched = await fetchBankStatementsRange(from, to, defaultFormat, { concurrency: 10 });
    if (fetched.length > 0) {
      // El effect de persistencia (debounced) escribe bankJdeStatements a IDB.
      setBankJdeStatements(prev => mergeBankStatements(prev, fetched));
    }
    // fetchBankStatementsRange traga fallos por día internamente (quedan en
    // Salud de datos vía reportDataGap); aquí no hay señal barata de fallo.
    return true;
  }, []);

  const backfillNomina = useCallback(async (from: string, to: string): Promise<boolean> => {
    const months: Array<{ anio: number; mes: number }> = [];
    let y = Number(from.slice(0, 4));
    let m = Number(from.slice(5, 7));
    const endY = Number(to.slice(0, 4));
    const endM = Number(to.slice(5, 7));
    while (y < endY || (y === endY && m <= endM)) {
      months.push({ anio: y, mes: m });
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
    if (months.length === 0) return true;
    const results = await Promise.allSettled(
      months.map(({ anio, mes }) => fetchNomina({ idEmpresa: 99, tipoNomina: 99, anio, mes })),
    );
    let batch: PayrollCostRecord[] = [];
    const keys: Record<string, string> = {};
    const ts = new Date().toISOString();
    results.forEach((res, idx) => {
      if (res.status !== 'fulfilled') return;
      const recs = refineBatch(res.value);
      batch = mergeNominaBatch(batch, recs);
      const { anio, mes } = months[idx];
      keys[nominaCacheKey({ idEmpresa: 99, tipoNomina: 99, anio, mes })] = ts;
    });
    if (batch.length > 0) {
      setNominaRecords(prev => {
        const merged = mergeNominaBatch(prev, batch);
        void saveHeavyRecords('nominaRecords', merged);
        return merged;
      });
    }
    if (Object.keys(keys).length > 0) {
      setNominaLoadedKeys(prev => ({ ...prev, ...keys }));
    }
    // mergeNominaBatch reemplaza por llave → reintento idempotente.
    return !results.some(r => r.status === 'rejected');
  }, []);

  const runBackfill = useCallback(async (ds: string, from: string, to: string): Promise<boolean> => {
    switch (ds) {
      case 'cobranza': return backfillCobranza(from, to);
      case 'rol': return backfillRol(from, to);
      case 'compras': return backfillCompras(from, to);
      case 'pagos': return backfillPagos(from, to);
      case 'auxiliar': return backfillAuxiliar(from, to);
      case 'banks': return backfillBanks(from, to);
      case 'nomina': return backfillNomina(from, to);
      default: return true;
    }
  }, [backfillCobranza, backfillRol, backfillCompras, backfillPagos, backfillAuxiliar, backfillBanks, backfillNomina]);

  // Controlador de backfill: por cada dataset cuyo piso solicitado bajó por
  // debajo de lo ya cargado, fetchea el hueco [solicitado, ya-cargado) una vez.
  // El piso "ya cargado" arranca en la fecha MÍNIMA real de los records (para
  // no re-fetchear historia ya persistida), acotado al piso por defecto.
  useEffect(() => {
    const allowed = allowedDatasetsRef.current;
    const minLoadedDate = (ds: string): string => {
      const dates: (string | undefined)[] = [];
      if (ds === 'cobranza') for (const r of cobranzaRecords) dates.push(r.fechaFactura);
      else if (ds === 'rol') for (const r of rolRecords) dates.push(r.fechaViaje);
      else if (ds === 'compras') for (const r of comprasRecords) dates.push(r.fechaPedido || r.fechaRecepcion);
      else if (ds === 'pagos') for (const r of pagoProveedorRecords) dates.push(r.fechaPago);
      else if (ds === 'auxiliar') for (const r of auxiliarContableRecords) dates.push(r.fechaContable);
      else if (ds === 'banks') for (const acc of bankJdeStatements) for (const mv of acc.movimientos) dates.push(mv.fechaOperacion);
      else if (ds === 'nomina') for (const r of nominaRecords) {
        if (r.year && r.month) dates.push(`${r.year}-${String(r.month).padStart(2, '0')}-01`);
      }
      let min: string | null = null;
      for (const d of dates) {
        if (d && (min === null || d < min)) min = d;
      }
      return min !== null && min < dataWindowDefaultFloor ? min : dataWindowDefaultFloor;
    };
    for (const ds of Object.keys(historicalFloorByDataset)) {
      if (!allowed.has(ds as DatasetKey)) continue;
      if (backfillInFlightRef.current.has(ds)) continue;
      if (backfilledFloorRef.current[ds] === undefined) {
        backfilledFloorRef.current[ds] = minLoadedDate(ds);
      }
      const coveredFloor = backfilledFloorRef.current[ds];
      const requestedFloor = historicalFloorByDataset[ds];
      if (requestedFloor >= coveredFloor) continue; // ya cubierto
      if (backfillFailedFloorRef.current[ds] === requestedFloor) continue; // falló; reintento vía ensureYearLoaded
      const from = requestedFloor;
      const to = previousIsoDay(coveredFloor);
      backfilledFloorRef.current[ds] = requestedFloor; // reclama el rango (evita reentrada)
      backfillInFlightRef.current.add(ds);
      setHistoricalLoadingByDataset(prev => ({ ...prev, [ds]: true }));
      void (async () => {
        try {
          const ok = await runBackfill(ds, from, to);
          if (!ok) {
            // Fallo parcial/total reportado por el backfiller (los fetchers
            // internos no lanzan — allSettled / catch por cía). Sin este
            // rollback el rango quedaba reclamado como cubierto para siempre
            // y el año se pintaba vacío el resto de la sesión.
            // eslint-disable-next-line no-console
            console.warn(`[backfill] ${ds} ${from}..${to} incompleto — rollback para permitir reintento`);
            // El rollback habilita el reintento, pero para el usuario el año
            // navegado quedó pintado como $0 legítimo y la pill "Cargando…" ya
            // desapareció. Registrarlo lo hace visible en "Salud de datos"
            // (aditivo: no cambia el rollback ni el gate de reintento).
            reportDataGap(BACKFILL_GAP_DATASET[ds] ?? ds, 'window-failed', `backfill ${from}..${to}`);
            backfilledFloorRef.current[ds] = coveredFloor;
            backfillFailedFloorRef.current[ds] = requestedFloor;
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[backfill] ${ds} ${from}..${to} falló`, err);
          reportDataGap(BACKFILL_GAP_DATASET[ds] ?? ds, 'window-failed', `backfill ${from}..${to}`);
          backfilledFloorRef.current[ds] = coveredFloor; // rollback → un re-intento puede volver
          backfillFailedFloorRef.current[ds] = requestedFloor;
        } finally {
          backfillInFlightRef.current.delete(ds);
          setHistoricalLoadingByDataset(prev => ({ ...prev, [ds]: false }));
          // Re-evalúa por si el usuario pidió un año AÚN más viejo durante el fetch.
          setBackfillTick(t => t + 1);
        }
      })();
    }
    // Referenciamos los arrays de records sólo para el piso inicial (una vez por
    // dataset); no los listamos como deps para no re-correr en cada commit del
    // boot — el efecto sólo actúa cuando el usuario navega a un año previo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historicalFloorByDataset, backfillTick, runBackfill, dataWindowDefaultFloor]);


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
    // Espera la hidratación: este efecto corre en el primer commit con
    // `bankLastQuery === null` y borraba `midas.bankLastQuery.v2` ANTES de
    // que loadBankCaches (idle, async) lo leyera — el query persistido se
    // perdía en cada boot y el path Santander/synth corría siempre.
    if (!bankCacheLoaded) return;
    try {
      if (bankLastQuery) localStorage.setItem('midas.bankLastQuery.v2', JSON.stringify(bankLastQuery));
      else localStorage.removeItem('midas.bankLastQuery.v2');
    } catch { /* ignore */ }
  }, [bankCacheLoaded, bankLastQuery]);

  // ── JDE: fetch bank statements ──
  // Boot sólo hace prime corto. El backfill año-a-la-fecha queda para refresh
  // manual; hacerlo automáticamente congelaba la app por red + renders +
  // persistencia de un dataset grande.
  const refreshBankStatementsRange = useCallback(async (
    force: boolean = false,
    includeRange: boolean = false,
  ) => {
    const today = todayISO();
    // Ventana por defecto uniforme (año en curso + 12 meses atrás). Antes
    // bajaba 2 años para alimentar Holt-Winters seasonal (≥24m); ahora el piso
    // es compartido y los estados de cuenta previos se cargan bajo demanda
    // (DataWindowContext / ensureBankCoverageForCollections). El predictor
    // estacional degrada a lineal hasta que se cargue más historia.
    const yearStart = defaultWindowFloor();
    const defaultFormat: BankStatementFormat = 'SWIFT';

    // Cache hit: skip unless forced. SOLO aplica al prime-only path
    // (includeRange=false, la revalidación de fondo). Si includeRange=true
    // (backfill estacional 2-años, o refresh manual con rango) NUNCA hacemos
    // este corto: `distinctDates.size >= 30` se cumple con un solo prime
    // reciente (un estado de cuenta de "hoy" ya trae >30 fechaOperacion
    // distintas del último mes), así que el heurístico confundía "tengo el
    // prime" con "tengo el histórico completo" y se saltaba TODO el backfill
    // año-a-la-fecha aunque el rango estuviera barato en el daily-cache IDB.
    // Resultado: histórico guardado en IDB pero nunca cargado a estado →
    // Flujo Neto sólo la semana en curso, Planeación sin ingresos pasados.
    // El Step 2 es idempotente (merge dedup) y barato si el cache persiste.
    if (!force && !includeRange) {
      const distinctDates = new Set<string>();
      for (const acc of bankJdeStatements) {
        for (const mov of acc.movimientos) distinctDates.add(mov.fechaOperacion);
      }
      const cacheIsFresh =
        bankLastQuery?.formatoElectronico !== SANTANDER_FILE_FORMAT &&
        bankLastQuery?.fechaEstadoCuenta === today &&
        distinctDates.size >= 30;
      if (cacheIsFresh) {
        return { primed: true, ranged: false };
      }
    }

    // Prime: hoy + últimos 14 días. JDE atrasa la carga de bancos en
    // domingos / festivos / puentes; 5 días back no alcanza cuando cae un
    // lunes festivo + fin de semana. 14 paralelas siguen dentro del mismo
    // orden de magnitud que el backfill anual (concurrency 10).
    const tryDates = [today];
    const d = new Date();
    for (let i = 0; i < 14; i++) {
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
          // Prime gatea el splash → fast-fail. 30s timeout + 1 retry en vez
          // del default 120s × 3: 6 fechas colgadas no deben costar minutos.
          fetchBankStatements(
            {
              fechaEstadoCuenta: fecha,
              formatoElectronico: defaultFormat,
            },
            { timeoutMs: 30_000, retries: 1 },
          ).then(res => ({ fecha, res })),
        ),
      );
      for (let i = 0; i < settled.length; i++) {
        const entry = settled[i];
        if (entry.status === 'fulfilled' && entry.value.res.length > 0) {
          // Merge, nunca replace: con force=true este paso corre aunque el
          // histórico (incl. años backfilleados) ya esté hidratado — un
          // replace lo pisaba con UN día y el Step 2 sólo re-mergea desde el
          // piso default, perdiendo lo anterior (mismo clobber corregido en
          // cobranza/rol/viajes).
          setBankJdeStatements(prev => mergeBankStatements(prev, entry.value.res));
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
      // Si el cache IDB NO persiste (lock de otra pestaña / IDB no disponible)
      // cada día pasado sería un miss → 731 llamadas vivas a JDE por boot,
      // serializadas en el semáforo global de 3. Recortamos a 120 días: útil
      // para la vista reciente; el predictor seasonal degrada a naive-mean
      // hasta que el cache vuelva a persistir — aceptable vs storm de >18min.
      let rangeStart = yearStart;
      if (!isDailyCachePersistent()) {
        const clamp = new Date();
        clamp.setUTCDate(clamp.getUTCDate() - 120);
        rangeStart = clamp.toISOString().slice(0, 10);
      }
      const maxCachedBanks = getMaxCachedDay(`banks.${defaultFormat}`);
      const cachedDayCount = dailyCacheStats(`banks.${defaultFormat}`).count;
      // Delta sync. Antes el backfill pegaba 2 años a fetchBankStatementsRange
      // siempre — el chunked cache filtraba días cacheados pero gaps internos
      // forzaban 50-100 reqs/boot por días pasados (`2025-10-06` etc).
      //
      // Tomamos como `lastSeen` el MÁX entre el daily-cache IDB y el
      // movimiento más reciente del heavy-store (`bankJdeStatements`).
      // Necesitamos ambos: el daily-cache se vacía/poda y el heavy-store
      // sobrevive (cuota dinámica IDB, save debounced) — sin leer heavy-store
      // un cache wipe nos manda al full 2yr backfill aunque el histórico ya
      // esté hidratado en estado. force=true mantiene el full range para
      // refresh manual.
      //
      // Cold-boot guard: tanto el state hidratado como la daily-cache pueden
      // tener su MAX en `today-1` aunque solo abarquen 5 días (el prime
      // cachea today + 5 días back). Confiar en ese MAX como floor mandaba
      // `rangeStart = today` y el backfill se reducía a un día. Confiamos
      // SOLO si el lado en cuestión cubre ≥ HISTORY_SPAN_DAYS — si no,
      // descartamos como insuficiente y dejamos `rangeStart` en `yearStart`.
      const HISTORY_SPAN_DAYS = 90;
      let maxStateBanks: string | null = null;
      const distinctStateDates = new Set<string>();
      for (const acc of bankJdeStatements) {
        for (const mov of acc.movimientos) {
          distinctStateDates.add(mov.fechaOperacion);
          if (!maxStateBanks || mov.fechaOperacion > maxStateBanks) {
            maxStateBanks = mov.fechaOperacion;
          }
        }
      }
      const stateSpansHistory = distinctStateDates.size >= HISTORY_SPAN_DAYS;
      const cacheSpansHistory = cachedDayCount >= HISTORY_SPAN_DAYS;
      const trustedStateMax = stateSpansHistory ? maxStateBanks : null;
      const trustedCacheMax = cacheSpansHistory ? maxCachedBanks : null;
      const lastSeen = trustedCacheMax && trustedStateMax
        ? (trustedCacheMax > trustedStateMax ? trustedCacheMax : trustedStateMax)
        : (trustedCacheMax ?? trustedStateMax);
      if (!force && lastSeen && lastSeen > rangeStart) {
        rangeStart = nextIsoDay(lastSeen);
      }
      // Revalidación de días vacíos recientes. El daily-cache puede tener
      // días pasados cacheados como `[]` porque el navegador los consultó
      // ANTES de que tesorería subiera el estado de cuenta a JDE (la carga
      // llega con atraso). El watermark `lastSeen` los saltaría para siempre
      // (el día "ya está cacheado"), así que el rango SIEMPRE incluye la
      // ventana reciente: fetchBankStatementsRange re-pide solo los días
      // vacíos de esa ventana; los días con datos siguen saliendo del cache.
      // Steady-state: ventana amplia (BANKS_BACKFILL_REVALIDATE_DAYS) para
      // tolerar el atraso de carga manual de Bajío/Santander. One-time heal: la
      // primera vez tras este fix (marker v2 ausente) la ventana se amplía a
      // 120 días para sanear caches envenenados viejos (días cacheados vacíos
      // antes de que tesorería subiera el estado de cuenta — p. ej. abril/mayo).
      const BANKS_EMPTY_HEAL_KEY = 'midas.banks.emptyDayHeal.v2';
      let emptyHealDone = true;
      try { emptyHealDone = localStorage.getItem(BANKS_EMPTY_HEAL_KEY) !== null; } catch { /* ignore */ }
      const revalidateEmptySince = isoDaysBefore(
        today,
        emptyHealDone ? BANKS_BACKFILL_REVALIDATE_DAYS : 120,
      );
      if (rangeStart > revalidateEmptySince) rangeStart = revalidateEmptySince;
      // Revalidación de días PARCIALES (no solo vacíos): un día CON datos pudo
      // cachearse cuando JDE tenía solo PARTE de los movimientos (captura con
      // atraso) y quedaba congelado — cada usuario veía un conteo distinto del
      // mismo día ("300 vs 330"). Re-pedimos los días recientes aunque tengan
      // datos; el valor previo se conserva si el refetch falla (nunca degrada).
      // Ventana más corta que la de vacíos: el atraso de captura es de días, no
      // de meses, y re-pedir días no-vacíos sí cuesta una request cada uno.
      const revalidateSince = isoDaysBefore(today, BANKS_PARTIAL_REVALIDATE_DAYS);
      // eslint-disable-next-line no-console
      console.info(
        `[banks v3-fix] backfill sync · maxCachedIDB=${maxCachedBanks ?? 'none'} (${cachedDayCount}d) · hydratedState=${bankJdeStatements.length} stmts / ${distinctStateDates.size} dates · stateSpansHistory=${stateSpansHistory} · cacheSpansHistory=${cacheSpansHistory} · trustedStateMax=${trustedStateMax ?? 'null'} · trustedCacheMax=${trustedCacheMax ?? 'null'} · force=${force} · idbPersist=${isDailyCachePersistent()} · revalidateEmptySince=${revalidateEmptySince}${emptyHealDone ? '' : ' (HEAL 120d)'} · range ${rangeStart}→${today} (${force ? 'FULL' : 'DELTA'} via daily cache)`,
      );

      if (rangeStart > today) {
        // eslint-disable-next-line no-console
        console.info('[banks v3-fix] backfill sync · cache cubre hasta hoy, SKIP — esto NO debería pasar en cold boot');
        setBankFetchStatus('idle');
        setBankFetchProgress(null);
        return { primed, ranged: true };
      }

      const fetchStart = performance.now();
      const full = await fetchBankStatementsRange(
        rangeStart,
        today,
        defaultFormat,
        {
          concurrency: 10,
          revalidateEmptySince,
          revalidateSince,
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
      const fetchMs = Math.round(performance.now() - fetchStart);
      const totalMovs = full.reduce((acc, s) => acc + s.movimientos.length, 0);
      // eslint-disable-next-line no-console
      console.info(
        `[banks v3-fix] backfill sync · fetch done · ${fetchMs}ms · ${full.length} statements · ${totalMovs} movs total`,
      );
      if (full.length > 0) {
        // Merge en lugar de replace: preserva cualquier statement adicional
        // que loadStore haya hidratado, y dedupea movimientos por (cia,
        // cuenta, moneda).
        setBankJdeStatements(prev => {
          const merged = mergeBankStatements(prev, full);
          const mergedMovs = merged.reduce((acc, s) => acc + s.movimientos.length, 0);
          // eslint-disable-next-line no-console
          console.info(
            `[banks v3-fix] backfill sync · merge done · prev=${prev.length} stmts → merged=${merged.length} stmts · ${mergedMovs} movs`,
          );
          return merged;
        });
        setBankLastQuery({
          fechaEstadoCuenta: today,
          formatoElectronico: defaultFormat,
          hasUploadedSantander: bankSupplementalStatements.length > 0,
        });
        setBanksLastSync(new Date().toISOString());
        ranged = true;
        // El rango regresó datos → el API es alcanzable; el saneo amplio
        // one-time ya corrió. Las siguientes pasadas usan la ventana de 14d.
        try { localStorage.setItem(BANKS_EMPTY_HEAL_KEY, today); } catch { /* ignore */ }
      } else {
        // eslint-disable-next-line no-console
        console.warn('[banks v3-fix] backfill sync · fetch retornó 0 statements — no merge');
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[banks v3-fix] backfill sync · ERROR caught', err);
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
        concurrency: 10,
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
    // Usuario sin ningún módulo que use bancos → no primar ni revalidar la API.
    if (!allowedDatasetsRef.current.has('banks')) {
      banksBootDone.current = true;
      setBootSlot('banks', 'done');
      return;
    }
    banksBootDone.current = true;
    // Cache-first boot (stale-while-revalidate, like every fast SPA): bank
    // statements are persisted in IDB/localStorage and already hydrated here
    // (effect gated on bankCacheLoaded). If we have ANY cached statements,
    // open the app INSTANTLY with them and revalidate JDE in the background —
    // never block the splash on a live JDE prime. A cold/slow JDE prime used
    // to hang the splash 100-240s ("2/3 listos") even though usable cached
    // bank data was sitting right there. Only a true cold start (zero cached
    // statements) waits for the first prime so the user doesn't land on an
    // empty treasury. The seasonal range backfill already runs in background.
    if (bankJdeStatements.length > 0) {
      setBootSlot('banks', 'done');
      // Background revalidate; errors stay silent (cached data is on screen).
      void refreshBankStatementsRange(false, false).catch(() => { /* keep cached */ });
    } else {
      (async () => {
        setBootSlot('banks', 'loading');
        try {
          await refreshBankStatementsRange(false, false);
          setBootSlot('banks', 'done');
        } catch {
          setBootSlot('banks', 'error');
        }
      })();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeHydrated, bankCacheLoaded]);

  // Backfill seasonal (2 años) en BACKGROUND — corre tras el prime, NO gatea
  // el splash. Para Holt-Winters (≥24m). Si el cache IDB persiste es barato
  // (días pasados salen de IDB); si no, refreshBankStatementsRange recorta a
  // 120d para no machacar JDE. Dispara al volverse 'done' el slot banks, con
  // el callback fresco → Step 1 ve bankJdeStatements ya primed y se lo salta.
  const bankRangeBackfillDone = useRef(false);
  useEffect(() => {
    if (bankRangeBackfillDone.current) return;
    if (bootStatus.banks !== 'done') return;
    if (!allowedDatasetsRef.current.has('banks')) return;
    bankRangeBackfillDone.current = true;
    void refreshBankStatementsRange(false, true);
  }, [bootStatus.banks, refreshBankStatementsRange]);

  // Los handlers de propuestas/escenarios ahora viven dentro de CashFlowView;
  // App sólo expone los setters directos al componente.

  // ── CXP per-cia cache management ──
  const mergeCxpForCia = useCallback((cia: string, records: CXPRecord[]) => {
    setCxpRecords(prev => [...prev.filter(r => r.cia !== cia), ...records]);
    setCxpLoadedCias(prev => ({ ...prev, [cia]: new Date().toISOString() }));
  }, []);
  // Import CSV: sólo reemplaza las cías presentes en el archivo — las demás
  // (cargadas de JDE) se conservan ("nunca degrada", paridad con el fix de
  // clobber de los loaders automáticos).
  const replaceCxpForCias = useCallback((records: CXPRecord[], cias: string[]) => {
    const ciaSet = new Set(cias);
    // Las filas sin cia (sólo pueden venir de un CSV previo) pertenecen al
    // último import: se purgan siempre — dejarlas acumulaba duplicados al
    // re-importar (nunca entran a ciaSet).
    setCxpRecords(prev => [...prev.filter(r => r.cia !== '' && !ciaSet.has(r.cia)), ...records]);
    const now = new Date().toISOString();
    setCxpLoadedCias(prev => ({ ...prev, ...cias.reduce<Record<string, string>>((acc, c) => { acc[c] = now; return acc; }, {}) }));
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

  const activeSection = SECTION_FOR_TAB[activeTab] ?? 'proyeccion';

  // ── RBAC: filtra secciones y sub-tabs por el rol del usuario ──────────────
  // Un tab no permitido no se renderiza en la navegación; una sección sin
  // tabs visibles se oculta por completo. La autorización vinculante la hace
  // el backend (AUTH.md) — esto es solo UX.
  const visibleSubTabsBySection = useMemo(() => {
    const out = {} as Record<SectionId, { id: TabId; label: string; icon: LucideIcon }[]>;
    (Object.keys(SUB_TABS) as SectionId[]).forEach((section) => {
      out[section] = SUB_TABS[section].filter((t) => canAccessTab(t.id as AppTabId));
    });
    return out;
  }, [canAccessTab]);

  const visibleSections = useMemo(
    () => SECTIONS.filter((s) => visibleSubTabsBySection[s.id].length > 0),
    [visibleSubTabsBySection],
  );

  /** Primer tab que el usuario puede ver, recorriendo el orden canónico. */
  const firstAllowedTab = useMemo<TabId | null>(() => {
    for (const section of SECTIONS) {
      const tabs = visibleSubTabsBySection[section.id];
      if (tabs.length > 0) return tabs[0].id;
    }
    return null;
  }, [visibleSubTabsBySection]);

  const subTabs = visibleSubTabsBySection[activeSection] ?? [];

  // Guard de render: si el usuario navega (deep-link / atajo / cambio de rol)
  // a un tab no permitido, lo mandamos al primer tab permitido y avisamos.
  const activeTabAllowed = canAccessTab(activeTab as AppTabId);
  useEffect(() => {
    if (activeTabAllowed) return;
    if (firstAllowedTab && firstAllowedTab !== activeTab) {
      setActiveTab(firstAllowedTab);
      toast.warning('No tienes acceso a este módulo.', { duration: 4000 });
    }
  }, [activeTabAllowed, firstAllowedTab, activeTab, toast]);

  // Atajos 1-N cambian sub-tabs DENTRO de la sección activa
  // (Proyección / Operación / Catálogos). Sección se deriva de activeTab.
  const { shortcutsOpen, setShortcutsOpen } = useKeyboardShortcuts({
    onTabSwitch: (n) => {
      const section = SECTION_FOR_TAB[activeTab] ?? 'proyeccion';
      const tabs = visibleSubTabsBySection[section] ?? [];
      if (n >= 1 && n <= tabs.length) setActiveTab(tabs[n - 1].id);
    },
  });

  // Seed for the global header scenario selector — cheap localStorage read,
  // no projection compute. Proyección modules register the fully-bootstrapped
  // list once they mount, which supersedes this.
  const initialHeaderScenarios = useMemo(() => listHeaderScenarios(), []);
  const activeTabDatasets = TAB_DATASETS[activeTab] ?? [];
  const datasetHasRecords: Record<DatasetKey, boolean> = {
    banks: bankStatements.length > 0,
    cxp: cxpRecords.length > 0,
    cobranza: cobranzaRecords.length > 0 || cobranzaPayments.length > 0,
    compras: comprasRecords.length > 0,
    pagos: pagoProveedorRecords.length > 0,
    nomina: nominaRecords.length > 0,
    rol: rolRecords.length > 0,
    auxiliar: auxiliarContableRecords.length > 0,
  };
  const tabDataPending = activeTabDatasets.some((dataset) => {
    const status = datasetStatus[dataset];
    return status !== 'ready' && status !== 'error' && !datasetHasRecords[dataset];
  });
  const projectionActive = activeTab === 'financialProjection';
  const planningActive = activeTab === 'financialPlanning';
  const [keepAliveVisited, setKeepAliveVisited] = useState<Set<TabId>>(
    () => (KEEP_ALIVE_TABS.has(activeTab) ? new Set([activeTab]) : new Set()),
  );
  // Retén SOLO el último heavy tab activo (no acumular). Antes el set crecía
  // y dejaba Proyección Y Planeación montados para siempre (uno display:none);
  // con comprasRecords ~334k + ambos árboles vivos = OOM del renderer al
  // navegar módulos. Cap a uno: el inactivo se desmonta. El remount es barato
  // — useFinancialProjectionSource (LRU por fingerprint) y useScenarioRunWorker
  // (worker cachea inputs pesados por versión, stale-while-recompute) sirven
  // el warm path sin recomputar. NO es el remount de NavigationProvider que
  // CLAUDE.md prohíbe (eso reinicia TODOS los workers); aquí solo un panel.
  //
  // El fijado NO espera a `!tabDataPending`: si lo hacía, entrar a un heavy
  // tab en boot dejaba el render colgado de `projectionActive && !pending`,
  // y como `tabDataPending` oscila mientras commitean datasets el panel
  // montaba/desmontaba en bucle → respawn de workers (miles de re-fetch de
  // scripts) + parpadeo. Fijar al volverse activo monta el panel UNA vez y
  // se queda; el dashboard tolera datos parciales (CLAUDE.md) y rellena al
  // llegar, sin desmontar.
  useEffect(() => {
    if (!KEEP_ALIVE_TABS.has(activeTab)) return;
    setKeepAliveVisited(prev =>
      prev.size === 1 && prev.has(activeTab) ? prev : new Set([activeTab]),
    );
  }, [activeTab]);
  const renderProjectionKeepAlive = keepAliveVisited.has('financialProjection') || (projectionActive && !tabDataPending);
  const renderPlanningKeepAlive = keepAliveVisited.has('financialPlanning') || (planningActive && !tabDataPending);
  const activeKeepAliveRendered = (projectionActive && renderProjectionKeepAlive) || (planningActive && renderPlanningKeepAlive);
  const navigateToTax = useCallback(() => setActiveTab('taxes'), []);
  const projectionProps = useMemo(() => ({
    companyCode: selectedCia,
    bankStatements,
    clients,
    providers,
    cxpRecords,
    cxpPaymentCoverage: paymentReconciliation.cxpCoverage,
    // Clasificación JDE del proveedor para el egreso HISTÓRICO cruzado. El
    // puente del libro mayor no la trae, así que sin esto el bucket lo decidía
    // un lookup por nombre contra el catálogo (~23%) — ver `mergeCargoEnrichments`.
    paymentCargoEnrichments: paymentReconciliation.cargoEnrichments,
    cobranzaRecords,
    cobranzaPayments,
    auxiliarReconciliation,
    rolRecords,
    viajesEspecialesRecords,
    purchaseReceipts: purchaseReceiptsFromCompras,
    payrollCosts: nominaRecords,
    assumptions,
    budget: null,
    startingBalance: undefined,
    onNavigateToTax: navigateToTax,
    payrollMonthlyActualJDE,
  }), [
    selectedCia,
    bankStatements,
    clients,
    providers,
    cxpRecords,
    paymentReconciliation.cxpCoverage,
    paymentReconciliation.cargoEnrichments,
    cobranzaRecords,
    cobranzaPayments,
    auxiliarReconciliation,
    rolRecords,
    viajesEspecialesRecords,
    purchaseReceiptsFromCompras,
    nominaRecords,
    assumptions,
    navigateToTax,
    payrollMonthlyActualJDE,
  ]);
  const planningProps = useMemo(() => ({
    companyCode: selectedCia,
    bankStatements: accountableBankStatements,
    bajioStatements,
    clients,
    providers,
    cxpRecords,
    cxpPaymentCoverage: paymentReconciliation.cxpCoverage,
    // Paridad OBLIGADA con `projectionProps`: ambos tableros comparten el memo de
    // módulo y el cache persistente del source. Si sólo uno mandara el cruce, el
    // otro le serviría (o le tomaría) una entrada con distinta clasificación.
    paymentCargoEnrichments: paymentReconciliation.cargoEnrichments,
    cobranzaRecords,
    cobranzaPayments,
    auxiliarReconciliation,
    rolRecords,
    viajesEspecialesRecords,
    purchaseReceipts: purchaseReceiptsFromCompras,
    payrollCosts: nominaRecords,
    assumptions,
    budget: null,
    startingBalance: undefined,
    payrollMonthlyActualJDE,
  }), [
    selectedCia,
    accountableBankStatements,
    bajioStatements,
    clients,
    providers,
    cxpRecords,
    paymentReconciliation.cxpCoverage,
    paymentReconciliation.cargoEnrichments,
    cobranzaRecords,
    cobranzaPayments,
    auxiliarReconciliation,
    rolRecords,
    viajesEspecialesRecords,
    purchaseReceiptsFromCompras,
    nominaRecords,
    assumptions,
    payrollMonthlyActualJDE,
  ]);
  const frozenProjectionProps = useFrozenWhenInactive(projectionProps, projectionActive);
  const frozenPlanningProps = useFrozenWhenInactive(planningProps, planningActive);

  const switchSection = (s: SectionId) => {
    setMobileNavOpen(false);
    if (s === activeSection) return;
    setActiveTab(DEFAULT_TAB[s]);
  };

  const dataWindowValue = useMemo<DataWindowValue>(() => ({
    defaultFloor: dataWindowDefaultFloor,
    floorByDataset: historicalFloorByDataset,
    loadingByDataset: historicalLoadingByDataset,
    ensureYearLoaded,
    isLoadingHistorical,
  }), [dataWindowDefaultFloor, historicalFloorByDataset, historicalLoadingByDataset, ensureYearLoaded, isLoadingHistorical]);

  return (
    <DataWindowProvider value={dataWindowValue}>
    <ScenarioSelectionProvider initialScenarios={initialHeaderScenarios}>
    <div className="min-h-dvh" style={{ background: 'var(--background)' }}>
      {splashMounted && (
        <MidasSplash
          visible={!isBooted}
          tasks={bootTasks}
          startedAt={bootStartedAtRef.current}
          blocked={bootBlocked}
          failedLabels={failedGatingTasks.map(t => t.label)}
          onRetry={() => window.location.reload()}
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
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between gap-3 sm:gap-4">
          {/* Hamburger — mobile/tablet only (xl- hides the inline section nav) */}
          <button
            onClick={() => setMobileNavOpen(true)}
            className="xl:hidden shell-icon-btn flex items-center justify-center w-9 h-9 rounded-[var(--radius-md)] flex-shrink-0 transition-colors duration-150"
            aria-label="Abrir menú de navegación"
            aria-expanded={mobileNavOpen}
          >
            <Menu className="w-5 h-5" strokeWidth={1.5} />
          </button>

          {/* Brand lockup — Senda (white, inverted on dark) + divider + Midas */}
          <div
            className="flex items-center gap-2 sm:gap-3 flex-shrink-0 cursor-pointer senda-lockup-dark mr-auto xl:mr-0"
            onClick={() => setActiveTab('netflow')}
            aria-label="Midas · Senda corporativo"
          >
            <img
              src={`${import.meta.env.BASE_URL}logos/senda-corporativo.svg`}
              alt="Senda"
              width={108}
              height={22}
              decoding="async"
              fetchpriority="high"
              className="senda-mark-inverted hidden sm:block"
              style={{ height: 22, width: 'auto', display: 'block' }}
            />
            <span
              aria-hidden="true"
              className="hidden sm:inline-block"
              style={{ width: 1, height: 22, background: 'var(--shell-border)' }}
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

          {/* Section nav — desktop only; collapses into the drawer below xl */}
          <nav
            role="navigation"
            aria-label="Secciones principales"
            className="hidden xl:flex items-center rounded-[var(--radius-md)] p-0.5 gap-0.5"
            style={{ background: 'var(--gray-50)', border: '1px solid var(--gray-200)' }}
          >
            {visibleSections.map(s => {
              const isActive = activeSection === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => switchSection(s.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className="flex items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-medium transition-colors duration-150 whitespace-nowrap"
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
          <div className="flex items-center gap-1 sm:gap-1.5 flex-shrink-0">
            {activeSection === 'proyeccion' && (
              <span className="hidden md:inline-flex"><GlobalScenarioSelector /></span>
            )}
            <button
              onClick={() => setDataHealthOpen(true)}
              title="Salud de datos"
              aria-label="Salud de datos"
              className="relative shell-icon-btn flex items-center justify-center w-9 h-9 rounded-[var(--radius-md)] flex-shrink-0 transition-colors duration-150"
            >
              <Activity className="w-4 h-4" strokeWidth={1.5} />
              {dataHealthGapCount > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute top-1 right-1 w-2 h-2 rounded-full"
                  style={{ background: 'var(--warning, #d97706)', boxShadow: '0 0 0 2px var(--surface)' }}
                />
              )}
            </button>
            <DarkModeToggle />
            {userEmail && (
              <button
                onClick={() => setChangePasswordOpen(true)}
                title="Cambiar contraseña"
                aria-label="Cambiar contraseña"
                className="hidden sm:flex shell-icon-btn items-center justify-center w-9 h-9 rounded-[var(--radius-md)] flex-shrink-0 transition-colors duration-150"
              >
                <KeyRound className="w-4 h-4" strokeWidth={1.5} />
              </button>
            )}
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

      {/* ─── MOBILE NAV DRAWER (off-canvas, lg- only) ─── */}
      {mobileNavOpen && (
        <div
          className="xl:hidden fixed inset-0 z-[60]"
          role="dialog"
          aria-modal="true"
          aria-label="Navegación"
        >
          <div
            className="absolute inset-0"
            style={{ background: 'rgba(15,23,42,0.45)' }}
            onClick={() => setMobileNavOpen(false)}
          />
          <div
            className="absolute inset-y-0 left-0 w-[82%] max-w-[320px] flex flex-col overflow-y-auto overscroll-contain animate-page-in"
            style={{
              background: 'var(--surface)',
              borderRight: '1px solid var(--gray-200)',
              boxShadow: '0 10px 40px rgba(15,23,42,0.25)',
              paddingTop: 'env(safe-area-inset-top)',
              paddingBottom: 'env(safe-area-inset-bottom)',
            }}
          >
            <div
              className="flex items-center justify-between px-4 h-14 border-b flex-shrink-0 sticky top-0"
              style={{ borderColor: 'var(--gray-200)', background: 'var(--surface)' }}
            >
              <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--shell-text)' }}>Midas</span>
              <button
                onClick={() => setMobileNavOpen(false)}
                className="shell-icon-btn flex items-center justify-center w-9 h-9 rounded-[var(--radius-md)]"
                aria-label="Cerrar menú"
              >
                <X className="w-5 h-5" strokeWidth={1.5} />
              </button>
            </div>

            <nav className="flex-1 px-2 py-3" aria-label="Secciones">
              {visibleSections.map((s) => {
                const sectionTabs = visibleSubTabsBySection[s.id] ?? [];
                const isActiveSection = activeSection === s.id;
                return (
                  <div key={s.id} className="mb-1">
                    <div
                      className="flex items-center gap-2 px-3 py-2 rounded-md text-[13px] font-semibold uppercase tracking-wide"
                      style={{ color: isActiveSection ? 'var(--primary)' : 'var(--gray-500)' }}
                    >
                      <s.icon className="w-4 h-4" strokeWidth={1.5} />
                      {s.label}
                    </div>
                    <div className="flex flex-col gap-0.5 pl-2">
                      {sectionTabs.map((t) => {
                        const isActive = activeTab === t.id;
                        return (
                          <button
                            key={t.id}
                            onClick={() => { setActiveTab(t.id); setMobileNavOpen(false); }}
                            aria-current={isActive ? 'page' : undefined}
                            className="flex items-center gap-2 text-left px-3 py-2 rounded-md text-[14px] font-medium transition-colors duration-150 min-h-11"
                            style={{
                              background: isActive ? 'var(--card)' : 'transparent',
                              color: isActive ? 'var(--gray-950)' : 'var(--gray-600)',
                              border: isActive ? '1px solid var(--gray-200)' : '1px solid transparent',
                            }}
                          >
                            <t.icon className="w-4 h-4 flex-shrink-0" strokeWidth={1.5} style={{ color: isActive ? 'var(--primary)' : 'var(--gray-400)' }} />
                            {t.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </nav>

            <div className="border-t px-2 py-3 flex flex-col gap-0.5" style={{ borderColor: 'var(--gray-200)' }}>
              {userEmail && (
                <button
                  onClick={() => { setMobileNavOpen(false); setChangePasswordOpen(true); }}
                  className="flex items-center gap-2 px-3 py-2 rounded-md text-[14px] font-medium min-h-11"
                  style={{ color: 'var(--gray-600)' }}
                >
                  <KeyRound className="w-4 h-4" strokeWidth={1.5} />
                  Cambiar contraseña
                </button>
              )}
              <button
                onClick={() => { clearAuth(); window.location.reload(); }}
                className="flex items-center gap-2 px-3 py-2 rounded-md text-[14px] font-medium min-h-11"
                style={{ color: 'var(--gray-600)' }}
              >
                <LogOut className="w-4 h-4" strokeWidth={1.5} />
                Cerrar sesión
              </button>
            </div>
          </div>
        </div>
      )}

      <ChangePasswordModal
        open={changePasswordOpen}
        onClose={() => setChangePasswordOpen(false)}
        onChanged={() => toast.success('Contraseña actualizada.')}
      />

      {/* ─── SUB-TABS with context breadcrumb (light shell) ─── */}
      {subTabs.length > 0 && (
        <div className="border-b" style={{ background: 'var(--gray-50)', borderColor: 'var(--gray-200)' }}>
          <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center gap-1 py-1.5 overflow-x-auto no-scrollbar">
              {/* Breadcrumb context */}
              <span className="hidden sm:flex text-[12px] font-medium mr-2 items-center gap-1 flex-shrink-0" style={{ color: 'var(--gray-500)' }}>
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
                    className="min-h-9 px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors duration-150 whitespace-nowrap flex-shrink-0"
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
         NavigationProvider stays stable across module switches. Avoid using
         a dynamic key here: forcing a remount discards dashboard state and
         restarts expensive workers/calculations on every tab change. */}
      <main id="main-content" role="main" className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-4">
        <NavigationProvider goTo={goTo}>
          <div className="animate-page-in">
          <ErrorBoundary
            fallbackLabel={subTabs.find(t => t.id === activeTab)?.label ?? activeTab}
            resetKeys={[activeTab]}
          >
            {!activeTabAllowed ? (
              <div
                className="mx-auto mt-12 max-w-md rounded-[var(--radius-lg)] p-8 text-center"
                style={{ background: 'var(--card)', border: '1px solid var(--gray-200)' }}
              >
                <Lock className="mx-auto h-8 w-8" strokeWidth={1.5} style={{ color: 'var(--gray-400)' }} />
                <h2 className="mt-3 text-[16px] font-semibold" style={{ color: 'var(--gray-950)' }}>
                  No tienes acceso a este módulo
                </h2>
                <p className="mt-1 text-[13px]" style={{ color: 'var(--gray-500)' }}>
                  Tu rol ({userRole}) no incluye esta sección.
                </p>
              </div>
            ) : (
              <>
            {renderProjectionKeepAlive && (
              <KeepAlivePanel active={projectionActive}>
                <Suspense fallback={<LazyTabFallback label="Proyección Financiera" />}>
                  <FinancialProjectionDashboard
                    {...frozenProjectionProps}
                    isActive={projectionActive}
                  />
                </Suspense>
              </KeepAlivePanel>
            )}
            {renderPlanningKeepAlive && (
              <KeepAlivePanel active={planningActive}>
                <Suspense fallback={<LazyTabFallback label="Planeación Financiera" />}>
                  <FinancialPlanningDashboard {...frozenPlanningProps} />
                </Suspense>
              </KeepAlivePanel>
            )}
            {tabDataPending && !activeKeepAliveRendered ? (
              <DashboardLoadingShell
                label={`Cargando ${subTabs.find(t => t.id === activeTab)?.label ?? activeTab}`}
                kpis={4}
                showFilterBar={false}
                showChart={activeSection === 'proyeccion'}
                tableRows={activeSection === 'porPagar' || activeSection === 'cobranza' ? 5 : 0}
              />
            ) : (
              <>
            {activeTab === 'taxes' && (
              <Suspense fallback={<LazyTabFallback label="Impuestos" />}>
                <TaxDashboard
                  companyCode={selectedCia}
                  companies={companies}
                  bankStatements={accountableBankStatements}
                  clients={clients}
                  providers={providers}
                  cxpRecords={cxpRecords}
                  cobranzaRecords={cobranzaRecords}
                  cobranzaPayments={cobranzaPayments}
                  cxpPaymentCoverage={paymentReconciliation.cxpCoverage}
                  paymentMatches={paymentReconciliation.paymentMatches}
                  auxiliarReconciliation={auxiliarReconciliation}
                  auxiliarIvaRecords={auxiliarIvaRecords}
                  purchaseReceipts={purchaseReceiptsForTaxes}
                  projectionPurchaseReceipts={purchaseReceiptsFromCompras}
                  payrollCosts={nominaRecords}
                  assumptions={assumptions}
                  budget={null}
                  startingBalance={undefined}
                />
              </Suspense>
            )}
            {activeTab === 'payroll' && (
              <Suspense fallback={<LazyTabFallback label="Nómina" />}>
                <PayrollDashboard
                  companyCode={selectedCia}
                  nominaRecords={nominaRecords}
                  nominaLoadedKeys={nominaLoadedKeys}
                  syncStatus={datasetStatus.nomina}
                  // Backfill progress hint: how many of the expected 24 months
                  // (fast-path YTD + historical) have landed in localStorage.
                  // Boot's setBootSlot('nomina', 'done') fires after the
                  // fast-path (4 months) so the splash dismisses, but the
                  // historical backfill keeps merging records for several
                  // minutes after. UI uses this to show a "loading historic"
                  // banner so users don't think the partial KPIs are final.
                  backfillProgress={{
                    loaded: Object.keys(nominaLoadedKeys).length,
                    total: 24,
                  }}
                  onNominaFetched={(batch, freshKeys) => {
                    // Merge funcional del batch recién bajado sobre el estado
                    // vivo — el hijo ya no manda un merge computado desde su
                    // prop (snapshot que pisaba commits concurrentes del boot
                    // loader / backfillNomina, estado + IDB).
                    setNominaRecords(prev => {
                      const merged = mergeNominaBatch(prev, batch);
                      void saveHeavyRecords('nominaRecords', merged);
                      return merged;
                    });
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
            {activeTab === 'venta' && (
              <Suspense fallback={<LazyTabFallback label="Venta" />}>
                <SalesCalendarDashboard
                  cobranzaRecords={cobranzaRecords}
                  rolRecords={rolRecords}
                  viajesEspecialesRecords={viajesEspecialesRecords}
                  cobranzaPayments={cobranzaPayments}
                  companies={companies}
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
                  rolRecords={rolRecords}
                  cobranzaLoadedCias={cobranzaLoadedCias}
                  cobranzaReconciliation={cobranzaReconciliation}
                  cobranzaFacturaIndex={cobranzaFacturaIndex}
                  cobranzaError={cobranzaError}
                  onRefreshCobranza={refreshCobranza}
                  cobranzaRefreshing={cobranzaRefreshing}
                  selectedCia={selectedCia}
                  onEnsureBankCoverage={ensureBankCoverageForCollections}
                  bankCoverageLoading={bankCoverageLoading}
                  glConfirmedInvoiceKeys={cobranzaGlConfirmedKeys}
                />
              </Suspense>
            )}
            {activeTab === 'kpisObjectives' && (
              <Suspense fallback={<LazyTabFallback label="KPIs y Objetivos" />}>
                <KpisObjectivesDashboard
                  companyCode={selectedCia}
                  bankStatements={accountableBankStatements}
                  bajioStatements={bajioStatements}
                  clients={clients}
                  providers={providers}
                  cobranzaRecords={cobranzaRecords}
                  cobranzaPayments={cobranzaPayments}
                  cxpRecords={cxpRecords}
                  cxpPaymentCoverage={paymentReconciliation.cxpCoverage}
                  auxiliarReconciliation={auxiliarReconciliation}
                  rolRecords={rolRecords}
                  viajesEspecialesRecords={viajesEspecialesRecords}
                  purchaseReceipts={purchaseReceiptsFromCompras}
                  payrollCosts={nominaRecords}
                  assumptions={assumptions}
                  budget={null}
                  startingBalance={undefined}
                />
              </Suspense>
            )}
            {activeTab === 'fideicomiso' && (
              <Suspense fallback={<LazyTabFallback label="Fideicomiso Dina" />}>
                <FideicomisoDashboard
                  bankStatements={bankStatements}
                  companies={companies}
                  selectedCia={selectedCia}
                  onRefreshBanks={() => refreshBankStatementsRange(true, true)}
                  bankFetchStatus={bankFetchStatus}
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
                  onReplaceAll={replaceCxpForCias}
                  onReset={resetCxp}
                />
              </Suspense>
            )}
            {activeTab === 'concursoMercantil' && (
              <Suspense fallback={<LazyTabFallback label="Concurso Mercantil" />}>
                <ConcursoMercantilDashboard
                  cxpRecords={cxpRecords}
                  companies={companies}
                  selectedCia={selectedCia}
                  bankStatements={accountableBankStatements}
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
            {activeTab === 'pasivoDistribuir' && (
              <Suspense fallback={<LazyTabFallback label="Pasivo por Distribuir" />}>
                <PasivoDistribuir
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
                  paymentMatches={paymentReconciliation.paymentMatches}
                  comprasRecords={comprasRecords}
                  cxpRecords={cxpRecords}
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
                  startingBalance={undefined}
                />
              </Suspense>
            )}
            {activeTab === 'users' && (
              <Suspense fallback={<LazyTabFallback label="Usuarios" />}>
                <UsersDashboard />
              </Suspense>
            )}
            {activeTab === 'permisos' && (
              <Suspense fallback={<LazyTabFallback label="Permisos" />}>
                <PermissionsDashboard />
              </Suspense>
            )}
            {/* TEMPORAL fuentes-datos (2026-07-10): diagnóstico de frescura
                por fuente. Quitar junto con src/modules/data-sources/. */}
            {activeTab === 'fuentesBancos' && (
              <Suspense fallback={<LazyTabFallback label="Fuentes y Datos" />}>
                <DataSourcesDashboard
                  source="bancos"
                  bankStatements={bankStatements}
                  companies={companies}
                />
              </Suspense>
            )}
            {activeTab === 'fuentesJde' && (
              <Suspense fallback={<LazyTabFallback label="Fuentes y Datos" />}>
                <DataSourcesDashboard
                  source="jde"
                  companies={companies}
                  cxpRecords={cxpRecords}
                  cobranzaRecords={cobranzaRecords}
                  comprasRecords={comprasRecords}
                  pagoProveedorRecords={pagoProveedorRecords}
                  bankJdeStatements={bankJdeStatements}
                  auxiliarRecords={auxiliarContableRecords}
                />
              </Suspense>
            )}
            {activeTab === 'fuentesTress' && (
              <Suspense fallback={<LazyTabFallback label="Fuentes y Datos" />}>
                <DataSourcesDashboard
                  source="tress"
                  nominaRecords={nominaRecords}
                  companies={companies}
                />
              </Suspense>
            )}
            {activeTab === 'fuentesRol' && (
              <Suspense fallback={<LazyTabFallback label="Fuentes y Datos" />}>
                <DataSourcesDashboard
                  source="rol"
                  rolRecords={rolRecords}
                  viajesEspecialesRecords={viajesEspecialesRecords}
                />
              </Suspense>
            )}
            {/* Forecast tab fused into Dashboard — no longer standalone */}
              </>
            )}
              </>
            )}
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
      <DataHealthPanel
        open={dataHealthOpen}
        onClose={() => setDataHealthOpen(false)}
        datasets={dataHealthRows}
        onResync={resyncDataLake}
        resyncing={resyncing}
      />
      <KeyboardShortcutsModal
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />
      </div>
    </div>
    </ScenarioSelectionProvider>
    </DataWindowProvider>
  );
}

/**
 * Global scenario picker — replaces the old company filter in the header.
 * Visible only in the Dashboard section (SectionId `proyeccion`). Selecting
 * here drives every tab in that section (Proyección Financiera, Planeación,
 * Concurso Mercantil, Fideicomiso) because they read `activeScenarioId` from
 * the same provider.
 */
function GlobalScenarioSelector() {
  const ctx = useScenarioSelection();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!ctx) return null;

  const { scenarios, activeScenarioId, setActiveScenarioId } = ctx;
  const visible = scenarios.filter((s) => !s.archivedAt);
  const base = visible.find((s) => s.kind === 'BASE');
  const approved = visible.find((s) => s.kind === 'APPROVED');
  const drafts = visible.filter((s) => s.kind === 'DRAFT');
  const active = visible.find((s) => s.id === activeScenarioId) ?? approved ?? base;

  const ActiveIcon =
    active?.kind === 'BASE' ? Lock : active?.kind === 'DRAFT' ? GitBranch : ShieldCheck;

  const renderOption = (s: FinancialScenario, Icon: LucideIcon, badge: string) => {
    const isActive = s.id === activeScenarioId;
    return (
      <button
        key={s.id}
        role="option"
        aria-selected={isActive}
        onClick={() => {
          setOpen(false);
          startTransition(() => setActiveScenarioId(s.id));
        }}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-[var(--radius-md)] text-[13px] text-left transition"
        style={{
          background: isActive ? 'var(--primary-muted)' : undefined,
          color: isActive ? 'var(--primary)' : 'var(--gray-950)',
        }}
      >
        <Icon className="w-4 h-4 flex-shrink-0" strokeWidth={1.5} />
        <span className="font-medium truncate flex-1">{s.name}</span>
        <span
          className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em] flex-shrink-0"
          style={{
            background: isActive ? 'rgba(255,255,255,0.5)' : 'var(--gray-100)',
            color: isActive ? 'var(--primary)' : 'var(--gray-500)',
          }}
        >
          {badge}
        </span>
        {isActive && <Check className="w-3.5 h-3.5 flex-shrink-0" />}
      </button>
    );
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Escenario activo: ${active?.name ?? 'Aprobado'}. Aplica a toda la Proyección.`}
        className="shell-picker-btn flex items-center gap-1.5 h-9 px-3 rounded-[var(--radius-md)] text-[13px] font-medium transition-colors duration-150 max-w-[150px] 2xl:max-w-[260px]"
        style={{
          background: 'rgba(255,255,255,0.08)',
          color: 'var(--shell-text)',
          border: '1px solid var(--shell-border)',
        }}
        title="Escenario activo — aplica a los módulos del Dashboard (Proyección, Planeación, Concurso, Fideicomiso)"
      >
        <ActiveIcon
          className="w-4 h-4 flex-shrink-0"
          strokeWidth={1.5}
          style={{ color: 'var(--shell-text-muted)' }}
        />
        <span className="truncate">{active?.name ?? 'Escenario Aprobado'}</span>
        <ChevronDown
          className={`w-3.5 h-3.5 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          strokeWidth={1.5}
          style={{ color: 'var(--shell-text-muted)' }}
        />
      </button>

      {open && (
        <div
          className="absolute right-0 top-11 w-[320px] max-w-[calc(100vw-1.5rem)] rounded-[var(--radius-md)] border p-1.5 z-50 max-h-[480px] overflow-y-auto animate-slide-down"
          style={{ background: 'var(--surface)', borderColor: 'var(--gray-200)', boxShadow: 'var(--shadow-md)' }}
        >
          <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--gray-400)] px-3 pt-1.5 pb-1 font-medium">
            Escenario activo
          </div>
          {base && renderOption(base, Lock, 'base')}
          {approved && renderOption(approved, ShieldCheck, 'main')}
          {drafts.length > 0 && (
            <>
              <div className="h-px bg-[var(--gray-100)] my-1.5" />
              <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--gray-400)] px-3 py-1 font-medium">
                Propuestas
              </div>
              {drafts.map((d) => renderOption(d, GitBranch, 'draft'))}
            </>
          )}
          <div className="h-px bg-[var(--gray-100)] my-1.5" />
          <p className="text-[11px] leading-snug px-3 py-1.5" style={{ color: 'var(--gray-400)' }}>
            Crea, edita o aprueba escenarios en <span className="font-medium text-[var(--gray-500)]">Planeación Financiera</span>.
          </p>
        </div>
      )}
    </div>
  );
}
