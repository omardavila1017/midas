import { describe, expect, it } from 'vitest';
import type { Client, Provider } from '../../../domain/types';
import type { FinancialProjectionSourceInput } from './financialProjectionService';
import { projectionSourcePersistentCacheKey } from './financialProjectionPersistentCache';
import {
  CLIENT_CACHE_KEY_FIELDS,
  PROVIDER_CACHE_KEY_FIELDS,
  sameByCacheKeyFields,
} from './projectionCacheFingerprint';

// Estas listas son la ÚNICA fuente de verdad compartida entre la llave del
// cache persistente y los guards de idempotencia de AppCore (`setProviders`).
// Si alguien agrega un campo a la llave sin agregarlo a la lista, el guard
// empezaría a tragarse cambios reales en silencio: estos tests lo fijan.
describe('projectionCacheFingerprint — sync con la llave del cache', () => {
  it('cada campo de PROVIDER_CACHE_KEY_FIELDS mueve la llave', () => {
    const base = projectionInput({ providers: [provider()] });
    const baseKey = projectionSourcePersistentCacheKey(base);

    for (const field of PROVIDER_CACHE_KEY_FIELDS) {
      const mutated = projectionInput({
        providers: [{ ...provider(), [field]: mutatedValue(provider()[field]) } as Provider],
      });
      expect(projectionSourcePersistentCacheKey(mutated), `campo ${field}`).not.toBe(baseKey);
    }
  });

  it('cada campo de CLIENT_CACHE_KEY_FIELDS mueve la llave', () => {
    const base = projectionInput({ clients: [client()] });
    const baseKey = projectionSourcePersistentCacheKey(base);

    for (const field of CLIENT_CACHE_KEY_FIELDS) {
      const mutated = projectionInput({
        clients: [{ ...client(), [field]: mutatedValue(client()[field]) } as Client],
      });
      expect(projectionSourcePersistentCacheKey(mutated), `campo ${field}`).not.toBe(baseKey);
    }
  });

  // Contraparte del test anterior: los campos fuera de la lista NO mueven la
  // llave, que es exactamente por qué el guard puede ignorarlos.
  it('un campo fuera de las listas no mueve la llave', () => {
    const baseKey = projectionSourcePersistentCacheKey(
      projectionInput({ providers: [provider()], clients: [client()] }),
    );
    const offKey = projectionSourcePersistentCacheKey(projectionInput({
      providers: [{ ...provider(), riskComment: 'otro comentario', numPagos2025: 99 }],
      clients: [{ ...client(), notes: 'otra nota' }],
    }));

    expect(offKey).toBe(baseKey);
  });
});

describe('sameByCacheKeyFields', () => {
  it('es true para arrays con identidad distinta y mismo contenido', () => {
    expect(sameByCacheKeyFields([provider()], [provider()], PROVIDER_CACHE_KEY_FIELDS)).toBe(true);
  });

  it('es false cuando cambia un campo de la llave, el largo o el orden', () => {
    expect(sameByCacheKeyFields(
      [provider()],
      [{ ...provider(), score: 51 }],
      PROVIDER_CACHE_KEY_FIELDS,
    )).toBe(false);
    expect(sameByCacheKeyFields(
      [provider()],
      [provider(), { ...provider(), id: 'p-2' }],
      PROVIDER_CACHE_KEY_FIELDS,
    )).toBe(false);
    expect(sameByCacheKeyFields(
      [provider(), { ...provider(), id: 'p-2' }],
      [{ ...provider(), id: 'p-2' }, provider()],
      PROVIDER_CACHE_KEY_FIELDS,
    )).toBe(false);
  });

  // Trade-off documentado del guard: un cambio que no puede alterar ninguna
  // cifra del motor tampoco re-commitea el estado.
  it('es true cuando sólo cambia un campo fuera de la llave', () => {
    expect(sameByCacheKeyFields(
      [provider()],
      [{ ...provider(), numPagos2025: 99 }],
      PROVIDER_CACHE_KEY_FIELDS,
    )).toBe(true);
  });

  it('trata undefined como distinto salvo que ambos lados estén vacíos', () => {
    expect(sameByCacheKeyFields(undefined, [], PROVIDER_CACHE_KEY_FIELDS)).toBe(false);
    expect(sameByCacheKeyFields([], [], PROVIDER_CACHE_KEY_FIELDS)).toBe(true);
  });
});

function provider(): Provider {
  return {
    id: 'p-1',
    name: 'Proveedor Uno',
    type: 'Servicios',
    risk: 'Medio',
    riskComment: 'comentario',
    paymentPeriod: '30 días',
    flexibility: 'flexible',
    score: 50,
    clasificacionAlberto: 'FLEX_MEDIO',
    montoPromedioPago: 1_000,
    gastoMinimoMensual: 2_000,
    lastUpdatedAt: '2026-07-31T00:00:00.000Z',
    numPagos2025: 12,
  };
}

function client(): Client {
  return {
    id: 'c-1',
    name: 'Cliente Uno',
    paymentDay: { kind: 'DOM', day: 15 },
    paymentDayName: 'Viernes',
    creditDays: 30,
    frequency: 'Mensual',
    commercialGroupId: 'grupo-1',
    monthlyBilling: new Array(12).fill(0),
    notes: 'nota',
  };
}

/** Valor distinto del actual, preservando el tipo del campo. */
function mutatedValue(current: unknown): unknown {
  if (typeof current === 'number') return current + 1;
  if (typeof current === 'string') return `${current}-x`;
  if (typeof current === 'boolean') return !current;
  return { kind: 'ANY' };
}

function projectionInput(patch: Partial<FinancialProjectionSourceInput>): FinancialProjectionSourceInput {
  return {
    companyCode: 'all',
    bankStatements: [],
    clients: [],
    providers: [],
    cxpRecords: [],
    assumptions: { year: 2026, globalCompliance: 1, factorajeDays: 30 },
    budget: null,
    startingBalance: 0,
    asOfDate: '2026-07-31',
    ...patch,
  };
}
