import type {
  FinancialProjectionSourceData,
  FinancialProjectionSourceInput,
} from './financialProjectionService';
import type { ScenarioForecastRun } from '../../financial-planning/services/scenarioForecastRun';
import { todayISO } from '../../../formatters';
import { BUILD_ID } from '../../../config/buildId';
// Las listas de campos + la serialización viven en un módulo hoja para que los
// guards de idempotencia de AppCore comparen EXACTAMENTE lo que la llave hashea.
import {
  CLIENT_CACHE_KEY_FIELDS,
  PROVIDER_CACHE_KEY_FIELDS,
  fields,
  primitive,
  stableStringify,
} from './projectionCacheFingerprint';

const DB_NAME = 'midas-financial-projection-cache';
const DB_VERSION = 1;
const STORE_NAME = 'entries';
const INDEX_KEY = 'midas.financialProjection.cache.index.v1';
// v2: client fingerprint expanded to cover `frequency`, `paymentDayName`,
// `commercialGroupId` patched by the JDE cobranza overlay.
// v3: la clave incorpora la versión de la app (ver ENGINE_VERSION).
// v4: "días en déficit" se mide sobre la curva diaria (antes por cierre de
// bucket, que a mensual reportaba 0) — cambia `summary` sin cambiar inputs.
// v5: la identidad del motor pasó de la versión de app (inerte en el deploy
// real) al hash del código, y el store se PURGA al cambiar de motor. Con esto
// un cambio de motor ya NO necesita un bump manual de esta constante — v4 fue
// el último que hizo falta.
const SCHEMA_VERSION = 5;
// Los valores persistidos son SALIDAS DEL MOTOR (movimientos ya prorrateados,
// corridas ya calculadas), pero la clave sólo describe los INPUTS. Un fix del
// motor que cambia el número sin cambiar el dato de origen (p.ej. el
// denominador del prorrateo Citi, PR #239) deja la entrada pre-fix vigente: el
// navegador computa bien al arrancar y vuelve al número viejo en cuanto esta
// cache resuelve.
//
// La identidad del motor es `BUILD_ID` = hash del código fuente del bundle.
// NO uses `APP_VERSION` aquí: se deriva del conteo de merges de git y el deploy
// real (`omardavila1017/midas`, rama `qa`) recibe los archivos por
// `rsync --exclude='.git'`, así que allá ese conteo es de otro repo y queda
// congelado — versionar por app version fue inerte en producción (PR #240).
// `BUILD_ID` cambia siempre que cambia el código y nunca depende de git.
const ENGINE_VERSION = `${SCHEMA_VERSION}:${BUILD_ID}`;
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
  /** Identidad del motor que produjo estas entradas (ver ENGINE_VERSION). */
  engineVersion?: string;
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
    // Las listas de campos viven en `projectionCacheFingerprint.ts` (con el
    // porqué de cada una) porque los guards de idempotencia de AppCore las
    // consumen para decidir si un recommit puede invalidar esta llave.
    `clients=${fingerprintArray(input.clients, (item) => fields(item, CLIENT_CACHE_KEY_FIELDS))}`,
    `providers=${fingerprintArray(input.providers, (item) => fields(item, PROVIDER_CACHE_KEY_FIELDS))}`,
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
    // Viajes Especiales: emite ingreso REAL (`cxc:especial:viaje:` fechado con
    // Fecha_Factura + Dias_Credito del API) y re-etiqueta los `cxc:` cruzados,
    // así que mueve el dinero de la proyección — no puede faltar en la llave.
    `viajes=${viajesEspecialesFingerprint(input.viajesEspecialesRecords)}`,
    `purchase=${fingerprintArray(input.purchaseReceipts ?? [], (item) => fields(item, ['cia', 'noProveedor', 'invoiceNo', 'purchaseOrderNo', 'receiptNo', 'estimatedDueDate', 'totalAmount', 'status', 'confidence']))}`,
    `payroll=${fingerprintArray(input.payrollCosts ?? [], (item) => fields(item, ['cia', 'year', 'month', 'paymentDate', 'payrollPeriod', 'conceptId', 'amount']))}`,
    // Reconciliation fingerprint: structural counts only. Serializing the full
    // AuxiliarReconResult (lines + bankOrphans + sourceConfirmation Map) builds
    // a ~25MB string and burns the main thread on boot (foldHash char-by-char).
    // Any real change to the recon output moves at least one summary counter,
    // a list length, or the sourceConfirmation size — same trade-off as the
    // cxp/cobranza/rol `len:` fingerprints above.
    `reconciliation=${reconciliationFingerprint(input.auxiliarReconciliation)}`,
    // Cruce PagoProveedor ↔ CARGO bancario: aporta la clasificación JDE del
    // proveedor al egreso histórico, así que MUEVE la salida (el bucket) y tiene
    // que estar en la llave — si no, una entrada construida antes de que el cruce
    // aterrizara (post-boot, asíncrono) se le sirve al tablero ya enriquecido y
    // el egreso vuelve a verse sin clasificar.
    `paymentCargo=${cargoEnrichmentFingerprint(input.paymentCargoEnrichments)}`,
    // Recibos de cobranza: descuentan el saldo por cobrar que `/cobranza`
    // reporta inflado, así que MUEVEN EL DINERO de la proyección. La longitud
    // NO alcanza como señal: el merge llavea por `cia::idPago`, de modo que un
    // recibo re-fetcheado puede ganar aplicaciones (o importe) sin cambiar el
    // conteo de pagos — y es justo el importe aplicado lo que decide cuánto se
    // descuenta. Por eso el fingerprint suma el `importeCobrado`.
    `cobranzaPagos=${cobranzaPaymentsFingerprint(input.cobranzaPayments)}`,
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
  stalePurgeDone = true;
  stalePurge = null;
  writeIndex({ schemaVersion: SCHEMA_VERSION, engineVersion: ENGINE_VERSION, entries: [] });
}

async function loadEntry<T>(key: string, kind: CacheKind): Promise<T | null> {
  purgeStaleEngineEntriesOnce();
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
  purgeStaleEngineEntriesOnce();
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
  if (stalePurge) await stalePurge;
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
  const empty: CacheIndex = { schemaVersion: SCHEMA_VERSION, engineVersion: ENGINE_VERSION, entries: [] };
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as CacheIndex;
    if (parsed?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.entries)) return empty;
    // Motor distinto → sus salidas no valen. La llave ya lo garantiza (un hash
    // distinto nunca empata), pero además así no se quedan pegadas en disco.
    if (parsed.engineVersion !== ENGINE_VERSION) return empty;
    return parsed;
  } catch {
    return empty;
  }
}

/**
 * Borra del disco lo que produjo un motor anterior. Corre UNA vez por sesión,
 * al primer uso de la cache. Es limpieza (la llave ya impide servirlas), pero
 * evita que las entradas envenenadas ocupen IDB para siempre y deja el estado
 * observable: tras un deploy, el store arranca vacío.
 */
let stalePurgeDone = false;
let stalePurge: Promise<void> | null = null;
function purgeStaleEngineEntriesOnce(): void {
  if (stalePurgeDone) return;
  stalePurgeDone = true;
  let staleFound = false;
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as CacheIndex;
    staleFound = parsed?.engineVersion !== ENGINE_VERSION || parsed?.schemaVersion !== SCHEMA_VERSION;
  } catch {
    staleFound = true;
  }
  if (!staleFound) return;
  writeIndex({ schemaVersion: SCHEMA_VERSION, engineVersion: ENGINE_VERSION, entries: [] });
  // Los writes de esta sesión esperan al borrado: si el `clear` corriera
  // después del primer `put`, se llevaría la entrada recién computada.
  stalePurge = clearIdbStore();
}

async function clearIdbStore(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
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
  writeIndex({ schemaVersion: SCHEMA_VERSION, engineVersion: ENGINE_VERSION, entries: [...sources, ...runs, ...forecasts] });
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

/**
 * Huella del cruce PagoProveedor ↔ CARGO bancario.
 *
 * `size` SOLO no sirve como señal del cruce: el motor de pagos cierra marcando
 * ORPHAN **todo** CARGO no asignado (`paymentReconciliationEngine`, pase final),
 * así que `map.size` es exactamente el número de CARGOs no-internos de los
 * estados de cuenta — una función de `bankStatements`, que esta misma llave ya
 * huellea aparte. Con `size` solo, el único cambio que movía la llave era la
 * transición 0 → N (el cruce aterrizando por primera vez): si después crecían
 * los `pagoProveedor` SIN que cambiaran los estados de cuenta (revalidación de
 * la ventana de pagos, delta de un día ya cacheado), subían los MATCHED, cambiaba
 * la clasificación del egreso histórico y la llave se quedaba quieta → IDB servía
 * la entrada vieja, menos clasificada. Es justo el modo de falla que el comentario
 * del call site dice cerrar.
 *
 * Se cuentan los MATCHED en un pase (~2-6 ms warm con 200k entradas; el walk que
 * este archivo evita costaba 100-300 ms porque construía string por item) y la
 * llave se computa un puñado de veces por sesión. No distingue "mismos MATCHED,
 * otro proveedor" — mismo trade-off estructural que `reconciliation` y los `len:`.
 */
function cargoEnrichmentFingerprint(
  map: FinancialProjectionSourceInput['paymentCargoEnrichments'],
): string {
  if (!map || map.size === 0) return '0';
  let matched = 0;
  for (const entry of map.values()) if (entry.status === 'MATCHED') matched++;
  return `${map.size}:${matched}`;
}

/**
 * Huella de Viajes Especiales.
 *
 * Dos contadores en UN pase, sin construir string por item (el walk que este
 * archivo evita a propósito): conteo total y cuántos traen factura.
 *
 * El conteo solo NO alcanza. La colección se upsertea por `kRenta`
 * (`AppCore`), así que un viaje re-fetcheado que YA se facturó **reemplaza al
 * anterior en sitio**: la longitud no se mueve pero `facturaJDE` pasa de vacío
 * a folio, y con eso cambia su bucket en `buildViajesEspecialesCobranzaCross`
 * (`withoutInvoice` → cruzado/unmatched) y la fecha con la que
 * `projectViajeEspecialDate` lo proyecta. El conteo cubre la otra mitad: los
 * viajes que entran o salen, incluido el backfill de años previos.
 *
 * Mismo trade-off estructural que `rol`/`cxp`/`cobranza` y que el cruce de
 * pagos: no distingue "mismos facturados, otro importe/fecha".
 */
function viajesEspecialesFingerprint(
  records: FinancialProjectionSourceInput['viajesEspecialesRecords'],
): string {
  if (!records || records.length === 0) return '0';
  let invoiced = 0;
  for (const r of records) if (r.facturaJDE) invoiced++;
  return `${records.length}:${invoiced}`;
}

/**
 * Recibos aplicados: pagos, aplicaciones y Σ importe cobrado, en UN pase y sin
 * construir un string por item (el walk que este archivo evita a propósito).
 *
 * La Σ es la parte load-bearing — es el numerador del descuento de
 * `effectivePendingAmount`. Mismo trade-off estructural que `reconciliation` y
 * los `len:`: no distingue "misma Σ, otro reparto entre folios".
 */
function cobranzaPaymentsFingerprint(
  payments: FinancialProjectionSourceInput['cobranzaPayments'],
): string {
  if (!payments || payments.length === 0) return '0';
  let applications = 0;
  let cobrado = 0;
  for (const payment of payments) {
    for (const application of payment.applications ?? []) {
      applications++;
      const amount = application.importeCobrado;
      if (Number.isFinite(amount)) cobrado += amount;
    }
  }
  return `${payments.length}:${applications}:${cobrado.toFixed(2)}`;
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
