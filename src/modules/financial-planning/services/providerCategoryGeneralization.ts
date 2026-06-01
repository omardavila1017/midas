/**
 * Cruce de movimientos de egreso contra el catálogo de proveedores DERIVADO
 * (en tiempo real desde antigüedad de saldos / compras / pagoProveedor; ver
 * `src/domain/providerDerivation.ts`) y generalización de la `categoria`
 * cruda a un macro-bucket para la planeación.
 *
 * El catálogo vive en estado de React (App.tsx). Para que módulos puramente
 * funcionales como Planeación puedan resolver `bucketForMovement` sin recibir
 * `providers` por argumento en cada llamada, App.tsx empuja la última lista
 * vía `setProviderCatalogForCategoryLookup(providers)` cada vez que se
 * recalcula. Si nadie llamó el setter (tests, primer render), el lookup cae a
 * "Otros".
 */

import type { Provider } from '../../../domain/types';
import { normalizeJdeKey, normalizeProviderName } from '../../../domain/providerIdentity';

interface CategoryIndex {
  byJde: Map<string, string>;   // normalized JDE key → categoria cruda
  byName: Map<string, string>;  // normalized name → categoria cruda
}

let categoryIndex: CategoryIndex = { byJde: new Map(), byName: new Map() };

/**
 * App.tsx empuja el catálogo derivado aquí. Es deliberado que sea un módulo
 * mutable: el costo de propagar `providers` por cada bucketForMovement era
 * demasiado alto (rederive en cada render del spreadsheet).
 */
export function setProviderCatalogForCategoryLookup(providers: Provider[]): void {
  const byJde = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const p of providers) {
    const categoria = (p.type || '').trim();
    if (!categoria) continue;
    const jdeKey = normalizeJdeKey(p.numProveedorJDE);
    if (jdeKey && !byJde.has(jdeKey)) byJde.set(jdeKey, categoria);
    const nameKey = normalizeProviderName(p.name);
    if (nameKey && !byName.has(nameKey)) byName.set(nameKey, categoria);
  }
  categoryIndex = { byJde, byName };
}

/** Solo para tests. No usar en producción. */
export function _resetProviderCatalogForCategoryLookup(): void {
  categoryIndex = { byJde: new Map(), byName: new Map() };
}

/**
 * Devuelve la `categoria` cruda del catálogo para un movimiento de proveedor,
 * o `undefined` si no hay cruce. `counterpartyId` puede venir como número JDE
 * directo o como id de catálogo (`plantilla-<num>` / `derived-<num>`).
 */
export function lookupProviderCategoria(opts: {
  counterpartyId?: string;
  counterpartyName?: string;
}): string | undefined {
  const id = opts.counterpartyId?.trim();
  if (id) {
    const direct = categoryIndex.byJde.get(id);
    if (direct) return direct;
    const normId = normalizeJdeKey(id);
    if (normId) {
      const byNorm = categoryIndex.byJde.get(normId);
      if (byNorm) return byNorm;
    }
    const embedded = id.match(/(\d{4,})/)?.[1];
    if (embedded) {
      const byEmbedded =
        categoryIndex.byJde.get(embedded) ?? categoryIndex.byJde.get(normalizeJdeKey(embedded));
      if (byEmbedded) return byEmbedded;
    }
  }
  if (opts.counterpartyName) {
    const byName = categoryIndex.byName.get(normalizeProviderName(opts.counterpartyName));
    if (byName) return byName;
  }
  return undefined;
}

/**
 * Generalización: ~85 `categoria` crudas → 7 macro-buckets. Orden importa
 * (primero el patrón más específico). Sin match → proveedor conocido pero
 * pendiente de clasificar.
 *
 * Cubre tanto la taxonomía manual de Alberto ("REFACCIONARIO", "RENTAS") como
 * la taxonomía JDE compras (`descCategoria` / `descFamilia` como "Indirectos",
 * "PRODUCTOS DE LIMPIEZA"), y los textos típicos de `clasificacionProveedor`
 * que vienen de CXP / pagoProveedor ("Nóminas", "Reembolsos").
 */
const MACRO_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bint\.?\s*cm\b|concurso\s*merc/i, label: 'Int. CM' },
  {
    pattern:
      /tecnolog|\bti\b|soporte|telecom|\bgps\b|sistema\s*de\s*archivo|licencias?\s*(bfiskur|bavel)|honorarios?\s*ti\b|celulares|accesorios?\s*eq|impresoras|inform[áa]tic|software|hardware|electr[óo]nica?/i,
    label: 'Proveedor TI',
  },
  {
    pattern:
      /refac|chasis|carrocer|hojalater|pintura|llanta|neumat|combust|diesel|gasolin|lubric|mantenim|lavado\s*unidad|verificac.*unidad|ferreter|chatarra|amenidades?\s*bus|renta\s*(de\s*)?(unidad|traila)|casetas?|peaje|autoconsumo|corral[óo]n|taller\s*atenci[óo]n\s*accident|\bfletes?\b|entrega|recolecci|paqueter|automotriz/i,
    label: 'Flota',
  },
  {
    pattern: /renta\s*(de\s*)?locales?|renta\s*sanitarios?|arrend|estacionamiento|centrales?|\brentas?\b|inmueble/i,
    label: 'Inmuebles y rentas',
  },
  {
    pattern:
      /n[óo]mina|sueldo|pension\s*aliment|sindicato|imss|infonavit|\bisn\b|embargo\s*salario|caja\s*y\s*fondo|reclut|practicant|uniformes?|colegiatura|investigaciones?\s*labor|enfermer[íi]a|atenci[óo]n\s*m[ée]dica|material\s*depto\s*medico|comedor|insumos?\s*aliment|licencias?\s*operadores|funerales|certificac|capacitac|outsourc|lesiones?\s*por\s*accident|indemnizaci[óo]n|reembolso|honorarios?\s*rh\b/i,
    label: 'Personal y nómina',
  },
  {
    pattern:
      /servicios?\s*p[úu]blicos?|servicios?\s*generales?|consultor|recolec|residuos|pipas?\s*de\s*agua|vigilanc|traslado\s*de\s*valores|seguros?\s*y?\s*fianzas?|honorarios?|publicidad|mercadot|imprenta|papeler|membres|fumigac|aseo|limpie|agencia\s*de\s*viaje|entradas?\s*a\s*parques|\bbancos?\b|gubernament|atenci[óo]n\s*a\s*clientes|bolsas?\s*de\s*valores|mobiliar|boleto|donatar|membres[íi]a/i,
    label: 'Servicios',
  },
];

export const UNCATEGORIZED_PROVIDER_BUCKET = 'Proveedores sin categoría';

export function generalizeCategoria(raw: string | undefined | null): string {
  const trimmed = raw?.trim();
  if (!trimmed) return UNCATEGORIZED_PROVIDER_BUCKET;
  for (const { pattern, label } of MACRO_PATTERNS) {
    if (pattern.test(trimmed)) return label;
  }
  return UNCATEGORIZED_PROVIDER_BUCKET;
}

/**
 * Bucket macro para un movimiento de proveedor: cruza con catálogo y
 * generaliza. Sin cruce → proveedor conocido pero pendiente de clasificar.
 */
export function macroBucketForSupplier(opts: {
  counterpartyId?: string;
  counterpartyName?: string;
  providerCategory?: string;
}): string {
  // Regla de negocio: Busbud es proveedor de Federal aunque la categoría JDE
  // diga otra cosa (caso bidireccional cliente+proveedor del mismo grupo).
  if (opts.counterpartyName && /\bbusbud\b/i.test(opts.counterpartyName)) {
    return 'Federal';
  }
  const categoria = opts.providerCategory || lookupProviderCategoria(opts);
  if (!categoria) return UNCATEGORIZED_PROVIDER_BUCKET;
  return generalizeCategoria(categoria);
}
