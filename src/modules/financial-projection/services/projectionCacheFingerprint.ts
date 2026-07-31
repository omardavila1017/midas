/**
 * Primitivas de fingerprint + las listas de campos que la llave del cache de
 * proyección (`projectionSourcePersistentCacheKey`) hashea por cada `Provider`
 * y por cada `Client`.
 *
 * Vive en su propio módulo HOJA (sin IDB, sin imports pesados) por dos razones:
 *
 * 1. **Una sola fuente de verdad.** Los guards de idempotencia de `AppCore`
 *    ("no re-commitees estado cuyo contenido no cambió") tienen que comparar
 *    EXACTAMENTE los campos que mueven la llave; si la lista se duplicara,
 *    agregar un campo a la llave dejaría la comparación desincronizada en
 *    silencio y el guard empezaría a tragarse cambios reales.
 * 2. **Bundle.** `AppCore` es eager; el módulo del cache persistente arrastra
 *    IndexedDB + los tipos del motor y vive en los chunks lazy de los tableros.
 */

/**
 * Campos de `Provider` que entran a la llave. `montoPromedioPago` /
 * `gastoMinimoMensual` los parcha `enrichProvidersWithRecentSpend` en runtime
 * sin tocar `lastUpdatedAt`, así que van explícitos.
 */
export const PROVIDER_CACHE_KEY_FIELDS = [
  'id',
  'name',
  'type',
  'risk',
  'flexibility',
  'paymentPeriod',
  'score',
  'clasificacionAlberto',
  'montoPromedioPago',
  'gastoMinimoMensual',
  'lastUpdatedAt',
] as const;

/**
 * Campos de `Client` que entran a la llave. `frequency` / `paymentDayName` /
 * `commercialGroupId` los parcha `recomputeClientCreditDaysFromCobranza`
 * (overlay JDE 2026-05-19) — sin ellos el cache servía proyecciones stale.
 * `updatedAt` no existe en `Client` (siempre undefined → sin señal).
 */
export const CLIENT_CACHE_KEY_FIELDS = [
  'id',
  'name',
  'paymentDay',
  'paymentDayName',
  'creditDays',
  'frequency',
  'commercialGroupId',
] as const;

export function fields(value: unknown, keys: readonly string[]): string {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return keys.map((key) => `${key}=${primitive(record[key])}`).join(',');
}

export function primitive(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  return stableStringify(value);
}

export function stableStringify(value: unknown): string {
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

/**
 * `true` cuando ninguna de las dos listas mueve la llave del cache: mismo
 * largo, mismo orden y mismos valores en `keys`. Es la pregunta exacta que
 * necesita un guard de idempotencia — "¿re-commitear esto invalidaría la
 * proyección?" — y NO una igualdad profunda: dos elementos con los campos de
 * la llave iguales pero distintos en un campo fuera de ella cuentan como
 * "iguales" a propósito (ese cambio no puede alterar el resultado del motor).
 */
export function sameByCacheKeyFields<T>(
  prev: readonly T[] | undefined,
  next: readonly T[],
  keys: readonly string[],
): boolean {
  if (prev === next) return true;
  if (!prev || prev.length !== next.length) return false;
  for (let i = 0; i < next.length; i++) {
    if (fields(prev[i], keys) !== fields(next[i], keys)) return false;
  }
  return true;
}
