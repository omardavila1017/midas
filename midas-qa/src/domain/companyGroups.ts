/**
 * Company Groups — allows users to create named groups of companies
 * and filter all data views by group.
 *
 * Examples:
 *   "Grupo Norte" → ['00011', '00060']  (Transportes del Norte + Tamaulipecos)
 *   "Grupo Citi"  → ['00038']           (Senda Citi)
 *   "Todas"       → all companies (built-in, not editable)
 *
 * Persisted in localStorage under key 'midas.companyGroups'.
 */

export interface CompanyGroup {
  id: string;
  name: string;
  /** Company codes (cia) included in this group */
  cias: string[];
  /** Color for visual identification */
  color?: string;
  /** Is this a system-generated group? If true, user can't delete it. */
  isSystem?: boolean;
  createdAt: string;
}

const STORAGE_KEY = 'midas.companyGroups';
const LEGACY_STORAGE_KEY = 'flowsense.companyGroups';

/**
 * Load company groups from localStorage.
 */
export function loadCompanyGroups(): CompanyGroup[] {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw) {
        try {
          localStorage.setItem(STORAGE_KEY, raw);
          localStorage.removeItem(LEGACY_STORAGE_KEY);
        } catch { /* ignore */ }
      }
    }
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Save company groups to localStorage.
 */
export function saveCompanyGroups(groups: CompanyGroup[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
  } catch {
    // Ignore quota errors
  }
}

/**
 * Generate a unique ID for a new group.
 */
export function newGroupId(): string {
  return `grp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Given a selection mode (group ID, 'all', or a single cia code),
 * resolve the list of company codes that should be active.
 */
export function resolveActiveCias(
  selection: string,
  groups: CompanyGroup[],
  allCias: string[],
): string[] {
  if (selection === 'all') return allCias;

  // Check if it's a group ID
  const group = groups.find(g => g.id === selection);
  if (group) return group.cias;

  // Otherwise it's a single cia code
  return [selection];
}

/**
 * Check if a cia is included in the current selection.
 */
export function isCiaActive(
  cia: string,
  selection: string,
  groups: CompanyGroup[],
  allCias: string[],
): boolean {
  const active = resolveActiveCias(selection, groups, allCias);
  return active.includes(cia);
}

/**
 * Default group colors (for UI badges).
 */
export const GROUP_COLORS = [
  'var(--primary)', // primary blue
  'var(--success)', // green
  'var(--warning)', // amber
  'var(--chart-4)', // purple
  'var(--danger)', // red
  'var(--info)', // sky
  'var(--chart-5)', // pink
  'var(--chart-3)', // teal
] as const;
