import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataHealthPanel, type DataHealthDatasetRow } from './DataHealthPanel';
import { __resetDataGapsForTests, reportDataGap } from '../services/dataHealth';

afterEach(() => {
  __resetDataGapsForTests();
});

const datasets: DataHealthDatasetRow[] = [
  { key: 'cxp', label: 'Antigüedad de Saldos (CXP)', status: 'ready', lastSync: new Date().toISOString() },
  { key: 'cobranza', label: 'Cobranza', status: 'error' },
  { key: 'banks', label: 'Bancos', status: 'ready' }, // ready sin lastSync → se pinta "Sin cargar"
];

function renderPanel(overrides?: Partial<Parameters<typeof DataHealthPanel>[0]>) {
  const onResync = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <DataHealthPanel
      open
      onClose={onClose}
      datasets={datasets}
      onResync={onResync}
      resyncing={false}
      {...overrides}
    />,
  );
  return { ...utils, onResync, onClose };
}

describe('<DataHealthPanel />', () => {
  it('renderiza las filas de frescura por módulo con su estado', () => {
    renderPanel();

    expect(screen.getByText('Salud de datos')).toBeTruthy();
    expect(screen.getByText('Frescura por módulo')).toBeTruthy();
    expect(screen.getByText('Antigüedad de Saldos (CXP)')).toBeTruthy();
    expect(screen.getByText('Cobranza')).toBeTruthy();
    expect(screen.getByText('Bancos')).toBeTruthy();
    // Datasets sin lastSync (cobranza en error y banks "ready" sin sync) → "Nunca".
    expect(screen.getAllByText('Nunca')).toHaveLength(2);
    // Sin huecos reportados → confesión limpia.
    expect(screen.getByText('Sin huecos. Todos los rangos cargaron completos.')).toBeTruthy();
  });

  it('muestra los huecos de la sesión reportados por dataHealth', () => {
    reportDataGap('cobranza', 'day-failed', '2026-07-01 · cía 00001');
    renderPanel();

    expect(screen.getByText(/Día sin cargar/)).toBeTruthy();
    expect(screen.getByText('2026-07-01 · cía 00001')).toBeTruthy();
    // Badge de huecos en la fila del dataset.
    expect(screen.getByText('1 hueco')).toBeTruthy();
  });

  it('el botón "Resincronizar todo" dispara onResync', () => {
    const { onResync } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /Resincronizar todo/ }));
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it('mientras resincroniza el botón queda deshabilitado', () => {
    renderPanel({ resyncing: true });

    const button = screen.getByRole('button', { name: /Resincronizando…/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('cerrado (open=false) no renderiza nada', () => {
    const { container } = render(
      <DataHealthPanel open={false} onClose={vi.fn()} datasets={datasets} onResync={vi.fn()} resyncing={false} />,
    );
    expect(container.innerHTML).toBe('');
  });
});
