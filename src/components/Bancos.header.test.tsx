/**
 * Tests de RENDER de la cabecera de Bancos: las 3 tarjetas de caja
 * (Caja disponible / Pagadoras / Saldo total) y los badges de frescura de
 * fuentes manuales (Bajío/Santander). La lógica de dominio ya está cubierta
 * en bankStatements.test.ts y bankSourceFreshness.test.ts — aquí solo el wiring.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Bancos from './Bancos';
import type { BankAccountStatement, BankStatementLine } from '../services/jde';

/** YYYY-MM-DD con offset de días desde hoy. */
function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function movement(patch: {
  cuenta: string;
  tipoMovimiento: 'ABONO' | 'CARGO';
  importe: number;
  banco?: string;
  fechaOperacion?: string;
}): BankStatementLine {
  return {
    cia: '00001',
    banco: patch.banco ?? 'BANAMEX',
    nombreBanco: patch.banco ?? 'BANAMEX',
    cuenta: patch.cuenta,
    moneda: 'MXN',
    fechaOperacion: patch.fechaOperacion ?? isoDaysFromNow(-3),
    referencia: `REF-${patch.cuenta}`,
    concepto: 'Movimiento bancario',
    tipoMovimiento: patch.tipoMovimiento,
    importe: patch.importe,
  };
}

function statement(patch: Partial<BankAccountStatement> & Pick<BankAccountStatement, 'cuenta' | 'movimientos'>): BankAccountStatement {
  return {
    cia: patch.cia ?? '00001',
    banco: patch.banco ?? 'BANAMEX',
    nombreBanco: patch.nombreBanco ?? patch.banco ?? 'BANAMEX',
    cuenta: patch.cuenta,
    moneda: patch.moneda ?? 'MXN',
    fechaEstadoCuenta: patch.fechaEstadoCuenta ?? isoDaysFromNow(-1),
    saldoInicial: patch.saldoInicial ?? 0,
    saldoFinal: patch.saldoFinal ?? patch.movimientos.reduce((sum, item) => (
      item.tipoMovimiento === 'ABONO' ? sum + item.importe : sum - item.importe
    ), 0),
    movimientos: patch.movimientos,
  };
}

function renderBancos(statements: BankAccountStatement[]) {
  return render(
    <Bancos
      selectedCia="all"
      statements={statements}
      supplementalStatements={[]}
      onJdeStatementsChange={vi.fn()}
      onSupplementalStatementsChange={vi.fn()}
      lastQuery={{ fechaEstadoCuenta: isoDaysFromNow(-1), formatoElectronico: 'SWIFT' }}
      onLastQueryChange={vi.fn()}
    />,
  );
}

// Cuentas del catálogo bundleado (bankAccountsCatalog.json):
// '06787361240' → role concentradora · '7014 1027881' → role pagadora.
function catalogStatements(): BankAccountStatement[] {
  return [
    statement({
      cuenta: '06787361240',
      saldoFinal: 10_000,
      movimientos: [movement({ cuenta: '06787361240', tipoMovimiento: 'ABONO', importe: 10_000 })],
    }),
    statement({
      cuenta: '7014 1027881',
      saldoFinal: 4_000,
      movimientos: [movement({ cuenta: '7014 1027881', tipoMovimiento: 'ABONO', importe: 4_000 })],
    }),
  ];
}

describe('<Bancos /> tarjetas de caja (cabecera)', () => {
  it('renderiza Caja disponible / Pagadoras / Saldo total', () => {
    renderBancos(catalogStatements());

    expect(screen.getByText('Caja disponible')).toBeTruthy();
    expect(screen.getByText('Pagadoras (comprometido)')).toBeTruthy();
    expect(screen.getByText('Saldo total (todas)')).toBeTruthy();
    // Concentradora = 1 cuenta.
    expect(screen.getByText(/1 concentradora/)).toBeTruthy();
  });
});

describe('<Bancos /> frescura de fuentes manuales', () => {
  it('sin cargas de Bajío/Santander marca ambas fuentes sin datos', () => {
    renderBancos(catalogStatements());

    expect(screen.getByText('BanBajío (carga manual):')).toBeTruthy();
    expect(screen.getByText('Santander (carga manual):')).toBeTruthy();
    expect(screen.getAllByText(/sin datos cargados en este navegador/)).toHaveLength(2);
  });

  it('con una carga de Bajío reciente el badge muestra el último movimiento', () => {
    renderBancos([
      ...catalogStatements(),
      statement({
        banco: 'BAJIO',
        nombreBanco: 'BANBAJIO',
        cuenta: '999999',
        movimientos: [
          movement({ cuenta: '999999', banco: 'BAJIO', tipoMovimiento: 'ABONO', importe: 1_000, fechaOperacion: isoDaysFromNow(-1) }),
        ],
      }),
    ]);

    // Bajío ya no aparece como "sin datos": muestra la fecha del último movimiento.
    expect(screen.getAllByText(/sin datos cargados en este navegador/)).toHaveLength(1);
    expect(screen.getByText(/último movimiento/)).toBeTruthy();
  });
});
