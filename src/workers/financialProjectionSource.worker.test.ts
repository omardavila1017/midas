import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Contrato del pegamento del worker con el buzón del diagnóstico Citi.
 *
 * La cadena que lleva `window.__midas__.citiProrrateo` al hilo principal tiene
 * tres piezas: el buzón del motor (`canonicalProjection.test.ts`), este worker,
 * y el hub que republica (`sharedSourceWorker.test.ts`). Las puntas estaban
 * pineadas; el pegamento no — y es la pieza cuyo fallo cuesta caro: si el buzón
 * NO se vacía en la rama de error, el siguiente job (que puede pegar en el memo
 * y no correr el motor) reporta como suyo el diagnóstico de la corrida anterior.
 * Eso es exactamente el modo de falla que esta capa existe para impedir — un
 * artefacto plausible que describe otra corrida, la clase de señal falsa que
 * hizo que el caso 3M pasara meses sin detectarse.
 *
 * Se mockea el servicio para que el test sea hermético: aquí se verifica el
 * pegamento (drenar el buzón exactamente una vez por job y adjuntarlo al
 * SOBRE), no el motor.
 */

const buildMock = vi.fn();
const takeMock = vi.fn();

vi.mock('../modules/financial-projection/services/financialProjectionService', () => ({
  buildFinancialProjectionSourceData: (...args: unknown[]) => buildMock(...args),
}));

vi.mock('../modules/shared-finance/calculation-engine/canonicalProjection', () => ({
  takeCitiAttributionDiagnostics: () => takeMock(),
}));

const diagnostics = [
  {
    cia: '00011', ym: '2026-02', depositTotal: 5_000_000, matchedByAmount: 0,
    matchedDeposits: 0, leftoverPool: 5_000_000, leftoverExpected: 0,
    ratio: null, mode: 'sin-desglosar' as const, clients: 0,
  },
];

const sourceResult = { movements: [], suppliers: [], customers: [] };
const request = { jobId: 7, input: { cxpRecords: [], bankStatements: [] } };

type WorkerScope = {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage: (message: unknown) => void;
};

/** Importa el worker fresco y devuelve su handler + lo que postea. */
async function loadWorker() {
  vi.resetModules();
  const posted: Record<string, unknown>[] = [];
  const scope = globalThis.self as unknown as WorkerScope;
  scope.postMessage = (message: unknown) => { posted.push(message as Record<string, unknown>); };
  await import('./financialProjectionSource.worker');
  return { fire: (data: unknown) => scope.onmessage!({ data }), posted };
}

describe('financialProjectionSource.worker — buzón del diagnóstico Citi', () => {
  beforeEach(() => {
    buildMock.mockReset();
    takeMock.mockReset();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (globalThis.self as unknown as WorkerScope).onmessage = null;
  });

  it('adjunta al sobre el diagnóstico de ESTA corrida', async () => {
    buildMock.mockReturnValue(sourceResult);
    takeMock.mockReturnValue(diagnostics);
    const { fire, posted } = await loadWorker();

    fire(request);

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ jobId: 7, result: sourceResult, citiDiagnostics: diagnostics });
    // Vaciar el buzón exactamente una vez: leerlo dos veces por job devolvería
    // `null` la segunda y el diagnóstico se perdería.
    expect(takeMock).toHaveBeenCalledTimes(1);
  });

  it('omite la clave cuando el motor no volvió a correr (memo hit)', async () => {
    buildMock.mockReturnValue(sourceResult);
    takeMock.mockReturnValue(null);
    const { fire, posted } = await loadWorker();

    fire(request);

    // `undefined` y no `null`: el hub distingue "sin diagnóstico" para NO pisar
    // la clave con un vacío.
    expect(posted[0].citiDiagnostics).toBeUndefined();
  });

  it('descarta el buzón cuando el job falla, para no atribuírselo al siguiente', async () => {
    buildMock.mockImplementation(() => { throw new Error('boom'); });
    takeMock.mockReturnValue(diagnostics);
    const { fire, posted } = await loadWorker();

    fire(request);

    // El fallo puede ser posterior al prorrateo, así que el buzón quedó lleno:
    // sin este drenado, el siguiente job lo reportaría como suyo.
    expect(takeMock).toHaveBeenCalledTimes(1);
    expect(posted[0]).toMatchObject({ jobId: 7, error: 'boom' });
    expect(posted[0].citiDiagnostics).toBeUndefined();
  });
});
