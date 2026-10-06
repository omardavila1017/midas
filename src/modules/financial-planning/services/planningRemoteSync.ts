/**
 * Server-side sync for financial-planning data (escenarios, propuestas, cell
 * overrides, custom rows, manual entries, change log).
 *
 * Modelo: LOCAL-FIRST con write-through + hidratación una vez al montar.
 *   • Render instantáneo: el dashboard sigue inicializando su estado desde
 *     localStorage (sin cambios), así que el primer paint es idéntico a hoy.
 *   • Write-through: cada `save*` llama `pushPlanningDoc` (fire-and-forget) para
 *     que el store compartido reciba la copia — así otro navegador la ve.
 *   • Hidratación: al montar, `hydratePlanningFromServer` baja los docs del
 *     store, los escribe al mirror local y avisa al dashboard para recargar.
 *     Si el store está apagado o no responde, todo es no-op (best-effort).
 *
 * Keying: GLOBAL / compartido por toda la organización (un solo workspace de
 * planeación). Ese es justamente el punto del cambio — que todos vean lo mismo.
 * Los records ya cargan `createdBy`/`createdAt` para atribución.
 *
 * ORDEN (load-bearing): NADA sube al servidor hasta que esta sesión lo LEYÓ.
 * Los dos tableros persisten sus seis documentos al montar, y eso ocurre antes
 * de que la hidratación responda: sin la compuerta, un navegador con datos
 * viejos pisaba el trabajo de toda la organización en cada arranque. Si la
 * lectura falla, la compuerta sigue cerrada (el espejo local se conserva y se
 * reintenta en la siguiente escritura, a lo más una vez por minuto) — nunca se
 * siembra a ciegas.
 *
 * Límite conocido: sin versión ni `updatedAt` por documento, el servidor GANA
 * al arrancar, así que lo capturado mientras el store no respondía se pierde al
 * siguiente arranque si el servidor ya tenía ese documento. Cerrarlo pide que
 * el contrato del store exponga `updatedAt` (pendiente de la BD de escenarios).
 */

import { batchGet, isRemoteStoreEnabled, putDoc } from '../../../services/remoteStore';
import { notifyPlanningDocWritten } from './planningDocSync';
import { PLANNING_DOC_KEYS, PLANNING_LOCAL_KEY, type PlanningDocKey } from './planningStorageKeys';

const NS = 'planning' as const;
/** Origen de las escrituras que vienen del servidor (ningún tablero lo usa). */
const REMOTE_ORIGIN = 'remote-store';

let hydrated = false;
let hydrating: Promise<boolean> | null = null;
/** Tras una lectura fallida, no reintentar más de una vez por minuto. */
const RETRY_AFTER_FAILURE_MS = 60_000;
let lastFailureAt = 0;

/**
 * Write-through al store compartido. Fire-and-forget, best-effort, no-op si
 * OFF. Antes de que esta sesión haya leído el servidor NO publica nada (ver
 * ORDEN arriba): lo escrito sigue en el espejo local, y la hidratación lo
 * siembra si el servidor no tiene ese documento.
 */
export function pushPlanningDoc(docKey: PlanningDocKey, value: unknown): void {
  if (!isRemoteStoreEnabled()) return;
  if (!hydrated) {
    void hydratePlanningFromServer().catch(() => {});
    return;
  }
  void putDoc(NS, docKey, value);
}

/** Sólo para tests: vuelve a la compuerta cerrada de un arranque nuevo. */
export function __resetPlanningRemoteSyncForTests(): void {
  hydrated = false;
  hydrating = null;
  lastFailureAt = 0;
}

function isEmptyDoc(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

/**
 * Desenvuelve el sobre `{ value, updatedAt }` si el upstream lo usa. `getDoc`
 * (remoteStore) ya es tolerante a los dos shapes; `batchGet` devuelve el valor
 * crudo, así que esta ruta tenía que serlo también: sin esto se escribía el
 * OBJETO ENVOLVENTE al espejo local, los seis loaders veían un no-arreglo,
 * devolvían `[]` y los tableros persistían ese `[]` encima — el trabajo del
 * usuario, borrado por un detalle de shape.
 */
function unwrapDoc(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in (value as Record<string, unknown>)) {
    return (value as { value: unknown }).value;
  }
  return value;
}

/**
 * Baja los docs de planeación del store compartido al mirror local, UNA vez por
 * sesión (llamadas concurrentes comparten la misma lectura). Devuelve `true` si
 * algún valor local cambió; además avisa por `planningDocSync` cada llave que
 * cambió, así los dos tableros recargan sólo eso y sin devolver el eco.
 * Si el server no tiene un doc todavía pero el local sí, lo SIEMBRA hacia arriba
 * (migración una vez del estado por-navegador previo). Si la lectura FALLA no
 * siembra nada y la compuerta del write-through sigue cerrada.
 */
export function hydratePlanningFromServer(): Promise<boolean> {
  if (!isRemoteStoreEnabled() || hydrated) return Promise.resolve(false);
  if (!hydrating && Date.now() - lastFailureAt < RETRY_AFTER_FAILURE_MS) return Promise.resolve(false);
  if (!hydrating) {
    hydrating = runHydration().finally(() => {
      hydrating = null;
    });
  }
  return hydrating;
}

async function runHydration(): Promise<boolean> {
  const remote = await batchGet<unknown>(NS, [...PLANNING_DOC_KEYS]);
  // Fallo de lectura ≠ "el servidor no tiene el doc": no se siembra nada.
  if (remote === null) {
    lastFailureAt = Date.now();
    return false;
  }
  let changed = false;
  const changedKeys: PlanningDocKey[] = [];
  for (const docKey of PLANNING_DOC_KEYS) {
    const localKey = PLANNING_LOCAL_KEY[docKey];
    // `null` presente = el server NO tiene el doc (semántica habitual de un
    // batch-get), no "el doc está vacío". Tratarlo como vacío BORRABA el
    // espejo local en vez de sembrarlo hacia arriba.
    const rawRemote = (remote as Record<string, unknown>)[docKey];
    if (docKey in remote && rawRemote != null) {
      const value = unwrapDoc(rawRemote);
      try {
        const current = localStorage.getItem(localKey);
        if (isEmptyDoc(value)) {
          if (current !== null) {
            localStorage.removeItem(localKey);
            changed = true;
            changedKeys.push(docKey);
          }
        } else {
          const serialized = JSON.stringify(value);
          if (current !== serialized) {
            localStorage.setItem(localKey, serialized);
            changed = true;
            changedKeys.push(docKey);
          }
        }
      } catch {
        /* best-effort */
      }
    } else {
      // Server sin doc → siembra desde el local (migración del estado previo).
      try {
        const current = localStorage.getItem(localKey);
        if (current) void putDoc(NS, docKey, JSON.parse(current));
      } catch {
        /* best-effort */
      }
    }
  }
  hydrated = true;
  for (const docKey of changedKeys) notifyPlanningDocWritten(`planning.${docKey}`, REMOTE_ORIGIN);
  return changed;
}
