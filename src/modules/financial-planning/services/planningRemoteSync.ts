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
 */

import { batchGet, isRemoteStoreEnabled, putDoc } from '../../../services/remoteStore';
import { PLANNING_DOC_KEYS, PLANNING_LOCAL_KEY, type PlanningDocKey } from './planningStorageKeys';

const NS = 'planning' as const;

/** Write-through al store compartido. Fire-and-forget, best-effort, no-op si OFF. */
export function pushPlanningDoc(docKey: PlanningDocKey, value: unknown): void {
  if (!isRemoteStoreEnabled()) return;
  void putDoc(NS, docKey, value);
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
 * Baja los docs de planeación del store compartido al mirror local.
 * Devuelve `true` si algún valor local cambió (el caller debe recargar estado).
 * Si el server no tiene un doc todavía pero el local sí, lo SIEMBRA hacia arriba
 * (migración una vez del estado por-navegador previo).
 */
export async function hydratePlanningFromServer(): Promise<boolean> {
  if (!isRemoteStoreEnabled()) return false;
  const remote = await batchGet<unknown>(NS, [...PLANNING_DOC_KEYS]);
  let changed = false;
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
          }
        } else {
          const serialized = JSON.stringify(value);
          if (current !== serialized) {
            localStorage.setItem(localKey, serialized);
            changed = true;
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
  return changed;
}
