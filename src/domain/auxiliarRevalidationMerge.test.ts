import { describe, expect, it } from 'vitest';
import {
  isInAuxiliarRevalidationWindow,
  shouldMergeAuxiliarLine,
} from './auxiliarRevalidationMerge';

const SINCE = '2026-09-09';

describe('shouldMergeAuxiliarLine — la revalidación no se tira a la basura', () => {
  it('deja pasar una línea YA hidratada cuando cae en la ventana de revalidación', () => {
    // El caso que el mecanismo existe para cubrir: el loader re-pidió ese día
    // a la red porque la póliza pudo cambiar (importe corregido, reversa,
    // `estatusConciliado` → 'R'). Descartarla por "ya la vi" deja el refetch
    // inerte y el dato viejo publicado.
    expect(
      shouldMergeAuxiliarLine({
        fechaContable: '2026-09-15',
        revalidateSince: SINCE,
        alreadyMerged: false,
        alreadyHydrated: true,
      }),
    ).toBe(true);
  });

  it('deja pasar una línea ya acumulada en ESTE fetch si cae en la ventana', () => {
    expect(
      shouldMergeAuxiliarLine({
        fechaContable: SINCE,
        revalidateSince: SINCE,
        alreadyMerged: true,
        alreadyHydrated: true,
      }),
    ).toBe(true);
  });

  it('conserva el guard FUERA de la ventana: lo ya visto no se re-mergea', () => {
    // Sin esto el Map acumulador crece al rango completo (~334k líneas) en un
    // renderer con historial de OOM.
    expect(
      shouldMergeAuxiliarLine({
        fechaContable: '2026-01-15',
        revalidateSince: SINCE,
        alreadyMerged: false,
        alreadyHydrated: true,
      }),
    ).toBe(false);
    expect(
      shouldMergeAuxiliarLine({
        fechaContable: '2026-01-15',
        revalidateSince: SINCE,
        alreadyMerged: true,
        alreadyHydrated: false,
      }),
    ).toBe(false);
  });

  it('una llave NUEVA fuera de la ventana entra igual (comportamiento previo)', () => {
    expect(
      shouldMergeAuxiliarLine({
        fechaContable: '2026-01-15',
        revalidateSince: SINCE,
        alreadyMerged: false,
        alreadyHydrated: false,
      }),
    ).toBe(true);
  });

  it('una línea sin fecha usable queda FUERA de la ventana (degrada al guard previo)', () => {
    for (const fechaContable of [undefined, '', '   ']) {
      expect(isInAuxiliarRevalidationWindow(fechaContable, SINCE)).toBe(false);
      expect(
        shouldMergeAuxiliarLine({
          fechaContable,
          revalidateSince: SINCE,
          alreadyMerged: false,
          alreadyHydrated: true,
        }),
      ).toBe(false);
    }
  });

  it('una ventana vacía NO desactiva el guard', () => {
    // `'' >= ''` es true, así que comparar a secas contra una ventana vacía
    // marcaría TODA línea como revalidable y volvería el guard inoperante — el
    // Map acumularía el rango entero. Sin call site hoy (`isoDaysBefore`
    // siempre devuelve fecha), pineado para que siga sin serlo.
    expect(isInAuxiliarRevalidationWindow('', '')).toBe(false);
    expect(
      shouldMergeAuxiliarLine({
        fechaContable: '2026-09-15',
        revalidateSince: '',
        alreadyMerged: false,
        alreadyHydrated: true,
      }),
    ).toBe(false);
  });
});
