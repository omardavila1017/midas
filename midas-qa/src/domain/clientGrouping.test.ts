import { describe, expect, it } from 'vitest';
import type { Client } from './types';
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
