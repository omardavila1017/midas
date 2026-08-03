import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinancialProjectionSourceWorkerResponse } from '../../../workers/financialProjectionSourceWorkerTypes';

/**
 * El hub del worker compartido es el ÚNICO punto por el que pasan las
 * respuestas de los tres call sites del motor (Proyección, Planeación y el hook
 * de Impuestos). Aquí se pinea que republica el diagnóstico del prorrateo Citi
 * en el hilo principal: el motor corre DENTRO del worker, donde no hay
 * `window`, así que su publicación directa es no-op y
 * `window.__midas__.citiProrrateo` quedaba vacío en producción — la superficie
 * que el propio aviso de consola manda consultar.
 */

class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((event: MessageEvent<FinancialProjectionSourceWorkerResponse>) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;
  constructor() { FakeWorker.last = this; }
  postMessage(msg: unknown) { this.posted.push(msg); }
  terminate() { this.terminated = true; }
}

const diagnostics = [
  { cia: '00011', ym: '2026-02', depositTotal: 5_000_000, matchedByAmount: 0, matchedDeposits: 0, leftoverPool: 5_000_000, leftoverExpected: 0, ratio: null, mode: 'sin-desglosar' as const, clients: 0 },
];

async function loadHub() {
  vi.resetModules(); // el módulo guarda el worker singleton a nivel módulo
  return import('./sharedSourceWorker');
}

function midasKey(): unknown {
  return (globalThis as unknown as { __midas__?: Record<string, unknown> }).__midas__?.citiProrrateo;
}

describe('sharedSourceWorker — republicación del diagnóstico Citi', () => {
  beforeEach(() => {
    FakeWorker.last = null;
    delete (globalThis as unknown as { __midas__?: unknown }).__midas__;
    (globalThis as unknown as { Worker?: unknown }).Worker = FakeWorker;
  });

  afterEach(() => {
    delete (globalThis as unknown as { Worker?: unknown }).Worker;
    delete (globalThis as unknown as { __midas__?: unknown }).__midas__;
  });

  it('publica en window.__midas__.citiProrrateo lo que el worker manda en el sobre', async () => {
    const hub = await loadHub();
    expect(hub.postToSharedSourceWorker({ jobId: 1, input: {} as never })).toBe(true);

    const received: FinancialProjectionSourceWorkerResponse[] = [];
    hub.subscribeSharedSourceWorker((data) => received.push(data));

    FakeWorker.last!.onmessage!({ data: { jobId: 1, citiDiagnostics: diagnostics } } as MessageEvent<FinancialProjectionSourceWorkerResponse>);

    expect(midasKey()).toEqual(diagnostics);
    // Republicar no puede robarle la respuesta a los suscriptores.
    expect(received).toHaveLength(1);
  });

  it('no pisa la clave cuando el job no trae diagnóstico (memo hit o sin depósitos Citi)', async () => {
    const hub = await loadHub();
    hub.postToSharedSourceWorker({ jobId: 1, input: {} as never });
    FakeWorker.last!.onmessage!({ data: { jobId: 1, citiDiagnostics: diagnostics } } as MessageEvent<FinancialProjectionSourceWorkerResponse>);
    FakeWorker.last!.onmessage!({ data: { jobId: 2 } } as MessageEvent<FinancialProjectionSourceWorkerResponse>);

    expect(midasKey()).toEqual(diagnostics);
  });

  it('falla los jobs en vuelo cuando el worker muere sin responder', async () => {
    const hub = await loadHub();
    const received: FinancialProjectionSourceWorkerResponse[] = [];
    hub.subscribeSharedSourceWorker((data) => received.push(data));

    hub.postToSharedSourceWorker({ jobId: 1, input: {} as never });
    hub.postToSharedSourceWorker({ jobId: 2, input: {} as never });
    // El job 2 sí respondió; sólo el 1 queda en vuelo.
    FakeWorker.last!.onmessage!({ data: { jobId: 2 } } as MessageEvent<FinancialProjectionSourceWorkerResponse>);
    received.length = 0;

    FakeWorker.last!.onerror!({ message: 'boom' });

    // Sin esto el call site espera su jobId PARA SIEMPRE: `onerror` no produce
    // respuesta y su rama `data.error` (fallback síncrono) nunca se alcanza.
    expect(received).toEqual([{ jobId: 1, error: 'boom' }]);
  });

  it('suelta el worker muerto para que el siguiente job levante uno nuevo', async () => {
    const hub = await loadHub();
    hub.postToSharedSourceWorker({ jobId: 1, input: {} as never });
    const dead = FakeWorker.last!;

    FakeWorker.last!.onerror!({ message: 'boom' });

    // Terminado: un `onerror` no siempre mata al worker, y dejarlo vivo con su
    // copia del bundle pesado mientras se levanta otro duplica el consumo que
    // este singleton existe para evitar.
    expect(dead.terminated).toBe(true);
    // El singleton muerto seguía cacheado, así que `post` devolvía `true` para
    // todo job posterior y el fallback síncrono nunca se disparaba.
    expect(hub.postToSharedSourceWorker({ jobId: 2, input: {} as never })).toBe(true);
    expect(FakeWorker.last).not.toBe(dead);
    expect(FakeWorker.last!.posted).toEqual([{ jobId: 2, input: {} }]);
  });

  it('no re-notifica un job ya respondido si el worker muere después', async () => {
    const hub = await loadHub();
    const received: FinancialProjectionSourceWorkerResponse[] = [];
    hub.subscribeSharedSourceWorker((data) => received.push(data));

    hub.postToSharedSourceWorker({ jobId: 1, input: {} as never });
    FakeWorker.last!.onmessage!({ data: { jobId: 1 } } as MessageEvent<FinancialProjectionSourceWorkerResponse>);
    received.length = 0;

    FakeWorker.last!.onerror!({ message: 'boom' });

    // Un error posterior no puede convertir en fallo un job que ya entregó su
    // resultado: el call site lo tomaría como error de su corrida vigente.
    expect(received).toEqual([]);
  });

  it('conserva las demás claves de diagnóstico de __midas__', async () => {
    (globalThis as unknown as { __midas__?: Record<string, unknown> }).__midas__ = { build: 'abc123' };
    const hub = await loadHub();
    hub.postToSharedSourceWorker({ jobId: 1, input: {} as never });
    FakeWorker.last!.onmessage!({ data: { jobId: 1, citiDiagnostics: diagnostics } } as MessageEvent<FinancialProjectionSourceWorkerResponse>);

    const w = (globalThis as unknown as { __midas__?: Record<string, unknown> }).__midas__;
    expect(w?.build).toBe('abc123');
    expect(w?.citiProrrateo).toEqual(diagnostics);
  });
});
