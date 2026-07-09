import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MidasSplash, { type BootTask } from './MidasSplash';

const tasksWith = (overrides: Partial<Record<string, Partial<BootTask>>> = {}): BootTask[] => {
  const base: BootTask[] = [
    { id: 'catalog', label: 'Catálogos · clientes y proveedores', status: 'loading' },
    { id: 'companies', label: 'JDE · empresas', status: 'loading' },
    { id: 'banks', label: 'Bancos · estado reciente', status: 'loading', progress: null },
    { id: 'cxp', label: 'CXP · antigüedad de saldos', status: 'pending' },
    { id: 'cobranza', label: 'Cobranza · cartera y pagos', status: 'pending' },
  ];
  return base.map(t => ({ ...t, ...(overrides[t.id] ?? {}) }));
};

describe('<MidasSplash /> task list', () => {
  it('renders an overall progress bar driven by settled tasks', () => {
    const { container } = render(
      <MidasSplash visible tasks={tasksWith()} startedAt={Date.now()} />,
    );
    const bar = container.querySelector('[role="progressbar"]') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.getAttribute('aria-valuemax')).toBe('5');
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
  });

  it('marks settled (done + error) progress correctly', () => {
    const tasks = tasksWith({
      catalog: { status: 'done' },
      companies: { status: 'done' },
      banks: { status: 'error' },
    });
    const { container } = render(
      <MidasSplash visible tasks={tasks} startedAt={Date.now()} />,
    );
    const bar = container.querySelector('[role="progressbar"]') as HTMLElement;
    expect(bar.getAttribute('aria-valuenow')).toBe('3');
    const fill = bar.firstElementChild as HTMLElement;
    expect(fill.style.width).toBe(`${(3 / 5) * 100}%`);
  });

  it('shows the first loading task label as the headline', () => {
    const tasks = tasksWith({
      catalog: { status: 'done' },
      companies: { status: 'loading' },
    });
    render(<MidasSplash visible tasks={tasks} startedAt={Date.now()} />);
    // Label appears in both the headline and the task row.
    expect(screen.getAllByText('JDE · empresas').length).toBeGreaterThanOrEqual(1);
  });

  it('does not expose per-task counts (no numeric chips)', () => {
    const tasks = tasksWith({
      banks: { status: 'loading', progress: { done: 100, total: 365 } },
      cxp: { status: 'loading', progress: { done: 5, total: 29 } },
    });
    const { container } = render(
      <MidasSplash visible tasks={tasks} startedAt={Date.now()} />,
    );
    expect(container.textContent ?? '').not.toMatch(/\b\d+\s*\/\s*\d+\b/);
  });

  it('renders an elapsed time counter', () => {
    const started = Date.now() - 65_000;
    const { container } = render(
      <MidasSplash visible tasks={tasksWith()} startedAt={started} />,
    );
    expect(container.textContent).toMatch(/01:0[45]/);
  });

  it('shows "Listo" headline once every task is settled', () => {
    const tasks = tasksWith({
      catalog: { status: 'done' },
      companies: { status: 'done' },
      banks: { status: 'done' },
      cxp: { status: 'done' },
      cobranza: { status: 'done' },
    });
    render(<MidasSplash visible tasks={tasks} startedAt={Date.now()} />);
    expect(screen.getByText(/Listo/)).toBeTruthy();
  });
});

describe('<MidasSplash /> blocked state', () => {
  it('shows the blocked message + failed labels and does not open the app', () => {
    const tasks = tasksWith({ banks: { status: 'error' } });
    render(
      <MidasSplash
        visible
        tasks={tasks}
        startedAt={Date.now()}
        blocked
        failedLabels={['Bancos · estado reciente']}
      />,
    );
    expect(screen.getByText(/No se pudo completar la carga de datos/)).toBeTruthy();
    expect(screen.getByText(/La app no se abrirá con datos incompletos/)).toBeTruthy();
    expect(screen.getByText(/No se pudo cargar: Bancos · estado reciente/)).toBeTruthy();
  });

  it('fires onRetry when the retry button is clicked', () => {
    const onRetry = vi.fn();
    const tasks = tasksWith({ banks: { status: 'error' } });
    render(
      <MidasSplash
        visible
        tasks={tasks}
        startedAt={Date.now()}
        blocked
        failedLabels={['Bancos · estado reciente']}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Reintentar la carga de datos/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders no blocked panel when not blocked', () => {
    render(<MidasSplash visible tasks={tasksWith()} startedAt={Date.now()} />);
    expect(screen.queryByText(/La app no se abrirá con datos incompletos/)).toBeNull();
  });
});
