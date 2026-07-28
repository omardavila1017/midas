/**
 * Pinea el contrato load-bearing de useScenarioRunWorker (documentado en
 * CLAUDE.md, "Scenario pipeline off the main thread"):
 *
 *   - Cache hit  = resultado SÍNCRONO (sin post al worker).
 *   - Cache miss = postea al worker y devuelve el run PREVIO del escenario
 *     (stale-while-recompute, nunca congela).
 *   - Sin `Worker` (jsdom) = fallback síncrono en el main thread.
 *   - `needsHeavy` del worker = el hook re-envía el bundle pesado.
 *   - `runVersion` bump al llegar el resultado = re-lee el cache.
 *   - El heavy bundle se manda UNA vez por versión (posts posteriores solo
 *     llevan los args ligeros).
 *
 * El módulo bajo prueba tiene MUCHO estado a nivel módulo (worker compartido,
 * cola, versión del heavy, placeholder universal), así que cada test re-importa
 * el módulo con `vi.resetModules()` para partir de estado limpio. El worker se
 * simula con una clase FakeWorker vía `vi.stubGlobal` (jsdom no trae Worker).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type {
  BuildScenarioForecastRunArgs,
  ScenarioForecastRun,
} from '../../financial-planning/services/scenarioForecastRun';
import type { ScenarioForecastRunWorkerRequest } from '../../../workers/scenarioForecastRunWorkerTypes';

const { buildSpy } = vi.hoisted(() => ({ buildSpy: vi.fn() }));

// Misma especificidad relativa que usa el hook (el test vive en su carpeta).
vi.mock('../../financial-planning/services/scenarioForecastRun', () => ({
  buildScenarioForecastRun: buildSpy,
}));

// ---------------------------------------------------------------------------
// Fake Worker
// ---------------------------------------------------------------------------

type WorkerMsg = ScenarioForecastRunWorkerRequest;

class FakeWorker {
  static instances: FakeWorker[] = [];
  posted: WorkerMsg[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  terminated = false;

  constructor(..._args: unknown[]) {
    FakeWorker.instances.push(this);
  }

  postMessage(msg: WorkerMsg): void {
    this.posted.push(msg);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Emite una respuesta del worker hacia el main thread. */
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let runSeq = 0;
function makeRun(label?: string): ScenarioForecastRun {
  runSeq += 1;
  return { __fakeRun: label ?? `run-${runSeq}` } as unknown as ScenarioForecastRun;
}

// Referencias ESTABLES para el heavy bundle: heavyChanged compara por
// identidad (===) campo por campo.
const HEAVY_A = {
  sourceMovements: [] as unknown[],
  clients: [] as unknown[],
  providers: [] as unknown[],
  cxpRecords: [] as unknown[],
  cxpPaymentCoverage: undefined,
  auxiliarReconciliation: undefined,
  purchaseReceipts: [] as unknown[],
  payrollCosts: [] as unknown[],
  cobranzaPayments: [] as unknown[],
  bajioStatements: [] as unknown[],
};

function makeArgs(overrides: Record<string, unknown> = {}): BuildScenarioForecastRunArgs {
  return {
    ...HEAVY_A,
    scenario: { id: 'sc1', kind: 'BASE' },
    granularity: 'month',
    ...overrides,
  } as unknown as BuildScenarioForecastRunArgs;
}

/**
 * Re-importa el módulo bajo prueba (y el cache que comparte) con registro de
 * módulos fresco, para que el estado module-level no se filtre entre tests.
 */
async function loadFresh() {
  vi.resetModules();
  const mod = await import('./useScenarioRunWorker');
  const cacheMod = await import('../../financial-projection/services/projectionCache');
  return { ...mod, projectionRunCache: cacheMod.projectionRunCache };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  buildSpy.mockReset();
  buildSpy.mockImplementation(() => makeRun());
  FakeWorker.instances = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// requestScenarioRun (función directa)
// ---------------------------------------------------------------------------

describe('requestScenarioRun', () => {
  it('cache hit resuelve síncrono con el valor cacheado, sin crear worker ni postear', async () => {
    const { requestScenarioRun, projectionRunCache } = await loadFresh();
    vi.stubGlobal('Worker', FakeWorker);

    const cachedRun = makeRun('cached');
    projectionRunCache.set('key-hit', cachedRun);

    await expect(requestScenarioRun('key-hit', 'sc1', makeArgs())).resolves.toBe(cachedRun);
    expect(FakeWorker.instances).toHaveLength(0);
    expect(buildSpy).not.toHaveBeenCalled();
  });

  it('sin Worker disponible (jsdom) cae al cómputo síncrono en main thread', async () => {
    const { requestScenarioRun } = await loadFresh();
    // jsdom: typeof Worker === 'undefined' (no stub)
    expect(typeof Worker).toBe('undefined');

    const args = makeArgs();
    const result = await requestScenarioRun('key-sync', 'sc1', args);

    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(buildSpy).toHaveBeenCalledWith(args);
    expect(result).toBe(buildSpy.mock.results[0].value);
  });

  it('manda el heavy bundle UNA vez por versión: mismo heavy → post sin heavy; heavy nuevo → re-envía con versión bump', async () => {
    const { requestScenarioRun } = await loadFresh();
    vi.stubGlobal('Worker', FakeWorker);

    const p1 = requestScenarioRun('key-a', 'sc1', makeArgs());
    const worker = FakeWorker.instances[0];
    expect(worker.posted).toHaveLength(1);
    const req1 = worker.posted[0];
    expect(req1.heavy).toBeDefined();

    worker.emit({ jobId: req1.jobId, cacheKey: 'key-a', scenarioId: 'sc1', result: makeRun() });
    await p1;

    // Mismo heavy (mismas referencias) → delta ligero, sin heavy re-adjunto.
    const p2 = requestScenarioRun('key-b', 'sc1', makeArgs());
    expect(worker.posted).toHaveLength(2);
    const req2 = worker.posted[1];
    expect(req2.heavy).toBeUndefined();
    expect(req2.sourceVersion).toBe(req1.sourceVersion);

    worker.emit({ jobId: req2.jobId, cacheKey: 'key-b', scenarioId: 'sc1', result: makeRun() });
    await p2;

    // Un input pesado cambió (nueva referencia) → versión bump + heavy re-enviado.
    const p3 = requestScenarioRun('key-c', 'sc1', makeArgs({ sourceMovements: [{ id: 'm1' }] }));
    expect(worker.posted).toHaveLength(3);
    const req3 = worker.posted[2];
    expect(req3.heavy).toBeDefined();
    expect(req3.sourceVersion).toBe(req1.sourceVersion + 1);

    worker.emit({ jobId: req3.jobId, cacheKey: 'key-c', scenarioId: 'sc1', result: makeRun() });
    await p3;

    // Todo el camino worker: el motor NUNCA corrió en el main thread.
    expect(buildSpy).not.toHaveBeenCalled();
  });

  it('respuesta needsHeavy → re-postea el MISMO job con el heavy bundle adjunto', async () => {
    const { requestScenarioRun } = await loadFresh();
    vi.stubGlobal('Worker', FakeWorker);

    // Job A establece la versión del heavy en el "worker".
    const pA = requestScenarioRun('key-a', 'sc1', makeArgs());
    const worker = FakeWorker.instances[0];
    const reqA = worker.posted[0];
    worker.emit({ jobId: reqA.jobId, cacheKey: 'key-a', scenarioId: 'sc1', result: makeRun() });
    await pA;

    // Job B viaja SIN heavy (misma versión)…
    const pB = requestScenarioRun('key-b', 'sc1', makeArgs());
    const reqB = worker.posted[1];
    expect(reqB.heavy).toBeUndefined();

    // …pero el worker dice que no tiene el bundle (p.ej. fue recreado).
    worker.emit({ jobId: reqB.jobId, cacheKey: 'key-b', scenarioId: 'sc1', needsHeavy: true });

    expect(worker.posted).toHaveLength(3);
    const reposted = worker.posted[2];
    expect(reposted.jobId).toBe(reqB.jobId);
    expect(reposted.cacheKey).toBe('key-b');
    expect(reposted.heavy).toBeDefined();

    const fresh = makeRun('after-needsHeavy');
    worker.emit({ jobId: reposted.jobId, cacheKey: 'key-b', scenarioId: 'sc1', result: fresh });
    await expect(pB).resolves.toBe(fresh);
  });

  it('dedup por cacheKey: dos requests concurrentes del mismo key = UN post; ambos resuelven con el mismo resultado', async () => {
    const { requestScenarioRun } = await loadFresh();
    vi.stubGlobal('Worker', FakeWorker);

    const p1 = requestScenarioRun('key-dup', 'sc1', makeArgs());
    const p2 = requestScenarioRun('key-dup', 'sc1', makeArgs());
    const worker = FakeWorker.instances[0];
    expect(worker.posted).toHaveLength(1);

    const fresh = makeRun('dedup');
    worker.emit({ jobId: worker.posted[0].jobId, cacheKey: 'key-dup', scenarioId: 'sc1', result: fresh });

    await expect(p1).resolves.toBe(fresh);
    await expect(p2).resolves.toBe(fresh);
  });

  it('resetScenarioRunWorker termina el worker y rechaza los jobs en vuelo con el error benigno', async () => {
    const { requestScenarioRun, resetScenarioRunWorker } = await loadFresh();
    vi.stubGlobal('Worker', FakeWorker);

    const pending = requestScenarioRun('key-reset', 'sc1', makeArgs());
    const worker = FakeWorker.instances[0];
    expect(worker.posted).toHaveLength(1);

    resetScenarioRunWorker();

    expect(worker.terminated).toBe(true);
    await expect(pending).rejects.toThrow('scenario worker reset under memory pressure');
  });
});

// ---------------------------------------------------------------------------
// useScenarioRunWorker (hook)
// ---------------------------------------------------------------------------

describe('useScenarioRunWorker', () => {
  it('sin Worker (jsdom): runCached computa síncrono, escribe el cache y llama persist', async () => {
    const mod = await loadFresh();
    expect(typeof Worker).toBe('undefined');

    const { result } = renderHook(() => mod.useScenarioRunWorker());
    const persist = vi.fn();

    const run = result.current.runCached<ScenarioForecastRun>('k1', 'sc1', () => makeArgs(), persist);

    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(mod.projectionRunCache.get('k1')).toBe(run);
    expect(persist).toHaveBeenCalledWith('k1', run);
    expect(result.current.runVersion).toBe(0); // el path síncrono no bumpea versión
  });

  it('cache hit es síncrono: devuelve el valor cacheado sin invocar el motor ni el worker', async () => {
    const mod = await loadFresh();
    vi.stubGlobal('Worker', FakeWorker);

    const cachedRun = makeRun('hook-cached');
    mod.projectionRunCache.set('k-hit', cachedRun);

    const { result } = renderHook(() => mod.useScenarioRunWorker());
    const got = result.current.runCached<ScenarioForecastRun>('k-hit', 'sc1', () => makeArgs());

    expect(got).toBe(cachedRun);
    expect(buildSpy).not.toHaveBeenCalled();
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('stale-while-recompute: cache miss con placeholder devuelve el run PREVIO, postea al worker, y al llegar el resultado bumpea runVersion + re-lee el cache', async () => {
    const mod = await loadFresh();
    vi.stubGlobal('Worker', FakeWorker);

    const { result } = renderHook(() => mod.useScenarioRunWorker());

    // 1er run del escenario: aún sin placeholder → computa síncrono (siembra el stale).
    const first = result.current.runCached<ScenarioForecastRun>('k1', 'sc1', () => makeArgs());
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(FakeWorker.instances).toHaveLength(0); // no tocó el worker

    // 2o run (key nuevo, mismo escenario): devuelve el run previo y postea.
    const persist = vi.fn();
    const stale = result.current.runCached<ScenarioForecastRun>('k2', 'sc1', () => makeArgs(), persist);
    expect(stale).toBe(first);
    expect(buildSpy).toHaveBeenCalledTimes(1); // NO recomputó en main thread
    const worker = FakeWorker.instances[0];
    expect(worker.posted).toHaveLength(1);
    const req = worker.posted[0];
    expect(req.cacheKey).toBe('k2');
    expect(req.scenarioId).toBe('sc1');

    // Re-pedir el mismo key mientras está en vuelo NO re-postea (pendingKeys).
    const staleAgain = result.current.runCached<ScenarioForecastRun>('k2', 'sc1', () => makeArgs());
    expect(staleAgain).toBe(first);
    expect(worker.posted).toHaveLength(1);

    // El worker responde → cache escrito, persist llamado, runVersion bump.
    const fresh = makeRun('fresh-from-worker');
    expect(result.current.runVersion).toBe(0);
    await act(async () => {
      worker.emit({ jobId: req.jobId, cacheKey: 'k2', scenarioId: 'sc1', result: fresh });
      await flushMicrotasks();
    });

    expect(result.current.runVersion).toBe(1);
    expect(mod.projectionRunCache.get('k2')).toBe(fresh);
    expect(persist).toHaveBeenCalledWith('k2', fresh);

    // El re-read tras el bump es cache hit síncrono (sin nuevo post).
    const reread = result.current.runCached<ScenarioForecastRun>('k2', 'sc1', () => makeArgs());
    expect(reread).toBe(fresh);
    expect(worker.posted).toHaveLength(1);
  });

  it("placeholderMode 'none' fuerza cómputo síncrono aunque haya Worker y placeholder disponible", async () => {
    const mod = await loadFresh();
    vi.stubGlobal('Worker', FakeWorker);

    const { result } = renderHook(() => mod.useScenarioRunWorker());

    // Siembra placeholder del escenario.
    result.current.runCached<ScenarioForecastRun>('k1', 'sc1', () => makeArgs());
    expect(buildSpy).toHaveBeenCalledTimes(1);

    // Con 'none' se ignora el stale → computa síncrono, sin worker.
    const run = result.current.runCached<ScenarioForecastRun>(
      'k2', 'sc1', () => makeArgs(), undefined, { placeholderMode: 'none' },
    );
    expect(buildSpy).toHaveBeenCalledTimes(2);
    expect(run).toBe(buildSpy.mock.results[1].value);
    expect(FakeWorker.instances).toHaveLength(0);
    expect(mod.projectionRunCache.get('k2')).toBe(run);
  });

  it("placeholderMode 'same-scenario': placeholder de OTRO escenario no aplica → computa síncrono; el del MISMO escenario sí → stale + post", async () => {
    const mod = await loadFresh();
    vi.stubGlobal('Worker', FakeWorker);

    const { result } = renderHook(() => mod.useScenarioRunWorker());

    // Placeholder sembrado para sc1 (también llena el universal).
    const runSc1 = result.current.runCached<ScenarioForecastRun>('k1', 'sc1', () => makeArgs());

    // sc2 con 'same-scenario': el universal NO cuenta → síncrono.
    const runSc2 = result.current.runCached<ScenarioForecastRun>(
      'k2', 'sc2', () => makeArgs(), undefined, { placeholderMode: 'same-scenario' },
    );
    expect(runSc2).not.toBe(runSc1);
    expect(buildSpy).toHaveBeenCalledTimes(2);
    expect(FakeWorker.instances).toHaveLength(0);

    // sc1 con 'same-scenario': su propio stale sí aplica → devuelve previo + postea.
    const stale = result.current.runCached<ScenarioForecastRun>(
      'k3', 'sc1', () => makeArgs(), undefined, { placeholderMode: 'same-scenario' },
    );
    expect(stale).toBe(runSc1);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].posted).toHaveLength(1);
  });

  it('error del worker: el hook loguea, limpia el pending y el siguiente runCached re-postea', async () => {
    const mod = await loadFresh();
    vi.stubGlobal('Worker', FakeWorker);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = renderHook(() => mod.useScenarioRunWorker());

    const first = result.current.runCached<ScenarioForecastRun>('k1', 'sc1', () => makeArgs());
    result.current.runCached<ScenarioForecastRun>('k2', 'sc1', () => makeArgs());
    const worker = FakeWorker.instances[0];
    const req = worker.posted[0];

    await act(async () => {
      worker.emit({ jobId: req.jobId, cacheKey: 'k2', scenarioId: 'sc1', error: 'boom en worker' });
      await flushMicrotasks();
    });

    expect(warnSpy).toHaveBeenCalled();
    expect(result.current.runVersion).toBe(0); // sin bump en error
    expect(mod.projectionRunCache.get('k2')).toBeUndefined();

    // El pending se limpió: un nuevo runCached del mismo key vuelve a postear.
    const staleRetry = result.current.runCached<ScenarioForecastRun>('k2', 'sc1', () => makeArgs());
    expect(staleRetry).toBe(first);
    expect(worker.posted).toHaveLength(2);
  });
});
