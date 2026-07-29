import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cachedRun,
  clearProjectionRunCache,
  fingerprintArray,
  primeProjectionRunCache,
  projectionRunCache,
} from './projectionCache';

describe('projectionRunCache (LRU)', () => {
  beforeEach(() => {
    // Cache a nivel de módulo — sobrevive entre tests si no se limpia.
    clearProjectionRunCache();
  });

  it('cachedRun construye una sola vez y sirve el mismo objeto después', () => {
    const build = vi.fn(() => ({ run: 'A' }));
    const first = cachedRun('k1', build);
    const second = cachedRun('k1', build);
    expect(build).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('primeProjectionRunCache precarga un valor que cachedRun sirve sin construir', () => {
    const primed = { run: 'primed' };
    primeProjectionRunCache('warm', primed);
    const build = vi.fn(() => ({ run: 'fresh' }));
    expect(cachedRun('warm', build)).toBe(primed);
    expect(build).not.toHaveBeenCalled();
  });

  it('claves distintas construyen valores independientes', () => {
    const a = cachedRun('a', () => ({ v: 1 }));
    const b = cachedRun('b', () => ({ v: 2 }));
    expect(a).not.toBe(b);
    expect(projectionRunCache.get('a')).toBe(a);
    expect(projectionRunCache.get('b')).toBe(b);
  });

  it('evicta la entrada más vieja al superar la capacidad (4)', () => {
    for (const key of ['k1', 'k2', 'k3', 'k4', 'k5']) {
      primeProjectionRunCache(key, { key });
    }
    expect(projectionRunCache.get('k1')).toBeUndefined();
    for (const key of ['k2', 'k3', 'k4', 'k5']) {
      expect(projectionRunCache.get(key)).toEqual({ key });
    }
  });

  it('get refresca la recencia: la entrada leída sobrevive a la evicción', () => {
    for (const key of ['k1', 'k2', 'k3', 'k4']) {
      primeProjectionRunCache(key, { key });
    }
    // Toca k1 → ahora k2 es la más vieja.
    expect(projectionRunCache.get('k1')).toEqual({ key: 'k1' });
    primeProjectionRunCache('k5', { key: 'k5' });
    expect(projectionRunCache.get('k2')).toBeUndefined();
    expect(projectionRunCache.get('k1')).toEqual({ key: 'k1' });
  });

  it('re-set de una clave existente no evicta a otras (reemplaza en sitio)', () => {
    for (const key of ['k1', 'k2', 'k3', 'k4']) {
      primeProjectionRunCache(key, { key });
    }
    primeProjectionRunCache('k1', { key: 'k1-v2' });
    for (const key of ['k2', 'k3', 'k4']) {
      expect(projectionRunCache.get(key)).toEqual({ key });
    }
    expect(projectionRunCache.get('k1')).toEqual({ key: 'k1-v2' });
  });

  it('clearProjectionRunCache libera todo', () => {
    primeProjectionRunCache('k1', { key: 'k1' });
    clearProjectionRunCache();
    expect(projectionRunCache.get('k1')).toBeUndefined();
    const build = vi.fn(() => 'rebuilt');
    expect(cachedRun('k1', build)).toBe('rebuilt');
    expect(build).toHaveBeenCalledTimes(1);
  });
});

describe('fingerprintArray', () => {
  interface Item { id?: string; amount?: number }
  const pickId = (item: Item) => item.id;

  it('arreglo vacío regresa "0"', () => {
    expect(fingerprintArray([], pickId)).toBe('0');
  });

  it('es determinista para el mismo contenido', () => {
    const items: Item[] = [{ id: 'a' }, { id: 'b' }];
    expect(fingerprintArray(items, pickId)).toBe(fingerprintArray([{ id: 'a' }, { id: 'b' }], pickId));
  });

  it('prefija la longitud y cambia cuando cambia un valor', () => {
    const base = fingerprintArray([{ id: 'a' }, { id: 'b' }], pickId);
    expect(base.startsWith('2:')).toBe(true);
    const changed = fingerprintArray([{ id: 'a' }, { id: 'c' }], pickId);
    expect(changed).not.toBe(base);
  });

  it('cambia cuando cambia la longitud aunque el hash parcial coincida', () => {
    const one = fingerprintArray([{ id: 'a' }], pickId);
    const two = fingerprintArray([{ id: 'a' }, {}], pickId); // pick undefined no aporta hash
    expect(one.startsWith('1:')).toBe(true);
    expect(two.startsWith('2:')).toBe(true);
    expect(one).not.toBe(two);
  });

  it('ignora items cuyo pick regresa undefined (solo cuentan en la longitud)', () => {
    // Mismo largo, mismos valores definidos → mismo hash aunque haya huecos distintos.
    const a = fingerprintArray([{ id: 'x' }, {}], pickId);
    const b = fingerprintArray([{}, { id: 'x' }], pickId);
    expect(a).toBe(b);
  });

  it('acepta picks numéricos', () => {
    const pickAmount = (item: Item) => item.amount;
    const a = fingerprintArray([{ amount: 100 }], pickAmount);
    const b = fingerprintArray([{ amount: 200 }], pickAmount);
    expect(a).not.toBe(b);
  });
});
