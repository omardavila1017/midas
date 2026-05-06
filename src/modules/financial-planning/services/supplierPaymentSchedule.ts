import type { Provider } from '../../../domain/types';
import {
  effectiveAmount,
  effectiveMovementDate,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type { FinancialMovement } from '../../shared-finance/types';

export type SupplierPaymentStatus = 'PAID' | 'DEFERRED' | 'PENDING';

export interface SupplierPaymentDecision {
  movementId: string;
  scenarioId: string;
  providerId?: string;
  providerName: string;
  invoiceId?: string;
  score: number;
  originalDate: string;
  dueDate?: string;
  estimatedDate?: string;
  amount: number;
  paidAmount: number;
  pendingAmount: number;
  status: SupplierPaymentStatus;
  daysDeferred: number;
  reason: string;
}

export interface DailyOperatingFlowRow {
  date: string;
  openingCash: number;
  expectedInflows: number;
  confirmedInflows: number;
  clientNamesExpected: string[];
  clientNamesConfirmed: string[];
  scheduledOutflows: number;
  executedOutflows: number;
  outflowConcepts: string[];
  supplierNamesScheduled: string[];
  suppliersPaid: number;
  suppliersPending: number;
  supplierNamesPaid: string[];
  supplierNamesPending: string[];
  net: number;
  closingCash: number;
  deficit: number;
}

export interface SupplierPaymentPlan {
  decisions: SupplierPaymentDecision[];
  dailyRows: DailyOperatingFlowRow[];
  diagnostics: SupplierPaymentDiagnostics;
}

export interface SupplierPaymentDiagnostics {
  payableMovements: number;
  managedPayableMovements: number;
  skippedResolvedPayables: number;
  missingProviderMatches: number;
}

export interface ScheduleSupplierPaymentsArgs {
  movements: FinancialMovement[];
  providers: Provider[];
  startDate: string;
  endDate: string;
  initialCash: number;
  minimumCash: number;
  scenarioId: string;
}

interface QueueItem {
  movement: FinancialMovement;
  originalDate: string;
  readyDate: string;
  amount: number;
  provider?: Provider;
  score: number;
}

export function scheduleSupplierPaymentsByScore(args: ScheduleSupplierPaymentsArgs): {
  movements: FinancialMovement[];
  plan: SupplierPaymentPlan;
} {
  const providerIndex = buildProviderIndex(args.providers);
  const managed: QueueItem[] = [];
  const passthrough: FinancialMovement[] = [];
  const diagnostics: SupplierPaymentDiagnostics = {
    payableMovements: 0,
    managedPayableMovements: 0,
    skippedResolvedPayables: 0,
    missingProviderMatches: 0,
  };

  for (const movement of args.movements) {
    if (isPayableMovement(movement)) diagnostics.payableMovements++;
    if (isSupplierPayment(movement)) {
      const provider = providerForMovement(movement, providerIndex);
      if (!provider) diagnostics.missingProviderMatches++;
      diagnostics.managedPayableMovements++;
      managed.push({
        movement,
        provider,
        originalDate: originalSupplierDate(movement),
        readyDate: effectiveMovementDate(movement),
        amount: effectiveAmount(movement),
        score: scoreFor(provider, movement),
      });
    } else {
      if (isPayableMovement(movement) && isResolvedPayment(movement)) diagnostics.skippedResolvedPayables++;
      passthrough.push(movement);
    }
  }

  if (managed.length === 0) {
    return {
      movements: args.movements,
      plan: buildDailyRows({
        startDate: args.startDate,
        endDate: args.endDate,
        initialCash: args.initialCash,
        minimumCash: args.minimumCash,
        passthrough,
        decisions: [],
        diagnostics,
      }),
    };
  }

  const pending = [...managed].sort(compareQueueItems);
  const paidMovementById = new Map<string, FinancialMovement>();
  const decisions: SupplierPaymentDecision[] = [];
  const dates = enumerateDates(args.startDate, args.endDate);
  let cash = args.initialCash;
  const dailyRows: DailyOperatingFlowRow[] = [];

  for (const date of dates) {
    const openingCash = cash;
    const todaysPassthrough = passthrough.filter((movement) => effectiveMovementDate(movement) === date);
    const inflows = todaysPassthrough
      .filter((movement) => movement.type === 'INFLOW')
      .reduce((sum, movement) => sum + effectiveAmount(movement), 0);
    const confirmedInflows = todaysPassthrough
      .filter((movement) => movement.type === 'INFLOW' && isConfirmedInflow(movement))
      .reduce((sum, movement) => sum + effectiveAmount(movement), 0);
    const otherOutflows = todaysPassthrough
      .filter((movement) => movement.type === 'OUTFLOW')
      .reduce((sum, movement) => sum + effectiveAmount(movement), 0);
    const todayInflows = todaysPassthrough.filter((movement) => movement.type === 'INFLOW');
    const todayOutflowMovements = todaysPassthrough.filter((movement) => movement.type === 'OUTFLOW');
    const scheduledSupplierItems = managed.filter((item) => item.readyDate === date);

    cash += inflows;
    cash -= otherOutflows;

    const paidToday: QueueItem[] = [];
    const ready = pending
      .filter((item) => item.readyDate <= date)
      .sort(compareQueueItems);

    while (ready.length > 0) {
      const candidate = ready[0];
      if (cash - candidate.amount < args.minimumCash) break;
      cash -= candidate.amount;
      paidToday.push(candidate);
      removeQueueItem(pending, candidate);
      ready.shift();

      const deferred = date > candidate.originalDate;
      paidMovementById.set(candidate.movement.id, {
      ...candidate.movement,
      adjustedDate: date,
      adjustedAmount: candidate.amount,
        status: deferred ? 'ADJUSTED' : candidate.movement.status,
        confidenceScore: Math.max(candidate.movement.confidenceScore, Math.min(100, candidate.score)),
        comments: [
          ...(candidate.movement.comments ?? []),
          deferred
            ? `Reprogramado por flujo en ${args.scenarioId}: ${candidate.originalDate} → ${date}.`
            : `Pagado según score en ${args.scenarioId}.`,
        ],
      });
      decisions.push(decisionFor(candidate, args.scenarioId, deferred ? 'DEFERRED' : 'PAID', date));
    }

    const supplierNamesPending = pending
      .filter((item) => item.readyDate <= date)
      .slice()
      .sort(compareQueueItems)
      .slice(0, 8)
      .map(supplierNameForItem);

    const executedSupplierOutflows = paidToday.reduce((sum, item) => sum + item.amount, 0);
    const scheduledSupplierOutflows = managed
      .filter((item) => item.readyDate === date)
      .reduce((sum, item) => sum + item.amount, 0);
    const executedOutflows = otherOutflows + executedSupplierOutflows;
    const expectedInflows = inflows;
    const scheduledOutflows = otherOutflows + scheduledSupplierOutflows;

    dailyRows.push({
      date,
      openingCash,
      expectedInflows,
      confirmedInflows,
      clientNamesExpected: uniqueLabels(todayInflows.map(inflowLabel)).slice(0, 10),
      clientNamesConfirmed: uniqueLabels(todayInflows.filter(isConfirmedInflow).map(inflowLabel)).slice(0, 10),
      scheduledOutflows,
      executedOutflows,
      outflowConcepts: uniqueLabels([
        ...todayOutflowMovements.map(outflowLabel),
        ...scheduledSupplierItems.map(supplierScheduledLabel),
      ]).slice(0, 10),
      supplierNamesScheduled: uniqueLabels(scheduledSupplierItems.map(supplierNameForItem)).slice(0, 8),
      suppliersPaid: paidToday.length,
      suppliersPending: pending.filter((item) => item.readyDate <= date).length,
      supplierNamesPaid: uniqueLabels(paidToday.map(supplierNameForItem)),
      supplierNamesPending: uniqueLabels(supplierNamesPending),
      net: expectedInflows - executedOutflows,
      closingCash: cash,
      deficit: Math.max(0, args.minimumCash - cash),
    });
  }

  for (const item of pending) {
    decisions.push(decisionFor(item, args.scenarioId, 'PENDING', undefined));
  }

  const beyondRangeDate = addDays(args.endDate, 1);
  const scheduledMovements = args.movements.map((movement) => {
    const paid = paidMovementById.get(movement.id);
    if (paid) return paid;
    const pendingItem = pending.find((item) => item.movement.id === movement.id);
    if (!pendingItem) return movement;
    return {
      ...movement,
      adjustedDate: beyondRangeDate,
      adjustedAmount: pendingItem.amount,
      status: 'ADJUSTED' as const,
      comments: [
        ...(movement.comments ?? []),
        `Pendiente por falta de flujo en ${args.scenarioId}; no se paga dentro de ${args.startDate}–${args.endDate}.`,
      ],
    };
  });

  return {
    movements: scheduledMovements,
    plan: {
      decisions: decisions.sort((a, b) => {
        if (a.status !== b.status) return statusWeight(a.status) - statusWeight(b.status);
        if (b.score !== a.score) return b.score - a.score;
        return a.originalDate.localeCompare(b.originalDate);
      }),
      dailyRows,
      diagnostics,
    },
  };
}

function buildDailyRows(args: {
  startDate: string;
  endDate: string;
  initialCash: number;
  minimumCash: number;
  passthrough: FinancialMovement[];
  decisions: SupplierPaymentDecision[];
  diagnostics: SupplierPaymentDiagnostics;
}): SupplierPaymentPlan {
  let cash = args.initialCash;
  const dailyRows = enumerateDates(args.startDate, args.endDate).map((date) => {
    const openingCash = cash;
    const movements = args.passthrough.filter((movement) => effectiveMovementDate(movement) === date);
    const expectedInflows = movements
      .filter((movement) => movement.type === 'INFLOW')
      .reduce((sum, movement) => sum + effectiveAmount(movement), 0);
    const confirmedInflows = movements
      .filter((movement) => movement.type === 'INFLOW' && isConfirmedInflow(movement))
      .reduce((sum, movement) => sum + effectiveAmount(movement), 0);
    const executedOutflows = movements
      .filter((movement) => movement.type === 'OUTFLOW')
      .reduce((sum, movement) => sum + effectiveAmount(movement), 0);
    cash += expectedInflows - executedOutflows;
    return {
      date,
      openingCash,
      expectedInflows,
      confirmedInflows,
      clientNamesExpected: uniqueLabels(movements.filter((movement) => movement.type === 'INFLOW').map(inflowLabel)).slice(0, 10),
      clientNamesConfirmed: uniqueLabels(movements.filter((movement) => movement.type === 'INFLOW' && isConfirmedInflow(movement)).map(inflowLabel)).slice(0, 10),
      scheduledOutflows: executedOutflows,
      executedOutflows,
      outflowConcepts: uniqueLabels(movements.filter((movement) => movement.type === 'OUTFLOW').map(outflowLabel)).slice(0, 10),
      supplierNamesScheduled: [],
      suppliersPaid: 0,
      suppliersPending: 0,
      supplierNamesPaid: [],
      supplierNamesPending: [],
      net: expectedInflows - executedOutflows,
      closingCash: cash,
      deficit: Math.max(0, args.minimumCash - cash),
    };
  });
  return { decisions: args.decisions, dailyRows, diagnostics: args.diagnostics };
}

function isPayableMovement(movement: FinancialMovement): boolean {
  return movement.type === 'OUTFLOW' && movement.category === 'AP_PAYMENT';
}

function isResolvedPayment(movement: FinancialMovement): boolean {
  return movement.status === 'REAL' || movement.status === 'EXECUTED' || movement.status === 'CANCELLED';
}

function isSupplierPayment(movement: FinancialMovement): boolean {
  return isPayableMovement(movement)
    && !isResolvedPayment(movement)
    && (movement.counterpartyType === 'SUPPLIER' || movement.sourceSystem === 'JDE' || Boolean(movement.counterpartyName));
}

function originalSupplierDate(movement: FinancialMovement): string {
  return movement.dueDate ?? movement.projectedDate;
}

function isConfirmedInflow(movement: FinancialMovement): boolean {
  return movement.status === 'REAL'
    || movement.status === 'EXECUTED'
    || Boolean(movement.actualDate)
    || movement.sourceSystem === 'BANK';
}

function inflowLabel(movement: FinancialMovement): string {
  const source = movement.sourceObjectId ? ` · ${movement.sourceObjectId}` : '';
  return `${movement.counterpartyName ?? movement.concept}${source}`;
}

function outflowLabel(movement: FinancialMovement): string {
  const counterparty = movement.counterpartyName ? `${movement.counterpartyName} · ` : '';
  const source = movement.sourceObjectId ? ` · ${movement.sourceObjectId}` : '';
  return `${counterparty}${movement.concept}${source}`;
}

function supplierNameForItem(item: QueueItem): string {
  return item.movement.counterpartyName ?? item.provider?.name ?? 'Proveedor';
}

function supplierScheduledLabel(item: QueueItem): string {
  const invoice = item.movement.sourceObjectId ? ` · ${item.movement.sourceObjectId}` : '';
  return `${supplierNameForItem(item)} · ${item.movement.concept}${invoice}`;
}

function uniqueLabels(values: string[]): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const value of values) {
    const label = value.trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

function decisionFor(
  item: QueueItem,
  scenarioId: string,
  status: SupplierPaymentStatus,
  estimatedDate: string | undefined,
): SupplierPaymentDecision {
  const paidAmount = status === 'PENDING' ? 0 : item.amount;
  return {
    movementId: item.movement.id,
    scenarioId,
    providerId: item.provider?.id ?? item.movement.counterpartyId,
    providerName: item.movement.counterpartyName ?? item.provider?.name ?? 'Proveedor',
    invoiceId: item.movement.sourceObjectId,
    score: item.score,
    originalDate: item.originalDate,
    dueDate: item.movement.dueDate,
    estimatedDate,
    amount: item.amount,
    paidAmount,
    pendingAmount: item.amount - paidAmount,
    status,
    daysDeferred: estimatedDate ? daysBetween(item.originalDate, estimatedDate) : 0,
    reason: status === 'PENDING'
      ? 'Sin flujo suficiente dentro del horizonte.'
      : estimatedDate && estimatedDate > item.originalDate
        ? 'Recorrido por caja mínima; conserva prioridad por score.'
        : 'Pagado por prioridad de score.',
  };
}

function compareQueueItems(a: QueueItem, b: QueueItem): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.originalDate !== b.originalDate) return a.originalDate.localeCompare(b.originalDate);
  if (a.readyDate !== b.readyDate) return a.readyDate.localeCompare(b.readyDate);
  return a.amount - b.amount;
}

function removeQueueItem(queue: QueueItem[], item: QueueItem): void {
  const index = queue.findIndex((candidate) => candidate.movement.id === item.movement.id);
  if (index >= 0) queue.splice(index, 1);
}

function buildProviderIndex(providers: Provider[]) {
  const byId = new Map<string, Provider>();
  const byName = new Map<string, Provider>();
  const byJde = new Map<string, Provider>();
  for (const provider of providers) {
    byId.set(provider.id, provider);
    byName.set(normalize(provider.name), provider);
    if (provider.numProveedorJDE) byJde.set(provider.numProveedorJDE, provider);
  }
  return { byId, byName, byJde };
}

function providerForMovement(
  movement: FinancialMovement,
  index: ReturnType<typeof buildProviderIndex>,
): Provider | undefined {
  if (movement.counterpartyId) {
    const byId = index.byId.get(movement.counterpartyId);
    if (byId) return byId;
    const byJde = index.byJde.get(movement.counterpartyId);
    if (byJde) return byJde;
  }
  if (movement.counterpartyName) return index.byName.get(normalize(movement.counterpartyName));
  return undefined;
}

function scoreFor(provider: Provider | undefined, movement: FinancialMovement): number {
  if (provider?.score != null && Number.isFinite(provider.score)) {
    return Math.max(0, Math.min(100, Math.round(provider.score)));
  }
  return Math.max(0, Math.min(100, Math.round(movement.confidenceScore)));
}

function statusWeight(status: SupplierPaymentStatus): number {
  if (status === 'PAID') return 0;
  if (status === 'DEFERRED') return 1;
  return 2;
}

function enumerateDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  let cursor = parseIso(startDate);
  const end = parseIso(endDate);
  while (cursor <= end && dates.length < 800) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor = addDate(cursor, 1);
  }
  return dates;
}

function addDays(date: string, days: number): string {
  return addDate(parseIso(date), days).toISOString().slice(0, 10);
}

function addDate(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function parseIso(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, (month || 1) - 1, day || 1));
}

function daysBetween(start: string, end: string): number {
  return Math.round((parseIso(end).getTime() - parseIso(start).getTime()) / 86_400_000);
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}
