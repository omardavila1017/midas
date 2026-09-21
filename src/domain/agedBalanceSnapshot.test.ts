import { describe, it, expect } from 'vitest';
import { agedBalanceSnapshotStamp, keepLatestAgedBalanceSnapshot } from './agedBalanceSnapshot';

const row = (over: Partial<{ fechaVence: string; diasVencida: number; importePendientePesos: number }> = {}) => ({
  fechaVence: '2026-12-13',
  diasVencida: -86,
  importePendientePesos: 1000,
  ...over,
});

describe('agedBalanceSnapshotStamp', () => {
  // Fila real del snapshot del 18-sep: vence 13-dic, faltan 86 días.
  it('reconstruye el día de la carga con fechaVence + diasVencida', () => {
    expect(agedBalanceSnapshotStamp(row())).toBe('2026-09-18');
  });

  it('funciona igual con el documento ya vencido (diasVencida positivo)', () => {
    expect(agedBalanceSnapshotStamp(row({ fechaVence: '2026-08-09', diasVencida: 40 })))
      .toBe('2026-09-18');
  });

  it('sin señal utilizable devuelve null en vez de inventar una fecha', () => {
    expect(agedBalanceSnapshotStamp(row({ fechaVence: '' }))).toBeNull();
    expect(agedBalanceSnapshotStamp(row({ fechaVence: '13-12-2026' }))).toBeNull();
    expect(agedBalanceSnapshotStamp(row({ diasVencida: Number.NaN }))).toBeNull();
  });
});

describe('keepLatestAgedBalanceSnapshot', () => {
  it('descarta las filas de cargas anteriores y conserva el snapshot vivo', () => {
    // Las dos cargas que convivían en la BD el 2026-09-18: la del 14-sep (rota,
    // sin truncar) y la de hoy. Sin el corte, Midas publicaba la suma.
    const stale = [
      row({ diasVencida: -90, importePendientePesos: 92_809_223.54 }),
      row({ diasVencida: -90, importePendientePesos: 100 }),
    ];
    const live = [
      row({ importePendientePesos: 88_399_294.40 }),
      row({ importePendientePesos: 200 }),
    ];

    const out = keepLatestAgedBalanceSnapshot([...stale, ...live], '2026-09-18');

    expect(out.latestStamp).toBe('2026-09-18');
    expect(out.kept).toEqual(live);
    expect(out.dropped).toBe(2);
    expect(out.droppedAmount).toBeCloseTo(92_809_323.54, 2);
    expect(out.staleStamps).toEqual(['2026-09-14']);
  });

  it('degrada solo: con una sola carga devuelve la entrada intacta', () => {
    const records = [row(), row({ importePendientePesos: 7 })];
    const out = keepLatestAgedBalanceSnapshot(records, '2026-09-18');
    expect(out.kept).toEqual(records);
    expect(out.dropped).toBe(0);
  });

  it('CONSERVA la fila sin señal: nunca se descarta pasivo por falta de dato', () => {
    const sinSenal = row({ fechaVence: '', importePendientePesos: 5_000 });
    const out = keepLatestAgedBalanceSnapshot(
      [sinSenal, row({ diasVencida: -90 }), row(), row()],
      '2026-09-18',
    );
    expect(out.kept).toContain(sinSenal);
    expect(out.dropped).toBe(1);
  });

  it('un sello FUTURO no puede tirar el snapshot entero', () => {
    // Guarda 1: una carga no se pudo correr en el futuro, así que ese sello no
    // elige (van DOS filas, para que no sea la guarda del conteo la que actúa);
    // las filas igual se conservan — nunca se descarta por sospecha.
    const futuras = [
      row({ diasVencida: -80, importePendientePesos: 3 }),
      row({ diasVencida: -80, importePendientePesos: 4 }),
    ];
    const out = keepLatestAgedBalanceSnapshot([...futuras, row(), row()], '2026-09-18');
    expect(out.latestStamp).toBe('2026-09-18');
    expect(out.kept).toEqual(expect.arrayContaining(futuras));
    expect(out.dropped).toBe(0);
  });

  it('una fila sola no es evidencia de una carga: no elige sello', () => {
    // Guarda 2: sin esto, una fila internamente inconsistente fechada un día
    // después dejaría el CXP en ceros.
    const rogue = row({ diasVencida: -85, importePendientePesos: 1 });
    const reales = [row(), row(), row()];
    const out = keepLatestAgedBalanceSnapshot([rogue, ...reales], '2026-09-19');
    expect(out.latestStamp).toBe('2026-09-18');
    expect(out.dropped).toBe(0);
    expect(out.kept).toHaveLength(4);
  });

  it('sin ninguna fila con señal no aplica el corte', () => {
    const records = [row({ fechaVence: '' }), row({ fechaVence: '' })];
    const out = keepLatestAgedBalanceSnapshot(records, '2026-09-18');
    expect(out.latestStamp).toBeNull();
    expect(out.kept).toEqual(records);
  });
});
