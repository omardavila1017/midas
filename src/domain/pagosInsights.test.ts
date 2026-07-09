import { describe, expect, it } from 'vitest';
import type { PagoProveedorRecord } from '../services/jdeTypes';
import type { PaymentMatch } from './paymentReconciliationEngine';
import {
  ORPHAN_STALE_DAYS,
  PAGO_STATUS_LABEL,
  attributePagoSource,
  buildPagadoPorMes,
  buildPagosDepuracionInsights,
  isPagoForeignCurrency,
  isRealOrphan,
  pagoDisplayStatus,
  pagoRecordKey,
  pagosToCsv,
  type PagosInsightId,
} from './pagosInsights';

const AS_OF = '2026-06-10';

function pago(overrides: Partial<PagoProveedorRecord>): PagoProveedorRecord {
  return {
    tipoPago: 'PT',
    noPago: '100',
    cia: '00001',
    nombreCia: 'SIR',
    cuentaBancaria: '38.1020.0010405 - BANAMEX - 7013 8708851',
    cuentaBanco: '70138708851',
    fechaPago: '2026-06-01',
    importePesos: 1000,
    moneda: 'MXP',
    batchPago: 'B-1',
    claveProveedor: '900',
    rfcProveedor: 'PDE900101AAA',
    nombreProveedor: 'Proveedor Demo',
    tipoBusqueda: 'Suppliers',
    clasificacionProveedor: 'Servicios',
    clasificacionProveedorFinanciera: '110 - Servicios',
    comentarioPago: 'FL CXP-1',
    ...overrides,
  };
}

function match(record: PagoProveedorRecord, overrides: Partial<PaymentMatch> = {}): PaymentMatch {
  return {
    payment: record,
    status: 'UNMATCHED',
    bankCoverage: 'covered',
    cxpMatches: [],
    reason: 'sin cxp ni cargo (test)',
    ...overrides,
  };
}

function findInsight(
  insights: ReturnType<typeof buildPagosDepuracionInsights>,
  id: PagosInsightId,
) {
  return insights.find((i) => i.id === id);
}

describe('attributePagoSource', () => {
  it('single source when neither bank nor cxp cross', () => {
    const attr = attributePagoSource(match(pago({})));
    expect(attr.sources).toEqual(['pagoproveedor']);
    expect(attr.crossed).toBe(false);
  });

  it('crosses bancos when a CARGO matched', () => {
    const m = match(pago({}), {
      status: 'MATCHED_BANK_ONLY',
      cargoMatch: {
        movement: { fechaOperacion: '2026-06-02', importe: -1000 } as unknown as NonNullable<PaymentMatch['cargoMatch']>['movement'],
        cia: '00001',
        cuenta: '70138708851',
        tier: 'exact',
        confidence: 1,
      },
    });
    const attr = attributePagoSource(m);
    expect(attr.sources).toEqual(['pagoproveedor', 'bancos']);
    expect(attr.crossed).toBe(true);
    expect(attr.crossKey).toContain('CARGO');
  });

  it('crosses cxp when it covers invoices', () => {
    const m = match(pago({}), {
      status: 'MATCHED_CXP_ONLY',
      cxpMatches: [{ cxp: {} as never, tier: 'folio-exact', confidence: 1 }],
    });
    const attr = attributePagoSource(m);
    expect(attr.sources).toEqual(['pagoproveedor', 'cxp']);
    expect(attr.crossKey).toContain('CXP');
  });
});

describe('pagoDisplayStatus / isRealOrphan', () => {
  it('splits UNMATCHED by bank coverage and reserves orphan for covered non-employees', () => {
    const covered = match(pago({}));
    expect(pagoDisplayStatus(covered)).toBe('UNMATCHED');
    expect(isRealOrphan(covered)).toBe(true);

    const noAccount = match(pago({}), { bankCoverage: 'no-account' });
    expect(pagoDisplayStatus(noAccount)).toBe('NO_BANK_DATA');
    expect(isRealOrphan(noAccount)).toBe(false);

    const employee = match(pago({ tipoBusqueda: 'Employees' }));
    expect(isRealOrphan(employee)).toBe(false);

    const matched = match(pago({}), { status: 'MATCHED_FULL' });
    expect(pagoDisplayStatus(matched)).toBe('MATCHED_FULL');
    expect(isRealOrphan(matched)).toBe(false);
  });
});

describe('isPagoForeignCurrency', () => {
  it('treats MXP/MXN/empty as pesos and everything else as divisa', () => {
    expect(isPagoForeignCurrency(pago({ moneda: 'MXP' }))).toBe(false);
    expect(isPagoForeignCurrency(pago({ moneda: 'MXN' }))).toBe(false);
    expect(isPagoForeignCurrency(pago({ moneda: '' }))).toBe(false);
    expect(isPagoForeignCurrency(pago({ moneda: 'USD' }))).toBe(true);
  });
});

describe('buildPagadoPorMes', () => {
  it('groups by payment month with provider/employee split, sorted, with focus keys', () => {
    const records = [
      pago({ noPago: '1', fechaPago: '2026-06-01', importePesos: 3000 }),
      pago({ noPago: '2', fechaPago: '2026-06-15', importePesos: 2000, tipoBusqueda: 'Employees' }),
      pago({ noPago: '3', fechaPago: '2026-01-10', importePesos: 500 }),
      pago({ noPago: '4', fechaPago: '' }), // sin fecha → fuera del strip
    ];
    const months = buildPagadoPorMes(records);
    expect(months.map((m) => m.ym)).toEqual(['2026-01', '2026-06']);

    const junio = months[1];
    expect(junio.count).toBe(2);
    expect(junio.totalMxn).toBe(5000);
    expect(junio.proveedoresMxn).toBe(3000);
    expect(junio.empleadosMxn).toBe(2000);
    expect(junio.keys).toEqual(['00001::1', '00001::2']);
  });
});

describe('buildPagosDepuracionInsights', () => {
  it('flags possible double payments only across distinct non-employee noPago', () => {
    const records = [
      pago({ noPago: 'A', importePesos: 5000 }),
      pago({ noPago: 'B', importePesos: 5000 }),
      // mismo monto pero empleado → vales idénticos legítimos, fuera
      pago({ noPago: 'C', importePesos: 5000, tipoBusqueda: 'Employees', claveProveedor: 'E1' }),
      pago({ noPago: 'D', importePesos: 5000, tipoBusqueda: 'Employees', claveProveedor: 'E1' }),
      // otro proveedor / otra fecha / otro monto → no agrupan
      pago({ noPago: 'E', importePesos: 5000, claveProveedor: '901' }),
      pago({ noPago: 'F', importePesos: 5001 }),
      pago({ noPago: 'G', importePesos: 5000, fechaPago: '2026-06-02' }),
    ];
    const hit = findInsight(buildPagosDepuracionInsights(records, AS_OF), 'posibleDoblePago');
    expect(hit).toBeDefined();
    expect(hit!.count).toBe(2);
    expect(hit!.totalMxn).toBe(10000);
    expect(hit!.keys.sort()).toEqual(['00001::A', '00001::B']);
  });

  it('flags stale real orphans only when matches are provided', () => {
    const oldOrphan = match(pago({ noPago: 'O1', fechaPago: '2026-04-01' }));
    const freshOrphan = match(pago({ noPago: 'O2', fechaPago: AS_OF }));
    const noCoverage = match(pago({ noPago: 'O3', fechaPago: '2026-04-01' }), { bankCoverage: 'no-account' });
    const matchedOld = match(pago({ noPago: 'O4', fechaPago: '2026-04-01' }), { status: 'MATCHED_FULL' });
    const records = [oldOrphan, freshOrphan, noCoverage, matchedOld].map((m) => m.payment);

    const without = buildPagosDepuracionInsights(records, AS_OF);
    expect(findInsight(without, 'huerfanoAntiguo')).toBeUndefined();

    const withMatches = buildPagosDepuracionInsights(records, AS_OF, [
      oldOrphan, freshOrphan, noCoverage, matchedOld,
    ]);
    const hit = findInsight(withMatches, 'huerfanoAntiguo');
    expect(hit).toBeDefined();
    expect(hit!.count).toBe(1);
    expect(hit!.keys).toEqual(['00001::O1']);
    expect(hit!.label).toContain(String(ORPHAN_STALE_DAYS));
  });

  it('flags field-level hygiene issues from the API record alone', () => {
    // Importes distintos por registro para no disparar el detector de dobles pagos.
    const records = [
      pago({ noPago: '1', fechaPago: '', importePesos: 101 }),
      pago({ noPago: '2', fechaPago: '2027-01-01', importePesos: 102 }),
      pago({ noPago: '3', cuentaBanco: '   ', importePesos: 103 }),
      pago({ noPago: '4', importePesos: 0 }),
      pago({ noPago: '5', moneda: 'USD', importePesos: 105 }),
      pago({ noPago: '6', rfcProveedor: '', importePesos: 106 }),
      pago({ noPago: '7', rfcProveedor: 'XAXX010101000', importePesos: 107 }),
      pago({ noPago: '8', clasificacionProveedorFinanciera: '220 - Por Clasificar', importePesos: 108 }),
      pago({ noPago: '9', clasificacionProveedorFinanciera: '', clasificacionProveedor: '', importePesos: 109 }),
      pago({ noPago: '10', comentarioPago: '  ', importePesos: 110 }),
      pago({ noPago: '11', importePesos: 111 }), // limpio
    ];
    const insights = buildPagosDepuracionInsights(records, AS_OF);
    const byId = (id: PagosInsightId) => findInsight(insights, id);

    expect(byId('sinFechaPago')!.keys).toEqual(['00001::1']);
    expect(byId('fechaFutura')!.keys).toEqual(['00001::2']);
    expect(byId('sinCuentaBanco')!.keys).toEqual(['00001::3']);
    expect(byId('importeNoPositivo')!.keys).toEqual(['00001::4']);
    expect(byId('monedaExtranjera')!.keys).toEqual(['00001::5']);
    expect(byId('sinRfc')!.keys).toEqual(['00001::6']);
    expect(byId('rfcGenerico')!.keys).toEqual(['00001::7']);
    expect(byId('porClasificar')!.keys.sort()).toEqual(['00001::8', '00001::9']);
    expect(byId('sinReferenciaCxp')!.keys).toEqual(['00001::10']);
    expect(byId('posibleDoblePago')).toBeUndefined();
  });

  it('skips employee payments for master-data findings (RFC/clasificación/referencia)', () => {
    const records = [
      pago({
        noPago: 'E1',
        tipoBusqueda: 'Employees',
        rfcProveedor: '',
        clasificacionProveedorFinanciera: '220 - Por Clasificar',
        comentarioPago: '',
      }),
    ];
    const insights = buildPagosDepuracionInsights(records, AS_OF);
    expect(findInsight(insights, 'sinRfc')).toBeUndefined();
    expect(findInsight(insights, 'porClasificar')).toBeUndefined();
    expect(findInsight(insights, 'sinReferenciaCxp')).toBeUndefined();
  });

  it('orders findings danger → warning → info, then by amount', () => {
    const records = [
      pago({ noPago: 'A', importePesos: 100 }),
      pago({ noPago: 'B', importePesos: 100 }), // doble pago (danger)
      pago({ noPago: 'C', fechaPago: '' }), // warning
      pago({ noPago: 'D', moneda: 'USD' }), // info
    ];
    const insights = buildPagosDepuracionInsights(records, AS_OF);
    const severities = insights.map((i) => i.severity);
    expect(severities).toEqual([...severities].sort(
      (a, b) => ({ danger: 0, warning: 1, info: 2 })[a] - ({ danger: 0, warning: 1, info: 2 })[b],
    ));
    expect(insights[0].id).toBe('posibleDoblePago');
  });
});

describe('pagosToCsv', () => {
  it('serializes API fields + derived cross status, escaping commas/quotes', () => {
    const m = match(
      pago({ comentarioPago: 'FL "CXP", VALE', nombreProveedor: 'ACME, SA' }),
      { bankCoverage: 'no-account' },
    );
    const csv = pagosToCsv([m]);
    const [header, row] = csv.split('\n');
    expect(header).toContain('Estado cruce');
    expect(header).toContain('Fuente');
    expect(header).toContain('Cruce');
    expect(header.split(',').length).toBe(24);
    expect(row).toContain('Pago a proveedores');
    expect(row).toContain('"ACME, SA"');
    expect(row).toContain('"FL ""CXP"", VALE"');
    expect(row).toContain(PAGO_STATUS_LABEL.NO_BANK_DATA);
  });

  it('includes cargo match details when present', () => {
    const m = match(pago({}), {
      status: 'MATCHED_FULL',
      cargoMatch: {
        movement: {
          fechaOperacion: '2026-06-02',
          importe: -1000,
        } as unknown as NonNullable<PaymentMatch['cargoMatch']>['movement'],
        cia: '00001',
        cuenta: '70138708851',
        tier: 'exact',
        confidence: 1,
      },
    });
    const row = pagosToCsv([m]).split('\n')[1];
    expect(row).toContain('02/06/2026'); // dd/mm/aaaa (B3.8)
    expect(row).toContain('exact');
    expect(row).toContain(PAGO_STATUS_LABEL.MATCHED_FULL);
  });
});

describe('pagoRecordKey', () => {
  it('matches the dedup key shape of fetchPagoProveedorRange', () => {
    expect(pagoRecordKey(pago({ cia: '00033', noPago: '777' }))).toBe('00033::777');
  });
});
