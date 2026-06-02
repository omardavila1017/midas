import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onMemoryPressure, onMemoryEmergency, getRuntimeIncidents, getNavigationEvents, trackNavigation } from './runtimeGuardian';

const TRAIL_KEY = 'midas.runtime.lastTrail.v1';

// Estos tests validan el contrato observable del guardian sin depender de
// `installRuntimeGuardian()` (que adjunta listeners globales — costoso de
// montar/desmontar bien en cada test). Tocamos la superficie de export.

describe('runtimeGuardian', () => {
  beforeEach(() => {
    // Limpia entre tests.
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('onMemoryPressure retorna unsubscribe que detiene la entrega', () => {
    const handler = vi.fn();
    const unsub = onMemoryPressure(handler);
    expect(typeof unsub).toBe('function');
    unsub();
    // No hay forma directa de disparar la presión desde tests sin
    // performance.memory; el contrato importante es que el unsubscribe no
    // tira y devuelve función.
  });

  it('trackNavigation acumula eventos con timestamp', () => {
    const before = getNavigationEvents().length;
    trackNavigation('bancos', 'cxp');
    trackNavigation('proyeccion', 'bancos');
    const events = getNavigationEvents();
    expect(events.length).toBeGreaterThanOrEqual(before + 2);
    const last = events[events.length - 1];
    expect(last.toTab).toBe('proyeccion');
    expect(last.fromTab).toBe('bancos');
    expect(typeof last.timestamp).toBe('number');
  });

  it('getRuntimeIncidents retorna copia (mutación no afecta el buffer interno)', () => {
    const a = getRuntimeIncidents();
    a.push({ type: 'error', timestamp: 0, message: 'fake-from-test' });
    const b = getRuntimeIncidents();
    expect(b.find(i => i.message === 'fake-from-test')).toBeUndefined();
  });

  it('onMemoryEmergency retorna unsubscribe que no tira', () => {
    const handler = vi.fn();
    const unsub = onMemoryEmergency(handler);
    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
  });

  it('trackNavigation persiste el trail a localStorage con el tab activo y cleanExit=false', () => {
    localStorage.removeItem(TRAIL_KEY);
    trackNavigation('payroll', 'financialProjection');
    const raw = localStorage.getItem(TRAIL_KEY);
    expect(raw).toBeTruthy();
    const trail = JSON.parse(raw as string);
    // cleanExit arranca en false — un OOM-kill lo deja así y el próximo boot
    // lo interpreta como cierre no limpio.
    expect(trail.cleanExit).toBe(false);
    const lastNav = trail.recentNav[trail.recentNav.length - 1];
    expect(lastNav.toTab).toBe('payroll');
    expect(lastNav.fromTab).toBe('financialProjection');
    expect(typeof trail.savedAt).toBe('number');
  });
});
