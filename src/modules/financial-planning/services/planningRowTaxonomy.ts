import type { Provider } from '../../../domain/types';
import { SCORE_LABELS, scoreBucket, type ScoreBucket } from '../../../domain/providerScore';
import type {
  CellOverride,
  FinancialMovement,
  FinancialMovementCategory,
  FinancialMovementType,
  PlanningCustomRow,
  PlanningRow,
} from '../../shared-finance/types';
import { slug } from './customRowsStorage';
import {
  INTERNAL_GROUP_BUCKET,
  macroBucketForSupplier,
  UNCATEGORIZED_PROVIDER_BUCKET,
} from './providerCategoryGeneralization';

function providerLookupKey(value: string | undefined | null): string {
  if (!value) return '';
  return value
    .toUpperCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveProviderScore(
  movement: FinancialMovement,
  byId: Map<string, Provider>,
  byName: Map<string, Provider>,
): { label: string; bucket: ScoreBucket } | undefined {
  if (movement.type !== 'OUTFLOW' || movement.category !== 'AP_PAYMENT') return undefined;
  const provider =
    (movement.counterpartyId ? byId.get(movement.counterpartyId) : undefined) ??
    byName.get(providerLookupKey(movement.counterpartyName));
  if (!provider) return undefined;
  const bucket = scoreBucket(provider);
  return { label: SCORE_LABELS[bucket], bucket };
}

export const UNIDENTIFIED_BANK_OUTFLOW_BUCKET = 'Egresos bancarios sin identificar';
export const INTERNAL_RECON_BUCKET = 'Traspasos internos (neto)';
/**
 * CARGOs desde las cuentas pagadoras PROPIAS del grupo que el rol de la cuenta
 * promovió a AP_PAYMENT pero que no cruzaron a ningún proveedor: su única
 * identidad es nuestra propia cuenta de banco origen (`counterpartyType` BANK).
 * Tesorería los considera movimientos internos, así que se sacan de
 * "Proveedores sin categoría" hacia este bucket. Siguen contando en el egreso
 * (el banco muestra la salida real de efectivo) para no romper el cuadre
 * Planeación↔banco; si se identifica la cuenta destino del grupo, el detector de
 * traspasos los netea aguas arriba y ya no llegan aquí.
 */
export const INTERNAL_PAGADORA_BUCKET = 'Traspasos internos (cuentas pagadoras)';

export const OUTFLOW_BUCKET_ORDER = [
  'Flota',
  'Proveedor TI',
  'Inmuebles y rentas',
  'Personal y nómina',
  'Servicios',
  'Intereses Concurso Mercantil',
  INTERNAL_GROUP_BUCKET,
  UNCATEGORIZED_PROVIDER_BUCKET,
  'Impuestos',
  'Nómina',
  'Deuda',
  'CAPEX',
  'OPEX',
  UNIDENTIFIED_BANK_OUTFLOW_BUCKET,
  INTERNAL_PAGADORA_BUCKET,
  INTERNAL_RECON_BUCKET,
  'Manual',
];

export const CATEGORY_LABELS: Record<FinancialMovementCategory, string> = {
  AR_COLLECTION: 'Cobranza',
  AP_PAYMENT: 'Proveedores',
  PAYROLL: 'Nómina',
  TAX: 'Impuestos',
  DEBT: 'Deuda',
  CAPEX: 'CAPEX',
  OPEX: 'OPEX',
  TRANSFER: UNIDENTIFIED_BANK_OUTFLOW_BUCKET,
  INTERNAL_RECON: INTERNAL_RECON_BUCKET,
  MANUAL: 'Manual',
};

const INCOME_BUCKETS = new Set([
  'AC',
  'Clientes Citi',
  'Federal',
  'Multicarga',
  'Reserva',
  'Turimex LLC',
  'Viajes Especiales',
  INTERNAL_RECON_BUCKET,
  'Otros ingresos',
]);

function inflowBucketFor(movement: FinancialMovement): string {
  if (movement.type !== 'INFLOW') return '';
  if (movement.category === 'INTERNAL_RECON') return INTERNAL_RECON_BUCKET;
  // El bucket de ingreso lo decide `subcategory` (ya resuelto en el motor
  // canónico: cliente/factura manda para cobranza, cuenta bancaria sólo para
  // ABONOs sin cruce). NO re-derivar desde businessUnitId del banco.
  const sub = movement.subcategory;
  if (sub && INCOME_BUCKETS.has(sub)) return sub;
  return 'Otros ingresos';
}

export function conceptKeyForMovement(movement: FinancialMovement): string {
  const tail = rowLabelForMovement(movement);
  return `${movement.type}:${movement.category}:${slug(tail)}`;
}

export interface BuildPlanningRowsArgs {
  movements: FinancialMovement[];
  customRows: PlanningCustomRow[];
  overrides: CellOverride[];
  /** Catálogo de proveedores. Si se provee, las filas de AP_PAYMENT reciben
   *  `providerScoreLabel` (Operativo/Prioritario/Negociable/Flexible). */
  providers?: Provider[];
}

export function buildPlanningRows(args: BuildPlanningRowsArgs): PlanningRow[] {
  const map = new Map<string, PlanningRow>();
  const providerById = new Map<string, Provider>();
  const providerByName = new Map<string, Provider>();
  for (const provider of args.providers ?? []) {
    if (provider.id) providerById.set(provider.id, provider);
    const key = providerLookupKey(provider.name);
    if (key) providerByName.set(key, provider);
  }

  for (const movement of args.movements) {
    const key = conceptKeyForMovement(movement);
    if (map.has(key)) continue;
    const tail = rowLabelForMovement(movement);
    const group = movement.type === 'INFLOW'
      ? `Ingresos · ${inflowBucketFor(movement)}`
      : rowGroup(movement.type, movement.category);
    const subgroupLabel = movement.type === 'OUTFLOW' && movement.category === 'AP_PAYMENT'
      ? movement.subcategory ?? 'Sin clasificar'
      : movement.counterpartyName;
    const providerCategoryLabel = movement.type === 'OUTFLOW' && movement.category === 'AP_PAYMENT'
      ? movement.providerCategory
      : undefined;
    const score = resolveProviderScore(movement, providerById, providerByName);
    map.set(key, {
      conceptKey: key,
      label: tail,
      group,
      bucketLabel: bucketForMovement(movement),
      type: movement.type,
      category: movement.category,
      subgroupLabel,
      providerCategoryLabel,
      providerScoreLabel: score?.label,
      providerScoreBucket: score?.bucket,
    });
  }

  for (const custom of args.customRows) {
    if (map.has(custom.conceptKey)) continue;
    map.set(custom.conceptKey, {
      conceptKey: custom.conceptKey,
      label: custom.label,
      group: rowGroup(custom.type, custom.category),
      bucketLabel: bucketForCategory(custom.type, custom.category),
      type: custom.type,
      category: custom.category,
      isCustom: true,
    });
  }

  for (const override of args.overrides) {
    if (map.has(override.conceptKey)) continue;
    const inferredCategory = inferCategoryFromConceptKey(override.conceptKey) ?? 'MANUAL';
    map.set(override.conceptKey, {
      conceptKey: override.conceptKey,
      label: humanizeConceptKey(override.conceptKey),
      group: rowGroup(override.type, inferredCategory),
      bucketLabel: bucketForCategory(override.type, inferredCategory),
      type: override.type,
      category: inferredCategory,
      isCustom: override.conceptKey.startsWith('custom:'),
    });
  }

  return Array.from(map.values()).sort((a, b) => {
    if (a.type !== b.type) return a.type === 'INFLOW' ? -1 : 1;
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.label.localeCompare(b.label, 'es-MX');
  });
}

function rowLabelForMovement(movement: FinancialMovement): string {
  if (movement.type === 'OUTFLOW' && movement.category === 'AP_PAYMENT') {
    return movement.counterpartyName ?? movement.subcategory ?? 'Sin proveedor';
  }
  return movement.counterpartyName
    ?? movement.subcategory
    ?? cleanConceptLabel(movement.concept)
    ?? 'General';
}

function cleanConceptLabel(concept: string | undefined): string | null {
  const trimmed = concept?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\s+/g, ' ');
}

const CATEGORY_BUCKET_LABEL: Record<FinancialMovementCategory, string> = {
  AR_COLLECTION: 'Cobranza',
  AP_PAYMENT: UNCATEGORIZED_PROVIDER_BUCKET,
  PAYROLL: 'Nómina',
  TAX: 'Impuestos',
  DEBT: 'Deuda',
  CAPEX: 'CAPEX',
  OPEX: 'OPEX',
  TRANSFER: UNIDENTIFIED_BANK_OUTFLOW_BUCKET,
  INTERNAL_RECON: INTERNAL_RECON_BUCKET,
  MANUAL: 'Manual',
};

export function bucketForMovement(movement: FinancialMovement): string {
  if (movement.type === 'INFLOW') return inflowBucketFor(movement);
  if (movement.category === 'AP_PAYMENT') {
    // CARGO de una cuenta pagadora propia promovido a AP por el rol de la cuenta
    // pero SIN proveedor cruzado: su única identidad es nuestra cuenta de banco
    // origen (counterpartyType BANK). No es una fila de proveedor — tesorería lo
    // trata como movimiento interno, así que sale de "Proveedores sin categoría".
    if (movement.counterpartyType === 'BANK') return INTERNAL_PAGADORA_BUCKET;
    return macroBucketForSupplier({
      counterpartyId: movement.counterpartyId,
      counterpartyName: movement.counterpartyName,
      providerCategory: movement.providerCategory,
      subcategory: movement.subcategory,
    });
  }
  if (movement.category === 'TRANSFER') return UNIDENTIFIED_BANK_OUTFLOW_BUCKET;
  return CATEGORY_BUCKET_LABEL[movement.category];
}

function bucketForCategory(type: FinancialMovementType, category: FinancialMovementCategory): string {
  if (type === 'INFLOW') return category === 'AR_COLLECTION' ? 'Otros ingresos' : 'Otros ingresos';
  if (category === 'TRANSFER') return UNIDENTIFIED_BANK_OUTFLOW_BUCKET;
  return CATEGORY_BUCKET_LABEL[category];
}

export function rowGroup(type: FinancialMovementType, category: FinancialMovementCategory): string {
  const sectionLabel = type === 'INFLOW' ? 'Ingresos' : 'Egresos';
  // TRANSFER cae tanto en ingreso (ABONOs sin cobranza match) como en
  // egreso (CARGOs sin pago match). En egresos usamos un label explícito
  // para distinguirlo de proveedores sin categoría.
  const tail = category === 'TRANSFER'
    ? (type === 'INFLOW' ? 'Otros Ingresos' : UNIDENTIFIED_BANK_OUTFLOW_BUCKET)
    : CATEGORY_LABELS[category];
  return `${sectionLabel} · ${tail}`;
}

export function aggregateRowValueForBucket(args: {
  conceptKey: string;
  movementsInBucket: FinancialMovement[];
}): number {
  return args.movementsInBucket
    .filter((movement) => conceptKeyForMovement(movement) === args.conceptKey)
    .reduce((sum, movement) => sum + Math.max(0, movement.adjustedAmount ?? movement.projectedAmount), 0);
}

function inferCategoryFromConceptKey(conceptKey: string): FinancialMovementCategory | null {
  const parts = conceptKey.split(':');
  // Native concept keys: TYPE:CATEGORY:slug
  // Custom concept keys: custom:TYPE:slug:tail
  if (parts[0] === 'custom') return 'MANUAL';
  const candidate = parts[1];
  return Object.keys(CATEGORY_LABELS).includes(candidate)
    ? (candidate as FinancialMovementCategory)
    : null;
}

function humanizeConceptKey(conceptKey: string): string {
  const parts = conceptKey.split(':');
  const tail = parts[parts.length - 1] ?? 'general';
  return tail.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}
