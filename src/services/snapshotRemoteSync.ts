/**
 * Cliente SOLO-LECTURA del snapshot compartido JDE/TRESS (namespace `cache`).
 *
 * Por qué existe: hoy cada navegador reconstruye ~2 años de datos JDE/TRESS con
 * ~5,000–7,000 requests (~60s c/u), y `clearCacheStorageOnEntry` borra el cache en
 * cada ingreso → todo boot es un boot frío de varios minutos. Peor: al reconstruir
 * cada navegador por su cuenta, derivan entre sí (días vacíos envenenados, OCs con
 * estado stale) — el motivo por el que "localStorage no funcionaba".
 *
 * La solución: un servidor arma el dataset UNA vez y publica un snapshot; cada
 * navegador DESCARGA el MISMO snapshot ya armado (segundos, no miles de llamadas a
 * JDE). Como el snapshot es server-fed, escritor único y atómico → cero deriva.
 *
 * REGLA DE ORO (heredada de la reversión de `cacheRemoteSync`, commit 3e71685): el
 * cliente NUNCA escribe el cache compartido. Este módulo SÓLO llama `getDoc` — nunca
 * `putDoc`/`deleteDoc`. La deriva del intento previo venía de MUCHOS navegadores
 * escribiendo DÍAS PARCIALES individuales; aquí el snapshot lo escribe un builder
 * único, completo y versionado atómicamente, y los clientes sólo leen.
 *
 * Contrato (namespace `cache` de remoteStore / api/store):
 *   GET /api/store/cache/snapshot.current                      → SnapshotPointer | 404
 *   GET /api/store/cache/snapshot.{version}.{collection}.{i}   → { value: Record[] }
 * El pointer es la primitiva de atomicidad: el builder escribe todos los shards de
 * la versión V y DESPUÉS voltea `snapshot.current` a V, así que un navegador sólo
 * descubre versiones cuyos shards ya existen (los snapshots a medio armar viven bajo
 * una versión aún no referenciada → invisibles).
 *
 * Modelo: se hidrata a IDB (via los writers existentes de heavyStoreIDB) ANTES de
 * soltar el gate `cacheCleared` del boot, así el resto del arranque (loadLightStore,
 * hydrateDataset, auto-fetch delta) no cambia — ve un IDB caliente y sólo pide el
 * delta reciente. BEST-EFFORT: si el store está apagado o no responde, todo es no-op
 * y el caller cae al clear-on-entry de hoy.
 */

import { getDoc, isRemoteStoreEnabled } from './remoteStore';
import {
  BANK_JDE_IDB_KEY,
  HEAVY_KEYS,
  type HeavyKey,
  saveHeavyRecords,
  saveBankJdeStatementsToIDB,
} from './heavyStoreIDB';

const NS = 'cache' as const;
const POINTER_KEY = 'snapshot.current';
/** Marker local: versión del snapshot ya materializada en IDB. Registrado en
 * storageRegistry.ts. Si coincide con `pointer.version` no se re-descarga. */
export const SNAPSHOT_VERSION_KEY = 'midas.snapshot.version';
/** Lecturas de shard concurrentes. Acota el paralelismo total de descarga sin
 * saturar el proxy same-origin. */
const SHARD_CONCURRENCY = 6;

/** Colecciones que el snapshot puede traer: las 10 heavy + estados de cuenta JDE.
 * Los nombres son EXACTAMENTE las keys de IDB → mapeo 1:1 a los writers, sin tabla
 * de traducción. `bankSupplementalStatements` NUNCA está aquí (cargas manuales). */
export type SnapshotCollectionKey = HeavyKey | typeof BANK_JDE_IDB_KEY;

const SNAPSHOT_COLLECTION_KEYS: readonly SnapshotCollectionKey[] = [
  ...HEAVY_KEYS,
  BANK_JDE_IDB_KEY,
];

export interface SnapshotCollectionMeta {
  /** Número de shards de la colección. 0 = sin dato en el snapshot. */
  shardCount: number;
  /** Total de registros (informativo / validación). */
  total: number;
}

export interface SnapshotPointer {
  /** Identificador opaco y monotónico de la versión (lo genera el builder). */
  version: string;
  /** ISO del build (fecha de corte del dato — el delta del cliente arranca de aquí). */
  builtAt: string;
  /** Versión del esquema del snapshot (para futura evolución). */
  schema: number;
  collections: Partial<Record<SnapshotCollectionKey, SnapshotCollectionMeta>>;
}

export interface SnapshotHydrationResult {
  /** Colecciones escritas a IDB con éxito (todos sus shards bajaron). */
  hydrated: SnapshotCollectionKey[];
  /** Colecciones cuyo download falló parcialmente → NO escritas (queda el IDB previo). */
  failed: SnapshotCollectionKey[];
  builtAt: string;
}

/**
 * ¿El path del snapshot está activo? Requiere el store encendido (sin él el proxy
 * `/api/store` no existe). `VITE_SNAPSHOT_ENABLED='false'` lo apaga de forma
 * INDEPENDIENTE (sin desactivar la sync de planeación) — palanca de rollback.
 * Default cuando el store está ON: activo.
 */
export function isSnapshotEnabled(): boolean {
  if (!isRemoteStoreEnabled()) return false;
  return (import.meta.env.VITE_SNAPSHOT_ENABLED as string | undefined) !== 'false';
}

function isValidPointer(value: unknown): value is SnapshotPointer {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.version === 'string' &&
    p.version.length > 0 &&
    typeof p.collections === 'object' &&
    p.collections != null
  );
}

/** Lee el pointer del snapshot activo. `null` = apagado, sin snapshot (404) o fallo. */
export async function getSnapshotPointer(): Promise<SnapshotPointer | null> {
  if (!isSnapshotEnabled()) return null;
  const doc = await getDoc<unknown>(NS, POINTER_KEY);
  if (!doc || !isValidPointer(doc.value)) return null;
  const p = doc.value;
  return {
    version: p.version,
    builtAt: typeof p.builtAt === 'string' ? p.builtAt : '',
    schema: typeof p.schema === 'number' ? p.schema : 1,
    collections: p.collections,
  };
}

/** Versión del snapshot ya materializada en IDB (marker local). */
export function getLocalSnapshotVersion(): string | null {
  try {
    return localStorage.getItem(SNAPSHOT_VERSION_KEY);
  } catch {
    return null;
  }
}

function setLocalSnapshotVersion(version: string): void {
  try {
    localStorage.setItem(SNAPSHOT_VERSION_KEY, version);
  } catch {
    /* best-effort */
  }
}

function shardKey(version: string, collection: SnapshotCollectionKey, index: number): string {
  return `snapshot.${version}.${collection}.${index}`;
}

/** Corre `task` sobre `items` con un tope de `limit` en vuelo. Preserva orden. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await task(items[i], i);
    }
  };
  const pool = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(pool);
  return results;
}

function writeCollection(collection: SnapshotCollectionKey, records: unknown[]): Promise<void> {
  // El nombre de colección ES la key de IDB → mapeo directo. Los estados de cuenta
  // JDE viven fuera de HEAVY_KEYS (los maneja App.tsx) → writer dedicado.
  if (collection === BANK_JDE_IDB_KEY) return saveBankJdeStatementsToIDB(records);
  return saveHeavyRecords(collection as HeavyKey, records);
}

/**
 * Descarga el snapshot y lo materializa a IDB con los writers existentes.
 *
 * Reglas:
 *   • TODO-O-NADA por colección: sólo se escribe una colección si TODOS sus shards
 *     bajaron OK. Una colección con un shard faltante se salta (queda el IDB previo;
 *     el delta JDE la completa) — nunca se pisa dato bueno con un snapshot parcial.
 *   • Colección con `shardCount === 0` se salta (sin dato en el snapshot; anti-wipe,
 *     espejo del per-key de `saveHeavyStore`).
 *   • Sólo escribe HEAVY_KEYS + bankJdeStatements. NUNCA `bankSupplementalStatements`
 *     (cargas manuales), localStorage, planeación, ni trabajo del usuario (Clase B).
 *   • El marker `midas.snapshot.version` se escribe SÓLO si NINGUNA colección falló,
 *     para que un boot posterior de la misma versión salte la re-descarga.
 */
export async function hydrateHeavyStoreFromSnapshot(
  pointer: SnapshotPointer,
): Promise<SnapshotHydrationResult> {
  const hydrated: SnapshotCollectionKey[] = [];
  const failed: SnapshotCollectionKey[] = [];

  // Sólo colecciones conocidas con al menos un shard. El orden es estable
  // (SNAPSHOT_COLLECTION_KEYS) para que el log sea determinista.
  const toFetch = SNAPSHOT_COLLECTION_KEYS.filter((c) => {
    const meta = pointer.collections[c];
    return meta != null && meta.shardCount > 0;
  });

  for (const collection of toFetch) {
    const meta = pointer.collections[collection]!;
    const indices = Array.from({ length: meta.shardCount }, (_, i) => i);
    const shards = await mapWithConcurrency(indices, SHARD_CONCURRENCY, async (i) => {
      const doc = await getDoc<unknown[]>(NS, shardKey(pointer.version, collection, i));
      return doc && Array.isArray(doc.value) ? doc.value : null;
    });
    if (shards.some((s) => s === null)) {
      failed.push(collection);
      // eslint-disable-next-line no-console
      console.warn(`[snapshot] ${collection}: shard faltante — se conserva el IDB previo`);
      continue;
    }
    const records: unknown[] = [];
    for (const shard of shards) for (const rec of shard!) records.push(rec);
    await writeCollection(collection, records);
    hydrated.push(collection);
    // eslint-disable-next-line no-console
    console.info(`[snapshot] ${collection}: ${records.length} registros hidratados desde el snapshot`);
  }

  if (failed.length === 0) setLocalSnapshotVersion(pointer.version);
  // eslint-disable-next-line no-console
  console.info(
    `[snapshot] hidratación · version=${pointer.version} · builtAt=${pointer.builtAt} · ` +
      `hidratadas=${hydrated.length} · fallidas=${failed.length}`,
  );
  return { hydrated, failed, builtAt: pointer.builtAt };
}
