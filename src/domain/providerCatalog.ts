/**
 * Provider Catalog — flexibility & criticality lookup for CXP payments.
 *
 * Sources (compiled into src/assets/providerCatalog.json):
 *   - Conciliated provider catalog — "resumen clasificado"
 *       Column A categories → map to flexibility
 *         sigue, sigue nomina    → inamovible (must pay on credit time)
 *         pausar, pausa, pausat  → flexible   (payment can be rescheduled)
 *         netear, no critico     → flexible
 *         finanzas, administrar, sistemas, tesoreria, legal, proyecto,
 *         martha, sr sampayo, revisar rh, etc. → revisar (needs area sign-off)
 *   - Critical IT provider catalog — "Prov. Crit. DTI"
 *       Criticidad DTI column: Alta / Media / Baja
 *   - Last-payment history — "bdd"
 *       Último pago realizado + fecha + condición de pago
 */

import catalogRaw from '../assets/providerCatalog.json';

export type Flexibility = 'inamovible' | 'flexible' | 'revisar' | 'unknown';
export type Criticidad = 'Alta' | 'Media' | 'Baja';

export interface DtiEntry {
  noProveedor: string;
  area: string;
  criticidad: Criticidad;
  descripcion: string;
}

export interface LastPaymentEntry {
  ultimoMonto: number;
  ultimaFecha: string;
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

/** Normalize a name the same way the catalog builder did. */
function normName(s: string | null | undefined): string {
  if (!s) return '';
  return s.trim().replace(/\s+/g, ' ').toUpperCase();
}

/** Normalize a classification (clasificacion_proveedor) the same way. */
function normClass(s: string | null | undefined): string {
  if (!s) return '';
  return s.trim().toUpperCase();
}

export interface EnrichmentInput {
  /** Supplier name (record.nombre) */
  supplier: string;
  /** Supplier classification (record.clasificacionProveedor) */
  classification: string;
}

export interface EnrichmentResult {
  providerType: string | null;
  flexibility: Flexibility;
  criticidad: Criticidad | null;
  dtiArea: string | null;
  lastPayment: LastPaymentEntry | null;
}

/**
 * Enrich a CXP record with catalog metadata.
 *
 * Resolution order for flexibility:
 *   1. Exact supplier-name match in flexibilityByName.
 *   2. Classification match in flexibilityByClass.
 *   3. 'unknown'.
 */
export function enrichFromCatalog(input: EnrichmentInput): EnrichmentResult {
  const name = normName(input.supplier);
  const clazz = normClass(input.classification);

  let flex: Flexibility = 'unknown';
  if (name && catalog.flexibilityByName[name]) {
    flex = catalog.flexibilityByName[name];
  } else if (clazz && catalog.flexibilityByClass[clazz]) {
    flex = catalog.flexibilityByClass[clazz];
  }

  const dti = name ? catalog.dtiCatalog[name] ?? null : null;
  const last = name ? catalog.lastPayment[name] ?? null : null;
  const providerType = name ? catalog.providerTypeByName?.[name] ?? null : null;

  return {
    providerType,
    flexibility: flex,
    criticidad: dti?.criticidad ?? null,
    dtiArea: dti?.area ?? null,
    lastPayment: last,
  };
}

/** Summary counts for the whole catalog — useful for diagnostics. */
export function catalogStats(): {
  totalSuppliers: number;
  totalClasses: number;
  dtiProviders: number;
  byFlexibility: Record<Flexibility, number>;
  byCriticidad: Record<Criticidad, number>;
} {
  const byFlex: Record<Flexibility, number> = {
    inamovible: 0,
    flexible: 0,
    revisar: 0,
    unknown: 0,
  };
  Object.values(catalog.flexibilityByClass).forEach((f) => {
    byFlex[f] = (byFlex[f] ?? 0) + 1;
  });

  const byCrit: Record<Criticidad, number> = { Alta: 0, Media: 0, Baja: 0 };
  Object.values(catalog.dtiCatalog).forEach((d) => {
    byCrit[d.criticidad] = (byCrit[d.criticidad] ?? 0) + 1;
  });

  return {
    totalSuppliers: new Set([
      ...Object.keys(catalog.providerTypeByName ?? {}),
      ...Object.keys(catalog.flexibilityByName),
    ]).size,
    totalClasses: Object.keys(catalog.flexibilityByClass).length,
    dtiProviders: Object.keys(catalog.dtiCatalog).length,
    byFlexibility: byFlex,
    byCriticidad: byCrit,
  };
}

/** Human-readable Spanish label for a flexibility value. */
export function flexibilityLabel(f: Flexibility): string {
  switch (f) {
    case 'inamovible':
      return 'Inamovible';
    case 'flexible':
      return 'Flexible';
    case 'revisar':
      return 'Revisar';
    default:
      return 'Sin clasificar';
  }
}
