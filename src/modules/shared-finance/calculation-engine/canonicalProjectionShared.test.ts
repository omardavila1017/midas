import { describe, expect, it } from 'vitest';
import { resolveInflowSubcategory, INCOME_SUBCAT_CITI } from './canonicalProjectionShared';
import type { Client } from '../../../domain/types';

const emptyClients = new Map<string, Client>();

describe('resolveInflowSubcategory — buckets de ingreso por unidad de negocio', () => {
  it('routes uncrossed ABONOs on FEDERAL accounts to Federal', () => {
    expect(
      resolveInflowSubcategory({ clientById: emptyClients, businessUnitId: 'FEDERAL' }),
    ).toBe('Federal');
  });

  it('routes uncrossed ABONOs on MULTICARGA accounts (Sendex / guías prepagadas) to Multicarga', () => {
    // El bucket "Multicarga" existía en la taxonomía de Planeación pero el
    // resolver nunca lo emitía — el ingreso de paquetería caía a Clientes Citi.
    expect(
      resolveInflowSubcategory({ clientById: emptyClients, businessUnitId: 'MULTICARGA' }),
    ).toBe('Multicarga');
  });

  it('viajes_especiales subRole dominates over the account business unit', () => {
    expect(
      resolveInflowSubcategory({
        clientById: emptyClients,
        businessUnitId: 'FEDERAL',
        bankSubRole: 'viajes_especiales',
      }),
    ).toBe('Viajes Especiales');
  });

  it('crossed collections (rol) stay Citi even on Federal accounts', () => {
    expect(
      resolveInflowSubcategory({
        clientById: emptyClients,
        businessUnitId: 'FEDERAL',
        isRolCollection: true,
      }),
    ).toBe(INCOME_SUBCAT_CITI);
  });

  it('defaults to Clientes Citi when nothing matches', () => {
    expect(resolveInflowSubcategory({ clientById: emptyClients })).toBe(INCOME_SUBCAT_CITI);
  });
});
