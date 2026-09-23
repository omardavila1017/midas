import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  newPlanningDocOrigin,
  notifyPlanningDocWritten,
  subscribePlanningDocs,
} from './planningDocSync';
import { debouncedPersist, resetDebouncedPersist } from './debouncedPersist';

afterEach(() => {
  resetDebouncedPersist();
});

describe('planningDocSync', () => {
  it('avisa al suscriptor la llave que escribió OTRO origen', () => {
    const seen: string[] = [];
    const stop = subscribePlanningDocs('planning#1', (key) => seen.push(key));
    notifyPlanningDocWritten('planning.cellOverrides', 'projection#2');
    stop();
    expect(seen).toEqual(['planning.cellOverrides']);
  });

  /**
   * La supresión por origen es lo que corta el ping-pong: sin ella el tablero
   * recargaría su propia escritura, eso crearía una identidad de arreglo nueva,
   * su efecto volvería a persistir, y los dos tableros se reenviarían el mismo
   * contenido indefinidamente.
   */
  it('NO avisa al origen que escribió', () => {
    const seen: string[] = [];
    const stop = subscribePlanningDocs('planning#1', (key) => seen.push(key));
    notifyPlanningDocWritten('planning.cellOverrides', 'planning#1');
    stop();
    expect(seen).toEqual([]);
  });

  it('un escritor sin identidad no se suprime para nadie', () => {
    const seen: string[] = [];
    const stop = subscribePlanningDocs('planning#1', (key) => seen.push(key));
    notifyPlanningDocWritten('planning.scenarios');
    stop();
    expect(seen).toEqual(['planning.scenarios']);
  });

  it('deja de escuchar al desuscribirse', () => {
    const seen: string[] = [];
    const stop = subscribePlanningDocs('planning#1', (key) => seen.push(key));
    stop();
    notifyPlanningDocWritten('planning.scenarios', 'projection#2');
    expect(seen).toEqual([]);
  });

  it('da una identidad distinta por instancia', () => {
    expect(newPlanningDocOrigin('planning')).not.toBe(newPlanningDocOrigin('planning'));
  });
});

describe('debouncedPersist → aviso', () => {
  it('avisa con la llave y el origen al persistir', () => {
    const seen: string[] = [];
    const stop = subscribePlanningDocs('otro', (key) => seen.push(key));
    const save = vi.fn();
    debouncedPersist('planning.adjustments', [1], save, 'projection#9');
    stop();
    expect(save).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['planning.adjustments']);
  });

  /**
   * El aviso cuelga de la escritura REAL: si el saver truena no debe anunciarse
   * un cambio que no ocurrió — el otro tablero recargaría el valor viejo y lo
   * re-persistiría como si fuera nuevo.
   */
  it('no avisa si la escritura falló', () => {
    const seen: string[] = [];
    const stop = subscribePlanningDocs('otro', (key) => seen.push(key));
    debouncedPersist('planning.customRows', [1], () => { throw new Error('quota'); }, 'projection#9');
    stop();
    expect(seen).toEqual([]);
  });
});
