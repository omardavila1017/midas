/**
 * Load providers from the bundled provider catalog (src/assets/providerCatalog.json).
 *
 * Fuentes compiladas en providerCatalog.json:
 *   - Clasificacion/tipo por proveedor — Excel "Clas. Proveodres"
 *   - Catálogo conciliado de proveedores — flexibilityByName (~470 proveedores)
 *   - Catálogo de proveedores críticos TI — dtiCatalog (criticidad + área)
 *   - Historial de último pago — lastPayment (condPago)
 *
 * Convierte cada entrada en un `Provider` listo para la pestaña Catálogos →
 * Proveedores. La idea es que el catálogo aparezca pre-poblado sin que el
 * usuario tenga que cargar archivos, y que cada proveedor traiga su
 * flexibilidad para planeación.
 *
 * Mapping:
 *   - Risk se deriva de la flexibilidad:
 *       inamovible → Alto   (no se puede reprogramar; alto impacto si falla)
 *       revisar    → Medio  (requiere revisión, impacto moderado)
 *       flexible   → Bajo   (se puede renegociar)
 *       unknown    → Medio  (default conservador)
 *   - paymentPeriod se deriva de condPago del `lastPayment` cuando está disponible.
 *   - type viene del Excel de clasificacion; si no existe, se infiere del DTI.
 */

import catalogRaw from '../assets/providerCatalog.json';
import clasificacionRaw from '../data/proveedores-clasificacion.json';
import {
  ClasificacionAlberto,
  Provider,
  ProviderRisk,
  ProviderPaymentPeriod,
  ProviderFlexibility,
} from './types';

type Flexibility = ProviderFlexibility;

interface DtiEntry {
  noProveedor: string;
  area: string;
  criticidad: 'Alta' | 'Media' | 'Baja';
  descripcion: string;
}

interface LastPaymentEntry {
  ultimoMonto: number;
  ultimaFecha: string;
  /** Días de crédito como string — "15", "30", "60", "C" (contado), etc. */
  condPago: string;
}

interface CatalogShape {
  version: string;
  generated: string;
  providerTypeByName?: Record<string, string>;
  providerNoByName?: Record<string, string>;
  classificationByName?: Record<string, string>;
  flexibilityByName: Record<string, Flexibility>;
  flexibilityByClass: Record<string, Flexibility>;
  riskNoteByName?: Record<string, string>;
  creditLimitByName?: Record<string, number>;
  creditDaysByName?: Record<string, string>;
  dtiCatalog: Record<string, DtiEntry>;
  lastPayment: Record<string, LastPaymentEntry>;
}

const catalog = catalogRaw as unknown as CatalogShape;

// ---------------------------------------------------------------------------
// Clasificación Alberto (proveedores-clasificacion.json)
// ---------------------------------------------------------------------------

interface ClasificacionEntry {
  numProveedor: string;
  nombre: string;
  categoria: string;
  clasificacionAlberto: ClasificacionAlberto;
  clasificacionAlbertoRaw: string;
  override: string | null;
  frecuencia: string | null;
  montoPromedioPago: number | null;
  numPagos2025: number | null;
  montoTotal2025: number | null;
  gastoMinimoMensual: number | null;
  score: number | null;
  clasificacionAutomatica: 'CRITICO' | 'ALTO' | 'MEDIO' | 'BAJO' | null;
  scoreCriterios: {
    sustituibilidad: number;
    impactoOperativo: number;
    riesgoLegal: number;
    diasCredito: number;
  } | null;
}

interface ClasificacionShape {
  meta: {
    generadoDesde: string;
    fechaGeneracion: string;
    totalProveedores: number;
    totalConHistoricoPagos: number;
    multiplicadoresFrecuencia: Record<string, number>;
    [k: string]: unknown;
  };
  proveedores: ClasificacionEntry[];
}

const clasificacion = clasificacionRaw as unknown as ClasificacionShape;

/** Normaliza el nombre para hacer match entre catálogo viejo y plantilla nueva. */
function normalizeName(name: string): string {
  return name
    .toUpperCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


/** Derive ProviderRisk from flexibility classification. */
function riskFromFlexibility(flex: Flexibility): ProviderRisk {
  switch (flex) {
    case 'inamovible': return 'Alto';
    case 'revisar':    return 'Medio';
    case 'flexible':   return 'Bajo';
    default:           return 'Medio';
  }
}

function riskCommentFromFlexibility(flex: Flexibility, dti: DtiEntry | undefined): string {
  if (dti?.criticidad === 'Alta') return `Proveedor critico DTI (${dti.area}); interrupcion con impacto operativo alto.`;
  switch (flex) {
    case 'inamovible':
      return 'Clasificado como inamovible: se recomienda pagar en fecha para evitar impacto operativo.';
    case 'revisar':
      return 'Requiere validacion del area responsable antes de modificar condiciones o fecha de pago.';
    case 'flexible':
      return 'Catalogado como negociable: menor riesgo de continuidad ante diferimiento controlado.';
    default:
      return 'Sin evidencia suficiente en catalogo; se asigna riesgo medio de forma conservadora.';
  }
}

function flexibilityCommentFromFlexibility(flex: Flexibility): string {
  switch (flex) {
    case 'inamovible':
      return 'Condiciones poco negociables; priorizar pago segun credito pactado.';
    case 'revisar':
      return 'Negociable solo con autorizacion del area responsable.';
    case 'flexible':
      return 'Puede evaluarse reprogramacion de pagos, plazos o condiciones.';
    default:
      return 'Flexibilidad no clasificada; validar con compras/tesoreria antes de negociar.';
  }
}

function normalizeDateLike(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const iso = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}T00:00:00.000Z`;
  }
  const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const month = Number(slash[1]);
    const day = Number(slash[2]);
    const year = Number(slash[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00.000Z`;
    }
  }
  return undefined;
}

/** Parse `condPago` string ("15", "30", "C", etc.) → ProviderPaymentPeriod. */
function paymentPeriodFromCondPago(condPago: string | undefined): ProviderPaymentPeriod {
  if (!condPago) return '30 días';
  const trimmed = condPago.trim().toUpperCase();
  if (trimmed === 'C' || trimmed === '0' || trimmed === '1' || trimmed === 'CONTADO') {
    return 'Contado';
  }
  const n = parseInt(trimmed, 10);
  if (Number.isFinite(n)) {
    if (n <= 15) return '15 días';
    if (n <= 30) return '30 días';
    if (n <= 45) return '45 días';
    if (n <= 60) return '60 días';
    return '90 días';
  }
  return '30 días';
}

/** Pick a human-readable type from the Romo Excel, DTI area, or default. */
function typeFromCatalog(name: string, dti: DtiEntry | undefined): string {
  const catalogType = catalog.providerTypeByName?.[name];
  if (catalogType?.trim()) return catalogType.trim();
  if (!dti) return 'Otro';
  if (dti.area === 'DTI') return 'Servicios TI';
  return dti.area || 'Otro';
}

/** Slug-friendly id for catalog-sourced providers. */
function idFor(name: string, index: number): string {
  const slug = name
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 32);
  return `catalog-prov-${index}-${slug}`;
}

/**
 * Mapeo Clasificación Alberto → ProviderRisk para mantener compatibilidad
 * con el resto del sistema (cola de pagos, queue priorización, etc.).
 */
function riskFromAlberto(alberto: ClasificacionAlberto | undefined): ProviderRisk {
  switch (alberto) {
    case 'CRITICO':    return 'Alto';
    case 'FLEX_ALTO':  return 'Alto';
    case 'FLEX_MEDIO': return 'Medio';
    case 'FLEX_BAJO':  return 'Bajo';
    case 'PAUSAR':     return 'Bajo';
    default:           return 'Medio';
  }
}

function flexibilityFromAlberto(alberto: ClasificacionAlberto | undefined): Flexibility {
  switch (alberto) {
    case 'CRITICO':    return 'inamovible';
    case 'FLEX_ALTO':  return 'revisar';
    case 'FLEX_MEDIO': return 'revisar';
    case 'FLEX_BAJO':  return 'flexible';
    case 'PAUSAR':     return 'flexible';
    default:           return 'unknown';
  }
}

/** Build Map por nombre normalizado para enriquecer desde el catálogo legacy. */
const legacyByName = new Map<string, string>();
Object.keys(catalog.providerNoByName ?? {}).forEach((name) => {
  legacyByName.set(normalizeName(name), name);
});
['providerTypeByName', 'classificationByName', 'flexibilityByName', 'creditLimitByName', 'creditDaysByName', 'riskNoteByName', 'dtiCatalog', 'lastPayment']
  .forEach((key) => {
    const map = (catalog as unknown as Record<string, Record<string, unknown> | undefined>)[key];
    if (map) Object.keys(map).forEach((name) => {
      const norm = normalizeName(name);
      if (!legacyByName.has(norm)) legacyByName.set(norm, name);
    });
  });

/**
 * Load providers from the Plantilla de Proveedores (proveedores-clasificacion.json).
 * El JSON es la **única fuente de verdad**. Cualquier proveedor del catálogo
 * antiguo que no esté en la plantilla queda fuera. El catálogo legacy se usa
 * únicamente para enriquecer datos (DTI, condPago, comentarios) cuando hay match.
 */
export function loadProvidersCatalog(): Provider[] {
  const providers: Provider[] = [];

  clasificacion.proveedores.forEach((entry, idx) => {
    const name = entry.nombre.trim();
    if (!name) return;

    const norm = normalizeName(name);
    const legacyName = legacyByName.get(norm);
    const dti = legacyName ? catalog.dtiCatalog?.[legacyName] : undefined;
    const last = legacyName ? catalog.lastPayment?.[legacyName] : undefined;
    const creditDays = legacyName
      ? (catalog.creditDaysByName?.[legacyName] ?? last?.condPago)
      : undefined;
    const legacyFlex = legacyName ? catalog.flexibilityByName?.[legacyName] : undefined;
    const legacyRiskNote = legacyName ? catalog.riskNoteByName?.[legacyName]?.trim() : undefined;
    const creditLimit = legacyName ? catalog.creditLimitByName?.[legacyName] : undefined;

    // Risk + flexibility se derivan de Alberto (manda); si no hay clasificación,
    // se cae al legacy.
    const risk = entry.clasificacionAlberto !== 'SIN_CLASIFICAR' && entry.clasificacionAlberto
      ? riskFromAlberto(entry.clasificacionAlberto)
      : riskFromFlexibility(legacyFlex ?? 'unknown');
    const flex = entry.clasificacionAlberto !== 'SIN_CLASIFICAR' && entry.clasificacionAlberto
      ? flexibilityFromAlberto(entry.clasificacionAlberto)
      : (legacyFlex ?? 'unknown');

    providers.push({
      id: legacyName ? idFor(name, idx) : `plantilla-${entry.numProveedor || idx}`,
      name,
      type: entry.categoria?.trim() || typeFromCatalog(legacyName ?? name, dti),
      risk,
      riskComment: legacyRiskNote || riskCommentFromFlexibility(flex, dti),
      paymentPeriod: paymentPeriodFromCondPago(creditDays),
      flexibility: flex,
      flexibilityComment: flexibilityCommentFromFlexibility(flex),
      creditLimit,
      lastUpdatedAt: normalizeDateLike(clasificacion.meta.fechaGeneracion) ?? normalizeDateLike(catalog.generated),
      dtiArea: dti?.area,
      dtiCriticidad: dti?.criticidad,
      clasificacionAlberto: entry.clasificacionAlberto,
      clasificacionAlbertoRaw: entry.clasificacionAlbertoRaw,
      clasificacionAutomatica: entry.clasificacionAutomatica ?? undefined,
      score: entry.score ?? undefined,
      scoreCriterios: entry.scoreCriterios ?? undefined,
      numProveedorJDE: entry.numProveedor,
      frecuenciaHistorica: entry.frecuencia ?? undefined,
      montoPromedioPago: entry.montoPromedioPago ?? undefined,
      numPagos2025: entry.numPagos2025 ?? undefined,
      montoTotal2025: entry.montoTotal2025 ?? undefined,
      gastoMinimoMensual: entry.gastoMinimoMensual ?? undefined,
    });
  });

  // Sort alphabetically so the Catálogos view is predictable.
  providers.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  return providers;
}
