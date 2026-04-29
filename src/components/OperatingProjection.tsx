import { Fragment, useEffect, useMemo, useState } from 'react';
import type ExcelJS from 'exceljs';
import {
  AlertTriangle,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  Download,
  GripVertical,
  Plus,
  ShieldAlert,
  Table2,
  Trash2,
  Upload,
  Wallet,
} from 'lucide-react';
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Budget } from '../domain/budget';
import Sparkline from './Sparkline';
import {
  buildDefaultOperatingProjectionWindow,
  buildOperatingProjection,
  priorityBlockLabel,
  type ManualExpenseEvent,
  type OperatingAdjustment,
  type OperatingCollectionOverride,
  type OperatingFlowLine,
  type OperatingProjectionDay,
  type OperatingMandatoryReserveLine,
  type OperatingScheduledOutflowOverride,
  type OperatingSupplierPayment,
  type OperatingSupplierPaymentOverride,
  type OperatingSupplierQueueItem,
} from '../domain/operatingProjectionModule';
import {
  loadOperatingAdjustments,
  saveOperatingAdjustments,
  sortOperatingAdjustment,
} from '../domain/operatingProjectionManualAdjustments';
import {
  loadOperatingManualExpenseEvents,
  OPERATING_MANUAL_EVENT_CONCEPTS,
  saveOperatingManualExpenseEvents,
  sortManualExpenseEvent,
} from '../domain/operatingProjectionManualEvents';
import {
  createOperatingProjectionScenario,
  loadActiveOperatingScenarioId,
  loadOperatingProjectionScenarios,
  saveActiveOperatingScenarioId,
  saveOperatingProjectionScenarios,
  type OperatingProjectionScenario,
} from '../domain/operatingProjectionScenarios';
import {
  createOperatingTaxDebt,
  effectiveOutstanding,
  liquidateOperatingTaxDebtsByDueDate,
  plannedTotal,
  shiftOperatingTaxDebtPayments,
  splitOperatingTaxDebtsWeekly,
  suggestOperatingTaxDebtPlan,
  summarizeOperatingTaxDebts,
  taxDebtsToManualExpenseEvents,
  type OperatingTaxDebt,
  type OperatingTaxDebtSummary,
  type OperatingTaxLegalRisk,
  type OperatingTaxPlannedPayment,
  type OperatingTaxPriority,
  type OperatingTaxType,
} from '../domain/operatingProjectionTaxes';
import {
  computeMinimumOperatingExpense,
  loadMinimumExpenseOverrides,
  prorateMinimumExpense,
  resolveMinimumExpenseForMonth,
  saveMinimumExpenseOverrides,
  type MinimumExpenseOverride,
  type MinimumExpenseSummary,
} from '../domain/operatingProjectionMinimumExpense';
import type { CXPRecord } from '../domain/persistence';
import { type CashFlowAssumptions, type Client, type Provider } from '../domain/types';
import type { BankAccountStatement } from '../services/jde';
import { fmtCompact, fmtCurrency, fmtDate, fmtYearMonthLong } from '../formatters';

interface Props {
  companyCode: string;
  bankStatements: BankAccountStatement[];
  clients: Client[];
  providers: Provider[];
  cxpRecords: CXPRecord[];
  assumptions: CashFlowAssumptions;
  budget: Budget | null;
}

type DayDetailTab = 'ingresos' | 'egresos' | 'alertas';
type SheetGranularity = 'daily' | 'weekly' | 'monthly';
type SheetScope = 'month' | 'year';
type OperatingProjectionModuleId = 'overview' | 'cobranza' | 'suppliers' | 'taxes' | 'obligations' | 'projection' | 'adjustments';
type OperatingBlockId = 'cobranza' | 'suppliers' | 'taxes' | 'obligations' | 'adjustments' | 'projection';
type TaxModuleTab = 'summary' | 'debts' | 'plan';
type SupplierRiskFilter = 'all' | 'Alto' | 'Medio' | 'Bajo';
type SupplierFlexFilter = 'all' | 'inamovible' | 'revisar' | 'flexible' | 'unknown';
type SupplierBucket = 'CRITICO' | 'ALTO' | 'MEDIO' | 'BAJO';
type SupplierBucketFilter = 'all' | SupplierBucket;
type SupplierStatusFilter = 'all' | OperatingSupplierQueueItem['status'];
type SupplierCreditFilter = 'all' | OperatingSupplierQueueItem['creditStatus'];
type SupplierDateFilter = 'all' | 'day' | 'week' | 'month';
type PlanningLedgerType = 'collection' | 'supplier' | 'tax' | 'obligation' | 'adjustment' | 'fixed';
type PlanningLedgerStatus = 'projected' | 'confirmed' | 'paid' | 'overdue' | 'rescheduled' | 'partial' | 'unplanned';

interface ProjectionSheetRow {
  id: string;
  label: string;
  sublabel: string;
  startDate: string;
  endDate: string;
  days: OperatingProjectionDay[];
  openingCash: number;
  collections: number;
  otherInflows: number;
  adjustmentInflows: number;
  fixedOutflows: number;
  adjustmentOutflows: number;
  supplierPayments: number;
  net: number;
  mandatoryReserve: number;
  mandatoryReserveRequired: number;
  mandatoryReserveShortfall: number;
  freeCash: number;
  closingCash: number;
  alertCount: number;
}

interface SheetLine {
  id: string;
  title: string;
  subtitle: string;
  amount: number;
}

interface SheetGroup {
  id: string;
  label: string;
  amount: number;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  lines: SheetLine[];
  empty: string;
}

interface OperatingBlockCard {
  id: OperatingBlockId;
  label: string;
  description: string;
  total: number;
  delta: number;
  count: number;
  sparkline: number[];
  tone: 'success' | 'danger' | 'warning' | 'neutral';
  countLabel: string;
  scheduleHint?: string;
  scheduleSeed?: { kind: 'adjustment' | 'obligation'; direction?: 'inflow' | 'outflow' };
}

interface TreasuryActionItem {
  id: string;
  title: string;
  detail: string;
  module: OperatingProjectionModuleId;
  cta: string;
  severity: 'danger' | 'warning' | 'neutral';
  date?: string;
}

const SHEET_GRANULARITIES: Array<{ id: SheetGranularity; label: string }> = [
  { id: 'daily', label: 'Día' },
  { id: 'weekly', label: 'Semana' },
  { id: 'monthly', label: 'Mes' },
];

const SHEET_SCOPES: Array<{ id: SheetScope; label: string }> = [
  { id: 'month', label: 'Mes' },
  { id: 'year', label: 'Año' },
];

type ManualConcept = (typeof OPERATING_MANUAL_EVENT_CONCEPTS)[number];
const TAX_MANUAL_CONCEPT: ManualConcept = 'Impuestos';
const OBLIGATION_MANUAL_CONCEPTS: ManualConcept[] = ['Finiquitos', 'CAPEX', 'Pasivos Financieros'];

const SUPPLIER_PAYMENT_DRAG_TYPE = 'application/x-senda-supplier-payment';
const SHEET_ADJUSTMENT_CATEGORY = 'Ajuste rápido';
const SHEET_MANUAL_LABEL_PREFIX = 'Hoja editable';
const TAX_SHEET_MANUAL_LABEL_PREFIX = 'Hoja impuestos';
const OPERATING_USER_STORAGE_KEY = 'midas.operating.user.v1';
const MINIMUM_CASH_STORAGE_KEY = 'midas.operating.minimumCash.v1';

interface ManualEventRow {
  id: string;
  concept: (typeof OPERATING_MANUAL_EVENT_CONCEPTS)[number];
  date: string;
  amountInput: string;
  label: string;
  allowPartial: boolean;
}

interface MandatoryPaymentSheetRow {
  date: string;
  label: string;
  total: number;
}

interface TaxPaymentSheetRow {
  id: string;
  label: string;
  sublabel: string;
  startDate: string;
  endDate: string;
  effectiveDate: string;
  days: OperatingProjectionDay[];
  taxAmount: number;
  protectedTaxAmount: number;
  collections: number;
  operatingOutflows: number;
  supplierPayments: number;
  freeCash: number;
  closingCash: number;
  alertCount: number;
}

interface TaxPaymentRow {
  id: string;
  date: string;
  amountInput: string;
  note: string;
  suggested: boolean;
}

interface TaxDebtRow {
  id: string;
  fiscalYearInput: string;
  taxType: OperatingTaxType;
  label: string;
  originalAmountInput: string;
  paidAmountInput: string;
  outstandingAmountInput: string;
  dueDate: string;
  priority: OperatingTaxPriority;
  legalRisk: OperatingTaxLegalRisk;
  authority: string;
  fiscalPeriod: string;
  legalStatus: string;
  surchargeAmountInput: string;
  agreementId: string;
  comments: string;
  plannedPayments: TaxPaymentRow[];
}

interface SupplierQueueFilters {
  risk: SupplierRiskFilter;
  flexibility: SupplierFlexFilter;
  bucket: SupplierBucketFilter;
  status: SupplierStatusFilter;
  credit: SupplierCreditFilter;
  date: SupplierDateFilter;
}

interface ProjectionConfidence {
  score: number;
  label: string;
  detail: string;
}

interface ScenarioComparison {
  baseEndingCash: number;
  scenarioEndingCash: number;
  endingCashDelta: number;
  baseRiskDays: number;
  scenarioRiskDays: number;
  riskDaysDelta: number;
  baseLatePayments: number;
  scenarioLatePayments: number;
  latePaymentsDelta: number;
  baseRiskLabel: string;
  scenarioRiskLabel: string;
}

interface PlanningLedgerItem {
  id: string;
  type: PlanningLedgerType;
  sourceId: string;
  parentId?: string;
  originalDate: string;
  scheduledDate: string;
  entity: string;
  concept: string;
  category: string;
  originalAmount: number;
  adjustedAmount: number;
  status: PlanningLedgerStatus;
  priority: string;
  risk: string;
  flexibility: string;
  comment: string;
  origin: string;
  updatedAt: string;
  editableDate: boolean;
  editableAmount: boolean;
  supplier?: OperatingSupplierQueueItem;
  collectionLine?: OperatingFlowLine;
  outflowLine?: OperatingFlowLine;
}

interface PlanningLedgerCsvRow {
  id: string;
  scheduledDate?: string;
  adjustedAmount?: number;
  comment?: string;
  isAddition?: boolean;
  additionType?: PlanningLedgerType;
  additionDirection?: 'inflow' | 'outflow';
  additionEntity?: string;
  additionConcept?: string;
  additionCategory?: string;
}

interface PlanningLedgerImportChange {
  id: string;
  label: string;
  type: PlanningLedgerType;
  field: 'fecha' | 'monto' | 'comentario' | 'alta';
  before: string;
  after: string;
  severity: 'ok' | 'warning' | 'danger';
  message: string;
}

interface PlanningLedgerImportPreview {
  fileName: string;
  rows: PlanningLedgerCsvRow[];
  changes: PlanningLedgerImportChange[];
  ignored: number;
  errors: string[];
}

interface OperatingAuditEntry {
  id: string;
  at: string;
  user: string;
  scenarioId: string;
  action: string;
  reason: string;
  detail: string;
  impact: string;
}

interface MinimumCashPolicy {
  amountInput: string;
  scope: 'group' | 'company';
  updatedAt: string;
}

interface OperatingProjectionUser {
  name: string;
  role: string;
}

interface AdjustmentRow {
  id: string;
  date: string;
  direction: OperatingAdjustment['direction'];
  category: string;
  label: string;
  amountInput: string;
}

interface SupplierOverrideRow {
  id: string;
  invoiceKey: string;
  providerName: string;
  supplierNumber?: string;
  invoiceNumber?: string;
  date: string;
  amountInput: string;
  note: string;
}

interface CollectionOverrideRow {
  id: string;
  sourceKey: string;
  clientName: string;
  invoiceDate?: string;
  date: string;
  amountInput: string;
  note: string;
}

interface ScheduledOutflowOverrideRow {
  id: string;
  sourceKey: string;
  label: string;
  category: string;
  date: string;
  amountInput: string;
  note: string;
}

interface SupplierPaymentMoveImpact {
  providerName: string;
  invoiceNumber?: string;
  amount: number;
  fromDate: string;
  toDate: string;
  sourceClosingBefore: number;
  sourceFreeCashBefore: number;
  targetClosingBefore: number;
  targetFreeCashBefore: number;
}

interface SupplierPaymentDragPayload {
  invoiceKey: string;
  sourceDate: string;
}

interface OperatingScenarioUiState {
  scenarios: OperatingProjectionScenario[];
  activeScenarioId: string;
  manualRows: ManualEventRow[];
  adjustmentRows: AdjustmentRow[];
  supplierOverrideRows: SupplierOverrideRow[];
  collectionOverrideRows: CollectionOverrideRow[];
  scheduledOutflowOverrideRows: ScheduledOutflowOverrideRow[];
  taxDebtRows: TaxDebtRow[];
}

const T = {
  section: 'rounded-[20px] border border-[var(--border)] bg-white',
  muted: 'text-[var(--gray-400)]',
  title: 'text-[var(--gray-950)]',
} as const;

const TAXES_MOVED_TO_INDEPENDENT_MODULE = true;

const COLOR = {
  cash: '#0f172a',
  opening: '#94a3b8',
  inflow: '#16a34a',
  fixed: '#f59e0b',
  suppliers: '#dc2626',
  grid: '#f1f5f9',
  axis: '#e2e8f0',
  tickText: '#64748b',
  refLine: '#cbd5e1',
  warning: '#d97706',
} as const;

export default function OperatingProjection({
  companyCode,
  bankStatements,
  clients,
  providers,
  cxpRecords,
  assumptions,
  budget,
}: Props) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [scenarioUi, setScenarioUi] = useState<OperatingScenarioUiState>(loadInitialScenarioUiState);
  const [runVersion, setRunVersion] = useState(0);
  const {
    scenarios,
    activeScenarioId,
    manualRows,
    adjustmentRows,
    supplierOverrideRows,
    collectionOverrideRows,
    scheduledOutflowOverrideRows,
    taxDebtRows,
  } = scenarioUi;
  const activeScenario = useMemo(
    () => scenarios.find((scenario) => scenario.id === activeScenarioId) ?? scenarios[0],
    [activeScenarioId, scenarios],
  );
  const setAdjustmentRows = (updater: (current: AdjustmentRow[]) => AdjustmentRow[]) => {
    setScenarioUi((current) => {
      setUndoStack((history) => [cloneOperatingScenarioUiState(current), ...history].slice(0, 20));
      const editable = ensureEditableScenarioUiState(current);
      return syncActiveScenarioRows({
        ...editable,
        adjustmentRows: updater(editable.adjustmentRows),
      });
    });
  };
  const setManualRows = (updater: (current: ManualEventRow[]) => ManualEventRow[]) => {
    setScenarioUi((current) => {
      setUndoStack((history) => [cloneOperatingScenarioUiState(current), ...history].slice(0, 20));
      const editable = ensureEditableScenarioUiState(current);
      return syncActiveScenarioRows({
        ...editable,
        manualRows: updater(editable.manualRows),
      });
    });
  };
  const setSupplierOverrideRows = (updater: (current: SupplierOverrideRow[]) => SupplierOverrideRow[]) => {
    setScenarioUi((current) => {
      setUndoStack((history) => [cloneOperatingScenarioUiState(current), ...history].slice(0, 20));
      const editable = ensureEditableScenarioUiState(current);
      return syncActiveScenarioRows({
        ...editable,
        supplierOverrideRows: updater(editable.supplierOverrideRows),
      });
    });
  };
  const setCollectionOverrideRows = (updater: (current: CollectionOverrideRow[]) => CollectionOverrideRow[]) => {
    setScenarioUi((current) => {
      setUndoStack((history) => [cloneOperatingScenarioUiState(current), ...history].slice(0, 20));
      const editable = ensureEditableScenarioUiState(current);
      return syncActiveScenarioRows({
        ...editable,
        collectionOverrideRows: updater(editable.collectionOverrideRows),
      });
    });
  };
  const setScheduledOutflowOverrideRows = (updater: (current: ScheduledOutflowOverrideRow[]) => ScheduledOutflowOverrideRow[]) => {
    setScenarioUi((current) => {
      setUndoStack((history) => [cloneOperatingScenarioUiState(current), ...history].slice(0, 20));
      const editable = ensureEditableScenarioUiState(current);
      return syncActiveScenarioRows({
        ...editable,
        scheduledOutflowOverrideRows: updater(editable.scheduledOutflowOverrideRows),
      });
    });
  };
  const setTaxDebtRows = (updater: (current: TaxDebtRow[]) => TaxDebtRow[]) => {
    setScenarioUi((current) => {
      setUndoStack((history) => [cloneOperatingScenarioUiState(current), ...history].slice(0, 20));
      const editable = ensureEditableScenarioUiState(current);
      return syncActiveScenarioRows({
        ...editable,
        taxDebtRows: updater(editable.taxDebtRows),
      });
    });
  };
  const manualEvents = useMemo(
    () => manualRows
      .map(toManualExpenseEvent)
      .filter((value): value is ManualExpenseEvent => value !== null)
      .sort(sortManualExpenseEvent),
    [manualRows],
  );
  const operatingAdjustments = useMemo(
    () => adjustmentRows
      .map(toOperatingAdjustment)
      .filter((value): value is OperatingAdjustment => value !== null)
      .sort(sortOperatingAdjustment),
    [adjustmentRows],
  );
  const supplierPaymentOverrides = useMemo(
    () => supplierOverrideRows
      .map(toSupplierPaymentOverride)
      .filter((value): value is OperatingSupplierPaymentOverride => value !== null),
    [supplierOverrideRows],
  );
  const collectionOverrides = useMemo(
    () => collectionOverrideRows
      .map(toOperatingCollectionOverride)
      .filter((value): value is OperatingCollectionOverride => value !== null),
    [collectionOverrideRows],
  );
  const scheduledOutflowOverrides = useMemo(
    () => scheduledOutflowOverrideRows
      .map(toOperatingScheduledOutflowOverride)
      .filter((value): value is OperatingScheduledOutflowOverride => value !== null),
    [scheduledOutflowOverrideRows],
  );
  const taxDebts = useMemo(
    () => taxDebtRows
      .map(toOperatingTaxDebt)
      .filter((value): value is OperatingTaxDebt => value !== null),
    [taxDebtRows],
  );
  const taxDebtManualEvents = useMemo(
    () => taxDebtsToManualExpenseEvents(taxDebts),
    [taxDebts],
  );
  const projectionManualEvents = useMemo(
    () => [
      ...manualEvents,
      ...taxDebtManualEvents,
    ].sort(sortManualExpenseEvent),
    [manualEvents, taxDebtManualEvents],
  );
  const [undoStack, setUndoStack] = useState<OperatingScenarioUiState[]>([]);
  const [currentUser, setCurrentUser] = useState(loadOperatingProjectionUser);
  const [minimumCashPolicy, setMinimumCashPolicy] = useState<MinimumCashPolicy>(loadMinimumCashPolicy);

  useEffect(() => {
    saveOperatingManualExpenseEvents(manualEvents);
  }, [manualEvents]);
  useEffect(() => {
    saveOperatingProjectionScenarios(scenarios);
    saveActiveOperatingScenarioId(activeScenarioId);
    saveOperatingAdjustments(operatingAdjustments);
  }, [activeScenarioId, operatingAdjustments, scenarios]);
  useEffect(() => {
    saveOperatingProjectionUser(currentUser);
  }, [currentUser]);
  useEffect(() => {
    saveMinimumCashPolicy(minimumCashPolicy);
  }, [minimumCashPolicy]);

  const projection = useMemo(() => {
    const window = buildDefaultOperatingProjectionWindow(today, budget);
    return buildOperatingProjection({
      startDate: window.startDate,
      endDate: window.endDate,
      bankStatements,
      clients,
      providers,
      agedBalances: cxpRecords,
      assumptions,
      budget,
      manualExpenseEvents: projectionManualEvents,
      operatingAdjustments,
      supplierPaymentOverrides,
      collectionOverrides,
      scheduledOutflowOverrides,
    });
  }, [assumptions, bankStatements, budget, clients, collectionOverrides, cxpRecords, operatingAdjustments, projectionManualEvents, providers, runVersion, scheduledOutflowOverrides, supplierPaymentOverrides, today]);
  const baseProjection = useMemo(() => {
    const baseScenario = scenarios.find((scenario) => scenario.id === 'base') ?? scenarios[0];
    const window = buildDefaultOperatingProjectionWindow(today, budget);
    const baseManualEvents = [
      ...(baseScenario?.manualExpenseEvents ?? []),
      ...taxDebtsToManualExpenseEvents(baseScenario?.taxDebts ?? []),
    ].sort(sortManualExpenseEvent);
    return buildOperatingProjection({
      startDate: window.startDate,
      endDate: window.endDate,
      bankStatements,
      clients,
      providers,
      agedBalances: cxpRecords,
      assumptions,
      budget,
      manualExpenseEvents: baseManualEvents,
      operatingAdjustments: baseScenario?.operatingAdjustments ?? [],
      supplierPaymentOverrides: baseScenario?.supplierPaymentOverrides ?? [],
      collectionOverrides: baseScenario?.collectionOverrides ?? [],
      scheduledOutflowOverrides: baseScenario?.scheduledOutflowOverrides ?? [],
    });
  }, [assumptions, bankStatements, budget, clients, cxpRecords, providers, scenarios, today]);

  const [selectedMonth, setSelectedMonth] = useState<string>(() => {
    const todayMonth = today.slice(0, 7);
    return projection.months.find((month) => month.yearMonth === todayMonth)?.yearMonth
      ?? projection.months[0]?.yearMonth
      ?? todayMonth;
  });
  const [expandedBlocks, setExpandedBlocks] = useState<Set<OperatingBlockId>>(() => new Set<OperatingBlockId>(['suppliers']));
  const toggleExpandedBlock = (id: OperatingBlockId) => {
    setExpandedBlocks((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const expandBlock = (id: OperatingBlockId) => {
    setExpandedBlocks((current) => {
      if (current.has(id)) return current;
      const next = new Set(current);
      next.add(id);
      return next;
    });
  };
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DayDetailTab>('ingresos');
  const [sheetScope, setSheetScope] = useState<SheetScope>('month');
  const [sheetGranularity, setSheetGranularity] = useState<SheetGranularity>('daily');
  const [planningGranularity, setPlanningGranularity] = useState<SheetGranularity>('daily');
  const [taxSheetScope, setTaxSheetScope] = useState<SheetScope>('year');
  const [taxSheetGranularity, setTaxSheetGranularity] = useState<SheetGranularity>('monthly');
  const [taxModuleTab, setTaxModuleTab] = useState<TaxModuleTab>('summary');
  const [supplierRiskFilter, setSupplierRiskFilter] = useState<SupplierRiskFilter>('all');
  const [supplierFlexFilter, setSupplierFlexFilter] = useState<SupplierFlexFilter>('all');
  const [supplierBucketFilter, setSupplierBucketFilter] = useState<SupplierBucketFilter>('all');
  const [supplierStatusFilter, setSupplierStatusFilter] = useState<SupplierStatusFilter>('all');
  const [supplierCreditFilter, setSupplierCreditFilter] = useState<SupplierCreditFilter>('all');
  const [supplierDateFilter, setSupplierDateFilter] = useState<SupplierDateFilter>('all');
  const [expandedSheetRows, setExpandedSheetRows] = useState<Set<string>>(() => new Set());
  const [lastSupplierMove, setLastSupplierMove] = useState<SupplierPaymentMoveImpact | null>(null);
  const [selectedLedgerItemId, setSelectedLedgerItemId] = useState<string | null>(null);
  const [ledgerImportStatus, setLedgerImportStatus] = useState<string | null>(null);
  const [ledgerImportPreview, setLedgerImportPreview] = useState<PlanningLedgerImportPreview | null>(null);
  const [ledgerSearch, setLedgerSearch] = useState('');
  const [ledgerTypeFilter, setLedgerTypeFilter] = useState<'all' | PlanningLedgerType>('all');
  const [ledgerStatusFilter, setLedgerStatusFilter] = useState<'all' | PlanningLedgerStatus>('all');
  const [ledgerRiskFilter, setLedgerRiskFilter] = useState<'all' | 'Alto' | 'Medio' | 'Bajo'>('all');
  const [ledgerEditableOnly, setLedgerEditableOnly] = useState(false);
  const [selectedLedgerIds, setSelectedLedgerIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!projection.months.some((month) => month.yearMonth === selectedMonth)) {
      setSelectedMonth(projection.months[0]?.yearMonth ?? today.slice(0, 7));
    }
  }, [projection.months, selectedMonth, today]);

  // ─── Gasto mínimo de operación (piso amarillo) ─────────────────────────
  const minimumExpenseSummary = useMemo<MinimumExpenseSummary>(
    () => computeMinimumOperatingExpense(providers),
    [providers],
  );
  const [minimumExpenseOverrides, setMinimumExpenseOverrides] = useState<MinimumExpenseOverride[]>(
    () => loadMinimumExpenseOverrides(),
  );
  useEffect(() => {
    saveMinimumExpenseOverrides(minimumExpenseOverrides);
  }, [minimumExpenseOverrides]);
  const [showMinimumExpenseDetail, setShowMinimumExpenseDetail] = useState(false);
  const [editingOverrideMonth, setEditingOverrideMonth] = useState<string | null>(null);
  const [overrideDraftAmount, setOverrideDraftAmount] = useState('');
  const [overrideDraftNote, setOverrideDraftNote] = useState('');

  const monthDays = useMemo(
    () => projection.days.filter((day) => day.date.slice(0, 7) === selectedMonth),
    [projection.days, selectedMonth],
  );

  useEffect(() => {
    if (monthDays.length === 0) {
      setSelectedDay(null);
      return;
    }
    if (selectedDay && monthDays.some((day) => day.date === selectedDay)) return;
    const firstRelevantDay = monthDays.find((day) =>
      day.cashInflows.length > 0
      || day.scheduledOutflows.length > 0
      || day.supplierPayments.length > 0
      || day.alerts.length > 0,
    );
    setSelectedDay(firstRelevantDay?.date ?? monthDays[0].date);
  }, [monthDays, selectedDay]);

  const selectedDayData = useMemo(
    () => monthDays.find((day) => day.date === selectedDay) ?? monthDays[0] ?? null,
    [monthDays, selectedDay],
  );

  const selectedMonthData = useMemo(
    () => projection.months.find((month) => month.yearMonth === selectedMonth) ?? null,
    [projection.months, selectedMonth],
  );

  const planningTimelineDays = useMemo(
    () => (planningGranularity === 'monthly' ? projection.days : monthDays),
    [monthDays, planningGranularity, projection.days],
  );
  const planningTimelineRows = useMemo(
    () => buildProjectionSheetRows(planningTimelineDays, planningGranularity),
    [planningGranularity, planningTimelineDays],
  );
  const timelineData = useMemo(
    () => planningTimelineRows.map((row) => {
      const inflows = row.collections + row.otherInflows + row.adjustmentInflows;
      const totalOutflows = row.fixedOutflows + row.supplierPayments + row.adjustmentOutflows;
      const configuredMinimumCash = Number(minimumCashPolicy.amountInput);
      const minimumCash = Math.max(
        row.mandatoryReserveRequired,
        Number.isFinite(configuredMinimumCash) && configuredMinimumCash > 0 ? configuredMinimumCash : 0,
      );
      // Piso operativo prorrateado para esta fila
      const rowYearMonth = row.startDate.slice(0, 7);
      const monthBase = resolveMinimumExpenseForMonth(
        rowYearMonth,
        minimumExpenseSummary.totalMonthly,
        minimumExpenseOverrides,
      );
      const proratedMinimum = prorateMinimumExpense(
        monthBase.amount,
        row.startDate,
        row.endDate,
      );
      return {
        date: row.startDate,
        label: row.label,
        displayDate: row.label,
        openingCash: row.openingCash,
        closingCash: row.closingCash,
        freeCash: row.freeCash,
        mandatoryReserve: row.mandatoryReserve,
        mandatoryReserveRequired: minimumCash,
        projectedCollections: row.collections,
        otherInflows: row.otherInflows + row.adjustmentInflows,
        inflows,
        fixedNegative: -row.fixedOutflows,
        supplierNegative: -row.supplierPayments,
        adjustmentNegative: -row.adjustmentOutflows,
        totalOutflowsNegative: -totalOutflows,
        // Piso operativo (en negativo para que aparezca en la zona de egresos)
        gastoMinimoOperativo: -proratedMinimum,
        gastoMinimoOperativoAbs: proratedMinimum,
        net: inflows - totalOutflows,
        collectionCount: row.days.reduce((sum, day) => sum + collectionLines(day).length, 0),
        paymentCount: row.days.reduce((sum, day) => sum + day.supplierPayments.length, 0),
        fixedCount: row.days.reduce((sum, day) => sum + day.scheduledOutflows.length, 0),
        alertCount: row.alertCount,
      };
    }),
    [minimumCashPolicy.amountInput, minimumExpenseOverrides, minimumExpenseSummary.totalMonthly, planningTimelineRows],
  );

  const upcomingPayments = useMemo(() => {
    return projection.days
      .flatMap((day) => day.supplierPayments.map((payment) => ({ date: day.date, payment })))
      .filter((entry) => entry.date >= today)
      .slice(0, 10);
  }, [projection.days, today]);

  const upcomingCollections = useMemo(() => {
    return projection.days
      .flatMap((day) => collectionLines(day).map((line) => ({ date: day.date, line })))
      .filter((entry) => entry.date >= today)
      .slice(0, 10);
  }, [projection.days, today]);

  const topMonthAlerts = useMemo(
    () => monthDays.flatMap((day) => day.alerts.map((alert) => ({ date: day.date, alert }))).slice(0, 10),
    [monthDays],
  );
  const projectionSheetDays = useMemo(
    () => (sheetScope === 'year' ? projection.days : monthDays),
    [monthDays, projection.days, sheetScope],
  );
  const sheetRows = useMemo(
    () => buildProjectionSheetRows(projectionSheetDays, sheetGranularity),
    [projectionSheetDays, sheetGranularity],
  );
  const sheetSummary = useMemo(() => summarizeSheetRows(sheetRows), [sheetRows]);
  useEffect(() => {
    setExpandedSheetRows(new Set());
  }, [selectedMonth, sheetGranularity, sheetScope]);
  const taxSheetDays = useMemo(
    () => (taxSheetScope === 'year' ? projection.days : monthDays),
    [monthDays, projection.days, taxSheetScope],
  );
  const taxSheetRows = useMemo(
    () => buildTaxPaymentSheetRows(taxSheetDays, manualRows, taxSheetGranularity),
    [manualRows, taxSheetDays, taxSheetGranularity],
  );
  const taxSheetSummary = useMemo(() => summarizeTaxSheetRows(taxSheetRows), [taxSheetRows]);
  const taxDebtSummary = useMemo(
    () => summarizeOperatingTaxDebts(taxDebts, selectedMonth, today),
    [selectedMonth, taxDebts, today],
  );
  const taxRows = useMemo(
    () => sortManualRows(
      manualRows.filter((row) => row.concept === TAX_MANUAL_CONCEPT),
    ),
    [manualRows],
  );
  const monthObligationRows = useMemo(
    () => sortManualRows(
      manualRows.filter((row) => row.date.startsWith(selectedMonth) && row.concept !== TAX_MANUAL_CONCEPT),
    ),
    [manualRows, selectedMonth],
  );
  const monthObligationEvents = useMemo(
    () => monthObligationRows
      .map(toManualExpenseEvent)
      .filter((value): value is ManualExpenseEvent => value !== null),
    [monthObligationRows],
  );
  const monthObligationTotal = useMemo(
    () => monthObligationEvents.reduce((sum, event) => sum + event.amount, 0),
    [monthObligationEvents],
  );
  const monthObligationTotalsByConcept = useMemo(
    () => OBLIGATION_MANUAL_CONCEPTS
      .map((concept) => ({
        concept,
        total: monthObligationEvents
          .filter((event) => event.concept === concept)
          .reduce((sum, event) => sum + event.amount, 0),
      }))
      .filter((entry) => entry.total > 0),
    [monthObligationEvents],
  );
  const mandatoryPaymentSheetRows = useMemo(
    () => buildMandatoryPaymentSheetRows(monthDays, manualRows, selectedMonth),
    [manualRows, monthDays, selectedMonth],
  );
  const monthAdjustmentRows = useMemo(
    () => sortAdjustmentRows(
      adjustmentRows.filter((row) => row.date.startsWith(selectedMonth)),
    ),
    [adjustmentRows, selectedMonth],
  );
  const monthAdjustments = useMemo(
    () => monthAdjustmentRows
      .map(toOperatingAdjustment)
      .filter((value): value is OperatingAdjustment => value !== null),
    [monthAdjustmentRows],
  );
  const monthAdjustmentInflows = useMemo(
    () => monthAdjustments
      .filter((adjustment) => adjustment.direction === 'inflow')
      .reduce((sum, adjustment) => sum + adjustment.amount, 0),
    [monthAdjustments],
  );
  const monthAdjustmentOutflows = useMemo(
    () => monthAdjustments
      .filter((adjustment) => adjustment.direction === 'outflow')
      .reduce((sum, adjustment) => sum + adjustment.amount, 0),
    [monthAdjustments],
  );

  const monthSupplierTotal = monthDays.reduce((sum, day) => sum + sumAmounts(day.supplierPayments), 0);
  const bucketByProviderId = useMemo(() => {
    const map = new Map<string, SupplierBucket>();
    providers.forEach((p) => {
      if (p.clasificacionAutomatica) map.set(p.id, p.clasificacionAutomatica);
    });
    return map;
  }, [providers]);
  const supplierQueueRows = useMemo(
    () => filterSupplierQueueRows(
      projection.supplierQueue,
      {
        risk: supplierRiskFilter,
        flexibility: supplierFlexFilter,
        bucket: supplierBucketFilter,
        status: supplierStatusFilter,
        credit: supplierCreditFilter,
        date: supplierDateFilter,
      },
      selectedDayData?.date ?? `${selectedMonth}-01`,
      selectedMonth,
      bucketByProviderId,
    ),
    [
      bucketByProviderId,
      projection.supplierQueue,
      selectedDayData?.date,
      selectedMonth,
      supplierBucketFilter,
      supplierCreditFilter,
      supplierDateFilter,
      supplierFlexFilter,
      supplierRiskFilter,
      supplierStatusFilter,
    ],
  );
  const projectionConfidence = useMemo(
    () => calculateProjectionConfidence(projection, taxDebtSummary),
    [projection, taxDebtSummary],
  );
  const manualMinimumCash = useMemo(() => {
    const amount = Number(minimumCashPolicy.amountInput);
    return Number.isFinite(amount) && amount > 0 ? amount : 0;
  }, [minimumCashPolicy.amountInput]);
  const scenarioComparison = useMemo(
    () => compareProjectionScenarios(baseProjection, projection, selectedMonth, manualMinimumCash),
    [baseProjection, manualMinimumCash, projection, selectedMonth],
  );
  const monthFixedTotal = monthDays.reduce((sum, day) => sum + sumAmounts(day.scheduledOutflows), 0);
  const monthCollectionsTotal = monthDays.reduce((sum, day) => sum + sumAmounts(collectionLines(day)), 0);
  const worstDay = monthDays.reduce<OperatingProjectionDay | null>((worst, day) => {
    if (!worst || day.closingCash < worst.closingCash) return day;
    return worst;
  }, null);
  const dayCollections = selectedDayData ? collectionLines(selectedDayData) : [];
  const selectedOtherInflows = selectedDayData
    ? selectedDayData.cashInflows.filter((line) => line.source !== 'collections')
    : [];
  const selectedDaySheetRow = useMemo(
    () => selectedDayData
      ? sheetRowFromDays(`chart-day:${selectedDayData.date}`, fmtDate(selectedDayData.date), weekdayLabel(selectedDayData.date), [selectedDayData])
      : null,
    [selectedDayData],
  );
  const planningLedgerRows = useMemo(
    () => buildPlanningLedgerRows({
      monthDays,
      supplierQueue: projection.supplierQueue,
      supplierOverrides: supplierOverrideRows,
      collectionOverrides: collectionOverrideRows,
      scheduledOutflowOverrides: scheduledOutflowOverrideRows,
      taxDebtRows,
      manualRows,
      adjustmentRows,
      selectedMonth,
      scenarioUpdatedAt: activeScenario?.updatedAt ?? today,
    }),
    [
      activeScenario?.updatedAt,
      adjustmentRows,
      collectionOverrideRows,
      manualRows,
      monthDays,
      projection.supplierQueue,
      scheduledOutflowOverrideRows,
      selectedMonth,
      supplierOverrideRows,
      taxDebtRows,
      today,
    ],
  );
  const filteredPlanningLedgerRows = useMemo(
    () => filterPlanningLedgerRows(planningLedgerRows, {
      search: ledgerSearch,
      type: ledgerTypeFilter,
      status: ledgerStatusFilter,
      risk: ledgerRiskFilter,
      editableOnly: ledgerEditableOnly,
    }),
    [ledgerEditableOnly, ledgerRiskFilter, ledgerSearch, ledgerStatusFilter, ledgerTypeFilter, planningLedgerRows],
  );
  const selectedLedgerItem = useMemo(
    () => planningLedgerRows.find((row) => row.id === selectedLedgerItemId) ?? planningLedgerRows[0] ?? null,
    [planningLedgerRows, selectedLedgerItemId],
  );
  const toggleSheetRow = (row: ProjectionSheetRow) => {
    if (sheetGranularity === 'daily') {
      setSelectedDay(row.startDate);
      setSelectedMonth(row.startDate.slice(0, 7));
    } else if (sheetGranularity === 'weekly') {
      setSelectedDay(row.startDate);
      setSelectedMonth(row.startDate.slice(0, 7));
    } else if (sheetGranularity === 'monthly') {
      setSelectedMonth(row.startDate.slice(0, 7));
    }
    setExpandedSheetRows((current) => {
      const next = new Set(current);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
  };
  const addAdjustmentRow = (date = selectedDayData?.date ?? `${selectedMonth}-01`) => {
    setAdjustmentRows((current) => sortAdjustmentRows([
      ...current,
      createAdjustmentRow(date),
    ]));
  };
  const activateScenario = (scenarioId: string) => {
    setScenarioUi((current) => {
      const nextActive = current.scenarios.find((scenario) => scenario.id === scenarioId) ?? current.scenarios[0];
      return {
        ...current,
        activeScenarioId: nextActive.id,
        manualRows: nextActive.manualExpenseEvents.map(rowFromManualEvent),
        adjustmentRows: nextActive.operatingAdjustments.map(rowFromOperatingAdjustment),
        supplierOverrideRows: nextActive.supplierPaymentOverrides.map(rowFromSupplierPaymentOverride),
        collectionOverrideRows: nextActive.collectionOverrides.map(rowFromOperatingCollectionOverride),
        scheduledOutflowOverrideRows: nextActive.scheduledOutflowOverrides.map(rowFromOperatingScheduledOutflowOverride),
        taxDebtRows: nextActive.taxDebts.map(rowFromOperatingTaxDebt),
      };
    });
  };
  const renameScenario = (name: string) => {
    setScenarioUi((current) => ({
      ...current,
      scenarios: current.scenarios.map((scenario) => (
        scenario.id === current.activeScenarioId
          ? { ...scenario, name: name.trim() || 'Escenario sin nombre', updatedAt: new Date().toISOString() }
          : scenario
      )),
    }));
  };
  const addScenario = () => {
    setScenarioUi((current) => {
      const scenario = createOperatingProjectionScenario(`Escenario ${current.scenarios.length + 1}`);
      return {
        scenarios: [...current.scenarios, scenario],
        activeScenarioId: scenario.id,
        manualRows: [],
        adjustmentRows: [],
        supplierOverrideRows: [],
        collectionOverrideRows: [],
        scheduledOutflowOverrideRows: [],
        taxDebtRows: [],
      };
    });
  };
  const duplicateScenario = () => {
    setScenarioUi((current) => {
      const active = current.scenarios.find((scenario) => scenario.id === current.activeScenarioId) ?? current.scenarios[0];
      const scenario = createOperatingProjectionScenario(`${active.name} copia`, {
        manualExpenseEvents: manualEvents,
        operatingAdjustments: operatingAdjustments,
        supplierPaymentOverrides,
        collectionOverrides,
        scheduledOutflowOverrides,
        taxDebts,
      });
      return {
        scenarios: [...current.scenarios, scenario],
        activeScenarioId: scenario.id,
        manualRows: scenario.manualExpenseEvents.map(rowFromManualEvent),
        adjustmentRows: scenario.operatingAdjustments.map(rowFromOperatingAdjustment),
        supplierOverrideRows: scenario.supplierPaymentOverrides.map(rowFromSupplierPaymentOverride),
        collectionOverrideRows: scenario.collectionOverrides.map(rowFromOperatingCollectionOverride),
        scheduledOutflowOverrideRows: scenario.scheduledOutflowOverrides.map(rowFromOperatingScheduledOutflowOverride),
        taxDebtRows: scenario.taxDebts.map(rowFromOperatingTaxDebt),
      };
    });
  };
  const deleteScenario = () => {
    setScenarioUi((current) => {
      if (current.scenarios.length <= 1) return current;
      const remaining = current.scenarios.filter((scenario) => scenario.id !== current.activeScenarioId);
      const nextActive = remaining[0];
      return {
        scenarios: remaining,
        activeScenarioId: nextActive.id,
        manualRows: nextActive.manualExpenseEvents.map(rowFromManualEvent),
        adjustmentRows: nextActive.operatingAdjustments.map(rowFromOperatingAdjustment),
        supplierOverrideRows: nextActive.supplierPaymentOverrides.map(rowFromSupplierPaymentOverride),
        collectionOverrideRows: nextActive.collectionOverrides.map(rowFromOperatingCollectionOverride),
        scheduledOutflowOverrideRows: nextActive.scheduledOutflowOverrides.map(rowFromOperatingScheduledOutflowOverride),
        taxDebtRows: nextActive.taxDebts.map(rowFromOperatingTaxDebt),
      };
    });
  };
  const updateSupplierOverride = (payment: OperatingSupplierPayment, patch: Partial<SupplierOverrideRow>, fallbackDate: string) => {
    setSupplierOverrideRows((current) => upsertSupplierOverrideRow(current, payment, patch, fallbackDate));
  };
  const removeSupplierOverride = (invoiceKey: string) => {
    setSupplierOverrideRows((current) => current.filter((row) => row.invoiceKey !== invoiceKey));
  };
  const updateCollectionOverride = (line: OperatingFlowLine, patch: Partial<CollectionOverrideRow>, fallbackDate: string) => {
    setCollectionOverrideRows((current) => upsertCollectionOverrideRow(current, line, patch, fallbackDate));
  };
  const removeCollectionOverride = (sourceKey: string) => {
    setCollectionOverrideRows((current) => current.filter((row) => row.sourceKey !== sourceKey));
  };
  const updateScheduledOutflowOverride = (line: OperatingFlowLine, patch: Partial<ScheduledOutflowOverrideRow>, fallbackDate: string) => {
    setScheduledOutflowOverrideRows((current) => upsertScheduledOutflowOverrideRow(current, line, patch, fallbackDate));
  };
  const removeScheduledOutflowOverride = (sourceKey: string) => {
    setScheduledOutflowOverrideRows((current) => current.filter((row) => row.sourceKey !== sourceKey));
  };
  const moveSupplierPaymentByKey = (invoiceKey: string, fromDate: string, toDate: string) => {
    if (fromDate === toDate) return;
    const sourceDay = projection.days.find((day) => day.date === fromDate);
    const targetDay = projection.days.find((day) => day.date === toDate);
    const payment = sourceDay?.supplierPayments.find((entry) => entry.invoiceKey === invoiceKey);
    if (!sourceDay || !targetDay || !payment) return;

    const currentOverride = supplierOverrideRows.find((row) => row.invoiceKey === invoiceKey);
    const overrideAmountInput = currentOverride?.amountInput ?? editableAmount(payment.amount);
    const overrideAmount = Number(overrideAmountInput);
    updateSupplierOverride(payment, {
      date: toDate,
      amountInput: overrideAmountInput,
      note: currentOverride?.note || `Movido desde ${fmtDate(fromDate)}`,
    }, fromDate);
    setSelectedDay(toDate);
    setDetailTab('egresos');
    setLastSupplierMove({
      providerName: payment.providerName,
      invoiceNumber: payment.invoiceNumber,
      amount: Number.isFinite(overrideAmount) ? overrideAmount : payment.amount,
      fromDate,
      toDate,
      sourceClosingBefore: sourceDay.closingCash,
      sourceFreeCashBefore: sourceDay.freeCash,
      targetClosingBefore: targetDay.closingCash,
      targetFreeCashBefore: targetDay.freeCash,
    });
  };
  const updateSupplierQueueOverride = (item: OperatingSupplierQueueItem, patch: Partial<SupplierOverrideRow>) => {
    setSupplierOverrideRows((current) => upsertSupplierOverrideFromQueueItem(
      current,
      item,
      patch,
      selectedDayData?.date ?? item.plannedDate ?? item.dueDate ?? `${selectedMonth}-01`,
    ));
  };
  const moveSupplierQueueItemByDays = (item: OperatingSupplierQueueItem, days: number) => {
    const baseDate = supplierOverrideRows.find((row) => row.invoiceKey === item.invoiceKey)?.date
      ?? item.plannedDate
      ?? item.dueDate
      ?? selectedDayData?.date
      ?? `${selectedMonth}-01`;
    updateSupplierQueueOverride(item, {
      date: shiftBusinessDate(baseDate, days),
      note: days > 0 ? `Movido ${days} días desde cola priorizada` : 'Ajuste desde cola priorizada',
    });
  };
  const removeSupplierQueueOverride = (invoiceKey: string) => {
    setSupplierOverrideRows((current) => current.filter((row) => row.invoiceKey !== invoiceKey));
  };
  const splitSupplierQueueItem = (item: OperatingSupplierQueueItem, weights: number[] = [0.4, 0.3, 0.3]) => {
    const baseDate = supplierOverrideRows.find((row) => row.invoiceKey === item.invoiceKey)?.date
      ?? item.plannedDate
      ?? item.dueDate
      ?? selectedDayData?.date
      ?? `${selectedMonth}-01`;
    const amount = Math.max(0, item.remainingAmount || item.plannedAmount || item.invoiceAmount);
    if (amount <= 0) return;
    setSupplierOverrideRows((current) => splitSupplierOverrideRows(current, item, baseDate, amount, weights));
  };
  const updatePlanningLedgerItem = (item: PlanningLedgerItem, patch: { date?: string; amountInput?: string; comment?: string }) => {
    const detail = planningLedgerPatchDetail(item, patch);
    const impact = planningLedgerPatchImpact(item, patch, projection, manualMinimumCash);
    if (item.type === 'supplier' && item.supplier) {
      const supplierPatch: Partial<SupplierOverrideRow> = {};
      if (patch.date !== undefined) supplierPatch.date = patch.date;
      if (patch.amountInput !== undefined) supplierPatch.amountInput = patch.amountInput;
      if (patch.comment !== undefined) supplierPatch.note = patch.comment;
      updateSupplierQueueOverride(item.supplier, supplierPatch);
      appendAuditEntry({
        action: 'Edición de proveedor',
        reason: patch.comment || 'Cambio manual desde tabla inteligente',
        detail,
        impact,
      });
      return;
    }
    if (item.type === 'collection' && item.collectionLine) {
      const collectionPatch: Partial<CollectionOverrideRow> = {};
      if (patch.date !== undefined) collectionPatch.date = patch.date;
      if (patch.amountInput !== undefined) collectionPatch.amountInput = patch.amountInput;
      if (patch.comment !== undefined) collectionPatch.note = patch.comment;
      updateCollectionOverride(item.collectionLine, collectionPatch, item.scheduledDate);
      appendAuditEntry({
        action: 'Edición de ingreso',
        reason: patch.comment || 'Cambio manual de cobranza desde tabla inteligente',
        detail,
        impact,
      });
      return;
    }
    if (item.type === 'fixed' && item.outflowLine) {
      const outflowPatch: Partial<ScheduledOutflowOverrideRow> = {};
      if (patch.date !== undefined) outflowPatch.date = patch.date;
      if (patch.amountInput !== undefined) outflowPatch.amountInput = patch.amountInput;
      if (patch.comment !== undefined) outflowPatch.note = patch.comment;
      updateScheduledOutflowOverride(item.outflowLine, outflowPatch, item.scheduledDate);
      appendAuditEntry({
        action: 'Edición de egreso fijo',
        reason: patch.comment || 'Cambio manual de egreso desde tabla inteligente',
        detail,
        impact,
      });
      return;
    }
    if (item.type === 'tax' && item.parentId) {
      const taxPatch: Partial<TaxPaymentRow> = {};
      if (patch.date !== undefined) taxPatch.date = patch.date;
      if (patch.amountInput !== undefined) taxPatch.amountInput = patch.amountInput;
      if (patch.comment !== undefined) taxPatch.note = patch.comment;
      setTaxDebtRows((current) => updateTaxPaymentRow(current, item.parentId!, item.sourceId, taxPatch));
      appendAuditEntry({
        action: 'Edición fiscal',
        reason: patch.comment || 'Cambio manual del plan fiscal',
        detail,
        impact,
      });
      return;
    }
    if (item.type === 'obligation') {
      const manualPatch: Partial<ManualEventRow> = {};
      if (patch.date !== undefined) manualPatch.date = patch.date;
      if (patch.amountInput !== undefined) manualPatch.amountInput = patch.amountInput;
      if (patch.comment !== undefined) manualPatch.label = patch.comment;
      updateManualRow(setManualRows, item.sourceId, manualPatch);
      appendAuditEntry({
        action: 'Edición de obligación',
        reason: patch.comment || 'Cambio manual de obligación',
        detail,
        impact,
      });
      return;
    }
    if (item.type === 'adjustment') {
      const adjustmentPatch: Partial<AdjustmentRow> = {};
      if (patch.date !== undefined) adjustmentPatch.date = patch.date;
      if (patch.amountInput !== undefined) adjustmentPatch.amountInput = patch.amountInput;
      if (patch.comment !== undefined) adjustmentPatch.label = patch.comment;
      updateAdjustmentRow(setAdjustmentRows, item.sourceId, adjustmentPatch);
      appendAuditEntry({
        action: 'Edición de ajuste',
        reason: patch.comment || 'Cambio manual de ajuste',
        detail,
        impact,
      });
    }
  };
  const fullPlanningLedgerRows = useMemo(
    () => buildPlanningLedgerRows({
      monthDays: projection.days,
      supplierQueue: projection.supplierQueue,
      supplierOverrides: supplierOverrideRows,
      collectionOverrides: collectionOverrideRows,
      scheduledOutflowOverrides: scheduledOutflowOverrideRows,
      taxDebtRows,
      manualRows,
      adjustmentRows,
      selectedMonth: '',
      scenarioUpdatedAt: activeScenario?.updatedAt ?? today,
    }),
    [
      activeScenario?.updatedAt,
      adjustmentRows,
      collectionOverrideRows,
      manualRows,
      projection.days,
      projection.supplierQueue,
      scheduledOutflowOverrideRows,
      supplierOverrideRows,
      taxDebtRows,
      today,
    ],
  );
  const exportPlanningLedgerCsv = () => {
    const csv = buildPlanningLedgerCsv({
      ledgerRows: fullPlanningLedgerRows,
      scenarioName: activeScenario?.name ?? 'Escenario',
      comparison: scenarioComparison,
    });
    downloadTextFile(
      `programacion-operativa-${today}-${safeFileName(activeScenario?.name ?? 'escenario')}.csv`,
      csv,
      'text/csv;charset=utf-8',
    );
  };
  const exportPlanningLedgerXlsx = async () => {
    const ExcelRuntime = await loadExcelJsRuntime();
    const workbook = await buildPlanningLedgerWorkbook(ExcelRuntime, {
      days: projection.days,
      ledgerRows: fullPlanningLedgerRows,
      scenarioName: activeScenario?.name ?? 'Escenario',
      comparison: scenarioComparison,
      importPreview: ledgerImportPreview,
      minimumCash: manualMinimumCash,
    });
    const buffer = await workbook.xlsx.writeBuffer();
    downloadBinaryFile(
      `programacion-operativa-${today}-${safeFileName(activeScenario?.name ?? 'escenario')}.xlsx`,
      buffer,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  };
  const importPlanningLedgerCsv = async (file: File) => {
    try {
      const rows = file.name.toLowerCase().endsWith('.xlsx')
        ? await parsePlanningLedgerXlsx(file)
        : parsePlanningLedgerCsv(await file.text());
      const preview = buildPlanningLedgerImportPreview(file.name, rows, fullPlanningLedgerRows, projection, manualMinimumCash);
      setLedgerImportPreview(preview);
      setLedgerImportStatus(`${preview.changes.length} cambios detectados · ${preview.ignored} filas ignoradas`);
    } catch (error) {
      setLedgerImportStatus(error instanceof Error ? error.message : 'No se pudo leer el archivo.');
    }
  };
  const applyPlanningLedgerImportPreview = () => {
    if (!ledgerImportPreview) return;
    const before = scenarioComparison;
    const previewSnapshot = ledgerImportPreview;
    const result = createScenarioFromImportPreview(previewSnapshot);
    if (!result) {
      setLedgerImportStatus('No se pudo crear el escenario desde la importación.');
      return;
    }
    setLedgerImportStatus(
      `Nuevo escenario "${result.scenarioName}" creado · ${result.applied} cambios · ${result.added} altas · ${result.ignored} ignoradas`,
    );
    setLedgerImportPreview(null);
    setRunVersion((value) => value + 1);
    setTimeout(() => {
      appendAuditEntry({
        action: 'Importación de flujo',
        reason: 'Archivo Excel/CSV editado',
        detail: `${previewSnapshot.fileName}: ${result.applied} edits, ${result.added} altas, ${result.ignored} ignoradas`,
        impact: `Antes de recalcular: caja delta ${fmtCompact(before.endingCashDelta)}, riesgo ${before.scenarioRiskLabel}. Escenario creado: ${result.scenarioName}.`,
      });
    }, 0);
  };
  const appendAuditEntry = (entry: Omit<OperatingAuditEntry, 'id' | 'at' | 'user' | 'scenarioId'>) => {
    setScenarioUi((current) => {
      const editable = ensureEditableScenarioUiState(current);
      const now = new Date().toISOString();
      const auditEntry: OperatingAuditEntry = {
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        at: now,
        user: currentUser.name || 'Usuario local',
        scenarioId: editable.activeScenarioId,
        ...entry,
      };
      return {
        ...editable,
        scenarios: editable.scenarios.map((scenario) => (
          scenario.id === editable.activeScenarioId
            ? {
              ...scenario,
              owner: currentUser.name || scenario.owner,
              role: currentUser.role || scenario.role,
              auditLog: [auditEntry, ...(scenario.auditLog ?? [])].slice(0, 200),
              updatedAt: now,
            }
            : scenario
        )),
      };
    });
  };
  const createScenarioFromImportPreview = (preview: PlanningLedgerImportPreview): {
    applied: number;
    added: number;
    ignored: number;
    scenarioName: string;
  } | null => {
    const byId = new Map(fullPlanningLedgerRows.map((row) => [row.id, row]));
    const fileLabel = preview.fileName.replace(/\.[^.]+$/, '').slice(0, 48) || 'Excel';
    const scenarioName = `Importado · ${fileLabel}`.slice(0, 60);

    let applied = 0;
    let added = 0;
    let ignored = 0;

    let nextManualRows = manualRows.slice();
    let nextAdjustmentRows = adjustmentRows.slice();
    let nextSupplierOverrideRows = supplierOverrideRows.slice();
    let nextCollectionOverrideRows = collectionOverrideRows.slice();
    let nextScheduledOutflowOverrideRows = scheduledOutflowOverrideRows.slice();
    let nextTaxDebtRows = taxDebtRows.slice();

    for (const incoming of preview.rows) {
      if (incoming.isAddition) {
        const date = incoming.scheduledDate;
        const amount = incoming.adjustedAmount;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || amount == null || amount <= 0) {
          ignored += 1;
          continue;
        }
        if (incoming.additionType === 'obligation') {
          const concept = mapAdditionToManualConcept(incoming.additionCategory);
          nextManualRows = sortManualRows([
            ...nextManualRows,
            {
              id: `manual-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              concept,
              date,
              amountInput: editableAmount(amount),
              label: incoming.additionConcept || incoming.comment || concept,
              allowPartial: concept === TAX_MANUAL_CONCEPT,
            },
          ]);
          added += 1;
          continue;
        }
        if (incoming.additionType === 'adjustment') {
          const direction: 'inflow' | 'outflow' = incoming.additionDirection === 'inflow' ? 'inflow' : 'outflow';
          nextAdjustmentRows = sortAdjustmentRows([
            ...nextAdjustmentRows,
            {
              id: `adjustment-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              date,
              direction,
              category: incoming.additionCategory || (direction === 'inflow' ? 'Entrada manual' : 'Salida manual'),
              label: incoming.additionConcept || incoming.comment || (direction === 'inflow' ? 'Entrada importada' : 'Salida importada'),
              amountInput: editableAmount(amount),
            },
          ]);
          added += 1;
          continue;
        }
        ignored += 1;
        continue;
      }

      const current = byId.get(incoming.id);
      if (!current) {
        ignored += 1;
        continue;
      }

      const dateChanged = incoming.scheduledDate != null
        && /^\d{4}-\d{2}-\d{2}$/.test(incoming.scheduledDate)
        && incoming.scheduledDate !== current.scheduledDate;
      const amountChanged = incoming.adjustedAmount != null
        && Number.isFinite(incoming.adjustedAmount)
        && Math.abs(incoming.adjustedAmount - current.adjustedAmount) > 0.004;
      const commentChanged = incoming.comment != null && incoming.comment !== current.comment;

      if (!dateChanged && !amountChanged && !commentChanged) {
        ignored += 1;
        continue;
      }

      if (current.type === 'supplier' && current.supplier) {
        const patch: Partial<SupplierOverrideRow> = {};
        if (dateChanged) patch.date = incoming.scheduledDate;
        if (amountChanged) patch.amountInput = editableAmount(incoming.adjustedAmount ?? current.adjustedAmount);
        if (commentChanged) patch.note = incoming.comment;
        nextSupplierOverrideRows = upsertSupplierOverrideFromQueueItem(
          nextSupplierOverrideRows,
          current.supplier,
          patch,
          current.supplier.plannedDate ?? current.supplier.dueDate ?? `${selectedMonth}-01`,
        );
        applied += 1;
        continue;
      }

      if (current.type === 'collection' && current.collectionLine) {
        const patch: Partial<CollectionOverrideRow> = {};
        if (dateChanged) patch.date = incoming.scheduledDate;
        if (amountChanged) patch.amountInput = editableAmount(incoming.adjustedAmount ?? current.adjustedAmount);
        if (commentChanged) patch.note = incoming.comment;
        nextCollectionOverrideRows = upsertCollectionOverrideRow(
          nextCollectionOverrideRows,
          current.collectionLine,
          patch,
          current.scheduledDate,
        );
        applied += 1;
        continue;
      }

      if (current.type === 'fixed' && current.outflowLine) {
        const patch: Partial<ScheduledOutflowOverrideRow> = {};
        if (dateChanged) patch.date = incoming.scheduledDate;
        if (amountChanged) patch.amountInput = editableAmount(incoming.adjustedAmount ?? current.adjustedAmount);
        if (commentChanged) patch.note = incoming.comment;
        nextScheduledOutflowOverrideRows = upsertScheduledOutflowOverrideRow(
          nextScheduledOutflowOverrideRows,
          current.outflowLine,
          patch,
          current.scheduledDate,
        );
        applied += 1;
        continue;
      }

      if (current.type === 'tax' && current.parentId) {
        const patch: Partial<TaxPaymentRow> = {};
        if (dateChanged) patch.date = incoming.scheduledDate;
        if (amountChanged) patch.amountInput = editableAmount(incoming.adjustedAmount ?? current.adjustedAmount);
        if (commentChanged) patch.note = incoming.comment;
        nextTaxDebtRows = updateTaxPaymentRow(nextTaxDebtRows, current.parentId, current.sourceId, patch);
        applied += 1;
        continue;
      }

      if (current.type === 'obligation') {
        const patch: Partial<ManualEventRow> = {};
        if (dateChanged) patch.date = incoming.scheduledDate;
        if (amountChanged) patch.amountInput = editableAmount(incoming.adjustedAmount ?? current.adjustedAmount);
        if (commentChanged) patch.label = incoming.comment ?? '';
        nextManualRows = sortManualRows(nextManualRows.map((row) => (
          row.id === current.sourceId ? { ...row, ...patch } : row
        )));
        applied += 1;
        continue;
      }

      if (current.type === 'adjustment') {
        const patch: Partial<AdjustmentRow> = {};
        if (dateChanged) patch.date = incoming.scheduledDate;
        if (amountChanged) patch.amountInput = editableAmount(incoming.adjustedAmount ?? current.adjustedAmount);
        if (commentChanged) patch.label = incoming.comment ?? '';
        nextAdjustmentRows = sortAdjustmentRows(nextAdjustmentRows.map((row) => (
          row.id === current.sourceId ? { ...row, ...patch } : row
        )));
        applied += 1;
        continue;
      }

      ignored += 1;
    }

    setScenarioUi((prev) => {
      setUndoStack((history) => [cloneOperatingScenarioUiState(prev), ...history].slice(0, 20));
      const manualEvents = nextManualRows
        .map(toManualExpenseEvent)
        .filter((value): value is ManualExpenseEvent => value !== null)
        .sort(sortManualExpenseEvent);
      const operatingAdjustmentList = nextAdjustmentRows
        .map(toOperatingAdjustment)
        .filter((value): value is OperatingAdjustment => value !== null)
        .sort(sortOperatingAdjustment);
      const supplierPaymentOverrideList = nextSupplierOverrideRows
        .map(toSupplierPaymentOverride)
        .filter((value): value is OperatingSupplierPaymentOverride => value !== null);
      const collectionOverrideList = nextCollectionOverrideRows
        .map(toOperatingCollectionOverride)
        .filter((value): value is OperatingCollectionOverride => value !== null);
      const scheduledOutflowOverrideList = nextScheduledOutflowOverrideRows
        .map(toOperatingScheduledOutflowOverride)
        .filter((value): value is OperatingScheduledOutflowOverride => value !== null);
      const taxDebtList = nextTaxDebtRows
        .map(toOperatingTaxDebt)
        .filter((value): value is OperatingTaxDebt => value !== null);
      const scenario = createOperatingProjectionScenario(scenarioName, {
        manualExpenseEvents: manualEvents,
        operatingAdjustments: operatingAdjustmentList,
        supplierPaymentOverrides: supplierPaymentOverrideList,
        collectionOverrides: collectionOverrideList,
        scheduledOutflowOverrides: scheduledOutflowOverrideList,
        taxDebts: taxDebtList,
        owner: currentUser.name,
        role: currentUser.role,
      });
      return {
        scenarios: [...prev.scenarios, scenario],
        activeScenarioId: scenario.id,
        manualRows: nextManualRows,
        adjustmentRows: nextAdjustmentRows,
        supplierOverrideRows: nextSupplierOverrideRows,
        collectionOverrideRows: nextCollectionOverrideRows,
        scheduledOutflowOverrideRows: nextScheduledOutflowOverrideRows,
        taxDebtRows: nextTaxDebtRows,
      };
    });

    return { applied, added, ignored, scenarioName };
  };

  const undoLastScenarioChange = () => {
    setUndoStack((history) => {
      const [snapshot, ...rest] = history;
      if (!snapshot) return history;
      setScenarioUi(snapshot);
      setLedgerImportStatus('Último cambio deshecho');
      return rest;
    });
  };
  const restoreScenarioFromBase = () => {
    setScenarioUi((current) => {
      const base = current.scenarios.find((scenario) => scenario.id === 'base') ?? current.scenarios[0];
      if (!base) return current;
      setUndoStack((history) => [cloneOperatingScenarioUiState(current), ...history].slice(0, 20));
      const restored = createOperatingProjectionScenario(`${base.name} restaurado`, {
        manualExpenseEvents: base.manualExpenseEvents,
        operatingAdjustments: base.operatingAdjustments,
        supplierPaymentOverrides: base.supplierPaymentOverrides,
        collectionOverrides: base.collectionOverrides,
        scheduledOutflowOverrides: base.scheduledOutflowOverrides,
        taxDebts: base.taxDebts,
        owner: currentUser.name,
        role: currentUser.role,
      });
      return {
        scenarios: [...current.scenarios, restored],
        activeScenarioId: restored.id,
        manualRows: restored.manualExpenseEvents.map(rowFromManualEvent),
        adjustmentRows: restored.operatingAdjustments.map(rowFromOperatingAdjustment),
        supplierOverrideRows: restored.supplierPaymentOverrides.map(rowFromSupplierPaymentOverride),
        collectionOverrideRows: restored.collectionOverrides.map(rowFromOperatingCollectionOverride),
        scheduledOutflowOverrideRows: restored.scheduledOutflowOverrides.map(rowFromOperatingScheduledOutflowOverride),
        taxDebtRows: restored.taxDebts.map(rowFromOperatingTaxDebt),
      };
    });
  };
  const selectedLedgerRows = useMemo(
    () => planningLedgerRows.filter((row) => selectedLedgerIds.has(row.id)),
    [planningLedgerRows, selectedLedgerIds],
  );
  const applyBulkMove = (days: number) => {
    for (const row of selectedLedgerRows) {
      if (!row.editableDate) continue;
      updatePlanningLedgerItem(row, { date: shiftBusinessDate(row.scheduledDate, days), comment: row.comment || `Movimiento masivo +${days} días` });
    }
    appendAuditEntry({
      action: 'Movimiento masivo',
      reason: `Mover ${selectedLedgerRows.length} líneas ${days} días`,
      detail: selectedLedgerRows.map((row) => row.id).join(', ').slice(0, 500),
      impact: `Se recalcula contra Base después del movimiento masivo.`,
    });
    setSelectedLedgerIds(new Set());
  };
  const applyBulkComment = (comment: string) => {
    for (const row of selectedLedgerRows) {
      if (!row.editableDate && !row.editableAmount) continue;
      updatePlanningLedgerItem(row, { comment });
    }
    appendAuditEntry({
      action: 'Comentario masivo',
      reason: comment,
      detail: `${selectedLedgerRows.length} líneas actualizadas`,
      impact: 'Sin impacto de caja directo; documenta justificación.',
    });
  };
  const optimizeScenarioCash = () => {
    const riskDates = new Set(projection.days
      .filter((day) => day.closingCash < manualMinimumCash || day.mandatoryReserveShortfall > 0)
      .map((day) => day.date));
    const candidates = projection.supplierQueue
      .filter((item) => item.plannedDate && riskDates.has(item.plannedDate))
      .filter((item) => item.flexibility === 'flexible' || (item.risk === 'Bajo' && item.flexibility !== 'inamovible'))
      .slice(0, 40);
    if (candidates.length === 0) {
      setLedgerImportStatus('No hay proveedores flexibles en días de riesgo para optimizar.');
      return;
    }
    setSupplierOverrideRows((current) => candidates.reduce((next, item) => (
      upsertSupplierOverrideFromQueueItem(next, item, {
        date: shiftBusinessDate(item.plannedDate ?? item.dueDate ?? `${selectedMonth}-01`, 7),
        amountInput: editableAmount(item.remainingAmount || item.plannedAmount || item.invoiceAmount),
        note: 'Optimizado por caja: proveedor flexible movido +7 días',
      }, item.plannedDate ?? `${selectedMonth}-01`)
    ), current));
    appendAuditEntry({
      action: 'Optimización automática',
      reason: 'Proteger caja mínima moviendo proveedores flexibles',
      detail: `${candidates.length} pagos candidatos movidos +7 días`,
      impact: `Objetivo: reducir días bajo caja mínima de ${scenarioComparison.scenarioRiskDays}`,
    });
    setLedgerImportStatus(`${candidates.length} pagos flexibles movidos por optimización automática`);
  };
  const applyTaxDebtPlan = (mapper: (debts: OperatingTaxDebt[]) => OperatingTaxDebt[]) => {
    setTaxDebtRows((current) => mapper(
      current.map(toOperatingTaxDebt).filter((value): value is OperatingTaxDebt => value !== null),
    ).map(rowFromOperatingTaxDebt));
    setRunVersion((value) => value + 1);
  };
  const addTaxDebt = () => {
    setTaxDebtRows((current) => [...current, createTaxDebtRow(today)]);
    setTaxModuleTab('debts');
  };
  const treasuryActions = useMemo(() => {
    const actions: TreasuryActionItem[] = [];
    const pressureDay = projection.days.find((day) => day.closingCash < 0 || day.mandatoryReserveShortfall > 0);
    const firstSupplierDay = projection.days.find((day) => day.supplierPayments.length > 0 || day.pendingSupplierAmount > 0);
    const monthNonTaxReserve = monthDays
      .flatMap((day) => day.mandatoryReserveLines)
      .filter((line) => !normalizeLabel(line.category).includes('IMPUEST'))
      .reduce((sum, line) => sum + line.amount, 0);
    const firstAlert = topMonthAlerts[0];

    if (pressureDay) {
      actions.push({
        id: 'cash-pressure',
        title: pressureDay.closingCash < 0 ? 'Caja negativa proyectada' : 'Reserva obligatoria incompleta',
        detail: `${fmtDate(pressureDay.date)} · cierre ${fmtCompact(pressureDay.closingCash)} · faltante ${fmtCompact(pressureDay.mandatoryReserveShortfall)}`,
        module: 'projection',
        cta: 'Abrir hoja',
        severity: 'danger',
        date: pressureDay.date,
      });
    }

    if (taxDebtSummary.outstanding > 0 && taxDebtSummary.unscheduled > 0) {
      actions.push({
        id: 'tax-plan',
        title: 'Impuestos sin plan completo',
        detail: `Pendiente ${fmtCompact(taxDebtSummary.outstanding)} · falta programar ${fmtCompact(taxDebtSummary.unscheduled)}`,
        module: 'taxes',
        cta: 'Programar impuestos',
        severity: 'warning',
      });
    } else if (taxSheetSummary.taxAmount > 0 && taxRows.length === 0 && taxDebtSummary.outstanding === 0) {
      actions.push({
        id: 'tax-plan',
        title: 'Falta plan manual de impuestos',
        detail: `Impuesto visible ${fmtCompact(taxSheetSummary.taxAmount)} · sin capturas fiscales`,
        module: 'taxes',
        cta: 'Programar impuestos',
        severity: 'warning',
      });
    }

    if (firstSupplierDay) {
      actions.push({
        id: 'supplier-plan',
        title: supplierOverrideRows.length > 0 ? 'Validar pagos movidos' : 'Revisar pagos a proveedores',
        detail: `${fmtDate(firstSupplierDay.date)} · pagos ${firstSupplierDay.supplierPayments.length} · pendiente ${fmtCompact(firstSupplierDay.pendingSupplierAmount)}`,
        module: 'suppliers',
        cta: 'Abrir proveedores',
        severity: firstSupplierDay.alerts.length > 0 ? 'warning' : 'neutral',
        date: firstSupplierDay.date,
      });
    }

    if (monthNonTaxReserve > 0 && monthObligationRows.length === 0) {
      actions.push({
        id: 'obligation-plan',
        title: 'Completar obligaciones no fiscales',
        detail: `${fmtYearMonthLong(selectedMonth)} · reserva no fiscal ${fmtCompact(monthNonTaxReserve)}`,
        module: 'obligations',
        cta: 'Abrir obligaciones',
        severity: 'warning',
      });
    }

    if (firstAlert) {
      actions.push({
        id: 'month-alert',
        title: 'Revisar alerta del mes',
        detail: `${fmtDate(firstAlert.date)} · ${firstAlert.alert}`,
        module: 'overview',
        cta: 'Ver alerta',
        severity: 'warning',
        date: firstAlert.date,
      });
    }

    if (actions.length === 0) {
      actions.push({
        id: 'ready',
        title: 'Corrida sin bloqueos principales',
        detail: 'Revisa escenario, caja final y supuestos antes de cerrar el plan.',
        module: 'overview',
        cta: 'Ver resumen',
        severity: 'neutral',
      });
    }

    return actions.slice(0, 4);
  }, [
    monthDays,
    monthObligationRows.length,
    projection.days,
    selectedMonth,
    supplierOverrideRows.length,
    taxDebtSummary.outstanding,
    taxDebtSummary.unscheduled,
    taxRows.length,
    taxSheetSummary.taxAmount,
    topMonthAlerts,
  ]);
  const openTreasuryAction = (action: TreasuryActionItem) => {
    if (action.module !== 'overview') {
      expandBlock(action.module as OperatingBlockId);
    }
    if (action.date) {
      setSelectedMonth(action.date.slice(0, 7));
      setSelectedDay(action.date);
    }
    if (action.module === 'projection') {
      setSheetScope('year');
    }
    if (action.module === 'taxes') {
      setTaxSheetScope('year');
      setTaxModuleTab('plan');
    }
  };
  const monthCollectionsByDay = monthDays.map((day) => sumAmounts(collectionLines(day)));
  const monthSupplierByDay = monthDays.map((day) => sumAmounts(day.supplierPayments));
  const monthTaxByDay = monthDays.map((day) => {
    const dateKey = day.date;
    return manualRows
      .filter((row) => row.concept === TAX_MANUAL_CONCEPT && row.date === dateKey)
      .reduce((sum, row) => sum + (Number(row.amountInput) || 0), 0);
  });
  const monthObligationByDay = monthDays.map((day) => {
    const dateKey = day.date;
    return manualRows
      .filter((row) => row.concept !== TAX_MANUAL_CONCEPT && row.date === dateKey)
      .reduce((sum, row) => sum + (Number(row.amountInput) || 0), 0);
  });
  const monthAdjustmentByDay = monthDays.map((day) => {
    const dateKey = day.date;
    return adjustmentRows
      .filter((row) => row.date === dateKey)
      .reduce((sum, row) => {
        const amount = Number(row.amountInput) || 0;
        return sum + (row.direction === 'inflow' ? amount : -amount);
      }, 0);
  });
  const monthTaxTotal = monthTaxByDay.reduce((sum, value) => sum + value, 0);
  const blockCards: OperatingBlockCard[] = [
    {
      id: 'cobranza',
      label: 'Cobranza',
      description: 'Cobros proyectados desde clientes y otras entradas no manuales.',
      total: monthCollectionsTotal,
      delta: 0,
      count: monthDays.reduce((sum, day) => sum + collectionLines(day).length, 0),
      sparkline: monthCollectionsByDay,
      tone: 'success',
      countLabel: 'cobros del mes',
    },
    {
      id: 'suppliers',
      label: 'Pagos a proveedores',
      description: 'Cola priorizada por riesgo, flexibilidad y vencimiento.',
      total: monthSupplierTotal,
      delta: monthSupplierTotal - (baseProjection.months.find((m) => m.yearMonth === selectedMonth)?.totalSupplierPayments ?? monthSupplierTotal),
      count: monthDays.reduce((sum, day) => sum + day.supplierPayments.length, 0),
      sparkline: monthSupplierByDay,
      tone: 'danger',
      countLabel: 'pagos del mes',
      scheduleHint: 'Programa nuevo desde calendario',
    },
    {
      id: 'taxes',
      label: 'Impuestos',
      description: 'Lectura legacy; la edición vive en Proyección > Impuestos.',
      total: monthTaxTotal,
      delta: 0,
      count: taxDebts.length,
      sparkline: monthTaxByDay,
      tone: 'warning',
      countLabel: 'adeudos activos',
    },
    {
      id: 'obligations',
      label: 'Obligaciones / CAPEX',
      description: 'Finiquitos, CAPEX y pasivos no fiscales.',
      total: monthObligationTotal,
      delta: 0,
      count: monthObligationRows.length,
      sparkline: monthObligationByDay,
      tone: 'danger',
      countLabel: 'pagos del mes',
      scheduleSeed: { kind: 'obligation', direction: 'outflow' },
    },
    {
      id: 'adjustments',
      label: 'Ajustes manuales',
      description: 'Entradas y salidas extra para forzar el escenario.',
      total: monthAdjustmentInflows - monthAdjustmentOutflows,
      delta: 0,
      count: monthAdjustmentRows.length,
      sparkline: monthAdjustmentByDay,
      tone: monthAdjustmentInflows >= monthAdjustmentOutflows ? 'success' : 'danger',
      countLabel: 'ajustes del mes',
      scheduleSeed: { kind: 'adjustment' },
    },
  ];
  const effectiveMinimumCash = Math.max(projection.summary.peakMandatoryReserve, manualMinimumCash);
  const effectiveMinimumShortfall = Math.max(0, effectiveMinimumCash - projection.summary.endingCash);
  const cashGapShortfall = Math.max(projection.summary.peakMandatoryReserveShortfall, effectiveMinimumShortfall);
  const cashGap = cashGapShortfall > 0
    ? -cashGapShortfall
    : projection.summary.endingFreeCash;
  const projectedOutflows = projection.summary.totalScheduledOutflows + projection.summary.totalSupplierPayments;
  const criticalUpcomingPayments = projection.supplierQueue
    .filter((item) => item.status === 'overdue' || item.risk === 'Alto' || item.flexibility === 'inamovible')
    .slice(0, 20);
  const monthRiskDays = monthDays.filter((day) => day.closingCash < effectiveMinimumCash).length;

  return (
    <div className="space-y-6">
      <OperatingStickyHeader
        scenarios={scenarios}
        activeScenarioId={activeScenarioId}
        onActivate={activateScenario}
        endingCash={projection.summary.endingCash}
        minimumCash={effectiveMinimumCash}
        cashGap={cashGap}
        criticalPayments={criticalUpcomingPayments.length}
        riskDays={monthRiskDays}
      />

      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium">
            <RulePill icon={Wallet} label="Caja nunca negativa" />
            <RulePill icon={ShieldAlert} label="Reserva para pagos forzosos" />
            <RulePill icon={ShieldAlert} label="Prioridad riesgo + flexibilidad" />
            <RulePill icon={CalendarDays} label="Cobranza diaria + drilldown" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-[var(--gray-950)]">Proyección operativa</h1>
            <p className="mt-1 text-[13px] text-[var(--gray-400)]">
              Muestra de dónde entra el efectivo, en qué se usa y cuánto queda apartado para pagos obligatorios.
            </p>
          </div>
        </div>
        <div className="text-[12px] text-right text-[var(--gray-400)]">
          <div>{fmtDate(projection.startDate)} → {fmtDate(projection.endDate)}</div>
          <div className="mt-1">
            {selectedMonthData ? fmtYearMonthLong(selectedMonthData.yearMonth) : 'Sin mes'}
          </div>
          {companyCode !== 'all' && (
            <div className="mt-1 text-[var(--warning)]">
              La predicción sigue corriendo a nivel grupo.
            </div>
          )}
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-8">
        <MetricCard label="Caja inicial" value={projection.summary.startingCash} tone="neutral" />
        <MetricCard label="Ingresos proyectados" value={projection.summary.totalCashInflows} tone="success" />
        <MetricCard label="Egresos proyectados" value={projectedOutflows} tone="danger" />
        <MetricCard label="Caja final proyectada" value={projection.summary.endingCash} tone={projection.summary.endingCash >= 0 ? 'success' : 'danger'} />
        <MetricCard label="Mínimo requerido" value={effectiveMinimumCash} tone="warning" />
        <MetricCard label="Déficit / excedente" value={cashGap} tone={cashGap >= 0 ? 'success' : 'danger'} />
        <MetricCard label="Pagos críticos" value={criticalUpcomingPayments.length} tone={criticalUpcomingPayments.length > 0 ? 'warning' : 'success'} subvalue={fmtCurrency(criticalUpcomingPayments.reduce((sum, item) => sum + item.remainingAmount, 0))} />
        <MetricCard label="Confianza" value={projectionConfidence.score} tone={projectionConfidence.score >= 80 ? 'success' : projectionConfidence.score >= 60 ? 'warning' : 'danger'} displayValue={projectionConfidence.label} subvalue={projectionConfidence.detail} />
      </section>

      <TreasuryActionPanel
        actions={treasuryActions}
        onOpen={openTreasuryAction}
        onRecalculate={() => setRunVersion((value) => value + 1)}
      />

      <OperatingPeriodBar
        months={projection.months}
        selectedMonth={selectedMonth}
        onSelectMonth={setSelectedMonth}
      />

      <OperatingTopCharts
        days={monthDays}
        allDays={projection.days}
        minimumCash={effectiveMinimumCash}
        monthSupplier={monthSupplierTotal}
        monthTax={monthTaxTotal}
        monthObligations={monthObligationTotal}
        monthAdjustmentOutflows={monthAdjustmentOutflows}
      />

      <OperatingBlocksPanel
        blocks={blockCards}
        expanded={expandedBlocks}
        onToggle={toggleExpandedBlock}
        onSchedule={() => {}}
        onExpandAll={() => setExpandedBlocks(new Set<OperatingBlockId>(blockCards.map((b) => b.id)))}
        onCollapseAll={() => setExpandedBlocks(new Set<OperatingBlockId>())}
      />

      <CobranzaBlock
        expanded={expandedBlocks.has('cobranza')}
        days={monthDays}
        monthLabel={selectedMonthData ? fmtYearMonthLong(selectedMonthData.yearMonth) : '—'}
        monthCollectionsTotal={monthCollectionsTotal}
      />

      <section className={`${T.section} overflow-hidden`}>
        <div className="flex flex-col gap-3 border-b border-[var(--border)] px-4 py-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0">
            <h2 className={`text-[15px] font-semibold ${T.title}`}>Escenarios de corrida</h2>
            <p className={`mt-1 text-[12px] ${T.muted}`}>
              Cambia escenario, mueve pagos por factura y el algoritmo recalcula caja, apartado y pagos restantes.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={addScenario}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] font-medium text-[var(--gray-950)] transition-colors hover:bg-[var(--surface-alt)]"
            >
              <Plus className="h-4 w-4" />
              Nuevo
            </button>
            <button
              onClick={duplicateScenario}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] font-medium text-[var(--gray-950)] transition-colors hover:bg-[var(--surface-alt)]"
            >
              <Copy className="h-4 w-4" />
              Duplicar
            </button>
            <button
              onClick={() => setRunVersion((value) => value + 1)}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--primary)] bg-[var(--primary)] px-3 text-[13px] font-medium text-white transition-colors hover:opacity-90"
            >
              Recalcular
            </button>
            <button
              onClick={deleteScenario}
              disabled={scenarios.length <= 1}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] font-medium text-[var(--gray-600)] transition-colors hover:bg-[var(--danger)]/8 hover:text-[var(--danger)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Trash2 className="h-4 w-4" />
              Eliminar
            </button>
          </div>
        </div>

        <div className="grid gap-3 border-b border-[var(--border)] px-4 py-3 lg:grid-cols-[240px_minmax(240px,1fr)_repeat(5,140px)]">
          <label className="min-w-0">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.02em] text-[var(--gray-400)]">Escenario activo</div>
            <select
              value={activeScenario?.id ?? ''}
              onChange={(event) => activateScenario(event.target.value)}
              className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none transition-colors focus:border-[var(--primary)]"
            >
              {scenarios.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>{scenario.name}</option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.02em] text-[var(--gray-400)]">Nombre</div>
            <input
              value={activeScenario?.name ?? ''}
              onChange={(event) => renameScenario(event.target.value)}
              disabled={activeScenario?.id === 'base'}
              className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none transition-colors focus:border-[var(--primary)] disabled:bg-[var(--surface-alt)] disabled:text-[var(--gray-400)]"
            />
          </label>
          <SelectedKpi label="Pagos movidos" value={String(supplierOverrideRows.length)} />
          <SelectedKpi label="Adeudos fiscales" value={String(taxDebts.length)} />
          <SelectedKpi label="Obligaciones" value={String(manualRows.length - taxRows.length)} />
          <SelectedKpi label="Ajustes caja" value={String(adjustmentRows.length)} />
          <SelectedKpi label="Recalculado" value={fmtDate(today)} />
        </div>

        <ScenarioComparisonPanel
          activeScenarioName={activeScenario?.name ?? 'Escenario'}
          comparison={scenarioComparison}
          lockedBase={activeScenario?.id === 'base'}
        />

        <AuditTrailPanel
          entries={(activeScenario?.auditLog ?? []) as OperatingAuditEntry[]}
          currentUser={currentUser}
        />

        {expandedBlocks.has('suppliers') && (
          <SupplierOverrideEditor
            rows={supplierOverrideRows}
            onChangeRows={setSupplierOverrideRows}
          />
        )}
      </section>

      <section className={`${expandedBlocks.has('taxes') ? T.section : 'hidden'} overflow-hidden`}>
        <div className="flex flex-col gap-3 border-b border-[var(--border)] px-4 py-4 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <h2 className={`text-[15px] font-semibold ${T.title}`}>Módulo fiscal</h2>
            <p className={`mt-1 text-[12px] ${T.muted}`}>
              Lectura legacy de adeudos fiscales. La edición de IVA, ISN, IMSS y pagos parciales ahora vive en Proyección &gt; Impuestos.
            </p>
          </div>
          {!TAXES_MOVED_TO_INDEPENDENT_MODULE && (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={addTaxDebt}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] font-medium text-[var(--gray-950)] transition-colors hover:bg-[var(--surface-alt)]"
            >
              <Plus className="h-4 w-4" />
              Adeudo fiscal
            </button>
            <button
              onClick={() => applyTaxDebtPlan((debts) => suggestOperatingTaxDebtPlan(debts, today))}
              className="inline-flex h-10 items-center rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] font-medium text-[var(--gray-950)] transition-colors hover:bg-[var(--surface-alt)]"
            >
              Sugerir plan
            </button>
            <button
              onClick={() => applyTaxDebtPlan((debts) => splitOperatingTaxDebtsWeekly(debts, today))}
              className="inline-flex h-10 items-center rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] font-medium text-[var(--gray-950)] transition-colors hover:bg-[var(--surface-alt)]"
            >
              Partir semanal
            </button>
            <button
              onClick={() => applyTaxDebtPlan((debts) => shiftOperatingTaxDebtPayments(debts, 30))}
              className="inline-flex h-10 items-center rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] font-medium text-[var(--gray-950)] transition-colors hover:bg-[var(--surface-alt)]"
            >
              Mover 30 días
            </button>
            <button
              onClick={() => applyTaxDebtPlan(liquidateOperatingTaxDebtsByDueDate)}
              className="inline-flex h-10 items-center rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] font-medium text-[var(--gray-950)] transition-colors hover:bg-[var(--surface-alt)]"
            >
              Liquidar al límite
            </button>
            <button
              onClick={() => setRunVersion((value) => value + 1)}
              className="inline-flex h-10 items-center rounded-xl border border-[var(--primary)] bg-[var(--primary)] px-3 text-[13px] font-medium text-white transition-colors hover:opacity-90"
            >
              Recalcular
            </button>
          </div>
          )}
        </div>

        <div className="grid gap-3 border-b border-[var(--border)] px-4 py-3 sm:grid-cols-2 xl:grid-cols-8">
          <SelectedKpi label="Total fiscal" value={fmtCurrency(taxDebtSummary.totalDebt)} />
          <SelectedKpi label="Pendiente 2025" value={fmtCurrency(taxDebtSummary.total2025)} />
          <SelectedKpi label="Pendiente 2026" value={fmtCurrency(taxDebtSummary.total2026)} />
          <SelectedKpi label="Pagado" value={fmtCurrency(taxDebtSummary.paid)} />
          <SelectedKpi label="Pendiente" value={fmtCurrency(taxDebtSummary.outstanding)} />
          <SelectedKpi label="Programado mes" value={fmtCurrency(taxDebtSummary.scheduledThisMonth)} />
          <SelectedKpi label="Vencido" value={fmtCurrency(taxDebtSummary.overdue)} />
          <SelectedKpi label="Falta plan" value={fmtCurrency(taxDebtSummary.unscheduled)} />
        </div>

        {TAXES_MOVED_TO_INDEPENDENT_MODULE && (
          <div className="border-b border-[var(--border)] px-4 py-3 text-[12px] text-[var(--gray-600)]">
            Este bloque conserva la lectura histórica para auditoría operativa; captura, overrides y pagos se hacen en el módulo independiente de Impuestos.
          </div>
        )}

        {!TAXES_MOVED_TO_INDEPENDENT_MODULE && (
        <div className="flex flex-col gap-3 border-b border-[var(--border)] px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="inline-flex w-fit rounded-lg bg-[var(--surface-alt)] p-1 text-[11px] font-medium">
            {([
              { id: 'summary', label: 'Resumen fiscal' },
              { id: 'debts', label: 'Adeudos fiscales' },
              { id: 'plan', label: 'Plan de pagos' },
            ] as Array<{ id: TaxModuleTab; label: string }>).map((option) => (
              <button
                key={option.id}
                onClick={() => setTaxModuleTab(option.id)}
                className={`rounded-md px-3 py-1.5 transition-colors ${
                  taxModuleTab === option.id
                    ? 'bg-white text-[var(--gray-950)] shadow-sm'
                    : 'text-[var(--gray-500)] hover:text-[var(--gray-950)]'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          {taxModuleTab === 'plan' && (
            <div className="flex flex-wrap gap-2">
              <div className="inline-flex w-fit rounded-lg bg-[var(--surface-alt)] p-1 text-[11px] font-medium">
                {SHEET_SCOPES.map((option) => (
                  <button
                    key={option.id}
                    onClick={() => setTaxSheetScope(option.id)}
                    className={`rounded-md px-3 py-1.5 transition-colors ${
                      taxSheetScope === option.id
                        ? 'bg-white text-[var(--gray-950)] shadow-sm'
                        : 'text-[var(--gray-500)] hover:text-[var(--gray-950)]'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="inline-flex w-fit rounded-lg bg-[var(--surface-alt)] p-1 text-[11px] font-medium">
                {SHEET_GRANULARITIES.map((option) => (
                  <button
                    key={option.id}
                    onClick={() => setTaxSheetGranularity(option.id)}
                    className={`rounded-md px-3 py-1.5 transition-colors ${
                      taxSheetGranularity === option.id
                        ? 'bg-white text-[var(--gray-950)] shadow-sm'
                        : 'text-[var(--gray-500)] hover:text-[var(--gray-950)]'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        )}

        {(TAXES_MOVED_TO_INDEPENDENT_MODULE || taxModuleTab === 'summary') && (
          <TaxDebtSummaryView
            debts={taxDebts}
            summary={taxDebtSummary}
            today={today}
          />
        )}
        {!TAXES_MOVED_TO_INDEPENDENT_MODULE && taxModuleTab === 'debts' && (
          <TaxDebtEditor
            rows={taxDebtRows}
            onChangeRows={setTaxDebtRows}
            onAddDebt={addTaxDebt}
            selectedMonth={selectedMonth}
          />
        )}
        {!TAXES_MOVED_TO_INDEPENDENT_MODULE && taxModuleTab === 'plan' && (
          <TaxPaymentPlanEditor
            rows={taxDebtRows}
            onChangeRows={setTaxDebtRows}
            selectedMonth={selectedMonth}
            taxSheetRows={taxSheetRows}
          />
        )}
      </section>

      <section className={`${expandedBlocks.has('obligations') ? T.section : 'hidden'} overflow-hidden`}>
        <div className="flex flex-col gap-3 border-b border-[var(--border)] px-4 py-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className={`text-[15px] font-semibold ${T.title}`}>Hoja de obligaciones no fiscales</h2>
            <p className={`mt-1 text-[12px] ${T.muted}`}>
              Finiquitos, CAPEX y pasivos financieros se editan por fecha. Impuestos se manejan en su módulo separado.
            </p>
          </div>
          <button
            onClick={() => setManualRows(current => sortManualRows([
              ...current,
              createManualRow(selectedMonth, 'Finiquitos'),
            ]))}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] font-medium text-[var(--gray-950)] transition-colors hover:bg-[var(--surface-alt)]"
          >
            <Plus className="h-4 w-4" />
            Agregar detalle
          </button>
        </div>

        <div className="grid gap-3 border-b border-[var(--border)] px-4 py-3 sm:grid-cols-2 xl:grid-cols-4">
          <SelectedKpi label="Mes" value={selectedMonthData ? fmtYearMonthLong(selectedMonthData.yearMonth) : '—'} />
          <SelectedKpi label="Pagos del mes" value={String(monthObligationRows.length)} />
          <SelectedKpi label="Monto del mes" value={fmtCurrency(monthObligationTotal)} />
          <SelectedKpi label="Pagos activos" value={String(manualEvents.filter((event) => event.concept !== TAX_MANUAL_CONCEPT).length)} />
        </div>

        <div className="border-b border-[var(--border)] px-4 py-3">
          <div className="flex flex-wrap gap-2">
            {monthObligationTotalsByConcept.length === 0 ? (
              <span className="text-[12px] text-[var(--gray-400)]">Sin pagos obligatorios capturados para este mes.</span>
            ) : (
              monthObligationTotalsByConcept.map((entry) => (
                <span
                  key={entry.concept}
                  className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-1 text-[11px] font-medium text-[var(--gray-700)]"
                >
                  <span>{entry.concept}</span>
                  <span className="tabular-nums text-[var(--gray-950)]">{fmtCompact(entry.total)}</span>
                </span>
              ))
            )}
          </div>
        </div>

        <MandatoryPaymentExcelSheet
          rows={mandatoryPaymentSheetRows}
          manualRows={manualRows}
          onSetCell={(date, concept, value) => setManualRows((current) => setManualSheetCellTarget(current, date, concept, value))}
          onShiftDate={(date, days) => setManualRows((current) => shiftManualRowsFromDate(current, date, days))}
          onSplitDate={(date, days) => setManualRows((current) => splitManualRowsFromDate(current, date, days))}
        />

        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-[12px]">
            <thead className="bg-[var(--surface-alt)] text-[var(--gray-500)]">
              <tr>
                <Th>Concepto</Th>
                <Th>Fecha</Th>
                <Th>Etiqueta</Th>
                <Th align="right">Monto</Th>
                <Th align="center">Pago parcial</Th>
                <Th align="center">Estado</Th>
                <Th align="center">Acción</Th>
              </tr>
            </thead>
            <tbody>
              {monthObligationRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6">
                    <EmptyMiniState label="No hay pagos obligatorios para este mes. Agrega fecha, concepto y monto exacto." />
                  </td>
                </tr>
              ) : (
                monthObligationRows.map((row) => {
                  const valid = toManualExpenseEvent(row) !== null;
                  return (
                    <tr key={row.id} className="border-t border-[var(--border)] align-top">
                      <td className="px-4 py-3">
                        <select
                          value={row.concept}
                          onChange={(event) => updateManualRow(setManualRows, row.id, { concept: event.target.value as ManualEventRow['concept'] })}
                          className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none transition-colors focus:border-[var(--primary)]"
                        >
                          {OBLIGATION_MANUAL_CONCEPTS.map((concept) => (
                            <option key={concept} value={concept}>{concept}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="date"
                          value={row.date}
                          onChange={(event) => updateManualRow(setManualRows, row.id, { date: event.target.value })}
                          className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none transition-colors focus:border-[var(--primary)]"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="text"
                          value={row.label}
                          onChange={(event) => updateManualRow(setManualRows, row.id, { label: event.target.value })}
                          placeholder="Finiquito, cuota Banorte, CAPEX patio..."
                          className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none transition-colors placeholder:text-[var(--gray-300)] focus:border-[var(--primary)]"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="0.01"
                          value={row.amountInput}
                          onChange={(event) => updateManualRow(setManualRows, row.id, { amountInput: event.target.value })}
                          placeholder="0.00"
                          className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-right text-[13px] tabular-nums text-[var(--gray-950)] outline-none transition-colors placeholder:text-[var(--gray-300)] focus:border-[var(--primary)]"
                        />
                      </td>
                      <td className="px-4 py-3 text-center">
                        <label className="inline-flex h-10 cursor-pointer items-center justify-center rounded-xl border border-[var(--border)] px-3">
                          <input
                            type="checkbox"
                            checked={row.allowPartial}
                            onChange={(event) => updateManualRow(setManualRows, row.id, { allowPartial: event.target.checked })}
                            className="h-4 w-4 rounded border-[var(--border)] text-[var(--primary)] focus:ring-[var(--primary)]"
                          />
                        </label>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium ${
                          valid
                            ? 'bg-[var(--success)]/10 text-[var(--success)]'
                            : 'bg-[var(--warning-muted)] text-[var(--warning)]'
                        }`}>
                          {valid ? 'Activo' : 'Incompleto'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button
                          onClick={() => setManualRows(current => current.filter((item) => item.id !== row.id))}
                          className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--border)] text-[var(--gray-500)] transition-colors hover:bg-[var(--danger)]/8 hover:text-[var(--danger)]"
                          title="Eliminar evento"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className={`${expandedBlocks.has('adjustments') ? T.section : 'hidden'} overflow-hidden`}>
        <div className="flex flex-col gap-3 border-b border-[var(--border)] px-4 py-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className={`text-[15px] font-semibold ${T.title}`}>Detalle de ajustes manuales</h2>
            <p className={`mt-1 text-[12px] ${T.muted}`}>
              La hoja editable crea ajustes rápidos. Usa este detalle cuando necesites fecha, concepto o descripción exacta.
            </p>
          </div>
          <button
            onClick={() => addAdjustmentRow()}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] font-medium text-[var(--gray-950)] transition-colors hover:bg-[var(--surface-alt)]"
          >
            <Plus className="h-4 w-4" />
            Agregar ajuste detallado
          </button>
        </div>

        <div className="grid gap-3 border-b border-[var(--border)] px-4 py-3 sm:grid-cols-2 xl:grid-cols-4">
          <SelectedKpi label="Ajustes del mes" value={String(monthAdjustmentRows.length)} />
          <SelectedKpi label="Entradas manuales" value={fmtCurrency(monthAdjustmentInflows)} />
          <SelectedKpi label="Salidas manuales" value={fmtCurrency(monthAdjustmentOutflows)} />
          <SelectedKpi label="Ajustes activos" value={String(operatingAdjustments.length)} />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px] text-[12px]">
            <thead className="bg-[var(--surface-alt)] text-[var(--gray-500)]">
              <tr>
                <Th>Fecha</Th>
                <Th>Tipo</Th>
                <Th>Concepto</Th>
                <Th>Descripción</Th>
                <Th align="right">Monto</Th>
                <Th align="center">Estado</Th>
                <Th align="center">Acción</Th>
              </tr>
            </thead>
            <tbody>
              {monthAdjustmentRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6">
                    <EmptyMiniState label="No hay ajustes para este mes. Agrega una entrada o salida cuando necesites corregir la corrida automática." />
                  </td>
                </tr>
              ) : (
                monthAdjustmentRows.map((row) => {
                  const valid = toOperatingAdjustment(row) !== null;
                  return (
                    <tr key={row.id} className="border-t border-[var(--border)] align-top">
                      <td className="px-4 py-3">
                        <input
                          type="date"
                          value={row.date}
                          onChange={(event) => updateAdjustmentRow(setAdjustmentRows, row.id, { date: event.target.value })}
                          className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none transition-colors focus:border-[var(--primary)]"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <select
                          value={row.direction}
                          onChange={(event) => updateAdjustmentRow(setAdjustmentRows, row.id, { direction: event.target.value as AdjustmentRow['direction'] })}
                          className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none transition-colors focus:border-[var(--primary)]"
                        >
                          <option value="inflow">Entrada</option>
                          <option value="outflow">Salida</option>
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="text"
                          value={row.category}
                          onChange={(event) => updateAdjustmentRow(setAdjustmentRows, row.id, { category: event.target.value })}
                          placeholder={row.direction === 'inflow' ? 'Cobranza manual' : 'Salida manual'}
                          className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none transition-colors placeholder:text-[var(--gray-300)] focus:border-[var(--primary)]"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="text"
                          value={row.label}
                          onChange={(event) => updateAdjustmentRow(setAdjustmentRows, row.id, { label: event.target.value })}
                          placeholder={row.direction === 'inflow' ? 'Depósito confirmado' : 'Pago urgente'}
                          className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none transition-colors placeholder:text-[var(--gray-300)] focus:border-[var(--primary)]"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="0.01"
                          value={row.amountInput}
                          onChange={(event) => updateAdjustmentRow(setAdjustmentRows, row.id, { amountInput: event.target.value })}
                          placeholder="0.00"
                          className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-right text-[13px] tabular-nums text-[var(--gray-950)] outline-none transition-colors placeholder:text-[var(--gray-300)] focus:border-[var(--primary)]"
                        />
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium ${
                          valid
                            ? 'bg-[var(--success)]/10 text-[var(--success)]'
                            : 'bg-[var(--warning-muted)] text-[var(--warning)]'
                        }`}>
                          {valid ? 'Activo' : 'Incompleto'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button
                          onClick={() => setAdjustmentRows(current => current.filter((item) => item.id !== row.id))}
                          className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--border)] text-[var(--gray-500)] transition-colors hover:bg-[var(--danger)]/8 hover:text-[var(--danger)]"
                          title="Eliminar ajuste"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="hidden">
        <div className="flex items-center justify-between gap-4 overflow-x-auto">
          <div>
            <h2 className={`text-[15px] font-semibold ${T.title}`}>Horizonte mensual</h2>
            <p className={`text-[12px] ${T.muted}`}>Navega por mes y baja al día exacto desde la línea de tiempo.</p>
          </div>
          <div className="flex gap-2 min-w-0 overflow-x-auto pb-1">
            {projection.months.map((month) => {
              const active = month.yearMonth === selectedMonth;
              return (
                <button
                  key={month.yearMonth}
                  onClick={() => setSelectedMonth(month.yearMonth)}
                  className={`min-w-[148px] rounded-xl border px-3 py-2 text-left transition-colors ${
                    active
                      ? 'border-[var(--primary)] bg-[var(--primary)]/6'
                      : 'border-[var(--border)] hover:bg-[var(--surface-alt)]'
                  }`}
                >
                  <div className="text-[12px] font-medium text-[var(--gray-500)]">{fmtYearMonthLong(month.yearMonth)}</div>
                  <div className="mt-1 text-[15px] font-semibold tabular-nums text-[var(--gray-950)]">{fmtCompact(month.closingCash)}</div>
                  <div className="mt-1 text-[11px] text-[var(--gray-400)]">
                    Pendiente {fmtCompact(month.pendingSupplierAmount + month.unpaidScheduledAmount)}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <section className={`${T.section} overflow-hidden`}>
        <div className="border-b border-[var(--border)] px-4 py-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className={`text-[15px] font-semibold ${T.title}`}>
                Timeline financiera {selectedMonthData ? `· ${fmtYearMonthLong(selectedMonthData.yearMonth)}` : ''}
              </h2>
              <p className={`text-[12px] ${T.muted}`}>
                Línea: caja proyectada y mínimo requerido. Barras: presión neta de ingresos contra egresos.
              </p>
            </div>
            <div className="flex flex-col gap-3 lg:items-end">
              <div className="inline-flex w-fit rounded-lg bg-[var(--surface-alt)] p-1 text-[11px] font-medium">
                {SHEET_GRANULARITIES.map((option) => (
                  <button
                    key={option.id}
                    onClick={() => setPlanningGranularity(option.id)}
                    className={`rounded-md px-3 py-1.5 transition-colors ${
                      planningGranularity === option.id
                        ? 'bg-white text-[var(--gray-950)] shadow-sm'
                        : 'text-[var(--gray-500)] hover:text-[var(--gray-950)]'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-4 text-right text-[12px] lg:grid-cols-4">
                <MiniStat label="Cobranza mes" value={monthCollectionsTotal} />
                <MiniStat label="Fijos mes" value={monthFixedTotal} />
                <MiniStat label="Pagos sugeridos" value={monthSupplierTotal} />
                <MiniStat label="Peor caja" value={worstDay?.closingCash ?? 0} accent={worstDay && worstDay.closingCash < 0 ? 'danger' : 'neutral'} />
              </div>
            </div>
          </div>
        </div>

        <div className="px-2 pt-4 sm:px-4">
          <div style={{ height: 360 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={timelineData}
                margin={{ top: 8, right: 20, left: 8, bottom: 8 }}
                onClick={(state) => {
                  const label = (state as { activeLabel?: string } | undefined)?.activeLabel;
                  if (label) {
                    setSelectedDay(label);
                    setSelectedMonth(label.slice(0, 7));
                  }
                }}
              >
                <defs>
                  <pattern id="gastoMinimoStripes" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
                    <rect width="8" height="8" fill="#FEF3C7" />
                    <line x1="0" y1="0" x2="0" y2="8" stroke="#F59E0B" strokeWidth="2.5" opacity="0.85" />
                  </pattern>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={COLOR.grid} vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={(date) => planningGranularity === 'daily'
                    ? shortDayLabel(String(date))
                    : timelineData.find((point) => point.date === date)?.label ?? shortDayLabel(String(date))}
                  tick={{ fontSize: 11, fill: COLOR.tickText }}
                  tickLine={false}
                  axisLine={{ stroke: COLOR.axis }}
                  minTickGap={14}
                />
                <YAxis
                  tickFormatter={(v) => fmtCompact(v)}
                  tick={{ fontSize: 11, fill: COLOR.tickText }}
                  tickLine={false}
                  axisLine={false}
                  width={64}
                />
                <Tooltip
                  content={<TimelineTooltip />}
                  cursor={{ stroke: COLOR.refLine, strokeWidth: 1 }}
                  isAnimationActive={false}
                />
                <ReferenceLine y={0} stroke={COLOR.refLine} strokeDasharray="4 4" />
                {selectedDay && (
                  <ReferenceLine x={selectedDay} stroke={COLOR.warning} strokeDasharray="3 3" />
                )}
                <Area
                  type="stepAfter"
                  dataKey="gastoMinimoOperativo"
                  name="Gasto mínimo operativo"
                  fill="url(#gastoMinimoStripes)"
                  stroke="#F59E0B"
                  strokeWidth={1.5}
                  strokeDasharray="4 2"
                  fillOpacity={0.85}
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="net"
                  name="Flujo neto"
                  radius={[3, 3, 0, 0]}
                  maxBarSize={24}
                >
                  {timelineData.map((point) => (
                    <Cell key={`net-${point.date}`} fill={point.net >= 0 ? COLOR.inflow : COLOR.suppliers} />
                  ))}
                </Bar>
                <Line
                  type="monotone"
                  dataKey="mandatoryReserveRequired"
                  name="Caja mínima requerida"
                  stroke={COLOR.warning}
                  strokeWidth={1.8}
                  strokeDasharray="5 5"
                  dot={false}
                  isAnimationActive
                />
                <Line
                  type="monotone"
                  dataKey="closingCash"
                  name="Caja cierre"
                  stroke={COLOR.opening}
                  strokeWidth={1.8}
                  dot={false}
                  isAnimationActive
                />
                <Line
                  type="monotone"
                  dataKey="freeCash"
                  name="Disponible"
                  stroke={COLOR.cash}
                  strokeWidth={2.2}
                  dot={{ r: 2, fill: COLOR.cash }}
                  activeDot={{ r: 4, fill: COLOR.cash }}
                  isAnimationActive
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        <CashBarStrip rows={planningTimelineRows} />

        <div className="grid gap-3 border-t border-[var(--border)] px-4 py-3 text-[12px] lg:grid-cols-4">
          <SelectedKpi label="Día" value={selectedDayData ? fmtDate(selectedDayData.date) : '—'} />
          <SelectedKpi label="Cobranza" value={selectedDayData ? fmtCurrency(sumAmounts(dayCollections)) : '—'} />
          <SelectedKpi label="Pagos sugeridos" value={selectedDayData ? fmtCurrency(sumAmounts(selectedDayData.supplierPayments)) : '—'} />
          <SelectedKpi label="Disponible cierre" value={selectedDayData ? fmtCurrency(selectedDayData.freeCash) : '—'} />
        </div>
        {selectedDaySheetRow && (
          <ChartDayDrilldown row={selectedDaySheetRow} onAddAdjustment={addAdjustmentRow} />
        )}
      </section>

      <section className={`grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]`}>
        <PlanningLedgerTable
          rows={filteredPlanningLedgerRows}
          allRows={planningLedgerRows}
          selectedId={selectedLedgerItem?.id ?? null}
          selectedIds={selectedLedgerIds}
          importStatus={ledgerImportStatus}
          importPreview={ledgerImportPreview}
          filters={{
            search: ledgerSearch,
            type: ledgerTypeFilter,
            status: ledgerStatusFilter,
            risk: ledgerRiskFilter,
            editableOnly: ledgerEditableOnly,
          }}
          undoAvailable={undoStack.length > 0}
          selectedCount={selectedLedgerRows.length}
          currentUser={currentUser}
          minimumCashPolicy={minimumCashPolicy}
          onSelect={(item) => setSelectedLedgerItemId(item.id)}
          onToggleSelected={(id) => setSelectedLedgerIds((current) => toggleSetValue(current, id))}
          onToggleAllVisible={() => setSelectedLedgerIds((current) => toggleAllVisible(current, filteredPlanningLedgerRows.map((row) => row.id)))}
          onUpdate={updatePlanningLedgerItem}
          onSplitSupplier={(item) => item.supplier && splitSupplierQueueItem(item.supplier)}
          onExport={exportPlanningLedgerCsv}
          onExportXlsx={exportPlanningLedgerXlsx}
          onImport={importPlanningLedgerCsv}
          onApplyImport={applyPlanningLedgerImportPreview}
          onCancelImport={() => setLedgerImportPreview(null)}
          onSearch={setLedgerSearch}
          onTypeFilter={setLedgerTypeFilter}
          onStatusFilter={setLedgerStatusFilter}
          onRiskFilter={setLedgerRiskFilter}
          onEditableOnly={setLedgerEditableOnly}
          onBulkMove={applyBulkMove}
          onBulkComment={applyBulkComment}
          onOptimize={optimizeScenarioCash}
          onUndo={undoLastScenarioChange}
          onRestoreBase={restoreScenarioFromBase}
          onUserChange={setCurrentUser}
          onMinimumCashChange={setMinimumCashPolicy}
        />
        <PlanningDetailPanel
          item={selectedLedgerItem}
          days={projection.days}
          onMoveNextWeek={(item) => item.supplier && moveSupplierQueueItemByDays(item.supplier, 7)}
          onSplitSupplier={(item) => item.supplier && splitSupplierQueueItem(item.supplier)}
          onHalfPayment={(item) => item.supplier && updateSupplierQueueOverride(item.supplier, {
            amountInput: editableAmount(Math.max(0, item.supplier.remainingAmount || item.supplier.invoiceAmount) / 2),
            note: 'Pago parcial 50% desde panel lateral',
          })}
          onLockPayment={(item) => item.supplier && updateSupplierQueueOverride(item.supplier, {
            date: item.supplier.plannedDate ?? item.supplier.dueDate ?? item.scheduledDate,
            amountInput: editableAmount(item.supplier.remainingAmount || item.supplier.plannedAmount || item.supplier.invoiceAmount),
            note: 'No mover',
          })}
        />
      </section>

      <div className={expandedBlocks.has('suppliers') ? 'space-y-6' : 'hidden'}>
        <SupplierPriorityQueue
          rows={supplierQueueRows}
          allRows={projection.supplierQueue}
          overrideRows={supplierOverrideRows}
          selectedMonth={selectedMonth}
          selectedDay={selectedDayData?.date ?? `${selectedMonth}-01`}
          filters={{
            risk: supplierRiskFilter,
            flexibility: supplierFlexFilter,
            bucket: supplierBucketFilter,
            status: supplierStatusFilter,
            credit: supplierCreditFilter,
            date: supplierDateFilter,
          }}
          onChangeRisk={setSupplierRiskFilter}
          onChangeFlexibility={setSupplierFlexFilter}
          onChangeBucket={setSupplierBucketFilter}
          onChangeStatus={setSupplierStatusFilter}
          onChangeCredit={setSupplierCreditFilter}
          onChangeDate={setSupplierDateFilter}
          onOverrideChange={updateSupplierQueueOverride}
          onMoveNextWeek={(item) => moveSupplierQueueItemByDays(item, 7)}
          onHalfPayment={(item) => updateSupplierQueueOverride(item, {
            amountInput: editableAmount(Math.max(0, item.remainingAmount || item.invoiceAmount) / 2),
            note: 'Pago parcial 50% desde cola priorizada',
          })}
          onLockPayment={(item) => updateSupplierQueueOverride(item, {
            date: item.plannedDate ?? item.dueDate ?? selectedDayData?.date ?? `${selectedMonth}-01`,
            amountInput: editableAmount(item.remainingAmount || item.plannedAmount || item.invoiceAmount),
            note: 'No mover',
          })}
          onRemoveOverride={removeSupplierQueueOverride}
        />

      </div>

      <section className={`${expandedBlocks.has('projection') ? T.section : 'hidden'} overflow-hidden`}>
        <div className="flex flex-col gap-3 border-b border-[var(--border)] px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Table2 className="h-4 w-4 text-[var(--gray-400)]" strokeWidth={1.5} />
              <h2 className={`text-[15px] font-semibold ${T.title}`}>Hoja anual editable de proyección</h2>
            </div>
            <p className={`mt-1 text-[12px] ${T.muted}`}>
              Alterna mes o año completo, edita entrada/salida manual y recalcula la corrida con vista diaria, semanal o mensual.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="inline-flex w-fit rounded-lg bg-[var(--surface-alt)] p-1 text-[11px] font-medium">
              {SHEET_SCOPES.map((option) => (
                <button
                  key={option.id}
                  onClick={() => setSheetScope(option.id)}
                  className={`rounded-md px-3 py-1.5 transition-colors ${
                    sheetScope === option.id
                      ? 'bg-white text-[var(--gray-950)] shadow-sm'
                      : 'text-[var(--gray-500)] hover:text-[var(--gray-950)]'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="inline-flex w-fit rounded-lg bg-[var(--surface-alt)] p-1 text-[11px] font-medium">
              {SHEET_GRANULARITIES.map((option) => (
                <button
                  key={option.id}
                  onClick={() => setSheetGranularity(option.id)}
                  className={`rounded-md px-3 py-1.5 transition-colors ${
                    sheetGranularity === option.id
                      ? 'bg-white text-[var(--gray-950)] shadow-sm'
                      : 'text-[var(--gray-500)] hover:text-[var(--gray-950)]'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="grid gap-3 border-b border-[var(--border)] px-4 py-3 sm:grid-cols-2 xl:grid-cols-8">
          <SelectedKpi label="Alcance" value={sheetScope === 'year' ? `${fmtDate(projection.startDate)} - ${fmtDate(projection.endDate)}` : (selectedMonthData ? fmtYearMonthLong(selectedMonthData.yearMonth) : '—')} />
          <SelectedKpi label="Entradas auto" value={fmtCurrency(sheetSummary.autoInflows)} />
          <SelectedKpi label="Entrada editable" value={fmtCurrency(sheetSummary.adjustmentInflows)} />
          <SelectedKpi label="Salidas auto" value={fmtCurrency(sheetSummary.autoOutflows)} />
          <SelectedKpi label="Salida editable" value={fmtCurrency(sheetSummary.adjustmentOutflows)} />
          <SelectedKpi label="Apartado al cierre" value={fmtCurrency(sheetSummary.reserve)} />
          <SelectedKpi label="Disponible al cierre" value={fmtCurrency(sheetSummary.freeCash)} />
          <SelectedKpi label="Faltante de apartado" value={fmtCurrency(sheetSummary.reserveShortfall)} />
        </div>

        <MinimumOperatingExpenseBanner
          summary={minimumExpenseSummary}
          overrides={minimumExpenseOverrides}
          showDetail={showMinimumExpenseDetail}
          onToggleDetail={() => setShowMinimumExpenseDetail((v) => !v)}
          months={projection.months.map((m) => m.yearMonth)}
          editingMonth={editingOverrideMonth}
          overrideDraftAmount={overrideDraftAmount}
          overrideDraftNote={overrideDraftNote}
          onStartEdit={(yearMonth) => {
            setEditingOverrideMonth(yearMonth);
            const existing = minimumExpenseOverrides.find((o) => o.yearMonth === yearMonth);
            setOverrideDraftAmount(existing ? String(existing.amount) : String(Math.round(minimumExpenseSummary.totalMonthly)));
            setOverrideDraftNote(existing?.note ?? '');
          }}
          onCancelEdit={() => {
            setEditingOverrideMonth(null);
            setOverrideDraftAmount('');
            setOverrideDraftNote('');
          }}
          onChangeDraftAmount={setOverrideDraftAmount}
          onChangeDraftNote={setOverrideDraftNote}
          onSaveOverride={() => {
            if (!editingOverrideMonth) return;
            const parsed = Number(overrideDraftAmount);
            if (!Number.isFinite(parsed) || parsed < 0) return;
            const updatedAt = new Date().toISOString();
            setMinimumExpenseOverrides((current) => {
              const without = current.filter((o) => o.yearMonth !== editingOverrideMonth);
              return [
                ...without,
                {
                  yearMonth: editingOverrideMonth,
                  amount: parsed,
                  note: overrideDraftNote.trim() || undefined,
                  updatedAt,
                },
              ].sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
            });
            setEditingOverrideMonth(null);
            setOverrideDraftAmount('');
            setOverrideDraftNote('');
          }}
          onRemoveOverride={(yearMonth) => {
            setMinimumExpenseOverrides((current) => current.filter((o) => o.yearMonth !== yearMonth));
          }}
        />

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1580px] text-[12px]">
            <thead className="bg-[var(--surface-alt)] text-[var(--gray-500)]">
              <tr>
                <Th>Periodo</Th>
                <Th align="right">Caja inicial</Th>
                <Th align="right">Cobranza</Th>
                <Th align="right">Entrada editable</Th>
                <Th align="right">Otros ingresos</Th>
                <Th align="right">Pagos fijos</Th>
                <Th align="right">Proveedores</Th>
                <Th align="right">Salida editable</Th>
                <Th align="right">Neto</Th>
                <Th align="right">Apartado obligatorio</Th>
                <Th align="right">Disponible</Th>
                <Th align="right">Caja cierre</Th>
                <Th align="center">Alertas</Th>
              </tr>
            </thead>
            <tbody>
              {sheetRows.length === 0 ? (
                <tr>
                  <td colSpan={13} className="px-4 py-6">
                    <EmptyMiniState label="No hay datos para construir la vista de proyección." />
                  </td>
                </tr>
              ) : (
                sheetRows.map((row) => {
                  const expanded = expandedSheetRows.has(row.id);
                  const totalOutflows = row.fixedOutflows + row.supplierPayments + row.adjustmentOutflows;
                  const canEditRow = projectionAdjustmentDate(row) !== null;
                  // Piso operativo prorrateado para esta fila
                  const rowYearMonth = row.startDate.slice(0, 7);
                  const monthBase = resolveMinimumExpenseForMonth(
                    rowYearMonth,
                    minimumExpenseSummary.totalMonthly,
                    minimumExpenseOverrides,
                  );
                  const proratedMinimum = prorateMinimumExpense(
                    monthBase.amount,
                    row.startDate,
                    row.endDate,
                  );
                  const isMonthOverride = monthBase.isOverride && row.startDate.slice(0, 7) === row.endDate.slice(0, 7);
                  return (
                    <Fragment key={row.id}>
                      <tr
                        onClick={() => toggleSheetRow(row)}
                        className={`cursor-pointer border-t border-[var(--border)] transition-colors ${
                          expanded ? 'bg-[var(--primary)]/5' : 'hover:bg-[var(--surface-alt)]'
                        }`}
                        aria-expanded={expanded}
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-start gap-2">
                            <span className="mt-0.5 text-[var(--gray-400)]">
                              {expanded
                                ? <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.5} />
                                : <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.5} />}
                            </span>
                            <div className="min-w-0">
                              <div className="font-medium text-[var(--gray-950)]">{row.label}</div>
                              <div className="text-[11px] text-[var(--gray-400)]">{row.sublabel}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-[var(--gray-700)]">{fmtCurrency(row.openingCash)}</td>
                        <td className="px-4 py-3 text-right font-medium tabular-nums text-[var(--success)]">{row.collections > 0 ? fmtCurrency(row.collections) : '—'}</td>
                        <td className="px-4 py-2">
                          <EditableProjectionCell
                            value={projectionAdjustmentInputValue(row, 'inflow', adjustmentRows)}
                            protectedValue={protectedAdjustmentTotal(row, 'inflow', adjustmentRows)}
                            tone="success"
                            disabled={!canEditRow}
                            onChange={(value) => setAdjustmentRows((current) => setProjectionAdjustmentTarget(
                              current,
                              row,
                              sheetGranularity,
                              'inflow',
                              value,
                            ))}
                          />
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-[var(--success)]">{row.otherInflows > 0 ? fmtCurrency(row.otherInflows) : '—'}</td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          <div className="text-[var(--warning)]">{row.fixedOutflows > 0 ? fmtCurrency(row.fixedOutflows) : '—'}</div>
                          {proratedMinimum > 0 && (
                            <div
                              className="mt-1 inline-flex flex-col items-end rounded-md bg-yellow-100 px-2 py-1 text-[10px] font-medium text-yellow-900 ring-1 ring-yellow-300"
                              title={`Gasto mínimo de operación (proveedores críticos)${isMonthOverride ? ' — override manual' : ''}`}
                            >
                              <span className="text-[9px] uppercase tracking-wide opacity-70">Piso operativo{isMonthOverride ? ' (manual)' : ''}</span>
                              <span className="tabular-nums">{fmtCurrency(proratedMinimum)}</span>
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-[var(--danger)]">{row.supplierPayments > 0 ? fmtCurrency(row.supplierPayments) : '—'}</td>
                        <td className="px-4 py-2">
                          <EditableProjectionCell
                            value={projectionAdjustmentInputValue(row, 'outflow', adjustmentRows)}
                            protectedValue={protectedAdjustmentTotal(row, 'outflow', adjustmentRows)}
                            tone="danger"
                            disabled={!canEditRow}
                            onChange={(value) => setAdjustmentRows((current) => setProjectionAdjustmentTarget(
                              current,
                              row,
                              sheetGranularity,
                              'outflow',
                              value,
                            ))}
                          />
                        </td>
                        <td className={`px-4 py-3 text-right font-semibold tabular-nums ${row.net >= 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
                          {fmtCurrency(row.net)}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-[var(--warning)]">
                          <div className="font-medium">{row.mandatoryReserve > 0 ? fmtCurrency(row.mandatoryReserve) : '—'}</div>
                          {row.mandatoryReserveShortfall > 0 && (
                            <div className="text-[10px] text-[var(--danger)]">Faltan {fmtCompact(row.mandatoryReserveShortfall)}</div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-medium tabular-nums text-[var(--gray-950)]">{fmtCurrency(row.freeCash)}</td>
                        <td className="px-4 py-3 text-right font-semibold tabular-nums text-[var(--gray-950)]">{fmtCurrency(row.closingCash)}</td>
                        <td className="px-4 py-3 text-center">
                          {row.alertCount > 0 ? (
                            <span className="inline-flex min-w-7 items-center justify-center rounded-full bg-[var(--warning-muted)] px-2 py-1 text-[11px] font-semibold text-[var(--warning)]">
                              {row.alertCount}
                            </span>
                          ) : (
                            <span className="text-[var(--gray-300)]">—</span>
                          )}
                        </td>
                      </tr>
                      {expanded && (
                        <tr key={`${row.id}:detail`} className="border-t border-[var(--border)] bg-[var(--surface-alt)]/70">
                          <td colSpan={13} className="px-4 py-4">
                            <SheetDrilldown row={row} totalOutflows={totalOutflows} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className={`grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_420px]`}>
        <OperatingDailyCalendar
          days={monthDays}
          selectedDay={selectedDayData?.date ?? null}
          lastMove={lastSupplierMove}
          onSelectDay={(date, tab) => {
            setSelectedDay(date);
            if (tab) setDetailTab(tab);
          }}
          onMovePayment={moveSupplierPaymentByKey}
        />

        <div className="space-y-4">
          <section className={`${T.section} p-4`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className={`text-[15px] font-semibold ${T.title}`}>{selectedDayData ? fmtDate(selectedDayData.date) : 'Sin día seleccionado'}</h2>
                <p className={`text-[12px] ${T.muted}`}>
                  Caja apertura {selectedDayData ? fmtCurrency(selectedDayData.openingCash) : '—'} · cierre {selectedDayData ? fmtCurrency(selectedDayData.closingCash) : '—'}
                </p>
              </div>
              <div className="inline-flex rounded-lg bg-[var(--surface-alt)] p-1 text-[11px] font-medium">
                {([
                  { id: 'ingresos', label: 'Ingresos' },
                  { id: 'egresos', label: 'Egresos' },
                  { id: 'alertas', label: 'Alertas' },
                ] as Array<{ id: DayDetailTab; label: string }>).map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setDetailTab(tab.id)}
                    className={`rounded-md px-2.5 py-1 transition-colors ${detailTab === tab.id ? 'bg-white text-[var(--gray-950)] shadow-sm' : 'text-[var(--gray-400)]'}`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            {selectedDayData && detailTab === 'ingresos' && (
              <IncomeDrilldown
                collections={dayCollections}
                otherInflows={selectedOtherInflows}
                date={selectedDayData.date}
                overrideRows={collectionOverrideRows}
                onOverrideChange={updateCollectionOverride}
                onOverrideRemove={removeCollectionOverride}
              />
            )}

            {selectedDayData && detailTab === 'egresos' && (
              <OutflowDrilldown
                supplierPayments={selectedDayData.supplierPayments}
                scheduledOutflows={selectedDayData.scheduledOutflows}
                date={selectedDayData.date}
                supplierOverrideRows={supplierOverrideRows}
                scheduledOverrideRows={scheduledOutflowOverrideRows}
                onSupplierOverrideChange={updateSupplierOverride}
                onSupplierOverrideRemove={removeSupplierOverride}
                onScheduledOverrideChange={updateScheduledOutflowOverride}
                onScheduledOverrideRemove={removeScheduledOutflowOverride}
              />
            )}

            {selectedDayData && detailTab === 'alertas' && (
              <div className="mt-4 space-y-2">
                {selectedDayData.alerts.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[var(--border)] px-3 py-4 text-[12px] text-[var(--gray-400)]">
                    Sin alertas para este día.
                  </div>
                ) : (
                  selectedDayData.alerts.map((alert, index) => (
                    <div key={`${selectedDayData.date}-alert-${index}`} className="rounded-xl border border-[var(--warning)]/20 bg-[var(--warning-muted)] px-3 py-2 text-[12px] text-[var(--gray-700)]">
                      {alert}
                    </div>
                  ))
                )}
              </div>
            )}
          </section>

          <section className={`${T.section} p-4`}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className={`text-[15px] font-semibold ${T.title}`}>Próxima cobranza proyectada</h2>
                <p className={`text-[12px] ${T.muted}`}>Lectura rápida de entradas futuras del horizonte visible.</p>
              </div>
              <Clock3 className="h-4 w-4 text-[var(--gray-400)]" />
            </div>
            <div className="mt-4 space-y-2">
              {upcomingCollections.length === 0 ? (
                <EmptyMiniState label="No hay cobranza futura visible." />
              ) : (
                upcomingCollections.map(({ date, line }, index) => (
                  <FlowRow
                    key={`${date}-${line.id}-${index}`}
                    date={date}
                    title={line.label}
                    subtitle={line.detail ?? 'Cobranza proyectada'}
                    meta={[line.confidence ? `confianza ${line.confidence.toLowerCase()}` : null, line.lagDays != null ? `lag ${line.lagDays}d` : null].filter(Boolean).join(' · ')}
                    amount={line.amount}
                    tone="success"
                  />
                ))
              )}
            </div>
          </section>

          <section className={`${T.section} p-4`}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className={`text-[15px] font-semibold ${T.title}`}>Próximos pagos sugeridos</h2>
                <p className={`text-[12px] ${T.muted}`}>Ordenados por la corrida visible del motor.</p>
              </div>
              <Clock3 className="h-4 w-4 text-[var(--gray-400)]" />
            </div>
            <div className="mt-4 space-y-2">
              {upcomingPayments.length === 0 ? (
                <EmptyMiniState label="No hay pagos sugeridos en el horizonte visible." />
              ) : (
                upcomingPayments.map(({ date, payment }, index) => (
                  <FlowRow
                    key={`${date}-${payment.invoiceKey}-${index}`}
                    date={date}
                    title={payment.providerName}
                    subtitle={`${supplierInvoiceLabel(payment)} · ${supplierPaymentReasonLabel(payment)}`}
                    meta={payment.paymentExplanation}
                    amount={payment.amount}
                    tone={payment.reason === 'due' ? 'danger' : 'warning'}
                  />
                ))
              )}
            </div>
          </section>

          <section className={`${T.section} p-4`}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className={`text-[15px] font-semibold ${T.title}`}>Alertas del mes</h2>
                <p className={`text-[12px] ${T.muted}`}>Lo que sigue abierto en el periodo seleccionado.</p>
              </div>
              <AlertTriangle className="h-4 w-4 text-[var(--warning)]" />
            </div>
            <div className="mt-4 space-y-2">
              {topMonthAlerts.length === 0 ? (
                <EmptyMiniState label="Sin alertas abiertas para este mes." />
              ) : (
                topMonthAlerts.map((entry, index) => (
                  <div key={`${entry.date}-${index}`} className="rounded-xl border border-[var(--border)] px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-[12px] text-[var(--gray-700)]">{entry.alert}</div>
                      <div className="shrink-0 text-[11px] font-medium text-[var(--gray-400)]">{fmtDate(entry.date)}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}

function collectionLines(day: OperatingProjectionDay): OperatingFlowLine[] {
  return day.cashInflows.filter((line) => line.source === 'collections');
}

function sumAmounts(items: Array<{ amount: number }>): number {
  return items.reduce((sum, item) => sum + item.amount, 0);
}

function buildProjectionSheetRows(
  days: OperatingProjectionDay[],
  granularity: SheetGranularity,
): ProjectionSheetRow[] {
  if (granularity === 'daily') {
    return days.map((day) => sheetRowFromDays(
      `day:${day.date}`,
      fmtDate(day.date),
      weekdayLabel(day.date),
      [day],
    ));
  }

  if (granularity === 'weekly') {
    return groupDays(days, (day) => isoWeekKey(day.date))
      .map((days) => {
        const first = days[0];
        const last = days[days.length - 1];
        return sheetRowFromDays(
          `week:${isoWeekKey(first.date)}:${first.date}`,
          `Semana ${isoWeekNumber(first.date)}`,
          `${fmtDate(first.date)} - ${fmtDate(last.date)}`,
          days,
        );
      });
  }

  return groupDays(days, (day) => day.date.slice(0, 7))
    .map((days) => {
      const first = days[0];
      const last = days[days.length - 1];
      const yearMonth = first.date.slice(0, 7);
      return sheetRowFromDays(
        `month:${yearMonth}`,
        fmtYearMonthLong(yearMonth),
        `${fmtDate(first.date)} - ${fmtDate(last.date)}`,
        days,
      );
    });
}

function sheetRowFromDays(
  id: string,
  label: string,
  sublabel: string,
  days: OperatingProjectionDay[],
): ProjectionSheetRow {
  const first = days[0];
  const last = days[days.length - 1];
  const collections = days.reduce((sum, day) => sum + sumAmounts(collectionLines(day)), 0);
  const totalInflows = days.reduce((sum, day) => sum + sumAmounts(day.cashInflows), 0);
  const adjustmentInflows = days.reduce((sum, day) => (
    sum + sumAmounts(day.cashInflows.filter((line) => line.source === 'adjustment'))
  ), 0);
  const totalScheduledOutflows = days.reduce((sum, day) => sum + sumAmounts(day.scheduledOutflows), 0);
  const adjustmentOutflows = days.reduce((sum, day) => (
    sum + sumAmounts(day.scheduledOutflows.filter((line) => line.source === 'adjustment'))
  ), 0);
  const fixedOutflows = Math.max(0, totalScheduledOutflows - adjustmentOutflows);
  const supplierPayments = days.reduce((sum, day) => sum + sumAmounts(day.supplierPayments), 0);
  return {
    id,
    label,
    sublabel,
    startDate: first.date,
    endDate: last.date,
    days,
    openingCash: first.openingCash,
    collections,
    otherInflows: Math.max(0, totalInflows - collections - adjustmentInflows),
    adjustmentInflows,
    fixedOutflows,
    adjustmentOutflows,
    supplierPayments,
    net: totalInflows - totalScheduledOutflows - supplierPayments,
    mandatoryReserve: last.mandatoryReserve,
    mandatoryReserveRequired: last.mandatoryReserveRequired,
    mandatoryReserveShortfall: days.reduce((max, day) => Math.max(max, day.mandatoryReserveShortfall), 0),
    freeCash: last.freeCash,
    closingCash: last.closingCash,
    alertCount: days.reduce((sum, day) => sum + day.alerts.length, 0),
  };
}

function groupDays(
  days: OperatingProjectionDay[],
  keyForDay: (day: OperatingProjectionDay) => string,
): OperatingProjectionDay[][] {
  const groups = new Map<string, OperatingProjectionDay[]>();
  for (const day of days) {
    const key = keyForDay(day);
    const bucket = groups.get(key) ?? [];
    bucket.push(day);
    groups.set(key, bucket);
  }
  return Array.from(groups.values());
}

function summarizeSheetRows(rows: ProjectionSheetRow[]): {
  inflows: number;
  autoInflows: number;
  adjustmentInflows: number;
  outflows: number;
  autoOutflows: number;
  adjustmentOutflows: number;
  reserve: number;
  freeCash: number;
  reserveShortfall: number;
} {
  const last = rows.length > 0 ? rows[rows.length - 1] : null;
  const autoInflows = rows.reduce((sum, row) => sum + row.collections + row.otherInflows, 0);
  const adjustmentInflows = rows.reduce((sum, row) => sum + row.adjustmentInflows, 0);
  const autoOutflows = rows.reduce((sum, row) => sum + row.fixedOutflows + row.supplierPayments, 0);
  const adjustmentOutflows = rows.reduce((sum, row) => sum + row.adjustmentOutflows, 0);
  return {
    inflows: autoInflows + adjustmentInflows,
    autoInflows,
    adjustmentInflows,
    outflows: autoOutflows + adjustmentOutflows,
    autoOutflows,
    adjustmentOutflows,
    reserve: last?.mandatoryReserve ?? 0,
    freeCash: last?.freeCash ?? 0,
    reserveShortfall: rows.reduce((max, row) => Math.max(max, row.mandatoryReserveShortfall), 0),
  };
}

function weekdayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'][d.getUTCDay()];
}

function isoWeekKey(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function isoWeekNumber(date: string): number {
  return Number(isoWeekKey(date).slice(-2));
}

function shortDayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return `${String(d.getUTCDate()).padStart(2, '0')} ${['D', 'L', 'M', 'M', 'J', 'V', 'S'][d.getUTCDay()]}`;
}

function buildMandatoryPaymentSheetRows(
  monthDays: OperatingProjectionDay[],
  manualRows: ManualEventRow[],
  selectedMonth: string,
): MandatoryPaymentSheetRow[] {
  const rowDates = new Set<string>();
  for (const day of monthDays) {
    const d = new Date(`${day.date}T12:00:00Z`);
    if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) rowDates.add(day.date);
  }
  for (const row of manualRows) {
    if (row.date.startsWith(selectedMonth) && row.concept !== TAX_MANUAL_CONCEPT) rowDates.add(row.date);
  }

  return Array.from(rowDates).sort().map((date) => ({
    date,
    label: weekdayLabel(date),
    total: OBLIGATION_MANUAL_CONCEPTS.reduce(
      (sum, concept) => sum + manualCellTotal(manualRows, date, concept, true),
      0,
    ),
  }));
}

function buildTaxPaymentSheetRows(
  days: OperatingProjectionDay[],
  manualRows: ManualEventRow[],
  granularity: SheetGranularity,
): TaxPaymentSheetRow[] {
  const rows = buildProjectionSheetRows(days, granularity);
  return rows.map((row) => {
    const effectiveDate = taxEffectiveDate(row);
    const manualTaxAmount = taxPeriodTotal(manualRows, row.startDate, row.endDate, true);
    const protectedTaxAmount = taxPeriodTotal(manualRows, row.startDate, row.endDate, false);
    const paidTaxOutflows = taxOutflowsForDays(row.days);
    const taxAmount = manualTaxAmount > 0 ? manualTaxAmount : paidTaxOutflows;
    const operatingOutflows = Math.max(0, row.fixedOutflows + row.adjustmentOutflows - paidTaxOutflows);
    return {
      id: `tax:${row.id}`,
      label: row.label,
      sublabel: row.sublabel,
      startDate: row.startDate,
      endDate: row.endDate,
      effectiveDate,
      days: row.days,
      taxAmount,
      protectedTaxAmount,
      collections: row.collections + row.otherInflows + row.adjustmentInflows,
      operatingOutflows,
      supplierPayments: row.supplierPayments,
      freeCash: row.freeCash,
      closingCash: row.closingCash,
      alertCount: row.alertCount,
    };
  });
}

function taxOutflowsForDays(days: OperatingProjectionDay[]): number {
  return days.reduce((sum, day) => (
    sum + day.scheduledOutflows
      .filter((line) => normalizeLabel(line.category).includes('IMPUEST') || normalizeLabel(line.label).includes('IMPUEST'))
      .reduce((lineSum, line) => lineSum + line.amount, 0)
  ), 0);
}

function summarizeTaxSheetRows(rows: TaxPaymentSheetRow[]): {
  taxAmount: number;
  protectedTaxAmount: number;
  closingCash: number;
  alertCount: number;
} {
  const last = rows.length > 0 ? rows[rows.length - 1] : null;
  return {
    taxAmount: rows.reduce((sum, row) => sum + row.taxAmount, 0),
    protectedTaxAmount: rows.reduce((sum, row) => sum + row.protectedTaxAmount, 0),
    closingCash: last?.closingCash ?? 0,
    alertCount: rows.reduce((sum, row) => sum + row.alertCount, 0),
  };
}

function calculateProjectionConfidence(
  projection: ReturnType<typeof buildOperatingProjection>,
  taxDebtSummary: OperatingTaxDebtSummary,
): ProjectionConfidence {
  const alertPenalty = Math.min(25, projection.days.reduce((sum, day) => sum + day.alerts.length, 0) * 2);
  const supplierUnknownPenalty = Math.min(20, projection.supplierQueue.filter((item) => item.flexibility === 'unknown').length);
  const taxPenalty = taxDebtSummary.unscheduled > 0 ? 15 : 0;
  const cashPenalty = projection.summary.peakMandatoryReserveShortfall > 0 ? 20 : 0;
  const score = Math.max(35, Math.round(100 - alertPenalty - supplierUnknownPenalty - taxPenalty - cashPenalty));
  const label = score >= 85 ? 'Alta' : score >= 65 ? 'Media' : 'Baja';
  const detail = `${score}% · ${projection.days.length} días`;
  return { score, label, detail };
}

function compareProjectionScenarios(
  baseProjection: ReturnType<typeof buildOperatingProjection>,
  activeProjection: ReturnType<typeof buildOperatingProjection>,
  selectedMonth: string,
  manualMinimumCash = 0,
): ScenarioComparison {
  const baseDays = baseProjection.days.filter((day) => day.date.startsWith(selectedMonth));
  const activeDays = activeProjection.days.filter((day) => day.date.startsWith(selectedMonth));
  const baseLast = baseDays[baseDays.length - 1] ?? baseProjection.days[baseProjection.days.length - 1] ?? null;
  const activeLast = activeDays[activeDays.length - 1] ?? activeProjection.days[activeProjection.days.length - 1] ?? null;
  const baseRiskDays = baseDays.filter((day) => isRiskDay(day, manualMinimumCash)).length;
  const scenarioRiskDays = activeDays.filter((day) => isRiskDay(day, manualMinimumCash)).length;
  const baseLatePayments = baseLast ? baseLast.pendingSupplierAmount + baseLast.unpaidScheduledAmount : 0;
  const scenarioLatePayments = activeLast ? activeLast.pendingSupplierAmount + activeLast.unpaidScheduledAmount : 0;
  return {
    baseEndingCash: baseLast?.closingCash ?? 0,
    scenarioEndingCash: activeLast?.closingCash ?? 0,
    endingCashDelta: (activeLast?.closingCash ?? 0) - (baseLast?.closingCash ?? 0),
    baseRiskDays,
    scenarioRiskDays,
    riskDaysDelta: scenarioRiskDays - baseRiskDays,
    baseLatePayments,
    scenarioLatePayments,
    latePaymentsDelta: scenarioLatePayments - baseLatePayments,
    baseRiskLabel: riskLabelForScenario(baseRiskDays, baseLatePayments),
    scenarioRiskLabel: riskLabelForScenario(scenarioRiskDays, scenarioLatePayments),
  };
}

function isRiskDay(day: OperatingProjectionDay, manualMinimumCash: number): boolean {
  return day.closingCash < 0
    || day.closingCash < manualMinimumCash
    || day.mandatoryReserveShortfall > 0
    || day.freeCash < 0;
}

function riskLabelForScenario(riskDays: number, latePayments: number): string {
  if (riskDays > 4 || latePayments > 10_000_000) return 'Alto';
  if (riskDays > 0 || latePayments > 0) return 'Medio';
  return 'Controlado';
}

function filterPlanningLedgerRows(
  rows: PlanningLedgerItem[],
  filters: {
    search: string;
    type: 'all' | PlanningLedgerType;
    status: 'all' | PlanningLedgerStatus;
    risk: 'all' | 'Alto' | 'Medio' | 'Bajo';
    editableOnly: boolean;
  },
): PlanningLedgerItem[] {
  const query = normalizeLabel(filters.search);
  return rows.filter((row) => {
    if (filters.type !== 'all' && row.type !== filters.type) return false;
    if (filters.status !== 'all' && row.status !== filters.status) return false;
    if (filters.risk !== 'all' && row.risk !== filters.risk) return false;
    if (filters.editableOnly && !row.editableDate && !row.editableAmount) return false;
    if (!query) return true;
    return normalizeLabel([
      row.entity,
      row.concept,
      row.category,
      row.comment,
      row.origin,
      row.priority,
      row.risk,
      row.flexibility,
      row.scheduledDate,
      row.originalDate,
    ].join(' ')).includes(query);
  });
}

function toggleSetValue(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function toggleAllVisible(current: Set<string>, visibleIds: string[]): Set<string> {
  const next = new Set(current);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => next.has(id));
  for (const id of visibleIds) {
    if (allVisibleSelected) next.delete(id);
    else next.add(id);
  }
  return next;
}

function planningLedgerPatchDetail(
  item: PlanningLedgerItem,
  patch: { date?: string; amountInput?: string; comment?: string },
): string {
  const changes = [
    patch.date !== undefined && patch.date !== item.scheduledDate
      ? `fecha ${fmtDate(item.scheduledDate)} → ${fmtDate(patch.date)}`
      : null,
    patch.amountInput !== undefined && Number(patch.amountInput) !== item.adjustedAmount
      ? `monto ${fmtCompact(item.adjustedAmount)} → ${fmtCompact(Number(patch.amountInput) || 0)}`
      : null,
    patch.comment !== undefined && patch.comment !== item.comment
      ? 'comentario actualizado'
      : null,
  ].filter(Boolean);
  return `${ledgerTypeLabel(item.type)} · ${item.entity} · ${item.concept}${changes.length > 0 ? ` · ${changes.join(' · ')}` : ''}`;
}

function planningLedgerPatchImpact(
  item: PlanningLedgerItem,
  patch: { date?: string; amountInput?: string; comment?: string },
  projection: ReturnType<typeof buildOperatingProjection>,
  manualMinimumCash: number,
): string {
  const targetDate = patch.date ?? item.scheduledDate;
  const targetDay = projection.days.find((day) => day.date === targetDate);
  const amount = patch.amountInput !== undefined && patch.amountInput.trim() !== ''
    ? Number(patch.amountInput)
    : item.adjustedAmount;
  const minimum = Math.max(targetDay?.mandatoryReserveRequired ?? 0, manualMinimumCash);
  const targetRisk = targetDay && isRiskDay(targetDay, manualMinimumCash)
    ? `riesgo en destino: cierre ${fmtCompact(targetDay.closingCash)} vs mínimo ${fmtCompact(minimum)}`
    : 'sin alerta inmediata en destino';
  return `${fmtCompact(Number.isFinite(amount) ? amount : item.adjustedAmount)} · ${targetRisk}`;
}

function buildPlanningLedgerRows({
  monthDays,
  supplierQueue,
  supplierOverrides,
  collectionOverrides,
  scheduledOutflowOverrides,
  taxDebtRows,
  manualRows,
  adjustmentRows,
  selectedMonth,
  scenarioUpdatedAt,
}: {
  monthDays: OperatingProjectionDay[];
  supplierQueue: OperatingSupplierQueueItem[];
  supplierOverrides: SupplierOverrideRow[];
  collectionOverrides: CollectionOverrideRow[];
  scheduledOutflowOverrides: ScheduledOutflowOverrideRow[];
  taxDebtRows: TaxDebtRow[];
  manualRows: ManualEventRow[];
  adjustmentRows: AdjustmentRow[];
  selectedMonth: string;
  scenarioUpdatedAt: string;
}): PlanningLedgerItem[] {
  const rows: PlanningLedgerItem[] = [];
  const overrideByInvoice = new Map<string, SupplierOverrideRow[]>();
  for (const override of supplierOverrides) {
    const bucket = overrideByInvoice.get(override.invoiceKey) ?? [];
    bucket.push(override);
    overrideByInvoice.set(override.invoiceKey, bucket);
  }
  const collectionOverrideByKey = new Map(collectionOverrides.map((row) => [row.sourceKey, row]));
  const scheduledOutflowOverrideByKey = new Map(scheduledOutflowOverrides.map((row) => [row.sourceKey, row]));

  for (const item of supplierQueue) {
    const overrides = overrideByInvoice.get(item.invoiceKey) ?? [];
    const scheduledDate = overrides[0]?.date ?? item.plannedDate ?? item.dueDate ?? `${selectedMonth}-01`;
    if (!scheduledDate.startsWith(selectedMonth) && !(item.dueDate ?? '').startsWith(selectedMonth)) continue;
    const adjustedAmount = overrides.reduce((sum, row) => sum + (Number(row.amountInput) || 0), 0)
      || item.plannedAmount
      || item.remainingAmount;
    rows.push({
      id: `supplier:${item.invoiceKey}`,
      type: 'supplier',
      sourceId: item.invoiceKey,
      originalDate: item.dueDate ?? scheduledDate,
      scheduledDate,
      entity: item.providerName,
      concept: item.invoiceNumber ? `Factura ${item.invoiceNumber}` : 'Factura proveedor',
      category: 'Proveedores',
      originalAmount: item.invoiceAmount,
      adjustedAmount,
      status: supplierStatusToLedgerStatus(item.status),
      priority: priorityBlockLabel(item.priorityBlock),
      risk: item.risk,
      flexibility: supplierFlexibilityLabel(item.flexibility),
      comment: overrides.map((override) => override.note).filter(Boolean).join(' · ') || item.paymentExplanation,
      origin: overrides.length > 0 ? 'Manual' : 'Algoritmo/JDE',
      updatedAt: scenarioUpdatedAt,
      editableDate: true,
      editableAmount: true,
      supplier: item,
    });
  }

  for (const debt of taxDebtRows) {
    for (const payment of debt.plannedPayments) {
      if (!payment.date.startsWith(selectedMonth)) continue;
      rows.push({
        id: `tax:${debt.id}:${payment.id}`,
        type: 'tax',
        sourceId: payment.id,
        parentId: debt.id,
        originalDate: debt.dueDate,
        scheduledDate: payment.date,
        entity: `${debt.fiscalYearInput} · ${debt.taxType}`,
        concept: debt.label,
        category: 'Impuestos',
        originalAmount: Number(debt.outstandingAmountInput) || 0,
        adjustedAmount: Number(payment.amountInput) || 0,
        status: payment.suggested ? 'projected' : 'rescheduled',
        priority: taxPriorityLabel(debt.priority),
        risk: taxLegalRiskLabel(debt.legalRisk),
        flexibility: 'Manual controlado',
        comment: payment.note || debt.comments,
        origin: payment.suggested ? 'Algoritmo sugerido' : 'Manual',
        updatedAt: scenarioUpdatedAt,
        editableDate: true,
        editableAmount: true,
      });
    }
  }

  for (const row of manualRows) {
    if (!row.date.startsWith(selectedMonth)) continue;
    if (row.concept === TAX_MANUAL_CONCEPT) continue;
    const amount = Number(row.amountInput) || 0;
    rows.push({
      id: `manual:${row.id}`,
      type: 'obligation',
      sourceId: row.id,
      originalDate: row.date,
      scheduledDate: row.date,
      entity: row.concept,
      concept: row.label || row.concept,
      category: row.concept,
      originalAmount: amount,
      adjustedAmount: amount,
      status: 'confirmed',
      priority: row.allowPartial ? 'Media' : 'Alta',
      risk: row.allowPartial ? 'Medio' : 'Alto',
      flexibility: row.allowPartial ? 'Puede moverse' : 'No mover',
      comment: row.label,
      origin: isSheetManualRow(row) ? 'Hoja editable' : 'Manual',
      updatedAt: scenarioUpdatedAt,
      editableDate: true,
      editableAmount: true,
    });
  }

  for (const row of adjustmentRows) {
    if (!row.date.startsWith(selectedMonth)) continue;
    const amount = Number(row.amountInput) || 0;
    rows.push({
      id: `adjustment:${row.id}`,
      type: 'adjustment',
      sourceId: row.id,
      originalDate: row.date,
      scheduledDate: row.date,
      entity: row.category,
      concept: row.label || row.category,
      category: row.direction === 'inflow' ? 'Ajuste entrada' : 'Ajuste salida',
      originalAmount: amount,
      adjustedAmount: amount,
      status: 'confirmed',
      priority: 'Manual',
      risk: 'Medio',
      flexibility: 'Editable',
      comment: row.label,
      origin: isSheetAdjustmentRow(row) ? 'Hoja editable' : 'Manual',
      updatedAt: scenarioUpdatedAt,
      editableDate: true,
      editableAmount: true,
    });
  }

  for (const day of monthDays) {
    for (const line of day.cashInflows.filter((entry) => entry.source !== 'adjustment')) {
      const sourceKey = collectionOverrideSourceKey(line);
      const override = collectionOverrideByKey.get(sourceKey);
      rows.push({
        id: `collection:${sourceKey}`,
        type: 'collection',
        sourceId: sourceKey,
        originalDate: line.originalDate ?? line.theoreticalDate ?? day.date,
        scheduledDate: day.date,
        entity: line.label,
        concept: line.invoiceDate ? `Factura proyectada ${fmtDate(line.invoiceDate)}` : (line.detail ?? line.category),
        category: line.category || 'Cobranza',
        originalAmount: line.amount,
        adjustedAmount: line.amount,
        status: override ? 'rescheduled' : 'projected',
        priority: 'Media',
        risk: line.confidence === 'Baja' ? 'Alto' : line.confidence === 'Media' ? 'Medio' : 'Bajo',
        flexibility: 'Editable por escenario',
        comment: override?.note || line.overrideNote || line.detail || '',
        origin: override ? 'Manual' : line.source === 'collections' ? 'Algoritmo/JDE' : sourceLabel(line.source),
        updatedAt: scenarioUpdatedAt,
        editableDate: true,
        editableAmount: true,
        collectionLine: line,
      });
    }
    for (const line of day.scheduledOutflows.filter((entry) => entry.source !== 'adjustment')) {
      if (normalizeLabel(line.category).includes('IMPUEST')) continue;
      const sourceKey = scheduledOutflowOverrideSourceKey(line);
      const override = scheduledOutflowOverrideByKey.get(sourceKey);
      rows.push({
        id: `fixed:${day.date}:${sourceKey}`,
        type: 'fixed',
        sourceId: sourceKey,
        originalDate: line.originalDate ?? line.theoreticalDate ?? day.date,
        scheduledDate: day.date,
        entity: line.category,
        concept: line.label,
        category: line.category,
        originalAmount: line.amount,
        adjustedAmount: line.amount,
        status: override ? 'rescheduled' : 'projected',
        priority: 'Alta',
        risk: 'Medio',
        flexibility: line.source === 'fixed' ? 'Regla fija' : 'Editable por escenario',
        comment: override?.note || line.overrideNote || line.detail || '',
        origin: override ? 'Manual' : sourceLabel(line.source),
        updatedAt: scenarioUpdatedAt,
        editableDate: true,
        editableAmount: true,
        outflowLine: line,
      });
    }
  }

  return rows
    .sort((a, b) => {
      const dateDelta = a.scheduledDate.localeCompare(b.scheduledDate);
      if (dateDelta !== 0) return dateDelta;
      const typeDelta = ledgerTypeOrder(a.type) - ledgerTypeOrder(b.type);
      if (typeDelta !== 0) return typeDelta;
      return Math.abs(b.adjustedAmount) - Math.abs(a.adjustedAmount);
    });
}

const PROGRAMACION_HEADERS = [
  'id',
  'tipo',
  'direccion',
  'fecha_programada',
  'monto',
  'entidad',
  'concepto',
  'categoria',
  'comentario',
  'estatus',
  'prioridad',
  'riesgo',
  'flexibilidad',
  'fecha_original',
  'monto_original',
  'origen',
  'editable',
] as const;

type ProgramacionHeader = (typeof PROGRAMACION_HEADERS)[number];

const TIMELINE_HEADERS = [
  'fecha',
  'dia_semana',
  'caja_inicial',
  'ingresos',
  'egresos_fijos',
  'pagos_proveedor',
  'ajustes_neto',
  'caja_minima',
  'caja_final',
  'disponible',
  'alertas',
  'top_movimientos',
] as const;

const LEDGER_TYPE_TO_LABEL: Record<PlanningLedgerType, string> = {
  collection: 'Cobranza',
  supplier: 'Proveedor',
  tax: 'Impuesto',
  obligation: 'Obligación',
  adjustment: 'Ajuste',
  fixed: 'Fijo',
};

const LEDGER_LABEL_TO_TYPE: Record<string, PlanningLedgerType> = {
  COBRANZA: 'collection',
  COBRO: 'collection',
  COLLECTION: 'collection',
  INGRESO: 'collection',
  INGRESOS: 'collection',
  PROVEEDOR: 'supplier',
  PROVEEDORES: 'supplier',
  SUPPLIER: 'supplier',
  IMPUESTO: 'tax',
  IMPUESTOS: 'tax',
  TAX: 'tax',
  OBLIGACION: 'obligation',
  OBLIGACIONES: 'obligation',
  OBLIGATION: 'obligation',
  AJUSTE: 'adjustment',
  AJUSTES: 'adjustment',
  ADJUSTMENT: 'adjustment',
  FIJO: 'fixed',
  FIJOS: 'fixed',
  FIXED: 'fixed',
  EGRESO_FIJO: 'fixed',
};

function parseLedgerTypeLabel(value: string | undefined): PlanningLedgerType | null {
  if (!value) return null;
  const key = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .toUpperCase();
  return LEDGER_LABEL_TO_TYPE[key] ?? null;
}

function parseAdditionDirection(value: string | undefined): 'inflow' | 'outflow' | null {
  if (!value) return null;
  const key = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
  if (key === 'INFLOW' || key === 'ENTRADA' || key === 'INGRESO') return 'inflow';
  if (key === 'OUTFLOW' || key === 'SALIDA' || key === 'EGRESO') return 'outflow';
  return null;
}

function buildPlanningLedgerCsv({
  ledgerRows,
  scenarioName,
  comparison,
}: {
  ledgerRows: PlanningLedgerItem[];
  scenarioName: string;
  comparison: ScenarioComparison;
}): string {
  const header = PROGRAMACION_HEADERS.map(String);
  const meta = [
    `# Senda · Programación operativa`,
    `# Escenario: ${scenarioName}`,
    `# Caja final delta vs base: ${fmtCompact(comparison.endingCashDelta)} · días bajo mínimo: ${comparison.riskDaysDelta} · pagos atrasados: ${fmtCompact(comparison.latePaymentsDelta)}`,
    `# Edita 'fecha_programada', 'monto', 'comentario' o 'estatus'. Para ALTAS deja 'id' vacío y completa 'tipo' (Ajuste u Obligación), 'direccion', 'fecha_programada', 'monto' y 'concepto'.`,
  ];
  const rows: string[][] = [
    [meta.join(' | ')],
    header,
    ...ledgerRows.map((row) => programacionRow(row)),
  ];
  return `\uFEFF${rows.map((row) => row.map(csvEscape).join(';')).join('\n')}`;
}

function programacionRow(row: PlanningLedgerItem): string[] {
  const direction = ledgerDirection(row);
  const editable = !row.editableDate && !row.editableAmount
    ? 'Solo lectura'
    : row.editableAmount
      ? 'Sí'
      : 'Solo fecha';
  const values: Record<ProgramacionHeader, string | number> = {
    id: row.id,
    tipo: LEDGER_TYPE_TO_LABEL[row.type],
    direccion: direction,
    fecha_programada: row.scheduledDate,
    monto: row.adjustedAmount,
    entidad: row.entity,
    concepto: row.concept,
    categoria: row.category,
    comentario: row.comment ?? '',
    estatus: ledgerStatusLabel(row.status),
    prioridad: row.priority,
    riesgo: row.risk,
    flexibilidad: row.flexibility,
    fecha_original: row.originalDate,
    monto_original: row.originalAmount,
    origen: row.origin,
    editable,
  };
  return PROGRAMACION_HEADERS.map((header) => {
    const value = values[header];
    if (value == null) return '';
    return typeof value === 'number' ? String(roundCsvNumber(value)) : value;
  });
}

function ledgerDirection(row: PlanningLedgerItem): 'inflow' | 'outflow' {
  if (row.type === 'collection') return 'inflow';
  if (row.type === 'adjustment') {
    return row.category.toLowerCase().includes('entrada') ? 'inflow' : 'outflow';
  }
  return 'outflow';
}

function roundCsvNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

function csvEscape(value: string): string {
  if (/[;"\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function parsePlanningLedgerCsv(text: string): PlanningLedgerCsvRow[] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  const headerIndex = rows.findIndex((row) => row.some((cell) => {
    const value = normalizeCsvHeader(cell);
    return value === 'tipo' || value === 'row_type';
  }));
  if (headerIndex < 0) {
    throw new Error("El CSV no tiene encabezado 'tipo'. Descarga la plantilla desde la tabla antes de editar.");
  }
  const headers = rows[headerIndex].map(normalizeCsvHeader);
  if (headers.includes('row_type')) {
    return parseLegacyMovimientosCsv(rows, headers, headerIndex);
  }
  const data = rows.slice(headerIndex + 1).map((row) => row.map(normalizeCsvValue));
  return parseProgramacionRows(data, headers);
}

function parseLegacyMovimientosCsv(
  rows: string[][],
  headers: string[],
  headerIndex: number,
): PlanningLedgerCsvRow[] {
  const rowTypeIndex = headers.indexOf('row_type');
  const idIndex = headers.indexOf('id');
  const dateIndex = headers.indexOf('fecha_programada');
  const amountIndex = headers.indexOf('monto_ajustado');
  const commentIndex = headers.indexOf('comentario');
  if (idIndex < 0 || dateIndex < 0 || amountIndex < 0) {
    throw new Error('El CSV legacy no tiene columnas necesarias: id, fecha_programada y monto_ajustado.');
  }
  const parsed: PlanningLedgerCsvRow[] = [];
  for (const row of rows.slice(headerIndex + 1)) {
    const rowType = normalizeCsvValue(row[rowTypeIndex]);
    if (rowType !== 'movimiento') continue;
    const id = normalizeCsvValue(row[idIndex]);
    if (!id) continue;
    const amountRaw = normalizeCsvValue(row[amountIndex]);
    const amount = amountRaw ? parseCsvAmount(amountRaw) : undefined;
    parsed.push({
      id,
      scheduledDate: normalizeCsvValue(row[dateIndex]) || undefined,
      adjustedAmount: amount,
      comment: commentIndex >= 0 ? normalizeCsvValue(row[commentIndex]) : undefined,
    });
  }
  return parsed;
}

function parseProgramacionRows(
  rows: string[][],
  headers: string[],
): PlanningLedgerCsvRow[] {
  const idIndex = headers.indexOf('id');
  const tipoIndex = headers.indexOf('tipo');
  const direccionIndex = headers.indexOf('direccion');
  const dateIndex = headers.indexOf('fecha_programada');
  const amountIndex = headers.indexOf('monto');
  const entityIndex = headers.indexOf('entidad');
  const conceptIndex = headers.indexOf('concepto');
  const categoryIndex = headers.indexOf('categoria');
  const commentIndex = headers.indexOf('comentario');
  if (tipoIndex < 0 || dateIndex < 0 || amountIndex < 0) {
    throw new Error("La hoja Programaci\u00f3n necesita las columnas 'tipo', 'fecha_programada' y 'monto'.");
  }
  const parsed: PlanningLedgerCsvRow[] = [];
  for (const row of rows) {
    if (row.every((cell) => !cell)) continue;
    const id = idIndex >= 0 ? normalizeCsvValue(row[idIndex]) : '';
    const dateRaw = normalizeCsvValue(row[dateIndex]);
    const amountRaw = normalizeCsvValue(row[amountIndex]);
    const commentRaw = commentIndex >= 0 ? normalizeCsvValue(row[commentIndex]) : '';
    if (id) {
      parsed.push({
        id,
        scheduledDate: dateRaw || undefined,
        adjustedAmount: amountRaw ? parseCsvAmount(amountRaw) : undefined,
        comment: commentRaw || undefined,
      });
      continue;
    }
    const tipo = parseLedgerTypeLabel(normalizeCsvValue(row[tipoIndex]));
    if (!tipo) continue;
    if (tipo !== 'adjustment' && tipo !== 'obligation') continue;
    const amount = amountRaw ? parseCsvAmount(amountRaw) : undefined;
    if (!dateRaw || !/^\d{4}-\d{2}-\d{2}$/.test(dateRaw) || amount == null || amount <= 0) continue;
    const direction = parseAdditionDirection(direccionIndex >= 0 ? normalizeCsvValue(row[direccionIndex]) : undefined);
    parsed.push({
      id: '',
      isAddition: true,
      additionType: tipo,
      additionDirection: direction ?? 'outflow',
      additionEntity: entityIndex >= 0 ? normalizeCsvValue(row[entityIndex]) : undefined,
      additionConcept: conceptIndex >= 0 ? normalizeCsvValue(row[conceptIndex]) : undefined,
      additionCategory: categoryIndex >= 0 ? normalizeCsvValue(row[categoryIndex]) : undefined,
      scheduledDate: dateRaw,
      adjustedAmount: amount,
      comment: commentRaw || undefined,
    });
  }
  return parsed;
}

type ExcelJsRuntime = {
  Workbook: new () => ExcelJS.Workbook;
};

async function loadExcelJsRuntime(): Promise<ExcelJsRuntime> {
  const module = await import('exceljs');
  return ((module as { default?: ExcelJsRuntime }).default ?? module) as ExcelJsRuntime;
}

async function buildPlanningLedgerWorkbook(
  ExcelRuntime: ExcelJsRuntime,
  {
  days,
  ledgerRows,
  scenarioName,
  comparison,
  importPreview,
  minimumCash,
}: {
  days: OperatingProjectionDay[];
  ledgerRows: PlanningLedgerItem[];
  scenarioName: string;
  comparison: ScenarioComparison;
  importPreview: PlanningLedgerImportPreview | null;
  minimumCash: number;
}): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelRuntime.Workbook();
  workbook.creator = 'Senda';
  workbook.created = new Date();
  workbook.modified = new Date();

  const intro = workbook.addWorksheet('Instrucciones', { views: [{ state: 'frozen', ySplit: 1 }] });
  intro.addRow(['Senda · Programación operativa']);
  intro.getRow(1).font = { bold: true, size: 14 };
  intro.addRow([`Escenario: ${scenarioName}`]);
  intro.addRow([
    `Caja final delta vs base: ${fmtCompact(comparison.endingCashDelta)} | Días bajo mínimo: ${comparison.riskDaysDelta} | Pagos atrasados: ${fmtCompact(comparison.latePaymentsDelta)}`,
  ]);
  intro.addRow([]);
  intro.addRow(['Cómo editar y subir cambios:']);
  intro.addRow(['1. Edita la hoja Programación. Cambia "fecha_programada", "monto", "comentario" o "estatus".']);
  intro.addRow(['2. Para programar un movimiento NUEVO, deja el campo "id" vacío y completa "tipo", "direccion" (entrada/salida), "fecha_programada", "monto" y "concepto".']);
  intro.addRow(['3. Tipos disponibles para altas: "Ajuste" (entrada o salida libre) u "Obligación" (CAPEX, Finiquitos, Pasivos Financieros, Impuestos).']);
  intro.addRow(['4. Sube el archivo en la app: se creará un escenario nuevo con tus cambios y se activará automáticamente.']);
  intro.addRow([]);
  intro.addRow(['Hojas:']);
  intro.addRow(['  Programación → editable. 1 fila por movimiento.']);
  intro.addRow(['  Línea de tiempo → resumen de caja día por día (solo lectura).']);
  intro.addRow(['  Comparativo → métricas de este escenario contra el base.']);
  intro.addRow(['  Errores → si hubo carga previa, aquí ves qué se ignoró y por qué.']);
  setExcelColumnWidths(intro, [120]);

  const programacion = workbook.addWorksheet('Programación', { views: [{ state: 'frozen', ySplit: 1 }] });
  programacion.addRow([...PROGRAMACION_HEADERS]);
  for (const row of ledgerRows) {
    programacion.addRow(programacionRow(row));
  }
  styleExcelHeader(programacion, 1);
  programacion.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, programacion.rowCount), column: PROGRAMACION_HEADERS.length },
  };
  setExcelColumnWidths(programacion, [
    32, 14, 12, 14, 16, 28, 36, 22, 36, 14, 12, 12, 18, 14, 16, 18, 14,
  ]);
  const montoCol = PROGRAMACION_HEADERS.indexOf('monto') + 1;
  const montoOrigCol = PROGRAMACION_HEADERS.indexOf('monto_original') + 1;
  formatExcelMoneyColumns(programacion, [montoCol, montoOrigCol]);
  addProgramacionValidations(programacion);

  const timeline = workbook.addWorksheet('Línea de tiempo', { views: [{ state: 'frozen', ySplit: 1 }] });
  timeline.addRow([...TIMELINE_HEADERS]);
  for (const day of days) {
    const ingresos = day.cashInflows.reduce((sum, line) => sum + line.amount, 0);
    const egresosFijos = day.scheduledOutflows
      .filter((line) => line.source !== 'adjustment')
      .reduce((sum, line) => sum + line.amount, 0);
    const ajustesEntrada = day.cashInflows
      .filter((line) => line.source === 'adjustment')
      .reduce((sum, line) => sum + line.amount, 0);
    const ajustesSalida = day.scheduledOutflows
      .filter((line) => line.source === 'adjustment')
      .reduce((sum, line) => sum + line.amount, 0);
    const supplierPayments = day.supplierPayments.reduce((sum, line) => sum + line.amount, 0);
    const top = topMovementsForDay(day);
    timeline.addRow([
      day.date,
      weekdayLabel(day.date),
      roundCsvNumber(day.openingCash),
      roundCsvNumber(ingresos),
      roundCsvNumber(egresosFijos),
      roundCsvNumber(supplierPayments),
      roundCsvNumber(ajustesEntrada - ajustesSalida),
      roundCsvNumber(Math.max(day.mandatoryReserveRequired, minimumCash)),
      roundCsvNumber(day.closingCash),
      roundCsvNumber(day.freeCash),
      day.alerts.length,
      top,
    ]);
  }
  styleExcelHeader(timeline, 1);
  setExcelColumnWidths(timeline, [12, 12, 16, 16, 16, 16, 16, 16, 16, 16, 10, 60]);
  formatExcelMoneyColumns(timeline, [3, 4, 5, 6, 7, 8, 9, 10]);

  const comparisonSheet = workbook.addWorksheet('Comparativo', { views: [{ state: 'frozen', ySplit: 1 }] });
  comparisonSheet.addRow(['Metrica', 'Base', 'Escenario', 'Diferencia']);
  comparisonSheet.addRow(['Caja final', comparison.baseEndingCash, comparison.scenarioEndingCash, comparison.endingCashDelta]);
  comparisonSheet.addRow(['Días bajo caja mínima', comparison.baseRiskDays, comparison.scenarioRiskDays, comparison.riskDaysDelta]);
  comparisonSheet.addRow(['Pagos atrasados', comparison.baseLatePayments, comparison.scenarioLatePayments, comparison.latePaymentsDelta]);
  comparisonSheet.addRow(['Riesgo', comparison.baseRiskLabel, comparison.scenarioRiskLabel, '']);
  styleExcelHeader(comparisonSheet, 1);
  setExcelColumnWidths(comparisonSheet, [28, 18, 18, 18]);
  formatExcelMoneyColumns(comparisonSheet, [2, 3, 4]);

  const errors = workbook.addWorksheet('Errores', { views: [{ state: 'frozen', ySplit: 1 }] });
  errors.addRow(['archivo', 'id', 'tipo', 'campo', 'antes', 'despues', 'severidad', 'mensaje']);
  if (importPreview) {
    for (const change of importPreview.changes) {
      errors.addRow([
        importPreview.fileName,
        change.id,
        ledgerTypeLabel(change.type),
        change.field,
        change.before,
        change.after,
        change.severity,
        change.message,
      ]);
    }
    for (const error of importPreview.errors) {
      errors.addRow([importPreview.fileName, '', '', '', '', '', 'danger', error]);
    }
  }
  styleExcelHeader(errors, 1);
  setExcelColumnWidths(errors, [28, 42, 18, 14, 18, 18, 12, 64]);

  return workbook;
}

function topMovementsForDay(day: OperatingProjectionDay): string {
  type Entry = { label: string; amount: number; sign: 1 | -1 };
  const entries: Entry[] = [];
  for (const line of day.cashInflows) entries.push({ label: line.label, amount: line.amount, sign: 1 });
  for (const line of day.scheduledOutflows) entries.push({ label: line.label, amount: line.amount, sign: -1 });
  for (const line of day.supplierPayments) entries.push({ label: line.providerName, amount: line.amount, sign: -1 });
  entries.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  return entries
    .slice(0, 3)
    .map((entry) => `${entry.sign === 1 ? '+' : '-'}${fmtCompact(entry.amount)} ${entry.label}`)
    .join(' · ');
}

function addProgramacionValidations(worksheet: ExcelJS.Worksheet): void {
  const tipoColumn = PROGRAMACION_HEADERS.indexOf('tipo') + 1;
  const direccionColumn = PROGRAMACION_HEADERS.indexOf('direccion') + 1;
  const dateColumn = PROGRAMACION_HEADERS.indexOf('fecha_programada') + 1;
  const amountColumn = PROGRAMACION_HEADERS.indexOf('monto') + 1;
  const statusColumn = PROGRAMACION_HEADERS.indexOf('estatus') + 1;
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const tipoCell = worksheet.getRow(rowNumber).getCell(tipoColumn);
    tipoCell.dataValidation = {
      type: 'list',
      allowBlank: false,
      formulae: ['"Cobranza,Proveedor,Impuesto,Obligación,Ajuste,Fijo"'],
    };
    worksheet.getRow(rowNumber).getCell(direccionColumn).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['"inflow,outflow,entrada,salida"'],
    };
    worksheet.getRow(rowNumber).getCell(dateColumn).note = 'Editable: cambia la fecha YYYY-MM-DD y vuelve a subir el archivo.';
    worksheet.getRow(rowNumber).getCell(amountColumn).note = 'Editable: cambia el monto. Usa 0 para patear o dejar sin pago.';
    worksheet.getRow(rowNumber).getCell(statusColumn).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['"Proyectado,Confirmado,Pagado,Vencido,Reprogramado,Parcial,Sin programar"'],
    };
  }
}

async function parsePlanningLedgerXlsx(file: File): Promise<PlanningLedgerCsvRow[]> {
  const ExcelRuntime = await loadExcelJsRuntime();
  const workbook = new ExcelRuntime.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());

  const programacion = workbook.getWorksheet('Programación')
    ?? workbook.worksheets.find((sheet) => worksheetHasHeader(sheet, 'tipo') && !worksheetHasHeader(sheet, 'row_type'));
  if (programacion) {
    return parseProgramacionXlsxSheet(programacion);
  }

  const legacy = workbook.getWorksheet('Movimientos')
    ?? workbook.worksheets.find((sheet) => worksheetHasHeader(sheet, 'row_type'));
  if (!legacy) {
    throw new Error("El XLSX no tiene hoja Programación con encabezado 'tipo'. Descarga la plantilla antes de editar.");
  }
  return parseLegacyMovimientosXlsxSheet(legacy);
}

function parseProgramacionXlsxSheet(worksheet: ExcelJS.Worksheet): PlanningLedgerCsvRow[] {
  const headerRowNumber = findExcelHeaderRow(worksheet, 'tipo');
  if (!headerRowNumber) {
    throw new Error("La hoja Programación no tiene encabezado 'tipo'.");
  }
  const headerRow = worksheet.getRow(headerRowNumber);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    headers[columnNumber - 1] = normalizeCsvHeader(excelCellToText(cell.value));
  });
  const dataRows: string[][] = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRowNumber) return;
    const cells: string[] = [];
    for (let column = 1; column <= headers.length; column += 1) {
      cells[column - 1] = normalizeCsvValue(excelCellToText(row.getCell(column).value));
    }
    dataRows.push(cells);
  });
  return parseProgramacionRows(dataRows, headers);
}

function parseLegacyMovimientosXlsxSheet(worksheet: ExcelJS.Worksheet): PlanningLedgerCsvRow[] {
  const headerRowNumber = findExcelHeaderRow(worksheet, 'row_type');
  if (!headerRowNumber) {
    throw new Error('El XLSX legacy no tiene encabezado row_type. Descarga la plantilla antes de editar.');
  }

  const headerRow = worksheet.getRow(headerRowNumber);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    headers[columnNumber - 1] = normalizeCsvHeader(excelCellToText(cell.value));
  });

  const rowTypeIndex = headers.indexOf('row_type') + 1;
  const idIndex = headers.indexOf('id') + 1;
  const dateIndex = headers.indexOf('fecha_programada') + 1;
  const amountIndex = headers.indexOf('monto_ajustado') + 1;
  const commentIndex = headers.indexOf('comentario') + 1;
  if (!idIndex || !dateIndex || !amountIndex) {
    throw new Error('El XLSX legacy no tiene columnas necesarias: id, fecha_programada y monto_ajustado.');
  }

  const parsed: PlanningLedgerCsvRow[] = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRowNumber) return;
    const rowType = normalizeCsvValue(excelCellToText(row.getCell(rowTypeIndex).value));
    if (rowType !== 'movimiento') return;
    const id = normalizeCsvValue(excelCellToText(row.getCell(idIndex).value));
    if (!id) return;
    const amountRaw = normalizeCsvValue(excelCellToText(row.getCell(amountIndex).value));
    parsed.push({
      id,
      scheduledDate: normalizeCsvValue(excelCellToText(row.getCell(dateIndex).value)) || undefined,
      adjustedAmount: amountRaw ? parseCsvAmount(amountRaw) : undefined,
      comment: commentIndex > 0 ? normalizeCsvValue(excelCellToText(row.getCell(commentIndex).value)) : undefined,
    });
  });
  return parsed;
}

function buildPlanningLedgerImportPreview(
  fileName: string,
  rows: PlanningLedgerCsvRow[],
  currentRows: PlanningLedgerItem[],
  projection: ReturnType<typeof buildOperatingProjection>,
  manualMinimumCash: number,
): PlanningLedgerImportPreview {
  const currentById = new Map(currentRows.map((row) => [row.id, row]));
  const dayByDate = new Map(projection.days.map((day) => [day.date, day]));
  const changes: PlanningLedgerImportChange[] = [];
  const errors: string[] = [];
  let ignored = 0;

  for (const incoming of rows) {
    if (incoming.isAddition) {
      const additionType = incoming.additionType ?? 'adjustment';
      if (additionType !== 'adjustment' && additionType !== 'obligation') {
        ignored += 1;
        continue;
      }
      if (!incoming.scheduledDate || !/^\d{4}-\d{2}-\d{2}$/.test(incoming.scheduledDate)) {
        errors.push(`Alta inválida: fecha_programada faltante o con formato distinto a YYYY-MM-DD.`);
        continue;
      }
      if (incoming.adjustedAmount == null || !Number.isFinite(incoming.adjustedAmount) || incoming.adjustedAmount <= 0) {
        errors.push(`Alta inválida (${incoming.additionConcept ?? 'sin concepto'}): monto debe ser mayor a 0.`);
        continue;
      }
      const direction = incoming.additionDirection === 'inflow' ? 'inflow' : 'outflow';
      const targetDay = dayByDate.get(incoming.scheduledDate);
      const severity: PlanningLedgerImportChange['severity'] = targetDay && isRiskDay(targetDay, manualMinimumCash) && direction === 'outflow'
        ? 'warning'
        : 'ok';
      changes.push({
        id: `nuevo:${incoming.additionType}:${changes.length}`,
        label: incoming.additionConcept || incoming.additionEntity || (additionType === 'obligation' ? 'Obligación nueva' : 'Ajuste nuevo'),
        type: additionType,
        field: 'alta',
        before: '—',
        after: `${direction === 'inflow' ? 'Entrada' : 'Salida'} ${fmtCurrency(incoming.adjustedAmount)} el ${fmtDate(incoming.scheduledDate)}`,
        severity,
        message: severity === 'warning'
          ? 'Alta programada en día con presión de caja mínima.'
          : 'Movimiento nuevo programado desde la hoja Programación.',
      });
      continue;
    }

    const current = currentById.get(incoming.id);
    if (!current) {
      ignored += 1;
      continue;
    }

    if (incoming.scheduledDate != null && incoming.scheduledDate !== current.scheduledDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(incoming.scheduledDate)) {
        errors.push(`${incoming.id}: fecha_programada inválida (${incoming.scheduledDate}).`);
      } else {
        changes.push(buildDateImportChange(current, incoming.scheduledDate, dayByDate.get(incoming.scheduledDate), manualMinimumCash));
      }
    }

    if (incoming.adjustedAmount != null && Math.abs(incoming.adjustedAmount - current.adjustedAmount) > 0.004) {
      changes.push(buildAmountImportChange(current, incoming.adjustedAmount));
    }

    if (incoming.comment != null && incoming.comment !== current.comment) {
      changes.push({
        id: current.id,
        label: `${current.entity} · ${current.concept}`,
        type: current.type,
        field: 'comentario',
        before: current.comment || 'Sin comentario',
        after: incoming.comment || 'Sin comentario',
        severity: 'ok',
        message: 'Comentario actualizado para documentar el ajuste.',
      });
    }
  }

  return { fileName, rows, changes, ignored, errors };
}

function buildDateImportChange(
  current: PlanningLedgerItem,
  scheduledDate: string,
  targetDay: OperatingProjectionDay | undefined,
  manualMinimumCash: number,
): PlanningLedgerImportChange {
  const blocked = !current.editableDate;
  const movedLater = scheduledDate > current.originalDate;
  let severity: PlanningLedgerImportChange['severity'] = 'ok';
  let message = 'Fecha reprogramada; el escenario conserva la fecha original para auditoría.';

  if (blocked) {
    severity = 'danger';
    message = 'Esta línea no es editable desde la carga; se ignorará al aplicar.';
  } else if (current.type === 'supplier' && current.supplier?.flexibility === 'inamovible') {
    severity = 'danger';
    message = 'Proveedor inamovible: moverlo puede romper operación.';
  } else if (current.type === 'tax' && scheduledDate > current.originalDate) {
    severity = 'danger';
    message = 'Pago fiscal después de fecha límite; requiere aprobación manual.';
  } else if (current.type === 'supplier' && current.risk === 'Alto' && movedLater) {
    severity = 'warning';
    message = 'Proveedor de riesgo alto movido después del vencimiento.';
  } else if (targetDay && isRiskDay(targetDay, manualMinimumCash)) {
    severity = 'warning';
    message = 'La fecha destino ya está bajo presión de caja mínima o reserva obligatoria.';
  }

  return {
    id: current.id,
    label: `${current.entity} · ${current.concept}`,
    type: current.type,
    field: 'fecha',
    before: fmtDate(current.scheduledDate),
    after: fmtDate(scheduledDate),
    severity,
    message,
  };
}

function buildAmountImportChange(
  current: PlanningLedgerItem,
  adjustedAmount: number,
): PlanningLedgerImportChange {
  const blocked = !current.editableAmount;
  let severity: PlanningLedgerImportChange['severity'] = 'ok';
  let message = 'Monto ajustado; el monto original se conserva para comparación.';
  if (blocked) {
    severity = 'danger';
    message = 'Esta línea no permite edición de monto desde carga.';
  } else if (current.type === 'supplier' && current.risk === 'Alto' && adjustedAmount <= 0) {
    severity = 'warning';
    message = 'Pago crítico en cero: puede subir riesgo operativo/proveedor.';
  } else if (current.type === 'tax' && adjustedAmount <= 0) {
    severity = 'warning';
    message = 'Pago fiscal en cero: queda como decisión manual y no activa fallback automático.';
  }

  return {
    id: current.id,
    label: `${current.entity} · ${current.concept}`,
    type: current.type,
    field: 'monto',
    before: fmtCurrency(current.adjustedAmount),
    after: fmtCurrency(adjustedAmount),
    severity,
    message,
  };
}

function worksheetHasHeader(worksheet: ExcelJS.Worksheet, header: string): boolean {
  return Boolean(findExcelHeaderRow(worksheet, header));
}

function findExcelHeaderRow(worksheet: ExcelJS.Worksheet, header: string): number | null {
  let found: number | null = null;
  worksheet.eachRow((row, rowNumber) => {
    if (found) return;
    let hasHeader = false;
    row.eachCell({ includeEmpty: true }, (cell) => {
      if (normalizeCsvHeader(excelCellToText(cell.value)) === header) hasHeader = true;
    });
    if (hasHeader) found = rowNumber;
  });
  return found;
}

function excelCellToText(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return value.trim();
  const rich = value as { text?: string; result?: unknown; richText?: Array<{ text?: string }> };
  if (rich.text) return rich.text.trim();
  if (rich.result != null) return excelCellToText(rich.result);
  if (Array.isArray(rich.richText)) return rich.richText.map((part) => part.text ?? '').join('').trim();
  return String(value).trim();
}

function styleExcelHeader(worksheet: ExcelJS.Worksheet, rowNumber: number): void {
  const row = worksheet.getRow(rowNumber);
  row.font = { bold: true, color: { argb: 'FF0F172A' } };
  row.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF8FAFC' },
  };
  row.border = {
    bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
  };
}

function setExcelColumnWidths(worksheet: ExcelJS.Worksheet, widths: number[]): void {
  widths.forEach((width, index) => {
    worksheet.getColumn(index + 1).width = width;
  });
}

function formatExcelMoneyColumns(worksheet: ExcelJS.Worksheet, columns: number[]): void {
  for (const column of columns) {
    worksheet.getColumn(column).numFmt = '$#,##0.00;-$#,##0.00';
  }
}

function parseCsvRows(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, '');
  const delimiter = detectCsvDelimiter(source);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  return rows;
}

function detectCsvDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const semicolons = (firstLine.match(/;/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return semicolons > commas ? ';' : ',';
}

function normalizeCsvHeader(value: string | undefined): string {
  return normalizeCsvValue(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function normalizeCsvValue(value: string | undefined): string {
  return (value ?? '').trim();
}

function parseCsvAmount(value: string): number | undefined {
  const normalized = value
    .replace(/\$/g, '')
    .replace(/\s/g, '')
    .replace(/,/g, '');
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadBinaryFile(filename: string, content: unknown, mimeType: string): void {
  const blob = new Blob([content as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function safeFileName(value: string): string {
  return normalizeLabel(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'escenario';
}

function supplierStatusToLedgerStatus(status: OperatingSupplierQueueItem['status']): PlanningLedgerStatus {
  switch (status) {
    case 'moved': return 'rescheduled';
    case 'overdue': return 'overdue';
    case 'partial': return 'partial';
    case 'suggested': return 'projected';
    case 'unplanned': return 'unplanned';
  }
}

function ledgerTypeOrder(type: PlanningLedgerType): number {
  switch (type) {
    case 'supplier': return 0;
    case 'tax': return 1;
    case 'obligation': return 2;
    case 'fixed': return 3;
    case 'adjustment': return 4;
    case 'collection': return 5;
  }
}

function mapAdditionToManualConcept(value: string | undefined): ManualConcept {
  const normalized = (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
  if (!normalized) return 'Pasivos Financieros';
  if (normalized.startsWith('impuest')) return 'Impuestos';
  if (normalized.startsWith('finiquit')) return 'Finiquitos';
  if (normalized.startsWith('capex') || normalized.includes('capital')) return 'CAPEX';
  if (normalized.includes('pasivo') || normalized.includes('financier') || normalized.includes('credito')) return 'Pasivos Financieros';
  return 'Pasivos Financieros';
}

function createManualRow(selectedMonth: string, concept: ManualConcept = 'Finiquitos'): ManualEventRow {
  return {
    id: `manual-ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    concept,
    date: `${selectedMonth}-01`,
    amountInput: '',
    label: '',
    allowPartial: concept === TAX_MANUAL_CONCEPT,
  };
}

function rowFromManualEvent(event: ManualExpenseEvent): ManualEventRow {
  return {
    id: event.id ?? `manual-ui-${event.date}-${event.concept}`,
    concept: event.concept as ManualEventRow['concept'],
    date: event.date,
    amountInput: String(event.amount),
    label: event.label ?? '',
    allowPartial: event.allowPartial ?? false,
  };
}

function toManualExpenseEvent(row: ManualEventRow): ManualExpenseEvent | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return null;
  const amount = Number(row.amountInput);
  if (!Number.isFinite(amount) || amount < 0) return null;
  if (amount === 0 && row.concept !== TAX_MANUAL_CONCEPT) return null;
  return {
    id: row.id,
    concept: row.concept,
    date: row.date,
    amount,
    label: row.label.trim() || undefined,
    allowPartial: row.allowPartial,
  };
}

function rowFromOperatingTaxDebt(debt: OperatingTaxDebt): TaxDebtRow {
  return {
    id: debt.id,
    fiscalYearInput: String(debt.fiscalYear),
    taxType: debt.taxType,
    label: debt.label,
    originalAmountInput: editableAmount(debt.originalAmount),
    paidAmountInput: editableAmount(debt.paidAmount),
    outstandingAmountInput: editableAmount(debt.outstandingAmount),
    dueDate: debt.dueDate,
    priority: debt.priority,
    legalRisk: debt.legalRisk,
    authority: debt.authority ?? '',
    fiscalPeriod: debt.fiscalPeriod ?? '',
    legalStatus: debt.legalStatus ?? '',
    surchargeAmountInput: editableAmount(debt.surchargeAmount ?? 0),
    agreementId: debt.agreementId ?? '',
    comments: debt.comments ?? '',
    plannedPayments: debt.plannedPayments.map(rowFromTaxPayment),
  };
}

function rowFromTaxPayment(payment: OperatingTaxPlannedPayment): TaxPaymentRow {
  return {
    id: payment.id ?? `tax-payment-ui-${payment.date}-${Math.random().toString(36).slice(2, 8)}`,
    date: payment.date,
    amountInput: editableAmount(payment.amount),
    note: payment.note ?? '',
    suggested: payment.suggested ?? false,
  };
}

function toOperatingTaxDebt(row: TaxDebtRow): OperatingTaxDebt | null {
  if (!/^\d{4}$/.test(row.fiscalYearInput)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.dueDate)) return null;
  const originalAmount = Number(row.originalAmountInput);
  const paidAmount = Number(row.paidAmountInput);
  const outstandingAmount = Number(row.outstandingAmountInput);
  const surchargeAmount = row.surchargeAmountInput.trim() === '' ? 0 : Number(row.surchargeAmountInput);
  if (!Number.isFinite(originalAmount) || originalAmount < 0) return null;
  if (!Number.isFinite(paidAmount) || paidAmount < 0) return null;
  if (!Number.isFinite(outstandingAmount) || outstandingAmount < 0) return null;
  if (!Number.isFinite(surchargeAmount) || surchargeAmount < 0) return null;
  return {
    id: row.id,
    fiscalYear: Number(row.fiscalYearInput),
    taxType: row.taxType,
    label: row.label.trim() || 'Adeudo fiscal',
    originalAmount,
    paidAmount,
    outstandingAmount,
    dueDate: row.dueDate,
    priority: row.priority,
    legalRisk: row.legalRisk,
    authority: row.authority.trim() || undefined,
    fiscalPeriod: row.fiscalPeriod.trim() || undefined,
    legalStatus: row.legalStatus.trim() || undefined,
    surchargeAmount,
    agreementId: row.agreementId.trim() || undefined,
    comments: row.comments.trim() || undefined,
    plannedPayments: row.plannedPayments
      .map(toTaxPlannedPayment)
      .filter((payment): payment is OperatingTaxPlannedPayment => payment !== null),
  };
}

function toTaxPlannedPayment(row: TaxPaymentRow): OperatingTaxPlannedPayment | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return null;
  const amount = Number(row.amountInput);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return {
    id: row.id,
    date: row.date,
    amount,
    note: row.note.trim() || undefined,
    suggested: row.suggested,
  };
}

function createTaxDebtRow(today: string): TaxDebtRow {
  return rowFromOperatingTaxDebt(createOperatingTaxDebt({
    fiscalYear: 2025,
    taxType: 'ISR',
    label: 'Adeudo fiscal',
    dueDate: today,
    priority: 'alta',
    legalRisk: 'alto',
  }));
}

function updateTaxDebtRow(
  setRows: (updater: (current: TaxDebtRow[]) => TaxDebtRow[]) => void,
  rowId: string,
  patch: Partial<TaxDebtRow>,
): void {
  setRows((current) => current.map((row) => (row.id === rowId ? { ...row, ...patch } : row)));
}

function updateTaxPaymentRow(
  rows: TaxDebtRow[],
  debtId: string,
  paymentId: string,
  patch: Partial<TaxPaymentRow>,
): TaxDebtRow[] {
  return rows.map((row) => (
    row.id === debtId
      ? {
        ...row,
        plannedPayments: row.plannedPayments.map((payment) => (
          payment.id === paymentId ? { ...payment, ...patch, suggested: false } : payment
        )),
      }
      : row
  ));
}

function addTaxPaymentRow(rows: TaxDebtRow[], debtId: string, date: string): TaxDebtRow[] {
  return rows.map((row) => (
    row.id === debtId
      ? {
        ...row,
        plannedPayments: [
          ...row.plannedPayments,
          {
            id: `tax-payment-ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            date,
            amountInput: '',
            note: '',
            suggested: false,
          },
        ],
      }
      : row
  ));
}

function removeTaxPaymentRow(rows: TaxDebtRow[], debtId: string, paymentId: string): TaxDebtRow[] {
  return rows.map((row) => (
    row.id === debtId
      ? { ...row, plannedPayments: row.plannedPayments.filter((payment) => payment.id !== paymentId) }
      : row
  ));
}

function createAdjustmentRow(date: string): AdjustmentRow {
  return {
    id: `adjustment-ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    date,
    direction: 'outflow',
    category: 'Salida manual',
    label: '',
    amountInput: '',
  };
}

function rowFromOperatingAdjustment(adjustment: OperatingAdjustment): AdjustmentRow {
  return {
    id: adjustment.id ?? `adjustment-ui-${adjustment.date}-${adjustment.direction}`,
    date: adjustment.date,
    direction: adjustment.direction,
    category: adjustment.category ?? (adjustment.direction === 'inflow' ? 'Entrada manual' : 'Salida manual'),
    label: adjustment.label,
    amountInput: String(adjustment.amount),
  };
}

function toOperatingAdjustment(row: AdjustmentRow): OperatingAdjustment | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return null;
  const amount = Number(row.amountInput);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const label = row.label.trim();
  if (!label) return null;
  return {
    id: row.id,
    date: row.date,
    label,
    amount,
    direction: row.direction,
    affectsCash: true,
    category: row.category.trim() || (row.direction === 'inflow' ? 'Entrada manual' : 'Salida manual'),
  };
}

function rowFromOperatingCollectionOverride(override: OperatingCollectionOverride): CollectionOverrideRow {
  return {
    id: override.id ?? `collection-override-${override.sourceKey}`,
    sourceKey: override.sourceKey,
    clientName: 'Cliente',
    date: override.date,
    amountInput: String(override.amount),
    note: override.note ?? '',
  };
}

function rowFromOperatingScheduledOutflowOverride(override: OperatingScheduledOutflowOverride): ScheduledOutflowOverrideRow {
  return {
    id: override.id ?? `outflow-override-${override.sourceKey}`,
    sourceKey: override.sourceKey,
    label: 'Egreso',
    category: 'Egreso programado',
    date: override.date,
    amountInput: String(override.amount),
    note: override.note ?? '',
  };
}

function toOperatingCollectionOverride(row: CollectionOverrideRow): OperatingCollectionOverride | null {
  if (!row.sourceKey) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return null;
  if (row.amountInput.trim() === '') return null;
  const amount = Number(row.amountInput);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return {
    id: row.id,
    sourceKey: row.sourceKey,
    date: row.date,
    amount,
    note: row.note.trim() || undefined,
  };
}

function toOperatingScheduledOutflowOverride(row: ScheduledOutflowOverrideRow): OperatingScheduledOutflowOverride | null {
  if (!row.sourceKey) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return null;
  if (row.amountInput.trim() === '') return null;
  const amount = Number(row.amountInput);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return {
    id: row.id,
    sourceKey: row.sourceKey,
    date: row.date,
    amount,
    note: row.note.trim() || undefined,
  };
}

function loadInitialScenarioUiState(): OperatingScenarioUiState {
  const scenarios = loadOperatingProjectionScenarios(
    loadOperatingManualExpenseEvents(),
    loadOperatingAdjustments(),
  );
  const activeId = loadActiveOperatingScenarioId();
  const activeScenario = scenarios.find((scenario) => scenario.id === activeId) ?? scenarios[0];
  return {
    scenarios,
    activeScenarioId: activeScenario.id,
    manualRows: activeScenario.manualExpenseEvents.map(rowFromManualEvent),
    adjustmentRows: activeScenario.operatingAdjustments.map(rowFromOperatingAdjustment),
    supplierOverrideRows: activeScenario.supplierPaymentOverrides.map(rowFromSupplierPaymentOverride),
    collectionOverrideRows: activeScenario.collectionOverrides.map(rowFromOperatingCollectionOverride),
    scheduledOutflowOverrideRows: activeScenario.scheduledOutflowOverrides.map(rowFromOperatingScheduledOutflowOverride),
    taxDebtRows: activeScenario.taxDebts.map(rowFromOperatingTaxDebt),
  };
}

function loadOperatingProjectionUser(): OperatingProjectionUser {
  try {
    const raw = localStorage.getItem(OPERATING_USER_STORAGE_KEY);
    if (!raw) return { name: 'Tesorería', role: 'Planeación' };
    const parsed = JSON.parse(raw) as Partial<OperatingProjectionUser>;
    return {
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name : 'Tesorería',
      role: typeof parsed.role === 'string' && parsed.role.trim() ? parsed.role : 'Planeación',
    };
  } catch {
    return { name: 'Tesorería', role: 'Planeación' };
  }
}

function saveOperatingProjectionUser(user: OperatingProjectionUser): void {
  try {
    localStorage.setItem(OPERATING_USER_STORAGE_KEY, JSON.stringify(user));
  } catch {
    // localStorage puede no estar disponible; la corrida no depende de esto.
  }
}

function loadMinimumCashPolicy(): MinimumCashPolicy {
  try {
    const raw = localStorage.getItem(MINIMUM_CASH_STORAGE_KEY);
    if (!raw) return { amountInput: '', scope: 'group', updatedAt: new Date().toISOString() };
    const parsed = JSON.parse(raw) as Partial<MinimumCashPolicy>;
    return {
      amountInput: typeof parsed.amountInput === 'string' ? parsed.amountInput : '',
      scope: parsed.scope === 'company' ? 'company' : 'group',
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return { amountInput: '', scope: 'group', updatedAt: new Date().toISOString() };
  }
}

function saveMinimumCashPolicy(policy: MinimumCashPolicy): void {
  try {
    localStorage.setItem(MINIMUM_CASH_STORAGE_KEY, JSON.stringify(policy));
  } catch {
    // localStorage puede no estar disponible; el usuario puede seguir recalculando.
  }
}

function cloneOperatingScenarioUiState(state: OperatingScenarioUiState): OperatingScenarioUiState {
  return {
    scenarios: state.scenarios.map((scenario) => ({
      ...scenario,
      manualExpenseEvents: scenario.manualExpenseEvents.map((event) => ({ ...event })),
      operatingAdjustments: scenario.operatingAdjustments.map((adjustment) => ({ ...adjustment })),
      supplierPaymentOverrides: scenario.supplierPaymentOverrides.map((override) => ({ ...override })),
      collectionOverrides: scenario.collectionOverrides.map((override) => ({ ...override })),
      scheduledOutflowOverrides: scenario.scheduledOutflowOverrides.map((override) => ({ ...override })),
      taxDebts: scenario.taxDebts.map(cloneOperatingTaxDebt),
      auditLog: scenario.auditLog?.map((entry) => ({ ...entry })),
    })),
    activeScenarioId: state.activeScenarioId,
    manualRows: state.manualRows.map((row) => ({ ...row })),
    adjustmentRows: state.adjustmentRows.map((row) => ({ ...row })),
    supplierOverrideRows: state.supplierOverrideRows.map((row) => ({ ...row })),
    collectionOverrideRows: state.collectionOverrideRows.map((row) => ({ ...row })),
    scheduledOutflowOverrideRows: state.scheduledOutflowOverrideRows.map((row) => ({ ...row })),
    taxDebtRows: state.taxDebtRows.map((row) => ({
      ...row,
      plannedPayments: row.plannedPayments.map((payment) => ({ ...payment })),
    })),
  };
}

function cloneOperatingTaxDebt(debt: OperatingTaxDebt): OperatingTaxDebt {
  return {
    ...debt,
    plannedPayments: debt.plannedPayments.map((payment) => ({ ...payment })),
  };
}

function ensureEditableScenarioUiState(state: OperatingScenarioUiState): OperatingScenarioUiState {
  if (state.activeScenarioId !== 'base') return state;
  const active = state.scenarios.find((scenario) => scenario.id === state.activeScenarioId) ?? state.scenarios[0];
  const scenario = createOperatingProjectionScenario(`${active?.name ?? 'Base'} ajustado`, {
    manualExpenseEvents: state.manualRows
      .map(toManualExpenseEvent)
      .filter((value): value is ManualExpenseEvent => value !== null)
      .sort(sortManualExpenseEvent),
    operatingAdjustments: state.adjustmentRows
      .map(toOperatingAdjustment)
      .filter((value): value is OperatingAdjustment => value !== null)
      .sort(sortOperatingAdjustment),
    supplierPaymentOverrides: state.supplierOverrideRows
      .map(toSupplierPaymentOverride)
      .filter((value): value is OperatingSupplierPaymentOverride => value !== null),
    collectionOverrides: state.collectionOverrideRows
      .map(toOperatingCollectionOverride)
      .filter((value): value is OperatingCollectionOverride => value !== null),
    scheduledOutflowOverrides: state.scheduledOutflowOverrideRows
      .map(toOperatingScheduledOutflowOverride)
      .filter((value): value is OperatingScheduledOutflowOverride => value !== null),
    taxDebts: state.taxDebtRows
      .map(toOperatingTaxDebt)
      .filter((value): value is OperatingTaxDebt => value !== null),
  });

  return {
    ...state,
    scenarios: [...state.scenarios, scenario],
    activeScenarioId: scenario.id,
  };
}

function syncActiveScenarioRows(state: OperatingScenarioUiState): OperatingScenarioUiState {
  const manualExpenseEvents = state.manualRows
    .map(toManualExpenseEvent)
    .filter((value): value is ManualExpenseEvent => value !== null)
    .sort(sortManualExpenseEvent);
  const operatingAdjustments = state.adjustmentRows
    .map(toOperatingAdjustment)
    .filter((value): value is OperatingAdjustment => value !== null)
    .sort(sortOperatingAdjustment);
  const supplierPaymentOverrides = state.supplierOverrideRows
    .map(toSupplierPaymentOverride)
    .filter((value): value is OperatingSupplierPaymentOverride => value !== null);
  const collectionOverrides = state.collectionOverrideRows
    .map(toOperatingCollectionOverride)
    .filter((value): value is OperatingCollectionOverride => value !== null);
  const scheduledOutflowOverrides = state.scheduledOutflowOverrideRows
    .map(toOperatingScheduledOutflowOverride)
    .filter((value): value is OperatingScheduledOutflowOverride => value !== null);
  const taxDebts = state.taxDebtRows
    .map(toOperatingTaxDebt)
    .filter((value): value is OperatingTaxDebt => value !== null);
  const now = new Date().toISOString();
  return {
    ...state,
    scenarios: state.scenarios.map((scenario) => (
      scenario.id === state.activeScenarioId
        ? {
          ...scenario,
          manualExpenseEvents,
          operatingAdjustments,
          supplierPaymentOverrides,
          collectionOverrides,
          scheduledOutflowOverrides,
          taxDebts,
          updatedAt: now,
        }
        : scenario
    )),
  };
}

function rowFromSupplierPaymentOverride(override: OperatingSupplierPaymentOverride): SupplierOverrideRow {
  return {
    id: override.id ?? `supplier-override-${override.invoiceKey}`,
    invoiceKey: override.invoiceKey,
    providerName: override.providerName ?? 'Proveedor',
    supplierNumber: override.supplierNumber,
    invoiceNumber: override.invoiceNumber,
    date: override.date,
    amountInput: String(override.amount),
    note: override.note ?? '',
  };
}

function toSupplierPaymentOverride(row: SupplierOverrideRow): OperatingSupplierPaymentOverride | null {
  if (!row.invoiceKey) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return null;
  if (row.amountInput.trim() === '') return null;
  const amount = Number(row.amountInput);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return {
    id: row.id,
    invoiceKey: row.invoiceKey,
    providerName: row.providerName,
    supplierNumber: row.supplierNumber,
    invoiceNumber: row.invoiceNumber,
    date: row.date,
    amount,
    note: row.note.trim() || undefined,
  };
}

function collectionOverrideSourceKey(line: OperatingFlowLine): string {
  return line.sourceKey ?? line.id;
}

function scheduledOutflowOverrideSourceKey(line: OperatingFlowLine): string {
  return line.sourceKey ?? line.id.replace(/^paid:/, '').replace(/:\d{4}-\d{2}-\d{2}$/, '');
}

function upsertCollectionOverrideRow(
  rows: CollectionOverrideRow[],
  line: OperatingFlowLine,
  patch: Partial<CollectionOverrideRow>,
  fallbackDate: string,
): CollectionOverrideRow[] {
  const sourceKey = collectionOverrideSourceKey(line);
  const current = rows.find((row) => row.sourceKey === sourceKey);
  const next: CollectionOverrideRow = {
    id: current?.id ?? `collection-override-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sourceKey,
    clientName: current?.clientName ?? line.label,
    invoiceDate: current?.invoiceDate ?? line.invoiceDate,
    date: current?.date ?? fallbackDate,
    amountInput: current?.amountInput ?? editableAmount(line.amount),
    note: current?.note ?? '',
    ...patch,
  };
  return sortCollectionOverrideRows(current
    ? rows.map((row) => (row.id === current.id ? next : row))
    : [...rows, next]);
}

function upsertScheduledOutflowOverrideRow(
  rows: ScheduledOutflowOverrideRow[],
  line: OperatingFlowLine,
  patch: Partial<ScheduledOutflowOverrideRow>,
  fallbackDate: string,
): ScheduledOutflowOverrideRow[] {
  const sourceKey = scheduledOutflowOverrideSourceKey(line);
  const current = rows.find((row) => row.sourceKey === sourceKey);
  const next: ScheduledOutflowOverrideRow = {
    id: current?.id ?? `outflow-override-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sourceKey,
    label: current?.label ?? line.label,
    category: current?.category ?? line.category,
    date: current?.date ?? fallbackDate,
    amountInput: current?.amountInput ?? editableAmount(line.amount),
    note: current?.note ?? '',
    ...patch,
  };
  return sortScheduledOutflowOverrideRows(current
    ? rows.map((row) => (row.id === current.id ? next : row))
    : [...rows, next]);
}

function sortCollectionOverrideRows(rows: CollectionOverrideRow[]): CollectionOverrideRow[] {
  return [...rows].sort((a, b) => {
    const dateDelta = a.date.localeCompare(b.date);
    if (dateDelta !== 0) return dateDelta;
    return a.clientName.localeCompare(b.clientName);
  });
}

function sortScheduledOutflowOverrideRows(rows: ScheduledOutflowOverrideRow[]): ScheduledOutflowOverrideRow[] {
  return [...rows].sort((a, b) => {
    const dateDelta = a.date.localeCompare(b.date);
    if (dateDelta !== 0) return dateDelta;
    const categoryDelta = a.category.localeCompare(b.category);
    if (categoryDelta !== 0) return categoryDelta;
    return a.label.localeCompare(b.label);
  });
}

function upsertSupplierOverrideRow(
  rows: SupplierOverrideRow[],
  payment: OperatingSupplierPayment,
  patch: Partial<SupplierOverrideRow>,
  fallbackDate: string,
): SupplierOverrideRow[] {
  const current = rows.find((row) => row.invoiceKey === payment.invoiceKey);
  const next: SupplierOverrideRow = {
    id: current?.id ?? `supplier-override-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    invoiceKey: payment.invoiceKey,
    providerName: payment.providerName,
    supplierNumber: payment.supplierNumber,
    invoiceNumber: payment.invoiceNumber,
    date: current?.date ?? fallbackDate,
    amountInput: current?.amountInput ?? editableAmount(payment.amount),
    note: current?.note ?? '',
    ...patch,
  };
  return sortSupplierOverrideRows(current
    ? rows.map((row) => (row.id === current.id ? next : row))
    : [...rows, next]);
}

function upsertSupplierOverrideFromQueueItem(
  rows: SupplierOverrideRow[],
  item: OperatingSupplierQueueItem,
  patch: Partial<SupplierOverrideRow>,
  fallbackDate: string,
): SupplierOverrideRow[] {
  const current = rows.find((row) => row.invoiceKey === item.invoiceKey);
  const next: SupplierOverrideRow = {
    id: current?.id ?? `supplier-override-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    invoiceKey: item.invoiceKey,
    providerName: item.providerName,
    supplierNumber: item.supplierNumber,
    invoiceNumber: item.invoiceNumber,
    date: current?.date ?? item.plannedDate ?? item.dueDate ?? fallbackDate,
    amountInput: current?.amountInput ?? editableAmount(item.plannedAmount ?? item.remainingAmount ?? item.invoiceAmount),
    note: current?.note ?? 'Editado desde cola priorizada',
    ...patch,
  };
  return sortSupplierOverrideRows(current
    ? rows.map((row) => (row.id === current.id ? next : row))
    : [...rows, next]);
}

function splitSupplierOverrideRows(
  rows: SupplierOverrideRow[],
  item: OperatingSupplierQueueItem,
  startDate: string,
  amount: number,
  weights: number[],
): SupplierOverrideRow[] {
  const safeWeights = weights.filter((weight) => Number.isFinite(weight) && weight > 0);
  const totalWeight = safeWeights.reduce((sum, weight) => sum + weight, 0) || 1;
  const withoutInvoice = rows.filter((row) => row.invoiceKey !== item.invoiceKey);
  let allocated = 0;
  const additions = safeWeights.map((weight, index) => {
    const isLast = index === safeWeights.length - 1;
    const splitAmount = isLast ? amount - allocated : amount * (weight / totalWeight);
    allocated += splitAmount;
    return {
      id: `supplier-split-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
      invoiceKey: item.invoiceKey,
      providerName: item.providerName,
      supplierNumber: item.supplierNumber,
      invoiceNumber: item.invoiceNumber,
      date: shiftBusinessDate(startDate, index * 7),
      amountInput: editableAmount(splitAmount),
      note: `Dividido ${Math.round((weight / totalWeight) * 100)}% desde planeación`,
    };
  });
  return sortSupplierOverrideRows([...withoutInvoice, ...additions]);
}

function updateSupplierOverrideRow(
  rows: SupplierOverrideRow[],
  rowId: string,
  patch: Partial<SupplierOverrideRow>,
): SupplierOverrideRow[] {
  return sortSupplierOverrideRows(rows.map((row) => (
    row.id === rowId ? { ...row, ...patch } : row
  )));
}

function sortSupplierOverrideRows(rows: SupplierOverrideRow[]): SupplierOverrideRow[] {
  return [...rows].sort((a, b) => {
    const dateDelta = a.date.localeCompare(b.date);
    if (dateDelta !== 0) return dateDelta;
    const providerDelta = a.providerName.localeCompare(b.providerName);
    if (providerDelta !== 0) return providerDelta;
    return (a.invoiceNumber ?? '').localeCompare(b.invoiceNumber ?? '');
  });
}

function filterSupplierQueueRows(
  rows: OperatingSupplierQueueItem[],
  filters: SupplierQueueFilters,
  selectedDay: string,
  selectedMonth: string,
  bucketByProviderId?: Map<string, SupplierBucket>,
): OperatingSupplierQueueItem[] {
  return rows.filter((row) => {
    if (filters.risk !== 'all' && row.risk !== filters.risk) return false;
    if (filters.flexibility !== 'all' && row.flexibility !== filters.flexibility) return false;
    if (filters.bucket !== 'all') {
      const bucketForRow = row.clasificacionAutomatica
        ?? (row.providerId ? bucketByProviderId?.get(row.providerId) : undefined);
      if (bucketForRow !== filters.bucket) return false;
    }
    if (filters.status !== 'all' && row.status !== filters.status) return false;
    if (filters.credit !== 'all' && row.creditStatus !== filters.credit) return false;
    const relevantDate = row.plannedDate ?? row.dueDate ?? '';
    if (filters.date === 'day') return relevantDate === selectedDay;
    if (filters.date === 'week') return relevantDate >= selectedDay && relevantDate <= shiftBusinessDate(selectedDay, 7);
    if (filters.date === 'month') return relevantDate.startsWith(selectedMonth);
    return true;
  });
}

function summarizeSupplierQueue(rows: OperatingSupplierQueueItem[]): {
  criticalCount: number;
  overdueCount: number;
  movedCount: number;
} {
  return {
    criticalCount: rows.filter((row) => row.risk === 'Alto' || row.flexibility === 'inamovible').length,
    overdueCount: rows.filter((row) => row.status === 'overdue').length,
    movedCount: rows.filter((row) => row.status === 'moved').length,
  };
}

function projectionAdjustmentInputValue(
  row: ProjectionSheetRow,
  direction: OperatingAdjustment['direction'],
  adjustmentRows: AdjustmentRow[],
): string {
  const total = periodAdjustmentTotal(row, direction, adjustmentRows, true);
  return total > 0 ? editableAmount(total) : '';
}

function protectedAdjustmentTotal(
  row: ProjectionSheetRow,
  direction: OperatingAdjustment['direction'],
  adjustmentRows: AdjustmentRow[],
): number {
  return periodAdjustmentTotal(row, direction, adjustmentRows, false);
}

function setProjectionAdjustmentTarget(
  current: AdjustmentRow[],
  row: ProjectionSheetRow,
  granularity: SheetGranularity,
  direction: OperatingAdjustment['direction'],
  rawAmount: string,
): AdjustmentRow[] {
  const editableDate = projectionAdjustmentDate(row);
  if (!editableDate) return current;

  const target = rawAmount.trim() === '' ? 0 : Number(rawAmount);
  if (!Number.isFinite(target) || target < 0) return current;

  const protectedTotal = periodAdjustmentTotal(row, direction, current, false);
  const amount = Math.max(0, target - protectedTotal);
  const withoutSheetRows = current.filter((entry) => !(
    isSheetAdjustmentRow(entry)
    && entry.direction === direction
    && dateInRange(effectiveAdjustmentDate(entry.date), row.startDate, row.endDate)
  ));

  if (amount <= 0) return sortAdjustmentRows(withoutSheetRows);

  return sortAdjustmentRows([
    ...withoutSheetRows,
    {
      id: sheetAdjustmentId(row, granularity, direction),
      date: editableDate,
      direction,
      category: SHEET_ADJUSTMENT_CATEGORY,
      label: `${direction === 'inflow' ? 'Entrada editable' : 'Salida editable'} · ${row.label}`,
      amountInput: editableAmount(amount),
    },
  ]);
}

function periodAdjustmentTotal(
  row: ProjectionSheetRow,
  direction: OperatingAdjustment['direction'],
  adjustmentRows: AdjustmentRow[],
  includeSheetRows: boolean,
): number {
  return adjustmentRows
    .filter((entry) => entry.direction === direction)
    .filter((entry) => dateInRange(effectiveAdjustmentDate(entry.date), row.startDate, row.endDate))
    .filter((entry) => includeSheetRows || !isSheetAdjustmentRow(entry))
    .map(toOperatingAdjustment)
    .filter((value): value is OperatingAdjustment => value !== null)
    .reduce((sum, adjustment) => sum + adjustment.amount, 0);
}

function isSheetAdjustmentRow(row: AdjustmentRow): boolean {
  return row.category.trim() === SHEET_ADJUSTMENT_CATEGORY || row.id.startsWith('sheet-adjustment:');
}

function sheetAdjustmentId(
  row: ProjectionSheetRow,
  granularity: SheetGranularity,
  direction: OperatingAdjustment['direction'],
): string {
  return `sheet-adjustment:${granularity}:${row.startDate}:${row.endDate}:${direction}`;
}

function projectionAdjustmentDate(row: ProjectionSheetRow): string | null {
  let cursor = new Date(`${row.startDate}T12:00:00Z`);
  const end = new Date(`${row.endDate}T12:00:00Z`);
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day >= 1 && day <= 5) return cursor.toISOString().slice(0, 10);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return null;
}

function effectiveAdjustmentDate(date: string): string {
  let cursor = new Date(`${date}T12:00:00Z`);
  while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return cursor.toISOString().slice(0, 10);
}

function dateInRange(date: string, startDate: string, endDate: string): boolean {
  return date >= startDate && date <= endDate;
}

function editableAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function taxPeriodTotal(
  rows: ManualEventRow[],
  startDate: string,
  endDate: string,
  includeSheetRows: boolean,
): number {
  return rows
    .filter((row) => row.concept === TAX_MANUAL_CONCEPT)
    .filter((row) => dateInRange(row.date, startDate, endDate))
    .filter((row) => includeSheetRows || !isTaxSheetManualRow(row))
    .map(toManualExpenseEvent)
    .filter((value): value is ManualExpenseEvent => value !== null)
    .reduce((sum, event) => sum + event.amount, 0);
}

function taxEffectiveDate(row: ProjectionSheetRow): string {
  const reversed = [...row.days].reverse();
  const businessDay = reversed.find((day) => {
    const d = new Date(`${day.date}T12:00:00Z`);
    const dow = d.getUTCDay();
    return dow >= 1 && dow <= 5;
  });
  return businessDay?.date ?? row.endDate;
}

function isTaxSheetManualRow(row: ManualEventRow): boolean {
  return row.id.startsWith('sheet-tax:') || row.label.startsWith(TAX_SHEET_MANUAL_LABEL_PREFIX);
}

function manualCellInputValue(
  rows: ManualEventRow[],
  date: string,
  concept: ManualEventRow['concept'],
): string {
  const total = manualCellTotal(rows, date, concept, true);
  return total > 0 ? editableAmount(total) : '';
}

function protectedManualCellTotal(
  rows: ManualEventRow[],
  date: string,
  concept: ManualEventRow['concept'],
): number {
  return manualCellTotal(rows, date, concept, false);
}

function manualCellTotal(
  rows: ManualEventRow[],
  date: string,
  concept: ManualEventRow['concept'],
  includeSheetRows: boolean,
): number {
  return rows
    .filter((row) => row.date === date && row.concept === concept)
    .filter((row) => includeSheetRows || !isSheetManualRow(row))
    .map(toManualExpenseEvent)
    .filter((value): value is ManualExpenseEvent => value !== null)
    .reduce((sum, event) => sum + event.amount, 0);
}

function setManualSheetCellTarget(
  current: ManualEventRow[],
  date: string,
  concept: ManualEventRow['concept'],
  rawAmount: string,
): ManualEventRow[] {
  const target = rawAmount.trim() === '' ? 0 : Number(rawAmount);
  if (!Number.isFinite(target) || target < 0) return current;
  const protectedTotal = manualCellTotal(current, date, concept, false);
  const sheetAmount = Math.max(0, target - protectedTotal);
  const withoutSheetRows = current.filter((row) => !(
    row.date === date
    && row.concept === concept
    && isSheetManualRow(row)
  ));
  if (sheetAmount <= 0) return sortManualRows(withoutSheetRows);
  return sortManualRows([
    ...withoutSheetRows,
    {
      id: sheetManualId(date, concept),
      concept,
      date,
      amountInput: editableAmount(sheetAmount),
      label: `${SHEET_MANUAL_LABEL_PREFIX} · ${concept}`,
      allowPartial: false,
    },
  ]);
}

function shiftManualRowsFromDate(
  rows: ManualEventRow[],
  date: string,
  days: number,
): ManualEventRow[] {
  const nextDate = shiftBusinessDate(date, days);
  return sortManualRows(rows.map((row) => (
    row.date === date && row.concept !== TAX_MANUAL_CONCEPT ? { ...row, date: nextDate } : row
  )));
}

function splitManualRowsFromDate(
  rows: ManualEventRow[],
  date: string,
  days: number,
): ManualEventRow[] {
  const nextDate = shiftBusinessDate(date, days);
  const additions: ManualEventRow[] = [];
  const updated = rows.map((row) => {
    if (row.date !== date || row.concept === TAX_MANUAL_CONCEPT) return row;
    const amount = Number(row.amountInput);
    if (!Number.isFinite(amount) || amount <= 0.01) return row;
    const firstHalf = amount / 2;
    const secondHalf = amount - firstHalf;
    additions.push({
      ...row,
      id: `manual-split-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      date: nextDate,
      amountInput: editableAmount(secondHalf),
      label: `${row.label || row.concept} · diferido`,
    });
    return {
      ...row,
      amountInput: editableAmount(firstHalf),
    };
  });
  return sortManualRows([...updated, ...additions]);
}

function isSheetManualRow(row: ManualEventRow): boolean {
  return row.id.startsWith('sheet-manual:') || row.label.startsWith(SHEET_MANUAL_LABEL_PREFIX);
}

function sheetManualId(date: string, concept: ManualEventRow['concept']): string {
  return `sheet-manual:${date}:${concept}`;
}

function shiftBusinessDate(date: string, days: number): string {
  const cursor = new Date(`${date}T12:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() + days);
  while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return cursor.toISOString().slice(0, 10);
}

function normalizeLabel(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
}

function sortManualRows(rows: ManualEventRow[]): ManualEventRow[] {
  return [...rows].sort((a, b) => {
    const dateDelta = a.date.localeCompare(b.date);
    if (dateDelta !== 0) return dateDelta;
    const conceptDelta = a.concept.localeCompare(b.concept);
    if (conceptDelta !== 0) return conceptDelta;
    return a.label.localeCompare(b.label);
  });
}

function updateManualRow(
  setRows: (updater: (current: ManualEventRow[]) => ManualEventRow[]) => void,
  rowId: string,
  patch: Partial<ManualEventRow>,
): void {
  setRows((current) => sortManualRows(current.map((row) => (
    row.id === rowId ? { ...row, ...patch } : row
  ))));
}

function sortAdjustmentRows(rows: AdjustmentRow[]): AdjustmentRow[] {
  return [...rows].sort((a, b) => {
    const dateDelta = a.date.localeCompare(b.date);
    if (dateDelta !== 0) return dateDelta;
    const directionDelta = a.direction.localeCompare(b.direction);
    if (directionDelta !== 0) return directionDelta;
    return a.label.localeCompare(b.label);
  });
}

function updateAdjustmentRow(
  setRows: (updater: (current: AdjustmentRow[]) => AdjustmentRow[]) => void,
  rowId: string,
  patch: Partial<AdjustmentRow>,
): void {
  setRows((current) => sortAdjustmentRows(current.map((row) => (
    row.id === rowId ? { ...row, ...patch } : row
  ))));
}

function MetricCard({
  label,
  value,
  tone,
  displayValue,
  subvalue,
}: {
  label: string;
  value: number;
  tone: 'neutral' | 'success' | 'danger' | 'warning';
  displayValue?: string;
  subvalue?: string;
}) {
  const toneClass = {
    neutral: 'text-[var(--gray-950)]',
    success: 'text-[var(--success)]',
    danger: 'text-[var(--danger)]',
    warning: 'text-[var(--warning)]',
  }[tone];

  return (
    <div className={`${T.section} px-4 py-3`}>
      <div className="text-[11px] font-medium uppercase tracking-[0.02em] text-[var(--gray-400)]">{label}</div>
      <div className={`mt-2 text-[22px] font-semibold tabular-nums ${toneClass}`}>{displayValue ?? fmtCompact(value)}</div>
      <div className="mt-1 truncate text-[11px] tabular-nums text-[var(--gray-400)]">{subvalue ?? fmtCurrency(value)}</div>
    </div>
  );
}

function ScenarioComparisonPanel({
  activeScenarioName,
  comparison,
  lockedBase,
}: {
  activeScenarioName: string;
  comparison: ScenarioComparison;
  lockedBase: boolean;
}) {
  return (
    <div className="border-b border-[var(--border)] px-4 py-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="text-[12px] font-semibold text-[var(--gray-950)]">Base vs {activeScenarioName}</div>
          <div className="mt-0.5 text-[11px] text-[var(--gray-400)]">
            {lockedBase
              ? 'Base protegido: el primer cambio manual crea un escenario ajustado.'
              : 'Cada cambio se guarda como ajuste del escenario activo; el dato original se conserva.'}
          </div>
        </div>
        <div className="grid gap-3 text-[12px] sm:grid-cols-4 lg:min-w-[760px]">
          <ScenarioDelta label="Caja final" base={comparison.baseEndingCash} value={comparison.scenarioEndingCash} delta={comparison.endingCashDelta} currency />
          <ScenarioDelta label="Días bajo mínimo" base={comparison.baseRiskDays} value={comparison.scenarioRiskDays} delta={comparison.riskDaysDelta} />
          <ScenarioDelta label="Pagos atrasados" base={comparison.baseLatePayments} value={comparison.scenarioLatePayments} delta={comparison.latePaymentsDelta} currency invert />
          <div className="rounded-lg border border-[var(--border)] bg-white px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.02em] text-[var(--gray-400)]">Riesgo</div>
            <div className="mt-1 text-[12px] font-semibold text-[var(--gray-950)]">{comparison.baseRiskLabel} → {comparison.scenarioRiskLabel}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ScenarioDelta({
  label,
  base,
  value,
  delta,
  currency = false,
  invert = false,
}: {
  label: string;
  base: number;
  value: number;
  delta: number;
  currency?: boolean;
  invert?: boolean;
}) {
  const positive = invert ? delta <= 0 : delta >= 0;
  return (
    <div className="rounded-lg border border-[var(--border)] bg-white px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.02em] text-[var(--gray-400)]">{label}</div>
      <div className="mt-1 text-[12px] font-semibold tabular-nums text-[var(--gray-950)]">
        {currency ? fmtCompact(value) : value}
      </div>
      <div className="mt-0.5 text-[10px] tabular-nums text-[var(--gray-400)]">
        Base {currency ? fmtCompact(base) : base} · <span className={positive ? 'text-[var(--success)]' : 'text-[var(--danger)]'}>{delta >= 0 ? '+' : ''}{currency ? fmtCompact(delta) : delta}</span>
      </div>
    </div>
  );
}

function AuditTrailPanel({
  entries,
  currentUser,
}: {
  entries: OperatingAuditEntry[];
  currentUser: OperatingProjectionUser;
}) {
  const visible = entries.slice(0, 5);
  return (
    <div className="border-b border-[var(--border)] px-4 py-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-[12px] font-semibold text-[var(--gray-950)]">Historial del escenario</div>
          <div className="mt-0.5 text-[11px] text-[var(--gray-400)]">
            Responsable local: {currentUser.name || 'Usuario local'} · {currentUser.role || 'Tesorería'}
          </div>
        </div>
        {visible.length === 0 ? (
          <div className="text-[12px] text-[var(--gray-400)]">Sin ajustes registrados todavía.</div>
        ) : (
          <div className="grid gap-2 lg:min-w-[720px]">
            {visible.map((entry) => (
              <div key={entry.id} className="grid gap-2 rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-[11px] lg:grid-cols-[150px_minmax(0,1fr)_220px]">
                <div className="text-[var(--gray-500)]">
                  <div className="font-medium text-[var(--gray-950)]">{entry.user}</div>
                  <div>{fmtDate(entry.at.slice(0, 10))}</div>
                </div>
                <div className="min-w-0">
                  <div className="font-semibold text-[var(--gray-950)]">{entry.action}</div>
                  <div className="mt-0.5 truncate text-[var(--gray-500)]">{entry.reason}</div>
                  {entry.detail && <div className="mt-0.5 truncate text-[var(--gray-400)]">{entry.detail}</div>}
                </div>
                <div className="text-[var(--gray-500)]">{entry.impact}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CashBarStrip({ rows }: { rows: ProjectionSheetRow[] }) {
  const visible = rows.slice(0, 18);
  const maxAmount = Math.max(1, ...visible.map((row) => Math.max(
    row.collections + row.otherInflows + row.adjustmentInflows,
    row.fixedOutflows + row.supplierPayments + row.adjustmentOutflows,
    Math.abs(row.closingCash),
  )));

  return (
    <div className="border-t border-[var(--border)] px-4 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-3 text-[10px] font-medium text-[var(--gray-400)]">
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[var(--success)]" />Ingresos</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[var(--danger)]" />Egresos</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[var(--primary)]" />Caja final</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[var(--warning)]" />Ajustes</span>
      </div>
      <div className="grid auto-cols-[112px] grid-flow-col gap-2 overflow-x-auto pb-1">
        {visible.map((row) => {
          const inflows = row.collections + row.otherInflows + row.adjustmentInflows;
          const outflows = row.fixedOutflows + row.supplierPayments + row.adjustmentOutflows;
          const adjustment = row.adjustmentInflows + row.adjustmentOutflows;
          return (
            <button
              key={row.id}
              className="rounded-lg border border-[var(--border)] bg-white px-2 py-2 text-left hover:bg-[var(--surface-alt)]"
              title={`${row.label}: entradas ${fmtCurrency(inflows)}, egresos ${fmtCurrency(outflows)}`}
            >
              <div className="truncate text-[10px] font-medium text-[var(--gray-500)]">{row.label}</div>
              <div className="mt-2 flex h-16 items-end gap-1">
                <span className="w-4 rounded-t bg-[var(--success)]" style={{ height: `${Math.max(4, (inflows / maxAmount) * 64)}px` }} />
                <span className="w-4 rounded-t bg-[var(--danger)]" style={{ height: `${Math.max(4, (outflows / maxAmount) * 64)}px` }} />
                <span className="w-4 rounded-t bg-[var(--primary)]" style={{ height: `${Math.max(4, (Math.max(0, row.closingCash) / maxAmount) * 64)}px` }} />
                <span className="w-4 rounded-t bg-[var(--warning)]" style={{ height: `${Math.max(4, (adjustment / maxAmount) * 64)}px` }} />
              </div>
              <div className={`mt-2 text-[11px] font-semibold tabular-nums ${row.closingCash < row.mandatoryReserveRequired ? 'text-[var(--danger)]' : 'text-[var(--gray-950)]'}`}>
                {fmtCompact(row.closingCash)}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PlanningLedgerTable({
  rows,
  allRows,
  selectedId,
  selectedIds,
  importStatus,
  importPreview,
  filters,
  undoAvailable,
  selectedCount,
  currentUser,
  minimumCashPolicy,
  onSelect,
  onToggleSelected,
  onToggleAllVisible,
  onUpdate,
  onSplitSupplier,
  onExport,
  onExportXlsx,
  onImport,
  onApplyImport,
  onCancelImport,
  onSearch,
  onTypeFilter,
  onStatusFilter,
  onRiskFilter,
  onEditableOnly,
  onBulkMove,
  onBulkComment,
  onOptimize,
  onUndo,
  onRestoreBase,
  onUserChange,
  onMinimumCashChange,
}: {
  rows: PlanningLedgerItem[];
  allRows: PlanningLedgerItem[];
  selectedId: string | null;
  selectedIds: Set<string>;
  importStatus: string | null;
  importPreview: PlanningLedgerImportPreview | null;
  filters: {
    search: string;
    type: 'all' | PlanningLedgerType;
    status: 'all' | PlanningLedgerStatus;
    risk: 'all' | 'Alto' | 'Medio' | 'Bajo';
    editableOnly: boolean;
  };
  undoAvailable: boolean;
  selectedCount: number;
  currentUser: OperatingProjectionUser;
  minimumCashPolicy: MinimumCashPolicy;
  onSelect: (item: PlanningLedgerItem) => void;
  onToggleSelected: (id: string) => void;
  onToggleAllVisible: () => void;
  onUpdate: (item: PlanningLedgerItem, patch: { date?: string; amountInput?: string; comment?: string }) => void;
  onSplitSupplier: (item: PlanningLedgerItem) => void;
  onExport: () => void;
  onExportXlsx: () => void;
  onImport: (file: File) => void;
  onApplyImport: () => void;
  onCancelImport: () => void;
  onSearch: (value: string) => void;
  onTypeFilter: (value: 'all' | PlanningLedgerType) => void;
  onStatusFilter: (value: 'all' | PlanningLedgerStatus) => void;
  onRiskFilter: (value: 'all' | 'Alto' | 'Medio' | 'Bajo') => void;
  onEditableOnly: (value: boolean) => void;
  onBulkMove: (days: number) => void;
  onBulkComment: (comment: string) => void;
  onOptimize: () => void;
  onUndo: () => void;
  onRestoreBase: () => void;
  onUserChange: (user: OperatingProjectionUser) => void;
  onMinimumCashChange: (policy: MinimumCashPolicy) => void;
}) {
  const allVisibleSelected = rows.length > 0 && rows.every((row) => selectedIds.has(row.id));
  return (
    <section className={`${T.section} overflow-hidden`}>
      <div className="flex flex-col gap-3 border-b border-[var(--border)] px-4 py-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <h2 className={`text-[15px] font-semibold ${T.title}`}>Tabla inteligente de planeación</h2>
          <p className={`mt-1 text-[12px] ${T.muted}`}>
            Exporta toda la programación a Excel: 1 fila por movimiento + línea de tiempo diaria. Edita fechas, montos, comentarios o añade movimientos nuevos (deja id vacío). Al subirlo se crea un escenario nuevo y el algoritmo recalcula caja contra Base.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 xl:justify-end">
          {importStatus && <span className="text-[12px] text-[var(--gray-500)]">{importStatus}</span>}
          <button
            onClick={onExport}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] font-medium text-[var(--gray-950)] transition-colors hover:bg-[var(--surface-alt)]"
          >
            <Download className="h-4 w-4" />
            Descargar CSV
          </button>
          <button
            onClick={onExportXlsx}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] font-medium text-[var(--gray-950)] transition-colors hover:bg-[var(--surface-alt)]"
          >
            <Download className="h-4 w-4" />
            Descargar XLSX
          </button>
          <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] font-medium text-[var(--gray-950)] transition-colors hover:bg-[var(--surface-alt)]">
            <Upload className="h-4 w-4" />
            Subir cambios
            <input
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onImport(file);
                event.currentTarget.value = '';
              }}
            />
          </label>
          <button
            onClick={onUndo}
            disabled={!undoAvailable}
            className="h-10 rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] font-medium text-[var(--gray-700)] transition-colors hover:bg-[var(--surface-alt)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Deshacer
          </button>
          <button
            onClick={onOptimize}
            className="h-10 rounded-xl border border-[var(--primary)] bg-[var(--primary)] px-3 text-[13px] font-medium text-white transition-colors hover:opacity-90"
          >
            Optimizar caja
          </button>
        </div>
      </div>

      <div className="grid gap-3 border-b border-[var(--border)] px-4 py-3 lg:grid-cols-[minmax(180px,1fr)_140px_140px_130px_120px] xl:grid-cols-[minmax(220px,1fr)_140px_140px_130px_120px_170px_330px]">
        <input
          value={filters.search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Buscar proveedor, factura, cliente, concepto..."
          className="h-10 rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none placeholder:text-[var(--gray-300)] focus:border-[var(--primary)]"
        />
        <select value={filters.type} onChange={(event) => onTypeFilter(event.target.value as 'all' | PlanningLedgerType)} className="h-10 rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)]">
          <option value="all">Tipo: todos</option>
          <option value="collection">Ingresos</option>
          <option value="supplier">Proveedores</option>
          <option value="tax">Impuestos</option>
          <option value="obligation">Obligaciones</option>
          <option value="adjustment">Ajustes</option>
          <option value="fixed">Fijos</option>
        </select>
        <select value={filters.status} onChange={(event) => onStatusFilter(event.target.value as 'all' | PlanningLedgerStatus)} className="h-10 rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)]">
          <option value="all">Estado: todos</option>
          <option value="projected">Proyectado</option>
          <option value="confirmed">Confirmado</option>
          <option value="overdue">Vencido</option>
          <option value="rescheduled">Reprogramado</option>
          <option value="partial">Parcial</option>
          <option value="unplanned">Sin programar</option>
        </select>
        <select value={filters.risk} onChange={(event) => onRiskFilter(event.target.value as 'all' | 'Alto' | 'Medio' | 'Bajo')} className="h-10 rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)]">
          <option value="all">Riesgo: todos</option>
          <option value="Alto">Alto</option>
          <option value="Medio">Medio</option>
          <option value="Bajo">Bajo</option>
        </select>
        <label className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 text-[12px] font-medium text-[var(--gray-700)]">
          <input type="checkbox" checked={filters.editableOnly} onChange={(event) => onEditableOnly(event.target.checked)} className="h-4 w-4 rounded border-[var(--border)] text-[var(--primary)] focus:ring-[var(--primary)]" />
          Editables
        </label>
        <div className="hidden gap-2 xl:flex">
          <button onClick={() => onBulkMove(7)} disabled={selectedCount === 0} className="h-10 rounded-xl border border-[var(--border)] bg-white px-3 text-[12px] font-medium text-[var(--gray-700)] hover:bg-[var(--surface-alt)] disabled:cursor-not-allowed disabled:opacity-40">Mover +7</button>
          <button onClick={() => onBulkComment('Revisión masiva de tesorería')} disabled={selectedCount === 0} className="h-10 rounded-xl border border-[var(--border)] bg-white px-3 text-[12px] font-medium text-[var(--gray-700)] hover:bg-[var(--surface-alt)] disabled:cursor-not-allowed disabled:opacity-40">Comentar</button>
        </div>
        <div className="hidden grid-cols-3 gap-2 xl:grid">
          <input
            value={currentUser.name}
            onChange={(event) => onUserChange({ ...currentUser, name: event.target.value })}
            placeholder="Usuario"
            className="h-10 rounded-xl border border-[var(--border)] bg-white px-3 text-[12px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)]"
          />
          <input
            value={currentUser.role}
            onChange={(event) => onUserChange({ ...currentUser, role: event.target.value })}
            placeholder="Rol"
            className="h-10 rounded-xl border border-[var(--border)] bg-white px-3 text-[12px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)]"
          />
          <input
            value={minimumCashPolicy.amountInput}
            onChange={(event) => onMinimumCashChange({ ...minimumCashPolicy, amountInput: event.target.value, updatedAt: new Date().toISOString() })}
            placeholder="Caja mínima"
            type="number"
            min="0"
            className="h-10 rounded-xl border border-[var(--border)] bg-white px-3 text-right text-[12px] tabular-nums text-[var(--gray-950)] outline-none focus:border-[var(--primary)]"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-2 text-[12px] text-[var(--gray-500)]">
        <span>{rows.length} de {allRows.length} movimientos visibles · {selectedCount} seleccionados</span>
        <button onClick={onRestoreBase} className="h-8 rounded-lg border border-[var(--border)] bg-white px-2.5 text-[11px] font-medium text-[var(--gray-700)] hover:bg-[var(--surface-alt)]">
          Restaurar desde Base
        </button>
      </div>

      {importPreview && (
        <PlanningImportPreview
          preview={importPreview}
          onApply={onApplyImport}
          onCancel={onCancelImport}
        />
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1820px] text-[12px]">
          <thead className="bg-[var(--surface-alt)] text-[var(--gray-500)]">
            <tr>
              <Th align="center">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={onToggleAllVisible}
                  className="h-4 w-4 rounded border-[var(--border)] text-[var(--primary)] focus:ring-[var(--primary)]"
                />
              </Th>
              <Th>Fecha original</Th>
              <Th>Fecha programada</Th>
              <Th>Tipo</Th>
              <Th>Categoría</Th>
              <Th>Empresa / proveedor / cliente</Th>
              <Th>Concepto</Th>
              <Th align="right">Monto original</Th>
              <Th align="right">Monto ajustado</Th>
              <Th>Estatus</Th>
              <Th>Prioridad</Th>
              <Th>Riesgo</Th>
              <Th>Flexibilidad</Th>
              <Th>Comentario</Th>
              <Th>Origen</Th>
              <Th>Última actualización</Th>
              <Th align="center">Acción</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={17} className="px-4 py-6">
                  <EmptyMiniState label="Sin movimientos para la tabla de planeación del periodo." />
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const active = row.id === selectedId;
                return (
                  <tr
                    key={row.id}
                    onClick={() => onSelect(row)}
                    className={`cursor-pointer border-t border-[var(--border)] align-top transition-colors ${active ? 'bg-[var(--primary)]/5' : 'hover:bg-[var(--surface-alt)]'}`}
                  >
                    <td className="px-4 py-3 text-center" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(row.id)}
                        onChange={() => onToggleSelected(row.id)}
                        className="h-4 w-4 rounded border-[var(--border)] text-[var(--primary)] focus:ring-[var(--primary)]"
                      />
                    </td>
                    <td className="px-4 py-3 text-[var(--gray-600)]">{fmtDate(row.originalDate)}</td>
                    <td className="px-4 py-2" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="date"
                        value={row.scheduledDate}
                        disabled={!row.editableDate}
                        onChange={(event) => onUpdate(row, { date: event.target.value })}
                        className="h-9 w-full rounded-lg border border-[var(--border)] bg-white px-2.5 text-[12px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)] disabled:bg-[var(--surface-alt)] disabled:text-[var(--gray-400)]"
                      />
                    </td>
                    <td className="px-4 py-3">{ledgerTypeLabel(row.type)}</td>
                    <td className="px-4 py-3">{row.category}</td>
                    <td className="px-4 py-3">
                      <div className="max-w-[240px] truncate font-medium text-[var(--gray-950)]">{row.entity}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="max-w-[260px] truncate text-[var(--gray-700)]">{row.concept}</div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-[var(--gray-600)]">{fmtCurrency(row.originalAmount)}</td>
                    <td className="px-4 py-2" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.01"
                        value={editableAmount(row.adjustedAmount)}
                        disabled={!row.editableAmount}
                        onChange={(event) => onUpdate(row, { amountInput: event.target.value })}
                        className="h-9 w-full rounded-lg border border-[var(--border)] bg-white px-2.5 text-right text-[12px] tabular-nums text-[var(--gray-950)] outline-none focus:border-[var(--primary)] disabled:bg-[var(--surface-alt)] disabled:text-[var(--gray-400)]"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium ${ledgerStatusClass(row.status)}`}>
                        {ledgerStatusLabel(row.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[var(--gray-700)]">{row.priority}</td>
                    <td className="px-4 py-3 text-[var(--gray-700)]">{row.risk}</td>
                    <td className="px-4 py-3 text-[var(--gray-700)]">{row.flexibility}</td>
                    <td className="px-4 py-2" onClick={(event) => event.stopPropagation()}>
                      <input
                        value={row.comment}
                        disabled={!row.editableDate && !row.editableAmount}
                        onChange={(event) => onUpdate(row, { comment: event.target.value })}
                        className="h-9 w-full rounded-lg border border-[var(--border)] bg-white px-2.5 text-[12px] text-[var(--gray-950)] outline-none placeholder:text-[var(--gray-300)] focus:border-[var(--primary)] disabled:bg-[var(--surface-alt)] disabled:text-[var(--gray-400)]"
                        placeholder="Justificación del ajuste"
                      />
                    </td>
                    <td className="px-4 py-3 text-[var(--gray-500)]">{row.origin}</td>
                    <td className="px-4 py-3 text-[var(--gray-500)]">{fmtDate(row.updatedAt.slice(0, 10))}</td>
                    <td className="px-4 py-3 text-center" onClick={(event) => event.stopPropagation()}>
                      {row.type === 'supplier' ? (
                        <button
                          onClick={() => onSplitSupplier(row)}
                          className="h-8 rounded-lg border border-[var(--border)] bg-white px-2 text-[11px] font-medium text-[var(--gray-700)] hover:bg-[var(--surface-alt)]"
                        >
                          Dividir
                        </button>
                      ) : (
                        <span className="text-[var(--gray-300)]">—</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PlanningImportPreview({
  preview,
  onApply,
  onCancel,
}: {
  preview: PlanningLedgerImportPreview;
  onApply: () => void;
  onCancel: () => void;
}) {
  const dangerCount = preview.changes.filter((change) => change.severity === 'danger').length + preview.errors.length;
  const warningCount = preview.changes.filter((change) => change.severity === 'warning').length;
  const okCount = preview.changes.filter((change) => change.severity === 'ok').length;
  return (
    <div className="border-b border-[var(--border)] bg-[var(--surface-alt)] px-4 py-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-[12px] font-semibold text-[var(--gray-950)]">Vista previa de carga: {preview.fileName}</div>
          <div className="mt-1 text-[11px] text-[var(--gray-500)]">
            {preview.changes.length} cambios detectados · {okCount} limpios · {warningCount} advertencias · {dangerCount} bloqueos · {preview.ignored} ignorados
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="h-9 rounded-lg border border-[var(--border)] bg-white px-3 text-[12px] font-medium text-[var(--gray-700)] hover:bg-[var(--surface-alt)]"
          >
            Cancelar
          </button>
          <button
            onClick={onApply}
            disabled={dangerCount > 0}
            className="h-9 rounded-lg border border-[var(--primary)] bg-[var(--primary)] px-3 text-[12px] font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Aplicar y recalcular
          </button>
        </div>
      </div>

      {(preview.errors.length > 0 || preview.changes.length > 0) && (
        <div className="mt-3 grid gap-2 lg:grid-cols-2">
          {preview.errors.map((error, index) => (
            <div key={`error-${index}`} className="rounded-lg border border-[var(--danger)]/20 bg-white px-3 py-2 text-[11px] text-[var(--danger)]">
              {error}
            </div>
          ))}
          {preview.changes.slice(0, 8).map((change) => (
            <div key={`${change.id}-${change.field}`} className="rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-[11px]">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-semibold text-[var(--gray-950)]">{change.label}</div>
                  <div className="mt-0.5 text-[var(--gray-500)]">{change.field}: {change.before} → {change.after}</div>
                  <div className="mt-0.5 text-[var(--gray-400)]">{change.message}</div>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${importSeverityClass(change.severity)}`}>
                  {importSeverityLabel(change.severity)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PlanningDetailPanel({
  item,
  days,
  onMoveNextWeek,
  onSplitSupplier,
  onHalfPayment,
  onLockPayment,
}: {
  item: PlanningLedgerItem | null;
  days: OperatingProjectionDay[];
  onMoveNextWeek: (item: PlanningLedgerItem) => void;
  onSplitSupplier: (item: PlanningLedgerItem) => void;
  onHalfPayment: (item: PlanningLedgerItem) => void;
  onLockPayment: (item: PlanningLedgerItem) => void;
}) {
  if (!item) {
    return (
      <section className={`${T.section} p-4`}>
        <EmptyMiniState label="Selecciona una línea de la tabla para ver impacto, recomendaciones y acciones." />
      </section>
    );
  }

  const sourceDay = days.find((day) => day.date === item.originalDate);
  const targetDay = days.find((day) => day.date === item.scheduledDate);
  const moved = item.originalDate !== item.scheduledDate;

  return (
    <aside className={`${T.section} overflow-hidden`}>
      <div className="border-b border-[var(--border)] px-4 py-4">
        <div className="text-[11px] font-medium uppercase tracking-[0.02em] text-[var(--gray-400)]">Panel lateral</div>
        <h2 className="mt-1 text-[15px] font-semibold text-[var(--gray-950)]">{item.entity}</h2>
        <p className="mt-1 text-[12px] text-[var(--gray-500)]">{item.concept}</p>
      </div>
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-3 text-[12px]">
          <SelectedKpi label="Monto" value={fmtCurrency(item.adjustedAmount)} />
          <SelectedKpi label="Tipo" value={ledgerTypeLabel(item.type)} />
          <SelectedKpi label="Original" value={fmtDate(item.originalDate)} />
          <SelectedKpi label="Programada" value={fmtDate(item.scheduledDate)} />
          <SelectedKpi label="Riesgo" value={item.risk} />
          <SelectedKpi label="Flexibilidad" value={item.flexibility} />
        </div>

        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-3">
          <div className="text-[12px] font-semibold text-[var(--gray-950)]">Impacto de mover</div>
          <div className="mt-2 space-y-1 text-[11px] text-[var(--gray-600)]">
            <div>Fecha original: {fmtDate(item.originalDate)} · caja cierre {sourceDay ? fmtCompact(sourceDay.closingCash) : 'sin día'}</div>
            <div>Fecha programada: {fmtDate(item.scheduledDate)} · caja cierre {targetDay ? fmtCompact(targetDay.closingCash) : 'sin día'}</div>
            <div className={moved ? 'text-[var(--warning)]' : 'text-[var(--gray-400)]'}>
              {moved
                ? `El escenario conserva el dato original y aplica un ajuste manual por ${fmtCurrency(item.adjustedAmount)}.`
                : 'Sin reprogramación aplicada sobre esta línea.'}
            </div>
          </div>
        </div>

        <div>
          <div className="text-[12px] font-semibold text-[var(--gray-950)]">Recomendación</div>
          <p className="mt-1 text-[12px] leading-5 text-[var(--gray-600)]">
            {item.type === 'supplier'
              ? supplierPanelRecommendation(item)
              : item.type === 'tax'
                ? 'Los impuestos se manejan como obligación manual: conviene prorratear sin desplazar pagos operativos críticos.'
                : 'Valida impacto contra caja mínima y documenta el motivo antes de cerrar el escenario.'}
          </p>
        </div>

        {item.type === 'supplier' && (
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => onMoveNextWeek(item)} className="h-10 rounded-xl border border-[var(--border)] bg-white px-3 text-[12px] font-medium text-[var(--gray-950)] hover:bg-[var(--surface-alt)]">Mover +7</button>
            <button onClick={() => onSplitSupplier(item)} className="h-10 rounded-xl border border-[var(--border)] bg-white px-3 text-[12px] font-medium text-[var(--gray-950)] hover:bg-[var(--surface-alt)]">Dividir 40/30/30</button>
            <button onClick={() => onHalfPayment(item)} className="h-10 rounded-xl border border-[var(--border)] bg-white px-3 text-[12px] font-medium text-[var(--gray-950)] hover:bg-[var(--surface-alt)]">Pagar 50%</button>
            <button onClick={() => onLockPayment(item)} className="h-10 rounded-xl border border-[var(--border)] bg-white px-3 text-[12px] font-medium text-[var(--gray-950)] hover:bg-[var(--surface-alt)]">No mover</button>
          </div>
        )}

        <div className="rounded-xl border border-[var(--border)] px-3 py-3 text-[11px] leading-5 text-[var(--gray-500)]">
          Origen: {item.origin}. Última actualización: {fmtDate(item.updatedAt.slice(0, 10))}. Responsable: usuario local.
        </div>
      </div>
    </aside>
  );
}

function RulePill({ icon: Icon, label }: { icon: typeof Wallet; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-white px-2.5 py-1 text-[var(--gray-600)]">
      <Icon className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

function MiniStat({
  label,
  value,
  accent = 'neutral',
}: {
  label: string;
  value: number;
  accent?: 'neutral' | 'success' | 'danger';
}) {
  const valueClass = accent === 'danger'
    ? 'text-[var(--danger)]'
    : accent === 'success'
      ? 'text-[var(--success)]'
      : 'text-[var(--gray-950)]';
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.02em] text-[var(--gray-400)]">{label}</div>
      <div className={`mt-0.5 font-semibold tabular-nums ${valueClass}`}>
        {fmtCompact(value)}
      </div>
    </div>
  );
}

function SelectedKpi({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.02em] text-[var(--gray-400)]">{label}</div>
      <div className="mt-1 font-semibold tabular-nums text-[var(--gray-950)]">{value}</div>
    </div>
  );
}

const BUCKET_LABELS: Record<SupplierBucket, string> = {
  CRITICO: 'Operativo',
  ALTO:    'Prioritario',
  MEDIO:   'Negociable',
  BAJO:    'Flexible',
};

function SupplierBucketChip({ bucket }: { bucket?: SupplierBucket }) {
  if (!bucket) {
    return <span className="text-[10px] text-[var(--gray-300)]">—</span>;
  }
  const styleMap: Record<SupplierBucket, { bg: string; text: string; border: string }> = {
    CRITICO: { bg: 'var(--danger-muted)',  text: 'var(--danger)',  border: 'oklch(88% 0.08 25)' },
    ALTO:    { bg: '#FEF3C7',              text: '#92400E',         border: '#FCD34D' },
    MEDIO:   { bg: '#FFEDD5',              text: '#9A3412',         border: '#FED7AA' },
    BAJO:    { bg: 'var(--success-muted)', text: 'var(--success)', border: 'oklch(88% 0.08 145)' },
  };
  const s = styleMap[bucket];
  return (
    <span
      className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium"
      style={{ backgroundColor: s.bg, color: s.text, borderColor: s.border }}
    >
      {BUCKET_LABELS[bucket]}
    </span>
  );
}

function SupplierScoreBar({ score }: { score: number | undefined }) {
  if (score == null || !Number.isFinite(score)) {
    return <span className="text-[10px] text-[var(--gray-300)]">—</span>;
  }
  const pct = Math.max(0, Math.min(100, score));
  let color = 'var(--success)';
  if (pct >= 80) color = 'var(--danger)';
  else if (pct >= 60) color = '#F59E0B';
  else if (pct >= 40) color = '#F97316';
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className="w-14 h-1 rounded-full bg-[var(--gray-100)] overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span className="text-[10px] tabular-nums font-medium" style={{ color }}>{pct.toFixed(0)}</span>
    </div>
  );
}

function MinimumOperatingExpenseBanner({
  summary,
  overrides,
  showDetail,
  onToggleDetail,
  months,
  editingMonth,
  overrideDraftAmount,
  overrideDraftNote,
  onStartEdit,
  onCancelEdit,
  onChangeDraftAmount,
  onChangeDraftNote,
  onSaveOverride,
  onRemoveOverride,
}: {
  summary: MinimumExpenseSummary;
  overrides: MinimumExpenseOverride[];
  showDetail: boolean;
  onToggleDetail: () => void;
  months: string[];
  editingMonth: string | null;
  overrideDraftAmount: string;
  overrideDraftNote: string;
  onStartEdit: (yearMonth: string) => void;
  onCancelEdit: () => void;
  onChangeDraftAmount: (value: string) => void;
  onChangeDraftNote: (value: string) => void;
  onSaveOverride: () => void;
  onRemoveOverride: (yearMonth: string) => void;
}) {
  if (summary.criticalCount === 0) return null;
  const topByCategory = summary.byCategory.slice(0, 5);
  const topByProvider = summary.byProvider.slice(0, 8);
  const overridesActive = overrides.length;
  return (
    <div className="border-b border-yellow-200 bg-yellow-50/60 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-yellow-200/70 text-yellow-900">
            <ShieldAlert className="h-4 w-4" strokeWidth={1.75} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-[13px] font-semibold text-yellow-900">
                Gasto mínimo de operación
              </h3>
              <span className="inline-flex items-center rounded-full bg-yellow-200/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-yellow-900">
                Proveedores de Operación
              </span>
              {overridesActive > 0 && (
                <span className="inline-flex items-center rounded-full bg-yellow-300/70 px-2 py-0.5 text-[10px] font-semibold text-yellow-900">
                  {overridesActive} override{overridesActive === 1 ? '' : 's'} manual{overridesActive === 1 ? '' : 'es'}
                </span>
              )}
            </div>
            <p className="mt-1 text-[12px] text-yellow-900/80">
              Piso mensual estimado a partir del histórico 2025 de proveedores marcados como CRÍTICO por Alberto.
              Aparece prorrateado en cada periodo del calendario.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wide text-yellow-900/70">Piso mensual</div>
            <div className="text-[18px] font-semibold tabular-nums text-yellow-900">
              {fmtCurrency(summary.totalMonthly)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wide text-yellow-900/70">Anualizado</div>
            <div className="text-[14px] font-medium tabular-nums text-yellow-900">
              {fmtCurrency(summary.totalAnnual)}
            </div>
          </div>
          <button
            onClick={onToggleDetail}
            className="inline-flex items-center gap-1 rounded-md border border-yellow-300 bg-white/70 px-2.5 py-1 text-[11px] font-medium text-yellow-900 hover:bg-yellow-100"
          >
            {showDetail ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {showDetail ? 'Ocultar desglose' : 'Ver desglose'}
          </button>
        </div>
      </div>

      <div className="mt-2 grid gap-2 text-[11px] text-yellow-900/80 sm:grid-cols-3">
        <div>
          <span className="font-semibold">{summary.criticalCount}</span> proveedores de Operación
        </div>
        <div>
          <span className="font-semibold">{summary.criticalWithData}</span> con histórico calculable
        </div>
        <div>
          <span className="font-semibold">{summary.criticalMissingData}</span> requieren input manual
        </div>
      </div>

      {showDetail && (
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="rounded-lg border border-yellow-200 bg-white/70 p-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-yellow-900/80">
              Top categorías
            </div>
            <ul className="space-y-1">
              {topByCategory.map((cat) => (
                <li key={cat.categoria} className="flex items-center justify-between text-[12px]">
                  <span className="truncate text-yellow-900">{cat.categoria} <span className="text-yellow-900/60">({cat.count})</span></span>
                  <span className="ml-2 shrink-0 font-medium tabular-nums text-yellow-900">{fmtCurrency(cat.total)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-lg border border-yellow-200 bg-white/70 p-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-yellow-900/80">
              Top proveedores críticos
            </div>
            <ul className="space-y-1">
              {topByProvider.map((p) => (
                <li key={p.providerId} className="flex items-center justify-between text-[12px]">
                  <span className="truncate text-yellow-900" title={`${p.providerName} · ${p.frecuencia ?? 'sin frecuencia'}`}>
                    {p.providerName}
                  </span>
                  <span className="ml-2 shrink-0 font-medium tabular-nums text-yellow-900">{fmtCurrency(p.gastoMinimoMensual)}</span>
                </li>
              ))}
            </ul>
          </div>
          {summary.criticalsWithoutData.length > 0 && (
            <div className="rounded-lg border border-yellow-200 bg-white/70 p-3 lg:col-span-2">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-yellow-900/80">
                Críticos sin histórico ({summary.criticalsWithoutData.length}) — requieren un monto mínimo manual
              </div>
              <div className="flex flex-wrap gap-1">
                {summary.criticalsWithoutData.slice(0, 30).map((p) => (
                  <span
                    key={p.providerId}
                    className="inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-[10px] text-yellow-900"
                    title={p.categoria}
                  >
                    {p.providerName}
                  </span>
                ))}
                {summary.criticalsWithoutData.length > 30 && (
                  <span className="inline-flex items-center text-[10px] text-yellow-900/70">
                    + {summary.criticalsWithoutData.length - 30} más
                  </span>
                )}
              </div>
            </div>
          )}

          <div className="rounded-lg border border-yellow-200 bg-white/70 p-3 lg:col-span-2">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-yellow-900/80">
                Override manual del piso por mes
              </div>
              <span className="text-[10px] text-yellow-900/60">
                Si quieres forzar un piso distinto al automático para un mes específico, captúralo aquí.
              </span>
            </div>

            {overrides.length > 0 && (
              <ul className="mb-2 space-y-1">
                {overrides.map((o) => (
                  <li key={o.yearMonth} className="flex items-center justify-between gap-2 rounded-md bg-yellow-50 px-2 py-1 text-[12px]">
                    <span className="font-medium text-yellow-900">{o.yearMonth}</span>
                    <span className="font-semibold tabular-nums text-yellow-900">{fmtCurrency(o.amount)}</span>
                    {o.note && <span className="truncate text-[11px] text-yellow-900/70" title={o.note}>{o.note}</span>}
                    <div className="ml-auto flex gap-1">
                      <button
                        type="button"
                        onClick={() => onStartEdit(o.yearMonth)}
                        className="rounded border border-yellow-300 bg-white px-2 py-0.5 text-[10px] font-medium text-yellow-900 hover:bg-yellow-100"
                      >
                        Editar
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemoveOverride(o.yearMonth)}
                        className="rounded border border-red-200 bg-white px-2 py-0.5 text-[10px] font-medium text-red-700 hover:bg-red-50"
                      >
                        Quitar
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {editingMonth ? (
              <div className="grid gap-2 rounded-md border border-yellow-300 bg-yellow-50 p-2 sm:grid-cols-[120px_1fr_1fr_auto]">
                <select
                  value={editingMonth}
                  onChange={(e) => onStartEdit(e.target.value)}
                  className="rounded border border-yellow-300 bg-white px-2 py-1 text-[12px]"
                >
                  {months.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <input
                  type="number"
                  value={overrideDraftAmount}
                  onChange={(e) => onChangeDraftAmount(e.target.value)}
                  placeholder="Monto del piso ($)"
                  className="rounded border border-yellow-300 bg-white px-2 py-1 text-[12px] tabular-nums"
                />
                <input
                  type="text"
                  value={overrideDraftNote}
                  onChange={(e) => onChangeDraftNote(e.target.value)}
                  placeholder="Nota (opcional)"
                  className="rounded border border-yellow-300 bg-white px-2 py-1 text-[12px]"
                />
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={onSaveOverride}
                    className="rounded bg-yellow-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-yellow-700"
                  >
                    Guardar
                  </button>
                  <button
                    type="button"
                    onClick={onCancelEdit}
                    className="rounded border border-yellow-300 bg-white px-3 py-1 text-[11px] font-medium text-yellow-900 hover:bg-yellow-100"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {months.slice(0, 12).map((m) => {
                  const hasOverride = overrides.some((o) => o.yearMonth === m);
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => onStartEdit(m)}
                      className={`rounded-md border px-2 py-1 text-[11px] font-medium ${
                        hasOverride
                          ? 'border-yellow-400 bg-yellow-200 text-yellow-900'
                          : 'border-yellow-200 bg-white text-yellow-900 hover:bg-yellow-50'
                      }`}
                    >
                      {hasOverride ? '✏️ ' : '+ '}{m}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TreasuryActionPanel({
  actions,
  onOpen,
  onRecalculate,
}: {
  actions: TreasuryActionItem[];
  onOpen: (action: TreasuryActionItem) => void;
  onRecalculate: () => void;
}) {
  return (
    <section className={`${T.section} overflow-hidden`}>
      <div className="flex flex-col gap-3 border-b border-[var(--border)] px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className={`text-[15px] font-semibold ${T.title}`}>Bandeja de planeación</h2>
          <p className={`mt-1 text-[12px] ${T.muted}`}>Prioriza riesgos, pagos y capturas pendientes del escenario activo.</p>
        </div>
        <button
          onClick={onRecalculate}
          className="inline-flex h-10 w-fit items-center justify-center rounded-xl border border-[var(--primary)] bg-[var(--primary)] px-3 text-[13px] font-medium text-white transition-colors hover:opacity-90"
        >
          Recalcular corrida
        </button>
      </div>
      <div className="divide-y divide-[var(--border)]">
        {actions.map((action) => (
          <div key={action.id} className="grid gap-3 px-4 py-3 lg:grid-cols-[160px_minmax(0,1fr)_160px] lg:items-center">
            <div>
              <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium ${actionSeverityClass(action.severity)}`}>
                {actionSeverityLabel(action.severity)}
              </span>
            </div>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-[var(--gray-950)]">{action.title}</div>
              <div className="mt-0.5 truncate text-[12px] text-[var(--gray-500)]">{action.detail}</div>
            </div>
            <button
              onClick={() => onOpen(action)}
              className="inline-flex h-9 items-center justify-center rounded-lg border border-[var(--border)] bg-white px-3 text-[12px] font-medium text-[var(--gray-950)] transition-colors hover:bg-[var(--surface-alt)]"
            >
              {action.cta}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function OperatingPeriodBar({
  months,
  selectedMonth,
  onSelectMonth,
}: {
  months: Array<{
    yearMonth: string;
    closingCash: number;
    pendingSupplierAmount: number;
    unpaidScheduledAmount: number;
  }>;
  selectedMonth: string;
  onSelectMonth: (month: string) => void;
}) {
  const active = months.find((month) => month.yearMonth === selectedMonth) ?? months[0] ?? null;
  return (
    <section className={`${T.section} overflow-hidden`}>
      <div className="grid gap-px bg-[var(--border)] lg:grid-cols-[220px_minmax(0,1fr)]">
        <div className="bg-white px-4 py-3">
          <div className="text-[10px] font-medium uppercase tracking-[0.02em] text-[var(--gray-400)]">Periodo de trabajo</div>
          <div className="mt-1 text-[14px] font-semibold text-[var(--gray-950)]">
            {active ? fmtYearMonthLong(active.yearMonth) : 'Sin periodo'}
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--gray-400)]">
            Cierre {active ? fmtCompact(active.closingCash) : '—'}
          </div>
        </div>
        <div className="flex gap-2 overflow-x-auto bg-white px-4 py-3">
          {months.map((month) => {
            const isActive = month.yearMonth === selectedMonth;
            return (
              <button
                key={month.yearMonth}
                onClick={() => onSelectMonth(month.yearMonth)}
                className={`min-w-[140px] rounded-lg border px-3 py-2 text-left transition-colors ${
                  isActive
                    ? 'border-[var(--primary)] bg-[var(--primary)]/6'
                    : 'border-[var(--border)] hover:bg-[var(--surface-alt)]'
                }`}
              >
                <div className="text-[12px] font-medium text-[var(--gray-950)]">{fmtYearMonthLong(month.yearMonth)}</div>
                <div className="mt-1 text-[11px] tabular-nums text-[var(--gray-500)]">
                  Caja {fmtCompact(month.closingCash)}
                </div>
                <div className="mt-0.5 text-[10px] tabular-nums text-[var(--gray-400)]">
                  Pendiente {fmtCompact(month.pendingSupplierAmount + month.unpaidScheduledAmount)}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function OperatingBlocksPanel({
  blocks,
  expanded,
  onToggle,
  onSchedule,
  onExpandAll,
  onCollapseAll,
}: {
  blocks: OperatingBlockCard[];
  expanded: Set<OperatingBlockId>;
  onToggle: (id: OperatingBlockId) => void;
  onSchedule: (seed: { kind: 'adjustment' | 'obligation'; direction?: 'inflow' | 'outflow' } | null) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}) {
  return (
    <section className={`${T.section} overflow-hidden`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
        <div>
          <h2 className={`text-[15px] font-semibold ${T.title}`}>Bloques operativos</h2>
          <p className={`text-[12px] ${T.muted}`}>
            Abre o cierra cada bloque. Programa nuevos movimientos directo al calendario y el algoritmo recalcula caja al instante.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onSchedule(null)}
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-[var(--primary)] bg-[var(--primary)] px-3 text-[12px] font-medium text-white transition-colors hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            Programar movimiento
          </button>
          <button
            onClick={onExpandAll}
            className="h-9 rounded-xl border border-[var(--border)] bg-white px-3 text-[12px] font-medium text-[var(--gray-700)] transition-colors hover:bg-[var(--surface-alt)]"
          >
            Abrir todo
          </button>
          <button
            onClick={onCollapseAll}
            className="h-9 rounded-xl border border-[var(--border)] bg-white px-3 text-[12px] font-medium text-[var(--gray-700)] transition-colors hover:bg-[var(--surface-alt)]"
          >
            Cerrar todo
          </button>
        </div>
      </div>
      <div className="divide-y divide-[var(--border)]">
        {blocks.map((block) => {
          const isOpen = expanded.has(block.id);
          const toneClass = block.tone === 'success'
            ? 'text-[var(--success)]'
            : block.tone === 'danger'
              ? 'text-[var(--danger)]'
              : block.tone === 'warning'
                ? 'text-[var(--warning)]'
                : 'text-[var(--gray-950)]';
          const sparkColor = block.tone === 'success'
            ? 'var(--success)'
            : block.tone === 'danger'
              ? 'var(--danger)'
              : block.tone === 'warning'
                ? 'var(--warning)'
                : 'var(--primary)';
          return (
            <div key={block.id} className="grid items-center gap-3 px-4 py-3 lg:grid-cols-[minmax(0,1.4fr)_120px_minmax(0,1fr)_140px_minmax(0,180px)]">
              <button
                onClick={() => onToggle(block.id)}
                className="flex min-w-0 items-center gap-2 text-left"
              >
                {isOpen
                  ? <ChevronDown className="h-4 w-4 shrink-0 text-[var(--gray-500)]" />
                  : <ChevronRight className="h-4 w-4 shrink-0 text-[var(--gray-500)]" />}
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-[var(--gray-950)]">{block.label}</div>
                  <div className="line-clamp-1 text-[11px] text-[var(--gray-400)]">{block.description}</div>
                </div>
              </button>
              <div className="text-right">
                <div className={`text-[14px] font-semibold tabular-nums ${toneClass}`}>{fmtCompact(block.total)}</div>
                <div className="text-[10px] uppercase tracking-wider text-[var(--gray-400)]">total mes</div>
              </div>
              <div>
                <Sparkline data={block.sparkline} width={120} height={28} color={sparkColor} areaFill />
              </div>
              <div className="text-right">
                <div className="text-[13px] font-semibold tabular-nums text-[var(--gray-950)]">{block.count}</div>
                <div className="text-[10px] uppercase tracking-wider text-[var(--gray-400)]">{block.countLabel}</div>
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => onSchedule(block.scheduleSeed ?? null)}
                  className="inline-flex h-9 items-center gap-1 rounded-xl border border-[var(--border)] bg-white px-3 text-[12px] font-medium text-[var(--gray-700)] transition-colors hover:bg-[var(--surface-alt)]"
                  title={block.scheduleHint ?? 'Programar nuevo movimiento'}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Programar
                </button>
                <button
                  onClick={() => onToggle(block.id)}
                  className="inline-flex h-9 items-center rounded-xl border border-[var(--border)] bg-white px-3 text-[12px] font-medium text-[var(--gray-700)] transition-colors hover:bg-[var(--surface-alt)]"
                >
                  {isOpen ? 'Cerrar' : 'Editar inline'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

const TOP_CHART_COLORS = {
  inflow: COLOR.inflow,
  outflow: COLOR.suppliers,
  suppliers: COLOR.suppliers,
  taxes: '#9333ea',
  obligations: '#0ea5e9',
  adjustments: COLOR.warning,
  riskBar: '#dc2626',
  riskLine: '#0f172a',
} as const;

function OperatingTopCharts({
  days,
  allDays,
  minimumCash,
  monthSupplier,
  monthTax,
  monthObligations,
  monthAdjustmentOutflows,
}: {
  days: OperatingProjectionDay[];
  allDays: OperatingProjectionDay[];
  minimumCash: number;
  monthSupplier: number;
  monthTax: number;
  monthObligations: number;
  monthAdjustmentOutflows: number;
}) {
  const barData = days.map((day) => ({
    date: day.date,
    label: shortDayLabel(day.date),
    inflows: sumAmounts(day.cashInflows),
    outflows: sumAmounts(day.scheduledOutflows) + sumAmounts(day.supplierPayments),
  }));

  const donutSlices = [
    { key: 'suppliers', name: 'Proveedores', value: monthSupplier, fill: TOP_CHART_COLORS.suppliers },
    { key: 'taxes', name: 'Impuestos', value: monthTax, fill: TOP_CHART_COLORS.taxes },
    { key: 'obligations', name: 'Obligaciones', value: monthObligations, fill: TOP_CHART_COLORS.obligations },
    { key: 'adjustments', name: 'Ajustes', value: monthAdjustmentOutflows, fill: TOP_CHART_COLORS.adjustments },
  ].filter((slice) => slice.value > 0);
  const donutTotal = donutSlices.reduce((sum, slice) => sum + slice.value, 0);

  const weeklyMap = new Map<string, { week: string; weekNum: number; firstDate: string; total: number; risk: number }>();
  for (const day of allDays) {
    const key = isoWeekKey(day.date);
    let bucket = weeklyMap.get(key);
    if (!bucket) {
      bucket = { week: key, weekNum: isoWeekNumber(day.date), firstDate: day.date, total: 0, risk: 0 };
      weeklyMap.set(key, bucket);
    }
    bucket.total += 1;
    if (day.closingCash < minimumCash) bucket.risk += 1;
  }
  const weeklyData = Array.from(weeklyMap.values())
    .sort((a, b) => a.week.localeCompare(b.week))
    .map((bucket) => ({
      label: `S${String(bucket.weekNum).padStart(2, '0')}`,
      risk: bucket.risk,
      total: bucket.total,
    }));

  return (
    <section className={`${T.section} overflow-hidden`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
        <div>
          <h2 className={`text-[15px] font-semibold ${T.title}`}>Pulso del mes</h2>
          <p className={`text-[12px] ${T.muted}`}>
            Movimientos diarios, en qué se va el efectivo y qué semanas tienen días bajo el mínimo de caja.
          </p>
        </div>
      </div>
      <div className="grid gap-4 px-4 py-4 lg:grid-cols-3">
        <div className="rounded-xl border border-[var(--border)] bg-white p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[12px] font-medium text-[var(--gray-700)]">Ingresos vs egresos por día</div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--gray-400)]">{barData.length} días</div>
          </div>
          <div className="h-48">
            {barData.length === 0 ? (
              <EmptyMiniState label="Sin movimientos del mes" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={barData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={COLOR.grid} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: COLOR.tickText }} stroke={COLOR.axis} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 10, fill: COLOR.tickText }} stroke={COLOR.axis} tickFormatter={(value) => fmtCompact(Number(value))} width={56} />
                  <Tooltip
                    cursor={{ fill: 'rgba(15,23,42,0.04)' }}
                    formatter={(value: number, name: string) => [fmtCurrency(value), name === 'inflows' ? 'Ingresos' : 'Egresos']}
                    labelFormatter={(label: string) => label}
                    contentStyle={{ borderRadius: 12, border: `1px solid ${COLOR.axis}`, fontSize: 12 }}
                  />
                  <Bar dataKey="inflows" name="Ingresos" fill={TOP_CHART_COLORS.inflow} radius={[3, 3, 0, 0]} />
                  <Bar dataKey="outflows" name="Egresos" fill={TOP_CHART_COLORS.outflow} radius={[3, 3, 0, 0]} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-[var(--border)] bg-white p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[12px] font-medium text-[var(--gray-700)]">Composición de egresos</div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--gray-400)]">total {fmtCompact(donutTotal)}</div>
          </div>
          <div className="h-48">
            {donutTotal === 0 ? (
              <EmptyMiniState label="Sin egresos del mes" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Tooltip
                    formatter={(value: number, name: string) => [fmtCurrency(value), name]}
                    contentStyle={{ borderRadius: 12, border: `1px solid ${COLOR.axis}`, fontSize: 12 }}
                  />
                  <Pie
                    data={donutSlices}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={48}
                    outerRadius={72}
                    paddingAngle={2}
                    stroke="white"
                  >
                    {donutSlices.map((slice) => (
                      <Cell key={slice.key} fill={slice.fill} />
                    ))}
                  </Pie>
                  <Legend
                    verticalAlign="bottom"
                    height={28}
                    iconType="circle"
                    wrapperStyle={{ fontSize: 11, color: COLOR.tickText }}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-[var(--border)] bg-white p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[12px] font-medium text-[var(--gray-700)]">Días bajo el mínimo por semana</div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--gray-400)]">mín {fmtCompact(minimumCash)}</div>
          </div>
          <div className="h-48">
            {weeklyData.length === 0 ? (
              <EmptyMiniState label="Sin datos por semana" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={weeklyData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={COLOR.grid} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: COLOR.tickText }} stroke={COLOR.axis} interval="preserveStartEnd" />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: COLOR.tickText }} stroke={COLOR.axis} width={28} />
                  <Tooltip
                    cursor={{ fill: 'rgba(15,23,42,0.04)' }}
                    formatter={(value: number, name: string) => [`${value} días`, name === 'risk' ? 'Bajo mínimo' : 'Total']}
                    contentStyle={{ borderRadius: 12, border: `1px solid ${COLOR.axis}`, fontSize: 12 }}
                  />
                  <Bar dataKey="risk" name="risk" fill={TOP_CHART_COLORS.riskBar} radius={[3, 3, 0, 0]} />
                  <Line type="monotone" dataKey="total" name="total" stroke={TOP_CHART_COLORS.riskLine} strokeWidth={1} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function OperatingStickyHeader({
  scenarios,
  activeScenarioId,
  onActivate,
  endingCash,
  minimumCash,
  cashGap,
  criticalPayments,
  riskDays,
}: {
  scenarios: OperatingProjectionScenario[];
  activeScenarioId: string;
  onActivate: (id: string) => void;
  endingCash: number;
  minimumCash: number;
  cashGap: number;
  criticalPayments: number;
  riskDays: number;
}) {
  const cashTone = cashGap >= 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]';
  const riskTone = riskDays > 0 ? 'text-[var(--danger)]' : 'text-[var(--success)]';
  const criticalTone = criticalPayments > 0 ? 'text-[var(--warning)]' : 'text-[var(--success)]';
  return (
    <div className="sticky top-0 z-30 -mx-4 border-b border-[var(--border)] bg-white/90 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-white/75 lg:-mx-6 lg:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-medium uppercase tracking-[0.04em] text-[var(--gray-400)]">Escenario</span>
          {scenarios.map((scenario) => {
            const isActive = scenario.id === activeScenarioId;
            return (
              <button
                key={scenario.id}
                onClick={() => onActivate(scenario.id)}
                className={`inline-flex h-7 items-center rounded-full border px-3 text-[11px] font-medium transition-colors ${
                  isActive
                    ? 'border-[var(--primary)] bg-[var(--primary)] text-white'
                    : 'border-[var(--border)] bg-white text-[var(--gray-700)] hover:bg-[var(--surface-alt)]'
                }`}
              >
                {scenario.name}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-4 text-right">
          <StickyKpi label="Caja final" value={fmtCompact(endingCash)} tone={endingCash >= 0 ? 'text-[var(--gray-950)]' : 'text-[var(--danger)]'} />
          <StickyKpi label="Mínimo" value={fmtCompact(minimumCash)} tone="text-[var(--gray-700)]" />
          <StickyKpi label={cashGap >= 0 ? 'Excedente' : 'Déficit'} value={fmtCompact(cashGap)} tone={cashTone} />
          <StickyKpi label="Pagos críticos" value={String(criticalPayments)} tone={criticalTone} />
          <StickyKpi label="Días bajo mínimo" value={String(riskDays)} tone={riskTone} />
        </div>
      </div>
    </div>
  );
}

function StickyKpi({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="text-right">
      <div className="text-[9px] uppercase tracking-[0.04em] text-[var(--gray-400)]">{label}</div>
      <div className={`text-[13px] font-semibold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

function CobranzaBlock({
  expanded,
  days,
  monthLabel,
  monthCollectionsTotal,
}: {
  expanded: boolean;
  days: OperatingProjectionDay[];
  monthLabel: string;
  monthCollectionsTotal: number;
}) {
  if (!expanded) return null;
  const dailyRows = days
    .map((day) => {
      const lines = collectionLines(day);
      const total = sumAmounts(lines);
      return { date: day.date, label: shortDayLabel(day.date), lines, total };
    })
    .filter((row) => row.lines.length > 0);
  const collectionCount = dailyRows.reduce((sum, row) => sum + row.lines.length, 0);
  const bestDay = dailyRows.reduce<{ label: string; total: number } | null>((best, row) => {
    if (!best || row.total > best.total) return { label: row.label, total: row.total };
    return best;
  }, null);
  return (
    <section className={`${T.section} overflow-hidden`}>
      <div className="flex flex-col gap-3 border-b border-[var(--border)] px-4 py-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h2 className={`text-[15px] font-semibold ${T.title}`}>Cobranza programada</h2>
          <p className={`mt-1 text-[12px] ${T.muted}`}>
            Cobros proyectados por día. {monthLabel}.
          </p>
        </div>
      </div>
      <div className="grid gap-3 border-b border-[var(--border)] px-4 py-3 sm:grid-cols-2 xl:grid-cols-4">
        <SelectedKpi label="Mes" value={monthLabel} />
        <SelectedKpi label="Total cobranza" value={fmtCurrency(monthCollectionsTotal)} />
        <SelectedKpi label="Cobros del mes" value={String(collectionCount)} />
        <SelectedKpi label="Mejor día" value={bestDay ? `${bestDay.label} · ${fmtCompact(bestDay.total)}` : '—'} />
      </div>
      <div className="px-4 py-3">
        {dailyRows.length === 0 ? (
          <EmptyMiniState label="Sin cobranza proyectada para el mes" />
        ) : (
          <div className="overflow-hidden rounded-xl border border-[var(--border)]">
            <table className="w-full text-[12px]">
              <thead className="bg-[var(--surface-alt)]">
                <tr>
                  <Th>Día</Th>
                  <Th>Cliente</Th>
                  <Th>Detalle</Th>
                  <Th align="right">Monto</Th>
                </tr>
              </thead>
              <tbody>
                {dailyRows.flatMap((row) =>
                  row.lines.map((line, index) => (
                    <tr
                      key={`${row.date}:${line.id}:${index}`}
                      className="border-t border-[var(--border)] hover:bg-[var(--surface-alt)]"
                    >
                      <td className="px-3 py-2 text-[var(--gray-700)]">
                        {index === 0 ? row.label : ''}
                      </td>
                      <td className="px-3 py-2 font-medium text-[var(--gray-950)]">{line.label}</td>
                      <td className="px-3 py-2 text-[11px] text-[var(--gray-500)]">
                        {line.detail ?? 'Cobranza proyectada'}
                        {line.confidence ? ` · ${line.confidence}` : ''}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-[var(--gray-950)]">{fmtCurrency(line.amount)}</td>
                    </tr>
                  )),
                )}
                <tr className="border-t border-[var(--border)] bg-[var(--surface-alt)] font-semibold">
                  <td className="px-3 py-2" colSpan={3}>Total mes</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtCurrency(monthCollectionsTotal)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' | 'center' }) {
  const classes = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
  return <th className={`px-4 py-2.5 font-medium ${classes}`}>{children}</th>;
}

function EditableProjectionCell({
  value,
  protectedValue,
  tone,
  disabled = false,
  onChange,
}: {
  value: string;
  protectedValue: number;
  tone: 'success' | 'danger';
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const toneClass = tone === 'success'
    ? 'focus:border-[var(--success)] focus:bg-[var(--success)]/5'
    : 'focus:border-[var(--danger)] focus:bg-[var(--danger)]/5';
  return (
    <div onClick={(event) => event.stopPropagation()} className="min-w-[132px]">
      <input
        type="number"
        inputMode="decimal"
        min="0"
        step="0.01"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={(event) => event.stopPropagation()}
        disabled={disabled}
        placeholder={disabled ? '—' : '0.00'}
        title={disabled ? 'Los ajustes se capturan en días hábiles' : 'Editar ajuste de proyección'}
        className={`h-9 w-full rounded-lg border border-[var(--border)] bg-white px-2.5 text-right text-[12px] tabular-nums text-[var(--gray-950)] outline-none transition-colors placeholder:text-[var(--gray-300)] disabled:bg-[var(--surface-alt)] disabled:text-[var(--gray-300)] ${toneClass}`}
      />
      {protectedValue > 0 && (
        <div className="mt-1 text-right text-[10px] text-[var(--gray-400)]">
          detalle {fmtCompact(protectedValue)}
        </div>
      )}
    </div>
  );
}

function MandatoryPaymentExcelSheet({
  rows,
  manualRows,
  onSetCell,
  onShiftDate,
  onSplitDate,
}: {
  rows: MandatoryPaymentSheetRow[];
  manualRows: ManualEventRow[];
  onSetCell: (date: string, concept: ManualEventRow['concept'], value: string) => void;
  onShiftDate: (date: string, days: number) => void;
  onSplitDate: (date: string, days: number) => void;
}) {
  return (
    <div className="overflow-x-auto border-b border-[var(--border)]">
      <table className="w-full min-w-[1180px] text-[12px]">
        <thead className="bg-[var(--surface-alt)] text-[var(--gray-500)]">
          <tr>
            <Th>Fecha de pago</Th>
            {OBLIGATION_MANUAL_CONCEPTS.map((concept) => (
              <Th key={concept} align="right">{concept}</Th>
            ))}
            <Th align="right">Total</Th>
            <Th align="center">Patear</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={OBLIGATION_MANUAL_CONCEPTS.length + 3} className="px-4 py-6">
                <EmptyMiniState label="Sin fechas en el mes. Agrega una fecha o escribe montos en la hoja para modelar pagos obligatorios." />
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.date} className="border-t border-[var(--border)] align-top">
                <td className="px-4 py-3">
                  <div className="font-medium text-[var(--gray-950)]">{fmtDate(row.date)}</div>
                  <div className="text-[11px] text-[var(--gray-400)]">{row.label}</div>
                </td>
                {OBLIGATION_MANUAL_CONCEPTS.map((concept) => {
                  const protectedValue = protectedManualCellTotal(manualRows, row.date, concept);
                  return (
                    <td key={concept} className="px-4 py-2">
                      <EditableObligationCell
                        value={manualCellInputValue(manualRows, row.date, concept)}
                        protectedValue={protectedValue}
                        onChange={(value) => onSetCell(row.date, concept, value)}
                      />
                    </td>
                  );
                })}
                <td className="px-4 py-3 text-right font-semibold tabular-nums text-[var(--gray-950)]">
                  {row.total > 0 ? fmtCurrency(row.total) : '—'}
                </td>
                <td className="px-4 py-3">
                  <div className="flex justify-center gap-1">
                    {[7, 15, 30].map((days) => (
                      <button
                        key={days}
                        onClick={() => onShiftDate(row.date, days)}
                        disabled={row.total <= 0}
                        className="h-8 rounded-lg border border-[var(--border)] bg-white px-2 text-[11px] font-medium text-[var(--gray-700)] transition-colors hover:bg-[var(--surface-alt)] disabled:cursor-not-allowed disabled:opacity-40"
                        title={`Patear ${days} días`}
                      >
                        +{days}
                      </button>
                    ))}
                    <button
                      onClick={() => onSplitDate(row.date, 30)}
                      disabled={row.total <= 0}
                      className="h-8 rounded-lg border border-[var(--border)] bg-white px-2 text-[11px] font-medium text-[var(--gray-700)] transition-colors hover:bg-[var(--surface-alt)] disabled:cursor-not-allowed disabled:opacity-40"
                      title="Partir 50/50 y mandar la mitad a 30 días"
                    >
                      50/50
                    </button>
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function EditableObligationCell({
  value,
  protectedValue,
  onChange,
}: {
  value: string;
  protectedValue: number;
  onChange: (value: string) => void;
}) {
  return (
    <div className="min-w-[128px]">
      <input
        type="number"
        inputMode="decimal"
        min="0"
        step="0.01"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="0.00"
        className="h-9 w-full rounded-lg border border-[var(--border)] bg-white px-2.5 text-right text-[12px] tabular-nums text-[var(--gray-950)] outline-none transition-colors placeholder:text-[var(--gray-300)] focus:border-[var(--primary)]"
      />
      {protectedValue > 0 && (
        <div className="mt-1 text-right text-[10px] text-[var(--gray-400)]">detalle {fmtCompact(protectedValue)}</div>
      )}
    </div>
  );
}

function TaxDebtSummaryView({
  debts,
  summary,
  today,
}: {
  debts: OperatingTaxDebt[];
  summary: OperatingTaxDebtSummary;
  today: string;
}) {
  const byYear = [2025, 2026, ...Array.from(new Set(debts.map((debt) => debt.fiscalYear))).filter((year) => year !== 2025 && year !== 2026).sort()];
  const highRiskDebts = debts
    .filter((debt) => effectiveOutstanding(debt) > 0)
    .sort((a, b) => {
      const riskDelta = taxRiskWeight(b.legalRisk) - taxRiskWeight(a.legalRisk);
      if (riskDelta !== 0) return riskDelta;
      return a.dueDate.localeCompare(b.dueDate);
    })
    .slice(0, 8);

  return (
    <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="overflow-hidden rounded-xl border border-[var(--border)]">
        <div className="border-b border-[var(--border)] bg-[var(--surface-alt)] px-4 py-3">
          <h3 className="text-[13px] font-semibold text-[var(--gray-950)]">Deuda por año fiscal</h3>
          <p className="mt-0.5 text-[11px] text-[var(--gray-400)]">Pendiente, programado y faltante por programar.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-[12px]">
            <thead className="bg-white text-[var(--gray-500)]">
              <tr>
                <Th>Año</Th>
                <Th align="right">Adeudos</Th>
                <Th align="right">Pendiente</Th>
                <Th align="right">Programado</Th>
                <Th align="right">Falta plan</Th>
                <Th align="right">Vencido</Th>
              </tr>
            </thead>
            <tbody>
              {byYear.map((year) => {
                const yearDebts = debts.filter((debt) => debt.fiscalYear === year);
                const outstanding = yearDebts.reduce((sum, debt) => sum + effectiveOutstanding(debt), 0);
                const planned = yearDebts.reduce((sum, debt) => sum + plannedTotal(debt), 0);
                const overdue = yearDebts
                  .filter((debt) => debt.dueDate < today)
                  .reduce((sum, debt) => sum + effectiveOutstanding(debt), 0);
                return (
                  <tr key={year} className="border-t border-[var(--border)]">
                    <td className="px-4 py-3 font-medium text-[var(--gray-950)]">{year}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-[var(--gray-700)]">{yearDebts.length}</td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums text-[var(--danger)]">{fmtCurrency(outstanding)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-[var(--primary)]">{planned > 0 ? fmtCurrency(planned) : '—'}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-[var(--warning)]">{fmtCurrency(Math.max(0, outstanding - planned))}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-[var(--danger)]">{overdue > 0 ? fmtCurrency(overdue) : '—'}</td>
                  </tr>
                );
              })}
              {debts.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-5">
                    <EmptyMiniState label="Sin adeudos fiscales capturados. Agrega adeudos 2025/2026 para construir el plan." />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="space-y-3">
        <div className="rounded-xl border border-[var(--border)] p-4">
          <h3 className="text-[13px] font-semibold text-[var(--gray-950)]">Lectura fiscal</h3>
          <div className="mt-3 grid grid-cols-2 gap-3 text-[12px]">
            <SelectedKpi label="Pendiente" value={fmtCurrency(summary.outstanding)} />
            <SelectedKpi label="Programado mes" value={fmtCurrency(summary.scheduledThisMonth)} />
            <SelectedKpi label="Vencido" value={fmtCurrency(summary.overdue)} />
            <SelectedKpi label="Falta plan" value={fmtCurrency(summary.unscheduled)} />
          </div>
        </div>
        <div className="rounded-xl border border-[var(--border)] p-4">
          <h3 className="text-[13px] font-semibold text-[var(--gray-950)]">Riesgos fiscales</h3>
          <div className="mt-3 space-y-2">
            {highRiskDebts.length === 0 ? (
              <EmptyMiniState label="Sin adeudos fiscales pendientes." />
            ) : (
              highRiskDebts.map((debt) => (
                <div key={debt.id} className="rounded-lg border border-[var(--border)] px-3 py-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-medium text-[var(--gray-950)]">{debt.label}</div>
                      <div className="mt-0.5 text-[10px] text-[var(--gray-400)]">
                        {[
                          String(debt.fiscalYear),
                          debt.taxType,
                          debt.authority,
                          debt.fiscalPeriod,
                          debt.agreementId ? `convenio ${debt.agreementId}` : null,
                          `vence ${fmtDate(debt.dueDate)}`,
                        ].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-[12px] font-semibold tabular-nums text-[var(--danger)]">{fmtCompact(effectiveOutstanding(debt))}</div>
                      <div className={`mt-0.5 text-[10px] font-medium ${taxLegalRiskClass(debt.legalRisk)}`}>{taxLegalRiskLabel(debt.legalRisk)}</div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TaxDebtEditor({
  rows,
  onChangeRows,
  onAddDebt,
  selectedMonth,
}: {
  rows: TaxDebtRow[];
  onChangeRows: (updater: (current: TaxDebtRow[]) => TaxDebtRow[]) => void;
  onAddDebt: () => void;
  selectedMonth: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1960px] text-[12px]">
        <thead className="bg-[var(--surface-alt)] text-[var(--gray-500)]">
          <tr>
            <Th>Año / impuesto</Th>
            <Th>Descripción</Th>
            <Th>Autoridad / periodo</Th>
            <Th align="right">Original</Th>
            <Th align="right">Pagado</Th>
            <Th align="right">Pendiente</Th>
            <Th align="right">Recargos</Th>
            <Th>Fecha límite</Th>
            <Th>Prioridad</Th>
            <Th>Riesgo legal</Th>
            <Th>Convenio / estatus</Th>
            <Th>Comentarios</Th>
            <Th align="center">Pagos</Th>
            <Th align="center">Acción</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={14} className="px-4 py-6">
                <EmptyMiniState label="Sin adeudos fiscales. Agrega ISR, IVA, IMSS, ISN, convenio u otro adeudo para planear pagos parciales." />
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const planned = row.plannedPayments.reduce((sum, payment) => sum + (Number(payment.amountInput) || 0), 0);
              const outstanding = (Number(row.outstandingAmountInput) || 0) + (Number(row.surchargeAmountInput) || 0);
              return (
                <tr key={row.id} className="border-t border-[var(--border)] align-top">
                  <td className="px-4 py-3">
                    <div className="grid grid-cols-[88px_130px] gap-2">
                      <input
                        value={row.fiscalYearInput}
                        onChange={(event) => updateTaxDebtRow(onChangeRows, row.id, { fiscalYearInput: event.target.value })}
                        className="h-10 rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)]"
                      />
                      <select
                        value={row.taxType}
                        onChange={(event) => updateTaxDebtRow(onChangeRows, row.id, { taxType: event.target.value as OperatingTaxType })}
                        className="h-10 rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)]"
                      >
                        {(['ISR', 'IVA', 'IMSS', 'ISN', 'Convenio', 'Otro'] as OperatingTaxType[]).map((type) => (
                          <option key={type} value={type}>{type}</option>
                        ))}
                      </select>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <input
                      value={row.label}
                      onChange={(event) => updateTaxDebtRow(onChangeRows, row.id, { label: event.target.value })}
                      placeholder="Adeudo ISR 2025, convenio IVA..."
                      className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none placeholder:text-[var(--gray-300)] focus:border-[var(--primary)]"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        value={row.authority}
                        onChange={(event) => updateTaxDebtRow(onChangeRows, row.id, { authority: event.target.value })}
                        placeholder="SAT, IMSS..."
                        className="h-10 rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none placeholder:text-[var(--gray-300)] focus:border-[var(--primary)]"
                      />
                      <input
                        value={row.fiscalPeriod}
                        onChange={(event) => updateTaxDebtRow(onChangeRows, row.id, { fiscalPeriod: event.target.value })}
                        placeholder="2025 anual, ene-abr..."
                        className="h-10 rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none placeholder:text-[var(--gray-300)] focus:border-[var(--primary)]"
                      />
                    </div>
                  </td>
                  {(['originalAmountInput', 'paidAmountInput', 'outstandingAmountInput'] as const).map((field) => (
                    <td key={field} className="px-4 py-3">
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.01"
                        value={row[field]}
                        onChange={(event) => updateTaxDebtRow(onChangeRows, row.id, { [field]: event.target.value })}
                        className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-right text-[13px] tabular-nums text-[var(--gray-950)] outline-none focus:border-[var(--primary)]"
                      />
                    </td>
                  ))}
                  <td className="px-4 py-3">
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.01"
                      value={row.surchargeAmountInput}
                      onChange={(event) => updateTaxDebtRow(onChangeRows, row.id, { surchargeAmountInput: event.target.value })}
                      className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-right text-[13px] tabular-nums text-[var(--gray-950)] outline-none focus:border-[var(--primary)]"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <input
                      type="date"
                      value={row.dueDate}
                      onChange={(event) => updateTaxDebtRow(onChangeRows, row.id, { dueDate: event.target.value })}
                      className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)]"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={row.priority}
                      onChange={(event) => updateTaxDebtRow(onChangeRows, row.id, { priority: event.target.value as OperatingTaxPriority })}
                      className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)]"
                    >
                      {(['baja', 'media', 'alta', 'critica'] as OperatingTaxPriority[]).map((priority) => (
                        <option key={priority} value={priority}>{taxPriorityLabel(priority)}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={row.legalRisk}
                      onChange={(event) => updateTaxDebtRow(onChangeRows, row.id, { legalRisk: event.target.value as OperatingTaxLegalRisk })}
                      className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)]"
                    >
                      {(['bajo', 'medio', 'alto'] as OperatingTaxLegalRisk[]).map((risk) => (
                        <option key={risk} value={risk}>{taxLegalRiskLabel(risk)}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        value={row.agreementId}
                        onChange={(event) => updateTaxDebtRow(onChangeRows, row.id, { agreementId: event.target.value })}
                        placeholder="Convenio"
                        className="h-10 rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none placeholder:text-[var(--gray-300)] focus:border-[var(--primary)]"
                      />
                      <input
                        value={row.legalStatus}
                        onChange={(event) => updateTaxDebtRow(onChangeRows, row.id, { legalStatus: event.target.value })}
                        placeholder="En negociación, requerido..."
                        className="h-10 rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none placeholder:text-[var(--gray-300)] focus:border-[var(--primary)]"
                      />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <input
                      value={row.comments}
                      onChange={(event) => updateTaxDebtRow(onChangeRows, row.id, { comments: event.target.value })}
                      placeholder="Estatus SAT, convenio, negociación..."
                      className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none placeholder:text-[var(--gray-300)] focus:border-[var(--primary)]"
                    />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="font-semibold tabular-nums text-[var(--gray-950)]">{fmtCompact(planned)}</div>
                    <div className={`mt-0.5 text-[10px] ${planned >= outstanding ? 'text-[var(--success)]' : 'text-[var(--warning)]'}`}>
                      {planned >= outstanding ? 'cubierto' : `faltan ${fmtCompact(Math.max(0, outstanding - planned))}`}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="flex justify-center gap-1">
                      <button
                        onClick={() => onChangeRows((current) => addTaxPaymentRow(current, row.id, `${selectedMonth}-01`))}
                        className="inline-flex h-9 items-center rounded-lg border border-[var(--border)] bg-white px-2.5 text-[11px] font-medium text-[var(--gray-700)] hover:bg-[var(--surface-alt)]"
                      >
                        Pago
                      </button>
                      <button
                        onClick={() => onChangeRows((current) => current.filter((item) => item.id !== row.id))}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] text-[var(--gray-500)] hover:bg-[var(--danger)]/8 hover:text-[var(--danger)]"
                        title="Eliminar adeudo fiscal"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })
          )}
          <tr className="border-t border-[var(--border)]">
            <td colSpan={14} className="px-4 py-3">
              <button
                onClick={onAddDebt}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-white px-3 text-[12px] font-medium text-[var(--gray-950)] hover:bg-[var(--surface-alt)]"
              >
                <Plus className="h-3.5 w-3.5" />
                Agregar adeudo fiscal
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function TaxPaymentPlanEditor({
  rows,
  onChangeRows,
  selectedMonth,
  taxSheetRows,
}: {
  rows: TaxDebtRow[];
  onChangeRows: (updater: (current: TaxDebtRow[]) => TaxDebtRow[]) => void;
  selectedMonth: string;
  taxSheetRows: TaxPaymentSheetRow[];
}) {
  const planRows = rows.flatMap((debt) => debt.plannedPayments.map((payment) => ({ debt, payment })))
    .sort((a, b) => a.payment.date.localeCompare(b.payment.date));

  return (
    <div>
      <div className="overflow-x-auto border-b border-[var(--border)]">
        <table className="w-full min-w-[1320px] text-[12px]">
          <thead className="bg-[var(--surface-alt)] text-[var(--gray-500)]">
            <tr>
              <Th>Periodo</Th>
              <Th>Fecha sugerida</Th>
              <Th align="right">Plan fiscal</Th>
              <Th align="right">Entradas</Th>
              <Th align="right">Operación</Th>
              <Th align="right">Proveedores</Th>
              <Th align="right">Disponible</Th>
              <Th align="right">Caja cierre</Th>
              <Th align="center">Acción</Th>
            </tr>
          </thead>
          <tbody>
            {taxSheetRows.map((row) => {
              const payments = planRows.filter(({ payment }) => dateInRange(payment.date, row.startDate, row.endDate));
              const planned = payments.reduce((sum, entry) => sum + (Number(entry.payment.amountInput) || 0), 0);
              return (
                <tr key={row.id} className="border-t border-[var(--border)] align-top">
                  <td className="px-4 py-3">
                    <div className="font-medium text-[var(--gray-950)]">{row.label}</div>
                    <div className="text-[11px] text-[var(--gray-400)]">{row.sublabel}</div>
                  </td>
                  <td className="px-4 py-3 text-[var(--gray-700)]">{fmtDate(row.effectiveDate)}</td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums text-[var(--danger)]">{planned > 0 ? fmtCurrency(planned) : '—'}</td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums text-[var(--success)]">{row.collections > 0 ? fmtCurrency(row.collections) : '—'}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-[var(--warning)]">{row.operatingOutflows > 0 ? fmtCurrency(row.operatingOutflows) : '—'}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-[var(--danger)]">{row.supplierPayments > 0 ? fmtCurrency(row.supplierPayments) : '—'}</td>
                  <td className={`px-4 py-3 text-right font-medium tabular-nums ${row.freeCash < 0 ? 'text-[var(--danger)]' : 'text-[var(--gray-950)]'}`}>
                    {fmtCurrency(row.freeCash)}
                  </td>
                  <td className={`px-4 py-3 text-right font-semibold tabular-nums ${row.closingCash < 0 ? 'text-[var(--danger)]' : 'text-[var(--gray-950)]'}`}>
                    {fmtCurrency(row.closingCash)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={() => {
                        const firstDebt = rows[0];
                        if (!firstDebt) return;
                        onChangeRows((current) => addTaxPaymentRow(current, firstDebt.id, row.effectiveDate));
                      }}
                      disabled={rows.length === 0}
                      className="h-8 rounded-lg border border-[var(--border)] bg-white px-2.5 text-[11px] font-medium text-[var(--gray-700)] hover:bg-[var(--surface-alt)] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Agregar pago
                    </button>
                  </td>
                </tr>
              );
            })}
            {taxSheetRows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-6">
                  <EmptyMiniState label="No hay periodos visibles para el plan fiscal." />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1180px] text-[12px]">
          <thead className="bg-white text-[var(--gray-500)]">
            <tr>
              <Th>Adeudo fiscal</Th>
              <Th>Fecha pago</Th>
              <Th align="right">Monto</Th>
              <Th>Nota</Th>
              <Th align="center">Origen</Th>
              <Th align="center">Acción</Th>
            </tr>
          </thead>
          <tbody>
            {planRows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6">
                  <EmptyMiniState label="Sin pagos fiscales planeados. Usa Sugerir plan o agrega pagos desde Adeudos fiscales." />
                </td>
              </tr>
            ) : (
              planRows.map(({ debt, payment }) => (
                <tr key={`${debt.id}:${payment.id}`} className="border-t border-[var(--border)] align-top">
                  <td className="px-4 py-3">
                    <div className="font-medium text-[var(--gray-950)]">{debt.label}</div>
                    <div className="text-[11px] text-[var(--gray-400)]">{debt.fiscalYearInput} · {debt.taxType} · vence {fmtDate(debt.dueDate)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <input
                      type="date"
                      value={payment.date}
                      onChange={(event) => onChangeRows((current) => updateTaxPaymentRow(current, debt.id, payment.id, { date: event.target.value }))}
                      className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)]"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.01"
                      value={payment.amountInput}
                      onChange={(event) => onChangeRows((current) => updateTaxPaymentRow(current, debt.id, payment.id, { amountInput: event.target.value }))}
                      className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-right text-[13px] tabular-nums text-[var(--gray-950)] outline-none focus:border-[var(--primary)]"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <input
                      value={payment.note}
                      onChange={(event) => onChangeRows((current) => updateTaxPaymentRow(current, debt.id, payment.id, { note: event.target.value }))}
                      placeholder="Pago parcial, convenio, caja disponible..."
                      className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none placeholder:text-[var(--gray-300)] focus:border-[var(--primary)]"
                    />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium ${
                      payment.suggested
                        ? 'bg-[var(--primary-muted)] text-[var(--primary)]'
                        : 'bg-[var(--surface-alt)] text-[var(--gray-600)]'
                    }`}>
                      {payment.suggested ? 'Sugerido' : 'Manual'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={() => onChangeRows((current) => removeTaxPaymentRow(current, debt.id, payment.id))}
                      className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--border)] text-[var(--gray-500)] hover:bg-[var(--danger)]/8 hover:text-[var(--danger)]"
                      title="Quitar pago fiscal"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))
            )}
            {rows.length > 0 && (
              <tr className="border-t border-[var(--border)]">
                <td colSpan={6} className="px-4 py-3">
                  <button
                    onClick={() => onChangeRows((current) => addTaxPaymentRow(current, rows[0].id, `${selectedMonth}-01`))}
                    className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-white px-3 text-[12px] font-medium text-[var(--gray-950)] hover:bg-[var(--surface-alt)]"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Agregar pago fiscal
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SupplierPriorityQueue({
  rows,
  allRows,
  overrideRows,
  selectedMonth,
  selectedDay,
  filters,
  onChangeRisk,
  onChangeFlexibility,
  onChangeBucket,
  onChangeStatus,
  onChangeCredit,
  onChangeDate,
  onOverrideChange,
  onMoveNextWeek,
  onHalfPayment,
  onLockPayment,
  onRemoveOverride,
}: {
  rows: OperatingSupplierQueueItem[];
  allRows: OperatingSupplierQueueItem[];
  overrideRows: SupplierOverrideRow[];
  selectedMonth: string;
  selectedDay: string;
  filters: SupplierQueueFilters;
  onChangeRisk: (value: SupplierRiskFilter) => void;
  onChangeFlexibility: (value: SupplierFlexFilter) => void;
  onChangeBucket: (value: SupplierBucketFilter) => void;
  onChangeStatus: (value: SupplierStatusFilter) => void;
  onChangeCredit: (value: SupplierCreditFilter) => void;
  onChangeDate: (value: SupplierDateFilter) => void;
  onOverrideChange: (item: OperatingSupplierQueueItem, patch: Partial<SupplierOverrideRow>) => void;
  onMoveNextWeek: (item: OperatingSupplierQueueItem) => void;
  onHalfPayment: (item: OperatingSupplierQueueItem) => void;
  onLockPayment: (item: OperatingSupplierQueueItem) => void;
  onRemoveOverride: (invoiceKey: string) => void;
}) {
  const summary = summarizeSupplierQueue(allRows);

  return (
    <section className={`${T.section} overflow-hidden`}>
      <div className="flex flex-col gap-3 border-b border-[var(--border)] px-4 py-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className={`text-[15px] font-semibold ${T.title}`}>Cola priorizada de proveedores</h2>
          <p className={`mt-1 text-[12px] ${T.muted}`}>
            Orden de pago: <span className="font-semibold text-yellow-700">Operación</span> → score más alto → vencimiento más antiguo → menor monto.
            Cambios aquí recalculan el escenario.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3 text-right text-[12px]">
          <MiniStat label="Críticos" value={summary.criticalCount} accent={summary.criticalCount > 0 ? 'danger' : 'neutral'} />
          <MiniStat label="Vencidos" value={summary.overdueCount} accent={summary.overdueCount > 0 ? 'danger' : 'neutral'} />
          <MiniStat label="Movidos" value={summary.movedCount} />
        </div>
      </div>

      <div className="grid gap-3 border-b border-[var(--border)] px-4 py-3 md:grid-cols-2 xl:grid-cols-6">
        <QueueSelect label="Riesgo" value={filters.risk} onChange={(value) => onChangeRisk(value as SupplierRiskFilter)}>
          <option value="all">Todos</option>
          <option value="Alto">Alto</option>
          <option value="Medio">Medio</option>
          <option value="Bajo">Bajo</option>
        </QueueSelect>
        <QueueSelect label="Flexibilidad" value={filters.flexibility} onChange={(value) => onChangeFlexibility(value as SupplierFlexFilter)}>
          <option value="all">Todas</option>
          <option value="inamovible">Inamovible</option>
          <option value="revisar">Revisar</option>
          <option value="flexible">Flexible</option>
          <option value="unknown">Sin clasificar</option>
        </QueueSelect>
        <QueueSelect label="Clasif." value={filters.bucket} onChange={(value) => onChangeBucket(value as SupplierBucketFilter)}>
          <option value="all">Todas</option>
          <option value="CRITICO">{BUCKET_LABELS.CRITICO}</option>
          <option value="ALTO">{BUCKET_LABELS.ALTO}</option>
          <option value="MEDIO">{BUCKET_LABELS.MEDIO}</option>
          <option value="BAJO">{BUCKET_LABELS.BAJO}</option>
        </QueueSelect>
        <QueueSelect label="Estado" value={filters.status} onChange={(value) => onChangeStatus(value as SupplierStatusFilter)}>
          <option value="all">Todos</option>
          <option value="suggested">Sugerido</option>
          <option value="moved">Movido</option>
          <option value="overdue">Vencido</option>
          <option value="partial">Parcial</option>
          <option value="unplanned">Sin programar</option>
        </QueueSelect>
        <QueueSelect label="Línea crédito" value={filters.credit} onChange={(value) => onChangeCredit(value as SupplierCreditFilter)}>
          <option value="all">Todas</option>
          <option value="exceeded">Excedida</option>
          <option value="near_limit">Cerca del límite</option>
          <option value="normal">Normal</option>
          <option value="none">Sin límite</option>
        </QueueSelect>
        <QueueSelect label="Fecha" value={filters.date} onChange={(value) => onChangeDate(value as SupplierDateFilter)}>
          <option value="all">Todas</option>
          <option value="day">Día seleccionado</option>
          <option value="week">Siguiente semana</option>
          <option value="month">Mes seleccionado</option>
        </QueueSelect>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1660px] text-[12px]">
          <thead className="bg-[var(--surface-alt)] text-[var(--gray-500)]">
            <tr>
              <Th>Proveedor / factura</Th>
              <Th>Clasif.</Th>
              <Th align="center">Score</Th>
              <Th>Riesgo</Th>
              <Th>Flexibilidad</Th>
              <Th>Estado</Th>
              <Th>Línea crédito</Th>
              <Th>Fecha escenario</Th>
              <Th align="right">Monto escenario</Th>
              <Th align="right">Pendiente</Th>
              <Th>Explicación</Th>
              <Th align="center">Acciones</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={12} className="px-4 py-6">
                  <EmptyMiniState label={`Sin facturas para los filtros actuales en ${fmtYearMonthLong(selectedMonth)}.`} />
                </td>
              </tr>
            ) : (
              rows.map((item) => {
                const override = overrideRows.find((row) => row.invoiceKey === item.invoiceKey);
                const baseDate = override?.date ?? item.plannedDate ?? item.dueDate ?? selectedDay;
                const baseAmount = override?.amountInput ?? editableAmount(item.plannedAmount ?? item.remainingAmount);
                const isCritico = item.clasificacionAutomatica === 'CRITICO';
                return (
                  <tr key={item.invoiceKey} className={`border-t border-[var(--border)] align-top ${isCritico ? 'bg-yellow-50/40' : ''}`}>
                    <td className={`px-4 py-3 ${isCritico ? 'border-l-2 border-yellow-400' : ''}`}>
                      <div className="font-medium text-[var(--gray-950)]">{item.providerName}</div>
                      <div className="mt-0.5 text-[11px] text-[var(--gray-500)]">
                        {item.invoiceNumber ? `Factura ${item.invoiceNumber}` : 'Factura sin número'}
                        {item.supplierNumber ? ` · Proveedor ${item.supplierNumber}` : ''}
                      </div>
                      <div className="mt-0.5 text-[10px] text-[var(--gray-400)]">
                        {item.dueDate ? `vence ${fmtDate(item.dueDate)}` : 'sin vencimiento'}
                        {item.invoiceDate ? ` · emitida ${fmtDate(item.invoiceDate)}` : ''}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <SupplierBucketChip bucket={item.clasificacionAutomatica} />
                    </td>
                    <td className="px-4 py-3">
                      <SupplierScoreBar score={item.score} />
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium ${supplierRiskClass(item.risk)}`}>{item.risk}</span>
                    </td>
                    <td className="px-4 py-3 text-[var(--gray-700)]">{supplierFlexibilityLabel(item.flexibility)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium ${supplierQueueStatusClass(item.status)}`}>
                        {supplierQueueStatusLabel(item.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className={`font-medium ${supplierCreditStatusClass(item.creditStatus)}`}>{supplierCreditStatusLabel(item.creditStatus)}</div>
                      {item.creditLimit && <div className="mt-0.5 text-[10px] text-[var(--gray-400)]">límite {fmtCompact(item.creditLimit)}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="date"
                        value={baseDate}
                        onChange={(event) => onOverrideChange(item, { date: event.target.value })}
                        className="h-9 w-full rounded-lg border border-[var(--border)] bg-white px-2.5 text-[12px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)]"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.01"
                        value={baseAmount}
                        onChange={(event) => onOverrideChange(item, { amountInput: event.target.value })}
                        className="h-9 w-full rounded-lg border border-[var(--border)] bg-white px-2.5 text-right text-[12px] tabular-nums text-[var(--gray-950)] outline-none focus:border-[var(--primary)]"
                      />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="font-semibold tabular-nums text-[var(--gray-950)]">{fmtCurrency(item.remainingAmount)}</div>
                      <div className="mt-0.5 text-[10px] text-[var(--gray-400)]">factura {fmtCompact(item.invoiceAmount)}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="max-w-[360px] text-[11px] leading-4 text-[var(--gray-700)]">{item.paymentExplanation}</div>
                      <div className="mt-1 text-[10px] text-[var(--gray-400)]">{item.priorityExplanation}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap justify-center gap-1">
                        <button
                          onClick={() => onMoveNextWeek(item)}
                          className="h-8 rounded-lg border border-[var(--border)] bg-white px-2 text-[11px] font-medium text-[var(--gray-700)] hover:bg-[var(--surface-alt)]"
                        >
                          +7
                        </button>
                        <button
                          onClick={() => onHalfPayment(item)}
                          className="h-8 rounded-lg border border-[var(--border)] bg-white px-2 text-[11px] font-medium text-[var(--gray-700)] hover:bg-[var(--surface-alt)]"
                        >
                          50%
                        </button>
                        <button
                          onClick={() => onLockPayment(item)}
                          className="h-8 rounded-lg border border-[var(--border)] bg-white px-2 text-[11px] font-medium text-[var(--gray-700)] hover:bg-[var(--surface-alt)]"
                        >
                          No mover
                        </button>
                        {override && (
                          <button
                            onClick={() => onRemoveOverride(item.invoiceKey)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] text-[var(--gray-500)] hover:bg-[var(--danger)]/8 hover:text-[var(--danger)]"
                            title="Quitar cambio"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function QueueSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.02em] text-[var(--gray-400)]">{label}</div>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)]"
      >
        {children}
      </select>
    </label>
  );
}

function SupplierOverrideEditor({
  rows,
  onChangeRows,
}: {
  rows: SupplierOverrideRow[];
  onChangeRows: (updater: (current: SupplierOverrideRow[]) => SupplierOverrideRow[]) => void;
}) {
  const sorted = sortSupplierOverrideRows(rows);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] text-[12px]">
        <thead className="bg-[var(--surface-alt)] text-[var(--gray-500)]">
          <tr>
            <Th>Proveedor / factura</Th>
            <Th>Fecha escenario</Th>
            <Th align="right">Monto</Th>
            <Th>Nota</Th>
            <Th align="center">Acción</Th>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-4 py-5">
                <EmptyMiniState label="Sin pagos movidos. Abre el detalle de pagos de un día y cambia fecha o monto de una factura." />
              </td>
            </tr>
          ) : (
            sorted.map((row) => (
              <tr key={row.id} className="border-t border-[var(--border)] align-top">
                <td className="px-4 py-3">
                  <div className="font-medium text-[var(--gray-950)]">{row.providerName}</div>
                  <div className="mt-0.5 text-[11px] text-[var(--gray-500)]">
                    {row.invoiceNumber ? `Factura ${row.invoiceNumber}` : 'Factura sin número'}
                    {row.supplierNumber ? ` · Proveedor ${row.supplierNumber}` : ''}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <input
                    type="date"
                    value={row.date}
                    onChange={(event) => onChangeRows((current) => updateSupplierOverrideRow(current, row.id, { date: event.target.value }))}
                    className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none transition-colors focus:border-[var(--primary)]"
                  />
                </td>
                <td className="px-4 py-3">
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={row.amountInput}
                    onChange={(event) => onChangeRows((current) => updateSupplierOverrideRow(current, row.id, { amountInput: event.target.value }))}
                    className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-right text-[13px] tabular-nums text-[var(--gray-950)] outline-none transition-colors focus:border-[var(--primary)]"
                  />
                </td>
                <td className="px-4 py-3">
                  <input
                    value={row.note}
                    onChange={(event) => onChangeRows((current) => updateSupplierOverrideRow(current, row.id, { note: event.target.value }))}
                    placeholder="Negociado, diferido, pago parcial..."
                    className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none transition-colors placeholder:text-[var(--gray-300)] focus:border-[var(--primary)]"
                  />
                </td>
                <td className="px-4 py-3 text-center">
                  <button
                    onClick={() => onChangeRows((current) => current.filter((item) => item.id !== row.id))}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--border)] text-[var(--gray-500)] transition-colors hover:bg-[var(--danger)]/8 hover:text-[var(--danger)]"
                    title="Quitar movimiento del escenario"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function OperatingDailyCalendar({
  days,
  selectedDay,
  lastMove,
  onSelectDay,
  onMovePayment,
}: {
  days: OperatingProjectionDay[];
  selectedDay: string | null;
  lastMove: SupplierPaymentMoveImpact | null;
  onSelectDay: (date: string, tab?: DayDetailTab) => void;
  onMovePayment: (invoiceKey: string, fromDate: string, toDate: string) => void;
}) {
  const monthLabel = days[0] ? fmtYearMonthLong(days[0].date.slice(0, 7)) : 'Sin mes';
  const calendarDates = buildOperatingCalendarDates(days);
  const dayByDate = new Map(days.map((day) => [day.date, day]));
  const totalInflows = days.reduce((sum, day) => sum + sumAmounts(day.cashInflows), 0);
  const totalOutflows = days.reduce((sum, day) => sum + sumAmounts(day.scheduledOutflows) + sumAmounts(day.supplierPayments), 0);
  const totalEvents = days.reduce((sum, day) => sum + day.cashInflows.length + day.scheduledOutflows.length + day.supplierPayments.length, 0);
  const alertDays = days.filter((day) => day.alerts.length > 0).length;

  const handleDrop = (event: React.DragEvent<HTMLDivElement>, targetDate: string) => {
    event.preventDefault();
    const payload = readSupplierPaymentDragPayload(event);
    if (!payload) return;
    onMovePayment(payload.invoiceKey, payload.sourceDate, targetDate);
  };

  const movedFromDay = lastMove ? days.find((day) => day.date === lastMove.fromDate) : null;
  const movedToDay = lastMove ? days.find((day) => day.date === lastMove.toDate) : null;

  return (
    <section className={`${T.section} overflow-hidden`}>
      <div className="flex flex-col gap-3 border-b border-[var(--border)] px-4 py-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className={`text-[15px] font-semibold ${T.title}`}>Calendario operativo diario</h2>
          <p className={`mt-1 text-[12px] ${T.muted}`}>
            {monthLabel} · ingresos, egresos, neto, caja y riesgo por día.
          </p>
        </div>
        <div className="grid grid-cols-4 gap-3 text-right text-[12px]">
          <MiniStat label="Ingresos" value={totalInflows} accent="success" />
          <MiniStat label="Egresos" value={totalOutflows} accent="danger" />
          <MiniStat label="Eventos" value={totalEvents} />
          <MiniStat label="Días alerta" value={alertDays} accent={alertDays > 0 ? 'danger' : 'neutral'} />
        </div>
      </div>

      {lastMove && (
        <div className="border-b border-[var(--border)] bg-[var(--primary)]/5 px-4 py-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-[var(--gray-950)]">
                Movimiento aplicado: {lastMove.providerName}
                {lastMove.invoiceNumber ? ` · Factura ${lastMove.invoiceNumber}` : ''}
              </div>
              <div className="mt-1 text-[12px] text-[var(--gray-500)]">
                {fmtCurrency(lastMove.amount)} de {fmtDate(lastMove.fromDate)} a {fmtDate(lastMove.toDate)}.
              </div>
            </div>
            <div className="grid gap-2 text-[11px] sm:grid-cols-2 lg:min-w-[520px]">
              <MoveImpactStat
                label="Día origen"
                before={lastMove.sourceClosingBefore}
                after={movedFromDay?.closingCash ?? lastMove.sourceClosingBefore}
                freeBefore={lastMove.sourceFreeCashBefore}
                freeAfter={movedFromDay?.freeCash ?? lastMove.sourceFreeCashBefore}
              />
              <MoveImpactStat
                label="Día destino"
                before={lastMove.targetClosingBefore}
                after={movedToDay?.closingCash ?? lastMove.targetClosingBefore}
                freeBefore={lastMove.targetFreeCashBefore}
                freeAfter={movedToDay?.freeCash ?? lastMove.targetFreeCashBefore}
              />
            </div>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <div className="min-w-[980px]">
          <div className="grid grid-cols-7 border-b border-[var(--border)] bg-[var(--surface-alt)] text-center text-[10px] font-medium uppercase tracking-[0.02em] text-[var(--gray-400)]">
            {['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map((label) => (
              <div key={label} className="px-3 py-2">{label}</div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {calendarDates.map((date) => {
              const day = dayByDate.get(date);
              if (!day) {
                return (
                  <div key={date} className="min-h-[156px] border-b border-r border-[var(--border)] bg-[var(--surface-alt)]/55 p-2 text-[11px] text-[var(--gray-300)]">
                    {date.slice(8)}
                  </div>
                );
              }
            const active = day.date === selectedDay;
            const inflows = sumAmounts(day.cashInflows);
            const scheduled = sumAmounts(day.scheduledOutflows);
            const supplierTotal = sumAmounts(day.supplierPayments);
            const outflows = scheduled + supplierTotal;
            const net = inflows - outflows;
            const risk = dailyRisk(day);
            return (
              <div
                key={day.date}
                onClick={() => onSelectDay(day.date)}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(event) => handleDrop(event, day.date)}
                className={`min-h-[168px] border-b border-r bg-white p-2.5 transition-colors ${
                  active
                    ? 'relative z-[1] ring-2 ring-inset ring-[var(--primary)]'
                    : 'hover:bg-[var(--surface-alt)]/65'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-[12px] font-semibold text-[var(--gray-950)]">{day.date.slice(8)}</div>
                    <div className="mt-0.5 text-[10px] text-[var(--gray-400)]">{weekdayLabel(day.date)}</div>
                  </div>
                  <span className={`rounded-full px-2 py-1 text-[10px] font-medium ${risk.className}`}>
                    {risk.label}
                  </span>
                </div>

                <div className="mt-2 space-y-1.5">
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelectDay(day.date, 'ingresos');
                    }}
                    className="flex w-full items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-white px-2 py-1.5 text-[11px] transition-colors hover:border-[var(--success)]/40 hover:bg-[var(--success)]/5"
                  >
                    <span className="text-[var(--gray-500)]">Ingresos · {day.cashInflows.length}</span>
                    <span className="font-semibold tabular-nums text-[var(--success)]">+{fmtCompact(inflows)}</span>
                  </button>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelectDay(day.date, 'egresos');
                    }}
                    className="flex w-full items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-white px-2 py-1.5 text-[11px] transition-colors hover:border-[var(--danger)]/40 hover:bg-[var(--danger)]/5"
                  >
                    <span className="text-[var(--gray-500)]">Egresos · {day.scheduledOutflows.length + day.supplierPayments.length}</span>
                    <span className="font-semibold tabular-nums text-[var(--danger)]">-{fmtCompact(outflows)}</span>
                  </button>
                  <div className="grid grid-cols-2 gap-1.5 text-[10px]">
                    <div className={`rounded-md bg-[var(--surface-alt)] px-2 py-1.5 tabular-nums ${net >= 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
                      Neto <span className="font-semibold">{fmtCompact(net)}</span>
                    </div>
                    <div className="rounded-md bg-[var(--surface-alt)] px-2 py-1.5 text-right tabular-nums text-[var(--gray-700)]">
                      Cierre <span className="font-semibold">{fmtCompact(day.closingCash)}</span>
                    </div>
                  </div>
                </div>

                {day.alerts.length > 0 && (
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelectDay(day.date, 'alertas');
                    }}
                    className="mt-2 w-full rounded-lg border border-[var(--warning)]/20 bg-[var(--warning-muted)] px-2 py-1.5 text-left text-[10px] leading-4 text-[var(--gray-700)]"
                  >
                    {day.alerts[0]}
                    {day.alerts.length > 1 && (
                      <span className="font-medium text-[var(--warning)]"> +{day.alerts.length - 1}</span>
                    )}
                  </button>
                )}

                {day.supplierPayments.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {day.supplierPayments.slice(0, 2).map((payment, index) => (
                      <SupplierPaymentBoardCard
                        key={`${day.date}-${payment.invoiceKey}-${payment.reason}-${index}`}
                        payment={payment}
                        date={day.date}
                      />
                    ))}
                    {day.supplierPayments.length > 2 && (
                    <div className="text-center text-[11px] font-medium text-[var(--gray-400)]">
                        +{day.supplierPayments.length - 2} pagos proveedor
                    </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          </div>
        </div>
      </div>
    </section>
  );
}

function buildOperatingCalendarDates(days: OperatingProjectionDay[]): string[] {
  if (days.length === 0) return [];
  const first = parseCalendarDate(days[0].date);
  const last = parseCalendarDate(days[days.length - 1].date);
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const end = new Date(last);
  end.setUTCDate(end.getUTCDate() + (6 - ((end.getUTCDay() + 6) % 7)));
  const out: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function parseCalendarDate(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, (month || 1) - 1, day || 1));
}

function SupplierPaymentBoardCard({
  payment,
  date,
}: {
  payment: OperatingSupplierPayment;
  date: string;
}) {
  const onDragStart = (event: React.DragEvent<HTMLDivElement>) => {
    const payload: SupplierPaymentDragPayload = {
      invoiceKey: payment.invoiceKey,
      sourceDate: date,
    };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(SUPPLIER_PAYMENT_DRAG_TYPE, JSON.stringify(payload));
    event.dataTransfer.setData('text/plain', `${payment.providerName} ${fmtCurrency(payment.amount)}`);
  };

  return (
    <div
      draggable
      onDragStart={onDragStart}
      className="group cursor-grab rounded-lg border border-[var(--border)] bg-[var(--surface-alt)] px-2.5 py-2 active:cursor-grabbing"
      title="Mover pago en el escenario"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[12px] font-medium text-[var(--gray-950)]">{payment.providerName}</div>
          <div className="mt-0.5 truncate text-[10px] text-[var(--gray-400)]">{supplierInvoiceLabel(payment)}</div>
        </div>
        <GripVertical className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--gray-300)] group-hover:text-[var(--gray-500)]" />
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${supplierPaymentBadgeClass(payment)}`}>
          {supplierPaymentReasonLabel(payment)}
        </span>
        <span className={`text-[12px] font-semibold tabular-nums ${supplierPaymentToneClass(payment)}`}>
          {fmtCompact(payment.amount)}
        </span>
      </div>
    </div>
  );
}

function MoveImpactStat({
  label,
  before,
  after,
  freeBefore,
  freeAfter,
}: {
  label: string;
  before: number;
  after: number;
  freeBefore: number;
  freeAfter: number;
}) {
  const delta = after - before;
  const deltaClass = delta >= 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]';
  return (
    <div className="rounded-lg border border-[var(--border)] bg-white px-3 py-2">
      <div className="font-medium text-[var(--gray-950)]">{label}</div>
      <div className="mt-1 tabular-nums text-[var(--gray-500)]">
        Cierre {fmtCompact(before)} → <span className="font-semibold text-[var(--gray-950)]">{fmtCompact(after)}</span>
        <span className={`ml-1 font-semibold ${deltaClass}`}>({delta >= 0 ? '+' : ''}{fmtCompact(delta)})</span>
      </div>
      <div className="mt-0.5 tabular-nums text-[var(--gray-400)]">
        Disponible {fmtCompact(freeBefore)} → {fmtCompact(freeAfter)}
      </div>
    </div>
  );
}

function readSupplierPaymentDragPayload(event: React.DragEvent<HTMLDivElement>): SupplierPaymentDragPayload | null {
  const raw = event.dataTransfer.getData(SUPPLIER_PAYMENT_DRAG_TYPE);
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as Partial<SupplierPaymentDragPayload>;
    if (!payload.invoiceKey || !payload.sourceDate) return null;
    return {
      invoiceKey: payload.invoiceKey,
      sourceDate: payload.sourceDate,
    };
  } catch {
    return null;
  }
}

function dailyRisk(day: OperatingProjectionDay): { label: string; className: string } {
  if (day.closingCash < 0 || day.mandatoryReserveShortfall > 0) {
    return { label: 'Crítico', className: 'bg-[var(--danger)]/8 text-[var(--danger)]' };
  }
  if (day.alerts.length > 0 || day.freeCash < 0) {
    return { label: 'Alto', className: 'bg-[var(--warning-muted)] text-[var(--warning)]' };
  }
  const dailyOutflow = sumAmounts(day.scheduledOutflows) + sumAmounts(day.supplierPayments);
  if (dailyOutflow > 0 && day.freeCash < dailyOutflow * 0.15) {
    return { label: 'Medio', className: 'bg-[var(--primary-muted)] text-[var(--primary)]' };
  }
  return { label: 'Controlado', className: 'bg-[var(--success)]/10 text-[var(--success)]' };
}

function actionSeverityLabel(severity: TreasuryActionItem['severity']): string {
  switch (severity) {
    case 'danger': return 'Crítico';
    case 'warning': return 'Atención';
    case 'neutral': return 'Revisar';
  }
}

function actionSeverityClass(severity: TreasuryActionItem['severity']): string {
  switch (severity) {
    case 'danger': return 'bg-[var(--danger)]/8 text-[var(--danger)]';
    case 'warning': return 'bg-[var(--warning-muted)] text-[var(--warning)]';
    case 'neutral': return 'bg-[var(--surface-alt)] text-[var(--gray-600)]';
  }
}

function ledgerTypeLabel(type: PlanningLedgerType): string {
  switch (type) {
    case 'collection': return 'Ingreso';
    case 'supplier': return 'Proveedor';
    case 'tax': return 'Impuesto';
    case 'obligation': return 'Obligación';
    case 'adjustment': return 'Ajuste';
    case 'fixed': return 'Egreso fijo';
  }
}

function ledgerStatusLabel(status: PlanningLedgerStatus): string {
  switch (status) {
    case 'projected': return 'Proyectado';
    case 'confirmed': return 'Confirmado';
    case 'paid': return 'Pagado';
    case 'overdue': return 'Vencido';
    case 'rescheduled': return 'Reprogramado';
    case 'partial': return 'Parcial';
    case 'unplanned': return 'Sin programar';
  }
}

function ledgerStatusClass(status: PlanningLedgerStatus): string {
  switch (status) {
    case 'overdue': return 'bg-[var(--danger)]/8 text-[var(--danger)]';
    case 'rescheduled': return 'bg-[var(--primary-muted)] text-[var(--primary)]';
    case 'partial': return 'bg-[var(--warning-muted)] text-[var(--warning)]';
    case 'confirmed':
    case 'paid': return 'bg-[var(--success)]/10 text-[var(--success)]';
    case 'projected': return 'bg-[var(--surface-alt)] text-[var(--gray-600)]';
    case 'unplanned': return 'bg-[var(--warning-muted)] text-[var(--warning)]';
  }
}

function importSeverityLabel(severity: PlanningLedgerImportChange['severity']): string {
  switch (severity) {
    case 'ok': return 'OK';
    case 'warning': return 'Advertencia';
    case 'danger': return 'Bloqueo';
  }
}

function importSeverityClass(severity: PlanningLedgerImportChange['severity']): string {
  switch (severity) {
    case 'ok': return 'bg-[var(--success)]/10 text-[var(--success)]';
    case 'warning': return 'bg-[var(--warning-muted)] text-[var(--warning)]';
    case 'danger': return 'bg-[var(--danger)]/8 text-[var(--danger)]';
  }
}

function supplierPanelRecommendation(item: PlanningLedgerItem): string {
  if (!item.supplier) return 'Valida fecha, monto y comentario antes de aplicar el ajuste.';
  if (item.supplier.risk === 'Alto' && item.supplier.flexibility === 'inamovible') {
    return 'Proveedor crítico e inamovible: evita patearlo completo; si necesitas caja, divide el pago y conserva una parte en la fecha original.';
  }
  if (item.supplier.creditStatus === 'exceeded') {
    return 'La línea de crédito está excedida: prioriza un pago parcial suficiente para bajar exposición antes de mover el resto.';
  }
  if (item.supplier.flexibility === 'flexible') {
    return 'Proveedor flexible: buen candidato para mover a la siguiente semana o dividir sin deteriorar operación crítica.';
  }
  return 'Revisa el vencimiento y usa división de pago si moverlo completo sube el riesgo proveedor.';
}

function taxPriorityLabel(priority: OperatingTaxPriority): string {
  switch (priority) {
    case 'baja': return 'Baja';
    case 'media': return 'Media';
    case 'alta': return 'Alta';
    case 'critica': return 'Crítica';
  }
}

function taxLegalRiskLabel(risk: OperatingTaxLegalRisk): string {
  switch (risk) {
    case 'bajo': return 'Bajo';
    case 'medio': return 'Medio';
    case 'alto': return 'Alto';
  }
}

function taxLegalRiskClass(risk: OperatingTaxLegalRisk): string {
  switch (risk) {
    case 'alto': return 'text-[var(--danger)]';
    case 'medio': return 'text-[var(--warning)]';
    case 'bajo': return 'text-[var(--success)]';
  }
}

function taxRiskWeight(risk: OperatingTaxLegalRisk): number {
  switch (risk) {
    case 'alto': return 3;
    case 'medio': return 2;
    case 'bajo': return 1;
  }
}

function supplierRiskClass(risk: OperatingSupplierQueueItem['risk']): string {
  switch (risk) {
    case 'Alto': return 'bg-[var(--danger)]/8 text-[var(--danger)]';
    case 'Medio': return 'bg-[var(--warning-muted)] text-[var(--warning)]';
    case 'Bajo': return 'bg-[var(--success)]/10 text-[var(--success)]';
  }
}

function supplierFlexibilityLabel(flexibility: OperatingSupplierQueueItem['flexibility']): string {
  switch (flexibility) {
    case 'inamovible': return 'Inamovible';
    case 'revisar': return 'Revisar';
    case 'flexible': return 'Flexible';
    case 'unknown': return 'Sin clasificar';
  }
}

function supplierQueueStatusLabel(status: OperatingSupplierQueueItem['status']): string {
  switch (status) {
    case 'suggested': return 'Sugerido';
    case 'moved': return 'Movido';
    case 'overdue': return 'Vencido';
    case 'partial': return 'Parcial';
    case 'unplanned': return 'Sin programar';
  }
}

function supplierQueueStatusClass(status: OperatingSupplierQueueItem['status']): string {
  switch (status) {
    case 'overdue': return 'bg-[var(--danger)]/8 text-[var(--danger)]';
    case 'moved': return 'bg-[var(--primary-muted)] text-[var(--primary)]';
    case 'partial': return 'bg-[var(--warning-muted)] text-[var(--warning)]';
    case 'suggested': return 'bg-[var(--success)]/10 text-[var(--success)]';
    case 'unplanned': return 'bg-[var(--surface-alt)] text-[var(--gray-600)]';
  }
}

function supplierCreditStatusLabel(status: OperatingSupplierQueueItem['creditStatus']): string {
  switch (status) {
    case 'exceeded': return 'Excedida';
    case 'near_limit': return 'Cerca del límite';
    case 'normal': return 'Normal';
    case 'none': return 'Sin límite';
  }
}

function supplierCreditStatusClass(status: OperatingSupplierQueueItem['creditStatus']): string {
  switch (status) {
    case 'exceeded': return 'text-[var(--danger)]';
    case 'near_limit': return 'text-[var(--warning)]';
    case 'normal': return 'text-[var(--success)]';
    case 'none': return 'text-[var(--gray-500)]';
  }
}

function IncomeDrilldown({
  collections,
  otherInflows,
  date,
  overrideRows,
  onOverrideChange,
  onOverrideRemove,
}: {
  collections: OperatingFlowLine[];
  otherInflows: OperatingFlowLine[];
  date: string;
  overrideRows: CollectionOverrideRow[];
  onOverrideChange: (line: OperatingFlowLine, patch: Partial<CollectionOverrideRow>, fallbackDate: string) => void;
  onOverrideRemove: (sourceKey: string) => void;
}) {
  const hasRows = collections.length > 0 || otherInflows.length > 0;
  if (!hasRows) {
    return (
      <div className="mt-4">
        <EmptyMiniState label="Sin ingresos proyectados para este día." />
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-4">
      {collections.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-[var(--border)]">
          <div className="border-b border-[var(--border)] bg-[var(--surface-alt)] px-3 py-2 text-[11px] font-medium uppercase tracking-[0.02em] text-[var(--gray-400)]">
            Cobranza proyectada
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] text-[11px]">
              <thead className="bg-[var(--surface-alt)] text-[var(--gray-500)]">
                <tr>
                  <Th>Cliente / factura proyectada</Th>
                  <Th>Regla</Th>
                  <Th>Fecha escenario</Th>
                  <Th align="right">Monto escenario</Th>
                  <Th>Nota</Th>
                  <Th align="right">Monto proyectado</Th>
                  <Th align="center">Acción</Th>
                </tr>
              </thead>
              <tbody>
                {collections.map((line) => {
                  const sourceKey = collectionOverrideSourceKey(line);
                  const override = overrideRows.find((row) => row.sourceKey === sourceKey);
                  return (
                    <tr key={sourceKey} className="border-t border-[var(--border)] align-top">
                      <td className="px-4 py-3">
                        <div className="font-medium text-[var(--gray-950)]">{line.label}</div>
                        <div className="mt-0.5 text-[11px] text-[var(--gray-500)]">
                          {line.invoiceDate ? `Factura proyectada ${fmtDate(line.invoiceDate)}` : 'Factura proyectada'}
                        </div>
                        <div className="mt-0.5 text-[10px] text-[var(--gray-400)]">
                          Original {fmtDate(line.originalDate ?? date)}
                          {line.theoreticalDate ? ` · contractual ${fmtDate(line.theoreticalDate)}` : ''}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-[11px] text-[var(--gray-700)]">{line.detail ?? 'Cobranza proyectada'}</div>
                        <div className="mt-0.5 text-[10px] text-[var(--gray-400)]">
                          {[line.confidence ? `confianza ${line.confidence.toLowerCase()}` : null, line.lagDays != null ? `lag ${line.lagDays}d` : null].filter(Boolean).join(' · ')}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="date"
                          value={override?.date ?? date}
                          onChange={(event) => onOverrideChange(line, { date: event.target.value }, date)}
                          className="h-9 w-full rounded-lg border border-[var(--border)] bg-white px-2.5 text-[12px] text-[var(--gray-950)] outline-none transition-colors focus:border-[var(--primary)]"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="0.01"
                          value={override?.amountInput ?? editableAmount(line.amount)}
                          onChange={(event) => onOverrideChange(line, { amountInput: event.target.value }, date)}
                          className="h-9 w-full rounded-lg border border-[var(--border)] bg-white px-2.5 text-right text-[12px] tabular-nums text-[var(--gray-950)] outline-none transition-colors focus:border-[var(--primary)]"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <input
                          value={override?.note ?? ''}
                          onChange={(event) => onOverrideChange(line, { note: event.target.value }, date)}
                          placeholder="Justificación"
                          className="h-9 w-full rounded-lg border border-[var(--border)] bg-white px-2.5 text-[12px] text-[var(--gray-950)] outline-none placeholder:text-[var(--gray-300)] focus:border-[var(--primary)]"
                        />
                      </td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums text-[var(--success)]">{fmtCurrency(line.amount)}</td>
                      <td className="px-4 py-3 text-center">
                        {override ? (
                          <button
                            onClick={() => onOverrideRemove(sourceKey)}
                            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] text-[var(--gray-500)] transition-colors hover:bg-[var(--danger)]/8 hover:text-[var(--danger)]"
                            title="Quitar cambio del escenario"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        ) : (
                          <span className="text-[var(--gray-300)]">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {otherInflows.length > 0 && (
        <DetailList
          empty="Sin otros ingresos para este día."
          items={otherInflows.map((line) => ({
            title: line.label,
            subtitle: line.detail ?? line.category,
            meta: `${line.category} · ${sourceLabel(line.source)}`,
            amount: line.amount,
            tone: 'success',
          }))}
        />
      )}
    </div>
  );
}

function OutflowDrilldown({
  supplierPayments,
  scheduledOutflows,
  date,
  supplierOverrideRows,
  scheduledOverrideRows,
  onSupplierOverrideChange,
  onSupplierOverrideRemove,
  onScheduledOverrideChange,
  onScheduledOverrideRemove,
}: {
  supplierPayments: OperatingSupplierPayment[];
  scheduledOutflows: OperatingFlowLine[];
  date: string;
  supplierOverrideRows: SupplierOverrideRow[];
  scheduledOverrideRows: ScheduledOutflowOverrideRow[];
  onSupplierOverrideChange: (payment: OperatingSupplierPayment, patch: Partial<SupplierOverrideRow>, fallbackDate: string) => void;
  onSupplierOverrideRemove: (invoiceKey: string) => void;
  onScheduledOverrideChange: (line: OperatingFlowLine, patch: Partial<ScheduledOutflowOverrideRow>, fallbackDate: string) => void;
  onScheduledOverrideRemove: (sourceKey: string) => void;
}) {
  return (
    <div className="space-y-4">
      <SupplierPaymentDrilldown
        empty="Sin pagos sugeridos para este día."
        payments={supplierPayments}
        date={date}
        overrideRows={supplierOverrideRows}
        onOverrideChange={onSupplierOverrideChange}
        onOverrideRemove={onSupplierOverrideRemove}
      />
      <ScheduledOutflowDrilldown
        outflows={scheduledOutflows}
        date={date}
        overrideRows={scheduledOverrideRows}
        onOverrideChange={onScheduledOverrideChange}
        onOverrideRemove={onScheduledOverrideRemove}
      />
    </div>
  );
}

function ScheduledOutflowDrilldown({
  outflows,
  date,
  overrideRows,
  onOverrideChange,
  onOverrideRemove,
}: {
  outflows: OperatingFlowLine[];
  date: string;
  overrideRows: ScheduledOutflowOverrideRow[];
  onOverrideChange: (line: OperatingFlowLine, patch: Partial<ScheduledOutflowOverrideRow>, fallbackDate: string) => void;
  onOverrideRemove: (sourceKey: string) => void;
}) {
  return (
    <div>
      {outflows.length === 0 ? (
        <EmptyMiniState label="Sin egresos fijos, impuestos u obligaciones para este día." />
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--border)]">
          <div className="border-b border-[var(--border)] bg-[var(--surface-alt)] px-3 py-2 text-[11px] font-medium uppercase tracking-[0.02em] text-[var(--gray-400)]">
            Egresos programados
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] text-[11px]">
              <thead className="bg-[var(--surface-alt)] text-[var(--gray-500)]">
                <tr>
                  <Th>Concepto</Th>
                  <Th>Origen</Th>
                  <Th>Fecha escenario</Th>
                  <Th align="right">Monto escenario</Th>
                  <Th>Nota</Th>
                  <Th align="right">Monto programado</Th>
                  <Th align="center">Acción</Th>
                </tr>
              </thead>
              <tbody>
                {outflows.map((line, index) => {
                  const sourceKey = scheduledOutflowOverrideSourceKey(line);
                  const override = overrideRows.find((row) => row.sourceKey === sourceKey);
                  return (
                    <tr key={`${sourceKey}:${index}`} className="border-t border-[var(--border)] align-top">
                      <td className="px-4 py-3">
                        <div className="font-medium text-[var(--gray-950)]">{line.label}</div>
                        <div className="mt-0.5 text-[11px] text-[var(--gray-500)]">{line.category}</div>
                        <div className="mt-0.5 text-[10px] text-[var(--gray-400)]">Original {fmtDate(line.originalDate ?? date)}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-[11px] text-[var(--gray-700)]">{sourceLabel(line.source)}</div>
                        <div className="mt-0.5 max-w-[260px] text-[10px] text-[var(--gray-400)]">{line.detail ?? 'Programado por motor operativo'}</div>
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="date"
                          value={override?.date ?? date}
                          onChange={(event) => onOverrideChange(line, { date: event.target.value }, date)}
                          className="h-9 w-full rounded-lg border border-[var(--border)] bg-white px-2.5 text-[12px] text-[var(--gray-950)] outline-none transition-colors focus:border-[var(--primary)]"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="0.01"
                          value={override?.amountInput ?? editableAmount(line.amount)}
                          onChange={(event) => onOverrideChange(line, { amountInput: event.target.value }, date)}
                          className="h-9 w-full rounded-lg border border-[var(--border)] bg-white px-2.5 text-right text-[12px] tabular-nums text-[var(--gray-950)] outline-none transition-colors focus:border-[var(--primary)]"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <input
                          value={override?.note ?? ''}
                          onChange={(event) => onOverrideChange(line, { note: event.target.value }, date)}
                          placeholder="Justificación"
                          className="h-9 w-full rounded-lg border border-[var(--border)] bg-white px-2.5 text-[12px] text-[var(--gray-950)] outline-none placeholder:text-[var(--gray-300)] focus:border-[var(--primary)]"
                        />
                      </td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums text-[var(--warning)]">{fmtCurrency(line.amount)}</td>
                      <td className="px-4 py-3 text-center">
                        {override ? (
                          <button
                            onClick={() => onOverrideRemove(sourceKey)}
                            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] text-[var(--gray-500)] transition-colors hover:bg-[var(--danger)]/8 hover:text-[var(--danger)]"
                            title="Quitar cambio del escenario"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        ) : (
                          <span className="text-[var(--gray-300)]">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function SupplierPaymentDrilldown({
  payments,
  empty,
  date,
  overrideRows,
  onOverrideChange,
  onOverrideRemove,
}: {
  payments: OperatingSupplierPayment[];
  empty: string;
  date: string;
  overrideRows: SupplierOverrideRow[];
  onOverrideChange: (payment: OperatingSupplierPayment, patch: Partial<SupplierOverrideRow>, fallbackDate: string) => void;
  onOverrideRemove: (invoiceKey: string) => void;
}) {
  return (
    <div className="mt-4">
      {payments.length === 0 ? (
        <EmptyMiniState label={empty} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--border)]">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1160px] text-[11px]">
              <thead className="bg-[var(--surface-alt)] text-[var(--gray-500)]">
                <tr>
                  <Th>Proveedor / factura</Th>
                  <Th>Por qué se paga</Th>
                  <Th>Fecha escenario</Th>
                  <Th align="right">Factura</Th>
                  <Th align="right">Monto escenario</Th>
                  <Th align="right">Pago sugerido</Th>
                  <Th align="right">Saldo factura</Th>
                  <Th align="center">Acción</Th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment, index) => {
                  const override = overrideRows.find((row) => row.invoiceKey === payment.invoiceKey);
                  return (
                    <tr key={`${payment.invoiceKey}-${payment.reason}-${index}`} className="border-t border-[var(--border)] align-top">
                      <td className="px-4 py-3">
                        <div className="font-medium text-[var(--gray-950)]">{payment.providerName}</div>
                        <div className="mt-0.5 text-[11px] text-[var(--gray-500)]">{supplierInvoiceLabel(payment)}</div>
                        <div className="mt-0.5 text-[10px] text-[var(--gray-400)]">{supplierPaymentDateMeta(payment)}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${supplierPaymentBadgeClass(payment)}`}>
                          {supplierPaymentReasonLabel(payment)}
                        </span>
                        <div className="mt-1.5 max-w-[300px] text-[11px] leading-4 text-[var(--gray-700)]">
                          {payment.paymentExplanation}
                        </div>
                        <div className="mt-1 text-[10px] text-[var(--gray-400)]">{payment.priorityExplanation}</div>
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="date"
                          value={override?.date ?? date}
                          onChange={(event) => onOverrideChange(payment, { date: event.target.value }, date)}
                          className="h-9 w-full rounded-lg border border-[var(--border)] bg-white px-2.5 text-[12px] text-[var(--gray-950)] outline-none transition-colors focus:border-[var(--primary)]"
                        />
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-[var(--gray-700)]">{fmtCurrency(payment.invoiceAmount)}</td>
                      <td className="px-4 py-3">
                        <input
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="0.01"
                          value={override?.amountInput ?? editableAmount(payment.amount)}
                          onChange={(event) => onOverrideChange(payment, { amountInput: event.target.value }, date)}
                          className="h-9 w-full rounded-lg border border-[var(--border)] bg-white px-2.5 text-right text-[12px] tabular-nums text-[var(--gray-950)] outline-none transition-colors focus:border-[var(--primary)]"
                        />
                      </td>
                      <td className={`px-4 py-3 text-right font-semibold tabular-nums ${supplierPaymentToneClass(payment)}`}>
                        {fmtCurrency(payment.amount)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-[var(--gray-700)]">{fmtCurrency(payment.remainingAfterPayment)}</td>
                      <td className="px-4 py-3 text-center">
                        {override ? (
                          <button
                            onClick={() => onOverrideRemove(payment.invoiceKey)}
                            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] text-[var(--gray-500)] transition-colors hover:bg-[var(--danger)]/8 hover:text-[var(--danger)]"
                            title="Quitar cambio del escenario"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        ) : (
                          <span className="text-[var(--gray-300)]">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ChartDayDrilldown({
  row,
  onAddAdjustment,
}: {
  row: ProjectionSheetRow;
  onAddAdjustment: (date: string) => void;
}) {
  const groups = buildSheetGroups(row);
  return (
    <div className="border-t border-[var(--border)] px-4 py-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h3 className="text-[13px] font-semibold text-[var(--gray-950)]">Detalle del día seleccionado</h3>
          <p className="mt-0.5 text-[12px] text-[var(--gray-400)]">
            {row.label} · disponible {fmtCurrency(row.freeCash)} · apartado {fmtCurrency(row.mandatoryReserve)}
          </p>
        </div>
        <button
          onClick={() => onAddAdjustment(row.startDate)}
          className="inline-flex h-9 w-fit items-center gap-2 rounded-lg border border-[var(--border)] bg-white px-3 text-[12px] font-medium text-[var(--gray-950)] hover:bg-[var(--surface-alt)]"
        >
          <Plus className="h-3.5 w-3.5" />
          Ajustar este día
        </button>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        {groups.map((group) => (
          <div key={group.id} className="min-w-0">
            <div className="flex items-baseline justify-between gap-3">
              <div className="text-[10px] font-medium uppercase tracking-[0.02em] text-[var(--gray-400)]">{group.label}</div>
              <div className={`text-[12px] font-semibold tabular-nums ${sheetToneClass(group.tone)}`}>{fmtCompact(group.amount)}</div>
            </div>
            <div className="mt-2 space-y-2">
              {group.lines.length === 0 ? (
                <div className="text-[11px] text-[var(--gray-400)]">{group.empty}</div>
              ) : (
                group.lines.slice(0, 4).map((line) => (
                  <div key={line.id} className="flex items-start justify-between gap-2 border-t border-[var(--border)] pt-2 first:border-t-0 first:pt-0">
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-medium text-[var(--gray-950)]">{line.title}</div>
                      <div className="truncate text-[10px] text-[var(--gray-400)]">{line.subtitle}</div>
                    </div>
                    <div className={`shrink-0 text-[11px] font-semibold tabular-nums ${sheetToneClass(group.tone)}`}>
                      {fmtCompact(line.amount)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SheetDrilldown({ row, totalOutflows }: { row: ProjectionSheetRow; totalOutflows: number }) {
  const groups = buildSheetGroups(row);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 text-[12px]">
        <div className="font-medium text-[var(--gray-950)]">
          Drilldown de {row.label}
        </div>
        <div className="text-[var(--gray-500)]">
          Salidas {fmtCurrency(totalOutflows)} · apartado requerido {fmtCurrency(row.mandatoryReserveRequired)}
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-5">
        {groups.map((group) => (
          <div key={group.id} className="rounded-lg border border-[var(--border)] bg-white p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[11px] font-medium uppercase tracking-[0.02em] text-[var(--gray-400)]">{group.label}</div>
                <div className={`mt-1 text-[15px] font-semibold tabular-nums ${sheetToneClass(group.tone)}`}>
                  {fmtCurrency(group.amount)}
                </div>
              </div>
              <span className="rounded-full bg-[var(--surface-alt)] px-2 py-1 text-[10px] font-medium text-[var(--gray-500)]">
                {group.lines.length}
              </span>
            </div>
            <div className="mt-3 space-y-2">
              {group.lines.length === 0 ? (
                <div className="rounded-lg border border-dashed border-[var(--border)] px-2 py-3 text-[11px] text-[var(--gray-400)]">
                  {group.empty}
                </div>
              ) : (
                group.lines.map((line) => (
                  <div key={line.id} className="flex items-start justify-between gap-3 border-t border-[var(--border)] pt-2 first:border-t-0 first:pt-0">
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-medium text-[var(--gray-950)]">{line.title}</div>
                      <div className="mt-0.5 line-clamp-2 text-[10px] text-[var(--gray-400)]">{line.subtitle}</div>
                    </div>
                    <div className={`shrink-0 text-[11px] font-semibold tabular-nums ${sheetToneClass(group.tone)}`}>
                      {fmtCurrency(line.amount)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function buildSheetGroups(row: ProjectionSheetRow): SheetGroup[] {
  const inflowLines = aggregateSheetLines(row.days.flatMap((day) => (
    day.cashInflows.filter((line) => line.source !== 'adjustment').map((line) => ({
      key: `${line.source}:${line.label}:${line.category}`,
      title: line.label,
      subtitle: `${line.category} · ${line.detail ?? sourceLabel(line.source)}`,
      amount: line.amount,
    }))
  )));

  const fixedLines = aggregateSheetLines(row.days.flatMap((day) => (
    day.scheduledOutflows.filter((line) => line.source !== 'adjustment').map((line) => ({
      key: `${line.category}:${line.label}:${line.source}`,
      title: line.label,
      subtitle: `${line.category} · ${sourceLabel(line.source)}`,
      amount: line.amount,
    }))
  )));

  const supplierLines = aggregateSheetLines(row.days.flatMap((day) => (
    day.supplierPayments.map((payment) => ({
      key: `${payment.invoiceKey}:${payment.reason}`,
      title: payment.providerName,
      subtitle: `${supplierInvoiceLabel(payment)} · ${supplierPaymentReasonLabel(payment)} · ${payment.paymentExplanation}`,
      amount: payment.amount,
    }))
  )));

  const adjustmentLines = aggregateSheetLines(row.days.flatMap((day) => ([
    ...day.cashInflows
      .filter((line) => line.source === 'adjustment')
      .map((line) => ({
        key: `${day.date}:${line.id}`,
        title: line.label,
        subtitle: `${line.category} · entrada · ${fmtDate(day.date)}`,
        amount: line.amount,
      })),
    ...day.scheduledOutflows
      .filter((line) => line.source === 'adjustment')
      .map((line) => ({
        key: `${day.date}:${line.id}`,
        title: line.label,
        subtitle: `${line.category} · salida · ${fmtDate(day.date)}`,
        amount: -line.amount,
      })),
  ])));

  const lastDay = row.days[row.days.length - 1];
  const reserveLines = compactSheetLines(lastDay ? reserveSheetLines(lastDay.mandatoryReserveLines) : []);

  return [
    {
      id: 'inflows',
      label: 'Entradas',
      amount: row.collections + row.otherInflows,
      tone: 'success',
      lines: compactSheetLines(inflowLines),
      empty: 'Sin entradas en este periodo.',
    },
    {
      id: 'fixed',
      label: 'Pagos fijos',
      amount: row.fixedOutflows,
      tone: 'warning',
      lines: compactSheetLines(fixedLines),
      empty: 'Sin egresos fijos en este periodo.',
    },
    {
      id: 'suppliers',
      label: 'Proveedores',
      amount: row.supplierPayments,
      tone: 'danger',
      lines: compactSheetLines(supplierLines),
      empty: 'Sin pagos a proveedores en este periodo.',
    },
    {
      id: 'adjustments',
      label: 'Ajustes',
      amount: row.adjustmentInflows - row.adjustmentOutflows,
      tone: 'neutral',
      lines: compactSheetLines(adjustmentLines),
      empty: 'Sin ajustes editables en este periodo.',
    },
    {
      id: 'reserve',
      label: 'Apartado obligatorio',
      amount: row.mandatoryReserve,
      tone: 'neutral',
      lines: reserveLines,
      empty: 'Sin dinero apartado al cierre del periodo.',
    },
  ];
}

function supplierInvoiceLabel(payment: OperatingSupplierPayment): string {
  const invoice = payment.invoiceNumber ? `Factura ${payment.invoiceNumber}` : 'Factura sin número';
  return [invoice, payment.supplierNumber ? `Proveedor ${payment.supplierNumber}` : null]
    .filter(Boolean)
    .join(' · ');
}

function supplierPaymentReasonLabel(payment: OperatingSupplierPayment): string {
  if (payment.reason === 'manual') return 'Pago manual';
  return payment.reason === 'credit_limit' ? 'Bajar línea de crédito' : 'Pago por vencimiento';
}

function supplierPaymentDateMeta(payment: OperatingSupplierPayment): string {
  return [
    payment.invoiceDate ? `emitida ${fmtDate(payment.invoiceDate)}` : null,
    payment.dueDate ? `vence ${fmtDate(payment.dueDate)}` : null,
    payment.creditLimit ? `límite ${fmtCurrency(payment.creditLimit)}` : null,
  ].filter(Boolean).join(' · ') || 'Sin fechas registradas';
}

function supplierPaymentToneClass(payment: OperatingSupplierPayment): string {
  if (payment.reason === 'manual') return 'text-[var(--primary)]';
  return payment.reason === 'credit_limit' ? 'text-[var(--warning)]' : 'text-[var(--danger)]';
}

function supplierPaymentBadgeClass(payment: OperatingSupplierPayment): string {
  if (payment.reason === 'manual') return 'bg-[var(--primary-muted)] text-[var(--primary)]';
  return payment.reason === 'credit_limit'
    ? 'bg-[var(--warning-muted)] text-[var(--warning)]'
    : 'bg-[var(--danger)]/8 text-[var(--danger)]';
}

function aggregateSheetLines(lines: Array<{ key: string; title: string; subtitle: string; amount: number }>): SheetLine[] {
  const byKey = new Map<string, SheetLine & { count: number }>();
  for (const line of lines) {
    const current = byKey.get(line.key);
    if (!current) {
      byKey.set(line.key, {
        id: line.key,
        title: line.title,
        subtitle: line.subtitle,
        amount: line.amount,
        count: 1,
      });
      continue;
    }
    current.amount += line.amount;
    current.count += 1;
  }

  return Array.from(byKey.values())
    .map(({ count, ...line }) => ({
      ...line,
      subtitle: count > 1 ? `${count} movimientos · ${line.subtitle}` : line.subtitle,
    }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}

function compactSheetLines(lines: SheetLine[], limit = 8): SheetLine[] {
  if (lines.length <= limit) return lines;
  const visible = lines.slice(0, limit - 1);
  const hidden = lines.slice(limit - 1);
  const otherAmount = hidden.reduce((sum, line) => sum + line.amount, 0);
  return [
    ...visible,
    {
      id: 'otros',
      title: 'Otros',
      subtitle: `${hidden.length} conceptos agrupados`,
      amount: otherAmount,
    },
  ];
}

function reserveSheetLines(lines: OperatingMandatoryReserveLine[]): SheetLine[] {
  return lines
    .filter((line) => line.reservedAmount > 0)
    .map((line) => ({
      id: line.id,
      title: line.label,
      subtitle: `${line.category} · ${reserveSourceLabel(line.source)} · vence ${fmtDate(line.dueDate)}${line.daysUntilDue > 0 ? ` · ${line.daysUntilDue}d` : ''}`,
      amount: line.reservedAmount,
    }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}

function sourceLabel(source: OperatingFlowLine['source']): string {
  switch (source) {
    case 'collections': return 'Cobranza';
    case 'budget': return 'Presupuesto';
    case 'manual': return 'Manual';
    case 'fixed': return 'Regla fija';
    case 'supplier': return 'Proveedor';
    case 'adjustment': return 'Ajuste';
  }
}

function reserveSourceLabel(source: OperatingMandatoryReserveLine['source']): string {
  switch (source) {
    case 'budget': return 'Presupuesto';
    case 'manual': return 'Manual';
    case 'fixed': return 'Regla fija';
  }
}

function sheetToneClass(tone: SheetGroup['tone']): string {
  switch (tone) {
    case 'success': return 'text-[var(--success)]';
    case 'warning': return 'text-[var(--warning)]';
    case 'danger': return 'text-[var(--danger)]';
    case 'neutral': return 'text-[var(--gray-950)]';
  }
}

function DetailList({
  items,
  empty,
}: {
  items: Array<{ title: string; subtitle: string; meta?: string; amount: number; tone: 'success' | 'danger' | 'warning' }>;
  empty: string;
}) {
  return (
    <div className="mt-4 space-y-2">
      {items.length === 0 ? (
        <EmptyMiniState label={empty} />
      ) : (
        items.map((item, index) => (
          <div key={`${item.title}-${index}`} className="rounded-xl border border-[var(--border)] px-3 py-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-[var(--gray-950)]">{item.title}</div>
                <div className="mt-0.5 text-[11px] text-[var(--gray-500)]">{item.subtitle}</div>
                {item.meta && <div className="mt-0.5 text-[10px] text-[var(--gray-400)]">{item.meta}</div>}
              </div>
              <div className={`shrink-0 text-[12px] font-semibold tabular-nums ${
                item.tone === 'success' ? 'text-[var(--success)]' : item.tone === 'warning' ? 'text-[var(--warning)]' : 'text-[var(--danger)]'
              }`}>
                {fmtCurrency(item.amount)}
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function FlowRow({
  date,
  title,
  subtitle,
  meta,
  amount,
  tone,
}: {
  date: string;
  title: string;
  subtitle: string;
  meta?: string;
  amount: number;
  tone: 'success' | 'danger' | 'warning';
}) {
  const toneClass = tone === 'success' ? 'text-[var(--success)]' : tone === 'warning' ? 'text-[var(--warning)]' : 'text-[var(--danger)]';
  return (
    <div className="rounded-xl border border-[var(--border)] px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-[var(--gray-950)]">{title}</div>
          <div className="mt-0.5 text-[11px] text-[var(--gray-500)]">{fmtDate(date)} · {subtitle}</div>
          {meta && <div className="mt-0.5 text-[10px] text-[var(--gray-400)]">{meta}</div>}
        </div>
        <div className={`shrink-0 text-[12px] font-semibold tabular-nums ${toneClass}`}>{fmtCurrency(amount)}</div>
      </div>
    </div>
  );
}

function EmptyMiniState({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--border)] px-3 py-4 text-[12px] text-[var(--gray-400)]">
      {label}
    </div>
  );
}

function TimelineTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ payload?: Record<string, unknown> }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0]?.payload as {
    displayDate: string;
    openingCash: number;
    closingCash: number;
    freeCash: number;
    mandatoryReserve: number;
    mandatoryReserveRequired: number;
    inflows: number;
    totalOutflowsNegative: number;
    net: number;
    collectionCount: number;
    paymentCount: number;
    fixedCount: number;
    alertCount: number;
  } | undefined;
  if (!point) return null;

  return (
    <div
      className="rounded-xl border bg-white px-3 py-2 text-[12px] shadow-sm"
      style={{ borderColor: COLOR.axis }}
    >
      <div className="font-medium text-[var(--gray-950)]">{point.displayDate ?? label}</div>
      <div className="mt-1 space-y-1 text-[var(--gray-600)]">
        <div className="flex justify-between gap-4"><span>Caja apertura</span><span className="font-medium tabular-nums">{fmtCurrency(point.openingCash)}</span></div>
        <div className="flex justify-between gap-4"><span>Entradas</span><span className="font-medium tabular-nums text-[var(--success)]">{fmtCurrency(point.inflows)}</span></div>
        <div className="flex justify-between gap-4"><span>Salidas</span><span className="font-medium tabular-nums text-[var(--danger)]">{fmtCurrency(Math.abs(point.totalOutflowsNegative))}</span></div>
        <div className="flex justify-between gap-4"><span>Neto</span><span className={`font-semibold tabular-nums ${point.net >= 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>{fmtCurrency(point.net)}</span></div>
        <div className="flex justify-between gap-4"><span>Apartado</span><span className="font-medium tabular-nums text-[var(--warning)]">{fmtCurrency(point.mandatoryReserve)}</span></div>
        <div className="flex justify-between gap-4"><span>Mínimo requerido</span><span className="font-medium tabular-nums text-[var(--warning)]">{fmtCurrency(point.mandatoryReserveRequired)}</span></div>
        <div className="flex justify-between gap-4"><span>Disponible</span><span className="font-semibold tabular-nums text-[var(--gray-950)]">{fmtCurrency(point.freeCash)}</span></div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-[var(--gray-400)]">
        <span>{point.collectionCount} cobros</span>
        <span>{point.paymentCount} pagos</span>
        <span>{point.fixedCount} fijos</span>
        {point.alertCount > 0 && <span>{point.alertCount} alertas</span>}
      </div>
    </div>
  );
}
