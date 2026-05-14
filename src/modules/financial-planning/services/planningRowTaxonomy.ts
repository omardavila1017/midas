import type {
  CellOverride,
  FinancialMovement,
  FinancialMovementCategory,
  FinancialMovementType,
  PlanningCustomRow,
  PlanningRow,
} from '../../shared-finance/types';
import { slug } from './customRowsStorage';

export const CATEGORY_LABELS: Record<FinancialMovementCategory, string> = {
  AR_COLLECTION: 'Cobranza',
  AP_PAYMENT: 'Proveedores',
  PAYROLL: 'Nómina',
  TAX: 'Impuestos',
  DEBT: 'Deuda',
  CAPEX: 'CAPEX',
  OPEX: 'OPEX',
  TRANSFER: 'Otros Egresos',
  MANUAL: 'Manual',
};

// Buckets de negocio para INFLOW solicitados por el user: clientes con
// `commercialGroupId === 'group-viajes-especiales'` van a "Viajes Especiales";
// ABONOs Santander sin match de factura van a "Federal"; el resto cae en
// "Otros ingresos". El motor canónico ya escribe estas tres etiquetas en
// `movement.subcategory` para INFLOW — aquí solo las leemos.
const INCOME_BUCKETS = new Set(['Viajes Especiales', 'Federal', 'Otros ingresos']);

function inflowBucketFor(movement: FinancialMovement): string {
  if (movement.type !== 'INFLOW') return '';
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
}

export function buildPlanningRows(args: BuildPlanningRowsArgs): PlanningRow[] {
  const map = new Map<string, PlanningRow>();

  for (const movement of args.movements) {
    const key = conceptKeyForMovement(movement);
    if (map.has(key)) continue;
    const tail = rowLabelForMovement(movement);
    const group = movement.type === 'INFLOW'
      ? `Ingresos · ${inflowBucketFor(movement)}`
      : rowGroup(movement.type, movement.category);
    map.set(key, {
      conceptKey: key,
      label: tail,
      group,
      type: movement.type,
      category: movement.category,
      subgroupLabel: movement.type === 'OUTFLOW' && movement.category === 'AP_PAYMENT'
        ? movement.subcategory ?? 'Sin clasificar'
        : movement.counterpartyName,
      providerCategoryLabel: movement.type === 'OUTFLOW' && movement.category === 'AP_PAYMENT'
        ? movement.providerCategory
        : undefined,
    });
  }

  for (const custom of args.customRows) {
    if (map.has(custom.conceptKey)) continue;
    map.set(custom.conceptKey, {
      conceptKey: custom.conceptKey,
      label: custom.label,
      group: rowGroup(custom.type, custom.category),
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

export function rowGroup(type: FinancialMovementType, category: FinancialMovementCategory): string {
  const sectionLabel = type === 'INFLOW' ? 'Ingresos' : 'Egresos';
  // TRANSFER cae tanto en ingreso (ABONOs sin cobranza match) como en
  // egreso (CARGOs sin pago match). El label `'Otros Egresos'` sólo
  // tiene sentido para egresos; en ingresos lo etiquetamos como
  // `'Otros Ingresos'`.
  const tail = category === 'TRANSFER'
    ? (type === 'INFLOW' ? 'Otros Ingresos' : 'Otros Egresos')
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
