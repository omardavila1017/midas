import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderDerivationWorkerResponse } from './providerDerivationWorkerTypes';

/**
 * Un `onerror` que sólo loguea deja el job colgado PARA SIEMPRE: el suscriptor
 * de `AppCore` filtra por `jobId` y nunca recibe `result` ni `error`, así que
 * su fallback síncrono jamás corre. Peor, el singleton muerto sigue cacheado y
 * `post` devuelve `true` para todo job posterior — `providers` se queda vacío
 * el resto de la sesión. Causas naturales en este deploy: el chunk del worker
 * que no carga tras un redeploy con la pestaña abierta, y el OOM del renderer.
 */

class FakeWorker {
  static last: FakeWorker | null = null;
  static spawned = 0;
  onmessage: ((event: MessageEvent<ProviderDerivationWorkerResponse>) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;
  constructor() { FakeWorker.last = this; FakeWorker.spawned += 1; }
  postMessage(msg: unknown) { this.posted.push(msg); }
  terminate() { this.terminated = true; }
}

async function loadHub() {
  vi.resetModules(); // el singleton vive a nivel módulo
  return import('./sharedProviderDerivationWorker');
}

const req = (jobId: number) => ({
  jobId,
  agedBalanceRecords: [],
  comprasRecords: [],
  pagoProveedorRecords: [],
});

describe('sharedProviderDerivationWorker — recuperación ante onerror', () => {
  beforeEach(() => {
    FakeWorker.last = null;
    FakeWorker.spawned = 0;
    (globalThis as unknown as { Worker?: unknown }).Worker = FakeWorker;
  });

  afterEach(() => {
    delete (globalThis as unknown as { Worker?: unknown }).Worker;
  });

  it('falla los jobs en vuelo para que el call site pueda caer al fallback', async () => {
    const hub = await loadHub();
    const seen: ProviderDerivationWorkerResponse[] = [];
    hub.subscribeProviderDerivationWorker((d) => seen.push(d));
    expect(hub.postToProviderDerivationWorker(req(7))).toBe(true);

    FakeWorker.last!.onerror!({ message: 'chunk load failed' });

    expect(seen).toEqual([{ jobId: 7, error: 'chunk load failed' }]);
  });

  it('termina el worker muerto y el siguiente job levanta otro', async () => {
    const hub = await loadHub();
    hub.postToProviderDerivationWorker(req(1));
    const dead = FakeWorker.last!;

    dead.onerror!({ message: 'boom' });

    expect(dead.terminated).toBe(true);
    hub.postToProviderDerivationWorker(req(2));
    expect(FakeWorker.spawned).toBe(2);
    expect(FakeWorker.last).not.toBe(dead);
  });

  /**
   * Pinea la invariante en la otra dirección: un error posterior no puede
   * convertir en fallo un job que ya entregó resultado.
   */
  it('no re-notifica un job que ya respondió', async () => {
    const hub = await loadHub();
    const seen: ProviderDerivationWorkerResponse[] = [];
    hub.subscribeProviderDerivationWorker((d) => seen.push(d));
    hub.postToProviderDerivationWorker(req(3));

    FakeWorker.last!.onmessage!({ data: { jobId: 3, result: [] } } as unknown as MessageEvent<ProviderDerivationWorkerResponse>);
    FakeWorker.last!.onerror!({ message: 'tarde' });

    expect(seen).toEqual([{ jobId: 3, result: [] }]);
  });
});
