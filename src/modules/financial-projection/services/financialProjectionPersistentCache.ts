import type {
  FinancialProjectionSourceData,
  FinancialProjectionSourceInput,
} from './financialProjectionService';
import type { ScenarioForecastRun } from '../../financial-planning/services/scenarioForecastRun';
import { todayISO } from '../../../formatters';
import { APP_VERSION } from '../../../config/appVersion';

const DB_NAME = 'midas-financial-projection-cache';
const DB_VERSION = 1;
const STORE_NAME = 'entries';
const INDEX_KEY = 'midas.financialProjection.cache.index.v1';
// v2: client fingerprint expanded to cover `frequency`, `paymentDayName`,
// `commercialGroupId` patched by the JDE cobranza overlay.
// v3: la clave incorpora la versión de la app (ver ENGINE_VERSION).
const SCHEMA_VERSION = 3;
// Los valores persistidos son SALIDAS DEL MOTOR (movimientos ya prorrateados,
// corridas ya calculadas), pero la clave sólo describía los INPUTS. Un fix del
// motor que cambia el número sin cambiar el dato de origen (p.ej. el
// denominador del prorrateo Citi, PR #239) dejaba la entrada pre-fix vigente:
// el navegador computaba bien al arrancar y volvía al número viejo en cuanto
// esta cache resolvía. Por eso la versión de la app entra en la llave — cada
// deploy invalida las salidas del motor anterior. `clearCacheStorageOnEntry`
// borra esta BD, pero `deleteDatabase` se bloquea en silencio si otra pestaña
// la tiene abierta, así que no basta.
const ENGINE_VERSION = `${SCHEMA_VERSION}:${APP_VERSION}`;
const SOURCE_LIMIT = 12;
const SCENARIO_LIMIT = 24;
// El forecast probabilístico (Holt-Winters + Monte Carlo del Escenario
// Aprobado) es caro y estable: se computa una vez y se persiste para que
// boots futuros lo sirvan sin recomputar ("carga una vez y se guarda").
const PROBABILISTIC_LIMIT = 8;

type CacheKind = 'projection-source' | 'scenario-run' | 'probabilistic-forecast';

interface CacheIndexEntry {
  key: string;
  kind: CacheKind;
  savedAt: string;
}

interface CacheIndex {
  schemaVersion: number;
  entries: CacheIndexEntry[];
}

interface IdbEntry<T = unknown> {
  key: string;
  kind: CacheKind;
  savedAt: string;
  value: T;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
let idbWarned = false;

// In-memory L1 over IDB. Los valores de `projection-source` y `scenario-run`
// son enormes (movements/runs completos) y ya tienen caches vivos en sus
// servicios de ejecución. Retenerlos aquí duplicaba cientos de MB y podía
// disparar el guard de Chrome "Paused before potential out-of-memory crash".
// Para esos kinds dejamos sólo el L2 persistente en IndexedDB: cache hit entre
// sesiones sin clavar otra copia en RAM. El L1 queda reservado para artefactos
// más chicos como el forecast probabilístico.
const SESSION_PROBABILISTIC_LIMIT = 2;

interface SessionEntry {
  kind: CacheKind;
  value: unknown;
}

interface PendingWriteEntry {
  kind: CacheKind;
  value: unknown;
  promise: Promise<void>;
}

// Map mantiene orden de inserción → iteración da LRU (más viejo primero).
const sessionCache = new Map<string, SessionEntry>();
const pendingWrites = new Map<string, PendingWriteEntry>();

function pendingWriteKey(key: string, kind: CacheKind): string {
  return `${kind}\u0000${key}`;
}

function pendingWriteGet(key: string, kind: CacheKind): unknown {
  const hit = pendingWrites.get(pendingWriteKey(key, kind));
  return hit?.kind === kind ? hit.value : undefined;
}

function sessionCacheLimit(kind: CacheKind): number {
  return kind === 'probabilistic-forecast' ? SESSION_PROBABILISTIC_LIMIT : 0;
}

function sessionCacheGet(key: string, kind: CacheKind): unknown {
  if (sessionCacheLimit(kind) <= 0) return undefined;
  const hit = sessionCache.get(key);
  if (!hit || hit.kind !== kind) return undefined;
  // Touch: re-inserta al final para marcarlo como más reciente.
  sessionCache.delete(key);
  sessionCache.set(key, hit);
  return hit.value;
}

function sessionCacheSet(key: string, kind: CacheKind, value: unknown): void {
  const limit = sessionCacheLimit(kind);
  if (limit <= 0) {
    sessionCache.delete(key);
    return;
  }
  if (sessionCache.has(key)) sessionCache.delete(key);
  sessionCache.set(key, { kind, value });
  let count = 0;
  // Recorre de más reciente a más viejo; evicta los que excedan el cap de su
  // kind (el conteo por kind evita que muchos runs desalojen el source vivo).
  const keys = Array.from(sessionCache.keys());
  for (let i = keys.length - 1; i >= 0; i--) {
    const entry = sessionCache.get(keys[i]);
    if (!entry || entry.kind !== kind) continue;
    count++;
    if (count > limit) sessionCache.delete(keys[i]);
  }
}

export function projectionSourcePersistentCacheKey(input: FinancialProjectionSourceInput): string {
  const asOfDate = input.asOfDate ?? todayISO();
  return `projection-source:${hashString([
    `v=${ENGINE_VERSION}`,
    `company=${input.companyCode}`,
    `asOf=${asOfDate}`,
    `starting=${input.startingBalance}`,
    `predictive=${input.enablePredictive !== false ? '1' : '0'}`,
    `assumptions=${stableStringify(input.assumptions)}`,
    `budget=${budgetFingerprint(input.budget)}`,
    `banks=${fingerprintArray(input.bankStatements, bankStatementFingerprint)}`,
    // Client fields that drive projection. `updatedAt` doesn't exist on
    // Client (was always undefined → no signal). `frequency`, `paymentDayName`
    // and `commercialGroupId` are patched at runtime by
    // recomputeClientCreditDaysFromCobranza (JDE 2026-05-19 overlay) — without
    // them in the fingerprint the persistent cache returned stale projections
    // after the cobranza overlay updated cadence / payment-day-name.
    `clients=${fingerprintArray(input.clients, (item) => fields(item, ['id', 'name', 'paymentDay', 'paymentDayName', 'creditDays', 'frequency', 'commercialGroupId']))}`,
    // `montoPromedioPago`/`gastoMinimoMensual` are patched at runtime by
    // enrichProvidersWithRecentSpend (rolling window from PagoProveedor)
    // without touching `lastUpdatedAt`, so they must be fingerprinted directly.
    // `paymentPeriod` and `clasificacionAlberto` drive payment scheduling.
    `providers=${fingerprintArray(input.providers, (item) => fields(item, ['id', 'name', 'type', 'risk', 'flexibility', 'paymentPeriod', 'score', 'clasificacionAlberto', 'montoPromedioPago', 'gastoMinimoMensual', 'lastUpdatedAt']))}`,
    // `cxp` y `cobranza` son ledger-posted desde JDE — no se editan in-place,
    // sólo entran/salen records vía upsert por (cia, noFactura). Como Rol, la
    // longitud es señal estructural suficiente: cualquier mutación real cambia
    // el conteo. El fingerprint completo iteraba ~65k filas (cobranza) en cada
    // cómputo de clave, bloqueando 100-300ms el main thread. `updatedAt` no
    // existe en CobranzaRecord ni CXPRecord (verificado en jdeTypes.ts y
    // persistence.ts), así que el walk full no aportaba señal extra.
    `cxp=len:${input.cxpRecords.length}`,
    `cobranza=len:${(input.cobranzaRecords ?? []).length}`,
    // Fingerprint barato: longitud nada más. Iterar campos de 65k records
    // bloqueaba ~100-300ms el main thread en CADA cómputo de clave (boot +
    // cada cambio de cacheProbeInput). `refreshRol` ya usa upsert por
    // (cia,kCliente,anio,semana,ruta,tipoViaje) → la longitud cambia solo
    // cuando entran/salen viajes reales (señal correcta de invalidación).
    // Mismo trade-off que el memory cache (refId): identidad estructural, no
    // contenido. Si necesitamos sensibilidad a edición in-place de un viaje
    // (factura/efectuado), agregar un contador de "updates" en el upsert.
    `rol=len:${(input.rolRecords ?? []).length}`,
    `purchase=${fingerprintArray(input.purchaseReceipts ?? [], (item) => fields(item, ['cia', 'noProveedor', 'invoiceNo', 'purchaseOrderNo', 'receiptNo', 'estimatedDueDate', 'totalAmount', 'status', 'confidence']))}`,
    `payroll=${fingerprintArray(input.payrollCosts ?? [], (item) => fields(item, ['cia', 'year', 'month', 'paymentDate', 'payrollPeriod', 'conceptId', 'amount']))}`,
    // Reconciliation fingerprint: structural counts only. Serializing the full
    // AuxiliarReconResult (lines + bankOrphans + sourceConfirmation Map) builds
    // a ~25MB string and burns the main thread on boot (foldHash char-by-char).
    // Any real change to the recon output moves at least one summary counter,
    // a list length, or the sourceConfirmation size — same trade-off as the
    // cxp/cobranza/rol `len:` fingerprints above.
    `reconciliation=${reconciliationFingerprint(input.auxiliarReconciliation)}`,
  ].join('|'))}`;
}

export function scenarioRunPersistentCacheKey(rawKey: string): string {
  return `scenario-run:${hashString(`v=${ENGINE_VERSION}|${rawKey}`)}`;
}

export async function loadProjectionSourceFromPersistentCache(
  input: FinancialProjectionSourceInput,
): Promise<FinancialProjectionSourceData | null> {
  return loadEntry<FinancialProjectionSourceData>(projectionSourcePersistentCacheKey(input), 'projection-source');
}

export function saveProjectionSourceToPersistentCache(
  input: FinancialProjectionSourceInput,
  result: FinancialProjectionSourceData,
): void {
  void saveEntry(projectionSourcePersistentCacheKey(input), 'projection-source', result);
}

export async function loadScenarioRunFromPersistentCache(
  rawKey: string,
): Promise<ScenarioForecastRun | null> {
  return loadEntry<ScenarioForecastRun>(scenarioRunPersistentCacheKey(rawKey), 'scenario-run');
}

export function saveScenarioRunToPersistentCache(
  rawKey: string,
  run: ScenarioForecastRun,
): void {
  void saveEntry(scenarioRunPersistentCacheKey(rawKey), 'scenario-run', run);
}

export function probabilisticForecastPersistentCacheKey(rawKey: string): string {
  return `probabilistic-forecast:${hashString(`v=${ENGINE_VERSION}|${rawKey}`)}`;
}

export async function loadProbabilisticForecastFromPersistentCache<T>(
  rawKey: string,
): Promise<T | null> {
  return loadEntry<T>(probabilisticForecastPersistentCacheKey(rawKey), 'probabilistic-forecast');
}

export function saveProbabilisticForecastToPersistentCache<T>(
  rawKey: string,
  run: T,
): void {
  void saveEntry(probabilisticForecastPersistentCacheKey(rawKey), 'probabilistic-forecast', run);
}

export function __clearFinancialProjectionPersistentCacheForTests(): void {
  sessionCache.clear();
  pendingWrites.clear();
  writeIndex({ schemaVersion: SCHEMA_VERSION, entries: [] });
}

async function loadEntry<T>(key: string, kind: CacheKind): Promise<T | null> {
  const index = readIndex();
  if (!index.entries.some((entry) => entry.key === key && entry.kind === kind)) return null;
  const sessionHit = sessionCacheGet(key, kind);
  if (sessionHit) return sessionHit as T;
  const pendingHit = pendingWriteGet(key, kind);
  if (pendingHit) return pendingHit as T;
  const db = await openDb();
  if (!db) return null;
  return new Promise<T | null>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => {
        const value = req.result as IdbEntry<T> | undefined;
        if (!value || value.kind !== kind) {
          resolve(null);
          return;
        }
        sessionCacheSet(key, kind, value.value);
        resolve(value.value);
      };
      req.onerror = () => resolve(null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function saveEntry<T>(key: string, kind: CacheKind, value: T): Promise<void> {
  const savedAt = new Date().toISOString();
  sessionCacheSet(key, kind, value);
  rememberIndexEntry({ key, kind, savedAt });
  const pendingKey = pendingWriteKey(key, kind);
  const writePromise = writeEntryToIdb(key, kind, savedAt, value);
  pendingWrites.set(pendingKey, { kind, value, promise: writePromise });
  try {
    await writePromise;
  } finally {
    if (pendingWrites.get(pendingKey)?.promise === writePromise) {
      pendingWrites.delete(pendingKey);
    }
  }
}

async function writeEntryToIdb<T>(
  key: string,
  kind: CacheKind,
  savedAt: string,
  value: T,
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put({ key, kind, savedAt, value } satisfies IdbEntry<T>);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') {
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }
  dbPromise = new Promise((resolve) => {
    let resolved = false;
    const finish = (db: IDBDatabase | null) => {
      if (!resolved) {
        resolved = true;
        resolve(db);
      }
    };
    const timeoutId = window.setTimeout(() => {
      if (!idbWarned) {
        idbWarned = true;
        console.warn('[financialProjectionPersistentCache] IDB open timeout');
      }
      finish(null);
    }, 2500);
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => {
        window.clearTimeout(timeoutId);
        req.result.onversionchange = () => req.result.close();
        finish(req.result);
      };
      req.onerror = () => {
        window.clearTimeout(timeoutId);
        if (!idbWarned) {
          idbWarned = true;
          console.warn('[financialProjectionPersistentCache] IDB open failed', req.error);
        }
        finish(null);
      };
      req.onblocked = () => { /* timeout handles blocked opens */ };
    } catch (err) {
      window.clearTimeout(timeoutId);
      if (!idbWarned) {
        idbWarned = true;
        console.warn('[financialProjectionPersistentCache] IDB no disponible', err);
      }
      finish(null);
    }
  });
  return dbPromise;
}

function readIndex(): CacheIndex {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return { schemaVersion: SCHEMA_VERSION, entries: [] };
    const parsed = JSON.parse(raw) as CacheIndex;
    if (parsed?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.entries)) {
      return { schemaVersion: SCHEMA_VERSION, entries: [] };
    }
    return parsed;
  } catch {
    return { schemaVersion: SCHEMA_VERSION, entries: [] };
  }
}

function writeIndex(index: CacheIndex): void {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    /* metadata cache only */
  }
}

function rememberIndexEntry(entry: CacheIndexEntry): void {
  const index = readIndex();
  const entries = [entry, ...index.entries.filter((item) => item.key !== entry.key)];
  const sources = entries.filter((item) => item.kind === 'projection-source').slice(0, SOURCE_LIMIT);
  const runs = entries.filter((item) => item.kind === 'scenario-run').slice(0, SCENARIO_LIMIT);
  const forecasts = entries.filter((item) => item.kind === 'probabilistic-forecast').slice(0, PROBABILISTIC_LIMIT);
  writeIndex({ schemaVersion: SCHEMA_VERSION, entries: [...sources, ...runs, ...forecasts] });
}

function fingerprintArray<T>(items: readonly T[], pick: (item: T) => string): string {
  let hash = items.length;
  for (const item of items) hash = foldHash(hash, pick(item));
  return `${items.length}:${hash >>> 0}`;
}

function bankStatementFingerprint(statement: FinancialProjectionSourceInput['bankStatements'][number]): string {
  // Movimientos bancarios son ledger-posted desde JDE / supplemental upload —
  // no se editan in-place, sólo entran nuevos al final. Longitud + máxima
  // `fechaOperacion` carga señal estructural suficiente sin iterar 6 campos
  // × N movimientos × M cuentas (era el hot path dominante en el perf trace
  // después de P2: `foldHash` + `fingerprintArray` calientes). Para 2 años
  // de movimientos × ~10 cuentas, el walk completo era ~50k iteraciones por
  // cómputo de clave.
  const movs = statement.movimientos ?? [];
  let maxFecha = '';
  for (const m of movs) {
    const f = (m as { fechaOperacion?: string }).fechaOperacion ?? '';
    if (f > maxFecha) maxFecha = f;
  }
  return fields(statement, ['cia', 'banco', 'nombreBanco', 'cuenta', 'moneda', 'fechaEstadoCuenta', 'saldoInicial', 'saldoFinal'])
    + `:mov=len:${movs.length}:max:${maxFecha}`;
}

function fields(value: unknown, keys: string[]): string {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return keys.map((key) => `${key}=${primitive(record[key])}`).join(',');
}

function primitive(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  return stableStringify(value);
}

function budgetFingerprint(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const budget = value as {
    year?: unknown;
    uploadedAt?: unknown;
    incomeTotal?: unknown[];
    expenseTotal?: unknown[];
  };
  return [
    `year=${primitive(budget.year)}`,
    `uploadedAt=${primitive(budget.uploadedAt)}`,
    `income=${fingerprintArray(budget.incomeTotal ?? [], primitive)}`,
    `expense=${fingerprintArray(budget.expenseTotal ?? [], primitive)}`,
  ].join('|');
}

function reconciliationFingerprint(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const recon = value as {
    lines?: unknown[];
    bankOrphans?: unknown[];
    sourceConfirmation?: Map<unknown, unknown> | Record<string, unknown>;
    summary?: Record<string, unknown>;
  };
  const linesLen = Array.isArray(recon.lines) ? recon.lines.length : 0;
  const orphansLen = Array.isArray(recon.bankOrphans) ? recon.bankOrphans.length : 0;
  const sc = recon.sourceConfirmation;
  const scSize = sc instanceof Map ? sc.size : sc && typeof sc === 'object' ? Object.keys(sc).length : 0;
  const summary = recon.summary && typeof recon.summary === 'object' ? recon.summary : {};
  const summaryKeys = Object.keys(summary).sort();
  const summaryParts = summaryKeys.map((k) => `${k}=${primitive(summary[k])}`).join(',');
  return `L${linesLen}|O${orphansLen}|S${scSize}|{${summaryParts}}`;
}

function unknownFingerprint(value: unknown): string {
  if (!value) return '';
  if (value instanceof Set) return setFingerprint(value);
  if (value instanceof Map) return mapFingerprint(value);
  if (Array.isArray(value)) return fingerprintArray(value, unknownFingerprint);
  if (typeof value === 'object') return hashString(stableStringify(value));
  return primitive(value);
}

function setFingerprint(value?: Set<unknown>): string {
  if (!value) return '';
  return fingerprintArray(Array.from(value).sort(), primitive);
}

function mapFingerprint(value?: Map<unknown, unknown>): string {
  if (!value) return '';
  return fingerprintArray(
    Array.from(value.entries()).sort(([a], [b]) => String(a).localeCompare(String(b))),
    ([key, entry]) => `${primitive(key)}=${unknownFingerprint(entry)}`,
  );
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return primitive(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value instanceof Set) return `Set(${Array.from(value).sort().map(stableStringify).join(',')})`;
  if (value instanceof Map) {
    return `Map(${Array.from(value.entries())
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
      .map(([key, entry]) => `${stableStringify(key)}:${stableStringify(entry)}`)
      .join(',')})`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${key}:${stableStringify(record[key])}`).join(',')}}`;
}

function hashString(value: string): string {
  let hash = 2_166_136_261;
  hash = foldHash(hash, value);
  return (hash >>> 0).toString(36);
}

function foldHash(seed: number, value: string): number {
  let hash = seed;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash;
}
