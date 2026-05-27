/**
 * Long-session simulation: prueba que `debouncedPersist` mantiene su
 * presupuesto de writes a localStorage bajo 1000s de cambios de estado.
 *
 * Sin debounce, una sesión "viva" con cientos de ediciones haría miles de
 * JSON.stringify + setItem síncronos en el main thread, saturando el budget
 * de input lag y la cuota de localStorage. El test simula 1000 updates en
 * ráfaga sobre un payload realista (~200 cell overrides) y mide:
 *   - cuántas veces realmente se persistió a "disco"
 *   - que el último valor SÍ termine persistido (no se pierde el trailing edge)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debouncedPersist, flushDebouncedPersist } from './debouncedPersist';

describe('long-session simulation', () => {
  beforeEach(() => {
    flushDebouncedPersist();
    vi.useFakeTimers();
  });
  afterEach(() => {
    flushDebouncedPersist();
    vi.useRealTimers();
  });

  it('1000 updates en ráfaga colapsan a un puñado de writes (no a 1000)', () => {
    const save = vi.fn();
    for (let i = 0; i < 1000; i++) {
      debouncedPersist('long.session.key', { iteration: i }, save);
    }
    // En la ráfaga sin avanzar timers, solo el leading-edge debe haber escrito.
    expect(save).toHaveBeenCalledTimes(1);
    // Avanzar > WINDOW_MS → trailing flush con el último valor.
    vi.advanceTimersByTime(300);
    expect(save).toHaveBeenCalledTimes(2);
    // Último valor preservado.
    expect(save).toHaveBeenLastCalledWith({ iteration: 999 });
  });

  it('alternar entre keys reduce writes vs. naive write-per-change', () => {
    const saveScenarios = vi.fn();
    const saveOverrides = vi.fn();
    const saveCustomRows = vi.fn();

    // Patrón realista: usuario alterna entre editar overrides, custom rows
    // y scenarios. Sin debounce serían 300 writes en main thread.
    for (let i = 0; i < 100; i++) {
      debouncedPersist('scenarios', { i }, saveScenarios);
      debouncedPersist('overrides', { i }, saveOverrides);
      debouncedPersist('customRows', { i }, saveCustomRows);
    }
    // Leading-edge en cada key (3 writes inmediatos), sin trailing aún.
    expect(saveScenarios).toHaveBeenCalledTimes(1);
    expect(saveOverrides).toHaveBeenCalledTimes(1);
    expect(saveCustomRows).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300);
    // Trailing flush: 1 extra write por key = 6 writes totales (vs 300 naive).
    expect(saveScenarios).toHaveBeenCalledTimes(2);
    expect(saveOverrides).toHaveBeenCalledTimes(2);
    expect(saveCustomRows).toHaveBeenCalledTimes(2);

    // Reducción del 98% en writes (6 vs 300).
    const totalWrites =
      saveScenarios.mock.calls.length +
      saveOverrides.mock.calls.length +
      saveCustomRows.mock.calls.length;
    expect(totalWrites).toBe(6);
  });

  it('ventana se reabre tras inactividad — segunda ráfaga vuelve a leading-edge sync', () => {
    const save = vi.fn();
    debouncedPersist('key.gap', 'a', save);
    vi.advanceTimersByTime(300); // expira la ventana
    debouncedPersist('key.gap', 'b', save); // primer call en ventana nueva
    // Sin avanzar más timers, "b" debe haberse escrito sync (leading-edge
    // tras gap > WINDOW_MS).
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith('b');
  });

  it('saves de objetos grandes (payload realista) no causan throw', () => {
    const save = vi.fn();
    // Simula cellOverrides realistas: 500 entries × 8 fields cada uno.
    const bigPayload = Array.from({ length: 500 }, (_, i) => ({
      id: `co-${i}`,
      scenarioId: 'approved',
      conceptKey: `concept-${i % 50}`,
      bucketKey: '2026-05',
      granularity: 'monthly' as const,
      type: 'OUTFLOW' as const,
      mode: 'REPLACE' as const,
      value: 1000 * i,
      note: 'auto-generated for test',
      createdBy: 'tesoreria@senda.local',
      createdAt: '2026-05-27T00:00:00Z',
      updatedAt: '2026-05-27T00:00:00Z',
    }));
    expect(() => debouncedPersist('cellOverrides.big', bigPayload, save)).not.toThrow();
    expect(save).toHaveBeenCalledTimes(1);
  });
});
