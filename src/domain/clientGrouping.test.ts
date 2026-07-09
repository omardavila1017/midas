import { describe, expect, it } from 'vitest';
import type { Client } from './types';
import type { CobranzaRecord } from '../services/jdeTypes';
import { buildClientHierarchy, commercialGroupId, normalizeClientText } from './clientGrouping';

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

function link(cia: string, noCliente: string, nombreCliente: string) {
  return { cia, noCliente, nombreCliente, matchedAt: '2026-01-01', matchedBy: 'user' as const };
}

function cob(partial: Partial<CobranzaRecord>): CobranzaRecord {
  return {
    cia: '00011',
    noCliente: '1',
    nombreCliente: 'X',
    noFactura: 'RI-1',
    fechaFactura: '2026-01-10',
    fechaVence: '',
    fechaCobro: '',
    diasVencida: 0,
    importeBrutoPesos: 1000,
    importePendientePesos: 0,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXP',
    condPago: '',
    estatus: 'COBRADA',
    tipoCambio: 1,
    ...partial,
  } as CobranzaRecord;
}

describe('clientGrouping', () => {
  it('normalizes legal suffixes and accents', () => {
    expect(normalizeClientText('Carrier México, S.A. de C.V.')).toBe('CARRIER MEXICO');
  });

  it('groups related accounts by detected commercial brand', () => {
    const groups = buildClientHierarchy([
      client('APTIV CONTRACT SERVICES NORESTE, S. DE R.L. DE C.V.'),
      client('APTIV CONTRACT SERVICES NUEVO LAREDO S. DE R.L. DE C.V.'),
      client('APTIV CONTRACT SERVICES TAMAULIPAS, S. DE R.L. DE C.V.'),
    ], { today: '2026-04-22' });

    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Aptiv');
    expect(groups[0].accounts).toHaveLength(3);
    expect(groups[0].annualSales).toBe(3_600_000);
  });

  it('uses manual commercial group over auto detection', () => {
    const groups = buildClientHierarchy([
      client('Carrier Planta A', { commercialGroupName: 'Carrier HVAC', commercialGroupId: 'manual-carrier' }),
      client('Carrier Planta B', { commercialGroupName: 'Carrier HVAC', commercialGroupId: 'manual-carrier' }),
    ], { today: '2026-04-22' });

    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe('manual-carrier');
    expect(groups[0].name).toBe('Carrier HVAC');
    expect(groups[0].source).toBe('manual');
    expect(groups[0].confidence).toBe(1);
  });

  it('groups by RFC when fiscal data is available', () => {
    const groups = buildClientHierarchy([
      client('Cuenta Planta Norte', { rfc: 'CAR990101AB1' }),
      client('Cuenta Planta Sur', { rfc: 'CAR990101AB1' }),
    ], { today: '2026-04-22' });

    expect(groups).toHaveLength(1);
    expect(groups[0].source).toBe('rfc');
    expect(groups[0].accounts).toHaveLength(2);
  });

  // B2.4 — jerarquía padre/hijo desde la autoridad JDE (Nombre_Cliente_Padre).
  it('groups accounts under their JDE parent even when their RFCs differ', () => {
    const clients = [
      client('Filial Monterrey', { id: 'a', rfc: 'AAA010101AA1', jdeAccounts: [link('00011', '100', 'Filial Monterrey')] }),
      client('Filial Saltillo', { id: 'b', rfc: 'BBB020202BB2', jdeAccounts: [link('00011', '200', 'Filial Saltillo')] }),
    ];
    const cobranza = [
      cob({ cia: '00011', noCliente: '100', noClientePadre: '55501', nombreClientePadre: 'GRUPO INDUSTRIAL X' }),
      cob({ cia: '00011', noCliente: '200', noClientePadre: '55501', nombreClientePadre: 'GRUPO INDUSTRIAL X' }),
    ];
    const groups = buildClientHierarchy(clients, { today: '2026-04-22', cobranzaRecords: cobranza });
    expect(groups).toHaveLength(1);
    expect(groups[0].source).toBe('jde-padre');
    expect(groups[0].name).toBe('Grupo Industrial X');
    expect(groups[0].accounts).toHaveLength(2);
  });

  it('treats the JDE "Resto Clientes" bucket (49080179) as individual, not a real group', () => {
    const clients = [
      client('Cliente Suelto Uno', { id: 'a', rfc: 'AAA010101AA1', jdeAccounts: [link('00011', '100', 'Cliente Suelto Uno')] }),
      client('Cliente Suelto Dos', { id: 'b', rfc: 'BBB020202BB2', jdeAccounts: [link('00011', '200', 'Cliente Suelto Dos')] }),
    ];
    const cobranza = [
      cob({ cia: '00011', noCliente: '100', noClientePadre: '49080179', nombreClientePadre: 'Resto Clientes' }),
      cob({ cia: '00011', noCliente: '200', noClientePadre: '49080179', nombreClientePadre: 'Resto Clientes' }),
    ];
    const groups = buildClientHierarchy(clients, { today: '2026-04-22', cobranzaRecords: cobranza });
    expect(groups).toHaveLength(2); // no colapsan bajo "Resto Clientes"
    expect(groups.every(g => g.source !== 'jde-padre')).toBe(true);
  });

  it('lets the JDE parent override a manual commercial group name', () => {
    const clients = [
      client('Planta A', { id: 'a', commercialGroupName: 'Manual X', jdeAccounts: [link('00011', '100', 'Planta A')] }),
    ];
    const cobranza = [cob({ cia: '00011', noCliente: '100', noClientePadre: '77701', nombreClientePadre: 'GRUPO JDE Y' })];
    const groups = buildClientHierarchy(clients, { today: '2026-04-22', cobranzaRecords: cobranza });
    expect(groups).toHaveLength(1);
    expect(groups[0].source).toBe('jde-padre');
    expect(groups[0].name).toBe('Grupo Jde Y');
  });

  it('can separate an account by assigning a unique manual group', () => {
    const separated = client('Carrier Planta B', {
      commercialGroupName: 'Carrier Planta B',
      commercialGroupId: commercialGroupId('Carrier Planta B'),
    });
    const groups = buildClientHierarchy([
      client('Carrier Planta A'),
      separated,
    ], { today: '2026-04-22' });

    expect(groups.map(group => group.name).sort()).toEqual(['Carrier', 'Carrier Planta B']);
  });
});
