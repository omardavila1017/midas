import { describe, expect, it } from 'vitest';
import catalogRaw from '../assets/providerCatalog.json';
import {
  catalogStats,
  enrichFromCatalog,
  flexibilityLabel,
  lastPaymentAgeInDays,
  type Criticidad,
  type DtiEntry,
  type Flexibility,
  type LastPaymentEntry,
} from './providerCatalog';

// The module reads the bundled catalog directly; derive real keys from the
// same JSON so the tests stay valid when the catalog is regenerated.
const catalog = catalogRaw as unknown as {
  flexibilityByName: Record<string, Flexibility>;
  flexibilityByClass: Record<string, Flexibility>;
  dtiCatalog: Record<string, DtiEntry>;
  lastPayment: Record<string, LastPaymentEntry>;
  providerTypeByName?: Record<string, string>;
  providerNoByName?: Record<string, string>;
  creditLimitByName?: Record<string, number>;
  creditDaysByName?: Record<string, string>;
};

describe('lastPaymentAgeInDays', () => {
  const now = new Date(2026, 0, 31); // local 2026-01-31

  it('parses ISO dates', () => {
    expect(lastPaymentAgeInDays('2026-01-01', now)).toBe(30);
  });

  it('parses ISO dates with a time component', () => {
    expect(lastPaymentAgeInDays('2026-01-01T00:00:00', now)).toBe(30);
  });

  it('parses DD/MM/YYYY and DD-MM-YYYY', () => {
    expect(lastPaymentAgeInDays('15/01/2026', now)).toBe(16);
    expect(lastPaymentAgeInDays('15-01-2026', now)).toBe(16);
  });

  it('clamps future dates to 0 (never negative)', () => {
    expect(lastPaymentAgeInDays('2026-02-15', now)).toBe(0);
  });

  it('returns null for empty / null / unparseable input', () => {
    expect(lastPaymentAgeInDays('', now)).toBeNull();
    expect(lastPaymentAgeInDays(null, now)).toBeNull();
    expect(lastPaymentAgeInDays(undefined, now)).toBeNull();
    expect(lastPaymentAgeInDays('no-es-fecha', now)).toBeNull();
  });

  it('same-day payment is 0 days old', () => {
    expect(lastPaymentAgeInDays('2026-01-31', now)).toBe(0);
  });
});

describe('enrichFromCatalog', () => {
  it('returns unknown/nulls for a supplier absent from every catalog', () => {
    const r = enrichFromCatalog({
      supplier: 'PROVEEDOR INEXISTENTE XYZ 123',
      classification: 'CLASIFICACION INEXISTENTE XYZ',
    });
    expect(r).toEqual({
      providerType: null,
      flexibility: 'unknown',
      criticidad: null,
      dtiArea: null,
      lastPayment: null,
      lastPaymentAgeDays: null,
      antiguedad: null,
      creditLimit: null,
      creditDays: null,
      providerNo: null,
    });
  });

  it('handles empty supplier and classification', () => {
    const r = enrichFromCatalog({ supplier: '', classification: '' });
    expect(r.flexibility).toBe('unknown');
    expect(r.providerType).toBeNull();
    expect(r.lastPayment).toBeNull();
  });

  it('resolves flexibility by exact supplier name, tolerating case and extra whitespace', () => {
    const [name, flex] = Object.entries(catalog.flexibilityByName)[0];
    const messy = `  ${name.toLowerCase().replace(/ /g, '   ')}  `;
    const r = enrichFromCatalog({ supplier: messy, classification: '' });
    expect(r.flexibility).toBe(flex);
  });

  it('falls back to classification when the name is not in the flexibility catalog', () => {
    const [clazz, flex] = Object.entries(catalog.flexibilityByClass)[0];
    const r = enrichFromCatalog({
      supplier: 'PROVEEDOR INEXISTENTE XYZ 123',
      classification: clazz.toLowerCase(),
    });
    expect(r.flexibility).toBe(flex);
  });

  it('name match wins over classification', () => {
    const nameEntry = Object.entries(catalog.flexibilityByName).find(
      ([, f]) => f === 'inamovible',
    );
    const classEntry = Object.entries(catalog.flexibilityByClass).find(
      ([, f]) => f === 'flexible',
    );
    expect(nameEntry).toBeDefined();
    expect(classEntry).toBeDefined();
    const r = enrichFromCatalog({
      supplier: nameEntry![0],
      classification: classEntry![0],
    });
    expect(r.flexibility).toBe('inamovible');
  });

  it('attaches DTI criticidad + area when the supplier is in the DTI catalog', () => {
    const [name, entry] = Object.entries(catalog.dtiCatalog)[0];
    const r = enrichFromCatalog({ supplier: name, classification: '' });
    expect(r.criticidad).toBe(entry.criticidad);
    expect(r.dtiArea).toBe(entry.area);
  });

  it('attaches last payment info with an age bucket', () => {
    const [name, entry] = Object.entries(catalog.lastPayment)[0];
    const r = enrichFromCatalog({ supplier: name, classification: '' });
    expect(r.lastPayment).toEqual(entry);
    expect(r.lastPaymentAgeDays).not.toBeNull();
    expect(['reciente', 'media', 'aneja']).toContain(r.antiguedad);
  });

  it('resolves providerType / providerNo when present in the catalog', () => {
    const typeEntries = Object.entries(catalog.providerTypeByName ?? {});
    const noEntries = Object.entries(catalog.providerNoByName ?? {});
    expect(typeEntries.length).toBeGreaterThan(0);
    expect(noEntries.length).toBeGreaterThan(0);

    const [typeName, type] = typeEntries[0];
    expect(enrichFromCatalog({ supplier: typeName, classification: '' }).providerType).toBe(type);

    const [noName, no] = noEntries[0];
    expect(enrichFromCatalog({ supplier: noName, classification: '' }).providerNo).toBe(no);
  });
});

describe('catalogStats', () => {
  it('reports totals consistent with the bundled catalog', () => {
    const stats = catalogStats();
    expect(stats.totalClasses).toBe(Object.keys(catalog.flexibilityByClass).length);
    expect(stats.dtiProviders).toBe(Object.keys(catalog.dtiCatalog).length);
    expect(stats.totalSuppliers).toBeGreaterThanOrEqual(
      Object.keys(catalog.flexibilityByName).length,
    );
  });

  it('byFlexibility counts every classification exactly once', () => {
    const stats = catalogStats();
    const sum =
      stats.byFlexibility.inamovible +
      stats.byFlexibility.flexible +
      stats.byFlexibility.revisar +
      stats.byFlexibility.unknown;
    expect(sum).toBe(stats.totalClasses);
  });

  it('byCriticidad counts every DTI provider exactly once', () => {
    const stats = catalogStats();
    const sum = (['Alta', 'Media', 'Baja'] as Criticidad[]).reduce(
      (acc, c) => acc + stats.byCriticidad[c],
      0,
    );
    expect(sum).toBe(stats.dtiProviders);
  });
});

describe('flexibilityLabel', () => {
  it('maps every flexibility to its Spanish label', () => {
    expect(flexibilityLabel('inamovible')).toBe('Inamovible');
    expect(flexibilityLabel('flexible')).toBe('Flexible');
    expect(flexibilityLabel('revisar')).toBe('Revisar');
    expect(flexibilityLabel('unknown')).toBe('Sin clasificar');
  });
});
