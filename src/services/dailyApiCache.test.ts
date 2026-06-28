import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearDailyCache,
  fetchRangeWithChunkedDailyCache,
  fetchRangeWithDailyCache,
  fetchRangeWithMonthlyCache,
  getDailyCachedAsync,
  getMonthCachedAsync,
  hasDailyCached,
  isoDaysBefore,
  primeDailyCache,
  setDailyCached,
  setMonthCached,
} from './dailyApiCache';
import { todayISO } from '../formatters';

const today = todayISO();
const daysAgo = (n: number) => isoDaysBefore(today, n);

function prevMonth(): string {
  const [y, m] = today.slice(0, 7).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - 1, 1));
  return d.toISOString().slice(0, 7);
}

interface Rec { d: string; v: number }

afterEach(async () => {
  vi.restoreAllMocks();
  await primeDailyCache();
  for (const api of ['rv-daily', 'rv-daily-fb', 'rv-daily-empty', 'rv-daily-err', 'rv-monthly', 'rv-monthly-fb', 'rv-chunked', 'rv-chunked-fd', 'rv-chunked-fail']) {
    await clearDailyCache(api);
  }
});

// ── fetchRangeWithDailyCache: revalidación + fallback ─────────────────────

describe('fetchRangeWithDailyCache — revalidación de días cacheados', () => {
  it('re-pide un día CON datos dentro de revalidateSince y reescribe el cache (cura días parciales)', async () => {
    const day = daysAgo(3);
    await primeDailyCache();
    setDailyCached('rv-daily', day, [{ d: day, v: 1 }]);

    const fetchDay = vi.fn(async () => [{ d: day, v: 1 }, { d: day, v: 2 }]);
    const result = await fetchRangeWithDailyCache<Rec>('rv-daily', {
      from: day,
      to: day,
      fetchDay,
      revalidateSince: daysAgo(14),
    });

    expect(fetchDay).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(2);
    expect(await getDailyCachedAsync<Rec>('rv-daily', day)).toHaveLength(2);

    // Fuera de la ventana: se sirve del cache sin tocar la red.
    fetchDay.mockClear();
    const again = await fetchRangeWithDailyCache<Rec>('rv-daily', {
      from: day,
      to: day,
      fetchDay,
      revalidateSince: daysAgo(2),
    });
    expect(fetchDay).not.toHaveBeenCalled();
    expect(again).toHaveLength(2);
  });

  it('si el refetch de revalidación falla, sirve y CONSERVA el valor cacheado previo + onDayFailed', async () => {
    const day = daysAgo(2);
    await primeDailyCache();
    setDailyCached('rv-daily-fb', day, [{ d: day, v: 1 }]);

    const fetchDay = vi.fn(async () => { throw new Error('JDE caído'); });
    const failed: string[] = [];
    const result = await fetchRangeWithDailyCache<Rec>('rv-daily-fb', {
      from: day,
      to: day,
      fetchDay,
      revalidateSince: daysAgo(14),
      onDayFailed: (d) => failed.push(d),
    });

    expect(result).toEqual([{ d: day, v: 1 }]);
    expect(failed).toEqual([day]);
    // El cache no se degradó: el valor previo sigue ahí.
    expect(await getDailyCachedAsync<Rec>('rv-daily-fb', day)).toEqual([{ d: day, v: 1 }]);
  });

  it('un día SIN cache cuyo fetch falla NO se cachea y reporta onDayFailed', async () => {
    const day = daysAgo(2);
    await primeDailyCache();

    const fetchDay = vi.fn(async () => { throw new Error('timeout'); });
    const failed: string[] = [];
    const result = await fetchRangeWithDailyCache<Rec>('rv-daily-err', {
      from: day,
      to: day,
      fetchDay,
      onDayFailed: (d) => failed.push(d),
    });

    expect(result).toEqual([]);
    expect(failed).toEqual([day]);
    expect(hasDailyCached('rv-daily-err', day)).toBe(false);
  });
});

// ── fetchRangeWithMonthlyCache: revalidación + fallback ───────────────────

describe('fetchRangeWithMonthlyCache — revalidación de meses cacheados', () => {
  it('re-pide un mes en revalidateMonths aunque esté cacheado y reescribe el cache', async () => {
    const month = prevMonth();
    await primeDailyCache();
    setMonthCached('rv-monthly', month, [{ d: `${month}-05`, v: 1 }]);

    const fetchMonth = vi.fn(async () => [{ d: `${month}-05`, v: 1 }, { d: `${month}-28`, v: 2 }]);
    const result = await fetchRangeWithMonthlyCache<Rec>('rv-monthly', {
      from: `${month}-01`,
      to: `${month}-15`,
      fetchMonth,
      revalidateMonths: new Set([month]),
    });

    expect(fetchMonth).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(2);
    expect(await getMonthCachedAsync<Rec>('rv-monthly', month)).toHaveLength(2);

    // Mes NO en el set: sirve del cache sin tocar la red.
    fetchMonth.mockClear();
    const again = await fetchRangeWithMonthlyCache<Rec>('rv-monthly', {
      from: `${month}-01`,
      to: `${month}-15`,
      fetchMonth,
      revalidateMonths: new Set([today.slice(0, 7)]),
    });
    expect(fetchMonth).not.toHaveBeenCalled();
    expect(again).toHaveLength(2);
  });

  it('si el refetch del mes falla, sirve el cache previo + onMonthFailed (y no lo borra)', async () => {
    const month = prevMonth();
    await primeDailyCache();
    setMonthCached('rv-monthly-fb', month, [{ d: `${month}-05`, v: 1 }]);

    const fetchMonth = vi.fn(async () => { throw new Error('500'); });
    const failed: string[] = [];
    const result = await fetchRangeWithMonthlyCache<Rec>('rv-monthly-fb', {
      from: `${month}-01`,
      to: `${month}-15`,
      fetchMonth,
      revalidateMonths: new Set([month]),
      onMonthFailed: (m) => failed.push(m),
    });

    expect(result).toEqual([{ d: `${month}-05`, v: 1 }]);
    expect(failed).toEqual([month]);
    expect(await getMonthCachedAsync<Rec>('rv-monthly-fb', month)).toEqual([{ d: `${month}-05`, v: 1 }]);
  });
});

// ── fetchRangeWithChunkedDailyCache: revalidación + failedDays ────────────

describe('fetchRangeWithChunkedDailyCache — revalidación y días fallidos', () => {
  it('revalidateSince fuerza re-fetch del chunk con días cacheados y reescribe por día', async () => {
    const d3 = daysAgo(3);
    const d2 = daysAgo(2);
    await primeDailyCache();
    setDailyCached('rv-chunked', d3, [{ d: d3, v: 1 }]);
    setDailyCached('rv-chunked', d2, []);

    const fetchChunk = vi.fn(async () => [
      { d: d3, v: 1 }, { d: d3, v: 2 }, { d: d2, v: 3 },
    ]);
    const result = await fetchRangeWithChunkedDailyCache<Rec>('rv-chunked', {
      from: d3,
      to: d2,
      chunkSize: 7,
      fetchChunk,
      dateOf: (r) => r.d,
      revalidateSince: daysAgo(14),
    });

    expect(fetchChunk).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(3);
    expect(await getDailyCachedAsync<Rec>('rv-chunked', d3)).toHaveLength(2);
    expect(await getDailyCachedAsync<Rec>('rv-chunked', d2)).toHaveLength(1);
  });

  it('failedDays del fallback per-día NO se cachean como [] y sirven el cache previo', async () => {
    const d3 = daysAgo(3);
    const d2 = daysAgo(2);
    await primeDailyCache();
    // d3 tenía un valor previo (revalidación); d2 nunca se ha cacheado.
    setDailyCached('rv-chunked-fd', d3, [{ d: d3, v: 9 }]);

    const fetchChunk = vi.fn(async () => ({
      records: [{ d: d2, v: 1 }],
      failedDays: [d3],
    }));
    const failed: string[] = [];
    const result = await fetchRangeWithChunkedDailyCache<Rec>('rv-chunked-fd', {
      from: d3,
      to: d2,
      chunkSize: 7,
      fetchChunk,
      dateOf: (r) => r.d,
      revalidateSince: daysAgo(14),
      onDayFailed: (d) => failed.push(d),
    });

    // d3 servido del cache previo (no degradado), d2 fresco.
    expect(result.map(r => r.v).sort()).toEqual([1, 9]);
    expect(failed).toEqual([d3]);
    // El día fallido conserva su valor previo — NO fue sobreescrito con [].
    expect(await getDailyCachedAsync<Rec>('rv-chunked-fd', d3)).toEqual([{ d: d3, v: 9 }]);
    expect(await getDailyCachedAsync<Rec>('rv-chunked-fd', d2)).toEqual([{ d: d2, v: 1 }]);
  });

  it('chunk que falla COMPLETO sirve del cache los días que ya tenía + onChunkFailed', async () => {
    const d3 = daysAgo(3);
    const d2 = daysAgo(2);
    await primeDailyCache();
    setDailyCached('rv-chunked-fail', d3, [{ d: d3, v: 5 }]);
    // d2 sin cachear → el chunk necesita fetch.

    const fetchChunk = vi.fn(async () => { throw new Error('red caída'); });
    const failedChunks: string[] = [];
    const result = await fetchRangeWithChunkedDailyCache<Rec>('rv-chunked-fail', {
      from: d3,
      to: d2,
      chunkSize: 7,
      fetchChunk,
      dateOf: (r) => r.d,
      onChunkFailed: (f, t) => failedChunks.push(`${f}..${t}`),
    });

    expect(result).toEqual([{ d: d3, v: 5 }]);
    expect(failedChunks).toEqual([`${d3}..${d2}`]);
    // El día sin cache sigue sin cachear (reintenta el próximo boot).
    expect(hasDailyCached('rv-chunked-fail', d2)).toBe(false);
    // El día cacheado no se degradó.
    expect(await getDailyCachedAsync<Rec>('rv-chunked-fail', d3)).toEqual([{ d: d3, v: 5 }]);
  });
});
