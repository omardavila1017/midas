/**
 * Singleton para `providerDerivation.worker.ts`.
 *
 * `deriveProvidersFromJde` itera CXP (~334k) + compras (~332k) + pagos para
 * armar el catálogo de providers — corría en idle en main thread y agregaba un
 * spike post-boot que bloqueaba el tab switch. Mover al worker libera main.
 *
 * Mismo patrón que `sharedSourceWorker.ts`: una sola instancia de Worker
 * compartida (no duplicar memoria con pesados), fan-out a listeners por
 * jobId. Spawn lazy; null si Worker no está disponible (jsdom / SSR) —
 * caller debe hacer fallback sync.
 */

import type {
  ProviderDerivationWorkerRequest,
  ProviderDerivationWorkerResponse,
} from './providerDerivationWorkerTypes';

let sharedWorker: Worker | null = null;
let jobSeq = 0;
const listeners = new Set<(data: ProviderDerivationWorkerResponse) => void>();
/** Jobs posteados sin respuesta. Sin esto un `onerror` los cuelga para siempre. */
const inFlightJobIds = new Set<number>();

/**
 * Rechaza lo que quedo en vuelo cuando el worker muere. Sin esto el suscriptor
 * de `AppCore` --que filtra por `jobId`-- nunca recibe `result` ni `error`, asi
 * que su fallback sincrono JAMAS corre: `providers` se queda vacio/stale el
 * resto de la sesion, el catalogo de Proveedores sale en blanco y, peor,
 * Planeacion clasifica el egreso a la categoria equivocada porque
 * `setProviderCatalogForCategoryLookup` se quedo sin datos.
 *
 * Mismo trato que el hub hermano `sharedSourceWorker` (2026-08-07): esto solo
 * vuelve ALCANZABLE la rama `data.error` que el call site ya tenia.
 */
function failInFlightJobs(message: string): void {
  const failed = [...inFlightJobIds];
  inFlightJobIds.clear();
  for (const jobId of failed) {
    for (const listener of listeners) {
      try {
        listener({ jobId, error: message });
      } catch {
        /* un suscriptor no puede tumbar a los demas */
      }
    }
  }
}

export function getProviderDerivationWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (sharedWorker) return sharedWorker;
  try {
    const worker = new Worker(
      new URL('./providerDerivation.worker.ts', import.meta.url),
      { type: 'module' },
    );
    worker.onmessage = (event: MessageEvent<ProviderDerivationWorkerResponse>) => {
      inFlightJobIds.delete(event.data.jobId);
      for (const listener of listeners) listener(event.data);
    };
    worker.onerror = (event) => {
      // eslint-disable-next-line no-console
      console.warn('[providerDerivation] worker exception', event.message);
      // `terminate()` antes de soltar el singleton: un `onerror` no siempre
      // mata al worker, y dejarlo vivo y huerfano con su copia del bundle
      // mientras el proximo job levanta otro duplica el consumo que este
      // singleton existe para evitar.
      try {
        worker.terminate();
      } catch {
        /* ignore */
      }
      if (sharedWorker === worker) sharedWorker = null;
      failInFlightJobs(event.message || 'provider derivation worker failed');
    };
    sharedWorker = worker;
    return worker;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[providerDerivation] worker spawn failed', err);
    return null;
  }
}

export function nextProviderDerivationJobId(): number {
  return ++jobSeq;
}

export function subscribeProviderDerivationWorker(
  listener: (data: ProviderDerivationWorkerResponse) => void,
): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function postToProviderDerivationWorker(req: ProviderDerivationWorkerRequest): boolean {
  const worker = getProviderDerivationWorker();
  if (!worker) return false;
  try {
    worker.postMessage(req);
    inFlightJobIds.add(req.jobId);
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[providerDerivation] worker post failed', err);
    return false;
  }
}
