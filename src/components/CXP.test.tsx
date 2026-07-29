import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CXP from './CXP';
import type { CXPRecord } from '../domain/persistence';
import type { CashFlowAssumptions } from '../domain/types';
import { fmtCurrency } from '../formatters';

/** YYYY-MM-DD con offset de días desde hoy (UTC — offsets grandes, sin riesgo de huso). */
function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function cxp(overrides: Partial<CXPRecord>): CXPRecord {
  return {
    cia: '00001',
    noProveedor: '100',
    nombre: 'PROVEEDOR PRUEBA UNO',
    noFactura: 'F-1',
    fechaFactura: isoDaysFromNow(-40),
    fechaVence: isoDaysFromNow(-10),
    fechaProgramacionPago: '',
    diasVencida: 0,
    importeBrutoPesos: 1000,
    importePendientePesos: 1000,
    importeSubtotalPesos: 862,
    importeImpuestosPesos: 138,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXP',
    condPago: '30 días',
    clasifica: '',
    clasificacionProveedor: '',
    edoPago: '',
    tipoCambio: 1,
    porVencer: 0,
    v1_30: 0,
    v61_90: 0,
    v31_60: 0,
    v91_120: 0,
    v121_150: 0,
    v151_180: 0,
    mas180: 0,
    ...overrides,
  };
}

beforeEach(() => {
  // Recharts (ResponsiveContainer) requiere ResizeObserver, ausente en jsdom.
  vi.stubGlobal(
    'ResizeObserver',
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const assumptions: CashFlowAssumptions = {
  year: new Date().getFullYear(),
  globalCompliance: 1,
  factorajeDays: 30,
};

function renderCXP(records: CXPRecord[]) {
  return render(
    <CXP
      records={records}
      loadedCias={{ '00001': '2026-07-01T00:00:00Z' }}
      companies={[]}
      selectedCia="all"
      providers={[]}
      clients={[]}
      assumptions={assumptions}
      bankStatements={[]}
      budget={null}
      onMergeCia={vi.fn()}
      onReplaceAll={vi.fn()}
      onReset={vi.fn()}
    />,
  );
}

// Fixture base: una factura VENCIDA (10,000) + una POR VENCER lejana (5,000).
// Vencida: diasVencida 15 (≤30 → no critical) → prioridad normal.
function baseRecords(): CXPRecord[] {
  return [
    cxp({
      noFactura: 'F-VENCIDA',
      nombre: 'PROVEEDOR PRUEBA UNO',
      diasVencida: 15,
      fechaVence: isoDaysFromNow(-15),
      importePendientePesos: 10_000,
    }),
    cxp({
      noFactura: 'F-FUTURA',
      nombre: 'PROVEEDOR PRUEBA DOS',
      noProveedor: '200',
      diasVencida: 0,
      fechaVence: isoDaysFromNow(400),
      importePendientePesos: 5_000,
    }),
  ];
}

describe('<CXP /> KPIs de cabecera', () => {
  it('renderiza las 4 tarjetas de totales con los montos correctos', () => {
    renderCXP(baseRecords());

    expect(screen.getByText('Total adeudado')).toBeTruthy();
    expect(screen.getByText('Vencido')).toBeTruthy();
    expect(screen.getByText('Por vencer')).toBeTruthy();
    expect(screen.getByText('A pagar este mes')).toBeTruthy();

    // Total = 15,000 · Por vencer = 5,000 (la futura queda fuera del mes).
    expect(screen.getByText(fmtCurrency(15_000))).toBeTruthy();
    expect(screen.getByText(fmtCurrency(5_000))).toBeTruthy();
    // Vencido y "A pagar este mes" comparten monto (solo la vencida entra).
    expect(screen.getAllByText(fmtCurrency(10_000)).length).toBeGreaterThanOrEqual(2);
  });

  it('desglosa "A pagar este mes" por prioridad de proveedor', () => {
    renderCXP(baseRecords());

    expect(screen.getByText('A pagar este mes · por prioridad de proveedor')).toBeTruthy();
    // Sin catálogo de proveedores y diasVencida ≤ 30 → prioridad "Normal".
    expect(screen.getAllByText('Normal').length).toBeGreaterThanOrEqual(1);
  });

  it('"Ver proveedores" expande la lista accionable por proveedor', () => {
    renderCXP(baseRecords());

    // Solo la vencida entra al mes → 1 proveedor en la lista.
    fireEvent.click(screen.getByRole('button', { name: /Ver proveedores \(1\)/ }));

    expect(screen.getByText('PROVEEDOR PRUEBA UNO')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Ocultar proveedores/ })).toBeTruthy();
  });

  it('sin datos muestra el estado vacío con la acción de consulta a JDE', () => {
    render(
      <CXP
        records={[]}
        loadedCias={{}}
        companies={[]}
        selectedCia="all"
        providers={[]}
        clients={[]}
        assumptions={assumptions}
        bankStatements={[]}
        budget={null}
        onMergeCia={vi.fn()}
        onReplaceAll={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    expect(screen.getByText('Antigüedad de Saldos')).toBeTruthy();
    expect(screen.getByText('Consultar desde JDE')).toBeTruthy();
  });
});
