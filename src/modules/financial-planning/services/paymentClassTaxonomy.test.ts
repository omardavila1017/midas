import { describe, expect, it } from 'vitest';
import type { FinancialMovement } from '../../shared-finance/types';
import { payClassBucketForMovement, payClassLabel, SIN_PAY_CLASS_BUCKET } from './paymentClassTaxonomy';

describe('payClassLabel', () => {
  it('une el par con · y respeta el orden general → financiera', () => {
    expect(payClassLabel('Servicios', '160 - Autopistas')).toBe('Servicios · 160 - Autopistas');
  });

  it('devuelve el lado que exista cuando el otro falta', () => {
    expect(payClassLabel('Servicios', undefined)).toBe('Servicios');
    expect(payClassLabel(undefined, '220 - Por Clasificar')).toBe('220 - Por Clasificar');
  });

  it('no repite el valor cuando ambos lados coinciden', () => {
    expect(payClassLabel('Bancario', 'Bancario')).toBe('Bancario');
  });

  it('devuelve null cuando no hay nada que mostrar', () => {
    expect(payClassLabel(undefined, undefined)).toBeNull();
    expect(payClassLabel('   ', '')).toBeNull();
  });

  it('colapsa whitespace aunque el productor no lo haya hecho', () => {
    // Defensa contra un movimiento servido del cache persistente de un build
    // anterior: sin esto el mismo valor abre dos grupos idénticos a la vista.
    expect(payClassLabel('-        .', undefined)).toBe('- .');
  });
});

describe('payClassBucketForMovement', () => {
  it('agrupa el pago a proveedor por el par crudo, centinelas incluidos', () => {
    expect(payClassBucketForMovement(movement({
      payClass: 'Servicios',
      payClassFinanciera: '220 - Por Clasificar',
    }))).toBe('Servicios · 220 - Por Clasificar');
    expect(payClassBucketForMovement(movement({ payClass: '" "' }))).toBe('" "');
  });

  it('confiesa el pago a proveedor sin ninguna clasificación', () => {
    expect(payClassBucketForMovement(movement({
      providerCategory: 'REFACCIONES',
      counterpartyName: 'Proveedor Cualquiera',
    }))).toBe(SIN_PAY_CLASS_BUCKET);
  });

  it('conserva los traspasos intercompañía fuera de la clasificación de pago', () => {
    // Un pago a una razón social del grupo es traspaso, no gasto con un
    // tercero: agruparlo por su clasificación lo mezclaría con proveedores.
    expect(payClassBucketForMovement(movement({
      counterpartyName: 'MULTICARGA SA DE CV',
      payClass: 'Filiales',
    }))).toBe('Empresas del grupo');
    expect(payClassBucketForMovement(movement({
      counterpartyName: 'Proveedor X',
      providerCategory: 'Filiales',
    }))).toBe('Empresas del grupo');
  });

  it('devuelve null para lo que no es pago a proveedor clasificable', () => {
    // CARGO de una cuenta pagadora PROPIA sin proveedor cruzado.
    expect(payClassBucketForMovement(movement({
      counterpartyType: 'BANK',
      counterpartyName: 'Sin identificar · BANAMEX 70141027881',
    }))).toBeNull();
    // Nómina / impuestos / deuda: el caller cae a la etiqueta de categoría.
    expect(payClassBucketForMovement(movement({ category: 'PAYROLL' }))).toBeNull();
    expect(payClassBucketForMovement(movement({ category: 'TAX' }))).toBeNull();
    expect(payClassBucketForMovement(movement({ category: 'DEBT' }))).toBeNull();
    // Ingresos nunca pasan por aquí.
    expect(payClassBucketForMovement(movement({
      type: 'INFLOW',
      category: 'AR_COLLECTION',
      payClass: 'Servicios',
    }))).toBeNull();
  });
});

function movement(patch: Partial<FinancialMovement>): FinancialMovement {
  const now = '2026-05-01T00:00:00.000Z';
  return {
    id: patch.id ?? 'm',
    sourceSystem: 'JDE',
    type: patch.type ?? 'OUTFLOW',
    category: patch.category ?? 'AP_PAYMENT',
    subcategory: patch.subcategory,
    providerCategory: patch.providerCategory,
    payClass: patch.payClass,
    payClassFinanciera: patch.payClassFinanciera,
    counterpartyName: patch.counterpartyName,
    counterpartyType: patch.counterpartyType ?? 'SUPPLIER',
    concept: 'Factura',
    currency: 'MXN',
    originalAmount: 0,
    baseAmount: 0,
    projectedAmount: 0,
    projectedDate: '2026-05-15',
    confidenceScore: 90,
    confidenceBand: 'HIGH',
    forecastMethod: 'RULE',
    status: 'PROJECTED_BASE',
    lockState: 'RESTRICTED',
    createdAt: now,
    updatedAt: now,
  };
}
