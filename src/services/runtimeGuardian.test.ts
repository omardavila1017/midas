import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type GuardianModule = typeof import('./runtimeGuardian');

const TRAIL_KEY = 'midas.runtime.lastTrail.v1';

interface FakeMemory {
  jsHeapSizeLimit: number;
  totalJSHeapSize: number;
  usedJSHeapSize: number;
}

const LIMIT = 1000 * 1_048_576; // 1000 MB
let memory: FakeMemory | null;

function setHeapRatio(ratio: number): void {
  if (memory) memory.usedJSHeapSize = Math.round(LIMIT * ratio);
}

// Módulo fresco por test: el guardián tiene estado module-level (flag
// `started`, ring buffers, cooldowns) que no se puede resetear de otra forma.
async function freshGuardian(): Promise<GuardianModule> {
  vi.resetModules();
  return import('./runtimeGuardian');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  memory = { jsHeapSizeLimit: LIMIT, totalJSHeapSize: 0, usedJSHeapSize: Math.round(LIMIT * 0.3) };
  Object.defineProperty(performance, 'memory', {
    configurable: true,
    get: () => memory ?? undefined,
  });
});

afterEach(() => {
  delete (performance as unknown as Record<string, unknown>).memory;
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runtimeGuardian — incidentes globales', () => {
  it('captures window.error and unhandledrejection into the incident buffer', async () => {
    const mod = await freshGuardian();
    mod.installRuntimeGuardian();

    window.dispatchEvent(new ErrorEvent('error', { error: new Error('boom'), message: 'boom' }));
    const rejection = new Event('unhandledrejection') as Event & { reason?: unknown };
    rejection.reason = new Error('async-boom');
    window.dispatchEvent(rejection);

    const incidents = mod.getRuntimeIncidents();
    expect(incidents.some((i) => i.type === 'error' && i.message === 'boom')).toBe(true);
    expect(incidents.some((i) => i.type === 'unhandledrejection' && i.message === 'async-boom')).toBe(true);
  });

  it('is idempotent — a second install does not duplicate handlers', async () => {
    const mod = await freshGuardian();
    mod.installRuntimeGuardian();
    mod.installRuntimeGuardian();
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('once'), message: 'once' }));
    expect(mod.getRuntimeIncidents().filter((i) => i.message === 'once').length).toBe(1);
  });

  it('getRuntimeIncidents returns a copy — mutating it does not touch the buffer', async () => {
    const mod = await freshGuardian();
    const a = mod.getRuntimeIncidents();
    a.push({ type: 'error', timestamp: 0, message: 'fake-from-test' } as never);
    expect(mod.getRuntimeIncidents().find((i) => i.message === 'fake-from-test')).toBeUndefined();
  });
});

describe('runtimeGuardian — monitor de heap adaptativo', () => {
  it('logs a heap-warning at 60% and escalates to memory-pressure at 75% firing pressure handlers', async () => {
    const mod = await freshGuardian();
    const pressure = vi.fn();
    mod.onMemoryPressure(pressure);
    mod.installRuntimeGuardian();

    // Reposo: sin incidentes de heap
    expect(mod.getRuntimeIncidents().filter((i) => i.type === 'heap-warning' || i.type === 'memory-pressure')).toEqual([]);

    setHeapRatio(0.65);
    await vi.advanceTimersByTimeAsync(15_000); // intervalo lento
    expect(mod.getRuntimeIncidents().some((i) => i.type === 'heap-warning')).toBe(true);
    expect(pressure).not.toHaveBeenCalled();

    setHeapRatio(0.8);
    await vi.advanceTimersByTimeAsync(2_500); // ya en intervalo rápido
    expect(mod.getRuntimeIncidents().some((i) => i.type === 'memory-pressure')).toBe(true);
    expect(pressure).toHaveBeenCalledTimes(1);
  });

  it('fires emergency handlers at 90% with cooldowns for both tiers', async () => {
    const mod = await freshGuardian();
    const pressure = vi.fn();
    const emergency = vi.fn();
    mod.onMemoryPressure(pressure);
    mod.onMemoryEmergency(emergency);
    mod.installRuntimeGuardian();

    setHeapRatio(0.95);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(pressure).toHaveBeenCalledTimes(1);
    expect(emergency).toHaveBeenCalledTimes(1);

    // Cooldowns: dentro de 30s/60s no re-disparan
    await vi.advanceTimersByTimeAsync(2_500);
    expect(pressure).toHaveBeenCalledTimes(1);
    expect(emergency).toHaveBeenCalledTimes(1);

    // Pasado el cooldown de emergencia sigue >90% → re-dispara
    await vi.advanceTimersByTimeAsync(60_000);
    expect(emergency.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('never fires emergency handlers while the heap stays low', async () => {
    const mod = await freshGuardian();
    const emergency = vi.fn();
    mod.onMemoryEmergency(emergency);
    mod.installRuntimeGuardian();
    setHeapRatio(0.5);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(emergency).not.toHaveBeenCalled();
  });

  it('a pressure handler that throws does not break the rest', async () => {
    const mod = await freshGuardian();
    const bad = vi.fn(() => { throw new Error('handler-boom'); });
    const good = vi.fn();
    mod.onMemoryPressure(bad);
    mod.onMemoryPressure(good);
    mod.installRuntimeGuardian();
    setHeapRatio(0.8);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
  });

  it('unsubscribing a pressure handler stops future invocations', async () => {
    const mod = await freshGuardian();
    const handler = vi.fn();
    const off = mod.onMemoryPressure(handler);
    off();
    mod.installRuntimeGuardian();
    setHeapRatio(0.8);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('runtimeGuardian — trail post-mortem', () => {
  it('seeds the trail with cleanExit=false and marks it clean on pagehide', async () => {
    const mod = await freshGuardian();
    mod.installRuntimeGuardian();

    const seeded = JSON.parse(localStorage.getItem(TRAIL_KEY)!);
    expect(seeded.cleanExit).toBe(false);

    window.dispatchEvent(new Event('pagehide'));
    const closed = JSON.parse(localStorage.getItem(TRAIL_KEY)!);
    expect(closed.cleanExit).toBe(true);
    expect(closed.heap).toMatchObject({ limitMb: 1000 });
  });

  it('detects a dirty previous session (probable OOM) on next boot', async () => {
    const first = await freshGuardian();
    first.installRuntimeGuardian();
    first.trackNavigation('planeacion', 'bancos');
    // Sin pagehide: cleanExit queda false — simula OOM-kill.

    const warn = vi.mocked(console.warn);
    warn.mockClear();
    const second = await freshGuardian();
    second.installRuntimeGuardian();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('NO cerró limpio'))).toBe(true);

    const trail = (window as unknown as { __midas__: { runtime: { getLastTrail: () => { recentNav: { toTab: string }[] } } } })
      .__midas__.runtime.getLastTrail();
    expect(trail.recentNav[trail.recentNav.length - 1].toTab).toBe('planeacion');
  });

  it('trackNavigation records the tab with heap and persists immediately even before install', async () => {
    const mod = await freshGuardian();
    mod.trackNavigation('nomina', 'proyeccion');
    const navs = mod.getNavigationEvents();
    expect(navs[navs.length - 1]).toMatchObject({ toTab: 'nomina', fromTab: 'proyeccion' });
    expect(navs[navs.length - 1].heapMb).toBeGreaterThan(0);
    const trail = JSON.parse(localStorage.getItem(TRAIL_KEY)!);
    expect(trail.cleanExit).toBe(false);
    expect(trail.recentNav.some((n: { toTab: string }) => n.toTab === 'nomina')).toBe(true);
  });

  it('caps the incident ring buffer at 100', async () => {
    const mod = await freshGuardian();
    mod.installRuntimeGuardian();
    for (let i = 0; i < 120; i++) {
      window.dispatchEvent(new ErrorEvent('error', { error: new Error(`e${i}`), message: `e${i}` }));
    }
    const incidents = mod.getRuntimeIncidents();
    expect(incidents.length).toBeLessThanOrEqual(100);
    expect(incidents[incidents.length - 1].message).toBe('e119');
  });

  it('works without performance.memory (non-Chromium) — no heap incidents, no crash', async () => {
    memory = null;
    const mod = await freshGuardian();
    mod.installRuntimeGuardian();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mod.getRuntimeIncidents().filter((i) => i.type === 'heap-warning')).toEqual([]);
    mod.trackNavigation('bancos');
    const navs = mod.getNavigationEvents();
    expect(navs[navs.length - 1].heapMb).toBeUndefined();
  });
});
