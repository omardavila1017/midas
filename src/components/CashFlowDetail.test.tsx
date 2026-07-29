import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import CashFlowDetail from './CashFlowDetail';
import type { BankAccountStatement, BankStatementLine } from '../services/jde';
import type { CashFlowAssumptions } from '../domain/types';

const YEAR = new Date().getFullYear();

const assumptions: CashFlowAssumptions = {
  year: YEAR,
  globalCompliance: 1,
  factorajeDays: 30,
};

function movement(patch: {
  cia: string;
  cuenta: string;
  tipoMovimiento: 'ABONO' | 'CARGO';
  importe: number;
}): BankStatementLine {
  return {
    cia: patch.cia,
    banco: 'BANAMEX',
    nombreBanco: 'BANAMEX',
    cuenta: patch.cuenta,
    moneda: 'MXN',
    fechaOperacion: `${YEAR}-03-10`,
    referencia: `REF-${patch.cuenta}`,
    concepto: 'Depósito cliente',
    tipoMovimiento: patch.tipoMovimiento,
    importe: patch.importe,
  };
}

function statement(patch: {
  cia: string;
  cuenta: string;
  movimientos: BankStatementLine[];
}): BankAccountStatement {
  return {
    cia: patch.cia,
    banco: 'BANAMEX',
    nombreBanco: 'BANAMEX',
    cuenta: patch.cuenta,
    moneda: 'MXN',
    fechaEstadoCuenta: `${YEAR}-03-31`,
    saldoInicial: 0,
    saldoFinal: patch.movimientos.reduce(
      (sum, m) => (m.tipoMovimiento === 'ABONO' ? sum + m.importe : sum - m.importe),
      0,
    ),
    movimientos: patch.movimientos,
  };
}

const companies = [
  { cia: '00001', nombre: 'Empresa Uno' },
  { cia: '00002', nombre: 'Empresa Dos' },
];

function twoCompanyStatements(): BankAccountStatement[] {
  return [
    statement({
      cia: '00001',
      cuenta: '111111',
      movimientos: [movement({ cia: '00001', cuenta: '111111', tipoMovimiento: 'ABONO', importe: 10_000 })],
    }),
    statement({
      cia: '00002',
      cuenta: '222222',
      movimientos: [movement({ cia: '00002', cuenta: '222222', tipoMovimiento: 'CARGO', importe: 4_000 })],
    }),
  ];
}

function renderDetail(bankStatements: BankAccountStatement[]) {
  return render(
    <CashFlowDetail
      assumptions={assumptions}
      bankStatements={bankStatements}
      companies={companies}
    />,
  );
}

describe('<CashFlowDetail /> Flujo Neto', () => {
  it('renderiza la tabla "Flujo neto por empresa" con las cías presentes', () => {
    renderDetail(twoCompanyStatements());

    expect(screen.getByText('Flujo Neto')).toBeTruthy();
    expect(screen.getByText('Flujo neto por empresa')).toBeTruthy();
    // Nombres del catálogo en la tabla por empresa.
    expect(screen.getByText('Empresa Uno')).toBeTruthy();
    expect(screen.getByText('Empresa Dos')).toBeTruthy();
  });

  it('el filtro "Empresa" acota el flujo a la cía seleccionada', () => {
    renderDetail(twoCompanyStatements());

    const select = screen.getByTitle('Empresa');
    expect(select).toBeTruthy();

    fireEvent.change(select, { target: { value: '00002' } });

    // La tabla por empresa ahora solo muestra la cía 2 (la 1 sale del scope);
    // el option del select sigue existiendo pero con otro texto ("1 · Empresa Uno").
    expect(screen.queryByText('Empresa Uno')).toBeNull();
    expect(screen.getByText('Empresa Dos')).toBeTruthy();
  });

  it('con una sola empresa no muestra ni el filtro ni la tabla por empresa', () => {
    renderDetail([
      statement({
        cia: '00001',
        cuenta: '111111',
        movimientos: [movement({ cia: '00001', cuenta: '111111', tipoMovimiento: 'ABONO', importe: 10_000 })],
      }),
    ]);

    expect(screen.queryByTitle('Empresa')).toBeNull();
    expect(screen.queryByText('Flujo neto por empresa')).toBeNull();
  });

  it('sin estados de cuenta muestra el estado vacío', () => {
    renderDetail([]);
    expect(screen.getByText('Sin movimientos bancarios')).toBeTruthy();
  });
});
