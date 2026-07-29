/**
 * Cobertura de RAMAS de `dailyApiCache.ts` que las suites existentes
 * (`dailyApiCache.test.ts`, `.revalidation.test.ts`, `.idb.test.ts`) no
 * ejercitan: guards previos a `primeDailyCache()`, rangos inválidos,
 * callbacks opcionales (presentes / ausentes / que truenan), la carrera
 * "cacheado pero sin payload" (prune / desalojo del buffer FIFO), el
 * namespace mensual visto por los lectores diarios, las variantes de la
 * migración legacy de localStorage y los caminos de IDB rota / lenta.
 *
 * Patrón: módulo FRESCO por test (`vi.resetModules()` + import dinámico) para
 * que `keyIndex` / `dbPromise` / `recentWrites` (estado de módulo) no se
 * filtren entre casos. IDB falso vía `src/test/fakeIndexedDb.ts` (jsdom no
 * trae IndexedDB) — espejo exacto de `dailyApiCache.idb.test.ts`.
 *
 * Ramas INALCANZABLES desde la API pública (documentadas, no testeadas):
 *   • 106 `if (oldest === undefined) break` — el `while` sólo entra cuando
 *     `recentWrites.size > CAP`, así que siempre hay una llave que desalojar.
 *   • 307 `pruneStaleEntries` con `!keyIndex` — `ensureMemoryReady` siempre
 *     asigna `keyIndex` antes de llamarla.
 *   • 321 `dropFromIdb` con `!db` — `pruneStaleEntries` sólo corre dentro de
 *     `ensureMemoryReady` DESPUÉS del `if (!db) return`, así que cuando poda
 *     la DB siempre existe (y `dbPromise` está memoizada).
 *   • 330 la rama `typeof window === 'undefined'` del selector de
 *     `requestIdleCallback` — la suite corre en jsdom (siempre hay `window`).
 *   • 583 / 1194 el `catch` alrededor de `getDailyCachedAsync` /
 *     `getMonthCachedAsync` — ninguna de las dos rechaza (`readEntryFromIdb`
 *     se traga todo y resuelve `null`).
 *   • 805 `buckets.get(day) ?? []` — el bucket se siembra para TODOS los días
 *     de la ventana justo arriba, así que el `??` nunca cae.
 *   • 882 `clearDailyCache` con `!keyIndex` y 957 `listDailyCacheKeys` con
 *     `!keyIndex` — ambas hacen `await ensureMemoryReady()` primero.
 *   • 997 `monthFromKey` sin el tag `M:` — sus dos callers ya filtraron por el
 *     prefijo `M:…`, así que la llave siempre lo trae.
 *   • 1028 `monthBounds` con mes no parseable — sólo se llama con meses que
 *     produjo `buildMonthList` (siempre `YYYY-MM` válido).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeIDBDatabase,
  installFakeIndexedDb,
  uninstallFakeIndexedDb,
  type FakeIndexedDB,
} from '../test/fakeIndexedDb';

type CacheModule = typeof import('./dailyApiCache');

interface Rec { d?: string; v?: number; i?: number | string }

let fake: FakeIndexedDB;

async function freshCache(): Promise<CacheModule> {
  vi.resetModules();
  return import('./dailyApiCache');
}

/** Deja drenar micro/macro-tasks de las escrituras fire-and-forget. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const TODAY = '2026-07-28';

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  fake = installFakeIndexedDb();
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as Record<string, unknown>).requestIdleCallback;
  uninstallFakeIndexedDb();
  vi.unstubAllGlobals();
  localStorage.clear();
  vi.restoreAllMocks();
});

// ── Guards previos a primeDailyCache (keyIndex === null) ──────────────────

describe('dailyApiCache — lecturas antes de primeDailyCache()', () => {
  it('todos los lectores sync/async responden vacío sin keyIndex', async () => {
    const mod = await freshCache();

    expect(mod.hasDailyCached('x', '2026-01-01')).toBe(false);
    expect(await mod.getDailyCachedAsync('x', '2026-01-01')).toBeNull();
    expect(mod.hasMonthCached('x', '2026-01')).toBe(false);
    expect(await mod.getMonthCachedAsync('x', '2026-01')).toBeNull();
    expect(mod.dailyCacheStats('x')).toEqual({ count: 0, days: [] });
    expect(mod.getMaxCachedDay('x')).toBeNull();
    expect(mod.getMaxCachedMonth('x')).toBeNull();
    expect(mod.isDailyCachePersistent()).toBe(false);
  });

  it('setDailyCached crea el keyIndex aunque no se haya primed', async () => {
    const mod = await freshCache();
    mod.setDailyCached('x', '2026-06-01', [{ v: 1 }], undefined, TODAY);
    expect(mod.hasDailyCached('x', '2026-06-01')).toBe(true);
  });

  it('setMonthCached crea el keyIndex y NUNCA cachea el mes en curso', async () => {
    const mod = await freshCache();
    mod.setMonthCached('y', '2026-05', [{ v: 1 }], undefined, TODAY);
    expect(mod.hasMonthCached('y', '2026-05')).toBe(true);
    // Buffer write-through: se lee sin esperar el commit de IDB.
    expect(await mod.getMonthCachedAsync('y', '2026-05')).toEqual([{ v: 1 }]);

    mod.setMonthCached('y', '2026-07', [{ v: 2 }], undefined, TODAY);
    expect(mod.hasMonthCached('y', '2026-07')).toBe(false);
  });
});

// ── Prefijos: sin cía + keys mensuales vistas por los lectores diarios ────

describe('dailyApiCache — prefijos de api/cía y keys mensuales', () => {
  it('sin cía agrega todas las cías; las keys mensuales no aportan día', async () => {
    const mod = await freshCache();
    await mod.primeDailyCache();

    mod.setDailyCached('bancos', '2026-06-01', [], '00150', TODAY);
    mod.setDailyCached('bancos', '2026-06-02', [], '00033', TODAY);
    mod.setDailyCached('otroapi', '2026-06-30', [], undefined, TODAY);
    mod.setMonthCached('bancos', '2026-05', [], '00150', TODAY);

    // Prefijo sin cía → une las dos cías, ignora `otroapi` y la key mensual.
    expect(mod.dailyCacheStats('bancos')).toEqual({
      count: 2,
      days: ['2026-06-01', '2026-06-02'],
    });
    expect(mod.getMaxCachedDay('bancos')).toBe('2026-06-02');

    // Namespace mensual: la key existe pero `dayFromKey` no extrae día.
    expect(mod.dailyCacheStats('M:bancos')).toEqual({ count: 0, days: [] });
    expect(mod.getMaxCachedDay('M:bancos')).toBeNull();

    expect(mod.getMaxCachedMonth('bancos')).toBe('2026-05');
    expect(mod.getMaxCachedMonth('otroapi')).toBeNull();

    expect((await mod.listDailyCacheKeys()).length).toBe(4);
  });

  it('getMaxCachedMonth: filtra por cía, compara meses y descarta keys sin mes', async () => {
    const mod = await freshCache();
    await mod.primeDailyCache();

    mod.setMonthCached('mx', '2026-03', [], '00150', TODAY);
    mod.setMonthCached('mx', '2026-05', [], '00150', TODAY);
    mod.setMonthCached('mx', '2026-06', [], '00033', TODAY);
    // Una key DIARIA bajo un api que empieza con el tag mensual: entra al
    // prefijo de `getMaxCachedMonth` pero `monthFromKey` no extrae mes.
    mod.setDailyCached('M:mx', '2026-07-01', [], '00150', TODAY);

    expect(mod.getMaxCachedMonth('mx', '00150')).toBe('2026-05');
    expect(mod.getMaxCachedMonth('mx', '00033')).toBe('2026-06');
    expect(mod.getMaxCachedMonth('mx')).toBe('2026-06');
  });
});

// ── Rangos vacíos / inválidos ────────────────────────────────────────────

describe('dailyApiCache — rangos vacíos o invertidos', () => {
  it('los tres helpers devuelven [] sin tocar el fetcher', async () => {
    const mod = await freshCache();
    await mod.primeDailyCache();

    const fetchDay = vi.fn(async () => [{ v: 1 }]);
    expect(await mod.fetchRangeWithDailyCache<Rec>('z', {
      from: '2026-06-10', to: '2026-06-01', fetchDay, today: TODAY,
    })).toEqual([]);
    expect(await mod.fetchRangeWithDailyCache<Rec>('z', {
      from: 'no-es-fecha', to: '2026-06-01', fetchDay, today: TODAY,
    })).toEqual([]);
    expect(fetchDay).not.toHaveBeenCalled();

    const fetchChunk = vi.fn(async () => [] as Rec[]);
    expect(await mod.fetchRangeWithChunkedDailyCache<Rec>('z', {
      from: '2026-06-10', to: '2026-06-01', chunkSize: 7, fetchChunk,
      dateOf: (r) => r.d ?? '', today: TODAY,
    })).toEqual([]);
    expect(fetchChunk).not.toHaveBeenCalled();

    const fetchMonth = vi.fn(async () => [{ v: 1 }]);
    expect(await mod.fetchRangeWithMonthlyCache<Rec>('z', {
      from: '2026-06-10', to: '2026-06-01', fetchMonth, today: TODAY,
    })).toEqual([]);
    expect(await mod.fetchRangeWithMonthlyCache<Rec>('z', {
      from: 'basura', to: '2026-06-01', fetchMonth, today: TODAY,
    })).toEqual([]);
    expect(fetchMonth).not.toHaveBeenCalled();
  });

  it('isoDaysBefore devuelve la entrada tal cual si no es parseable', async () => {
    const mod = await freshCache();
    expect(mod.isoDaysBefore('basura', 3)).toBe('basura');
    expect(mod.isoDaysBefore('2026-06-10', 9)).toBe('2026-06-01');
  });
});

// ── fetchRangeWithDailyCache: callbacks presentes y que truenan ───────────

describe('fetchRangeWithDailyCache — onProgress/onDay (incl. callbacks que truenan)', () => {
  it('emite progreso y onDay por cache-hit y por fetch fresco, tragándose el throw del caller', async () => {
    const mod = await freshCache();
    await mod.primeDailyCache();
    const d1 = '2026-06-01';
    const d2 = '2026-06-02';
    mod.setDailyCached('cb', d1, [{ v: 1 }], undefined, TODAY);

    const onDay = vi.fn(() => { throw new Error('bug del caller'); });
    const onProgress = vi.fn();
    const out = await mod.fetchRangeWithDailyCache<Rec>('cb', {
      from: d1, to: d2, today: TODAY, onDay, onProgress,
      fetchDay: async () => [{ v: 2 }],
    });

    expect(out).toEqual([{ v: 1 }, { v: 2 }]);
    // Uno por el hit del cache + uno por el día fetcheado.
    expect(onDay).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalled();
    expect(onProgress).toHaveBeenLastCalledWith(2, 2);
  });

  it('revalidación fallida: sirve el cache previo aunque onDay y onDayFailed truenen', async () => {
    const mod = await freshCache();
    await mod.primeDailyCache();
    const day = '2026-06-05';
    mod.setDailyCached('cbf', day, [{ v: 7 }], undefined, TODAY);

    const onDay = vi.fn(() => { throw new Error('bug onDay'); });
    const onDayFailed = vi.fn(() => { throw new Error('bug onDayFailed'); });
    const out = await mod.fetchRangeWithDailyCache<Rec>('cbf', {
      from: day, to: day, today: TODAY, revalidateSince: day,
      fetchDay: async () => { throw new Error('JDE caído'); },
      onDay, onDayFailed,
    });

    expect(out).toEqual([{ v: 7 }]);
    expect(onDay).toHaveBeenCalledTimes(1);
    expect(onDayFailed).toHaveBeenCalledWith(day);
  });
});

// ── Carrera "cacheado sin payload": desalojo FIFO del buffer sin IDB ──────

describe('dailyApiCache — key en el índice pero payload ilegible', () => {
  it('desalojo del buffer sin IDB → getDailyCachedAsync null y el rango re-fetchea el día', async () => {
    uninstallFakeIndexedDb();
    const mod = await freshCache();
    await mod.primeDailyCache();
    expect(mod.isDailyCachePersistent()).toBe(false);

    // El buffer write-through está acotado a 256 entradas (FIFO). Con 300
    // escrituras, las primeras salen del buffer pero SIGUEN en el keyIndex;
    // sin IDB detrás, su payload ya no es legible.
    const base = '2025-01-01';
    for (let i = 0; i < 300; i++) {
      mod.setDailyCached('big', addDays(base, i), [{ i }], undefined, TODAY);
    }
    const first = base;
    expect(mod.hasDailyCached('big', first)).toBe(true);
    expect(await mod.getDailyCachedAsync('big', first)).toBeNull();

    const fetchDay = vi.fn(async () => [{ i: 'refetch' }]);
    const out = await mod.fetchRangeWithDailyCache<Rec>('big', {
      from: first, to: first, fetchDay, today: TODAY,
    });
    expect(fetchDay).toHaveBeenCalledTimes(1);
    expect(out).toEqual([{ i: 'refetch' }]);

    // El carril chunked NO re-fetchea la ventana: el día ilegible queda [].
    const second = addDays(base, 1);
    expect(mod.hasDailyCached('big', second)).toBe(true);
    const fetchChunk = vi.fn(async () => [] as Rec[]);
    const outChunk = await mod.fetchRangeWithChunkedDailyCache<Rec>('big', {
      from: second, to: second, chunkSize: 7, fetchChunk,
      dateOf: (r) => r.d ?? '', today: TODAY,
    });
    expect(fetchChunk).not.toHaveBeenCalled();
    expect(outChunk).toEqual([]);

    // Mismo desalojo en el carril mensual.
    const baseMonth = '2000-01';
    for (let i = 0; i < 300; i++) {
      mod.setMonthCached('bigm', addMonths(baseMonth, i), [{ i }], undefined, TODAY);
    }
    expect(mod.hasMonthCached('bigm', baseMonth)).toBe(true);
    expect(await mod.getMonthCachedAsync('bigm', baseMonth)).toBeNull();

    const fetchMonth = vi.fn(async () => [{ v: 42 }]);
    const outM = await mod.fetchRangeWithMonthlyCache<Rec>('bigm', {
      from: `${baseMonth}-01`, to: `${baseMonth}-31`, fetchMonth, today: TODAY,
    });
    expect(fetchMonth).toHaveBeenCalledTimes(1);
    expect(outM).toEqual([{ v: 42 }]);
  });
});

// ── fetchRangeWithChunkedDailyCache ──────────────────────────────────────

describe('fetchRangeWithChunkedDailyCache — chunk 100% cacheado', () => {
  it('sirve la ventana entera del cache sin fetch, con progreso y onDay que truena', async () => {
    const mod = await freshCache();
    await mod.primeDailyCache();
    const d1 = '2026-06-01';
    const d2 = '2026-06-02';
    mod.setDailyCached('ck', d1, [{ d: d1, v: 1 }], undefined, TODAY);
    mod.setDailyCached('ck', d2, [], undefined, TODAY);

    const fetchChunk = vi.fn(async () => [] as Rec[]);
    const onDay = vi.fn(() => { throw new Error('bug del caller'); });
    const onProgress = vi.fn();
    const out = await mod.fetchRangeWithChunkedDailyCache<Rec>('ck', {
      from: d1, to: d2, chunkSize: 7, fetchChunk, dateOf: (r) => r.d ?? '',
      today: TODAY, onDay, onProgress,
    });

    expect(fetchChunk).not.toHaveBeenCalled();
    expect(out).toEqual([{ d: d1, v: 1 }]);
    expect(onDay).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenLastCalledWith(2, 2);
  });

  it('chunk que truena: onChunkFailed/onDay que lanzan no rompen el rango', async () => {
    const mod = await freshCache();
    await mod.primeDailyCache();
    const d1 = '2026-06-01';
    const d2 = '2026-06-02';
    mod.setDailyCached('ckf', d1, [{ d: d1, v: 5 }], undefined, TODAY);
    // d2 sin cachear → el chunk necesita fetch.

    const onChunkFailed = vi.fn(() => { throw new Error('bug onChunkFailed'); });
    const onDay = vi.fn(() => { throw new Error('bug onDay'); });
    const onProgress = vi.fn();
    const out = await mod.fetchRangeWithChunkedDailyCache<Rec>('ckf', {
      from: d1, to: d2, chunkSize: 7, dateOf: (r) => r.d ?? '', today: TODAY,
      fetchChunk: async () => { throw new Error('red caída'); },
      onChunkFailed, onDay, onProgress,
    });

    expect(out).toEqual([{ d: d1, v: 5 }]);
    expect(onChunkFailed).toHaveBeenCalledWith(d1, d2);
    expect(onDay).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenLastCalledWith(2, 2);
  });

  it('failedDays + día normal: ambos callbacks pueden tronar sin degradar el resultado', async () => {
    const mod = await freshCache();
    await mod.primeDailyCache();
    const d1 = '2026-06-01';
    const d2 = '2026-06-02';
    mod.setDailyCached('ckd', d1, [{ d: d1, v: 9 }], undefined, TODAY);

    const onDay = vi.fn(() => { throw new Error('bug onDay'); });
    const onDayFailed = vi.fn(() => { throw new Error('bug onDayFailed'); });
    const onProgress = vi.fn();
    const out = await mod.fetchRangeWithChunkedDailyCache<Rec>('ckd', {
      from: d1, to: d2, chunkSize: 7, dateOf: (r) => r.d ?? '', today: TODAY,
      revalidateSince: d1,
      fetchChunk: async () => ({ records: [{ d: d2, v: 1 }], failedDays: [d1] }),
      onDay, onDayFailed, onProgress,
    });

    expect(out.map(r => r.v).sort()).toEqual([1, 9]);
    expect(onDayFailed).toHaveBeenCalledWith(d1);
    // Un onDay por el día fallido (cache previo) y otro por el día fresco.
    expect(onDay).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith(2, 2);
  });
});

// ── fetchRangeWithMonthlyCache ───────────────────────────────────────────

describe('fetchRangeWithMonthlyCache — mes en curso + progreso', () => {
  it('acota el mes en curso a hoy, sirve el mes cacheado y emite progreso', async () => {
    const mod = await freshCache();
    await mod.primeDailyCache();
    mod.setMonthCached('mm', '2026-05', [{ v: 5 }], undefined, TODAY);

    const fetchMonth = vi.fn(async (from: string, to: string) => [{ d: `${from}..${to}`, v: 1 }]);
    const onProgress = vi.fn();
    const out = await mod.fetchRangeWithMonthlyCache<Rec>('mm', {
      from: '2026-05-10', to: '2026-07-15', fetchMonth, onProgress, today: TODAY,
    });

    expect(fetchMonth).toHaveBeenCalledWith('2026-06-01', '2026-06-30');
    expect(fetchMonth).toHaveBeenCalledWith('2026-07-01', TODAY);
    expect(out).toHaveLength(3);
    expect(onProgress).toHaveBeenLastCalledWith(3, 3);
    // El mes en curso no se persiste (datos vivos).
    expect(mod.hasMonthCached('mm', '2026-07')).toBe(false);
    expect(mod.hasMonthCached('mm', '2026-06')).toBe(true);
  });

  it('mes sin cache previo cuyo fetch falla devuelve [] y tolera un onMonthFailed que truena', async () => {
    const mod = await freshCache();
    await mod.primeDailyCache();

    const onMonthFailed = vi.fn(() => { throw new Error('bug del caller'); });
    const out = await mod.fetchRangeWithMonthlyCache<Rec>('mf', {
      from: '2026-05-01', to: '2026-05-31', today: TODAY, onMonthFailed,
      fetchMonth: async () => { throw new Error('500'); },
    });

    expect(out).toEqual([]);
    expect(onMonthFailed).toHaveBeenCalledWith('2026-05');
    expect(mod.hasMonthCached('mf', '2026-05')).toBe(false);
  });
});

// ── IDB: entradas corruptas y keys mensuales persistidas ─────────────────

describe('dailyApiCache — IDB con entradas no-array y keys mensuales', () => {
  it('persiste una key mensual (sin día) y devuelve null si records no es un arreglo', async () => {
    const first = await freshCache();
    await first.primeDailyCache();
    first.setMonthCached('mo', '2026-05', [{ v: 1 }], undefined, TODAY);
    await settle();

    const store = fake.databases.get('midas-daily-cache')!.stores.get('entries')!;
    expect(store.has('M:mo.__all__.2026-05')).toBe(true);
    store.set('corr.__all__.2026-06-01', {
      key: 'corr.__all__.2026-06-01', day: '2026-06-01', records: 'no-es-arreglo',
    });

    const second = await freshCache();
    await second.primeDailyCache();
    expect(second.hasDailyCached('corr', '2026-06-01')).toBe(true);
    expect(await second.getDailyCachedAsync('corr', '2026-06-01')).toBeNull();
    // La key mensual sobrevive el reload y se lee desde disco.
    expect(await second.getMonthCachedAsync('mo', '2026-05')).toEqual([{ v: 1 }]);
  });
});

// ── IDB rota: transaction() lanza en todos los caminos ───────────────────

describe('dailyApiCache — IDB que lanza en transaction()', () => {
  it('prime/persist/read/delete/clear degradan en silencio', async () => {
    const broken = new FakeIDBDatabase();
    broken.createObjectStore('entries', { keyPath: 'key' });
    broken.transaction = () => { throw new Error('IDB rota'); };
    fake.databases.set('midas-daily-cache', broken);
    // Una key legacy vieja fuerza el prune → su delete en IDB también truena.
    localStorage.setItem('midas.daily.viejo.__all__.2020-01-01', JSON.stringify([{ v: 1 }]));

    const mod = await freshCache();
    await mod.primeDailyCache();
    await settle();
    // `getAllKeys` falló, así que el índice arranca vacío (y la key legacy
    // migrada quedó fuera del retención de 800 días → podada).
    expect(mod.hasDailyCached('viejo', '2020-01-01')).toBe(false);

    // 300 escrituras: las primeras salen del buffer FIFO y su lectura tiene
    // que ir a IDB… que truena → null en vez de reventar.
    const base = '2025-01-01';
    for (let i = 0; i < 300; i++) {
      mod.setDailyCached('bk', addDays(base, i), [{ i }], undefined, TODAY);
    }
    await settle();
    expect(mod.hasDailyCached('bk', base)).toBe(true);
    expect(await mod.getDailyCachedAsync('bk', base)).toBeNull();

    mod.deleteDailyCached('bk', base);
    await settle();
    expect(mod.hasDailyCached('bk', base)).toBe(false);

    await expect(mod.clearDailyCache('bk')).resolves.toBeGreaterThan(0);
    expect(mod.dailyCacheStats('bk')).toEqual({ count: 0, days: [] });
  });
});

// ── Prune sin IDB + requestIdleCallback disponible ───────────────────────

describe('dailyApiCache — prune agendado con requestIdleCallback', () => {
  it('poda la entrada legacy fuera de retención agendando el delete en idle', async () => {
    const ric = vi.fn((cb: () => void) => { cb(); return 1; });
    // El módulo lo lee de `window`, no de `globalThis` — hay que ponerlo ahí.
    (window as unknown as Record<string, unknown>).requestIdleCallback = ric;
    // Payload legacy en forma de ARREGLO plano (variante sin `{ records }`).
    localStorage.setItem('midas.daily.old.__all__.2020-01-01', JSON.stringify([{ v: 1 }]));

    const mod = await freshCache();
    await mod.primeDailyCache();
    await settle();

    expect(ric).toHaveBeenCalled();
    expect(mod.hasDailyCached('old', '2020-01-01')).toBe(false);
    expect(localStorage.getItem('midas.daily.old.__all__.2020-01-01')).toBeNull();
  });
});

// ── Migración legacy: variantes de payload ───────────────────────────────

describe('dailyApiCache — migración legacy de localStorage', () => {
  it('ignora keys ajenas, vacías, corruptas y sin `records`; migra arreglo y { records }', async () => {
    localStorage.setItem('otra.key.no-legacy', 'intacta');
    localStorage.setItem('midas.daily.a.__all__.2026-06-01', '');
    localStorage.setItem('midas.daily.b.__all__.2026-06-02', '{esto no es json');
    localStorage.setItem('midas.daily.c.__all__.2026-06-03', JSON.stringify({ otro: 1 }));
    localStorage.setItem('midas.daily.d.__all__.2026-06-04', JSON.stringify([{ v: 1 }]));
    localStorage.setItem('midas.daily.e.__all__.2026-06-05', JSON.stringify({ records: [{ v: 2 }] }));

    const mod = await freshCache();
    await mod.primeDailyCache();
    await settle();

    expect(mod.hasDailyCached('a', '2026-06-01')).toBe(false);
    expect(mod.hasDailyCached('b', '2026-06-02')).toBe(false);
    expect(mod.hasDailyCached('c', '2026-06-03')).toBe(false);
    expect(await mod.getDailyCachedAsync('d', '2026-06-04')).toEqual([{ v: 1 }]);
    expect(await mod.getDailyCachedAsync('e', '2026-06-05')).toEqual([{ v: 2 }]);
    // Toda key legacy se borra de localStorage; las ajenas no se tocan.
    expect(localStorage.getItem('midas.daily.d.__all__.2026-06-04')).toBeNull();
    expect(localStorage.getItem('otra.key.no-legacy')).toBe('intacta');
  });

  it('un removeItem que truena no aborta la migración', async () => {
    localStorage.setItem('midas.daily.f.__all__.2026-06-06', JSON.stringify([{ v: 3 }]));
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('quota / storage bloqueado');
    });

    const mod = await freshCache();
    await mod.primeDailyCache();
    await settle();

    expect(await mod.getDailyCachedAsync('f', '2026-06-06')).toEqual([{ v: 3 }]);
  });

  it('sin localStorage la migración se salta sin romper el prime', async () => {
    vi.stubGlobal('localStorage', undefined);
    const mod = await freshCache();
    await expect(mod.primeDailyCache()).resolves.toBeUndefined();
    expect(mod.isDailyCachePersistent()).toBe(true);
  });
});

// ── Apertura de IDB: excepción dura y timeouts transitorios ──────────────

describe('dailyApiCache — apertura de IDB', () => {
  it('indexedDB.open que lanza degrada a memory-only en el primer intento', async () => {
    vi.stubGlobal('indexedDB', {
      open() { throw new Error('acceso denegado'); },
    });

    const mod = await freshCache();
    await mod.primeDailyCache();
    expect(mod.isDailyCachePersistent()).toBe(false);
    mod.setDailyCached('mem', '2026-06-01', [{ v: 1 }], undefined, TODAY);
    expect(await mod.getDailyCachedAsync('mem', '2026-06-01')).toEqual([{ v: 1 }]);
  });

  it('timeouts consecutivos agotan los reintentos y cierran la conexión que llegó tarde', async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    let attempts = 0;
    vi.stubGlobal('indexedDB', {
      open() {
        attempts += 1;
        const isFirst = attempts === 1;
        const req: Record<string, unknown> = {
          onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null,
          result: null, error: null,
        };
        if (isFirst) {
          // Éxito TARDÍO: llega después del timeout de 2.5s del intento.
          setTimeout(() => {
            req.result = {
              close,
              objectStoreNames: { contains: () => true },
              createObjectStore: () => {},
              transaction: () => { throw new Error('no debería usarse'); },
            };
            (req.onsuccess as (() => void) | null)?.();
          }, 4000);
        }
        // Los intentos 2 y 3 nunca emiten evento → siempre 'retry'.
        return req;
      },
    });

    const mod = await freshCache();
    const primed = mod.primeDailyCache();
    await vi.advanceTimersByTimeAsync(30_000);
    await primed;

    expect(attempts).toBe(3);
    expect(close).toHaveBeenCalled();
    expect(mod.isDailyCachePersistent()).toBe(false);
  });

  it('un error que llega DESPUÉS del timeout no re-resuelve el intento', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('indexedDB', {
      open() {
        const req: Record<string, unknown> = {
          onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null,
          result: null, error: new Error('tarde'),
        };
        setTimeout(() => { (req.onerror as (() => void) | null)?.(); }, 4000);
        return req;
      },
    });

    const mod = await freshCache();
    const primed = mod.primeDailyCache();
    await vi.advanceTimersByTimeAsync(30_000);
    await primed;

    expect(mod.isDailyCachePersistent()).toBe(false);
  });
});
