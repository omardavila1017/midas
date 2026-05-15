import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Bancos from './Bancos';
import type { BankAccountStatement } from '../services/jde';

describe('<Bancos /> bank catalog enrichment', () => {
  it('renders business-unit summaries and filters bank accounts by catalog unit', () => {
    const { container } = render(
      <Bancos
        selectedCia="all"
        statements={[
          statement({
            cuenta: '678 7361240',
            movimientos: [movement({ cuenta: '678 7361240', tipoMovimiento: 'ABONO', importe: 10_000 })],
          }),
          statement({
            cuenta: '7013 8805172',
            movimientos: [movement({ cuenta: '7013 8805172', tipoMovimiento: 'ABONO', importe: 5_000 })],
          }),
        ]}
        supplementalStatements={[]}
        onJdeStatementsChange={vi.fn()}
        onSupplementalStatementsChange={vi.fn()}
        lastQuery={{ fechaEstadoCuenta: '2026-04-30', formatoElectronico: 'SWIFT' }}
        onLastQueryChange={vi.fn()}
      />,
    );

    expect(container.querySelector('button[title="Filtrar por Multicarga"]')).toBeTruthy();
    expect(container.querySelector('button[title="Filtrar por CITI"]')).toBeTruthy();

    fireEvent.change(screen.getByTitle('Unidad de negocio'), { target: { value: 'MULTICARGA' } });

    expect(container.querySelector('button[title="Filtrar por Multicarga"]')).toBeTruthy();
    expect(container.querySelector('button[title="Filtrar por CITI"]')).toBeFalsy();
    expect(screen.getByText(/Cuentas/)).toBeTruthy();
  });
});

function statement(patch: Partial<BankAccountStatement> & Pick<BankAccountStatement, 'cuenta' | 'movimientos'>): BankAccountStatement {
  return {
    cia: patch.cia ?? '00001',
    banco: patch.banco ?? 'BANAMEX',
    nombreBanco: patch.nombreBanco ?? patch.banco ?? 'BANAMEX',
    cuenta: patch.cuenta,
    moneda: patch.moneda ?? 'MXN',
    fechaEstadoCuenta: patch.fechaEstadoCuenta ?? '2026-04-30',
    saldoInicial: patch.saldoInicial ?? 0,
    saldoFinal: patch.saldoFinal ?? patch.movimientos.reduce((sum, item) => (
      item.tipoMovimiento === 'ABONO' ? sum + item.importe : sum - item.importe
    ), 0),
    movimientos: patch.movimientos,
  };
}

function movement(patch: {
  cuenta: string;
  tipoMovimiento: 'ABONO' | 'CARGO';
  importe: number;
}) {
  return {
    cia: '00001',
    banco: 'BANAMEX',
    nombreBanco: 'BANAMEX',
    cuenta: patch.cuenta,
    moneda: 'MXN',
    fechaOperacion: '2026-04-16',
    referencia: `REF-${patch.cuenta}`,
    concepto: 'Movimiento bancario',
    tipoMovimiento: patch.tipoMovimiento,
    importe: patch.importe,
  };
}
