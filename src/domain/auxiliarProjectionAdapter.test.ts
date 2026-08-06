import { describe, expect, it } from 'vitest';
import { mergeCargoEnrichments, type BankOutflowEnrichment } from './auxiliarProjectionAdapter';

/**
 * Los DOS productores de enriquecimiento de CARGO histórico se unen aquí. El
 * puente del libro mayor sabe QUÉ movimiento es pago a proveedor pero sólo puede
 * nombrarlo con el texto del GL; `paymentReconciliationEngine` trae la clave y la
 * clasificación de JDE. Antes del 2026-08-06 sólo llegaba el primero, así que el
 * bucket del egreso histórico de Planeación se decidía por nombre contra el
 * catálogo de proveedores (~23% de cobertura).
 */
describe('mergeCargoEnrichments', () => {
  const ledger = (nombre: string): BankOutflowEnrichment => ({
    status: 'MATCHED',
    payments: [{ nombreProveedor: nombre, importe: 100 }],
  });

  it('el pago le gana al texto del mayor: aporta clave, nombre JDE y clasificación', () => {
    const merged = mergeCargoEnrichments(
      new Map([['K1', ledger('CUENTA 1020 BANCOS')]]),
      new Map([['K1', {
        status: 'MATCHED' as const,
        payments: [{
          claveProveedor: '55501',
          nombreProveedor: 'REFACCIONES DEL NORTE SA DE CV',
          clasificacionProveedor: 'Servicios',
          clasificacionProveedorFinanciera: '010 - Refacciones y Llantas',
          importe: 100,
        }],
      }]]),
    );

    expect(merged.get('K1')?.payments?.[0]).toMatchObject({
      claveProveedor: '55501',
      nombreProveedor: 'REFACCIONES DEL NORTE SA DE CV',
      clasificacionProveedor: 'Servicios',
      clasificacionProveedorFinanciera: '010 - Refacciones y Llantas',
    });
  });

  it('NUNCA degrada: un ORPHAN del motor de pagos conserva el MATCHED del mayor', () => {
    const merged = mergeCargoEnrichments(
      new Map([['K1', ledger('PROVEEDOR GL')]]),
      new Map([['K1', { status: 'ORPHAN' as const }]]),
    );

    expect(merged.get('K1')?.status).toBe('MATCHED');
    expect(merged.get('K1')?.payments?.[0].nombreProveedor).toBe('PROVEEDOR GL');
  });

  it('un MATCHED sin pagos tampoco degrada al mayor', () => {
    const merged = mergeCargoEnrichments(
      new Map([['K1', ledger('PROVEEDOR GL')]]),
      new Map([['K1', { status: 'MATCHED' as const, payments: [] }]]),
    );

    expect(merged.get('K1')?.payments?.[0].nombreProveedor).toBe('PROVEEDOR GL');
  });

  it('conserva las llaves del mayor que el motor de pagos no cruzó, y agrega las suyas', () => {
    const merged = mergeCargoEnrichments(
      new Map([['SOLO-GL', ledger('PROVEEDOR GL')]]),
      new Map([['SOLO-PAGO', {
        status: 'MATCHED' as const,
        payments: [{ claveProveedor: '9', nombreProveedor: 'PROVEEDOR JDE', importe: 5 }],
      }]]),
    );

    expect([...merged.keys()].sort()).toEqual(['SOLO-GL', 'SOLO-PAGO']);
  });

  it('sin mapa de pagos devuelve la MISMA referencia (no invalida la identidad del input)', () => {
    const fromLedger = new Map([['K1', ledger('PROVEEDOR GL')]]);

    expect(mergeCargoEnrichments(fromLedger, undefined)).toBe(fromLedger);
    expect(mergeCargoEnrichments(fromLedger, new Map())).toBe(fromLedger);
  });
});
