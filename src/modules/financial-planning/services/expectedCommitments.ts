import type {
  ManualPlanningCategory,
  ManualPlanningRecurrence,
} from '../../shared-finance/types';

export type ExpectedCommitmentCategory = Extract<ManualPlanningCategory, 'PAYROLL' | 'CAPEX' | 'OPEX' | 'OTHER'>;

export interface ExpectedCommitmentDraft {
  name: string;
  category: ExpectedCommitmentCategory;
  amount: number;
  startDate: string;
  recurrence: ManualPlanningRecurrence;
  companyId?: string;
}

export interface ExpectedCommitmentsPasteResult {
  drafts: ExpectedCommitmentDraft[];
  errors: string[];
}

export const EXPECTED_COMMITMENT_CATEGORY_OPTIONS: Array<{ value: ExpectedCommitmentCategory; label: string }> = [
  { value: 'PAYROLL', label: 'Nómina' },
  { value: 'CAPEX', label: 'CAPEX' },
  { value: 'OPEX', label: 'OPEX' },
  { value: 'OTHER', label: 'Otro' },
];

export const EXPECTED_COMMITMENT_RECURRENCE_OPTIONS: Array<{ value: ManualPlanningRecurrence; label: string }> = [
  { value: 'ONE_TIME', label: 'Una vez' },
  { value: 'WEEKLY', label: 'Semanal' },
  { value: 'BIWEEKLY', label: 'Quincenal' },
  { value: 'MONTHLY', label: 'Mensual' },
  { value: 'QUARTERLY', label: 'Trimestral' },
];

const HEADER_ALIASES = {
  name: ['concepto', 'concept', 'nombre', 'name'],
  category: ['categoria', 'category', 'tipo'],
  amount: ['monto', 'amount', 'importe', 'valor'],
  startDate: ['fecha', 'date', 'fecha inicio', 'inicio', 'startdate', 'start date'],
  recurrence: ['recurrencia', 'recurrence', 'frecuencia', 'periodicidad'],
  companyId: ['compania', 'compañia', 'company', 'cia', 'companyid', 'company id'],
} as const;

export function parseExpectedCommitmentsPaste(text: string): ExpectedCommitmentsPasteResult {
  const rows = text
    .split(/\r?\n/)
    .map((line) => splitCells(line).map((cell) => cell.trim()))
    .filter((cells) => cells.some((cell) => cell.length > 0));

  if (rows.length === 0) return { drafts: [], errors: [] };

  const headerMap = detectHeaderMap(rows[0]);
  const bodyRows = headerMap ? rows.slice(1) : rows;
  const drafts: ExpectedCommitmentDraft[] = [];
  const errors: string[] = [];

  bodyRows.forEach((cells, index) => {
    const rowNumber = index + (headerMap ? 2 : 1);
    const rawName = cellFor(cells, headerMap, 'name', 0);
    const rawCategory = cellFor(cells, headerMap, 'category', 1);
    const rawAmount = cellFor(cells, headerMap, 'amount', 2);
    const rawDate = cellFor(cells, headerMap, 'startDate', 3);
    const rawRecurrence = cellFor(cells, headerMap, 'recurrence', 4);
    const rawCompany = cellFor(cells, headerMap, 'companyId', 5);

    const name = rawName.trim();
    const category = parseCategory(rawCategory);
    const amount = parseMoney(rawAmount);
    const startDate = parseDate(rawDate);
    const recurrence = parseRecurrence(rawRecurrence);

    const rowErrors: string[] = [];
    if (!name) rowErrors.push('concepto');
    if (!category) rowErrors.push('categoría');
    if (!Number.isFinite(amount) || amount <= 0) rowErrors.push('monto');
    if (!startDate) rowErrors.push('fecha');
    if (!recurrence) rowErrors.push('recurrencia');

    if (rowErrors.length > 0 || !category || !startDate || !recurrence) {
      errors.push(`Fila ${rowNumber}: revisa ${rowErrors.join(', ')}.`);
      return;
    }

    drafts.push({
      name,
      category,
      amount,
      startDate,
      recurrence,
      companyId: rawCompany.trim() || undefined,
    });
  });

  return { drafts, errors };
}

export function isExpectedCommitmentCategory(category: ManualPlanningCategory): category is ExpectedCommitmentCategory {
  return category === 'PAYROLL' || category === 'CAPEX' || category === 'OPEX' || category === 'OTHER';
}

function splitCells(line: string): string[] {
  if (line.includes('\t')) return line.split('\t');
  if (line.includes(';')) return line.split(';');
  return line.split(',');
}

function detectHeaderMap(cells: string[]): Map<keyof typeof HEADER_ALIASES, number> | null {
  const normalized = cells.map(normalizeText);
  const map = new Map<keyof typeof HEADER_ALIASES, number>();

  (Object.keys(HEADER_ALIASES) as Array<keyof typeof HEADER_ALIASES>).forEach((key) => {
    const aliases = HEADER_ALIASES[key];
    const index = normalized.findIndex((cell) => (aliases as readonly string[]).includes(cell));
    if (index >= 0) map.set(key, index);
  });

  return map.has('name') && map.has('amount') && map.has('startDate') ? map : null;
}

function cellFor(
  cells: string[],
  headerMap: Map<keyof typeof HEADER_ALIASES, number> | null,
  key: keyof typeof HEADER_ALIASES,
  fallbackIndex: number,
): string {
  const index = headerMap?.get(key) ?? fallbackIndex;
  return cells[index] ?? '';
}

function parseCategory(value: string): ExpectedCommitmentCategory | null {
  const normalized = normalizeText(value);
  if (normalized === 'payroll' || normalized === 'nomina') return 'PAYROLL';
  if (normalized === 'capex') return 'CAPEX';
  if (normalized === 'opex') return 'OPEX';
  if (normalized === 'otro' || normalized === 'other' || normalized === 'manual') return 'OTHER';
  return null;
}

function parseRecurrence(value: string): ManualPlanningRecurrence | null {
  const normalized = normalizeText(value || 'una vez');
  if (normalized === 'one_time' || normalized === 'one time' || normalized === 'una vez' || normalized === 'unica') return 'ONE_TIME';
  if (normalized === 'weekly' || normalized === 'semanal') return 'WEEKLY';
  if (normalized === 'biweekly' || normalized === 'quincenal') return 'BIWEEKLY';
  if (normalized === 'monthly' || normalized === 'mensual') return 'MONTHLY';
  if (normalized === 'quarterly' || normalized === 'trimestral') return 'QUARTERLY';
  return null;
}

function parseDate(value: string): string | null {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const match = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (!match) return null;

  let first = Number(match[1]);
  let second = Number(match[2]);
  const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);

  if (second > 12 && first <= 12) {
    [first, second] = [second, first];
  }

  if (first < 1 || first > 31 || second < 1 || second > 12 || year < 2000) return null;
  const date = new Date(Date.UTC(year, second - 1, first));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== second - 1 || date.getUTCDate() !== first) return null;
  return date.toISOString().slice(0, 10);
}

function parseMoney(value: string): number {
  const cleaned = value.replace(/[^\d,.-]/g, '').trim();
  if (!cleaned) return NaN;

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;

  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSeparator = lastComma > lastDot ? ',' : '.';
    const groupSeparator = decimalSeparator === ',' ? '.' : ',';
    normalized = cleaned.split(groupSeparator).join('').replace(decimalSeparator, '.');
  } else if (lastComma >= 0) {
    normalized = /\d,\d{1,2}$/.test(cleaned) ? cleaned.replace(',', '.') : cleaned.replace(/,/g, '');
  } else if (lastDot >= 0 && /\.\d{3}(\D|$)/.test(cleaned)) {
    normalized = cleaned.replace(/\./g, '');
  }

  return Math.abs(Number(normalized));
}

function normalizeText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}
