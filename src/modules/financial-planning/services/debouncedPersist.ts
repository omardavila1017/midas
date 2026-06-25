/**
 * debouncedPersist — wrapper para escrituras de localStorage que se disparan
 * en cada cambio de estado del editor (cellOverrides, customRows, manualEntries,
 * scenarios, adjustments, changeLog).
 *
 * Por qué existe: los `useEffect` que persisten estos arrays corren en CADA
 * tick de React. En sesiones largas con muchas ediciones cada commit hace
 * JSON.stringify + setItem de un array potencialmente grande (cientos de
 * overrides + scenarios). Eso:
 *   • Bloquea el main thread (serialización síncrona, varios MB).
 *   • Acumula presión sobre la cuota de localStorage (~5MB total).
 *   • En Edge se ha visto causar input lag perceptible.
 *
 * Estrategia: leading-edge + trailing-edge. La PRIMERA escritura para un key
 * se hace inmediata (mantiene la UX responsiva y los tests que leen
 * localStorage sin esperar). Escrituras subsecuentes dentro de la ventana de
 * `WINDOW_MS` se coalescen — solo el último valor queda programado para
 * persistir cuando expire la ventana. Esto reduce ráfagas de ediciones
 * rápidas (10 saves/s) a 1 leading + 1 trailing por ventana (~3 saves/s
 * efectivos) sin perder la última edición.
 *
 * También flushamos en `beforeunload`/`pagehide`/`visibilitychange→hidden`
 * para no perder writes pendientes.
 *
 * NO cambia el contrato — el caller sigue llamando `saveX(value)`. Solo
 * difiere el efecto secundario de saves rápidos.
 */

interface DebouncedEntry {
  lastFiredAt: number;
  scheduledId: number | null;
  pendingValue: unknown;
  doSave: (value: unknown) => void;
}

// Ventana corta — suficiente para colapsar ráfagas (typing rápido, edit cell
// → propuesta apply chain) sin postergar mucho la escritura efectiva.
const WINDOW_MS = 250;

const entries = new Map<string, DebouncedEntry>();
let unloadHooked = false;

function flushOne(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  if (entry.scheduledId !== null && typeof window !== 'undefined') {
    window.clearTimeout(entry.scheduledId);
  }
  entry.scheduledId = null;
  try { entry.doSave(entry.pendingValue); } catch { /* swallow */ }
  entry.lastFiredAt = Date.now();
}

function ensureUnloadHook(): void {
  if (unloadHooked) return;
  if (typeof window === 'undefined') return;
  unloadHooked = true;
  const flushAll = () => {
    for (const key of Array.from(entries.keys())) {
      const entry = entries.get(key);
      if (!entry || entry.scheduledId === null) continue;
      try {
        window.clearTimeout(entry.scheduledId);
        entry.scheduledId = null;
        entry.doSave(entry.pendingValue);
      } catch {
        /* never block unload */
      }
    }
  };
  window.addEventListener('beforeunload', flushAll);
  window.addEventListener('pagehide', flushAll);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAll();
  });
}

/**
 * Persistencia coalescida por `key`. Leading + trailing:
 *   • Primera llamada en una ventana fría → escribe sync.
 *   • Llamadas dentro de la ventana → solo memoizan el último valor.
 *   • Al expirar la ventana, persiste el último valor pendiente (si lo hay).
 */
export function debouncedPersist<T>(
  key: string,
  value: T,
  doSave: (value: T) => void,
): void {
  if (typeof window === 'undefined') {
    // SSR / jsdom sin window — persiste sync.
    try { doSave(value); } catch { /* ignore */ }
    return;
  }
  ensureUnloadHook();
  const wrapped = (v: unknown) => doSave(v as T);
  const now = Date.now();
  const existing = entries.get(key);
  if (!existing) {
    // Leading-edge: primera escritura es síncrona. Mantiene UX inmediata y
    // compatibilidad con tests que leen localStorage justo después del action.
    const entry: DebouncedEntry = {
      lastFiredAt: now,
      scheduledId: null,
      pendingValue: value,
      doSave: wrapped,
    };
    entries.set(key, entry);
    try { wrapped(value); } catch { /* swallow */ }
    return;
  }
  existing.pendingValue = value;
  existing.doSave = wrapped;
  const elapsed = now - existing.lastFiredAt;
  if (elapsed >= WINDOW_MS) {
    // Fuera de ventana — fire inmediato y reset.
    flushOne(key);
    return;
  }
  // Dentro de ventana — programa trailing-edge si no hay ya uno.
  if (existing.scheduledId !== null) return;
  const remaining = Math.max(0, WINDOW_MS - elapsed);
  existing.scheduledId = window.setTimeout(() => flushOne(key), remaining);
}

/**
 * Cancela timers pendientes y limpia TODO el estado de debounce SIN escribir
 * los valores pendientes (a diferencia de `flushDebouncedPersist`, que sí los
 * persiste). Pensado para aislamiento de tests: cada `debouncedPersist` fuera
 * de ventana programa un `setTimeout` trailing; si un test corre con
 * `vi.useFakeTimers({ toFake: ['Date'] })` (Date congelado pero `setTimeout`
 * real), ese timer puede dispararse DURANTE el siguiente test y sobrescribir su
 * localStorage con un valor obsoleto. Llamar esto en `afterEach` descarta esos
 * timers y vacía el mapa para que ningún estado cruce la frontera del test.
 */
export function resetDebouncedPersist(): void {
  if (typeof window !== 'undefined') {
    for (const entry of entries.values()) {
      if (entry.scheduledId !== null) window.clearTimeout(entry.scheduledId);
    }
  }
  entries.clear();
}

/**
 * Fuerza la escritura pendiente de un key (si la hay). Útil para tests o
 * para flushes manuales antes de cambios destructivos (logout, resets).
 */
export function flushDebouncedPersist(key?: string): void {
  if (typeof window === 'undefined') return;
  if (key) {
    flushOne(key);
    return;
  }
  for (const k of Array.from(entries.keys())) {
    flushOne(k);
  }
}
