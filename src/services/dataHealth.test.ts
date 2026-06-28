import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetDataGapsForTests,
  clearDataLakeMarkers,
  countCachedRecordsByDay,
  getDataGaps,
  reportDataGap,
  summarizeLocalCache,
} from './dataHealth';
import {
  clearDailyCache,
  isoDaysBefore,
  primeDailyCache,
  setDailyCached,
  setMonthCached,
} from './dailyApiCache';
import { todayISO } from '../formatters';

beforeEach(() => {
  __resetDataGapsForTests();
});

afterEach(async () => {
  __resetDataGapsForTests();
  await primeDailyCache();
  await clearDailyCache('dh-sum');
  await clearDailyCache('dh-counts');
});

describe('registro de huecos de la sesión', () => {
  it('acumula y expone los huecos reportados', () => {
    reportDataGap('banks', 'day-failed', '2026-06-10');
    reportDataGap('compras', 'month-failed', '00011 2026-05');
    const gaps = getDataGaps();
    expect(gaps).toHaveLength(2);
    expect(gaps[0]).toMatchObject({ dataset: 'banks', kind: 'day-failed', detail: '2026-06-10' });
    expect(gaps[1]).toMatchObject({ dataset: 'compras', kind: 'month-failed' });
  });
});

describe('clearDataLakeMarkers', () => {
  it('borra los markers de saneo de bancos (v1 + v2)', () => {
    localStorage.setItem('midas.banks.emptyDayHeal.v1', '2026-06-10');
    localStorage.setItem('midas.banks.emptyDayHeal.v2', '2026-06-12');
    clearDataLakeMarkers();
    expect(localStorage.getItem('midas.banks.emptyDayHeal.v1')).toBeNull();
    expect(localStorage.getItem('midas.banks.emptyDayHeal.v2')).toBeNull();
  });
});

describe('diagnóstico del cache local', () => {
  const today = todayISO();
  const daysAgo = (n: number) => isoDaysBefore(today, n);

  it('summarizeLocalCache agrega por (api, cia) con días y meses', async () => {
    await primeDailyCache();
    setDailyCached('dh-sum', daysAgo(3), [{ v: 1 }]);
    setDailyCached('dh-sum', daysAgo(2), []);
    setMonthCached('dh-sum', '2026-04', [{ v: 1 }, { v: 2 }]);

    const summary = await summarizeLocalCache();
    const entry = summary.find((e) => e.api === 'dh-sum');
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({ cia: '__all__', days: 2, months: 1 });
  });

  it('countCachedRecordsByDay regresa el conteo por día — la herramienta del caso "300 vs 330"', async () => {
    await primeDailyCache();
    setDailyCached('dh-counts', daysAgo(3), [{ v: 1 }, { v: 2 }, { v: 3 }]);
    setDailyCached('dh-counts', daysAgo(2), []);

    const counts = await countCachedRecordsByDay('dh-counts');
    expect(counts[`__all__::${daysAgo(3)}`]).toBe(3);
    expect(counts[`__all__::${daysAgo(2)}`]).toBe(0);
  });
});
