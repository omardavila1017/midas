import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debouncedPersist, flushDebouncedPersist } from './debouncedPersist';

describe('debouncedPersist', () => {
  beforeEach(() => {
    flushDebouncedPersist(); // estado limpio entre tests
    vi.useFakeTimers();
  });
  afterEach(() => {
    flushDebouncedPersist();
    vi.useRealTimers();
  });

  it('escribe SÍNCRONO la primera vez para un key (leading-edge)', () => {
    const save = vi.fn();
    debouncedPersist('test.key1', 'value-1', save);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('value-1');
  });

  it('coalesce ráfagas dentro de la ventana en un solo trailing flush', () => {
    const save = vi.fn();
    debouncedPersist('test.key2', 'a', save); // leading-edge fire
    debouncedPersist('test.key2', 'b', save);
    debouncedPersist('test.key2', 'c', save);
    debouncedPersist('test.key2', 'd', save);
    // Leading-edge ya disparó una vez; los 3 siguientes son dentro de ventana
    // → un solo trailing flush con el último valor.
    expect(save).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300); // > WINDOW_MS (250)
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith('d');
  });

  it('reduce 10 saves/ráfaga a 2 calls (leading + trailing) — confirma la coalescing', () => {
    const save = vi.fn();
    for (let i = 0; i < 10; i++) {
      debouncedPersist('test.key3', `v${i}`, save);
    }
    vi.advanceTimersByTime(300);
    expect(save).toHaveBeenCalledTimes(2); // 1 leading + 1 trailing
    expect(save).toHaveBeenLastCalledWith('v9');
  });

  it('flushDebouncedPersist fuerza writes pendientes sin esperar el timeout', () => {
    const save = vi.fn();
    debouncedPersist('test.key4', 'a', save); // leading
    debouncedPersist('test.key4', 'b', save); // queued
    expect(save).toHaveBeenCalledTimes(1);
    flushDebouncedPersist('test.key4');
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith('b');
  });

  it('keys distintos no se interfieren', () => {
    const saveA = vi.fn();
    const saveB = vi.fn();
    debouncedPersist('test.keyA', 'a1', saveA);
    debouncedPersist('test.keyB', 'b1', saveB);
    expect(saveA).toHaveBeenCalledWith('a1');
    expect(saveB).toHaveBeenCalledWith('b1');
  });
});
