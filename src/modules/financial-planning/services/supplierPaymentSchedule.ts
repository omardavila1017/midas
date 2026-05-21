import type { Provider } from '../../../domain/types';
import {
  effectiveAmount,
  effectiveMovementDate,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type { FinancialMovement } from '../../shared-finance/types';

export type SupplierPaymentStatus = 'PAID' | 'DEFERRED' | 'PARTIAL' | 'PENDING';

export interface PaymentInstallment {
  date: string;
  amount: number;
}

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
  installments: PaymentInstallment[];
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
  totalAmount: number;
  remainingAmount: number;
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
      if (isUntouchableSupplierPayment(movement, provider)) {
        passthrough.push(movement);
        continue;
      }
      if (!provider) diagnostics.missingProviderMatches++;
      diagnostics.managedPayableMovements++;
      const amount = effectiveAmount(movement);
      managed.push({
        movement,
        provider,
        originalDate: originalSupplierDate(movement),
        readyDate: eligibleSupplierDate(movement),
        totalAmount: amount,
        remainingAmount: amount,
        score: scoreFor(provider, movement),
      });
    } else if (isSchedulableTaxPayment(movement)) {
      const amount = effectiveAmount(movement);
      managed.push({
        movement,
        originalDate: originalSupplierDate(movement),
        readyDate: eligibleSupplierDate(movement),
        totalAmount: amount,
        remainingAmount: amount,
        score: scoreFor(undefined, movement),
      });
    } else if (isSchedulableSyntheticExpense(movement)) {
      const amount = effectiveAmount(movement);
      managed.push({
        movement,
        originalDate: originalSupplierDate(movement),
        readyDate: eligibleSupplierDate(movement),
        totalAmount: amount,
        remainingAmount: amount,
        score: scoreFor(undefined, movement),
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
  const installmentsByMovementId = new Map<string, PaymentInstallment[]>();
  const dates = enumerateDates(args.startDate, args.endDate);
  let cash = args.initialCash;
  const dailyRows: DailyOperatingFlowRow[] = [];

  for (const date of dates) {
    const openingCash = Math.max(0, cash);
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

    const paidToday: Array<{ item: QueueItem; amount: number }> = [];
    const ready = pending
      .filter((item) => item.readyDate <= date && item.remainingAmount > 0)
      .sort(compareQueueItems);

    while (ready.length > 0) {
      const candidate = ready[0];
      const available = Math.max(0, cash - args.minimumCash);
      if (available <= 0) break;
      const amount = Math.min(candidate.remainingAmount, available);
      if (amount <= 0) break;

      cash -= amount;
      candidate.remainingAmount = Math.max(0, candidate.remainingAmount - amount);
      paidToday.push({ item: candidate, amount });
      appendInstallment(installmentsByMovementId, candidate.movement.id, { date, amount });

      if (candidate.remainingAmount <= 0) {
        removeQueueItem(pending, candidate);
        ready.shift();
      } else {
        break;
      }
    }

    const supplierNamesPending = pending
      .filter((item) => item.readyDate <= date)
      .slice()
      .sort(compareQueueItems)
      .slice(0, 8)
      .map(supplierNameForItem);

    const executedSupplierOutflows = paidToday.reduce((sum, payment) => sum + payment.amount, 0);
    const scheduledSupplierOutflows = managed
      .filter((item) => item.readyDate === date)
      .reduce((sum, item) => sum + item.totalAmount, 0);
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
      suppliersPaid: new Set(paidToday.map((payment) => payment.item.movement.id)).size,
      suppliersPending: pending.filter((item) => item.readyDate <= date).length,
      supplierNamesPaid: uniqueLabels(paidToday.map((payment) => supplierNameForItem(payment.item))),
      supplierNamesPending: uniqueLabels(supplierNamesPending),
      net: expectedInflows - executedOutflows,
      closingCash: cash,
      deficit: Math.max(0, args.minimumCash - cash),
    });
  }

  const decisions = managed.map((item) => decisionFor(
    item,
    args.scenarioId,
    installmentsByMovementId.get(item.movement.id) ?? [],
  ));

  const beyondRangeDate = addDays(args.endDate, 1);
  const managedById = new Map(managed.map((item) => [item.movement.id, item]));
  const scheduledMovements = args.movements.flatMap((movement) => scheduleManagedMovement({
    movement,
    item: managedById.get(movement.id),
    installments: installmentsByMovementId.get(movement.id) ?? [],
    beyondRangeDate,
    scenarioId: args.scenarioId,
    startDate: args.startDate,
    endDate: args.endDate,
  }));

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
    const openingCash = Math.max(0, cash);
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

function isSchedulableTaxPayment(movement: FinancialMovement): boolean {
  return movement.type === 'OUTFLOW'
    && movement.category === 'TAX'
    && movement.lockState !== 'LOCKED'
    && !isResolvedPayment(movement);
}

/**
 * Egreso sintético del motor canónico (`canonical-outflow:{ym}`) — el residuo
 * del balanceo mensual contra el target del Dashboard cuando no hay desglose
 * por catálogo. Sale con `category: 'TRANSFER'`, sin counterparty, RESTRICTED.
 * El scheduler lo trata como diferible (igual que un supplier no-LOCKED) para
 * que el bulto no tire la caja a negativo y se reparta cuando aprieta el flujo.
 * No se reagendan TRANSFER reales (status='REAL' de banco) ni los LOCKED.
 */
function isSchedulableSyntheticExpense(movement: FinancialMovement): boolean {
  return movement.type === 'OUTFLOW'
    && movement.category === 'TRANSFER'
    && movement.sourceSystem === 'FORECAST'
    && movement.id.startsWith('canonical-outflow:')
    && movement.lockState !== 'LOCKED'
    && !isResolvedPayment(movement);
}

function isUntouchableSupplierPayment(
  movement: FinancialMovement,
  provider: Provider | undefined,
): boolean {
  return movement.lockState === 'LOCKED'
    || provider?.clasificacionAlberto === 'CRITICO'
    || provider?.clasificacionAutomatica === 'CRITICO'
    || provider?.flexibility === 'inamovible';
}

function originalSupplierDate(movement: FinancialMovement): string {
  return movement.dueDate ?? movement.projectedDate;
}

function eligibleSupplierDate(movement: FinancialMovement): string {
  const effectiveDate = effectiveMovementDate(movement);
  return movement.dueDate && movement.dueDate > effectiveDate ? movement.dueDate : effectiveDate;
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
  installments: PaymentInstallment[],
): SupplierPaymentDecision {
  const paidAmount = installments.reduce((sum, installment) => sum + installment.amount, 0);
  const pendingAmount = Math.max(0, item.totalAmount - paidAmount);
  const lastInstallment = installments[installments.length - 1];
  const estimatedDate = lastInstallment?.date;
  const status = pendingAmount > 0 && paidAmount > 0
    ? 'PARTIAL'
    : paidAmount === 0
      ? 'PENDING'
      : installments.length > 1
        ? 'PARTIAL'
        : estimatedDate && estimatedDate > item.originalDate
          ? 'DEFERRED'
          : 'PAID';
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
    amount: item.totalAmount,
    paidAmount,
    pendingAmount,
    installments,
    status,
    daysDeferred: estimatedDate ? daysBetween(item.originalDate, estimatedDate) : 0,
    reason: status === 'PENDING'
      ? 'Sin flujo suficiente dentro del horizonte.'
      : status === 'PARTIAL'
        ? pendingAmount > 0
          ? 'Pago parcial por caja disponible; el remanente queda pendiente.'
          : 'Pago dividido para respetar caja mínima y prioridad.'
      : estimatedDate && estimatedDate > item.originalDate
        ? 'Recorrido por caja mínima; conserva prioridad por score.'
        : 'Pagado por prioridad de score.',
  };
}

function compareQueueItems(a: QueueItem, b: QueueItem): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.originalDate !== b.originalDate) return a.originalDate.localeCompare(b.originalDate);
  if (a.readyDate !== b.readyDate) return a.readyDate.localeCompare(b.readyDate);
  return a.remainingAmount - b.remainingAmount;
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
  if (status === 'PARTIAL') return 2;
  return 3;
}

function appendInstallment(
  map: Map<string, PaymentInstallment[]>,
  movementId: string,
  installment: PaymentInstallment,
): void {
  const current = map.get(movementId) ?? [];
  current.push(installment);
  map.set(movementId, current);
}

function scheduleManagedMovement(params: {
  movement: FinancialMovement;
  item?: QueueItem;
  installments: PaymentInstallment[];
  beyondRangeDate: string;
  scenarioId: string;
  startDate: string;
  endDate: string;
}): FinancialMovement[] {
  const {
    movement, item, installments, beyondRangeDate, scenarioId, startDate, endDate,
  } = params;
  if (!item) return [movement];

  const paidAmount = installments.reduce((sum, installment) => sum + installment.amount, 0);
  const pendingAmount = Math.max(0, item.totalAmount - paidAmount);
  if (installments.length === 0) {
    return [{
      ...movement,
      adjustedDate: beyondRangeDate,
      adjustedAmount: item.totalAmount,
      status: 'ADJUSTED',
      comments: [
        ...(movement.comments ?? []),
        `Pendiente por falta de flujo en ${scenarioId}; no se paga dentro de ${startDate}–${endDate}.`,
      ],
    }];
  }

  if (installments.length === 1 && pendingAmount <= 0) {
    const installment = installments[0];
    const deferred = installment.date > item.originalDate;
    return [{
      ...movement,
      adjustedDate: installment.date,
      adjustedAmount: installment.amount,
      status: deferred ? 'ADJUSTED' : movement.status,
      confidenceScore: Math.max(movement.confidenceScore, Math.min(100, item.score)),
      comments: [
        ...(movement.comments ?? []),
        deferred
          ? `Reprogramado por flujo en ${scenarioId}: ${item.originalDate} → ${installment.date}.`
          : `Pagado según score en ${scenarioId}.`,
      ],
    }];
  }

  const parts = installments.map((installment, index) => scaledMovementPart({
    movement,
    amount: installment.amount,
    date: installment.date,
    id: `${movement.id}:partial:${index + 1}`,
    conceptSuffix: `parcial ${index + 1}`,
    comment: `Parcialidad ${index + 1} programada por flujo en ${scenarioId}.`,
  }));
  if (pendingAmount > 0) {
    parts.push(scaledMovementPart({
      movement,
      amount: pendingAmount,
      date: beyondRangeDate,
      id: `${movement.id}:pending`,
      conceptSuffix: 'remanente pendiente',
      comment: `Remanente pendiente por falta de flujo dentro de ${startDate}–${endDate}.`,
    }));
  }
  return parts;
}

function scaledMovementPart(params: {
  movement: FinancialMovement;
  amount: number;
  date: string;
  id: string;
  conceptSuffix: string;
  comment: string;
}): FinancialMovement {
  const { movement, amount, date, id, conceptSuffix, comment } = params;
  const baseAmount = effectiveAmount(movement);
  const scale = baseAmount > 0 ? amount / baseAmount : 0;
  return {
    ...movement,
    id,
    sourceObjectId: movement.sourceObjectId ?? movement.id,
    concept: `${movement.concept} · ${conceptSuffix}`,
    originalAmount: amount,
    baseAmount: amount,
    projectedAmount: amount,
    adjustedAmount: amount,
    projectedDate: date,
    adjustedDate: date,
    taxBaseAmount: movement.taxBaseAmount == null ? undefined : movement.taxBaseAmount * scale,
    taxAmount: movement.taxAmount == null ? undefined : movement.taxAmount * scale,
    status: 'ADJUSTED',
    comments: [...(movement.comments ?? []), comment],
  };
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
