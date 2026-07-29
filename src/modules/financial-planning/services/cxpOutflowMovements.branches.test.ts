import { describe, expect, it } from 'vitest';
import type { CXPRecord } from '../../../domain/persistence';
import type { Provider } from '../../../domain/types';
import { buildCxpOutflowMovements } from './cxpOutflowMovements';

const AS_OF = '2026-05-07';
const END = '2026-12-31';

// Unreachable branch left uncovered on purpose: the `?? ''` fallbacks in the final
// `localeCompare` tie-breaker (cxpOutflowMovements.ts:147) can never fire — every emitted
// movement gets a `counterpartyName` from the `?? record.nombre ?? 'Proveedor sin nombre'`
// chain, so neither side of the comparison is ever nullish.

describe('buildCxpOutflowMovements — filtering branches', () => {
  it('filters by company code and keeps every record for "all" or an empty code', () => {
    const records = [
      cxp({ cia: '00001', noProveedor: '111', nombre: 'UNO', importePendientePesos: 100 }),
      cxp({ cia: '00002', noProveedor: '222', nombre: 'DOS', importePendientePesos: 200 }),
    ];
    const providers = [provider({ id: 'p1', numProveedorJDE: '111', name: 'UNO' }), provider({ id: 'p2', numProveedorJDE: '222', name: 'DOS' })];

    const scoped = buildCxpOutflowMovements({ cxpRecords: records, providers, companyCode: '00002', asOfDate: AS_OF, endDate: END });
    const all = buildCxpOutflowMovements({ cxpRecords: records, providers, companyCode: 'all', asOfDate: AS_OF, endDate: END });
    const empty = buildCxpOutflowMovements({ cxpRecords: records, providers, companyCode: '', asOfDate: AS_OF, endDate: END });

    expect(scoped.map((m) => m.companyId)).toEqual(['00002']);
    expect(all).toHaveLength(2);
    expect(empty).toHaveLength(2);
  });

  it('drops rows with a non-positive or non-numeric pending amount', () => {
    const movements = buildCxpOutflowMovements({
      cxpRecords: [
        cxp({ noProveedor: '111', nombre: 'CERO', importePendientePesos: 0 }),
        cxp({ noProveedor: '111', nombre: 'NEGATIVO', importePendientePesos: -500 }),
        cxp({ noProveedor: '111', nombre: 'NAN', importePendientePesos: 'x' as unknown as number }),
      ],
      providers: [provider({ id: 'p1', numProveedorJDE: '111', name: 'CERO' })],
      companyCode: 'all',
      asOfDate: AS_OF,
      endDate: END,
    });
    expect(movements).toHaveLength(0);
  });

  it('drops CXPs already flagged as PAID by PagoProveedor', () => {
    const record = cxp({ cia: '00001', noProveedor: '111', noFactura: 'F-9', nombre: 'UNO', importePendientePesos: 100 });
    const args = {
      cxpRecords: [record],
      providers: [provider({ id: 'p1', numProveedorJDE: '111', name: 'UNO' })],
      companyCode: 'all',
      asOfDate: AS_OF,
      endDate: END,
    };
    expect(buildCxpOutflowMovements({ ...args, paidCxpKeys: new Set(['00001::F-9::111']) })).toHaveLength(0);
    expect(buildCxpOutflowMovements({ ...args, paidCxpKeys: new Set(['00001::OTRA::111']) })).toHaveLength(1);
  });

  it('drops Pausa and Sin clasificar and keeps the four visible classes', () => {
    const movements = buildCxpOutflowMovements({
      cxpRecords: [
        cxp({ noProveedor: '111', nombre: 'CRITICO', importePendientePesos: 100 }),
        cxp({ noProveedor: '222', nombre: 'ALTO', importePendientePesos: 100 }),
        cxp({ noProveedor: '333', nombre: 'MEDIO', importePendientePesos: 100 }),
        cxp({ noProveedor: '444', nombre: 'BAJO', importePendientePesos: 100 }),
        cxp({ noProveedor: '555', nombre: 'PAUSA', importePendientePesos: 100 }),
        // Neither a catalog provider nor a classification on the record → SIN_CLASIFICAR.
        cxp({ noProveedor: '666', nombre: 'DESCONOCIDO', clasificacionProveedor: undefined, importePendientePesos: 100 }),
      ],
      providers: [
        provider({ id: 'p1', numProveedorJDE: '111', name: 'CRITICO', clasificacionAlberto: 'CRITICO' }),
        provider({ id: 'p2', numProveedorJDE: '222', name: 'ALTO', clasificacionAlberto: 'FLEX_ALTO' }),
        provider({ id: 'p3', numProveedorJDE: '333', name: 'MEDIO', clasificacionAlberto: 'FLEX_MEDIO' }),
        provider({ id: 'p4', numProveedorJDE: '444', name: 'BAJO', clasificacionAlberto: 'FLEX_BAJO' }),
        provider({ id: 'p5', numProveedorJDE: '555', name: 'PAUSA', clasificacionAlberto: 'PAUSAR' }),
      ],
      companyCode: 'all',
      asOfDate: AS_OF,
      endDate: END,
    });

    expect(movements.map((m) => m.subcategory)).toEqual(['CRITICO', 'FLEX_ALTO', 'FLEX_MEDIO', 'FLEX_BAJO']);
    // Score ladder for providers without an explicit score.
    expect(movements.map((m) => m.confidenceScore)).toEqual([92, 85, 75, 65]);
    // Only CRITICO / score >= 80 gets a HIGH band.
    expect(movements.map((m) => m.confidenceBand)).toEqual(['HIGH', 'HIGH', 'MEDIUM', 'MEDIUM']);
    expect(movements.map((m) => m.lockState)).toEqual(['LOCKED', 'RESTRICTED', 'RESTRICTED', 'RESTRICTED']);
  });

  it('falls back to the record classification when the provider is unknown', () => {
    const movements = buildCxpOutflowMovements({
      cxpRecords: [cxp({ noProveedor: 'SIN-DIGITOS', nombre: 'SOLO EN JDE', clasificacionProveedor: 'FLEX_ALTO', importePendientePesos: 100 })],
      providers: [],
      companyCode: 'all',
      asOfDate: AS_OF,
      endDate: END,
    });
    expect(movements[0]).toMatchObject({ subcategory: 'FLEX_ALTO', counterpartyName: 'SOLO EN JDE', counterpartyId: 'SIN-DIGITOS' });
  });

  it('drops movements projected past the requested window end', () => {
    const movements = buildCxpOutflowMovements({
      cxpRecords: [cxp({ noProveedor: '111', nombre: 'UNO', fechaProgramacionPago: '2027-01-15', fechaVence: '2027-01-15', importePendientePesos: 100 })],
      providers: [provider({ id: 'p1', numProveedorJDE: '111', name: 'UNO' })],
      companyCode: 'all',
      asOfDate: AS_OF,
      endDate: '2026-12-31',
    });
    expect(movements).toHaveLength(0);
  });
});

describe('buildCxpOutflowMovements — field fallback branches', () => {
  it('falls back through programming date, due date, invoice date and finally the as-of date', () => {
    const [byVence] = buildCxpOutflowMovements({
      cxpRecords: [cxp({ noProveedor: '111', nombre: 'UNO', fechaProgramacionPago: '', fechaVence: '2026-06-10', importePendientePesos: 100 })],
      providers: [provider({ id: 'p1', numProveedorJDE: '111', name: 'UNO' })],
      companyCode: 'all',
      asOfDate: AS_OF,
      endDate: END,
    });
    const [byFactura] = buildCxpOutflowMovements({
      cxpRecords: [cxp({ noProveedor: '111', nombre: 'UNO', fechaProgramacionPago: '', fechaVence: '', fechaFactura: '2026-06-20', importePendientePesos: 100 })],
      providers: [provider({ id: 'p1', numProveedorJDE: '111', name: 'UNO' })],
      companyCode: 'all',
      asOfDate: AS_OF,
      endDate: END,
    });
    const [byAsOf] = buildCxpOutflowMovements({
      cxpRecords: [cxp({ noProveedor: '111', nombre: 'UNO', fechaProgramacionPago: '  ', fechaVence: 'sin fecha', fechaFactura: '20/06/2026', importePendientePesos: 100 })],
      providers: [provider({ id: 'p1', numProveedorJDE: '111', name: 'UNO' })],
      companyCode: 'all',
      asOfDate: AS_OF,
      endDate: END,
    });

    expect(byVence.projectedDate).toBe('2026-06-10');
    expect(byFactura.projectedDate).toBe('2026-06-20');
    expect(byAsOf).toMatchObject({ projectedDate: AS_OF, issueDate: undefined, dueDate: undefined });
    expect(byAsOf.comments?.[0]).toBe(`Fecha CXP ${AS_OF}.`);
  });

  it('annotates overdue rows brought forward to the as-of date', () => {
    const [movement] = buildCxpOutflowMovements({
      cxpRecords: [cxp({ noProveedor: '111', nombre: 'UNO', fechaProgramacionPago: '2026-04-01', fechaVence: '2026-04-01', importePendientePesos: 100 })],
      providers: [provider({ id: 'p1', numProveedorJDE: '111', name: 'UNO' })],
      companyCode: 'all',
      asOfDate: AS_OF,
      endDate: END,
    });
    expect(movement.projectedDate).toBe(AS_OF);
    expect(movement.comments?.[0]).toBe(`Fecha CXP original 2026-04-01; se trae a ${AS_OF} por estar vencida.`);
  });

  it('falls back for missing supplier number, name, invoice number and provider type', () => {
    const [movement] = buildCxpOutflowMovements({
      cxpRecords: [cxp({
        cia: '00007',
        noProveedor: '',
        nombre: undefined as unknown as string,
        noFactura: '',
        clasifica: '',
        clasificacionProveedor: 'CRITICO',
        importePendientePesos: 100,
      })],
      providers: [],
      companyCode: 'all',
      asOfDate: AS_OF,
      endDate: END,
    });

    expect(movement).toMatchObject({
      id: 'cxp-invoice:00007:sin-proveedor:0:0',
      counterpartyName: 'Proveedor sin nombre',
      providerCategory: 'Sin categoría',
      sourceObjectId: undefined,
    });
    expect(movement.concept).toBe('Factura sin folio · Operación · Sin categoría');
  });

  it('uses the record clasifica when the catalog provider has a blank type', () => {
    const [movement] = buildCxpOutflowMovements({
      cxpRecords: [cxp({ noProveedor: '111', nombre: 'UNO', clasifica: 'REFACCIONES', importePendientePesos: 100 })],
      providers: [provider({ id: 'p1', numProveedorJDE: '111', name: 'UNO', type: '   ' as Provider['type'] })],
      companyCode: 'all',
      asOfDate: AS_OF,
      endDate: END,
    });
    expect(movement.providerCategory).toBe('REFACCIONES');
  });

  it('matches by provider name when the record carries no usable supplier number', () => {
    const [movement] = buildCxpOutflowMovements({
      cxpRecords: [cxp({ noProveedor: '', nombre: '  Acme Refacciones  ', importePendientePesos: 100 })],
      providers: [provider({ id: 'p-acme', name: 'ACME REFACCIONES', numProveedorJDE: undefined })],
      companyCode: 'all',
      asOfDate: AS_OF,
      endDate: END,
    });
    expect(movement).toMatchObject({ counterpartyId: 'p-acme', counterpartyName: 'ACME REFACCIONES' });
  });

  it('clamps an out-of-range catalog score and keeps IVA metadata only when taxes exist', () => {
    const [withTax, withoutTax] = buildCxpOutflowMovements({
      cxpRecords: [
        cxp({ noProveedor: '111', nombre: 'CON IVA', noFactura: 'A', importeImpuestosPesos: 160, importePendientePesos: 1160 }),
        cxp({ noProveedor: '222', nombre: 'SIN IVA', noFactura: 'B', importeImpuestosPesos: 0, importePendientePesos: 1000 }),
      ],
      providers: [
        provider({ id: 'p1', numProveedorJDE: '111', name: 'CON IVA', score: 480 }),
        provider({ id: 'p2', numProveedorJDE: '222', name: 'SIN IVA', score: -20 }),
      ],
      companyCode: 'all',
      asOfDate: AS_OF,
      endDate: END,
    });

    expect(withTax).toMatchObject({ confidenceScore: 100, taxTreatment: 'IVA_CREDITABLE', taxRate: 16 });
    expect(withoutTax).toMatchObject({ confidenceScore: 0, taxTreatment: 'UNCLASSIFIED', taxRate: undefined });
  });

  it('ignores a non-finite catalog score and falls back to the classification ladder', () => {
    const [movement] = buildCxpOutflowMovements({
      cxpRecords: [cxp({ noProveedor: '111', nombre: 'UNO', importePendientePesos: 100 })],
      providers: [provider({ id: 'p1', numProveedorJDE: '111', name: 'UNO', clasificacionAlberto: 'FLEX_ALTO', score: Number.NaN })],
      companyCode: 'all',
      asOfDate: AS_OF,
      endDate: END,
    });
    expect(movement.confidenceScore).toBe(85);
  });
});

describe('buildCxpOutflowMovements — sort tie-breakers', () => {
  it('breaks score ties by projected date and then by counterparty name', () => {
    const movements = buildCxpOutflowMovements({
      cxpRecords: [
        cxp({ noProveedor: '111', nombre: 'ZETA', noFactura: 'Z', fechaProgramacionPago: '2026-06-10', fechaVence: '2026-06-10', importePendientePesos: 100 }),
        cxp({ noProveedor: '222', nombre: 'BETA', noFactura: 'B', fechaProgramacionPago: '2026-06-05', fechaVence: '2026-06-05', importePendientePesos: 100 }),
        cxp({ noProveedor: '333', nombre: 'ALFA', noFactura: 'A', fechaProgramacionPago: '2026-06-10', fechaVence: '2026-06-10', importePendientePesos: 100 }),
      ],
      providers: [
        provider({ id: 'p1', numProveedorJDE: '111', name: 'ZETA', clasificacionAlberto: 'FLEX_MEDIO' }),
        provider({ id: 'p2', numProveedorJDE: '222', name: 'BETA', clasificacionAlberto: 'FLEX_MEDIO' }),
        provider({ id: 'p3', numProveedorJDE: '333', name: 'ALFA', clasificacionAlberto: 'FLEX_MEDIO' }),
      ],
      companyCode: 'all',
      asOfDate: AS_OF,
      endDate: END,
    });

    expect(movements.map((m) => m.counterpartyName)).toEqual(['BETA', 'ALFA', 'ZETA']);
  });
});

function provider(patch: Partial<Provider>): Provider {
  return {
    id: patch.id ?? 'p',
    name: patch.name ?? 'Proveedor',
    type: patch.type ?? 'Sin categoría',
    risk: 'Medio',
    paymentPeriod: '30 días',
    clasificacionAlberto: 'clasificacionAlberto' in patch ? patch.clasificacionAlberto : 'CRITICO',
    numProveedorJDE: patch.numProveedorJDE,
    score: patch.score,
  };
}

function cxp(patch: Partial<CXPRecord>): CXPRecord {
  return {
    cia: patch.cia ?? '00001',
    noProveedor: patch.noProveedor ?? '',
    nombre: 'nombre' in patch ? (patch.nombre as string) : 'Proveedor',
    noFactura: patch.noFactura ?? 'F-1',
    fechaFactura: patch.fechaFactura ?? '2026-05-01',
    fechaVence: patch.fechaVence ?? '2026-05-15',
    fechaProgramacionPago: patch.fechaProgramacionPago ?? '2026-05-15',
    diasVencida: 0,
    importeBrutoPesos: patch.importeBrutoPesos ?? patch.importePendientePesos ?? 0,
    importePendientePesos: patch.importePendientePesos ?? 0,
    importeSubtotalPesos: patch.importeSubtotalPesos ?? patch.importePendientePesos ?? 0,
    importeImpuestosPesos: patch.importeImpuestosPesos ?? 0,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXN',
    condPago: '',
    clasifica: patch.clasifica ?? '',
    clasificacionProveedor: 'clasificacionProveedor' in patch
      ? (patch.clasificacionProveedor as string)
      : '',
    edoPago: '',
    tipoCambio: 1,
    porVencer: 0,
    v1_30: 0,
    v31_60: 0,
    v61_90: 0,
    v91_120: 0,
    v121_150: 0,
    v151_180: 0,
    mas180: 0,
  };
}
