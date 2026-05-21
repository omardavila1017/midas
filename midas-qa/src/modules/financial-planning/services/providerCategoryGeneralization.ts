/**
 * Cruce de movimientos de egreso contra el catálogo de proveedores
 * (`proveedores-clasificacion.json`) + generalización de la `categoria`
 * cruda (~85 etiquetas) a 7 macro-buckets para la planeación.
 *
 * El catálogo es la fuente de verdad de la categoría. Si un movimiento no
 * hace match (ni por número de proveedor JDE ni por nombre normalizado),
 * cae directo a "Otros" — decisión de negocio: la agrupación depende 100%
 * del catálogo, sin heurística de respaldo.
 */

import clasificacionRaw from '../../../data/proveedores-clasificacion.json';

interface ClasificacionEntry {
  numProveedor: string;
  nombre: string;
  categoria: string;
}

interface ClasificacionShape {
  proveedores: ClasificacionEntry[];
}

const clasificacion = clasificacionRaw as unknown as ClasificacionShape;

/** Mismo normalizador que `loadProvidersCatalog` para que el cruce coincida. */
function normalizeName(name: string): string {
  return name
    .toUpperCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const categoriaByNum = new Map<string, string>();
const categoriaByName = new Map<string, string>();

for (const entry of clasificacion.proveedores) {
  const categoria = entry.categoria?.trim();
  if (!categoria) continue;
  const num = entry.numProveedor?.trim();
  if (num) categoriaByNum.set(num, categoria);
  const norm = normalizeName(entry.nombre ?? '');
  if (norm && !categoriaByName.has(norm)) categoriaByName.set(norm, categoria);
}

/**
 * Devuelve la `categoria` cruda del catálogo para un movimiento de proveedor,
 * o `undefined` si no hay cruce. `counterpartyId` puede venir como número JDE
 * directo (cuando no hubo match de proveedor) o como id de catálogo
 * (`plantilla-<num>`), de ahí que también se intente extraer el número.
 */
export function lookupProviderCategoria(opts: {
  counterpartyId?: string;
  counterpartyName?: string;
}): string | undefined {
  const id = opts.counterpartyId?.trim();
  if (id) {
    const direct = categoriaByNum.get(id);
    if (direct) return direct;
    const embedded = id.match(/(\d{4,})/)?.[1];
    if (embedded) {
      const byEmbedded = categoriaByNum.get(embedded);
      if (byEmbedded) return byEmbedded;
    }
  }
  if (opts.counterpartyName) {
    const byName = categoriaByName.get(normalizeName(opts.counterpartyName));
    if (byName) return byName;
  }
  return undefined;
}

/**
 * Generalización: ~85 `categoria` crudas → 7 macro-buckets. Orden importa
 * (primero el patrón más específico). Sin match → "Otros".
 */
const MACRO_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bint\.?\s*cm\b|concurso\s*merc/i, label: 'Int. CM' },
  {
    pattern:
      /tecnolog|soporte|telecom|\bgps\b|sistema\s*de\s*archivo|licencias?\s*(bfiskur|bavel)|honorarios?\s*ti\b|celulares|accesorios?\s*eq|impresoras|inform[áa]tic|software|hardware/i,
    label: 'Proveedor TI',
  },
  {
    pattern:
      /refac|llanta|neumat|combust|diesel|gasolin|lubric|mantenim|lavado\s*unidad|verificac.*unidad|ferreter|chatarra|amenidades?\s*bus|renta\s*(de\s*)?(unidad|traila)/i,
    label: 'Flota',
  },
  { pattern: /renta\s*(de\s*)?locales?|renta\s*sanitarios?|arrend|estacionamiento/i, label: 'Inmuebles y rentas' },
  {
    pattern:
      /pension\s*aliment|sindicato|imss|\bisn\b|embargo\s*salario|caja\s*y\s*fondo|reclut|practicant|uniformes?|colegiatura|investigaciones?\s*labor|enfermer[íi]a|atenci[óo]n\s*m[ée]dica|material\s*depto\s*medico|comedor|insumos?\s*aliment|licencias?\s*operadores|funerales|certificac|capacitac|outsourc/i,
    label: 'Personal y nómina',
  },
  {
    pattern:
      /servicios?\s*p[úu]blicos?|recolec|residuos|pipas?\s*de\s*agua|vigilanc|traslado\s*de\s*valores|seguros?\s*y?\s*fianzas?|honorarios?|publicidad|mercadot|imprenta|papeler|membres|fumigac|aseo|limpie|agencia\s*de\s*viaje/i,
    label: 'Servicios',
  },
];

export function generalizeCategoria(raw: string | undefined | null): string {
  const trimmed = raw?.trim();
  if (!trimmed) return 'Otros';
  for (const { pattern, label } of MACRO_PATTERNS) {
    if (pattern.test(trimmed)) return label;
  }
  return 'Otros';
}

/**
 * Bucket macro para un movimiento de proveedor: cruza con catálogo y
 * generaliza. Sin cruce → "Otros".
 */
export function macroBucketForSupplier(opts: {
  counterpartyId?: string;
  counterpartyName?: string;
}): string {
  const categoria = lookupProviderCategoria(opts);
  if (!categoria) return 'Otros';
  return generalizeCategoria(categoria);
}
