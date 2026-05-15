import type {
  CellOverride,
  FinancialMovement,
  FinancialMovementCategory,
  FinancialMovementType,
  PlanningCustomRow,
  PlanningRow,
} from '../../shared-finance/types';
import { bankAccountBusinessUnitLabel } from '../../../domain/bankAccountsCatalog';
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

const INCOME_BUCKETS = new Set([
  'AC',
  'CITI',
  'Federal',
  'Multicarga',
  'Reserva',
  'Turimex LLC',
  'Viajes Especiales',
  'Otros ingresos',
]);

function inflowBucketFor(movement: FinancialMovement): string {
  if (movement.type !== 'INFLOW') return '';
  if (movement.businessUnitId) {
    return bankAccountBusinessUnitLabel(movement.businessUnitId);
  }
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
    const subgroupLabel = movement.type === 'OUTFLOW' && movement.category === 'AP_PAYMENT'
      ? movement.subcategory ?? 'Sin clasificar'
      : movement.counterpartyName;
    const providerCategoryLabel = movement.type === 'OUTFLOW' && movement.category === 'AP_PAYMENT'
      ? movement.providerCategory
      : undefined;
    map.set(key, {
      conceptKey: key,
      label: tail,
      group,
      bucketLabel: bucketForMovement(movement),
      type: movement.type,
      category: movement.category,
      subgroupLabel,
      providerCategoryLabel,
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

// Mapeo de etiqueta cruda de proveedor (REFACCIONARIO, HONORARIOS LEGAL,
// TECNOLOGIA Y SOPORTE, …) a bucket limpio para agrupación visual en la
// planeación. El orden importa: primero patrones más específicos.
const EXPENSE_BUCKET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /refac/i, label: 'Refacciones' },
  { pattern: /llanta|neumat/i, label: 'Llantas' },
  { pattern: /combust|diesel|gasolin|lubric/i, label: 'Combustibles y lubricantes' },
  { pattern: /legal|jur[íi]dic|abogad|notari/i, label: 'Legal' },
  { pattern: /tecnolog|sistem|soporte|inform[áa]tic|software|hardware|\bti\b|dti|telecom/i, label: 'Tecnología (TI)' },
  { pattern: /mantenim/i, label: 'Mantenimiento' },
  { pattern: /\brh\b|recursos\s*humanos|personal|capacitaci|reclut/i, label: 'Recursos Humanos' },
  { pattern: /renta|arrend/i, label: 'Rentas' },
  { pattern: /seguro\b|p[óo]liza/i, label: 'Seguros' },
  { pattern: /seguridad|vigilanc|guard/i, label: 'Seguridad y vigilancia' },
  { pattern: /honorar/i, label: 'Honorarios' },
  { pattern: /transp|flete|log[íi]stic|paqueter/i, label: 'Transporte y logística' },
  { pattern: /papel|oficin|consumibl/i, label: 'Papelería y oficina' },
  { pattern: /publi|marketing|mercad|imprent|imprenta/i, label: 'Publicidad y marketing' },
  { pattern: /viaje|hospedaje|hotel|vi[áa]tic/i, label: 'Viáticos y viajes' },
  { pattern: /financ|banc|comisi/i, label: 'Servicios financieros' },
  { pattern: /tesorer/i, label: 'Tesorería' },
  { pattern: /administr/i, label: 'Administración' },
  { pattern: /limpie|aseo|sanit/i, label: 'Limpieza' },
  { pattern: /energ|electric|cfe|agua|gas\b/i, label: 'Servicios (luz, agua, gas)' },
  { pattern: /alimento|comed|restaur/i, label: 'Alimentos' },
];

function toTitleCase(value: string): string {
  return value.toLowerCase().replace(/(^|\s|·|-|\/)\p{L}/gu, (c) => c.toUpperCase());
}

function normalizeExpenseBucket(raw: string | undefined | null): string {
  const trimmed = raw?.trim();
  if (!trimmed) return 'Otros proveedores';
  for (const { pattern, label } of EXPENSE_BUCKET_PATTERNS) {
    if (pattern.test(trimmed)) return label;
  }
  return toTitleCase(trimmed);
}

const CATEGORY_BUCKET_LABEL: Record<FinancialMovementCategory, string> = {
  AR_COLLECTION: 'Cobranza',
  AP_PAYMENT: 'Otros proveedores',
  PAYROLL: 'Nómina',
  TAX: 'Impuestos',
  DEBT: 'Deuda',
  CAPEX: 'CAPEX',
  OPEX: 'OPEX',
  TRANSFER: 'Otros movimientos',
  MANUAL: 'Manual',
};

export function bucketForMovement(movement: FinancialMovement): string {
  if (movement.type === 'INFLOW') return inflowBucketFor(movement);
  if (movement.category === 'AP_PAYMENT') {
    return normalizeExpenseBucket(movement.providerCategory ?? movement.subcategory);
  }
  if (movement.category === 'TRANSFER') return 'Otros egresos';
  return CATEGORY_BUCKET_LABEL[movement.category];
}

function bucketForCategory(type: FinancialMovementType, category: FinancialMovementCategory): string {
  if (type === 'INFLOW') return category === 'AR_COLLECTION' ? 'Otros ingresos' : 'Otros ingresos';
  if (category === 'TRANSFER') return 'Otros egresos';
  return CATEGORY_BUCKET_LABEL[category];
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
