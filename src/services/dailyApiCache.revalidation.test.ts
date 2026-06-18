import { describe, it, expect, vi, beforeAll } from 'vitest';
import {
  fetchRangeWithMonthlyCache,
  fetchRangeWithDailyCache,
  setMonthCached,
  setDailyCached,
  primeDailyCache,
} from './dailyApiCache';

// Frescura de datos (Etapa 1): el cache mensual/diario servía meses/días
// pasados SIEMPRE del cache, así que un registro que cambia de estado en JDE
// después de cachearse (una OC creada→recibida→facturada, un pago capturado
// con atraso) quedaba stale para siempre. `revalidateMonths` / `revalidateSince`
// re-piden exactamente lo relevante sin re-pedir todo el histórico.

const TODAY = '2026-06-17';

describe('fetchRangeWithMonthlyCache — revalidateMonths', () => {
  beforeAll(async () => {
    await primeDailyCache();
  });

  it('re-pide SOLO los meses del set aunque estén cacheados; el resto sale del cache', async () => {
    const api = 'test-monthly-reval';
    setMonthCached(api, '2026-03', [{ m: '2026-03', v: 1 }], undefined, TODAY);
    setMonthCached(api, '2026-04', [{ m: '2026-04', v: 1 }], undefined, TODAY);
    setMonthCached(api, '2026-05', [{ m: '2026-05', v: 1 }], undefined, TODAY);

    const fetchedMonths: string[] = [];
    const fetchMonth = vi.fn(async (from: string) => {
      const month = from.slice(0, 7);
      fetchedMonths.push(month);
      return [{ m: month, v: 2 }];
    });

    const result = await fetchRangeWithMonthlyCache<{ m: string; v: number }>(api, {
      from: '2026-03-01',
      to: '2026-05-31',
      fetchMonth,
      today: TODAY,
      revalidateMonths: new Set(['2026-05']),
    });

    // Solo mayo pegó a la red; marzo y abril se sirvieron del cache.
    expect(fetchedMonths).toEqual(['2026-05']);
    const byMonth = Object.fromEntries(result.map((r) => [r.m, r.v]));
    expect(byMonth['2026-03']).toBe(1); // cache
    expect(byMonth['2026-04']).toBe(1); // cache
    expect(byMonth['2026-05']).toBe(2); // revalidado
  });

  it('sin revalidateMonths sirve TODOS los meses pasados del cache (comportamiento previo)', async () => {
    const api = 'test-monthly-noreval';
    setMonthCached(api, '2026-04', [{ m: '2026-04', v: 1 }], undefined, TODAY);

    const fetchMonth = vi.fn(async () => [{ m: 'x', v: 2 }]);
    const result = await fetchRangeWithMonthlyCache(api, {
      from: '2026-04-01',
      to: '2026-04-30',
      fetchMonth,
      today: TODAY,
    });

    expect(fetchMonth).not.toHaveBeenCalled();
    expect(result).toEqual([{ m: '2026-04', v: 1 }]);
  });

  it('el re-fetch reescribe el cache: una segunda pasada sin set ya sale del cache nuevo', async () => {
    const api = 'test-monthly-rewrite';
    setMonthCached(api, '2026-05', [{ m: '2026-05', v: 1 }], undefined, TODAY);

    const fetchMonth = vi.fn(async (from: string) => [{ m: from.slice(0, 7), v: 9 }]);
    await fetchRangeWithMonthlyCache(api, {
      from: '2026-05-01',
      to: '2026-05-31',
      fetchMonth,
      today: TODAY,
      revalidateMonths: new Set(['2026-05']),
    });
    expect(fetchMonth).toHaveBeenCalledTimes(1);

    fetchMonth.mockClear();
    const second = await fetchRangeWithMonthlyCache(api, {
      from: '2026-05-01',
      to: '2026-05-31',
      fetchMonth,
      today: TODAY,
    });
    expect(fetchMonth).not.toHaveBeenCalled();
    expect(second).toEqual([{ m: '2026-05', v: 9 }]);
  });
});

describe('fetchRangeWithDailyCache — revalidateSince', () => {
  beforeAll(async () => {
    await primeDailyCache();
  });

  it('re-pide días pasados >= revalidateSince y sirve los anteriores del cache', async () => {
    const api = 'test-daily-reval';
    setDailyCached(api, '2026-06-01', [{ d: '2026-06-01', v: 1 }], undefined, TODAY);
    setDailyCached(api, '2026-06-10', [{ d: '2026-06-10', v: 1 }], undefined, TODAY);

    const fetchedDays: string[] = [];
    const fetchDay = vi.fn(async (day: string) => {
      fetchedDays.push(day);
      return [{ d: day, v: 2 }];
    });

    const result = await fetchRangeWithDailyCache<{ d: string; v: number }>(api, {
      from: '2026-06-01',
      to: '2026-06-10',
      fetchDay,
      today: TODAY,
      revalidateSince: '2026-06-10',
    });

    // 06-10 estaba cacheado pero >= revalidateSince → se re-pide.
    expect(fetchedDays).toContain('2026-06-10');
    // 06-01 estaba cacheado y < revalidateSince → NO se re-pide.
    expect(fetchedDays).not.toContain('2026-06-01');

    const byDay = Object.fromEntries(result.map((r) => [r.d, r.v]));
    expect(byDay['2026-06-01']).toBe(1); // cache
    expect(byDay['2026-06-10']).toBe(2); // revalidado
  });

  it('sin revalidateSince sirve los días pasados cacheados (comportamiento previo)', async () => {
    const api = 'test-daily-noreval';
    setDailyCached(api, '2026-06-05', [{ d: '2026-06-05', v: 1 }], undefined, TODAY);

    const fetchDay = vi.fn(async (day: string) => [{ d: day, v: 2 }]);
    const result = await fetchRangeWithDailyCache(api, {
      from: '2026-06-05',
      to: '2026-06-05',
      fetchDay,
      today: TODAY,
    });

    expect(fetchDay).not.toHaveBeenCalled();
    expect(result).toEqual([{ d: '2026-06-05', v: 1 }]);
  });
});
