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
import { isPersonName } from '../../../domain/personNameHeuristic';
import { isInternalCounterparty, isInternalProviderClassification } from '../../../domain/netCashFlowEngine';

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
 * Bucket de personal/nómina. Reutilizado por la regla de rescate de
 * `macroBucketForSupplier` (pagos a personas físicas / cuentas pagadoras de
 * nómina) y como `label` del patrón de nómina abajo, para que ambos coincidan.
 */
export const PERSONAL_NOMINA_BUCKET = 'Personal y nómina';

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
  // Mantenimiento de CENTRALES (edificios/estaciones) antes que Flota: sin
  // esta entrada, `mantenim` (Flota) se comía "MANTENIMIENTO CENTRALES" y
  // "Mtto central" caía sin bucket.
  { pattern: /m(?:antenimiento|tto)\.?\s*(de\s*)?central/i, label: 'Inmuebles y rentas' },
  {
    pattern:
      /tecnolog|\bti\b|soporte|telecom|\bgps\b|sistema\s*de\s*archivo|licencias?\s*(bfiskur|bavel)|honorarios?\s*ti\b|celulares|accesorios?\s*eq|impresoras|inform[áa]tic|software|hardware|electr[óo]nica?|plataforma/i,
    label: 'Proveedor TI',
  },
  {
    pattern:
      /refac|chasis|carrocer|hojalater|pintura|llanta|neumat|combust|diesel|gasolin|lubric|mantenim|lavado\s*unidad|verificac.*unidad|ferreter|ferrer|chatarra|amenidades?\s*bus|renta\s*(de\s*)?(unidad|traila)|casetas?|peaje|autoconsumo|corral[óo]n|taller\s*atenci[óo]n\s*accident|\bfletes?\b|entrega|recolecci|paqueter|automotriz|convenio\s*sendex|gr[uú]as?\b|sellador|traslado\s*de\s*unidades/i,
    label: 'Flota',
  },
  {
    pattern: /renta\s*(de\s*)?locales?|renta\s*sanitarios?|arrend|estacionamiento|centrales?|\brentas?\b|inmueble/i,
    label: 'Inmuebles y rentas',
  },
  {
    pattern:
      /n[óo]mina|sueldo|pensi[oó]n(?:es)?\b|sindicato|imss|infonavit|\bisn\b|embargo\s*salario|caja\s*y\s*fondo|reclut|practicant|uniformes?|colegiatura|investigaciones?\s*labor|enfermer[íi]a|atenci[óo]n\s*m[ée]dica|insumos?\s*m[ée]dic|servicios?\s*m[ée]dic|material\s*depto\s*medico|comedor|insumos?\s*aliment|licencias?\s*operadores|funerales|certificac|capacitac|cursos?\b|outsourc|lesiones?\s*por\s*accident|indemnizaci[óo]n|reembolso|honorarios?\s*rh\b/i,
    label: PERSONAL_NOMINA_BUCKET,
  },
  // Pagos a gobiernos por la vía CXP (predial, tenencias, renovaciones de
  // permisos municipales): bucket Impuestos, igual que los TAX por concepto.
  { pattern: /impuestos?\b|predial|tenencias?\b|renovaci[óo]n/i, label: 'Impuestos' },
  {
    pattern:
      /servicios?\s*p[úu]blicos?|serv\.?\s*p[úu]blic|servicios?\s*generales?|consultor|recolec|residuos|pipas?\s*de\s*agua|suministro\s*(de\s*)?agua|vigilanc|traslado\s*de\s*valores|seguros?\s*y?\s*fianzas?|honorarios?|publicidad|mercadot|imprenta|papeler|membres|fumigac|aseo|limpie|agencia\s*de\s*viaje|hospedaje|entradas?\s*a\s*parques|\bbancos?\b|gubernament|atenci[óo]n\s*a\s*clientes|bolsas?\s*de\s*valores|mobiliar|boleto|donatar|donativ|donacion(?:es)?\b|membres[íi]a|\barchivo\b|insumos?\b|anuncios?\b|panor[aá]mic|peri[oó]dic|pago\s*da[ñn]os|administra|tr[aá]mite/i,
    label: 'Servicios',
  },
];

export const UNCATEGORIZED_PROVIDER_BUCKET = 'Proveedores sin categoría';

/**
 * Bucket para pagos cuya contraparte es una EMPRESA INTERNA del grupo (filial /
 * intercompañía): pagos a una razón social del propio grupo o clasificados
 * "Filiales" en JDE. Económicamente son traspasos intercompañía, no gasto con un
 * tercero. En la proyección (CXP/CXC) se excluyen aguas arriba; aquí sólo se
 * RE-ETIQUETAN los históricos bancarios ya cruzados (no se pueden netear sin
 * romper el cuadre Planeación↔banco) para sacarlos de "Proveedores sin
 * categoría" hacia un bucket interno explícito.
 */
export const INTERNAL_GROUP_BUCKET = 'Empresas del grupo';

/** Quita acentos/diacríticos para que los patrones matcheen categorías crudas
 *  escritas con tilde ("NEUMÁTICOS", "PERIÓDICO") — antes `/neumat/` fallaba
 *  contra "NEUMÁT" y el proveedor caía sin bucket. */
function deaccent(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

export function generalizeCategoria(raw: string | undefined | null): string {
  const trimmed = raw?.trim();
  if (!trimmed) return UNCATEGORIZED_PROVIDER_BUCKET;
  const plain = deaccent(trimmed);
  for (const { pattern, label } of MACRO_PATTERNS) {
    if (pattern.test(trimmed) || pattern.test(plain)) return label;
  }
  return UNCATEGORIZED_PROVIDER_BUCKET;
}

/**
 * Bucket macro para un movimiento de proveedor: cruza con catálogo y
 * generaliza. Sin categoría resoluble, en vez de dejar el pago como una de
 * cientos de filas "Proveedores sin categoría", lo rescatamos hacia "Personal y
 * nómina" cuando hay evidencia de que es un pago a una PERSONA (no a un
 * proveedor formal) — JDE liquida finiquitos, honorarios, reembolsos y demás
 * por la vía de cuentas por pagar. Dos señales:
 *   1. EXACTA: la cuenta de banco pagadora es de nómina (subRole
 *      `proveedores_nomina` / `nomina_operadores`), que llega en `subcategory`
 *      y generaliza a "Personal y nómina".
 *   2. HEURÍSTICA: la contraparte es un nombre de persona física
 *      (`isPersonName`), sin razón social / dígitos.
 * Es re-bucketing de presentación — NO toca monto ni fecha.
 */
export function macroBucketForSupplier(opts: {
  counterpartyId?: string;
  counterpartyName?: string;
  providerCategory?: string;
  /** Subcategoría del movimiento; puede traer el subRole de la cuenta de banco. */
  subcategory?: string;
}): string {
  // Regla de negocio: Busbud es proveedor de Federal aunque la categoría JDE
  // diga otra cosa (caso bidireccional cliente+proveedor del mismo grupo).
  if (opts.counterpartyName && /\bbusbud\b/i.test(opts.counterpartyName)) {
    return 'Federal';
  }
  // Empresa interna del grupo (filial / intercompañía): un pago contra una
  // razón social del grupo (MULTICARGA, TRANSPORTES TAMAULIPAS, …) o clasificado
  // "Filiales" en JDE es un traspaso intercompañía, no gasto con un tercero. Se
  // re-etiqueta a un bucket interno explícito en vez de "Proveedores sin
  // categoría". Sólo presentación — no toca monto/categoría (cuadre intacto).
  if (
    isInternalProviderClassification(opts.providerCategory)
    || isInternalCounterparty(undefined, opts.counterpartyName)
  ) {
    return INTERNAL_GROUP_BUCKET;
  }
  // Dos fuentes de categoría cruda, en orden: la del movimiento (viene del
  // API — clasificacionProveedor de CXP/pagoProveedor) y el catálogo derivado.
  // Si la del movimiento existe pero NO generaliza a un bucket, se intenta la
  // del catálogo antes de rendirse — antes un providerCategory raro bloqueaba
  // el lookup y el proveedor caía "sin categoría" aunque el catálogo sí lo
  // tuviera clasificado.
  let bucket = generalizeCategoria(opts.providerCategory);
  if (bucket === UNCATEGORIZED_PROVIDER_BUCKET) {
    const catalogCategoria = lookupProviderCategoria(opts);
    if (catalogCategoria) bucket = generalizeCategoria(catalogCategoria);
  }
  if (bucket !== UNCATEGORIZED_PROVIDER_BUCKET) return bucket;
  // Rescate de pagos a personas → "Personal y nómina".
  if (opts.subcategory && generalizeCategoria(opts.subcategory) === PERSONAL_NOMINA_BUCKET) {
    return PERSONAL_NOMINA_BUCKET;
  }
  if (isPersonName(opts.counterpartyName)) return PERSONAL_NOMINA_BUCKET;
  return UNCATEGORIZED_PROVIDER_BUCKET;
}
