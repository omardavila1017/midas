/**
 * Gasto mínimo de operación (piso operativo)
 *
 * Suma el gasto mensual estimado de los proveedores marcados como CRÍTICO en
 * la Plantilla de Proveedores (Clas Alberto). Es el "piso" que el negocio
 * tiene que cubrir cada mes para no afectar operación.
 *
 * El cálculo se hace por proveedor:
 *   gastoMinimoMensual = montoPromedioPago × multiplicador(frecuenciaHistorica)
 *
 * Ese cálculo ya viene resuelto en `proveedores-clasificacion.json` y se
 * inyecta a cada Provider en `loadProvidersCatalog`.
 */

import type { Budget } from './budget';
import type { Provider } from './types';

export interface MinimumExpenseProviderEntry {
  providerId: string;
  providerName: string;
  numProveedorJDE?: string;
  categoria: string;
  frecuencia: string | null;
  montoPromedioPago: number | null;
  gastoMinimoMensual: number;
}

export interface MinimumExpenseSummary {
  /** Total mensual (sumatoria de todos los críticos + nómina si aplica). */
  totalMonthly: number;
  /** Total mensual SOLO de proveedores (sin nómina). */
  providersMonthly: number;
  /** Promedio mensual de nómina + finiquitos del presupuesto, si se proporcionó. */
  payrollMonthly: number;
  /** Total anualizado (totalMonthly × 12). */
  totalAnnual: number;
  /** # de proveedores críticos. */
  criticalCount: number;
  /** # de proveedores críticos con dato calculable. */
  criticalWithData: number;
  /** # de proveedores críticos sin histórico (requieren input manual). */
  criticalMissingData: number;
  /** Lista ordenada por monto desc. */
  byProvider: MinimumExpenseProviderEntry[];
  /** Lista de críticos sin histórico (para mostrar al usuario que rellene). */
  criticalsWithoutData: Array<{
    providerId: string;
    providerName: string;
    categoria: string;
  }>;
  /** Por categoría: total mensual agrupado. Incluye fila NÓMINA cuando aplica. */
  byCategory: Array<{ categoria: string; total: number; count: number }>;
}

/**
 * Filtra las filas de nómina/finiquitos del presupuesto deduplicando por concepto.
 * El parser de presupuesto preserva filas con el mismo concepto cuando aparecen
 * dos veces en el CSV (por error de captura, copiar/pegar, etc). Sumar duplicados
 * en el piso operativo infla el total Nx, lo que se vio como un "bug de unidad"
 * cuando la cifra mensual termina cerca del ingreso mensual real.
 */
function payrollRows(budget: Budget): Array<{ concept: string; monthly: number[] }> {
  const seen = new Map<string, { concept: string; monthly: number[] }>();
  for (const row of budget.expenseByConcept) {
    const concept = (row.concept || '').toUpperCase();
    if (!concept.includes('NOMINA') && !concept.includes('NÓMINA') && !concept.includes('FINIQUITO')) continue;
    const key = concept.trim();
    if (seen.has(key)) continue;
    seen.set(key, row);
  }
  return Array.from(seen.values());
}

/**
 * Promedio mensual de nómina + finiquitos del presupuesto. Estos egresos son
 * obligatorios por ley/contrato — son piso operativo igual que los proveedores
 * críticos, pero se manejan aparte porque NO son proveedores (son empleados).
 */
function computePayrollMonthlyFromBudget(budget?: Budget | null): number {
  if (!budget) return 0;
  let total = 0;
  for (const row of payrollRows(budget)) {
    // Promedio mensual del año
    const sum = row.monthly.reduce((s, v) => s + (v || 0), 0);
    total += sum / 12;
  }
  return total;
}

/**
 * Nómina + finiquitos del presupuesto para UN mes específico (0-11).
 * Cuando el budget tiene valores diferentes por mes (típico — abril vs nov),
 * regresar el valor real de ese mes en lugar del promedio.
 */
export function payrollForMonth(budget: Budget | null | undefined, monthIndex: number): number {
  if (!budget) return 0;
  if (monthIndex < 0 || monthIndex > 11) return 0;
  let total = 0;
  for (const row of payrollRows(budget)) {
    total += row.monthly[monthIndex] ?? 0;
  }
  return total;
}

/**
 * Calcula el piso operativo para un mes dado (yearMonth "YYYY-MM").
 * Combina el piso constante de proveedores Operación + nómina/finiquitos
 * específicos de ese mes según el presupuesto.
 */
export function floorForMonth(
  yearMonth: string,
  providersMonthlyFloor: number,
  budget: Budget | null | undefined,
): number {
  if (!yearMonth || yearMonth.length < 7) return providersMonthlyFloor;
  const monthIndex = Number(yearMonth.slice(5, 7)) - 1;
  return providersMonthlyFloor + payrollForMonth(budget, monthIndex);
}

/**
 * Computa el resumen del piso operativo. Si se proporciona un `budget`, también
 * incluye nómina + finiquitos como piso (obligatorio por contrato). El monto
 * de nómina aparece en la sumatoria total y en una fila aparte por categoría
 * pero NO en la lista de proveedores.
 */
export function computeMinimumOperatingExpense(
  providers: Provider[],
  budget?: Budget | null,
  payrollMonthlyOverride?: number,
): MinimumExpenseSummary {
  const criticals = providers.filter((p) => p.clasificacionAutomatica === 'CRITICO');
  const withData: Provider[] = [];
  const withoutData: Provider[] = [];
  for (const p of criticals) {
    if (typeof p.gastoMinimoMensual === 'number' && p.gastoMinimoMensual > 0) {
      withData.push(p);
    } else {
      withoutData.push(p);
    }
  }

  const byProvider: MinimumExpenseProviderEntry[] = withData
    .map((p) => ({
      providerId: p.id,
      providerName: p.name,
      numProveedorJDE: p.numProveedorJDE,
      categoria: p.type || 'Sin categoría',
      frecuencia: p.frecuenciaHistorica ?? null,
      montoPromedioPago: p.montoPromedioPago ?? null,
      gastoMinimoMensual: p.gastoMinimoMensual ?? 0,
    }))
    .sort((a, b) => b.gastoMinimoMensual - a.gastoMinimoMensual);

  const providersMonthly = byProvider.reduce((acc, p) => acc + p.gastoMinimoMensual, 0);
  // Prioridad: TRESS (cash neto real) > presupuesto CSV. TRESS refleja el
  // pago que efectivamente sale del banco; el budget es solo plantilla.
  const payrollMonthly = typeof payrollMonthlyOverride === 'number' && payrollMonthlyOverride > 0
    ? payrollMonthlyOverride
    : computePayrollMonthlyFromBudget(budget);
  const totalMonthly = providersMonthly + payrollMonthly;

  const categoryMap = new Map<string, { total: number; count: number }>();
  byProvider.forEach((p) => {
    const cur = categoryMap.get(p.categoria) ?? { total: 0, count: 0 };
    cur.total += p.gastoMinimoMensual;
    cur.count += 1;
    categoryMap.set(p.categoria, cur);
  });

  const byCategory = Array.from(categoryMap.entries())
    .map(([categoria, v]) => ({ categoria, total: v.total, count: v.count }))
    .sort((a, b) => b.total - a.total);

  // Si hay nómina, agregamos una fila ficticia al inicio para que sea visible
  // en breakdowns. NO se agrega a `byProvider` porque no es un proveedor.
  if (payrollMonthly > 0) {
    byCategory.unshift({ categoria: 'NÓMINA + FINIQUITOS', total: payrollMonthly, count: 1 });
    byCategory.sort((a, b) => b.total - a.total);
  }

  return {
    totalMonthly,
    providersMonthly,
    payrollMonthly,
    totalAnnual: totalMonthly * 12,
    criticalCount: criticals.length,
    criticalWithData: withData.length,
    criticalMissingData: withoutData.length,
    byProvider,
    criticalsWithoutData: withoutData.map((p) => ({
      providerId: p.id,
      providerName: p.name,
      categoria: p.type || 'Sin categoría',
    })),
    byCategory,
  };
}

/**
 * Para una fila de proyección con un rango de fechas, calcula la porción
 * proporcional del piso mensual que aplica.
 *
 * Si el rango cubre 7 días de un mes de 30, devuelve totalMonthly × (7/30).
 * Para rangos que cruzan meses se prorratea por mes y se suma.
 */
export function prorateMinimumExpense(
  totalMonthly: number,
  startDateIso: string,
  endDateIso: string,
): number {
  if (!totalMonthly || totalMonthly <= 0) return 0;
  if (!startDateIso || !endDateIso) return 0;
  const start = new Date(startDateIso);
  const end = new Date(endDateIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  if (end < start) return 0;

  let total = 0;
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const stop = new Date(end.getFullYear(), end.getMonth(), end.getDate());

  while (cur <= stop) {
    const year = cur.getFullYear();
    const month = cur.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    // Día actual aporta totalMonthly / daysInMonth
    total += totalMonthly / daysInMonth;
    cur.setDate(cur.getDate() + 1);
  }

  return total;
}

/**
 * Override manual del piso operativo. Persiste por mes (yearMonth → monto).
 * Cuando un mes tiene override, ese override gana sobre el cálculo automático.
 */
export interface MinimumExpenseOverride {
  yearMonth: string; // "YYYY-MM"
  amount: number;
  note?: string;
  updatedAt: string;
}

const OVERRIDE_STORAGE_KEY = 'flujo-senda::minimum-expense-overrides';

export function loadMinimumExpenseOverrides(): MinimumExpenseOverride[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(OVERRIDE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is MinimumExpenseOverride =>
      entry && typeof entry === 'object'
      && typeof entry.yearMonth === 'string'
      && typeof entry.amount === 'number',
    );
  } catch {
    return [];
  }
}

export function saveMinimumExpenseOverrides(overrides: MinimumExpenseOverride[]): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(OVERRIDE_STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // ignore
  }
}

/** Resuelve el monto efectivo del piso para un mes dado, con override si existe. */
export function resolveMinimumExpenseForMonth(
  yearMonth: string,
  baseMonthly: number,
  overrides: MinimumExpenseOverride[],
): { amount: number; isOverride: boolean; note?: string } {
  const override = overrides.find((o) => o.yearMonth === yearMonth);
  if (override) {
    return { amount: override.amount, isOverride: true, note: override.note };
  }
  return { amount: baseMonthly, isOverride: false };
}
