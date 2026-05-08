import { describe, expect, it } from 'vitest';
import type { CXPRecord } from '../../../domain/persistence';
import type { Provider } from '../../../domain/types';
import { buildCxpOutflowMovements } from './cxpOutflowMovements';

describe('buildCxpOutflowMovements', () => {
  it('keeps Alberto classification as the top group and emits invoice-dated provider rows with catalog category', () => {
    const movements = buildCxpOutflowMovements({
      cxpRecords: [
        cxp({ noProveedor: '000123', nombre: 'ACME REFACCIONES', noFactura: 'MAY-1', fechaProgramacionPago: '2026-05-20', importePendientePesos: 1200 }),
        cxp({ noProveedor: '000456', nombre: 'NETSYS TI', noFactura: 'JUL-1', fechaProgramacionPago: '2026-07-10', importePendientePesos: 2400 }),
      ],
      providers: [
        provider({
          id: 'p-123',
          numProveedorJDE: '123',
          name: 'ACME REFACCIONES',
          type: 'REFACCIONES',
          clasificacionAlberto: 'CRITICO',
          score: 98,
        }),
        provider({
          id: 'p-456',
          numProveedorJDE: '456',
          name: 'NETSYS TI',
          type: 'TECNOLOGIA',
          clasificacionAlberto: 'CRITICO',
          score: 90,
        }),
      ],
      companyCode: 'all',
      asOfDate: '2026-05-07',
      endDate: '2026-12-31',
    });

    const may = movements.filter((movement) => movement.projectedDate.startsWith('2026-05'));
    const july = movements.filter((movement) => movement.projectedDate.startsWith('2026-07'));
    const june = movements.filter((movement) => movement.projectedDate.startsWith('2026-06'));
    expect(movements).toHaveLength(2);
    expect(may).toHaveLength(1);
    expect(july).toHaveLength(1);
    expect(june).toHaveLength(0);
    expect(movements.map((movement) => movement.counterpartyName)).toEqual(['ACME REFACCIONES', 'NETSYS TI']);
    expect(movements.every((movement) => movement.subcategory === 'CRITICO')).toBe(true);
    expect(movements.map((movement) => movement.providerCategory).sort()).toEqual(['REFACCIONES', 'TECNOLOGIA']);
    expect(movements.find((movement) => movement.counterpartyName === 'ACME REFACCIONES')?.projectedAmount).toBe(1200);
    expect(movements.find((movement) => movement.counterpartyName === 'ACME REFACCIONES')?.status).toBe('PROJECTED_BASE');
  });

  it('moves overdue CXP to as-of date and sorts higher score providers first', () => {
    const movements = buildCxpOutflowMovements({
      cxpRecords: [
        cxp({ noProveedor: '000111', nombre: 'OPERACION CRITICA', noFactura: 'OLD', fechaProgramacionPago: '2026-04-30', fechaVence: '2026-04-30', importePendientePesos: 500 }),
        cxp({ noProveedor: '000222', nombre: 'FLEXIBLE ALTO', noFactura: 'SOON', fechaProgramacionPago: '2026-05-08', importePendientePesos: 900 }),
      ],
      providers: [
        provider({
          id: 'p-111',
          numProveedorJDE: '111',
          name: 'OPERACION CRITICA',
          type: 'OPERACION',
          clasificacionAlberto: 'CRITICO',
          score: 100,
        }),
        provider({
          id: 'p-222',
          numProveedorJDE: '222',
          name: 'FLEXIBLE ALTO',
          type: 'SERVICIOS',
          clasificacionAlberto: 'FLEX_ALTO',
          score: 95,
        }),
      ],
      companyCode: 'all',
      asOfDate: '2026-05-07',
      endDate: '2026-12-31',
    });

    expect(movements[0]).toMatchObject({
      counterpartyName: 'OPERACION CRITICA',
      projectedDate: '2026-05-07',
      subcategory: 'CRITICO',
      providerCategory: 'OPERACION',
      confidenceScore: 100,
    });
  });

  it('does not schedule CXP before invoice due date even if payment programming is earlier', () => {
    const movements = buildCxpOutflowMovements({
      cxpRecords: [
        cxp({
          noProveedor: '000333',
          nombre: 'PROVEEDOR CON CREDITO',
          noFactura: 'EARLY-PROGRAM',
          fechaProgramacionPago: '2026-05-08',
          fechaVence: '2026-05-20',
          importePendientePesos: 750,
        }),
      ],
      providers: [
        provider({
          id: 'p-333',
          numProveedorJDE: '333',
          name: 'PROVEEDOR CON CREDITO',
          type: 'OPERACION',
          clasificacionAlberto: 'CRITICO',
          score: 99,
        }),
      ],
      companyCode: 'all',
      asOfDate: '2026-05-07',
      endDate: '2026-12-31',
    });

    expect(movements[0]).toMatchObject({
      projectedDate: '2026-05-20',
      dueDate: '2026-05-20',
    });
  });
});

function provider(patch: Partial<Provider>): Provider {
  return {
    id: patch.id ?? 'p',
    name: patch.name ?? 'Proveedor',
    type: patch.type ?? 'Sin categoría',
    risk: 'Medio',
    paymentPeriod: '30 días',
    clasificacionAlberto: patch.clasificacionAlberto,
    numProveedorJDE: patch.numProveedorJDE,
    score: patch.score,
  };
}

function cxp(patch: Partial<CXPRecord>): CXPRecord {
  return {
    cia: patch.cia ?? '00001',
    noProveedor: patch.noProveedor ?? '',
    nombre: patch.nombre ?? 'Proveedor',
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
    clasificacionProveedor: patch.clasificacionProveedor ?? '',
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
