/**
 * El panel del pie de página de una celda de Planeación DEBE mostrar el
 * desglose por factura de una línea Citi sin un segundo clic — es lo que el
 * usuario pidió y lo que `d5b30a9` no entregó (el desglose vivía sólo dentro
 * del drilldown, y el drilldown nunca se abría por falta de anchor).
 *
 * Se monta el componente de verdad a propósito: el defecto que arrastró dos PRs
 * era "componente inalcanzable", y eso NO lo detecta un test de la lógica pura.
 *
 * Cifras reales de la BD (`jde.Cobranza_Citi`, cía 00011, 2026).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PlanningCellDetailPanel } from './FinancialPlanningDashboard';
import type { FinancialMovement } from '../../shared-finance/types';
import type { CobranzaRecord } from '../../../services/jdeTypes';

function citiMovement(patch: Partial<FinancialMovement> = {}): FinancialMovement {
  return {
    id: 'citi-prorrateo:00011:103246:2026-02',
    sourceSystem: 'BANK',
    type: 'INFLOW',
    category: 'AR_COLLECTION',
    subcategory: 'Clientes Citi',
    companyId: '00011',
    counterpartyId: '103246',
    counterpartyName: '3M MEXICO',
    counterpartyType: 'CUSTOMER',
    concept: 'Cobro Citi 3M MEXICO (depósito concentradora 2026-02)',
    currency: 'MXN',
    originalAmount: 221_201.53,
    baseAmount: 221_201.53,
    projectedAmount: 221_201.53,
    actualDate: '2026-02-12',
    projectedDate: '2026-02-12',
    confidenceScore: 100,
    confidenceBand: 'HIGH',
    forecastMethod: 'RULE',
    status: 'REAL',
    lockState: 'LOCKED',
    createdAt: '2026-02-12T00:00:00.000Z',
    updatedAt: '2026-02-12T00:00:00.000Z',
    ...patch,
  };
}

function cobranza(patch: Partial<CobranzaRecord>): CobranzaRecord {
  return {
    cia: '00011',
    noCliente: '103246',
    nombreCliente: '3M MEXICO',
    noFactura: 'RI-301306',
    fechaFactura: '2025-12-16',
    fechaVence: '2026-01-15',
    fechaCobro: '2026-02-12',
    diasVencida: 0,
    importeBrutoPesos: 221_201.53,
    importePendientePesos: 0,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXN',
    condPago: '30',
    estatus: 'PAGADA',
    tipoCambio: 1,
    ...patch,
  };
}

/** 3M MEXICO (No_Cliente 103246) — su única factura cobrada en feb-2026. */
const TRESM_FEB = [
  cobranza({ noFactura: 'RI-301306', fechaFactura: '2025-12-16', fechaCobro: '2026-02-12', importeBrutoPesos: 221_201.53 }),
];

/** ACEROMEX (No_Cliente 69414113) — sus 2 facturas cobradas en ene-2026. */
const ACEROMEX_ENE = [
  cobranza({
    noCliente: '69414113', nombreCliente: 'ACEROMEX', noFactura: 'RI-301003',
    fechaFactura: '2025-12-08', fechaCobro: '2026-01-05', importeBrutoPesos: 305_019.49,
  }),
  cobranza({
    noCliente: '69414113', nombreCliente: 'ACEROMEX', noFactura: 'RI-301896',
    fechaFactura: '2026-01-07', fechaCobro: '2026-01-28', importeBrutoPesos: 315_976.47,
  }),
];

function renderPanel(
  movements: FinancialMovement[],
  cobranzaRecords: CobranzaRecord[] | undefined,
  onSelectMovement = vi.fn(),
) {
  render(
    <PlanningCellDetailPanel
      movements={movements}
      cobranzaRecords={cobranzaRecords}
      clients={[]}
      conceptLabel="3M MEXICO"
      scenarioName="Escenario Base"
      bucketLabel="feb 2026"
      onSelectMovement={onSelectMovement}
      onClose={() => {}}
    />,
  );
  return onSelectMovement;
}

describe('PlanningCellDetailPanel · desglose de facturas Citi en el pie de página', () => {
  it('muestra la tabla de facturas SIN segundo clic al abrir la celda de un cliente', () => {
    renderPanel([citiMovement()], TRESM_FEB);

    expect(screen.getByText('Factura que respalda el importe')).toBeTruthy();
    expect(screen.getByText('RI-301306')).toBeTruthy();
    expect(screen.getByText('Suma de facturas')).toBeTruthy();
    expect(screen.getByText('Importe atribuido')).toBeTruthy();
    expect(screen.getByText('1.000')).toBeTruthy();
    expect(screen.getByText(/el depósito se acreditó completo/i)).toBeTruthy();
  });

  it('desglosa a cualquier otro cliente Citi en cualquier otro mes (ACEROMEX, ene-2026)', () => {
    renderPanel(
      [citiMovement({
        id: 'citi-prorrateo:00011:69414113:2026-01',
        counterpartyId: '69414113',
        counterpartyName: 'ACEROMEX',
        actualDate: '2026-01-28',
        projectedDate: '2026-01-28',
        originalAmount: 620_995.96,
        baseAmount: 620_995.96,
        projectedAmount: 620_995.96,
      })],
      ACEROMEX_ENE,
    );

    expect(screen.getByText('Facturas que respaldan el importe (2)')).toBeTruthy();
    expect(screen.getByText('RI-301003')).toBeTruthy();
    expect(screen.getByText('RI-301896')).toBeTruthy();
    expect(screen.getByText('1.000')).toBeTruthy();
  });

  it('declara el factor cuando el reparto proporcional atribuyó menos que las facturas', () => {
    // Ratio real de ene-2026 en la cía 00011: depósito/cobranza ≈ 0.786.
    renderPanel(
      [citiMovement({
        id: 'citi-prorrateo:00011:69414113:2026-01',
        counterpartyId: '69414113',
        counterpartyName: 'ACEROMEX',
        actualDate: '2026-01-28',
        projectedDate: '2026-01-28',
        originalAmount: 488_102.83,
        baseAmount: 488_102.83,
        projectedAmount: 488_102.83,
      })],
      ACEROMEX_ENE,
    );

    expect(screen.getByText('0.786')).toBeTruthy();
    expect(screen.getByText(/se le atribuyó el 78\.6% de sus facturas del periodo/i)).toBeTruthy();
    // No puede afirmar una sola causa: el factor < 1 también sale del descuento
    // de lo ya atribuido por cruce directo, donde el depósito SÍ alcanzaba.
    expect(screen.queryByText(/no alcanza/i)).toBeNull();
  });

  it('deja el resto de los movimientos exactamente como antes (sin tabla)', () => {
    renderPanel(
      [citiMovement({
        id: 'cxc:00011:RI-999:2026-02-12',
        subcategory: 'Cobranza JDE',
        concept: 'Factura CXC abierta',
      })],
      TRESM_FEB,
    );

    expect(screen.queryByText(/respalda/i)).toBeNull();
    expect(screen.queryByText('Suma de facturas')).toBeNull();
  });

  it('no cuelga el desglose a un `cxc:` del bucket Citi (una factura, no el set del mes)', () => {
    // `subcategory === 'Clientes Citi'` NO identifica la línea del prorrateo: el
    // mismo bucket lo llevan el `cxc:` abierto, el `bank:` cruzado y el `rol:`
    // proyectado del mismo cliente. Cada uno tiene su propio documento, así que
    // listarles el set COMPLETO de la cobranza del mes con un factor de reparto
    // afirma un respaldo que no es el suyo.
    renderPanel(
      [citiMovement({
        id: 'cxc:00011:103246:RI-301306',
        sourceSystem: 'JDE',
        sourceObjectId: 'RI-301306',
        status: 'PROJECTED_BASE',
        concept: 'Factura CXC RI-301306 · 3M MEXICO',
      })],
      TRESM_FEB,
    );

    expect(screen.queryByText(/respalda/i)).toBeNull();
    expect(screen.queryByText('Suma de facturas')).toBeNull();
    expect(screen.queryByText('Factor aplicado')).toBeNull();
  });

  it('no rompe ni pinta tabla cuando la cobranza del mes no está cargada', () => {
    renderPanel([citiMovement()], []);
    expect(screen.queryByText(/respalda/i)).toBeNull();

    renderPanel([citiMovement()], undefined);
    expect(screen.queryByText(/respalda/i)).toBeNull();
  });

  it('entrega un anchor real al seleccionar el movimiento (el drilldown lo exige)', () => {
    const onSelect = renderPanel([citiMovement()], TRESM_FEB);

    // La tarjeta del movimiento: el único botón que lleva el nombre del cliente
    // junto a la línea de origen bancario.
    const card = screen.getAllByRole('button').find((el) =>
      el.textContent?.includes('3M MEXICO') && el.textContent?.includes('Cuenta'));
    fireEvent.click(card!);

    expect(onSelect).toHaveBeenCalledTimes(1);
    const [, anchor] = onSelect.mock.calls[0];
    expect(anchor).toBeTruthy();
    expect(typeof (anchor as DOMRect).top).toBe('number');
  });
});
