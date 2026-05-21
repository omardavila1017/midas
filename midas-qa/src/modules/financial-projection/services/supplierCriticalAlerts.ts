import type { CXPRecord } from '../../../domain/persistence';
import type { Provider } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import type { FinancialMovement, ManualPlanningEntry } from '../../shared-finance/types';
import { effectiveAmount } from '../../shared-finance/calculation-engine/financialProjectionEngine';

export type SupplierCriticalStatus =
  | 'PAID_REAL'
  | 'SCHEDULED'
  | 'MANUAL_COMMITTED'
  | 'PARTIAL'
  | 'PENDING'
  | 'OVERDUE';

export interface SupplierCriticalAlert {
  id: string;
  providerName: string;
  supplierNumber?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  dueDate?: string;
  pendingAmount: number;
  scheduledAmount: number;
  manualAmount: number;
  status: SupplierCriticalStatus;
  statusLabel: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  detail: string;
  movementIds: string[];
  manualEntryIds: string[];
  bankEvidenceCount: number;
}

export function buildSupplierCriticalAlerts(input: {
  providers: Provider[];
  cxpRecords: CXPRecord[];
  movements: FinancialMovement[];
  manualEntries: ManualPlanningEntry[];
  bankStatements: BankAccountStatement[];
  scenarioId: string;
  today: string;
}): SupplierCriticalAlert[] {
  const criticalProviderNames = new Set(
    input.providers
      .filter((provider) =>
        provider.risk === 'Alto'
        || provider.flexibility === 'inamovible'
        || provider.clasificacionAlberto === 'CRITICO',
      )
      .map((provider) => normalize(provider.name)),
  );
  const criticalSupplierNumbers = new Set(
    input.providers
      .filter((provider) =>
        provider.risk === 'Alto'
        || provider.flexibility === 'inamovible'
        || provider.clasificacionAlberto === 'CRITICO',
      )
      .map((provider) => provider.id ? normalize(provider.id) : '')
      .filter(Boolean),
  );

  return input.cxpRecords
    .filter((record) => record.importePendientePesos > 0)
    .filter((record) =>
      criticalProviderNames.has(normalize(record.nombre))
      || criticalSupplierNumbers.has(normalize(record.noProveedor)),
    )
    .map((record, index) => buildAlertForRecord(record, index, input))
    .sort((a, b) => {
      const severityDelta = severityWeight(b.severity) - severityWeight(a.severity);
      if (severityDelta !== 0) return severityDelta;
      return b.pendingAmount - a.pendingAmount;
    });
}

function buildAlertForRecord(
  record: CXPRecord,
  index: number,
  input: {
    movements: FinancialMovement[];
    manualEntries: ManualPlanningEntry[];
    bankStatements: BankAccountStatement[];
    scenarioId: string;
    today: string;
  },
): SupplierCriticalAlert {
  const scheduledMovements = input.movements.filter((movement) =>
    movement.category === 'AP_PAYMENT'
    && movement.type === 'OUTFLOW'
    && (
      normalize(movement.counterpartyName) === normalize(record.nombre)
      || normalize(movement.sourceObjectId).includes(normalize(record.noFactura))
      || normalize(movement.concept).includes(normalize(record.noFactura))
    ),
  );
  const manualEntries = input.manualEntries.filter((entry) =>
    entry.scenarioIds.includes(input.scenarioId)
    && entry.type === 'OUTFLOW'
    && entry.category === 'SUPPLIER_PAYMENT'
    && (
      normalize(entry.counterpartyName) === normalize(record.nombre)
      || normalize(entry.description).includes(normalize(record.noFactura))
      || normalize(entry.name).includes(normalize(record.noFactura))
    ),
  );
  const bankEvidenceCount = countBankEvidence(record, input.bankStatements);
  const scheduledAmount = scheduledMovements.reduce((sum, movement) => sum + effectiveAmount(movement), 0);
  const manualAmount = manualEntries.reduce((sum, entry) => sum + entry.amount, 0);
  const totalCovered = Math.max(scheduledAmount, scheduledAmount + manualAmount);
  const paidReal = bankEvidenceCount > 0 || record.edoPago.toUpperCase().includes('PAG');
  const dueDate = record.fechaProgramacionPago || record.fechaVence || record.fechaFactura;
  const overdue = dueDate ? dueDate < input.today : record.diasVencida > 0;

  const status: SupplierCriticalStatus = paidReal
    ? 'PAID_REAL'
    : manualAmount >= record.importePendientePesos
      ? 'MANUAL_COMMITTED'
      : scheduledAmount >= record.importePendientePesos
        ? 'SCHEDULED'
        : totalCovered > 0
          ? 'PARTIAL'
          : overdue
            ? 'OVERDUE'
            : 'PENDING';
  const severity = status === 'OVERDUE' || status === 'PENDING'
    ? 'CRITICAL'
    : status === 'PARTIAL'
      ? 'WARNING'
      : 'INFO';

  return {
    id: `supplier-alert:${record.cia}:${record.noProveedor}:${record.noFactura}:${index}`,
    providerName: record.nombre,
    supplierNumber: record.noProveedor || undefined,
    invoiceNumber: record.noFactura || undefined,
    invoiceDate: record.fechaFactura || undefined,
    dueDate: dueDate || undefined,
    pendingAmount: record.importePendientePesos,
    scheduledAmount,
    manualAmount,
    status,
    statusLabel: supplierCriticalStatusLabel(status),
    severity,
    detail: statusDetail(status, record, scheduledAmount, manualAmount, bankEvidenceCount),
    movementIds: scheduledMovements.map((movement) => movement.id),
    manualEntryIds: manualEntries.map((entry) => entry.id),
    bankEvidenceCount,
  };
}

export function supplierCriticalStatusLabel(status: SupplierCriticalStatus): string {
  switch (status) {
    case 'PAID_REAL': return 'Pagado real';
    case 'SCHEDULED': return 'Programado';
    case 'MANUAL_COMMITTED': return 'Comprometido manual';
    case 'PARTIAL': return 'Parcial';
    case 'PENDING': return 'Pendiente';
    case 'OVERDUE': return 'Vencido';
  }
}

function statusDetail(
  status: SupplierCriticalStatus,
  record: CXPRecord,
  scheduledAmount: number,
  manualAmount: number,
  bankEvidenceCount: number,
): string {
  if (status === 'PAID_REAL') return `Con evidencia real (${bankEvidenceCount || record.edoPago || 'JDE'}).`;
  if (status === 'SCHEDULED') return 'La corrida cubre el pendiente completo.';
  if (status === 'MANUAL_COMMITTED') return 'Tesorería capturó un pago manual suficiente en el escenario.';
  if (status === 'PARTIAL') return `Cubierto parcialmente: escenario ${scheduledAmount.toFixed(2)}, manual ${manualAmount.toFixed(2)}.`;
  if (status === 'OVERDUE') return `Factura vencida por ${record.diasVencida} días sin pago cubierto.`;
  return 'Proveedor crítico sin pago cubierto en el escenario.';
}

function countBankEvidence(record: CXPRecord, statements: BankAccountStatement[]): number {
  const provider = normalize(record.nombre);
  const invoice = normalize(record.noFactura);
  const amount = Math.abs(record.importePendientePesos || record.importeBrutoPesos || 0);
  let count = 0;
  for (const statement of statements) {
    for (const line of statement.movimientos ?? []) {
      if (line.tipoMovimiento !== 'CARGO') continue;
      const haystack = normalize(`${line.concepto ?? ''} ${line.referencia ?? ''}`);
      const textMatches = Boolean(provider && haystack.includes(provider)) || Boolean(invoice && haystack.includes(invoice));
      const bankAmount = Math.abs(line.importe ?? 0);
      const amountMatches = amount <= 0 || Math.abs(bankAmount - amount) <= Math.max(10, amount * 0.03);
      if (textMatches && amountMatches) count += 1;
    }
  }
  return count;
}

function severityWeight(severity: SupplierCriticalAlert['severity']): number {
  if (severity === 'CRITICAL') return 3;
  if (severity === 'WARNING') return 2;
  return 1;
}

function normalize(value: string | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}
