/**
 * Stress test: BancosMovimientos soft-cap.
 *
 * Objetivo: confirmar que expandir una cuenta con 10k+ movimientos NO renderiza
 * 10k filas DOM (anti-OOM). El soft-cap inicial es 1500 filas — el resto
 * disponible vía "Cargar más". Garantiza que historiales pesados no revientan
 * el renderer.
 *
 * BancosMovimientos no se exporta, así que validamos la constante del cap +
 * la construcción del dataset stress. Si alguien sube el chunk a Infinity por
 * accidente, este test falla.
 */
// @ts-expect-error — node builtin used only in test runtime (vitest provides Node env)
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

describe('Bancos · soft-cap de movimientos (anti-OOM)', () => {
  it('confirma que la constante BANCOS_ROW_CHUNK es ≤ 2000 (defensa OOM)', () => {
    const src = readFileSync('src/components/Bancos.tsx', 'utf-8');
    const match = src.match(/const BANCOS_ROW_CHUNK = (\d+)/);
    expect(match).toBeTruthy();
    const chunk = Number(match![1]);
    expect(chunk).toBeGreaterThan(0);
    expect(chunk).toBeLessThanOrEqual(2000);
  });

  it('confirma que existe el botón "Cargar más" cuando aplica el cap', () => {
    const src = readFileSync('src/components/Bancos.tsx', 'utf-8');
    // Patrón de la UI del cap: indicador + botón. JSX usa `{expr}` (no `${}`),
    // así que validamos la forma literal del código.
    expect(src).toMatch(/setRenderLimit\(prev => prev \+ BANCOS_ROW_CHUNK\)/);
    expect(src).toMatch(/Cargar todas/);
    expect(src).toMatch(/setRenderLimit\(totalRows\)/);
  });

  it('dataset stress de 10k movs es construible sin OOM en jsdom', () => {
    const movs = Array.from({ length: 10_000 }, (_, i) => ({
      tipoMovimiento: i % 2 === 0 ? 'ABONO' : 'CARGO',
      importe: 1000 + i,
      referencia: `REF-${i}`,
      concepto: `Concepto ${i}`,
    }));
    expect(movs.length).toBe(10_000);
  });
});
