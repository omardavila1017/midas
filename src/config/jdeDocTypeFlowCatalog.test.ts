import { describe, expect, it } from 'vitest';
import { resolveCategoryForDocType } from './jdeDocTypeFlowCatalog';

describe('jdeDocTypeFlowCatalog · tipo_docto → categoría', () => {
  it('mapea el subconjunto de efectivo de alta confianza', () => {
    expect(resolveCategoryForDocType('PK')?.category).toBe('AP_PAYMENT');
    expect(resolveCategoryForDocType('PV')?.category).toBe('AP_PAYMENT');
    expect(resolveCategoryForDocType('RC')?.category).toBe('AR_COLLECTION');
    expect(resolveCategoryForDocType('T1')?.category).toBe('PAYROLL');
    expect(resolveCategoryForDocType('JT')?.category).toBe('TAX');
    expect(resolveCategoryForDocType('QD')).toEqual({
      category: 'OPEX', subcategory: 'Arrendamiento', label: 'Arrendamiento',
    });
  });

  it('aplica las decisiones de negocio para los códigos antes ambiguos', () => {
    // PU = Comprobación gastos de viaje → OPEX/Viáticos.
    expect(resolveCategoryForDocType('PU')).toMatchObject({ category: 'OPEX', subcategory: 'Viáticos' });
    // PW = Retención de requisiciones no almacenables → retención al SAT (TAX).
    expect(resolveCategoryForDocType('PW')).toMatchObject({ category: 'TAX', subcategory: 'Retenciones' });
    // RA Nota de cargo / RM Nota de crédito → cobranza.
    expect(resolveCategoryForDocType('RA')?.category).toBe('AR_COLLECTION');
    expect(resolveCategoryForDocType('RM')?.category).toBe('AR_COLLECTION');
    // Q7/Q8/Q9 IVA suspendido → TAX.
    for (const code of ['Q7', 'Q8', 'Q9']) {
      expect(resolveCategoryForDocType(code)).toMatchObject({ category: 'TAX', subcategory: 'IVA suspendido' });
    }
  });

  it('NO mapea lo que no toca efectivo (cae al comportamiento previo)', () => {
    // Autorización de presupuesto, FX, inventario, diario.
    for (const code of ['XN', 'X7', 'PG', 'RG', 'RU', 'RV', 'JE', 'AE', '99']) {
      expect(resolveCategoryForDocType(code)).toBeUndefined();
    }
    expect(resolveCategoryForDocType('')).toBeUndefined();
    expect(resolveCategoryForDocType(undefined)).toBeUndefined();
  });

  it('normaliza el código (trim + mayúsculas)', () => {
    expect(resolveCategoryForDocType('  pk ')?.category).toBe('AP_PAYMENT');
  });
});
