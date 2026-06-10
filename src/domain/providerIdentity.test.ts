import { describe, expect, it } from 'vitest';
import type { Provider } from './types';
import {
  buildProviderIndex,
  isScientificJdeKey,
  normalizeJdeKey,
  providerBusinessClassification,
  provierClassificationLabel,
  reportUnmatchedProviders,
} from './providerIdentity';

function provider(patch: Partial<Provider>): Provider {
  return {
    id: 'p1',
    name: 'Proveedor Uno',
    type: 'Otro',
    risk: 'Medio',
    paymentPeriod: '30 días',
    ...patch,
  };
}

describe('providerBusinessClassification', () => {
  it('usa clasificacionAlberto como override de negocio', () => {
    expect(providerBusinessClassification(provider({
      clasificacionAlberto: 'CRITICO',
      clasificacionAutomatica: 'BAJO',
    }))).toEqual({ key: 'OPERACION', label: 'Operación' });
    expect(providerBusinessClassification(provider({ clasificacionAlberto: 'FLEX_ALTO' })).label).toBe('Prioritario');
    expect(providerBusinessClassification(provider({ clasificacionAlberto: 'FLEX_MEDIO' })).label).toBe('Negociable');
    expect(providerBusinessClassification(provider({ clasificacionAlberto: 'FLEX_BAJO' })).label).toBe('Flexible');
    expect(providerBusinessClassification(provider({ clasificacionAlberto: 'PAUSAR' })).label).toBe('Pausa');
  });

  it('usa clasificacionAutomatica cuando no hay override humano', () => {
    expect(providerBusinessClassification(provider({ clasificacionAutomatica: 'CRITICO' }))).toEqual({ key: 'OPERACION', label: 'Operación' });
    expect(providerBusinessClassification(provider({ clasificacionAutomatica: 'ALTO' }))).toEqual({ key: 'PRIORITARIO', label: 'Prioritario' });
    expect(providerBusinessClassification(provider({ clasificacionAutomatica: 'MEDIO' }))).toEqual({ key: 'NEGOCIABLE', label: 'Negociable' });
    expect(providerBusinessClassification(provider({ clasificacionAutomatica: 'BAJO' }))).toEqual({ key: 'FLEXIBLE', label: 'Flexible' });
  });

  it('marca sin clasificar cuando no hay proveedor o clasificacion', () => {
    expect(providerBusinessClassification(null)).toEqual({ key: 'SIN_CLASIFICAR', label: 'Sin clasificar' });
    expect(providerBusinessClassification(provider({}))).toEqual({ key: 'SIN_CLASIFICAR', label: 'Sin clasificar' });
    expect(provierClassificationLabel(provider({}))).toBeNull();
  });
});

describe('reportUnmatchedProviders', () => {
  it('excluye empleados (isEmployee) del reporte de sin catálogo', () => {
    const index = buildProviderIndex([
      provider({ id: 'real', name: 'DIESEL SA', numProveedorJDE: '107671', type: 'DIESEL' }),
      provider({ id: 'emp', name: 'JUAN PEREZ', numProveedorJDE: '200500', isEmployee: true, type: 'Prestaciones' }),
    ]);
    const report = reportUnmatchedProviders(index, [
      { jdeCode: '107671', name: 'DIESEL SA' },
      { jdeCode: '200500', name: 'JUAN PEREZ' },   // empleado → excluido
      { jdeCode: '999999', name: 'PROVEEDOR FANTASMA' }, // sin catálogo real
    ]);
    expect(report.totalRefs).toBe(2);
    expect(report.matched).toBe(1);
    expect(report.unmatched).toBe(1);
    expect(report.unmatchedSamples.map((s) => s.jdeCode)).toEqual(['999999']);
  });
});

describe('normalizeJdeKey — notación científica', () => {
  it('expande floats .NET en vez de mezclar mantisa y exponente', () => {
    expect(normalizeJdeKey('5.27835e+007')).toBe('52783500');
    expect(normalizeJdeKey('1.0e+005')).toBe('100000');
    expect(normalizeJdeKey('7.16756e+007')).toBe('71675600');
  });

  it('no altera números íntegros ni el strip de ceros a la izquierda', () => {
    expect(normalizeJdeKey('52783473')).toBe('52783473');
    expect(normalizeJdeKey('00107671')).toBe('107671');
    expect(normalizeJdeKey(' 107671 ')).toBe('107671');
    expect(normalizeJdeKey('')).toBe('');
  });

  it('detecta la forma científica con isScientificJdeKey', () => {
    expect(isScientificJdeKey('5.27835e+007')).toBe(true);
    expect(isScientificJdeKey('1E5')).toBe(true);
    expect(isScientificJdeKey('52783473')).toBe(false);
    expect(isScientificJdeKey(undefined)).toBe(false);
  });
});
