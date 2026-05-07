import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { ClasificacionAlberto, Provider } from '../../../domain/types';
import { CLASIFICACION_LABELS } from '../../../domain/types';
import type { FinancialMovement, FinancialMovementCategory } from '../../shared-finance/types';

/**
 * Builds OUTFLOW movements from open JDE CXP invoices. Supplier payments stay
 * invoice-dated so the scheduler can prioritize by score and actual CXP dates.
 * Excludes Pausa and Sin clasificar — only compromisos firmes appear.
 */
export interface BuildCxpOutflowsInput {
  cxpRecords: CXPRecord[];
  providers: Provider[];
  companyCode: string;
  asOfDate: string;
  endDate: string;
}

function normalize(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase();
}

function normalizeJde(value: string | undefined | null): string {
  const digits = (value ?? '').replace(/\D+/g, '');
  if (!digits) return '';
  return String(Number(digits));
}

function cleanDate(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined;
}

function effectiveCxpDate(record: CXPRecord, asOfDate: string): { date: string; originalDate: string; moved: boolean } {
  const originalDate = cleanDate(record.fechaProgramacionPago)
    ?? cleanDate(record.fechaVence)
    ?? cleanDate(record.fechaFactura)
    ?? asOfDate;
  return originalDate < asOfDate
    ? { date: asOfDate, originalDate, moved: true }
    : { date: originalDate, originalDate, moved: false };
}

// Categorías visibles en el grid de planeación. Se excluyen Pausa y
// Sin clasificar a propósito: no son compromisos firmes.
const VISIBLE_CLASIF: ClasificacionAlberto[] = ['CRITICO', 'FLEX_ALTO', 'FLEX_MEDIO', 'FLEX_BAJO'];

export function buildCxpOutflowMovements(input: BuildCxpOutflowsInput): FinancialMovement[] {
  const { cxpRecords, providers, companyCode, asOfDate, endDate } = input;

  const providerByJde = new Map<string, Provider>();
  const providerByName = new Map<string, Provider>();
  for (const p of providers) {
    const jdeKey = normalizeJde(p.numProveedorJDE);
    if (jdeKey) providerByJde.set(jdeKey, p);
    providerByName.set(normalize(p.name), p);
  }

  const filtered = !companyCode || companyCode === 'all'
    ? cxpRecords
    : cxpRecords.filter((r) => r.cia === companyCode);

  const movements: FinancialMovement[] = [];
  const createdAt = `${asOfDate}T00:00:00.000Z`;

  filtered.forEach((record, index) => {
    const amount = Number(record.importePendientePesos) || 0;
    if (amount <= 0) return;
    const provider = (record.noProveedor ? providerByJde.get(normalizeJde(record.noProveedor)) : undefined)
      ?? providerByName.get(normalize(record.nombre));
    const clasif: ClasificacionAlberto = provider?.clasificacionAlberto
      ?? (record.clasificacionProveedor as ClasificacionAlberto | undefined)
      ?? 'SIN_CLASIFICAR';
    if (!VISIBLE_CLASIF.includes(clasif)) return;
    const dateInfo = effectiveCxpDate(record, asOfDate);
    if (dateInfo.date > endDate) return;
    const providerName = provider?.name ?? record.nombre ?? 'Proveedor sin nombre';
    const providerId = provider?.id ?? record.noProveedor;
    const providerType = provider?.type?.trim() || record.clasifica || 'Sin categoría';
    const categoryLabel = CLASIFICACION_LABELS[clasif];
    const score = provider?.score != null && Number.isFinite(provider.score)
      ? Math.max(0, Math.min(100, Math.round(provider.score)))
      : clasif === 'CRITICO'
        ? 92
        : clasif === 'FLEX_ALTO'
          ? 85
          : clasif === 'FLEX_MEDIO'
            ? 75
            : 65;

    movements.push({
      id: `cxp-invoice:${record.cia}:${record.noProveedor || providerId || 'sin-proveedor'}:${record.noFactura || index}:${index}`,
      sourceSystem: 'JDE',
      sourceObjectId: record.noFactura || undefined,
      companyId: record.cia,
      type: 'OUTFLOW',
      category: 'AP_PAYMENT',
      subcategory: clasif,
      providerCategory: providerType,
      counterpartyId: providerId,
      counterpartyName: providerName,
      counterpartyType: 'SUPPLIER',
      concept: `Factura ${record.noFactura || 'sin folio'} · ${categoryLabel} · ${providerType}`,
      currency: 'MXN',
      originalAmount: amount,
      baseAmount: amount,
      projectedAmount: amount,
      issueDate: cleanDate(record.fechaFactura),
      dueDate: cleanDate(record.fechaVence),
      projectedDate: dateInfo.date,
      confidenceScore: score,
      confidenceBand: clasif === 'CRITICO' || score >= 80 ? 'HIGH' : 'MEDIUM',
      forecastMethod: 'RULE',
      ruleApplied: `CXP JDE · ${categoryLabel} · score ${score}`,
      taxTreatment: Number(record.importeImpuestosPesos) > 0 ? 'IVA_CREDITABLE' : 'UNCLASSIFIED',
      taxRate: Number(record.importeImpuestosPesos) > 0 ? 16 : undefined,
      status: 'PROJECTED_BASE',
      lockState: clasif === 'CRITICO' ? 'LOCKED' : 'RESTRICTED',
      comments: [
        dateInfo.moved
          ? `Fecha CXP original ${dateInfo.originalDate}; se trae a ${dateInfo.date} por estar vencida.`
          : `Fecha CXP ${dateInfo.date}.`,
      ],
      createdAt,
      updatedAt: createdAt,
    });
  });

  return movements.sort((a, b) => {
    const clasifDelta = VISIBLE_CLASIF.indexOf(a.subcategory as ClasificacionAlberto)
      - VISIBLE_CLASIF.indexOf(b.subcategory as ClasificacionAlberto);
    if (clasifDelta !== 0) return clasifDelta;
    if (b.confidenceScore !== a.confidenceScore) return b.confidenceScore - a.confidenceScore;
    if (a.projectedDate !== b.projectedDate) return a.projectedDate.localeCompare(b.projectedDate);
    return (a.counterpartyName ?? '').localeCompare(b.counterpartyName ?? '', 'es-MX');
  });
}

/**
 * Maps a budget concept label (Romo's CSV) to a financial category.
 * TAX is handled by the dedicated tax module — we skip it here so we
 * don't double-count.
 */
function categoryForBudgetConcept(concept: string, includeTaxes: boolean): FinancialMovementCategory | null {
  const upper = concept.toUpperCase();
  // Balancing / reserve rows aren't real outflows.
  if (upper.includes('AJUSTE') || upper.includes('RESERVA')) return null;
  if (upper.includes('IMPUESTO') || upper.includes('ISR') || upper.includes('IVA') || upper.includes('IMSS')) {
    return includeTaxes ? 'TAX' : null;
  }
  if (upper.includes('NOMINA') || upper.includes('NÓMINA') || upper.includes('SUELDOS') || upper.includes('FINIQUITO')) return 'PAYROLL';
  if (upper.includes('DEUDA') || upper.includes('PRESTAMO') || upper.includes('PRÉSTAMO') || upper.includes('CREDITO') || upper.includes('PASIVO')) return 'DEBT';
  if (upper.includes('CAPEX') || upper.includes('INVERSION') || upper.includes('INVERSIÓN')) return 'CAPEX';
  return 'OPEX';
}

function typicalDayForConcept(concept: string, idx: number): number {
  const upper = concept.toUpperCase();
  if (upper.includes('NOMINA') || upper.includes('NÓMINA') || upper.includes('SUELDOS')) return 15;
  if (upper.includes('FINIQUITO')) return 30;
  if (upper.includes('PASIVO') || upper.includes('PRESTAMO') || upper.includes('PRÉSTAMO') || upper.includes('DEUDA') || upper.includes('CREDITO')) return 10;
  if (upper.includes('ARRENDAMIENTO') || upper.includes('RENTA')) return 5;
  if (upper.includes('CAPEX')) return 20;
  return 5 + (idx % 10);
}

function dateForDayOfMonth(yearMonth: string, day: number): string {
  const [y, m] = yearMonth.split('-').map((v) => Number(v));
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const safeDay = Math.min(Math.max(day, 1), lastDay);
  return `${yearMonth}-${String(safeDay).padStart(2, '0')}`;
}

export interface BuildBudgetOutflowsInput {
  budget: Budget | null;
  asOfDate: string;
  startDate: string;
  endDate: string;
  /** When true, emits movements for past months too (used by Base scenario). */
  includePast?: boolean;
  /** When true, emits TAX-category lines too (Base scenario mirrors CSV). */
  includeTaxes?: boolean;
}

/**
 * Emits one OUTFLOW movement per (concept × month) from the budget,
 * scoped to non-AP categories: Nómina, CAPEX, Pasivos Financieros / Préstamos,
 * Arrendamientos y demás Gastos de Operación. Excluye Impuestos (los maneja
 * el módulo de Taxes) y AP_PAYMENT (lo cubre CXP).
 */
export function buildBudgetOutflowMovements(input: BuildBudgetOutflowsInput): FinancialMovement[] {
  const { budget, asOfDate, startDate, endDate, includePast = false, includeTaxes = false } = input;
  if (!budget) return [];

  const movements: FinancialMovement[] = [];
  const createdAt = `${asOfDate}T00:00:00.000Z`;
  const startMonth = startDate.slice(0, 7);
  const endMonth = endDate.slice(0, 7);
  const asOfMonth = asOfDate.slice(0, 7);

  // Scaling only applies to the Base scenario, where we want every emitted
  // concept to roll up to Romo's `expenseTotal` exactly. For Aprobado/draft
  // scenarios the tax module + CXP cover separate categories, so scaling
  // would double-count.
  const scaleByMonth: number[] = new Array(12).fill(1);
  if (includeTaxes && budget.expenseTotal) {
    for (let m = 0; m < 12; m++) {
      let sum = 0;
      for (const c of budget.expenseByConcept ?? []) {
        if (categoryForBudgetConcept(c.concept, includeTaxes) == null) continue;
        sum += Math.max(0, Number(c.monthly?.[m]) || 0);
      }
      const target = Number(budget.expenseTotal[m]) || 0;
      scaleByMonth[m] = sum > 0 && target > 0 ? target / sum : 1;
    }
  }

  let conceptIdx = 0;
  for (const concept of budget.expenseByConcept ?? []) {
    const category = categoryForBudgetConcept(concept.concept, includeTaxes);
    if (!category) { conceptIdx++; continue; }

    for (let monthIdx = 0; monthIdx < 12; monthIdx++) {
      const rawAmount = Number(concept.monthly?.[monthIdx]) || 0;
      if (rawAmount <= 0) continue;
      const amount = rawAmount * scaleByMonth[monthIdx];

      const ym = `${budget.year}-${String(monthIdx + 1).padStart(2, '0')}`;
      if (ym < startMonth || ym > endMonth) continue;

      const day = typicalDayForConcept(concept.concept, conceptIdx);
      let projectedDate = dateForDayOfMonth(ym, day);
      if (!includePast) {
        if (ym === asOfMonth && projectedDate < asOfDate) projectedDate = asOfDate;
        else if (ym < asOfMonth) continue;
      }

      movements.push({
        id: `budget:${budget.year}:${monthIdx + 1}:${concept.concept.toLowerCase().replace(/\s+/g, '-')}`,
        sourceSystem: category === 'PAYROLL' ? 'PAYROLL' : 'FORECAST',
        type: 'OUTFLOW',
        category,
        counterpartyType: category === 'PAYROLL' ? 'EMPLOYEE' : 'INTERNAL',
        counterpartyName: concept.concept,
        concept: concept.concept,
        currency: 'MXN',
        originalAmount: amount,
        baseAmount: amount,
        projectedAmount: amount,
        projectedDate,
        confidenceScore: 70,
        confidenceBand: 'MEDIUM',
        forecastMethod: 'DRIVER',
        ruleApplied: 'Presupuesto anual (Romo)',
        taxTreatment: category === 'PAYROLL' || category === 'DEBT' ? 'IVA_EXEMPT' : 'UNCLASSIFIED',
        status: 'PROJECTED_BASE',
        lockState: 'RESTRICTED',
        comments: [`Línea de presupuesto ${concept.concept} · mes ${ym}.`],
        createdAt,
        updatedAt: createdAt,
      });
    }
    conceptIdx++;
  }

  return movements;
}

export interface BuildBudgetInflowsInput {
  budget: Budget | null;
  asOfDate: string;
  startDate: string;
  endDate: string;
}

/**
 * Emits one INFLOW movement per (concept × month) from the budget income
 * breakdown — used by the Base scenario to mirror Romo's CSV exactly.
 * Falls back to `incomeTotal` when no concept breakdown was provided.
 */
export function buildBudgetInflowMovements(input: BuildBudgetInflowsInput): FinancialMovement[] {
  const { budget, asOfDate, startDate, endDate } = input;
  if (!budget) return [];

  const movements: FinancialMovement[] = [];
  const createdAt = `${asOfDate}T00:00:00.000Z`;
  const startMonth = startDate.slice(0, 7);
  const endMonth = endDate.slice(0, 7);

  const concepts = (budget.incomeByConcept && budget.incomeByConcept.length > 0)
    ? budget.incomeByConcept
    : [{ concept: 'Ingresos Totales', monthly: budget.incomeTotal }];

  // Per-month scale factor to align emitted lines with `incomeTotal`.
  const scaleByMonth: number[] = new Array(12).fill(1);
  if (budget.incomeTotal) {
    for (let m = 0; m < 12; m++) {
      let sum = 0;
      for (const c of concepts) sum += Math.max(0, Number(c.monthly?.[m]) || 0);
      const target = Number(budget.incomeTotal[m]) || 0;
      scaleByMonth[m] = sum > 0 && target > 0 ? target / sum : 1;
    }
  }

  let conceptIdx = 0;
  for (const concept of concepts) {
    for (let monthIdx = 0; monthIdx < 12; monthIdx++) {
      const rawAmount = Number(concept.monthly?.[monthIdx]) || 0;
      if (rawAmount <= 0) continue;
      const amount = rawAmount * scaleByMonth[monthIdx];
      const ym = `${budget.year}-${String(monthIdx + 1).padStart(2, '0')}`;
      if (ym < startMonth || ym > endMonth) continue;

      const day = 25; // typical receivables day
      const projectedDate = dateForDayOfMonth(ym, day);

      movements.push({
        id: `budget-income:${budget.year}:${monthIdx + 1}:${concept.concept.toLowerCase().replace(/\s+/g, '-')}`,
        sourceSystem: 'FORECAST',
        type: 'INFLOW',
        category: 'AR_COLLECTION',
        counterpartyType: 'CUSTOMER',
        counterpartyName: concept.concept,
        concept: concept.concept,
        currency: 'MXN',
        originalAmount: amount,
        baseAmount: amount,
        projectedAmount: amount,
        projectedDate,
        confidenceScore: 70,
        confidenceBand: 'MEDIUM',
        forecastMethod: 'DRIVER',
        ruleApplied: 'Presupuesto anual (Romo)',
        taxTreatment: 'UNCLASSIFIED',
        status: 'PROJECTED_BASE',
        lockState: 'RESTRICTED',
        comments: [`Línea de ingreso del presupuesto ${concept.concept} · mes ${ym}.`],
        createdAt,
        updatedAt: createdAt,
      });
    }
    conceptIdx++;
  }

  return movements;
}
