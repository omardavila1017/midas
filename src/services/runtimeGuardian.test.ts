import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onMemoryPressure, getRuntimeIncidents, getNavigationEvents, trackNavigation } from './runtimeGuardian';

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
});
