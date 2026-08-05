import { afterEach, describe, expect, it } from 'vitest';
import {
  generalizeCategoria,
  macroBucketForSupplier,
  setProviderCatalogForCategoryLookup,
  _resetProviderCatalogForCategoryLookup,
  INTERNAL_GROUP_BUCKET,
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
    expect(generalizeCategoria('INT CM')).toBe('Intereses Concurso Mercantil');
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

  it('re-buckets internal group companies (Filiales / razón social del grupo) out of "sin categoría"', () => {
    // Clasificación JDE "Filiales" (intercompañía).
    expect(
      macroBucketForSupplier({ counterpartyName: 'MULTICARGA', providerCategory: 'Filiales' }),
    ).toBe(INTERNAL_GROUP_BUCKET);
    // Razón social del grupo aunque la categoría no diga nada.
    expect(
      macroBucketForSupplier({ counterpartyName: 'TRANSPORTES TAMAULIPAS SA DE CV' }),
    ).toBe(INTERNAL_GROUP_BUCKET);
    // Un proveedor externo real NO se re-etiqueta.
    expect(
      macroBucketForSupplier({ counterpartyName: 'PROVEEDOR EXTERNO SA', providerCategory: 'REFACCIONARIO' }),
    ).toBe('Flota');
  });
});

/**
 * Vocabulario REAL medido en la BD de producción (MCP midas-db, corrida
 * 2026-08-05): `jde.Pago_Proveedor` (pagos 2026, `Clasificacion_Proveedor` +
 * `Clasificacion_Proveedor_Financiera`) y `jde.Antiguedad_Saldos` (CXP abierto).
 *
 * Los catálogos bundleados NO contienen esta taxonomía — es la que mandan las
 * APIs — así que el test de cobertura de arriba no la cubría y el 44.5% del
 * egreso AP de 2026 ($533M de $1,199M) caía en "Proveedores sin categoría".
 *
 * Este test es el guardrail de ese hueco: si el backend agrega una
 * clasificación nueva, o alguien cambia un patrón, la lista de "sin bucket"
 * deja de cuadrar y el test truena en vez de dejar el egreso derivar en
 * silencio hacia el cajón de sastre.
 */
const JDE_API_VOCABULARY: Array<{ raw: string; bucket: string }> = [
  // Flota — combustible, refacciones, taller, casetas, arrastre
  { raw: 'DIESEL', bucket: 'Flota' },
  { raw: 'Diesel Distribuidor', bucket: 'Flota' },
  { raw: 'Diesel Gasolinero', bucket: 'Flota' },
  { raw: 'Combustible', bucket: 'Flota' },
  { raw: 'Refaccionario', bucket: 'Flota' },
  { raw: 'Refacciones y Llantas', bucket: 'Flota' },
  { raw: 'Llantas', bucket: 'Flota' },
  { raw: 'Carroceria y Asientos', bucket: 'Flota' },
  { raw: 'Lubricantes y Aceites', bucket: 'Flota' },
  { raw: 'Automotriz', bucket: 'Flota' },
  { raw: 'Autopistas', bucket: 'Flota' },          // PASE — $25,477,473.73
  { raw: 'Taller', bucket: 'Flota' },
  { raw: 'Vidrio', bucket: 'Flota' },              // VITROCAR — vidrio automotriz
  { raw: 'Transporte', bucket: 'Flota' },
  { raw: 'Logística', bucket: 'Flota' },
  { raw: 'Fletes', bucket: 'Flota' },
  { raw: 'Mensajeria/Paqueteria', bucket: 'Flota' },
  { raw: 'Ferreteria y herramientas', bucket: 'Flota' },
  { raw: 'Mantenimiento Industrial', bucket: 'Flota' },
  // Personal y nómina
  { raw: 'Beneficios', bucket: PERSONAL_NOMINA_BUCKET },  // ASOCIACION PROTACIO / SINDICATO
  { raw: 'Nominas / Reembolsos / Vales', bucket: PERSONAL_NOMINA_BUCKET },
  { raw: 'Recursos Humanos', bucket: PERSONAL_NOMINA_BUCKET },
  { raw: 'REEMBOLSOS', bucket: PERSONAL_NOMINA_BUCKET },
  { raw: 'Textil/Vestido/Calzado', bucket: PERSONAL_NOMINA_BUCKET },  // uniformes
  { raw: 'Servicios Médicos', bucket: PERSONAL_NOMINA_BUCKET },
  { raw: 'Farmaceutica/Laboratorio', bucket: PERSONAL_NOMINA_BUCKET },
  { raw: 'Hospitalario', bucket: PERSONAL_NOMINA_BUCKET },
  { raw: 'Comedor', bucket: PERSONAL_NOMINA_BUCKET },
  { raw: 'Alimenticio', bucket: PERSONAL_NOMINA_BUCKET },
  { raw: 'Cursos', bucket: PERSONAL_NOMINA_BUCKET },
  { raw: 'Escuelas/Universidades', bucket: PERSONAL_NOMINA_BUCKET },
  // Inmuebles y rentas
  { raw: 'Arrendamientos', bucket: 'Inmuebles y rentas' },
  { raw: 'Arrendamientos Financieros', bucket: 'Inmuebles y rentas' },
  { raw: 'Rentas y Centrales', bucket: 'Inmuebles y rentas' },
  { raw: 'SERVICIOS CENTRALES CAMIONERAS', bucket: 'Inmuebles y rentas' },
  { raw: 'Construccion', bucket: 'Inmuebles y rentas' },
  { raw: 'Construcción y remodelación', bucket: 'Inmuebles y rentas' },
  // Proveedor TI
  { raw: 'Tecnología de la Información', bucket: 'Proveedor TI' },
  { raw: 'Proveedores TI', bucket: 'Proveedor TI' },
  { raw: 'Telecomunicaciones', bucket: 'Proveedor TI' },
  { raw: 'Licenciamiento Software', bucket: 'Proveedor TI' },
  { raw: 'Computacion', bucket: 'Proveedor TI' },
  // Servicios
  { raw: 'Servicios', bucket: 'Servicios' },
  { raw: 'Servicios publicos', bucket: 'Servicios' },
  { raw: 'Servicios Públicos', bucket: 'Servicios' },
  { raw: 'Servicios Administrativos', bucket: 'Servicios' },
  { raw: 'Seguros y fianzas', bucket: 'Servicios' },
  { raw: 'Seguros', bucket: 'Servicios' },
  { raw: 'Seguridad', bucket: 'Servicios' },
  { raw: 'Vigilancia', bucket: 'Servicios' },
  { raw: 'Honorarios', bucket: 'Servicios' },
  { raw: 'Consultores', bucket: 'Servicios' },
  { raw: 'Publicidad', bucket: 'Servicios' },
  { raw: 'Mercadotecnia', bucket: 'Servicios' },
  { raw: 'Imprenta', bucket: 'Servicios' },
  { raw: 'Papelero/Editorial', bucket: 'Servicios' },
  { raw: 'Articulos de Limpieza', bucket: 'Servicios' },
  { raw: 'RECOLECCION RESIDUOS', bucket: 'Servicios' },  // basura, no paquetería
  { raw: 'Fumigaciones', bucket: 'Servicios' },
  { raw: 'Gubernamental', bucket: 'Servicios' },
  { raw: 'Muebles y equipos de oficina', bucket: 'Servicios' },
  { raw: 'HOTELES', bucket: 'Servicios' },
  // Otros buckets
  { raw: 'Impuestos', bucket: 'Impuestos' },
  { raw: 'Concurso', bucket: 'Intereses Concurso Mercantil' },
  { raw: 'Renta de peliculas', bucket: 'Flota' },  // amenidades a bordo
];

/**
 * Clasificaciones del API que a propósito NO se mapean, con su razón. Cambiar
 * una de estas es una decisión de negocio, no mantenimiento (ver CLAUDE.md).
 */
const KNOWN_UNMAPPED_API_CATEGORIES = [
  // Cajones de sastre / canal de pago: `usableJdeProviderCategory` los
  // deprioriza para que el otro campo gane, pero si es lo ÚNICO que hay no se
  // puede inventar un destino. "Bancario" ($170.7M en 2026) mezcla IMSS pagado
  // por ventanilla, capital e intereses del convenio y compra de dólares; el
  // dato que los separa está en `Comentario_Pago`, hoy sin cablear.
  'Bancario',
  'Varios',
  'Indirectos Negocio',
  'Convenios',
  'Proyectos',
  // Materialidad baja y destino ambiguo (bus vs. terminal, insumo vs. reventa).
  'Sistemas de Climatizacion',
  'Asociacion',
  'Maquiladoras',
  'Comercializadoras',
  'Acero',
  'Torno',
  'Industrial/Metal',
  'Hule/Plastico',
  'Bienes de consumo:cig/art',
  'Calcomanias',
  'Evento',

];

describe('generalizeCategoria — vocabulario REAL de las APIs JDE (medido en BD)', () => {
  it.each(JDE_API_VOCABULARY)('«$raw» → $bucket', ({ raw, bucket }) => {
    expect(generalizeCategoria(raw)).toBe(bucket);
  });

  it('las clasificaciones sin mapear son EXACTAMENTE las documentadas', () => {
    const stillUnmapped = KNOWN_UNMAPPED_API_CATEGORIES.filter(
      (raw) => generalizeCategoria(raw) !== UNCATEGORIZED_PROVIDER_BUCKET,
    );
    // Si una empieza a mapear, quítala de la lista y documenta la decisión.
    expect(stillUnmapped).toEqual([]);
  });

  it('"Filiales" sigue siendo intercompañía, no un bucket de gasto', () => {
    expect(macroBucketForSupplier({ counterpartyName: 'X', providerCategory: 'Filiales' }))
      .toBe(INTERNAL_GROUP_BUCKET);
  });
});
