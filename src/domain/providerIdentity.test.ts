import { describe, expect, it } from 'vitest';
import type { Provider } from './types';
import { providerBusinessClassification, provierClassificationLabel } from './providerIdentity';

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
