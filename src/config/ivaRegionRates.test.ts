import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INCOME_IVA_RATE,
  IVA_REGION_RATE_RULES,
  resolveIncomeIvaRate,
  type IvaRegionRateRule,
} from './ivaRegionRates';

describe('ivaRegionRates', () => {
  it('por defecto (catálogo fronterizo vacío) todo es 16%', () => {
    expect(DEFAULT_INCOME_IVA_RATE).toBe(16);
    expect(resolveIncomeIvaRate('00001', 'Transportes Tamaulipas')).toBe(16);
    expect(resolveIncomeIvaRate('00011')).toBe(16);
    expect(resolveIncomeIvaRate(undefined, undefined, undefined)).toBe(16);
    // El catálogo real arranca sin cías fronterizas.
    expect(IVA_REGION_RATE_RULES.flatMap((r) => r.cias ?? [])).toHaveLength(0);
  });

  it('aplica 8% a las cías/RFC/nombres marcados como fronterizos (regla inyectada)', () => {
    const rules: IvaRegionRateRule[] = [
      { rate: 8, cias: ['00001'], rfcs: ['TTA4906038F4'], namePatterns: [/frontera/i] },
    ];
    expect(resolveIncomeIvaRate('00001', 'X', undefined, rules)).toBe(8); // por cía
    expect(resolveIncomeIvaRate('1', 'X', undefined, rules)).toBe(8);     // padding-agnóstico
    expect(resolveIncomeIvaRate('90000', 'X', 'TTA4906038F4', rules)).toBe(8); // por RFC
    expect(resolveIncomeIvaRate('90000', 'Sucursal Frontera Norte', undefined, rules)).toBe(8); // por nombre
    expect(resolveIncomeIvaRate('00011', 'Otra', undefined, rules)).toBe(16); // no fronteriza → 16
  });
});
