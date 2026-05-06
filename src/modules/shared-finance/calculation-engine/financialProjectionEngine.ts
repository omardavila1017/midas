import type {
  CellOverride,
  ConfidenceBand,
  FinancialAdjustment,
  FinancialMovement,
  FinancialScenario,
  ForecastRun,
  PlanningRow,
  ProjectionAlert,
  ProjectionBucket,
  ProjectionGranularity,
  ProjectionSummary,
  ScenarioComparison,
} from '../types';

export interface ProjectionOptions {
  startDate: string;
  endDate: string;
  initialCash: number;
  minimumCash: number;
  granularity?: ProjectionGranularity;
  scenarioId?: string;
  name?: string;
}

export function calculateConfidenceBand(score: number): ConfidenceBand {
  if (score >= 90) return 'CONFIRMED';
  if (score >= 75) return 'HIGH';
  if (score >= 60) return 'MEDIUM';
  if (score >= 40) return 'LOW';
  return 'EXPLORATORY';
}

export function calculateMovementConfidence(input: {
  sourceSystem: FinancialMovement['sourceSystem'];
  forecastMethod: FinancialMovement['forecastMethod'];
  hasManualValidation?: boolean;
  historyScore?: number;
  freshnessScore?: number;
}): { score: number; band: ConfidenceBand } {
  const sourceScore = {
    BANK: 30,
    JDE: 26,
    TAX: 24,
    PAYROLL: 22,
    EXCEL: 16,
    FORECAST: 14,
    MANUAL: 12,
  }[input.sourceSystem];
  const methodScore = {
    RULE: 18,
    DRIVER: 16,
    STATISTICAL: 14,
    ML: 12,
    MANUAL: 10,
  }[input.forecastMethod];
  const history = Math.max(0, Math.min(20, input.historyScore ?? 14));
  const freshness = Math.max(0, Math.min(20, input.freshnessScore ?? 14));
  const validation = input.hasManualValidation ? 12 : 4;
  const score = Math.max(0, Math.min(100, sourceScore + methodScore + history + freshness + validation));
  return { score, band: calculateConfidenceBand(score) };
}

export function calculateBaseProjection(movements: FinancialMovement[], options: ProjectionOptions): ForecastRun {
  const granularity = options.granularity ?? 'daily';
  const normalized = movements
    .filter((movement) => movement.status !== 'CANCELLED')
    .map((movement) => ({
      ...movement,
      confidenceBand: calculateConfidenceBand(movement.confidenceScore),
    }));
  const buckets = calculateCashBalance(normalized, { ...options, granularity });
  const alerts = calculateRiskAlerts(buckets, normalized);
  const bucketsWithAlerts = buckets.map((bucket) => ({
    ...bucket,
    alertIds: alerts.filter((alert) => bucket.date === bucketKeyForDate(alert.date, granularity)).map((alert) => alert.id),
  }));
  return {
    id: `forecast-${options.scenarioId ?? 'base'}-${granularity}-${options.startDate}`,
    name: options.name ?? 'Proyección base',
    scenarioId: options.scenarioId ?? 'base',
    status: options.scenarioId && options.scenarioId !== 'base' ? 'SIMULATED' : 'BASE',
    granularity,
    startDate: options.startDate,
    endDate: options.endDate,
    generatedAt: new Date().toISOString(),
    movements: normalized,
    buckets: bucketsWithAlerts,
    summary: summarizeProjection(bucketsWithAlerts, normalized, options.minimumCash, granularity),
    alerts,
  };
}

export function groupMovementsByDate(
  movements: FinancialMovement[],
  granularity: ProjectionGranularity = 'daily',
): Map<string, FinancialMovement[]> {
  const map = new Map<string, FinancialMovement[]>();
  for (const movement of movements) {
    const key = bucketKeyForDate(effectiveMovementDate(movement), granularity);
    const bucket = map.get(key) ?? [];
    bucket.push(movement);
    map.set(key, bucket);
  }
  return map;
}

export function calculateCashBalance(movements: FinancialMovement[], options: ProjectionOptions): ProjectionBucket[] {
  const granularity = options.granularity ?? 'daily';
  const bucketDates = buildBucketDates(options.startDate, options.endDate, granularity);
  const grouped = groupMovementsByDate(
    movements.filter((movement) => inRange(effectiveMovementDate(movement), options.startDate, options.endDate)),
    granularity,
  );
  let openingCash = options.initialCash;
  return bucketDates.map((date) => {
    const bucketMovements = grouped.get(date) ?? [];
    const inflows = bucketMovements
      .filter((movement) => movement.type === 'INFLOW')
      .reduce((sum, movement) => sum + effectiveAmount(movement), 0);
    const outflows = bucketMovements
      .filter((movement) => movement.type === 'OUTFLOW')
      .reduce((sum, movement) => sum + effectiveAmount(movement), 0);
    const net = inflows - outflows;
    const closingCash = openingCash + net;
    const confidenceScore = bucketMovements.length === 0
      ? 100
      : bucketMovements.reduce((sum, movement) => sum + movement.confidenceScore, 0) / bucketMovements.length;
    const bucket: ProjectionBucket = {
      date,
      label: bucketLabel(date, granularity),
      openingCash,
      inflows,
      outflows,
      net,
      closingCash,
      minimumCash: options.minimumCash,
      deficit: Math.max(0, options.minimumCash - closingCash),
      confidenceScore,
      movementIds: bucketMovements.map((movement) => movement.id),
      alertIds: [],
    };
    openingCash = closingCash;
    return bucket;
  });
}

export function applyAdjustmentsToMovements(
  baseMovements: FinancialMovement[],
  adjustments: FinancialAdjustment[],
  scenarioId: string,
): FinancialMovement[] {
  const activeAdjustments = adjustments.filter((adjustment) =>
    adjustment.scenarioIds.includes(scenarioId) && adjustment.status !== 'REJECTED',
  );
  let movements: FinancialMovement[] = baseMovements.map((movement) => ({ ...movement, comments: [...(movement.comments ?? [])] }));

  for (const adjustment of activeAdjustments) {
    if (adjustment.type === 'ADD_MOVEMENT' || adjustment.type === 'FINANCING_DRAW') {
      const added = movementFromAdjustment(adjustment);
      if (added) movements = [...movements, added];
      continue;
    }

    const next: FinancialMovement[] = [];
    for (const movement of movements) {
      if (!matchesAdjustmentTarget(movement, adjustment)) {
        next.push(movement);
        continue;
      }
      next.push(...applySingleAdjustment(movement, adjustment));
    }
    movements = next;
  }

  return movements.filter((movement) => movement.status !== 'CANCELLED');
}

export function calculateScenarioProjection(
  baseProjection: ForecastRun,
  scenario: FinancialScenario,
  adjustments: FinancialAdjustment[],
  options?: Partial<ProjectionOptions>,
): ForecastRun {
  const adjustedMovements = scenario.isBase
    ? baseProjection.movements
    : applyAdjustmentsToMovements(baseProjection.movements, adjustments, scenario.id);
  return calculateBaseProjection(adjustedMovements, {
    startDate: options?.startDate ?? baseProjection.startDate,
    endDate: options?.endDate ?? baseProjection.endDate,
    initialCash: options?.initialCash ?? baseProjection.buckets[0]?.openingCash ?? baseProjection.summary.currentCash,
    minimumCash: options?.minimumCash ?? baseProjection.summary.minimumCashRequired,
    granularity: options?.granularity ?? baseProjection.granularity,
    scenarioId: scenario.id,
    name: scenario.name,
  });
}

export interface ApplyCellOverridesArgs {
  buckets: ProjectionBucket[];
  overrides: CellOverride[];
  movements: FinancialMovement[];
  rows: PlanningRow[];
  granularity: ProjectionGranularity;
  conceptKeyForMovement: (movement: FinancialMovement) => string;
  asOfDate?: string;
  initialCash?: number;
}

export function applyCellOverridesToBuckets(args: ApplyCellOverridesArgs): ProjectionBucket[] {
  const { buckets, overrides, movements, rows, granularity, conceptKeyForMovement, asOfDate, initialCash } = args;
  const filteredOverrides = overrides.filter((override) => override.granularity === granularity);
  if (filteredOverrides.length === 0 && rows.length === 0) return buckets;

  const overrideIndex = new Map<string, CellOverride>();
  for (const override of filteredOverrides) {
    overrideIndex.set(`${override.conceptKey}::${override.bucketKey}`, override);
  }

  const movementById = new Map<string, FinancialMovement>();
  for (const movement of movements) movementById.set(movement.id, movement);

  const recomputed = buckets.map((bucket) => {
    const bucketMovements = bucket.movementIds
      .map((id) => movementById.get(id))
      .filter((value): value is FinancialMovement => Boolean(value));

    const aggregateByConcept = new Map<string, number>();
    for (const movement of bucketMovements) {
      const key = conceptKeyForMovement(movement);
      const current = aggregateByConcept.get(key) ?? 0;
      aggregateByConcept.set(key, current + effectiveAmount(movement));
    }

    const isPast = asOfDate ? bucket.date < bucketKeyForDate(asOfDate, granularity) : false;

    let inflows = 0;
    let outflows = 0;

    for (const row of rows) {
      const aggregate = aggregateByConcept.get(row.conceptKey) ?? 0;
      const override = !isPast ? overrideIndex.get(`${row.conceptKey}::${bucket.date}`) : undefined;
      const value = override ? override.value : aggregate;
      if (row.type === 'INFLOW') inflows += value;
      else outflows += value;
    }

    for (const [conceptKey, aggregate] of aggregateByConcept.entries()) {
      const known = rows.some((row) => row.conceptKey === conceptKey);
      if (known) continue;
      const sample = bucketMovements.find((movement) => conceptKeyForMovement(movement) === conceptKey);
      if (!sample) continue;
      if (sample.type === 'INFLOW') inflows += aggregate;
      else outflows += aggregate;
    }

    const net = inflows - outflows;
    return {
      ...bucket,
      inflows,
      outflows,
      net,
    };
  });

  const opening = initialCash ?? buckets[0]?.openingCash ?? 0;
  return recomputeRollingCash(recomputed, opening);
}

export function recomputeRollingCash(buckets: ProjectionBucket[], initialCash: number): ProjectionBucket[] {
  let opening = initialCash;
  return buckets.map((bucket) => {
    const closing = opening + bucket.net;
    const next: ProjectionBucket = {
      ...bucket,
      openingCash: opening,
      closingCash: closing,
      deficit: Math.max(0, bucket.minimumCash - closing),
    };
    opening = closing;
    return next;
  });
}

export function summarizeBucketsForScenario(
  buckets: ProjectionBucket[],
  movements: FinancialMovement[],
  minimumCashRequired: number,
  granularity: ProjectionGranularity = 'daily',
): ProjectionSummary {
  return summarizeProjection(buckets, movements, minimumCashRequired, granularity);
}

export function compareProjectionVsScenario(baseProjection: ForecastRun, scenarioProjection: ForecastRun): ScenarioComparison {
  const baseRisk = riskScore(baseProjection);
  const scenarioRisk = riskScore(scenarioProjection);
  return {
    scenarioId: scenarioProjection.scenarioId,
    scenarioName: scenarioProjection.name,
    finalCash: scenarioProjection.summary.finalCash,
    minCash: scenarioProjection.summary.minCash,
    deficitDays: scenarioProjection.summary.deficitDays,
    totalInflows: scenarioProjection.summary.totalInflows,
    totalOutflows: scenarioProjection.summary.totalOutflows,
    maxRiskDate: scenarioProjection.summary.maxRiskDate,
    creditRequired: scenarioProjection.summary.creditRequired,
    averageConfidence: scenarioProjection.summary.averageConfidence,
    finalCashDelta: scenarioProjection.summary.finalCash - baseProjection.summary.finalCash,
    deficitDaysDelta: scenarioProjection.summary.deficitDays - baseProjection.summary.deficitDays,
    totalInflowsDelta: scenarioProjection.summary.totalInflows - baseProjection.summary.totalInflows,
    totalOutflowsDelta: scenarioProjection.summary.totalOutflows - baseProjection.summary.totalOutflows,
    riskScoreDelta: scenarioRisk - baseRisk,
  };
}

export function compareScenarios(baseProjection: ForecastRun, projections: ForecastRun[]): ScenarioComparison[] {
  return projections.map((projection) => compareProjectionVsScenario(baseProjection, projection));
}

export function calculateScenarioImpact(baseProjection: ForecastRun, adjustedProjection: ForecastRun) {
  return compareProjectionVsScenario(baseProjection, adjustedProjection);
}

export function effectiveMovementDate(movement: FinancialMovement): string {
  return movement.actualDate ?? movement.adjustedDate ?? movement.projectedDate;
}

export function effectiveAmount(movement: FinancialMovement): number {
  return Math.max(0, movement.adjustedAmount ?? movement.projectedAmount);
}

function applySingleAdjustment(movement: FinancialMovement, adjustment: FinancialAdjustment): FinancialMovement[] {
  const base: FinancialMovement = {
    ...movement,
    status: 'ADJUSTED',
    comments: [...(movement.comments ?? []), adjustment.justification],
    updatedAt: adjustment.createdAt,
  };

  if (adjustment.type === 'DATE_SHIFT') {
    return [{
      ...base,
      adjustedDate: typeof adjustment.adjustedValue === 'string'
        ? adjustment.adjustedValue
        : addDays(effectiveMovementDate(movement), adjustment.deltaDays ?? 0),
    }];
  }

  if (adjustment.type === 'AMOUNT_OVERRIDE') {
    const adjustedAmount = typeof adjustment.adjustedValue === 'number'
      ? adjustment.adjustedValue
      : effectiveAmount(movement);
    return [{ ...base, adjustedAmount: Math.max(0, adjustedAmount) }];
  }

  if (adjustment.type === 'AMOUNT_DELTA') {
    return [{ ...base, adjustedAmount: Math.max(0, effectiveAmount(movement) + (adjustment.deltaAmount ?? 0)) }];
  }

  if (adjustment.type === 'PERCENTAGE_CHANGE') {
    return [{ ...base, adjustedAmount: Math.max(0, effectiveAmount(movement) * (1 + (adjustment.percentageChange ?? 0))) }];
  }

  if (adjustment.type === 'CANCEL_MOVEMENT') {
    return [{ ...base, adjustedAmount: 0, status: 'CANCELLED' }];
  }

  if (adjustment.type === 'SPLIT_PAYMENT') {
    const numberOfPayments = Math.max(1, adjustment.splitConfig?.numberOfPayments ?? 1);
    const amount = effectiveAmount(movement) / numberOfPayments;
    const baseDate = effectiveMovementDate(movement);
    return Array.from({ length: numberOfPayments }, (_, index) => ({
      ...base,
      id: `${movement.id}:split:${adjustment.id}:${index + 1}`,
      sourceObjectId: movement.sourceObjectId ?? movement.id,
      projectedAmount: amount,
      adjustedAmount: amount,
      projectedDate: splitDate(adjustment, baseDate, index),
      adjustedDate: splitDate(adjustment, baseDate, index),
      concept: `${movement.concept} (${index + 1}/${numberOfPayments})`,
    }));
  }

  return [base];
}

function movementFromAdjustment(adjustment: FinancialAdjustment): FinancialMovement | null {
  const value = adjustment.adjustedValue;
  if (!value || typeof value !== 'object') return null;
  const movement = value as Partial<FinancialMovement>;
  if (!movement.projectedDate || !movement.type || !movement.category || typeof movement.projectedAmount !== 'number') return null;
  const score = movement.confidenceScore ?? 55;
  return {
    id: movement.id ?? `movement-${adjustment.id}`,
    sourceSystem: movement.sourceSystem ?? 'MANUAL',
    sourceObjectId: movement.sourceObjectId,
    type: movement.type,
    category: movement.category,
    subcategory: movement.subcategory,
    companyId: movement.companyId,
    businessUnitId: movement.businessUnitId,
    bankAccountId: movement.bankAccountId,
    counterpartyId: movement.counterpartyId,
    counterpartyName: movement.counterpartyName,
    counterpartyType: movement.counterpartyType,
    concept: movement.concept ?? adjustment.name,
    currency: movement.currency ?? 'MXN',
    originalAmount: movement.originalAmount ?? movement.projectedAmount,
    baseAmount: movement.baseAmount ?? movement.projectedAmount,
    projectedAmount: movement.projectedAmount,
    adjustedAmount: movement.adjustedAmount ?? movement.projectedAmount,
    issueDate: movement.issueDate,
    dueDate: movement.dueDate,
    projectedDate: movement.projectedDate,
    adjustedDate: movement.adjustedDate ?? movement.projectedDate,
    actualDate: movement.actualDate,
    confidenceScore: score,
    confidenceBand: calculateConfidenceBand(score),
    forecastMethod: movement.forecastMethod ?? 'MANUAL',
    ruleApplied: movement.ruleApplied ?? `Ajuste ${adjustment.type}`,
    taxTreatment: movement.taxTreatment,
    taxRate: movement.taxRate,
    taxBaseAmount: movement.taxBaseAmount,
    taxAmount: movement.taxAmount,
    status: 'ADJUSTED',
    lockState: movement.lockState ?? 'UNLOCKED',
    comments: [adjustment.justification],
    createdAt: adjustment.createdAt,
    updatedAt: adjustment.createdAt,
  };
}

function matchesAdjustmentTarget(movement: FinancialMovement, adjustment: FinancialAdjustment): boolean {
  const expression = adjustment.targetExpression.trim();
  if (!expression) return false;
  if (adjustment.targetType === 'MOVEMENT') {
    return movement.id === expression || movement.sourceObjectId === expression;
  }
  if (adjustment.targetType === 'CATEGORY') {
    return movement.category === expression;
  }
  if (adjustment.targetType === 'COUNTERPARTY') {
    return movement.counterpartyId === expression || movement.counterpartyName === expression;
  }
  if (adjustment.targetType === 'DATE_RANGE') {
    const [start, end] = expression.split('..');
    return Boolean(start && end && inRange(effectiveMovementDate(movement), start, end));
  }
  return filterExpressionMatches(movement, expression);
}

function filterExpressionMatches(movement: FinancialMovement, expression: string): boolean {
  const clauses = expression.split(/[;&]/).map((part) => part.trim()).filter(Boolean);
  return clauses.every((clause) => {
    const [field, value] = clause.split('=').map((part) => part.trim());
    if (!field || !value) return false;
    if (field === 'type') return movement.type === value;
    if (field === 'category') return movement.category === value;
    if (field === 'sourceSystem') return movement.sourceSystem === value;
    if (field === 'counterpartyType') return movement.counterpartyType === value;
    if (field === 'companyId') return movement.companyId === value;
    if (field === 'bankAccountId') return movement.bankAccountId === value;
    return false;
  });
}

function calculateRiskAlerts(buckets: ProjectionBucket[], movements: FinancialMovement[]): ProjectionAlert[] {
  const alerts: ProjectionAlert[] = [];
  for (const bucket of buckets) {
    if (bucket.deficit > 0) {
      alerts.push({
        id: `alert-deficit-${bucket.date}`,
        date: bucket.date,
        severity: 'CRITICAL',
        title: 'Caja bajo mínimo',
        description: `El cierre queda debajo de caja mínima por ${Math.round(bucket.deficit).toLocaleString('es-MX')} MXN.`,
      });
    }
    if (bucket.confidenceScore < 60 && bucket.movementIds.length > 0) {
      alerts.push({
        id: `alert-confidence-${bucket.date}`,
        date: bucket.date,
        severity: 'WARNING',
        title: 'Confianza media o baja',
        description: 'El bucket contiene movimientos con supuestos débiles o poco frescos.',
      });
    }
  }
  for (const movement of movements) {
    if (movement.category === 'TAX' && movement.type === 'OUTFLOW' && movement.lockState !== 'LOCKED') {
      alerts.push({
        id: `alert-tax-${movement.id}`,
        date: effectiveMovementDate(movement),
        severity: 'WARNING',
        title: 'Impuesto separado',
        description: 'Validar plan fiscal antes de mover o dividir este pago.',
        movementId: movement.id,
      });
    }
  }
  return alerts;
}

function countDeficitDaysFromMovements(movements: FinancialMovement[]): number {
  const perDay = new Map<string, { inflows: number; outflows: number }>();
  for (const movement of movements) {
    if (movement.status === 'CANCELLED') continue;
    const date = effectiveMovementDate(movement);
    if (!date) continue;
    const key = date.slice(0, 10);
    const amount = effectiveAmount(movement);
    const entry = perDay.get(key) ?? { inflows: 0, outflows: 0 };
    if (movement.type === 'INFLOW') entry.inflows += amount;
    else entry.outflows += amount;
    perDay.set(key, entry);
  }
  let count = 0;
  for (const { inflows, outflows } of perDay.values()) {
    if (outflows > inflows) count += 1;
  }
  return count;
}

function summarizeProjection(
  buckets: ProjectionBucket[],
  movements: FinancialMovement[],
  minimumCashRequired: number,
  granularity: ProjectionGranularity = 'daily',
): ProjectionSummary {
  const bucketForDay = (days: number) => buckets[Math.min(days - 1, Math.max(0, buckets.length - 1))];
  const futureMovements = movements
    .filter((movement) => movement.status !== 'REAL' && movement.status !== 'EXECUTED')
    .sort((a, b) => effectiveMovementDate(a).localeCompare(effectiveMovementDate(b)));
  const largestUpcomingInflow = [...futureMovements]
    .filter((movement) => movement.type === 'INFLOW')
    .sort((a, b) => effectiveAmount(b) - effectiveAmount(a))[0];
  const largestUpcomingOutflow = [...futureMovements]
    .filter((movement) => movement.type === 'OUTFLOW')
    .sort((a, b) => effectiveAmount(b) - effectiveAmount(a))[0];
  const minBucket = [...buckets].sort((a, b) => a.closingCash - b.closingCash)[0];
  const maxRiskBucket = [...buckets].sort((a, b) => b.deficit - a.deficit)[0];
  const totalInflows = buckets.reduce((sum, bucket) => sum + bucket.inflows, 0);
  const totalOutflows = buckets.reduce((sum, bucket) => sum + bucket.outflows, 0);
  const lastBucket = buckets[buckets.length - 1];
  return {
    currentCash: buckets[0]?.openingCash ?? 0,
    projectedCash7: bucketForDay(7)?.closingCash ?? lastBucket?.closingCash ?? 0,
    projectedCash30: bucketForDay(30)?.closingCash ?? lastBucket?.closingCash ?? 0,
    projectedCash90: bucketForDay(90)?.closingCash ?? lastBucket?.closingCash ?? 0,
    minimumCashRequired,
    deficitDays: countDeficitDaysFromMovements(movements),
    largestUpcomingInflow,
    largestUpcomingOutflow,
    averageConfidence: movements.length === 0
      ? 100
      : movements.reduce((sum, movement) => sum + movement.confidenceScore, 0) / movements.length,
    totalInflows,
    totalOutflows,
    finalCash: lastBucket?.closingCash ?? 0,
    minCash: minBucket?.closingCash ?? 0,
    maxRiskDate: maxRiskBucket?.deficit ? maxRiskBucket.date : undefined,
    creditRequired: Math.max(0, minimumCashRequired - (minBucket?.closingCash ?? minimumCashRequired)),
  };
}

function riskScore(projection: ForecastRun): number {
  return projection.summary.deficitDays * 10
    + projection.summary.creditRequired / 1_000_000
    + Math.max(0, 70 - projection.summary.averageConfidence);
}

function splitDate(adjustment: FinancialAdjustment, baseDate: string, index: number): string {
  const custom = adjustment.splitConfig?.dates?.[index];
  if (custom) return custom;
  const frequency = adjustment.splitConfig?.frequency ?? 'WEEKLY';
  const step = frequency === 'BIWEEKLY' ? 14 : frequency === 'MONTHLY' ? 30 : 7;
  return addDays(baseDate, step * index);
}

export function buildBucketDates(startDate: string, endDate: string, granularity: ProjectionGranularity): string[] {
  const out: string[] = [];
  let cursor = bucketKeyForDate(startDate, granularity);
  while (cursor <= endDate) {
    out.push(cursor);
    cursor = addBucket(cursor, granularity);
  }
  return out;
}

export function bucketKeyForDate(date: string, granularity: ProjectionGranularity): string {
  if (granularity === 'daily') return date;
  if (granularity === 'monthly') return `${date.slice(0, 7)}-01`;
  const parsed = parseIso(date);
  const day = parsed.getUTCDay();
  const mondayOffset = (day + 6) % 7;
  parsed.setUTCDate(parsed.getUTCDate() - mondayOffset);
  return toIso(parsed);
}

export function bucketLabel(date: string, granularity: ProjectionGranularity): string {
  if (granularity === 'daily') return date.slice(5);
  if (granularity === 'weekly') return `Sem ${date.slice(5)}`;
  return date.slice(0, 7);
}

function addBucket(date: string, granularity: ProjectionGranularity): string {
  if (granularity === 'daily') return addDays(date, 1);
  if (granularity === 'weekly') return addDays(date, 7);
  const parsed = parseIso(date);
  parsed.setUTCMonth(parsed.getUTCMonth() + 1);
  return toIso(parsed);
}

function addDays(date: string, days: number): string {
  const parsed = parseIso(date);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return toIso(parsed);
}

function inRange(date: string, startDate: string, endDate: string): boolean {
  return date >= startDate && date <= endDate;
}

function parseIso(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, (month || 1) - 1, day || 1));
}

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}
