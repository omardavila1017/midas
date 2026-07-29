import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetDataGapsForTests,
  clearDataLakeMarkers,
  countCachedRecordsByDay,
  countCachedRecordsByMonth,
  getDataGaps,
  publishDataHealthDiagnostics,
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
  await clearDailyCache('dh-months');
  await clearDailyCache('dh-scope');
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

  it('cada hueco lleva timestamp ISO parseable', () => {
    reportDataGap('rol', 'window-failed', '2026-01-01..2026-01-31');
    const [gap] = getDataGaps();
    expect(Number.isNaN(Date.parse(gap.at))).toBe(false);
  });

  it('respeta el cap de 500 huecos descartando los más viejos (FIFO)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 505; i++) {
      reportDataGap('banks', 'day-failed', `detail-${i}`);
    }
    const gaps = getDataGaps();
    expect(gaps).toHaveLength(500);
    // Los primeros 5 se descartaron; el más viejo restante es detail-5.
    expect(gaps[0].detail).toBe('detail-5');
    expect(gaps[gaps.length - 1].detail).toBe('detail-504');
    warn.mockRestore();
  });

  it('getDataGaps regresa una copia — mutarla no toca el registro interno', () => {
    reportDataGap('banks', 'cia-failed', '00011');
    const copy = getDataGaps();
    copy.push({ dataset: 'fake', kind: 'day-failed', detail: 'x', at: 'y' });
    copy.length = 0;
    expect(getDataGaps()).toHaveLength(1);
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

  it('countCachedRecordsByDay filtra por cia y por rango from/to', async () => {
    await primeDailyCache();
    setDailyCached('dh-scope', daysAgo(5), [{ v: 1 }], '00011');
    setDailyCached('dh-scope', daysAgo(3), [{ v: 1 }, { v: 2 }], '00011');
    setDailyCached('dh-scope', daysAgo(3), [{ v: 9 }], '00033');

    // Filtro por cia.
    const byCia = await countCachedRecordsByDay('dh-scope', '00011');
    expect(Object.keys(byCia)).toEqual([`00011::${daysAgo(5)}`, `00011::${daysAgo(3)}`].sort());
    expect(byCia[`00011::${daysAgo(3)}`]).toBe(2);
    expect(byCia[`00033::${daysAgo(3)}`]).toBeUndefined();

    // Filtro por rango: from excluye el día 5-atrás; to excluye días recientes.
    const ranged = await countCachedRecordsByDay('dh-scope', '00011', daysAgo(4), daysAgo(2));
    expect(Object.keys(ranged)).toEqual([`00011::${daysAgo(3)}`]);

    // Un api que no existe regresa objeto vacío.
    expect(await countCachedRecordsByDay('dh-no-existe')).toEqual({});
  });

  it('countCachedRecordsByMonth cuenta caches mensuales y filtra por cia', async () => {
    await primeDailyCache();
    setMonthCached('dh-months', '2026-03', [{ v: 1 }, { v: 2 }], '00011');
    setMonthCached('dh-months', '2026-04', [], '00011');
    setMonthCached('dh-months', '2026-03', [{ v: 9 }], '00033');
    // Un cache diario del mismo api NO debe contarse como mensual.
    setDailyCached('dh-months', daysAgo(2), [{ v: 1 }], '00011');

    const counts = await countCachedRecordsByMonth('dh-months');
    expect(counts['00011::2026-03']).toBe(2);
    expect(counts['00011::2026-04']).toBe(0);
    expect(counts['00033::2026-03']).toBe(1);
    expect(Object.keys(counts)).toHaveLength(3);

    const filtered = await countCachedRecordsByMonth('dh-months', '00033');
    expect(Object.keys(filtered)).toEqual(['00033::2026-03']);
  });

  it('summarizeLocalCache separa scopes por cia y trackea rango first/last', async () => {
    await primeDailyCache();
    setDailyCached('dh-scope', daysAgo(5), [{ v: 1 }], '00011');
    setDailyCached('dh-scope', daysAgo(3), [{ v: 1 }], '00011');
    setDailyCached('dh-scope', daysAgo(3), [{ v: 1 }], '00033');

    const summary = await summarizeLocalCache();
    const scopes = summary.filter((e) => e.api === 'dh-scope');
    expect(scopes).toHaveLength(2);
    const c11 = scopes.find((e) => e.cia === '00011');
    expect(c11).toMatchObject({ days: 2, months: 0, first: daysAgo(5), last: daysAgo(3) });
    const c33 = scopes.find((e) => e.cia === '00033');
    expect(c33).toMatchObject({ days: 1, months: 0, first: daysAgo(3), last: daysAgo(3) });
  });
});

describe('publishDataHealthDiagnostics', () => {
  it('publica window.__midas__.dataHealth preservando llaves previas y leyendo estado vivo', async () => {
    const w = window as unknown as { __midas__?: Record<string, unknown> };
    w.__midas__ = { existingKey: 'keep-me' };

    publishDataHealthDiagnostics();
    const dh = (w.__midas__ as Record<string, unknown>).dataHealth as {
      gaps: () => unknown[];
      coverage: () => Promise<unknown[]>;
      counts: (api: string) => Promise<Record<string, number>>;
      countsByMonth: (api: string) => Promise<Record<string, number>>;
    };
    expect(dh).toBeDefined();
    expect((w.__midas__ as Record<string, unknown>).existingKey).toBe('keep-me');

    // gaps() lee estado VIVO: reportar después de publicar se refleja.
    expect(dh.gaps()).toHaveLength(0);
    reportDataGap('banks', 'day-failed', '2026-06-10');
    expect(dh.gaps()).toHaveLength(1);

    await expect(dh.coverage()).resolves.toBeInstanceOf(Array);
    await expect(dh.counts('dh-no-existe')).resolves.toEqual({});
    await expect(dh.countsByMonth('dh-no-existe')).resolves.toEqual({});

    delete w.__midas__;
  });
});
