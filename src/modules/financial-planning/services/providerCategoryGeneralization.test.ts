import { afterEach, describe, expect, it } from 'vitest';
import {
  generalizeCategoria,
  macroBucketForSupplier,
  setProviderCatalogForCategoryLookup,
  _resetProviderCatalogForCategoryLookup,
  UNCATEGORIZED_PROVIDER_BUCKET,
  PERSONAL_NOMINA_BUCKET,
} from './providerCategoryGeneralization';
import type { Provider } from '../../../domain/types';
import providerCatalog from '../../../assets/providerCatalog.json';
import proveedoresClasificacion from '../../../data/proveedores-clasificacion.json';

afterEach(() => {
  _resetProviderCatalogForCategoryLookup();
});

describe('generalizeCategoria — cobertura del vocabulario real', () => {
  it('every raw category in the bundled catalogs generalizes to a bucket (none fall through)', () => {
    // Invariante de negocio: ningún proveedor CON categoría conocida debe
    // aparecer como "Proveedores sin categoría" en Planeación. Si este test
    // falla tras actualizar un catálogo, hay una categoría nueva sin mapear —
    // agregar su patrón a MACRO_PATTERNS (ver providerCategoryGeneralization).
    const raws = new Set<string>();
    for (const t of Object.values(
      (providerCatalog as { providerTypeByName: Record<string, string> }).providerTypeByName,
    )) {
      if (t.trim()) raws.add(t.trim());
    }
    for (const p of (proveedoresClasificacion as { proveedores: Array<{ categoria?: string | null }> }).proveedores) {
      const c = (p.categoria ?? '').trim();
      if (c) raws.add(c);
    }
    expect(raws.size).toBeGreaterThan(100);
    const unmapped = [...raws].filter(
      (raw) => generalizeCategoria(raw) === UNCATEGORIZED_PROVIDER_BUCKET,
    );
    expect(unmapped).toEqual([]);
  });

  it('maps the previously-uncovered categories to their data-verified buckets', () => {
    // Buckets decididos viendo los proveedores reales de cada categoría:
    // PLATAFORMA = SaaS (Fracttal/LinkedIn/OPIS); CONVENIO SENDEX =
    // transportistas aliados (FedEx, Autolíneas VIFE); Pensión = personas
    // físicas (pensión alimenticia); IMPUESTOS/predial/RENOVACIÓN = gobiernos.
    expect(generalizeCategoria('PLATAFORMA')).toBe('Proveedor TI');
    expect(generalizeCategoria('CONVENIO SENDEX')).toBe('Flota');
    expect(generalizeCategoria('Pensión')).toBe(PERSONAL_NOMINA_BUCKET);
    expect(generalizeCategoria('Pensiones')).toBe(PERSONAL_NOMINA_BUCKET);
    expect(generalizeCategoria('GRUAS')).toBe('Flota');
    expect(generalizeCategoria('IMPUESTOS')).toBe('Impuestos');
    expect(generalizeCategoria('predial')).toBe('Impuestos');
    expect(generalizeCategoria('INSUMOS MÉDICOS')).toBe(PERSONAL_NOMINA_BUCKET);
    expect(generalizeCategoria('INSUMOS EMPAQUE')).toBe('Servicios');
    expect(generalizeCategoria('Mtto central')).toBe('Inmuebles y rentas');
    expect(generalizeCategoria('MANTENIMIENTO CENTRALES')).toBe('Inmuebles y rentas');
    expect(generalizeCategoria('Hospedaje')).toBe('Servicios');
    expect(generalizeCategoria('DONATIVOS')).toBe('Servicios');
  });

  it('matches accented raw categories (deaccent normalization)', () => {
    // Antes /neumat/ NO matcheaba "NEUMÁTICOS" por la tilde y el proveedor
    // caía sin bucket.
    expect(generalizeCategoria('NEUMÁTICOS')).toBe('Flota');
    expect(generalizeCategoria('PERIÓDICO')).toBe('Servicios');
  });

  it('keeps the existing taxonomy stable (no re-bucketing of covered categories)', () => {
    expect(generalizeCategoria('REFACCIONARIO')).toBe('Flota');
    expect(generalizeCategoria('RENTAS')).toBe('Inmuebles y rentas');
    expect(generalizeCategoria('TECNOLOGIA Y SOPORTE')).toBe('Proveedor TI');
    expect(generalizeCategoria('INT CM')).toBe('Int. CM');
    expect(generalizeCategoria('Nóminas')).toBe(PERSONAL_NOMINA_BUCKET);
    expect(generalizeCategoria('SEGUROS Y FIANZAS')).toBe('Servicios');
    expect(generalizeCategoria('INSUMOS ALIMENTICIOS')).toBe(PERSONAL_NOMINA_BUCKET);
    expect(generalizeCategoria('PASES IMSS')).toBe(PERSONAL_NOMINA_BUCKET);
  });
});

describe('macroBucketForSupplier — fallback al catálogo', () => {
  function provider(patch: Partial<Provider>): Provider {
    return {
      id: 'derived-4076192',
      name: 'VISION CONSERVACION Y MANTENIMIENTO S DE',
      type: 'SERV ASEO Y LIMPIEZA',
      numProveedorJDE: '4076192',
    } as unknown as Provider;
  }

  it('falls back to the catalog categoria when the movement providerCategory does not generalize', () => {
    setProviderCatalogForCategoryLookup([provider({})]);
    const bucket = macroBucketForSupplier({
      counterpartyId: '4076192',
      counterpartyName: 'VISION CONSERVACION Y MANTENIMIENTO S DE',
      // Categoría rara del API que NO generaliza — antes bloqueaba el lookup.
      providerCategory: 'ZZZ-DESCONOCIDA',
    });
    expect(bucket).toBe('Servicios');
  });

  it('still resolves via movement providerCategory when it generalizes', () => {
    const bucket = macroBucketForSupplier({
      counterpartyName: 'PROVEEDOR X',
      providerCategory: 'REFACCIONARIO',
    });
    expect(bucket).toBe('Flota');
  });
});
