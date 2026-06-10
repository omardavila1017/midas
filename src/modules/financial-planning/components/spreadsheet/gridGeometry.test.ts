import { describe, expect, it } from 'vitest';
import { computeVirtualWindow } from './gridGeometry';

// Regresión del bug "el scroll no funciona / no me deja llegar hasta abajo":
// con el scroll más allá del final de una sección, `start` superaba `count` y
// el spacer inicial inflaba la sección más allá de su altura real — el
// contenido crecía al mismo ritmo que el scroll y el fondo era inalcanzable.
describe('computeVirtualWindow', () => {
  const base = { count: 10, itemSize: 34, viewportSize: 560, originOffset: 60, overscan: 2 };

  it('ventana en rango: slice alrededor del viewport con overscan', () => {
    // scrollOffset al inicio de la sección → desde el item 0.
    const win = computeVirtualWindow({ ...base, count: 100, scrollOffset: 60 });
    expect(win.start).toBe(0);
    // 560 / 34 = 16.47 → ceil 17 + overscan 2 = 19.
    expect(win.end).toBe(19);
    expect(win.leadPx).toBe(0);
    expect(win.trailPx).toBe((100 - 19) * 34);
  });

  it('clamp superior: scroll más allá del final NO infla el spacer (regresión scroll runaway)', () => {
    // 10 items × 34px = sección de 340px; scroll 100000px más abajo.
    const win = computeVirtualWindow({ ...base, scrollOffset: 100_000 });
    expect(win.start).toBe(10);
    expect(win.end).toBe(10);
    expect(win.leadPx).toBe(10 * 34); // exactamente la altura real, nunca más
    expect(win.trailPx).toBe(0);
  });

  it('sección por debajo del viewport: ventana vacía con spacer posterior completo', () => {
    const win = computeVirtualWindow({ ...base, originOffset: 5_000, scrollOffset: 0 });
    expect(win.start).toBe(0);
    expect(win.end).toBe(0);
    expect(win.leadPx).toBe(0);
    expect(win.trailPx).toBe(10 * 34);
  });

  it('sin medir (jsdom / primer paint) renderiza todo', () => {
    const win = computeVirtualWindow({ ...base, scrollOffset: 9_999, measured: false });
    expect(win.start).toBe(0);
    expect(win.end).toBe(10);
    expect(win.leadPx).toBe(0);
    expect(win.trailPx).toBe(0);
  });

  it('count 0 no produce spacers ni índices negativos', () => {
    const win = computeVirtualWindow({ ...base, count: 0, scrollOffset: 1_000 });
    expect(win).toEqual({ start: 0, end: 0, leadPx: 0, trailPx: 0 });
  });

  it('invariante de altura total para cualquier scrollOffset (incl. negativos y overshoot)', () => {
    const count = 37;
    const itemSize = 34;
    for (let offset = -5_000; offset <= 50_000; offset += 137) {
      const win = computeVirtualWindow({
        count,
        itemSize,
        scrollOffset: offset,
        viewportSize: 560,
        originOffset: 60,
        overscan: 8,
      });
      expect(win.start).toBeGreaterThanOrEqual(0);
      expect(win.end).toBeGreaterThanOrEqual(win.start);
      expect(win.end).toBeLessThanOrEqual(count);
      // La sección SIEMPRE mide exactamente count × itemSize.
      expect(win.leadPx + (win.end - win.start) * itemSize + win.trailPx).toBe(count * itemSize);
    }
  });
});
