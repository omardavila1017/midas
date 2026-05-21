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

export function getProviderDerivationWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (sharedWorker) return sharedWorker;
  try {
    const worker = new Worker(
      new URL('./providerDerivation.worker.ts', import.meta.url),
      { type: 'module' },
    );
    worker.onmessage = (event: MessageEvent<ProviderDerivationWorkerResponse>) => {
      for (const listener of listeners) listener(event.data);
    };
    worker.onerror = (event) => {
      // eslint-disable-next-line no-console
      console.warn('[providerDerivation] worker exception', event.message);
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
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[providerDerivation] worker post failed', err);
    return false;
  }
}
