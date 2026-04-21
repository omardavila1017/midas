/**
 * Load providers from the bundled provider catalog (src/assets/providerCatalog.json).
 *
 * Fuentes compiladas en providerCatalog.json:
 *   - Proveedores_2026_conciliado.xlsx — flexibilityByName (~470 proveedores)
 *   - Proveedores Criticos TI 2026.xlsx — dtiCatalog (criticidad + área)
 *   - Proveedores_2026_conciliado.xlsx sheet "bdd" — lastPayment (condPago)
 *
 * Convierte cada entrada en un `Provider` listo para la pestaña Catálogos →
 * Proveedores. La idea es que el catálogo aparezca pre-poblado sin que el
 * usuario tenga que subir un Excel, y que cada proveedor traiga su
 * flexibilidad para planeación.
 *
 * Mapping:
 *   - Risk se deriva de la flexibilidad:
 *       inamovible → Alto   (no se puede reprogramar; alto impacto si falla)
 *       revisar    → Medio  (requiere revisión, impacto moderado)
 *       flexible   → Bajo   (se puede renegociar)
 *       unknown    → Medio  (default conservador)
 *   - paymentPeriod se deriva de condPago del `lastPayment` cuando está disponible.
 *   - type se infiere del `dtiArea` o usa 'Otro' por default.
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

/** Pick a human-readable type from DTI area or default. */
function typeFromDti(dti: DtiEntry | undefined): string {
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
  const names = Object.keys(catalog.flexibilityByName ?? {});
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
      type: typeFromDti(dti),
      risk: riskFromFlexibility(flex),
      paymentPeriod: paymentPeriodFromCondPago(last?.condPago),
      flexibility: flex,
      dtiArea: dti?.area,
      dtiCriticidad: dti?.criticidad,
    });
  });

  // Sort alphabetically so the Catálogos view is predictable.
  providers.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  return providers;
}
