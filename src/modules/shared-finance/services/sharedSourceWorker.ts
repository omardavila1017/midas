/**
 * Shared singleton for `financialProjectionSource.worker.ts`.
 *
 * Background (2026-05-20): three components each spawned their own copy of the
 * source worker — FinancialProjectionDashboard, FinancialPlanningDashboard,
 * and the `useFinancialProjectionSource` hook used by TaxDashboard. When the
 * KeepAlive shell renders Planning + Projection at the same time and the user
 * has visited Tax, three live workers held duplicate copies of the heavy
 * source bundle during compute (~200MB peak each). Heap snapshot showed
 * `financialProjectionSource.worker.ts: 350 MB` while the main thread was
 * already past 2GB — the duplicate workers contributed the OOM headroom that
 * the grain-flip thrash finally exhausted.
 *
 * This module hosts the single worker instance plus a fan-out listener so
 * each caller still gets only its own jobs back (filtered by jobId).
 */

import type {
  FinancialProjectionSourceWorkerRequest,
  FinancialProjectionSourceWorkerResponse,
} from '../../../workers/financialProjectionSourceWorkerTypes';

let sharedWorker: Worker | null = null;
let sharedJobSeq = 0;
const sharedListeners = new Set<(data: FinancialProjectionSourceWorkerResponse) => void>();

/**
 * Republica en el hilo principal el diagnóstico del prorrateo Citi que viene
 * en el sobre del worker.
 *
 * El motor publica en `window.__midas__.citiProrrateo`, pero corre DENTRO del
 * worker, donde no hay `window` — así que esa clave quedaba vacía en producción
 * aunque la proyección ya hubiera corrido, justo la superficie que el aviso de
 * consola manda consultar cuando un (cía, mes) sale sin desglosar. Este es el
 * único punto por el que pasan las respuestas de los tres call sites
 * (Proyección, Planeación y el hook de Impuestos), así que republicar aquí las
 * cubre a las tres sin tocar ninguna.
 *
 * Best-effort y sin fallar nunca: es diagnóstico, no puede romper la entrega
 * del resultado a los suscriptores.
 */
function republishCitiDiagnostics(data: FinancialProjectionSourceWorkerResponse): void {
  if (!data.citiDiagnostics || data.citiDiagnostics.length === 0) return;
  try {
    const w = globalThis as unknown as { __midas__?: Record<string, unknown> };
    w.__midas__ = { ...(w.__midas__ ?? {}), citiProrrateo: data.citiDiagnostics };
  } catch {
    /* diagnóstico best-effort */
  }
}

/** Lazily spawn the singleton; returns `null` when `Worker` is unavailable. */
export function getSharedSourceWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (sharedWorker) return sharedWorker;
  try {
    const worker = new Worker(
      new URL('../../../workers/financialProjectionSource.worker.ts', import.meta.url),
      { type: 'module' },
    );
    worker.onmessage = (event: MessageEvent<FinancialProjectionSourceWorkerResponse>) => {
      republishCitiDiagnostics(event.data);
      for (const listener of sharedListeners) listener(event.data);
    };
    worker.onerror = (event) => {
      // eslint-disable-next-line no-console
      console.warn('[projection.source] shared worker exception', event.message);
    };
    sharedWorker = worker;
    return worker;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[projection.source] shared worker spawn failed', err);
    return null;
  }
}

/** Bump and return a unique jobId shared across all callsites. */
export function nextSourceJobId(): number {
  return ++sharedJobSeq;
}

/**
 * Subscribe to messages from the shared worker. Listener must filter by its
 * own jobId(s). Returns an unsubscribe function.
 */
export function subscribeSharedSourceWorker(
  listener: (data: FinancialProjectionSourceWorkerResponse) => void,
): () => void {
  sharedListeners.add(listener);
  return () => { sharedListeners.delete(listener); };
}

/** Post a request to the shared worker. Returns false if no worker available. */
export function postToSharedSourceWorker(req: FinancialProjectionSourceWorkerRequest): boolean {
  const worker = getSharedSourceWorker();
  if (!worker) return false;
  try {
    worker.postMessage(req);
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[projection.source] shared worker post failed', err);
    return false;
  }
}
