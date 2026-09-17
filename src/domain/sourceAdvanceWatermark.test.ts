import { describe, expect, it } from 'vitest';
import {
  assessSourceAdvance,
  assessSourceAdvanceAll,
  isSourceStalled,
  loadSourceAdvanceMarks,
  saveSourceAdvanceMarks,
  SOURCE_ADVANCE_KEY,
  SOURCE_ADVANCE_STALL_BUSINESS_DAYS,
  type SourceAdvanceMarks,
} from './sourceAdvanceWatermark';

function fakeStorage(seed?: string): Storage {
  const map = new Map<string, string>();
  if (seed !== undefined) map.set(SOURCE_ADVANCE_KEY, seed);
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k); },
    setItem: (k: string, v: string) => { map.set(k, v); },
  } as Storage;
}

describe('assessSourceAdvance', () => {
  it('no acusa en la PRIMERA observación: sin marca previa no hay contra qué comparar', () => {
    const v = assessSourceAdvance(undefined, '2026-08-31', '2026-09-14');
    expect(v.stalledBusinessDays).toBeNull();
    expect(v.next).toEqual({ maxDataDate: '2026-08-31', firstSeenAt: '2026-09-14' });
  });

  it('el máximo que sube resetea el reloj', () => {
    const v = assessSourceAdvance(
      { maxDataDate: '2026-09-01', firstSeenAt: '2026-09-01' },
      '2026-09-14',
      '2026-09-14',
    );
    expect(v.stalledBusinessDays).toBe(0);
    expect(v.next).toEqual({ maxDataDate: '2026-09-14', firstSeenAt: '2026-09-14' });
  });

  it('el máximo quieto cuenta días HÁBILES desde que se vio por primera vez', () => {
    // Caso real: `jde.Antiguedad_Saldos` cargó por última vez el 01-sep.
    const v = assessSourceAdvance(
      { maxDataDate: '2026-08-31', firstSeenAt: '2026-09-01' },
      '2026-08-31',
      '2026-09-14',
    );
    expect(v.stalledBusinessDays).toBe(9);
    // La marca NO se mueve: el reloj corre desde la primera vez, no desde hoy.
    expect(v.next).toEqual({ maxDataDate: '2026-08-31', firstSeenAt: '2026-09-01' });
  });

  it('un máximo que RETROCEDE conserva la marca y sigue contando desde firstSeenAt', () => {
    // Antes devolvía `null` para tolerar el transitorio del boot, pero eso dejaba
    // inmune PARA SIEMPRE a la fuente cuyo máximo baja de forma permanente (una
    // ventana que se acorta, una cía que deja de cargarse): cada evaluación
    // posterior seguía por esa rama y la fuente no podía acusarse nunca.
    const prev = { maxDataDate: '2026-09-14', firstSeenAt: '2026-09-01' };
    const v = assessSourceAdvance(prev, '2026-08-01', '2026-09-17');
    expect(v.next).toBe(prev);
    expect(v.stalledBusinessDays).toBe(11);
    // Lo que importa: ahora SÍ puede acusarse. Antes era `null` y esa fuente
    // quedaba fuera del panel para siempre.
    expect(isSourceStalled(v.stalledBusinessDays ?? undefined)).toBe(true);
  });

  it('el retroceso del boot NO produce falso positivo en una fuente sana', () => {
    // La razón por la que contar desde `firstSeenAt` es seguro: una fuente que
    // acaba de avanzar tiene `firstSeenAt` reciente, así que el conteo queda muy
    // por debajo del umbral aunque una ola del boot muestre un máximo menor.
    const prev = { maxDataDate: '2026-09-16', firstSeenAt: '2026-09-16' };
    const v = assessSourceAdvance(prev, '2026-09-10', '2026-09-17');
    expect(isSourceStalled(v.stalledBusinessDays ?? undefined)).toBe(false);
  });

  it('el parpadeo del boot es el precio ACEPTADO, y no corrompe la marca', () => {
    // Trade-off explícito: una fuente que YA llevaba días sin avanzar puede
    // acusarse unos segundos mientras la ola del boot se completa (el máximo se
    // ve menor de lo ya conocido). Se acepta porque un falso positivo
    // transitorio, visible y auto-corregible es mejor que el silencio
    // permanente que producía el `null`. Lo que NO se acepta es corromper la
    // marca: el retroceso conserva `prev` intacto, así que en cuanto la ola
    // sube el máximo el reloj vuelve a 0.
    const prev = { maxDataDate: '2026-09-16', firstSeenAt: '2026-09-01' };
    const transitorio = assessSourceAdvance(prev, '2026-08-20', '2026-09-17');
    expect(transitorio.next).toBe(prev);

    const olaCompleta = assessSourceAdvance(transitorio.next, '2026-09-17', '2026-09-17');
    expect(olaCompleta.stalledBusinessDays).toBe(0);
    expect(olaCompleta.next).toEqual({ maxDataDate: '2026-09-17', firstSeenAt: '2026-09-17' });
  });

  it('la fecha con hora se normaliza a 10 chars y la marca sobrevive la recarga', () => {
    // Sin el recorte, `isMark` descartaría la marca al releerla y la historia se
    // resetearía en cada arranque: la fuente nunca acumularía días ni acusaría.
    const v = assessSourceAdvance(undefined, '2026-09-17T02:00:44', '2026-09-17');
    expect(v.next?.maxDataDate).toBe('2026-09-17');
  });

  it('sin fecha usable no hay veredicto ni marca nueva', () => {
    const v = assessSourceAdvance(undefined, null, '2026-09-14');
    expect(v.stalledBusinessDays).toBeNull();
    expect(v.next).toBeUndefined();
  });
});

describe('isSourceStalled', () => {
  it('sólo pasa el umbral se llama muerta', () => {
    expect(isSourceStalled(undefined)).toBe(false);
    expect(isSourceStalled(0)).toBe(false);
    expect(isSourceStalled(SOURCE_ADVANCE_STALL_BUSINESS_DAYS)).toBe(false);
    expect(isSourceStalled(SOURCE_ADVANCE_STALL_BUSINESS_DAYS + 1)).toBe(true);
  });

  it('el umbral tolera la cadencia SEMANAL de la nómina', () => {
    // `paymentDate` avanza por semana (~5 días hábiles). Un umbral por debajo
    // de eso acusaría a una fuente sana cada semana.
    expect(SOURCE_ADVANCE_STALL_BUSINESS_DAYS).toBeGreaterThan(5);
  });
});

describe('assessSourceAdvanceAll', () => {
  it('juzga cada fuente por separado y sólo reporta las que tienen veredicto', () => {
    const prev: SourceAdvanceMarks = {
      'cxp-data-age': { maxDataDate: '2026-08-31', firstSeenAt: '2026-09-01' },
      'cobranza-data-age': { maxDataDate: '2026-09-11', firstSeenAt: '2026-09-11' },
    };
    const { next, stalledByKey } = assessSourceAdvanceAll(prev, {
      'cxp-data-age': '2026-08-31',
      'cobranza-data-age': '2026-09-14',
      'rol-data-age': '2026-09-14',
    }, '2026-09-14');

    expect(stalledByKey['cxp-data-age']).toBe(9);
    expect(stalledByKey['cobranza-data-age']).toBe(0);
    // Primera observación de ROL: sin veredicto, pero ya queda marcada.
    expect(stalledByKey['rol-data-age']).toBeUndefined();
    expect(next['rol-data-age']).toEqual({ maxDataDate: '2026-09-14', firstSeenAt: '2026-09-14' });
    expect(next['cxp-data-age']).toEqual(prev['cxp-data-age']);
  });
});

describe('persistencia', () => {
  it('ida y vuelta', () => {
    const store = fakeStorage();
    const marks: SourceAdvanceMarks = { a: { maxDataDate: '2026-09-01', firstSeenAt: '2026-09-02' } };
    saveSourceAdvanceMarks(marks, store);
    expect(loadSourceAdvanceMarks(store)).toEqual(marks);
  });

  it('descarta entrada por entrada un payload corrupto en vez de tirar', () => {
    const store = fakeStorage(JSON.stringify({
      buena: { maxDataDate: '2026-09-01', firstSeenAt: '2026-09-02' },
      sinFecha: { maxDataDate: 'ayer', firstSeenAt: '2026-09-02' },
      nula: null,
      texto: 'x',
    }));
    expect(loadSourceAdvanceMarks(store)).toEqual({
      buena: { maxDataDate: '2026-09-01', firstSeenAt: '2026-09-02' },
    });
  });

  it('JSON inválido devuelve vacío, no explota', () => {
    expect(loadSourceAdvanceMarks(fakeStorage('{no json'))).toEqual({});
  });

  it('un storage que lanza no rompe el flujo', () => {
    const hostile = {
      getItem: () => { throw new Error('bloqueado'); },
      setItem: () => { throw new Error('lleno'); },
    } as unknown as Storage;
    expect(loadSourceAdvanceMarks(hostile)).toEqual({});
    expect(() => saveSourceAdvanceMarks({ a: { maxDataDate: '2026-09-01', firstSeenAt: '2026-09-01' } }, hostile)).not.toThrow();
  });
});
