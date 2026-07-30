import { describe, expect, it } from 'vitest';
import type { Client } from './types';
import type { ViajeEspecialRecord } from '../services/jdeTypes';
import {
  applyViajesEspecialesGroup,
  VIAJES_ESPECIALES_GROUP_ID,
  VIAJES_ESPECIALES_GROUP_NAME,
} from './viajesEspecialesCatalog';

function client(name: string, overrides: Partial<Client> = {}): Client {
  return {
    id: name.toLowerCase().replace(/\W+/g, '-'),
    name,
    paymentDay: { kind: 'ANY' },
    frequency: 'Mensual',
    creditDays: 30,
    monthlyBilling: new Array(12).fill(100_000),
    ...overrides,
  };
}

function link(cia: string, noCliente: string) {
  return {
    cia,
    noCliente,
    nombreCliente: `CLIENTE ${noCliente}`,
    matchedAt: '2026-01-01',
    matchedBy: 'user' as const,
  };
}

function viaje(overrides: Partial<ViajeEspecialRecord> = {}): ViajeEspecialRecord {
  return {
    cia: '00150',
    empresaCodigo: 'SIRS2',
    kRenta: 1,
    kCliente: 10,
    dCliente: 'CLIENTE VIAJE',
    rfc: '',
    claveJDE: '12345',
    totalNegociado: 50_000,
    diasCredito: 30,
    ...overrides,
  };
}

describe('applyViajesEspecialesGroup', () => {
  it('returns the same array (identity) and zero counts when there are no viajes', () => {
    const clients = [client('A', { jdeAccounts: [link('00150', '12345')] })];
    const res = applyViajesEspecialesGroup(clients, []);
    expect(res.clients).toBe(clients);
    expect(res.promotedCount).toBe(0);
    expect(res.unmatchedClaveJdeCount).toBe(0);
  });

  it('is a no-op when no viaje carries a claveJDE', () => {
    const clients = [client('A', { jdeAccounts: [link('00150', '12345')] })];
    const res = applyViajesEspecialesGroup(clients, [viaje({ claveJDE: '' })]);
    expect(res.clients).toBe(clients);
    expect(res.promotedCount).toBe(0);
    expect(res.unmatchedClaveJdeCount).toBe(0);
  });

  it('promotes a client whose jdeAccount matches cia::claveJDE', () => {
    const original = client('A', { jdeAccounts: [link('00150', '12345')] });
    const res = applyViajesEspecialesGroup([original], [viaje()]);

    expect(res.promotedCount).toBe(1);
    expect(res.unmatchedClaveJdeCount).toBe(0);
    expect(res.clients[0].commercialGroupId).toBe(VIAJES_ESPECIALES_GROUP_ID);
    expect(res.clients[0].commercialGroupName).toBe(VIAJES_ESPECIALES_GROUP_NAME);
    // Does not mutate the original client object — returns a new one.
    expect(res.clients[0]).not.toBe(original);
    expect(original.commercialGroupId).toBeUndefined();
  });

  it('respects manualGroupOverride=true — never touches user-moved clients', () => {
    const manual = client('Manual', {
      jdeAccounts: [link('00150', '12345')],
      manualGroupOverride: true,
      commercialGroupId: 'group-custom',
      commercialGroupName: 'Custom',
    });
    const res = applyViajesEspecialesGroup([manual], [viaje()]);

    expect(res.promotedCount).toBe(0);
    expect(res.clients[0]).toBe(manual);
    expect(res.clients[0].commercialGroupId).toBe('group-custom');
    // El override no se promueve, pero su K_Cliente SÍ existe en el catálogo:
    // no debe contarse como clave huérfana del API.
    expect(res.unmatchedClaveJdeCount).toBe(0);
  });

  it('is a no-op for a client already in the viajes-especiales group', () => {
    const already = client('Ya', {
      jdeAccounts: [link('00150', '12345')],
      commercialGroupId: VIAJES_ESPECIALES_GROUP_ID,
      commercialGroupName: VIAJES_ESPECIALES_GROUP_NAME,
    });
    const res = applyViajesEspecialesGroup([already], [viaje()]);

    expect(res.promotedCount).toBe(0);
    expect(res.clients[0]).toBe(already);
    // The key DID match, so it does not count as unmatched.
    expect(res.unmatchedClaveJdeCount).toBe(0);
  });

  it('counts API claves without any catalog client as unmatched', () => {
    const clients = [
      client('Sin cuentas'), // no jdeAccounts at all
      client('Otra cuenta', { jdeAccounts: [link('00150', '99999')] }),
    ];
    const res = applyViajesEspecialesGroup(clients, [
      viaje({ claveJDE: '12345' }),
      viaje({ kRenta: 2, claveJDE: '77777' }),
    ]);

    expect(res.promotedCount).toBe(0);
    expect(res.unmatchedClaveJdeCount).toBe(2);
    expect(res.clients[0]).toBe(clients[0]);
    expect(res.clients[1]).toBe(clients[1]);
  });

  it('matches after trimming cia and claveJDE whitespace', () => {
    const c = client('Trim', { jdeAccounts: [link('00150', '12345')] });
    const res = applyViajesEspecialesGroup(
      [c],
      [viaje({ cia: ' 00150 ', claveJDE: ' 12345 ' })],
    );
    expect(res.promotedCount).toBe(1);
    expect(res.unmatchedClaveJdeCount).toBe(0);
  });

  it('does NOT match the same clave under a different cia', () => {
    const c = client('Otra cia', { jdeAccounts: [link('00033', '12345')] });
    const res = applyViajesEspecialesGroup([c], [viaje({ cia: '00150' })]);
    expect(res.promotedCount).toBe(0);
    expect(res.unmatchedClaveJdeCount).toBe(1);
  });

  it('registers every matching account of a multi-cia client (dedup of API keys)', () => {
    const multi = client('Multi', {
      jdeAccounts: [link('00150', '12345'), link('00033', '55555')],
    });
    const res = applyViajesEspecialesGroup(
      [multi],
      [viaje({ cia: '00150', claveJDE: '12345' }), viaje({ kRenta: 2, cia: '00033', claveJDE: '55555' })],
    );
    expect(res.promotedCount).toBe(1); // one client promoted once
    expect(res.unmatchedClaveJdeCount).toBe(0); // both API keys matched
  });

  it('deduplicates repeated viajes for the same clave (one API key)', () => {
    const c = client('Repetido', { jdeAccounts: [link('00150', '12345')] });
    const res = applyViajesEspecialesGroup(
      [c],
      [viaje(), viaje({ kRenta: 2 }), viaje({ kRenta: 3 })],
    );
    expect(res.promotedCount).toBe(1);
    expect(res.unmatchedClaveJdeCount).toBe(0);
  });

  it('handles an empty client catalog: every API clave is unmatched', () => {
    const res = applyViajesEspecialesGroup([], [viaje(), viaje({ kRenta: 2, claveJDE: '888' })]);
    expect(res.clients).toEqual([]);
    expect(res.promotedCount).toBe(0);
    expect(res.unmatchedClaveJdeCount).toBe(2);
  });

  it('preserves the rest of the client fields when promoting', () => {
    const c = client('Campos', {
      jdeAccounts: [link('00150', '12345')],
      rfc: 'XAXX010101000',
      notes: 'nota',
      commercialGroupId: 'group-previo',
      commercialGroupName: 'Previo',
    });
    const res = applyViajesEspecialesGroup([c], [viaje()]);
    const out = res.clients[0];
    expect(out.rfc).toBe('XAXX010101000');
    expect(out.notes).toBe('nota');
    expect(out.jdeAccounts).toBe(c.jdeAccounts);
    // Previous (non-manual) group is overwritten — API is authoritative.
    expect(out.commercialGroupId).toBe(VIAJES_ESPECIALES_GROUP_ID);
    expect(out.commercialGroupName).toBe(VIAJES_ESPECIALES_GROUP_NAME);
  });
});
