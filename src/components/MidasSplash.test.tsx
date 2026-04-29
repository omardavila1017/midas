import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MidasSplash from './MidasSplash';

describe('<MidasSplash /> bank progress', () => {
  it('shows empty progress bar (no dots) when no progress yet (priming)', () => {
    const { container } = render(
      <MidasSplash visible step="banks" progress={null} />,
    );
    expect(container.querySelectorAll('[data-splash-dot]').length).toBe(0);
    const bar = container.querySelector('[role="progressbar"]') as HTMLElement;
    expect(bar).not.toBeNull();
    const fill = bar.firstElementChild as HTMLElement;
    expect(fill.style.width).toBe('0%');
    expect(screen.getByText('Sincronizando bancos…')).toBeTruthy();
  });

  it('shows empty progress bar when ranging just started (total=0)', () => {
    const { container } = render(
      <MidasSplash visible step="banks" progress={{ done: 0, total: 0 }} />,
    );
    expect(container.querySelectorAll('[data-splash-dot]').length).toBe(0);
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar).not.toBeNull();
  });

  it('renders progress bar with correct aria + fill width during ranging', () => {
    const { container } = render(
      <MidasSplash visible step="banks" progress={{ done: 100, total: 365 }} />,
    );
    const bar = container.querySelector('[role="progressbar"]') as HTMLElement | null;
    expect(bar).not.toBeNull();
    expect(bar!.getAttribute('aria-valuenow')).toBe('100');
    expect(bar!.getAttribute('aria-valuemax')).toBe('365');
    const fill = bar!.firstElementChild as HTMLElement;
    expect(fill.style.width).toBe(`${(100 / 365) * 100}%`);
    expect(screen.getByText('Cargando año 100/365')).toBeTruthy();
  });

  it('caps fill at 100% when done >= total', () => {
    const { container } = render(
      <MidasSplash visible step="banks" progress={{ done: 400, total: 365 }} />,
    );
    const fill = container.querySelector('[role="progressbar"] > *') as HTMLElement;
    expect(fill.style.width).toBe('100%');
  });

  it('hides progress bar on non-bank steps even if progress is set', () => {
    const { container } = render(
      <MidasSplash visible step="catalog" progress={{ done: 50, total: 100 }} />,
    );
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(screen.getByText('Cargando catálogos…')).toBeTruthy();
  });
});
