import { describe, expect, it } from 'vitest';
import {
  attributeMovementId,
  makeAttribution,
  sourceCsvFields,
  sourceOf,
  SOURCE_CATALOG,
  type SourceId,
} from './sourceAttribution';

describe('sourceAttribution — catálogo', () => {
  it('every SourceId has a label and origin', () => {
    (Object.keys(SOURCE_CATALOG) as SourceId[]).forEach(id => {
      expect(SOURCE_CATALOG[id].label.length).toBeGreaterThan(0);
      expect(SOURCE_CATALOG[id].origin.length).toBeGreaterThan(0);
      expect(SOURCE_CATALOG[id].id).toBe(id);
    });
  });
});

describe('makeAttribution', () => {
  it('single source is not crossed and labels from the catalog', () => {
    const a = makeAttribution(['cobranza']);
    expect(a.crossed).toBe(false);
    expect(a.sources).toEqual(['cobranza']);
    expect(a.label).toBe('Cobranza JDE');
    expect(a.detail).toContain('Fuente:');
    expect(a.detail).toContain('Cobranza JDE');
  });

  it('two sources are crossed and joined with ↔', () => {
    const a = makeAttribution(['rol', 'cobranza'], { crossKey: 'folio RI-305405' });
    expect(a.crossed).toBe(true);
    expect(a.label).toBe('ROL CITI ↔ Cobranza JDE');
    expect(a.crossKey).toBe('folio RI-305405');
    expect(a.detail).toContain('Fuentes cruzadas:');
    expect(a.detail).toContain('Cruce: folio RI-305405');
  });

  it('de-duplicates sources preserving order', () => {
    const a = makeAttribution(['bancos', 'bancos', 'cobranza']);
    expect(a.sources).toEqual(['bancos', 'cobranza']);
  });

  it('empty sources fall back to computed (never throws)', () => {
    const a = makeAttribution([]);
    expect(a.sources).toEqual(['computed']);
    expect(a.crossed).toBe(false);
  });

  it('appends an optional note to the detail', () => {
    const a = sourceOf('rol', 'fecha por regla del cliente');
    expect(a.detail).toContain('fecha por regla del cliente');
  });
});

describe('attributeMovementId — prefijos del id', () => {
  const cases: Array<[string, SourceId[], boolean]> = [
    ['bank:00001:123:ref:2026-06-01:0', ['bancos'], false],
    ['internal-recon:00001:2026-06', ['bancos'], false],
    ['cobranza-historic:00001:c1:f1:2026-06', ['cobranza'], false],
    ['auxiliar-historic:glkey', ['auxiliarcontable'], false],
    ['cxc:00001:F-100', ['cobranza'], false],
    ['cxc:especial:00001:F-100', ['cobranza', 'viajes-especiales'], true],
    ['cxc:especial:viaje:00001:K123', ['viajes-especiales'], false],
    ['rol:00001:client-1:2026-07-01', ['rol'], false],
    ['purchase:00001:p1:INV1', ['compras'], false],
    ['po:00001:p1:OC1', ['compras'], false],
    ['cxp:00001:p1:F1:0', ['cxp'], false],
    ['payroll:00001:T1:2026-06:100:0', ['tress-nomina'], false],
    ['citi-prorrateo:00001:client-1:2026-06', ['bancos', 'cobranza'], true],
    ['fideicomiso-dina:base:2026-06', ['fideicomiso-config'], false],
    ['fideicomiso-corning:base:1', ['bancos'], false],
    ['convenio-payment:base:q1', ['convenio'], false],
    ['tax-reserve:base:ob1', ['impuestos'], false],
    ['tax-payment:ob1:p1:0', ['impuestos'], false],
    ['forecast:trend:income:base:2026-06:0', ['computed'], false],
    ['client:00001:c1:2026-06', ['catalog-clients'], false],
  ];

  it.each(cases)('%s → %j (crossed=%s)', (id, sources, crossed) => {
    const a = attributeMovementId(id);
    expect(a.sources).toEqual(sources);
    expect(a.crossed).toBe(crossed);
  });

  it('cxc:especial:viaje: is matched before cxc:especial: and cxc: (longest prefix wins)', () => {
    expect(attributeMovementId('cxc:especial:viaje:x').sources).toEqual(['viajes-especiales']);
    expect(attributeMovementId('cxc:especial:x').sources).toEqual(['cobranza', 'viajes-especiales']);
    expect(attributeMovementId('cxc:x').sources).toEqual(['cobranza']);
  });

  it('unknown id → computed, never throws', () => {
    expect(attributeMovementId('totally-unknown').sources).toEqual(['computed']);
    expect(attributeMovementId('').sources).toEqual(['computed']);
    expect(attributeMovementId(undefined).sources).toEqual(['computed']);
    expect(attributeMovementId(null).sources).toEqual(['computed']);
  });
});

describe('sourceCsvFields', () => {
  it('emits Fuente + Cruce columns', () => {
    const attr = makeAttribution(['rol', 'cobranza'], { crossKey: 'folio RI-1' });
    expect(sourceCsvFields(attr)).toEqual({ Fuente: 'ROL CITI ↔ Cobranza JDE', Cruce: 'folio RI-1' });
  });

  it('Cruce is empty for single-source rows', () => {
    expect(sourceCsvFields(sourceOf('bancos'))).toEqual({ Fuente: 'Bancos', Cruce: '' });
  });
});
