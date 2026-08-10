import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CausedIvaGapBanner } from './TaxDashboard';
import type { CausedIvaCoverage } from '../services/causedIvaCoverage';

/**
 * El banner se prueba aislado a propósito: montar `<TaxDashboard />` con
 * `cobranzaRecords` deja al tablero en su shell de carga en jsdom (el hook del
 * source no resuelve sin Worker), así que la integración motor→vista se cubre
 * en `taxModuleService.test.ts` y aquí sólo la presentación.
 */
function gap(partial: Partial<CausedIvaCoverage> & { period: string }): CausedIvaCoverage {
  return {
    reportedIva: 0,
    expectedIva: 35_362_508,
    applicationCount: 0,
    paidInvoiceCount: 1,
    coverageRatio: 0,
    implausible: true,
    ...partial,
  };
}

describe('<CausedIvaGapBanner />', () => {
  it('no pinta nada cuando no hay nada que confesar', () => {
    const { container } = render(<CausedIvaGapBanner gaps={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('nombra el periodo y dice dónde se corrige', () => {
    render(<CausedIvaGapBanner gaps={[gap({ period: '2026-03' })]} />);
    expect(screen.getByText(/El IVA causado de Marzo 2026 está incompleto en el origen/i)).toBeTruthy();
    expect(screen.getByText(/Se corrige capturando las aplicaciones en JDE, no en Midas/i)).toBeTruthy();
  });

  it('resume varios periodos y señala el peor', () => {
    render(
      <CausedIvaGapBanner
        gaps={[
          gap({ period: '2026-02', coverageRatio: 0.12 }),
          gap({ period: '2026-03', coverageRatio: 0.02 }),
          gap({ period: '2026-05', coverageRatio: 0.03 }),
        ]}
      />,
    );
    expect(screen.getByText(/El IVA causado de 3 periodos está incompleto en el origen/i)).toBeTruthy();
    // El peor es marzo (2%), no el primero de la lista.
    expect(screen.getByText(/Lo más bajo es Marzo 2026, con 2% de cobertura/i)).toBeTruthy();
  });

  it('el detalle por periodo se abre bajo demanda', () => {
    render(<CausedIvaGapBanner gaps={[gap({ period: '2026-03' })]} />);
    expect(screen.queryByText('Cobertura')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Ver detalle por periodo/i }));

    expect(screen.getByText('Cobertura')).toBeTruthy();
    expect(screen.getByText('0%')).toBeTruthy();
    expect(screen.getByText('0 de 1')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Ocultar detalle/i }));
    expect(screen.queryByText('Cobertura')).toBeNull();
  });
});
