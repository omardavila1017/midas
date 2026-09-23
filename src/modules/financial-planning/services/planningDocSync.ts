/**
 * Sincronización entre las DOS superficies que editan los mismos seis
 * documentos de planeación (escenarios, propuestas, entradas manuales, custom
 * rows, cell overrides, change log).
 *
 * EL DEFECTO QUE CIERRA. `FinancialPlanningDashboard` y
 * `FinancialProjectionDashboard` mantienen cada uno su propia copia en
 * `useState`, cargada UNA sola vez al montar, y ambos escriben el ARREGLO
 * COMPLETO bajo las mismas llaves. `KeepAlivePanel` deja los dos montados en
 * cuanto se visitan, así que el segundo en escribir persiste su snapshot viejo
 * y BORRA lo que el otro acababa de guardar — sin error y sin aviso. No hacía
 * falta ni que el usuario editara en el segundo tablero: el efecto de
 * bootstrap de Planeación reescribe sus seis estados cada vez que cambia
 * `sourceBaseScenario`, y eso pasa en cada ola de rebuild del source.
 *
 * CÓMO SE CIERRA. Toda escritura pasa por `debouncedPersist`, que es el único
 * chokepoint: al persistir avisa por CustomEvent con la llave y el ORIGEN que
 * escribió. Cada tablero se suscribe y re-lee del espejo local sólo las llaves
 * que escribió ALGUIEN MÁS. El origen es lo que evita el ping-pong: sin él, un
 * tablero recargaría su propia escritura, eso crearía una identidad de arreglo
 * nueva, su efecto volvería a persistir, y los dos tableros se reenviarían el
 * mismo contenido para siempre.
 *
 * Mismo patrón que `TAX_STORE_CHANGED_EVENT` y `subscribeAccessChanged`: el
 * evento `storage` del navegador NO sirve aquí porque no se dispara en la
 * pestaña que escribió.
 *
 * Semántica al converger: gana el último que escribió, que es la que
 * localStorage ya tiene. Un tablero que recarga descarta lo que tuviera sin
 * persistir, pero esa ventana es de ~250 ms (`WINDOW_MS`) — infinitamente
 * preferible a borrar en silencio el trabajo del otro tablero.
 */

export const PLANNING_DOC_CHANGED_EVENT = 'midas.planning.docChanged';

/** Las seis llaves que ambos tableros escriben. */
export type PlanningDocKey =
  | 'planning.scenarios'
  | 'planning.adjustments'
  | 'planning.manualEntries'
  | 'planning.customRows'
  | 'planning.cellOverrides'
  | 'planning.changeLog';

export interface PlanningDocChangedDetail {
  key: string;
  /** Quién escribió. `undefined` = escritor sin identidad (no se suprime). */
  origin?: string;
}

let originCounter = 0;

/** Identidad estable por instancia de tablero. */
export function newPlanningDocOrigin(label: string): string {
  originCounter += 1;
  return `${label}#${originCounter}`;
}

export function notifyPlanningDocWritten(key: string, origin?: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent<PlanningDocChangedDetail>(PLANNING_DOC_CHANGED_EVENT, {
        detail: { key, origin },
      }),
    );
  } catch {
    /* best-effort: nunca romper una escritura por no poder avisar */
  }
}

/**
 * Escucha escrituras AJENAS. `handler` recibe la llave que cambió; el caller
 * decide qué recargar. Devuelve la función para desuscribirse.
 */
export function subscribePlanningDocs(
  origin: string,
  handler: (key: string) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<PlanningDocChangedDetail>).detail;
    if (!detail || typeof detail.key !== 'string') return;
    // Propia escritura: ignorar. Es lo que corta el ping-pong.
    if (detail.origin === origin) return;
    handler(detail.key);
  };
  window.addEventListener(PLANNING_DOC_CHANGED_EVENT, listener);
  return () => window.removeEventListener(PLANNING_DOC_CHANGED_EVENT, listener);
}
