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
import {
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
  flexibilityByName: Record<string, Flexibility>;
  flexibilityByClass: Record<string, Flexibility>;
  dtiCatalog: Record<string, DtiEntry>;
  lastPayment: Record<string, LastPaymentEntry>;
}

const catalog = catalogRaw as unknown as CatalogShape;

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
 * Load providers from the bundled catalog. Pure + synchronous — returns
 * immediately with the full list derived from providerCatalog.json.
 */
export function loadProvidersCatalog(): Provider[] {
  const names = Array.from(new Set([
    ...Object.keys(catalog.providerTypeByName ?? {}),
    ...Object.keys(catalog.flexibilityByName ?? {}),
  ]));
  const providers: Provider[] = [];

  names.forEach((rawName, idx) => {
    const name = rawName.trim();
    if (!name) return;
    const flex: Flexibility = catalog.flexibilityByName[rawName] ?? 'unknown';
    const dti = catalog.dtiCatalog?.[name] ?? undefined;
    const last = catalog.lastPayment?.[name] ?? undefined;

    providers.push({
      id: idFor(name, idx),
      name,
      type: typeFromCatalog(name, dti),
      risk: riskFromFlexibility(flex),
      riskComment: riskCommentFromFlexibility(flex, dti),
      paymentPeriod: paymentPeriodFromCondPago(last?.condPago),
      flexibility: flex,
      flexibilityComment: flexibilityCommentFromFlexibility(flex),
      creditLimit: undefined,
      lastUpdatedAt: normalizeDateLike(catalog.generated),
      dtiArea: dti?.area,
      dtiCriticidad: dti?.criticidad,
    });
  });

  // Sort alphabetically so the Catálogos view is predictable.
  providers.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  return providers;
}
