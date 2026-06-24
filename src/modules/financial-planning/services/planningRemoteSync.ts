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
  return value == null || (Array.isArray(value) && value.length === 0);
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
    if (docKey in remote) {
      const value = (remote as Record<string, unknown>)[docKey];
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
