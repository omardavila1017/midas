/**
 * Lightweight LRU cache for ScenarioRun objects so the dashboard can switch
 * between scenarios, comparison targets and granularities without re-running
 * the full pipeline each time. Keys are stable strings derived from the
 * inputs that actually influence a run (scenario id, granularity, content
 * fingerprints of overrides / adjustments / movements). The cache only lives
 * for the lifetime of the React tree — it's deliberately a module-level
 * Map. NOTE: a module-level Map is NOT freed when the dashboard unmounts
 * (the module stays loaded for the whole SPA session), so callers that
 * unmount must call clearProjectionRunCache() to release the retained
 * runs — otherwise MAX_ENTRIES fat PlanningScenarioRun objects (each
 * holding the full post-pipeline movements array) stay pinned for the
 * whole session and the renderer eventually OOMs (Chrome "Aw Snap"
 * code 5). Capacity is intentionally small: the real access pattern is
 * active/base/approved × at most a couple of granularities.
 */

// History: 8 → 4 → 2 (cold-boot OOM) → 3 (grain-flip thrash) → 4 (2026-05-20,
// base recompute on each flip). User flips mes→sem→día rapidly and also
// renders the base comparison line. cacheKey includes granularity AND
// scenarioId, so active × 3 grans + base@current-grain = 4 unique keys hot
// at any moment. With LIMIT=3 the base recomputed on every flip; with =4 the
// base@current also fits. 4 × ~70MB = ~280MB cache budget, well under the
// post-fix 1.5GB steady-state heap.
const MAX_ENTRIES = 4;

class LRU<K, V> {
  private map = new Map<K, V>();

  constructor(private readonly capacity: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Refresh insertion order so frequently-used entries stay warm.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K | undefined;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

export const projectionRunCache = new LRU<string, unknown>(MAX_ENTRIES);

// Release every retained run. Call this when the owning React tree unmounts
// (e.g. user navigates away from Planning) so the fat movements/buckets arrays
// become GC-eligible instead of staying pinned for the whole SPA session.
// También se invoca desde el handler de memory-pressure de runtimeGuardian
// (registrado en el effect de los dashboards — NO en module init, porque
// este archivo se importa desde sharedSourceWorker y los worker bundles no
// admiten code-splitting con dynamic imports).
export function clearProjectionRunCache(): void {
  projectionRunCache.clear();
}

export function primeProjectionRunCache<T>(key: string, value: T): void {
  projectionRunCache.set(key, value as unknown);
}

export function cachedRun<T>(key: string, build: () => T): T {
  const cached = projectionRunCache.get(key) as T | undefined;
  if (cached !== undefined) return cached;
  const fresh = build();
  projectionRunCache.set(key, fresh as unknown);
  return fresh;
}

export function fingerprintArray<T>(items: readonly T[], pick: (item: T) => string | number | undefined): string {
  if (items.length === 0) return '0';
  // Cheap fingerprint: length + xor-style folded hash of selected keys. Avoids
  // JSON.stringify which is hot-path expensive for thousands of movements.
  let hash = items.length;
  for (let i = 0; i < items.length; i++) {
    const value = pick(items[i]);
    if (value === undefined) continue;
    const s = String(value);
    for (let j = 0; j < s.length; j++) {
      hash = ((hash << 5) - hash + s.charCodeAt(j)) | 0;
    }
  }
  return `${items.length}:${hash}`;
}
