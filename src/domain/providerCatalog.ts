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
  providerNoByName?: Record<string, string>;
  classificationByName?: Record<string, string>;
  flexibilityByName: Record<string, Flexibility>;
  flexibilityByClass: Record<string, Flexibility>;
  creditLimitByName?: Record<string, number>;
  creditDaysByName?: Record<string, string>;
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

/**
 * Provider payment aging derived from `lastPayment.ultimaFecha`:
 *   - 'reciente' : ≤ 60 días desde el último pago
 *   - 'media'    : ≤ 180 días
 *   - 'aneja'    : > 180 días (candidato a revisión de la regla aplicada)
 */
export type Antiguedad = 'reciente' | 'media' | 'aneja';

export interface EnrichmentResult {
  providerType: string | null;
  flexibility: Flexibility;
  criticidad: Criticidad | null;
  dtiArea: string | null;
  lastPayment: LastPaymentEntry | null;
  /** Días desde `lastPayment.ultimaFecha` (null si no hay/parsea mal). */
  lastPaymentAgeDays: number | null;
  /** Bucket de antigüedad del último pago (null si no hay último pago). */
  antiguedad: Antiguedad | null;
  creditLimit: number | null;
  creditDays: string | null;
  providerNo: string | null;
}

/** Parse `ultimaFecha` toleranting ISO (YYYY-MM-DD) and DD/MM/YYYY. */
function parseUltimaFecha(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  // ISO o ISO con tiempo
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s.length > 10 ? s : s + 'T00:00:00');
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // DD/MM/YYYY o DD-MM-YYYY
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (m) {
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const fallback = new Date(s);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function ageBucket(days: number): Antiguedad {
  if (days <= 60) return 'reciente';
  if (days <= 180) return 'media';
  return 'aneja';
}

/** Días entre `ultimaFecha` y `now` (null si no parsea). Exportado para tests. */
export function lastPaymentAgeInDays(
  ultimaFecha: string | null | undefined,
  now: Date = new Date(),
): number | null {
  const d = parseUltimaFecha(ultimaFecha);
  if (!d) return null;
  const ms = now.getTime() - d.getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
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
  const lastPaymentAgeDays = last ? lastPaymentAgeInDays(last.ultimaFecha) : null;
  const antiguedad = lastPaymentAgeDays == null ? null : ageBucket(lastPaymentAgeDays);
  const providerType = name ? catalog.providerTypeByName?.[name] ?? null : null;
  const creditLimit = name ? catalog.creditLimitByName?.[name] ?? null : null;
  const creditDays = name ? catalog.creditDaysByName?.[name] ?? null : null;
  const providerNo = name ? catalog.providerNoByName?.[name] ?? null : null;

  return {
    providerType,
    flexibility: flex,
    criticidad: dti?.criticidad ?? null,
    dtiArea: dti?.area ?? null,
    lastPayment: last,
    lastPaymentAgeDays,
    antiguedad,
    creditLimit,
    creditDays,
    providerNo,
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
      ...Object.keys(catalog.providerNoByName ?? {}),
      ...Object.keys(catalog.creditLimitByName ?? {}),
      ...Object.keys(catalog.creditDaysByName ?? {}),
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
