import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import AnimatedNumber from './AnimatedNumber';

// jsdom no implementa matchMedia — lo stubeamos para que el componente no
// crashee y para poder forzar reduced-motion cuando queramos.
function stubMatchMedia(reduce: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => ({
      matches: q.includes('reduce') && reduce,
      media: q,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    }),
  });
}

describe('AnimatedNumber', () => {
  beforeEach(() => {
    stubMatchMedia(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the initial value synchronously', () => {
    render(<AnimatedNumber value={1000} format={(n) => `$${Math.round(n)}`} />);
    expect(screen.getByText('$1000')).toBeTruthy();
  });

  it('snaps instantly when prefers-reduced-motion is set', () => {
    stubMatchMedia(true);
    const { rerender } = render(
      <AnimatedNumber value={0} format={(n) => `v:${Math.round(n)}`} />,
    );
    rerender(<AnimatedNumber value={500} format={(n) => `v:${Math.round(n)}`} />);
    expect(screen.getByText('v:500')).toBeTruthy();
  });

  it('settles to the new value after animating', async () => {
    const { rerender } = render(
      <AnimatedNumber value={0} format={(n) => `n:${Math.round(n)}`} duration={50} />,
    );
    rerender(<AnimatedNumber value={200} format={(n) => `n:${Math.round(n)}`} duration={50} />);
    // Esperamos lo suficiente para que el rAF termine la interpolación.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    expect(screen.getByText('n:200')).toBeTruthy();
  });

  it('skips animation when the delta is tiny', () => {
    const { rerender } = render(
      <AnimatedNumber value={100} format={(n) => `v:${Math.round(n)}`} />,
    );
    rerender(<AnimatedNumber value={100.2} format={(n) => `v:${Math.round(n)}`} />);
    // Debería mostrar el nuevo valor sin animación — sin esperar rAF.
    expect(screen.getByText('v:100')).toBeTruthy();
  });
});
