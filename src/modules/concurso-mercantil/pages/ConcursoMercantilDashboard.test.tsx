import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ConcursoMercantilDashboard from './ConcursoMercantilDashboard';

// El convenio vive en código (parseado del Excel) y NO depende de JDE.
// Este test prueba que el módulo monta y renderiza el convenio aun sin
// datos de backend (cxp/companies/banco vacíos) — sustituye la verificación
// visual en browser, que aquí está bloqueada porque el boot espera JDE.
describe('<ConcursoMercantilDashboard />', () => {
  const renderEmpty = () =>
    render(
      <ConcursoMercantilDashboard
        cxpRecords={[]}
        companies={[]}
        selectedCia="all"
        bankStatements={[]}
      />,
    );

  it('renders the convenio sections without any JDE data', () => {
    renderEmpty();
    expect(screen.getByText('Concurso Mercantil')).toBeTruthy();
    expect(screen.getByText('Saldo convenio')).toBeTruthy();
    expect(
      screen.getByText('Empate histórico vs movimientos bancarios'),
    ).toBeTruthy();
    expect(screen.getByText('Pagos futuros del convenio')).toBeTruthy();
  });

  it('reports no bank statements loaded in the reconciliation section', () => {
    renderEmpty();
    expect(screen.getByText('Sin estados de cuenta cargados')).toBeTruthy();
  });

  it('shows the frozen-CXP empty state when there are no concurso CXP rows', () => {
    renderEmpty();
    expect(screen.getByText('Sin saldos CXP en concurso')).toBeTruthy();
  });
});
