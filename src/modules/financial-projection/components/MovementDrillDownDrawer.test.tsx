import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MovementDrillDownDrawer } from './MovementDrillDownDrawer';
import type { FinancialMovement } from '../../shared-finance/types';
import type { CobranzaRecord } from '../../../services/jdeTypes';
import type { CashFlowAssumptions } from '../../../domain/types';

/** Línea sintética del prorrateo Citi, tal como la emite `citiLine`. */
function citiMovement(patch: Partial<FinancialMovement> = {}): FinancialMovement {
  return {
    id: 'citi-prorrateo:00011:55768551:2026-02',
    sourceSystem: 'BANK',
    type: 'INFLOW',
    category: 'AR_COLLECTION',
    subcategory: 'Clientes Citi',
    companyId: '00011',
    counterpartyId: '55768551',
    counterpartyName: 'ARGO PROYECTOS Y ESTRUCTURAS',
    counterpartyType: 'CUSTOMER',
    concept: 'Cobro Citi ARGO PROYECTOS Y ESTRUCTURAS (depósito concentradora 2026-02)',
    currency: 'MXN',
    originalAmount: 104_295.60,
    baseAmount: 104_295.60,
    projectedAmount: 104_295.60,
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
    noCliente: '55768551',
    nombreCliente: 'ARGO PROYECTOS Y ESTRUCTURAS',
    noFactura: 'RI-301711',
    fechaFactura: '2026-01-02',
    fechaVence: '2026-01-30',
    fechaCobro: '2026-02-12',
    diasVencida: 0,
    importeBrutoPesos: 13_906.08,
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

/** Las 5 facturas reales de ARGO cobradas en 2026-02 (BD, cía 00011). */
const ARGO_FEB = [
  cobranza({ noFactura: 'RI-301711', fechaFactura: '2026-01-02', fechaCobro: '2026-02-12', importeBrutoPesos: 13_906.08 }),
  cobranza({ noFactura: 'RI-302177', fechaFactura: '2026-01-16', fechaCobro: '2026-02-12', importeBrutoPesos: 20_859.12 }),
  cobranza({ noFactura: 'RI-302663', fechaFactura: '2026-02-02', fechaCobro: '2026-02-12', importeBrutoPesos: 25_494.48 }),
  cobranza({ noFactura: 'RI-303194', fechaFactura: '2026-02-16', fechaCobro: '2026-02-25', importeBrutoPesos: 20_859.12 }),
  cobranza({ noFactura: 'RI-303794', fechaFactura: '2026-03-02', fechaCobro: '2026-02-25', importeBrutoPesos: 23_176.80 }),
];

const assumptions = {} as CashFlowAssumptions;

/**
 * El drawer exige un `anchor` real: `if (!movement || !anchor || !pos) return
 * null`. Pasarlo en null es justo el defecto que tenía Planeación — el
 * drilldown nunca se abría.
 */
const anchor = {
  top: 200, bottom: 220, left: 100, right: 600, width: 500, height: 20,
  x: 100, y: 200, toJSON: () => ({}),
} as DOMRect;

const context = (records: CobranzaRecord[]) => ({
  cxpRecords: [],
  cobranzaRecords: records,
  clients: [],
  assumptions,
  budget: null,
});

describe('MovementDrillDownDrawer · desglose de facturas Citi', () => {
  it('lista las facturas que respaldan la línea del prorrateo', () => {
    render(
      <MovementDrillDownDrawer
        movement={citiMovement()}
        anchor={anchor}
        onClose={() => {}}
        invoiceContext={context(ARGO_FEB)}
      />,
    );
    expect(screen.getByText('Facturas CXC JDE (5)')).toBeTruthy();
    for (const folio of ['RI-301711', 'RI-302177', 'RI-302663', 'RI-303194', 'RI-303794']) {
      expect(screen.getByText(folio)).toBeTruthy();
    }
    // Factor 1: las facturas suman lo atribuido.
    expect(screen.getByText('1.000')).toBeTruthy();
    expect(screen.getByText(/el depósito se acreditó completo/i)).toBeTruthy();
  });

  it('declara el factor cuando el reparto proporcional atribuyó menos que las facturas', () => {
    render(
      <MovementDrillDownDrawer
        movement={citiMovement({
          projectedAmount: 104_295.60 * 0.84,
          baseAmount: 104_295.60 * 0.84,
        })}
        anchor={anchor}
        onClose={() => {}}
        invoiceContext={context(ARGO_FEB)}
      />,
    );
    expect(screen.getByText('0.840')).toBeTruthy();
    // La nota NO puede afirmar que "el depósito no alcanzó": el factor < 1
    // también sale de que el motor descontara lo ya atribuido por cruce directo,
    // y en ese caso el depósito SÍ alcanzaba.
    expect(screen.getByText(/se le atribuyó el 84\.0% de sus facturas del periodo/i)).toBeTruthy();
    expect(screen.queryByText(/no alcanza/i)).toBeNull();
  });

  it('NO cuelga el desglose del mes a un `cxc:` del mismo cliente — ése tiene su propio folio', () => {
    // El bucket `Clientes Citi` lo llevan también `cxc:`, `bank:` y `rol:`. Un
    // `cxc:` es UNA factura (`sourceObjectId` = folio) y el drawer ya la resolvía
    // exacto; el desglose del prorrateo la tapaba con las 5 del mes + un factor
    // de reparto, afirmando un respaldo que no es el suyo.
    render(
      <MovementDrillDownDrawer
        movement={citiMovement({
          id: 'cxc:00011:55768551:RI-302663',
          sourceSystem: 'JDE',
          sourceObjectId: 'RI-302663',
          status: 'PROJECTED_BASE',
          concept: 'Factura CXC RI-302663 · ARGO PROYECTOS Y ESTRUCTURAS',
        })}
        anchor={anchor}
        onClose={() => {}}
        invoiceContext={context(ARGO_FEB)}
      />,
    );
    // Sección exacta por folio, no el desglose del periodo.
    expect(screen.queryByText('Factor aplicado')).toBeNull();
    expect(screen.queryByText('Suma de facturas')).toBeNull();
    expect(screen.getByText('Factura CXC JDE')).toBeTruthy();
    expect(screen.queryByText('RI-301711')).toBeNull();
  });

  it('no rompe cuando no llega cobranza en el contexto (comportamiento previo)', () => {
    render(
      <MovementDrillDownDrawer
        movement={citiMovement()}
        anchor={anchor}
        onClose={() => {}}
        invoiceContext={context([])}
      />,
    );
    expect(screen.queryByText(/Facturas CXC JDE/)).toBeNull();
  });
});
