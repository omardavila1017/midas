import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CalendarDays, Check, ChevronDown, ChevronRight, FileText, Landmark, Pencil, Plus, RotateCcw, Wallet, X } from 'lucide-react';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import type { CobranzaPayment, CobranzaRecord } from '../../../services/jdeTypes';
import type { RealReconciliationResult } from '../../../domain/realReconciliationEngine';
import { fmtCompact, fmtCurrency, fmtDate } from '../../../formatters';
import KpiCard from '../../../components/ui/KpiCard';
import PageHeader from '../../../components/ui/PageHeader';
import { buildFinancialProjectionSourceData } from '../../financial-projection/services/financialProjectionService';
import type {
  TaxManualAdjustment,
  TaxObligation,
  TaxPaymentPlanItem,
  TaxType,
} from '../../shared-finance/types';
import {
  addTaxPaymentPlanItem,
  buildTaxDashboardView,
  createManualTaxObligation,
  createTaxManualAdjustment,
  defaultTaxStore,
  loadTaxStore,
  saveTaxStore,
  taxDueDate,
  updateTaxPaymentPlanItem,
  upsertTaxRateOverride,
  upsertTaxObligation,
  type IvaPeriodDetail,
  type TaxDashboardView,
  type TaxPeriodSummary,
  type TaxRateTarget,
  type TaxSourceLine,
  type TaxStore,
} from '../services/taxModuleService';

interface Props {
  companyCode: string;
  bankStatements: BankAccountStatement[];
  clients: Client[];
  providers: Provider[];
  cxpRecords: CXPRecord[];
  cobranzaRecords?: CobranzaRecord[];
  cobranzaPayments?: CobranzaPayment[];
  cobranzaReconciliation?: RealReconciliationResult;
  assumptions: CashFlowAssumptions;
  budget: Budget | null;
  startingBalance: number;
}

type RangePreset = '90d' | 'eoy';
type DetailTab = 'iva' | 'isn' | 'imss' | 'payments';
type IvaLineMode = 'caused' | 'creditable';

const RANGE_PRESETS: Array<{ id: RangePreset; label: string }> = [
  { id: '90d', label: '90 días' },
  { id: 'eoy', label: 'Fin de año' },
];

export default function TaxDashboard(props: Props) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const fiscalYearStart = useMemo(() => `${Number(today.slice(0, 4))}-01-01`, [today]);
  const yearEnd = useMemo(() => `${Number(today.slice(0, 4))}-12-31`, [today]);

  const [preset, setPreset] = useState<RangePreset>('eoy');
  const endDate = useMemo(() => preset === 'eoy' ? yearEnd : addDays(today, 90), [preset, today, yearEnd]);

  const [taxStore, setTaxStore] = useState<TaxStore>(() => {
    const loaded = loadTaxStore(defaultTaxStore());
    // Seed: si el saldo vencido es 0, lo arrancamos en $180M por defecto para este despliegue.
    if (loaded.overdueBalance === 0) {
      return { ...loaded, overdueBalance: 180_000_000 };
    }
    return loaded;
  });
  const [selectedPeriod, setSelectedPeriod] = useState<string>(today.slice(0, 7));
  const [detailTab, setDetailTab] = useState<DetailTab>('iva');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  useEffect(() => {
    saveTaxStore(taxStore);
  }, [taxStore]);

  const source = useMemo(
    () => buildFinancialProjectionSourceData({ ...props, asOfDate: today }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      props.companyCode,
      props.bankStatements,
      props.clients,
      props.providers,
      props.cxpRecords,
      props.cobranzaRecords,
      props.cobranzaReconciliation,
      props.assumptions,
      props.budget,
      props.startingBalance,
      today,
    ],
  );

  const view = useMemo(
    () => buildTaxDashboardView({
      clients: props.clients,
      providers: props.providers,
      assumptions: props.assumptions,
      cxpRecords: props.cxpRecords,
      cobranzaPayments: props.cobranzaPayments,
      budget: props.budget,
      companyCode: props.companyCode,
      startDate: fiscalYearStart,
      endDate,
      movements: source.movements,
      store: taxStore,
      today,
    }),
    [endDate, fiscalYearStart, props.assumptions, props.budget, props.clients, props.companyCode, props.cobranzaPayments, props.cxpRecords, props.providers, source.movements, taxStore, today],
  );

  useEffect(() => {
    if (view.periods.length === 0) return;
    setSelectedPeriod((current) => view.periods.some((period) => period.period === current)
      ? current
      : view.periods[0].period);
  }, [view.periods]);

  const selected = view.periods.find((period) => period.period === selectedPeriod) ?? view.periods[0];
  const hasFiscalData = props.clients.length > 0
    || props.cxpRecords.length > 0
    || props.budget != null
    || source.movements.length > 0
    || taxStore.adjustments.length > 0
    || taxStore.obligations.length > 0
    || taxStore.overdueBalance > 0;

  const handleAddAdjustment = (adjustment: TaxManualAdjustment) => {
    setTaxStore((current) => ({ ...current, adjustments: [...current.adjustments, adjustment] }));
    setStatusMessage(`Ajuste fiscal guardado para ${adjustment.taxType} ${adjustment.period}.`);
  };

  const handleAddManualObligation = (obligation: TaxObligation) => {
    setTaxStore((current) => upsertTaxObligation(current, obligation));
    setSelectedPeriod(obligation.period);
    setStatusMessage(`Obligación ${obligation.label} capturada.`);
  };

  const handleInlineEdit = (period: string, taxType: TaxType, kind: TaxManualAdjustment['kind'], amount: number) => {
    handleAddAdjustment(createTaxManualAdjustment({
      taxType,
      period,
      kind,
      amount,
      note: 'Ajuste desde tabla de periodos',
    }));
  };

  const handleApproveSuggestedPayment = (obligation: TaxObligation) => {
    const pending = Math.max(0, obligation.totalAmount - obligation.paymentPlan
      .filter((payment) => payment.status === 'PAID')
      .reduce((sum, payment) => sum + payment.amount, 0));
    if (pending <= 0) return;
    const next = addTaxPaymentPlanItem({
      obligation,
      date: obligation.dueDate < today ? today : obligation.dueDate,
      amount: pending,
      status: 'APPROVED',
      note: 'Pago fiscal programado desde módulo de impuestos.',
    });
    setTaxStore((current) => upsertTaxObligation(current, next));
    setStatusMessage(`Pago fiscal programado para ${obligation.taxType} ${obligation.period}.`);
  };

  const handleUpdatePayment = (obligation: TaxObligation, paymentId: string, patch: Partial<TaxPaymentPlanItem>) => {
    const next = updateTaxPaymentPlanItem(obligation, paymentId, patch);
    setTaxStore((current) => upsertTaxObligation(current, next));
  };

  const handleUpdateTaxRate = (target: TaxRateTarget, rate: 8 | 16) => {
    setTaxStore((current) => upsertTaxRateOverride(current, {
      ...target,
      rate,
      updatedAt: new Date().toISOString(),
    }));
    setStatusMessage(`Tasa IVA actualizada a ${rate}%.`);
  };

  const resetView = () => {
    setPreset('eoy');
    setSelectedPeriod(today.slice(0, 7));
    setDetailTab('iva');
    setShowAddForm(false);
  };

  if (!hasFiscalData) {
    return (
      <div className="space-y-5">
        <PageHeader title="Impuestos" />
        <div className="rounded-2xl border border-[var(--gray-200)] bg-white p-10 text-center text-[12px] text-[var(--gray-500)]">
          Carga clientes, CXP o captura una obligación manual para calcular el seguimiento fiscal.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 animate-page-in">
      <PageHeader
        title="Impuestos"
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAddForm((v) => !v)}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[13px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)]"
            >
              <Plus className="h-4 w-4" strokeWidth={1.5} />
              Captura manual
            </button>
            <button
              onClick={resetView}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[13px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)]"
            >
              <RotateCcw className="h-4 w-4" strokeWidth={1.5} />
              Restablecer
            </button>
          </div>
        }
      />

      {statusMessage && (
        <div className="flex items-center justify-between rounded-xl border border-[var(--gray-200)] bg-white px-4 py-2">
          <span className="text-[12px] font-medium text-[var(--gray-700)]">{statusMessage}</span>
          <button onClick={() => setStatusMessage(null)} className="text-[var(--gray-400)] hover:text-[var(--gray-600)]">
            <X className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
        </div>
      )}

      <section className="rounded-2xl border border-[var(--gray-200)] bg-white px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <SegmentedControl label="Rango" value={preset} options={RANGE_PRESETS} onChange={setPreset} />
          <div className="ml-auto text-[12px] text-[var(--gray-500)]">
            IVA por cobrado/pagado · vencimiento semilla día 17
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <KpiCard label="Saldo vencido" value={fmtCurrency(view.overdueBalance)} icon={<CalendarDays className="w-4 h-4" />} color="var(--danger)" sublabel="Impuestos acumulados" />
        <KpiCard label="IVA neto" value={fmtCurrency(view.totals.ivaNet)} icon={<FileText className="w-4 h-4" />} color={view.totals.ivaNet > 0 ? 'var(--warning)' : 'var(--success)'} sublabel="Causado menos acreditable" />
        <KpiCard label="ISN" value={fmtCurrency(view.totals.isn)} icon={<Landmark className="w-4 h-4" />} color="var(--gray-950)" sublabel="3% sobre nómina pagada" />
        <KpiCard label="IMSS" value={fmtCurrency(view.totals.imss)} icon={<Check className="w-4 h-4" />} color={view.totals.imss > 0 ? 'var(--danger)' : 'var(--gray-950)'} sublabel="JDE o captura manual" />
        <KpiCard label="Total acumulado" value={fmtCurrency(view.totals.totalWithOverdue)} icon={<Wallet className="w-4 h-4" />} color="var(--danger)" sublabel="Vencido + nuevos periodos" />
      </div>

      {/* Overdue balance tracker */}
      <section className="grid gap-5 xl:grid-cols-2">
        <OverdueBalanceSection
          balance={taxStore.overdueBalance}
          newPeriodTotal={view.totals.total}
          grossIncome={view.totals.grossIncome}
          registeredPayments={view.totals.cashImpact}
          onChange={(amount) => setTaxStore((prev) => ({ ...prev, overdueBalance: Math.max(0, amount) }))}
        />
        <TaxTrajectoryChart view={view} />
      </section>

      {showAddForm && (
        <TaxForms
          activePeriod={selectedPeriod}
          onAddAdjustment={handleAddAdjustment}
          onAddObligation={handleAddManualObligation}
          onClose={() => setShowAddForm(false)}
        />
      )}

      {/* Main content: period table with inline edit + detail panel */}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_460px]">
        <TaxPeriodTable
          view={view}
          selectedPeriod={selected?.period}
          onSelectPeriod={setSelectedPeriod}
          onInlineEdit={handleInlineEdit}
        />
        {selected && (
          <TaxPeriodDetail
            period={selected}
            detailTab={detailTab}
            onDetailTabChange={setDetailTab}
            onUpdateTaxRate={handleUpdateTaxRate}
            onApprovePayment={handleApproveSuggestedPayment}
            onUpdatePayment={handleUpdatePayment}
          />
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Tax Forms (shown on demand via "Captura manual" button)       */
/* ────────────────────────────────────────────────────────────── */

const ADJUSTMENT_KIND_BY_TAX: Record<TaxType, Array<{ id: TaxManualAdjustment['kind']; label: string }>> = {
  IVA: [
    { id: 'IVA_CAUSED', label: 'IVA causado' },
    { id: 'IVA_CREDITABLE', label: 'IVA acreditable' },
    { id: 'IVA_PAID', label: 'IVA pagado' },
    { id: 'IVA_PAYABLE', label: 'IVA por pagar' },
  ],
  ISN: [{ id: 'ISN_OVERRIDE', label: 'Override ISN' }],
  IMSS: [{ id: 'IMSS_MANUAL', label: 'IMSS manual' }],
};

function TaxForms({
  activePeriod,
  onAddAdjustment,
  onAddObligation,
  onClose,
}: {
  activePeriod: string;
  onAddAdjustment: (adjustment: TaxManualAdjustment) => void;
  onAddObligation: (obligation: TaxObligation) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'adjustment' | 'obligation'>('adjustment');
  const [taxType, setTaxType] = useState<TaxType>('IVA');
  const [kind, setKind] = useState<TaxManualAdjustment['kind']>('IVA_PAID');
  const [period, setPeriod] = useState(activePeriod);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  const [obligationType, setObligationType] = useState<TaxType>('IMSS');
  const [obligationPeriod, setObligationPeriod] = useState(activePeriod);
  const [obligationAmount, setObligationAmount] = useState('');
  const [obligationDueDate, setObligationDueDate] = useState(taxDueDate(activePeriod));
  const [obligationLabel, setObligationLabel] = useState('');

  useEffect(() => {
    setPeriod(activePeriod);
    setObligationPeriod(activePeriod);
    setObligationDueDate(taxDueDate(activePeriod));
  }, [activePeriod]);

  useEffect(() => {
    setKind(ADJUSTMENT_KIND_BY_TAX[taxType][0].id);
  }, [taxType]);

  const addAdjustment = () => {
    onAddAdjustment(createTaxManualAdjustment({
      taxType,
      period,
      kind,
      amount: Number(amount),
      note,
    }));
    setAmount('');
    setNote('');
  };

  const addObligation = () => {
    onAddObligation(createManualTaxObligation({
      taxType: obligationType,
      period: obligationPeriod,
      amount: Number(obligationAmount),
      dueDate: obligationDueDate,
      label: obligationLabel,
      source: 'MANUAL',
      status: 'PENDING',
    }));
    setObligationAmount('');
    setObligationLabel('');
  };

  return (
    <section className="rounded-2xl border border-[var(--gray-200)] bg-white">
      <div className="flex items-center justify-between border-b border-[var(--gray-200)] px-4 py-3">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight text-[var(--gray-950)]">Captura manual</h2>
          <p className="mt-0.5 text-[12px] text-[var(--gray-400)]">Ajustes, overrides y obligaciones sin tocar JDE ni banco.</p>
        </div>
        <button onClick={onClose} className="inline-flex h-7 w-7 items-center justify-center rounded-lg hover:bg-[var(--gray-100)]">
          <X className="h-4 w-4 text-[var(--gray-500)]" strokeWidth={1.5} />
        </button>
      </div>

      <div className="border-b border-[var(--gray-200)] px-4 py-2">
        <SegmentedControl
          value={mode}
          options={[
            { id: 'adjustment', label: 'Ajuste fiscal' },
            { id: 'obligation', label: 'Obligación nueva' },
          ]}
          onChange={setMode}
        />
      </div>

      <div className="px-4 py-3">
        {mode === 'adjustment' ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Impuesto">
              <select value={taxType} onChange={(event) => setTaxType(event.target.value as TaxType)} className={taxInputClass}>
                <option value="IVA">IVA</option>
                <option value="ISN">ISN</option>
                <option value="IMSS">IMSS</option>
              </select>
            </Field>
            <Field label="Periodo">
              <input value={period} onChange={(event) => setPeriod(event.target.value)} className={taxInputClass} placeholder="YYYY-MM" />
            </Field>
            <Field label="Tipo">
              <select value={kind} onChange={(event) => setKind(event.target.value as TaxManualAdjustment['kind'])} className={taxInputClass}>
                {ADJUSTMENT_KIND_BY_TAX[taxType].map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </Field>
            <Field label="Monto">
              <input value={amount} onChange={(event) => setAmount(event.target.value)} type="number" min="0" step="0.01" className={`${taxInputClass} text-right tabular-nums`} placeholder="$0.00" />
            </Field>
            <Field label="Nota">
              <input value={note} onChange={(event) => setNote(event.target.value)} className={taxInputClass} placeholder="Opcional" />
            </Field>
            <button onClick={addAdjustment} disabled={!amount || Number(amount) <= 0} className={taxButtonClass}>
              <Plus className="h-4 w-4" strokeWidth={1.5} />
              Agregar
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Impuesto">
              <select value={obligationType} onChange={(event) => setObligationType(event.target.value as TaxType)} className={taxInputClass}>
                <option value="IVA">IVA</option>
                <option value="ISN">ISN</option>
                <option value="IMSS">IMSS</option>
              </select>
            </Field>
            <Field label="Periodo">
              <input value={obligationPeriod} onChange={(event) => setObligationPeriod(event.target.value)} className={taxInputClass} placeholder="YYYY-MM" />
            </Field>
            <Field label="Monto">
              <input value={obligationAmount} onChange={(event) => setObligationAmount(event.target.value)} type="number" min="0" step="0.01" className={`${taxInputClass} text-right tabular-nums`} placeholder="$0.00" />
            </Field>
            <Field label="Vencimiento">
              <input value={obligationDueDate} onChange={(event) => setObligationDueDate(event.target.value)} type="date" className={taxInputClass} />
            </Field>
            <Field label="Etiqueta">
              <input value={obligationLabel} onChange={(event) => setObligationLabel(event.target.value)} className={taxInputClass} placeholder="IMSS pendiente..." />
            </Field>
            <button onClick={addObligation} disabled={!obligationAmount || Number(obligationAmount) <= 0} className={taxButtonClass}>
              <Plus className="h-4 w-4" strokeWidth={1.5} />
              Agregar
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Overdue Balance Section                                       */
/* ────────────────────────────────────────────────────────────── */

function OverdueBalanceSection({
  balance,
  newPeriodTotal,
  grossIncome,
  registeredPayments,
  onChange,
}: {
  balance: number;
  newPeriodTotal: number;
  grossIncome: number;
  registeredPayments: number;
  onChange: (amount: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const runningTotal = balance + newPeriodTotal;
  const netPending = runningTotal - registeredPayments;
  const benchmark8 = grossIncome * 0.08;

  const startEdit = () => {
    setEditing(true);
    setEditValue(String(Math.round(balance)));
  };
  const commit = () => {
    const val = Number(editValue);
    if (Number.isFinite(val) && val >= 0) onChange(val);
    setEditing(false);
  };

  return (
    <section className="rounded-2xl border border-[var(--gray-200)] bg-white">
      <div className="border-b border-[var(--gray-200)] px-4 py-3">
        <h2 className="text-[15px] font-semibold tracking-tight text-[var(--gray-950)]">Seguimiento de deuda fiscal</h2>
        <p className="mt-0.5 text-[12px] text-[var(--gray-400)]">
          Saldo vencido acumulado + nuevas obligaciones por periodo. Haz clic en el monto para editarlo.
        </p>
      </div>
      <div className="grid gap-2 p-4 sm:grid-cols-4">
        {/* Saldo vencido */}
        <div className="rounded-xl border border-[var(--danger)]/30 bg-[var(--danger)]/5 px-4 py-3">
          <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--danger)]">
            Saldo vencido acumulado
          </div>
          {editing ? (
            <input
              autoFocus
              type="number"
              min="0"
              step="1000000"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') setEditing(false);
              }}
              onBlur={commit}
              className="mt-1 h-8 w-full rounded-lg border border-[var(--danger)] bg-white px-2 text-right text-[16px] font-bold tabular-nums text-[var(--danger)] outline-none"
            />
          ) : (
            <button
              onClick={startEdit}
              className="group mt-1 flex w-full items-center justify-between"
            >
              <span className="text-[18px] font-bold tabular-nums text-[var(--danger)]">{fmtCurrency(balance)}</span>
              <Pencil className="h-3.5 w-3.5 text-[var(--danger)]/40 opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={1.5} />
            </button>
          )}
        </div>

        {/* Nuevas obligaciones del periodo */}
        <div className="rounded-xl border border-[var(--gray-200)] bg-[var(--gray-50)] px-4 py-3">
          <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">Nuevos impuestos</div>
          <div className="mt-1 flex items-baseline justify-between gap-2">
            <span className="text-[18px] font-bold tabular-nums text-[var(--warning)]">{fmtCurrency(newPeriodTotal)}</span>
          </div>
          <div className="mt-0.5 flex items-center justify-between text-[11px] text-[var(--gray-400)]">
            <span>Calculado (IVA+ISN+IMSS)</span>
          </div>
        </div>

        {/* Benchmark 8% */}
        <div className="rounded-xl border border-[var(--gray-200)] bg-[var(--gray-50)] px-4 py-3">
          <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">Referencia (8% Ingresos)</div>
          <div className="mt-1 text-[18px] font-bold tabular-nums text-[var(--gray-400)]">{fmtCurrency(benchmark8)}</div>
          <div className="mt-0.5 text-[11px] text-[var(--gray-400)]">Meta basada en facturación</div>
        </div>

        {/* Total acumulado */}
        <div className="rounded-xl border border-[var(--gray-200)] bg-[var(--gray-50)] px-4 py-3">
          <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">Total acumulado</div>
          <div className="mt-1 text-[18px] font-bold tabular-nums text-[var(--gray-950)]">{fmtCurrency(runningTotal)}</div>
          <div className="mt-0.5 text-[11px] text-[var(--gray-400)]">Vencido + nuevos periodos</div>
        </div>

        {/* Neto pendiente */}
        <div className="rounded-xl border border-[var(--gray-200)] bg-[var(--gray-50)] px-4 py-3">
          <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">Neto pendiente</div>
          <div className="mt-1 text-[18px] font-bold tabular-nums text-[var(--gray-950)]">{fmtCurrency(netPending)}</div>
          <div className="mt-0.5 text-[11px] text-[var(--gray-400)]">Total − pagos aprobados/ejecutados</div>
        </div>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">{label}</span>
      {children}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Tax Period Table — now with inline edit                       */
/* ────────────────────────────────────────────────────────────── */

function TaxPeriodTable({
  view,
  selectedPeriod,
  onSelectPeriod,
  onInlineEdit,
}: {
  view: TaxDashboardView;
  selectedPeriod?: string;
  onSelectPeriod: (period: string) => void;
  onInlineEdit: (period: string, taxType: TaxType, kind: TaxManualAdjustment['kind'], amount: number) => void;
}) {
  const [editingCell, setEditingCell] = useState<{ period: string; field: 'iva' | 'isn' | 'imss' } | null>(null);
  const [editValue, setEditValue] = useState('');

  const startEdit = (period: string, field: 'iva' | 'isn' | 'imss', currentValue: number) => {
    setEditingCell({ period, field });
    setEditValue(String(Math.round(currentValue)));
  };

  const commitEdit = () => {
    if (!editingCell) return;
    const val = Number(editValue);
    if (!Number.isFinite(val) || val < 0) {
      setEditingCell(null);
      return;
    }
    const kindMap: Record<string, { taxType: TaxType; kind: TaxManualAdjustment['kind'] }> = {
      iva: { taxType: 'IVA', kind: 'IVA_PAYABLE' },
      isn: { taxType: 'ISN', kind: 'ISN_OVERRIDE' },
      imss: { taxType: 'IMSS', kind: 'IMSS_MANUAL' },
    };
    const target = kindMap[editingCell.field];
    onInlineEdit(editingCell.period, target.taxType, target.kind, val);
    setEditingCell(null);
  };

  const cancelEdit = () => setEditingCell(null);

  return (
    <section className="rounded-2xl border border-[var(--gray-200)] bg-white">
      <div className="border-b border-[var(--gray-200)] px-4 py-3">
        <h2 className="text-[15px] font-semibold tracking-tight text-[var(--gray-950)]">Obligaciones por periodo</h2>
        <p className="mt-0.5 text-[12px] text-[var(--gray-400)]">
          Haz clic en un monto de IVA, ISN o IMSS para editarlo. Selecciona un periodo para ver su detalle.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-[12px]">
          <thead className="bg-[var(--gray-50)] text-left text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">
            <tr>
              <th className="px-4 py-2.5">Periodo</th>
              <th className="px-4 py-2.5 text-right">IVA neto</th>
              <th className="px-4 py-2.5 text-right">ISN</th>
              <th className="px-4 py-2.5 text-right">IMSS</th>
              <th className="px-4 py-2.5 text-right">Total</th>
              <th className="px-4 py-2.5">Vencimiento</th>
              <th className="px-4 py-2.5">Estatus</th>
              <th className="px-4 py-2.5 text-right">Pagos registrados</th>
            </tr>
          </thead>
          <tbody>
            {view.periods.map((period) => {
              const active = selectedPeriod === period.period;
              return (
                <tr
                  key={period.period}
                  onClick={() => onSelectPeriod(period.period)}
                  className="cursor-pointer border-t border-[var(--gray-200)] hover:bg-[var(--gray-50)]"
                  style={{ background: active ? 'var(--gray-50)' : undefined }}
                >
                  <td className="px-4 py-3 font-semibold text-[var(--gray-950)]">{period.period}</td>
                  <EditableCell
                    value={period.ivaNet}
                    editing={editingCell?.period === period.period && editingCell.field === 'iva'}
                    editValue={editValue}
                    onStartEdit={(e) => { e.stopPropagation(); startEdit(period.period, 'iva', period.ivaNet); }}
                    onEditChange={setEditValue}
                    onCommit={commitEdit}
                    onCancel={cancelEdit}
                  />
                  <EditableCell
                    value={period.isn}
                    editing={editingCell?.period === period.period && editingCell.field === 'isn'}
                    editValue={editValue}
                    onStartEdit={(e) => { e.stopPropagation(); startEdit(period.period, 'isn', period.isn); }}
                    onEditChange={setEditValue}
                    onCommit={commitEdit}
                    onCancel={cancelEdit}
                  />
                  <EditableCell
                    value={period.imss}
                    editing={editingCell?.period === period.period && editingCell.field === 'imss'}
                    editValue={editValue}
                    onStartEdit={(e) => { e.stopPropagation(); startEdit(period.period, 'imss', period.imss); }}
                    onEditChange={setEditValue}
                    onCommit={commitEdit}
                    onCancel={cancelEdit}
                  />
                  <td className="px-4 py-3 text-right font-semibold tabular-nums text-[var(--gray-950)]">{fmtCurrency(period.total)}</td>
                  <td className="px-4 py-3 text-[var(--gray-600)]">{fmtDate(period.dueDate)}</td>
                  <td className="px-4 py-3"><TaxStatusPill status={period.status} /></td>
                  <td className="px-4 py-3 text-right tabular-nums text-[var(--danger)]">{period.cashImpact > 0 ? fmtCurrency(period.cashImpact) : '—'}</td>
                </tr>
              );
            })}
            {view.periods.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-[12px] text-[var(--gray-400)]">Sin periodos fiscales visibles.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EditableCell({
  value,
  editing,
  editValue,
  onStartEdit,
  onEditChange,
  onCommit,
  onCancel,
}: {
  value: number;
  editing: boolean;
  editValue: string;
  onStartEdit: (e: React.MouseEvent) => void;
  onEditChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  if (editing) {
    return (
      <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          type="number"
          min="0"
          step="1"
          value={editValue}
          onChange={(e) => onEditChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCommit();
            if (e.key === 'Escape') onCancel();
          }}
          onBlur={onCommit}
          className="h-8 w-full rounded-lg border border-[var(--primary)] bg-white px-2 text-right text-[12px] tabular-nums text-[var(--gray-950)] outline-none"
        />
      </td>
    );
  }
  return (
    <td
      className="group px-4 py-3 text-right tabular-nums"
      onClick={onStartEdit}
    >
      <span className="inline-flex items-center gap-1">
        {fmtCurrency(value)}
        <Pencil className="h-3 w-3 text-[var(--gray-300)] opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={1.5} />
      </span>
    </td>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Tax Period Detail — improved with better source visibility    */
/* ────────────────────────────────────────────────────────────── */

function TaxPeriodDetail({
  period,
  detailTab,
  onDetailTabChange,
  onUpdateTaxRate,
  onApprovePayment,
  onUpdatePayment,
}: {
  period: TaxPeriodSummary;
  detailTab: DetailTab;
  onDetailTabChange: (tab: DetailTab) => void;
  onUpdateTaxRate: (target: TaxRateTarget, rate: 8 | 16) => void;
  onApprovePayment: (obligation: TaxObligation) => void;
  onUpdatePayment: (obligation: TaxObligation, paymentId: string, patch: Partial<TaxPaymentPlanItem>) => void;
}) {
  const sourceCount = (tab: DetailTab) => {
    if (tab === 'iva') return period.iva.incomeLines.length + period.iva.expenseLines.length;
    if (tab === 'isn') return period.payrollLines.length;
    if (tab === 'imss') return period.imssLines.length;
    return period.obligations.length;
  };

  return (
    <section className="rounded-2xl border border-[var(--gray-200)] bg-white">
      <div className="border-b border-[var(--gray-200)] px-4 py-3">
        <h2 className="text-[15px] font-semibold tracking-tight text-[var(--gray-950)]">Detalle {period.period}</h2>
        <p className="mt-0.5 text-[12px] text-[var(--gray-400)]">Origen de cada impuesto y plan de pagos.</p>
      </div>

      {/* Summary mini-stats */}
      <div className="grid grid-cols-3 gap-2 border-b border-[var(--gray-200)] px-4 py-3">
        <MiniStat label="IVA neto" value={fmtCurrency(period.ivaNet)} />
        <MiniStat label="ISN (3%)" value={fmtCurrency(period.isn)} />
        <MiniStat label="IMSS" value={fmtCurrency(period.imss)} />
      </div>

      <div className="border-b border-[var(--gray-200)] px-4 py-2">
        <SegmentedControl
          value={detailTab}
          options={[
            { id: 'iva' as const, label: `IVA (${sourceCount('iva')})` },
            { id: 'isn' as const, label: `ISN (${sourceCount('isn')})` },
            { id: 'imss' as const, label: `IMSS (${sourceCount('imss')})` },
            { id: 'payments' as const, label: `Pagos (${sourceCount('payments')})` },
          ]}
          onChange={onDetailTabChange}
        />
      </div>
      {detailTab === 'iva' && <IvaDetail iva={period.iva} onUpdateTaxRate={onUpdateTaxRate} />}
      {detailTab === 'isn' && <IsnDetail period={period} />}
      {detailTab === 'imss' && <ImssDetail period={period} />}
      {detailTab === 'payments' && (
        <PaymentPlanDetail
          obligations={period.obligations}
          onApprovePayment={onApprovePayment}
          onUpdatePayment={onUpdatePayment}
        />
      )}
    </section>
  );
}

function IvaDetail({
  iva,
  onUpdateTaxRate,
}: {
  iva: IvaPeriodDetail;
  onUpdateTaxRate: (target: TaxRateTarget, rate: 8 | 16) => void;
}) {
  const [mode, setMode] = useState<IvaLineMode>('caused');
  const lines = mode === 'caused' ? iva.incomeLines : iva.expenseLines;

  return (
    <div className="space-y-3 p-4">
      <div className="grid grid-cols-2 gap-2 text-[12px]">
        <MiniStat label="Causado 16%" value={fmtCurrency(iva.ivaCaused16)} />
        <MiniStat label="Causado 8%" value={fmtCurrency(iva.ivaCaused8)} />
        <MiniStat label="Acreditable 16%" value={fmtCurrency(iva.ivaCreditable16)} />
        <MiniStat label="Acreditable 8%" value={fmtCurrency(iva.ivaCreditable8)} />
        <MiniStat label="IVA neto" value={fmtCurrency(iva.netIva)} />
        <MiniStat label={iva.payable > 0 ? 'Por pagar' : 'Saldo a favor'} value={fmtCurrency(iva.payable > 0 ? iva.payable : iva.balanceInFavor)} />
      </div>

      <SegmentedControl
        value={mode}
        options={[
          { id: 'caused' as const, label: `Causado (${iva.incomeLines.length})` },
          { id: 'creditable' as const, label: `Acreditable (${iva.expenseLines.length})` },
        ]}
        onChange={setMode}
      />

      <IvaLinesTable
        lines={lines}
        empty={mode === 'caused' ? 'Sin facturas causadas en el periodo.' : 'Sin egresos acreditables en el periodo.'}
        onUpdateTaxRate={onUpdateTaxRate}
      />

      {(iva.unclassifiedIncome > 0 || iva.unclassifiedExpense > 0) && (
        <div className="rounded-xl border border-[var(--gray-200)] bg-[var(--gray-50)] px-3 py-2 text-[11px] text-[var(--gray-500)]">
          Sin clasificar: {fmtCurrency(iva.unclassifiedIncome + iva.unclassifiedExpense)}
        </div>
      )}
    </div>
  );
}

function IvaLinesTable({
  lines,
  empty,
  onUpdateTaxRate,
}: {
  lines: TaxSourceLine[];
  empty: string;
  onUpdateTaxRate: (target: TaxRateTarget, rate: 8 | 16) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--gray-200)]">
      <div className="max-h-[360px] overflow-auto">
        {lines.length === 0 ? (
          <div className="px-3 py-8 text-center text-[12px] text-[var(--gray-400)]">{empty}</div>
        ) : (
          <table className="w-full min-w-[560px] text-[11.5px]">
            <thead className="sticky top-0 bg-[var(--gray-50)] text-left text-[10px] uppercase tracking-wider text-[var(--gray-400)]">
              <tr>
                <th className="px-3 py-2">Documento / concepto</th>
                <th className="px-3 py-2">Fecha</th>
                <th className="px-3 py-2 text-right">Base</th>
                <th className="px-3 py-2">Tasa</th>
                <th className="px-3 py-2 text-right">IVA</th>
                <th className="px-3 py-2">Fuente</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={`${line.movementId}-${line.date}-${line.taxRate}`} className="border-t border-[var(--gray-100)]">
                  <td className="px-3 py-2">
                    <div className="max-w-[180px] truncate font-medium text-[var(--gray-950)]" title={line.concept}>{line.concept}</div>
                    <div className="max-w-[180px] truncate text-[10.5px] text-[var(--gray-400)]" title={line.counterpartyName ?? line.sourceSystem}>
                      {line.counterpartyName ?? line.sourceSystem}
                    </div>
                  </td>
                  <td className="px-3 py-2 tabular-nums text-[var(--gray-600)]">{fmtDate(line.date)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtCurrency(line.taxBase)}</td>
                  <td className="px-3 py-2">
                    <select
                      aria-label={`Tasa IVA ${line.concept}`}
                      value={line.taxRate === 8 ? 8 : 16}
                      disabled={!line.rateTarget}
                      onChange={(event) => {
                        if (!line.rateTarget) return;
                        onUpdateTaxRate(line.rateTarget, Number(event.target.value) as 8 | 16);
                      }}
                      className="h-8 rounded-lg border border-[var(--gray-200)] bg-white px-2 text-[11px] font-medium text-[var(--gray-700)] outline-none focus:border-[var(--primary)] disabled:bg-[var(--gray-50)] disabled:text-[var(--gray-400)]"
                    >
                      <option value={16}>16%</option>
                      <option value={8}>8%</option>
                    </select>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtCurrency(line.taxAmount)}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      <span className="rounded-full bg-[var(--gray-100)] px-2 py-0.5 text-[10px] font-medium text-[var(--gray-600)]">{line.sourceSystem}</span>
                      {line.estimated && <span className="rounded-full bg-[var(--warning-muted)] px-2 py-0.5 text-[10px] font-medium text-[var(--warning)]">Estimado</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function IsnDetail({ period }: { period: TaxPeriodSummary }) {
  return (
    <div className="space-y-3 p-4">
      <div className="grid grid-cols-2 gap-2">
        <MiniStat label="Base nómina pagada" value={fmtCurrency(period.payrollBase)} />
        <MiniStat label="ISN (3%)" value={fmtCurrency(period.isn)} />
      </div>
      <CollapsibleSourceLines
        title={`Movimientos de nómina · ${period.payrollLines.length}`}
        lines={period.payrollLines}
        empty="Sin movimientos de nómina en el periodo."
        expanded
        onToggle={() => {}}
      />
    </div>
  );
}

function ImssDetail({ period }: { period: TaxPeriodSummary }) {
  return (
    <div className="space-y-3 p-4">
      <div className="grid grid-cols-2 gap-2">
        <MiniStat label="IMSS detectado" value={fmtCurrency(period.imss)} />
        <MiniStat label="Movimientos" value={String(period.imssLines.length)} />
      </div>
      <CollapsibleSourceLines
        title={`Fuente IMSS · ${period.imssLines.length}`}
        lines={period.imssLines}
        empty="Sin IMSS detectado en JDE/CXP; usa la tabla para capturar el monto manualmente."
        expanded
        onToggle={() => {}}
      />
    </div>
  );
}

function CollapsibleSourceLines({
  title,
  lines,
  empty,
  expanded,
  onToggle,
}: {
  title: string;
  lines: TaxSourceLine[];
  empty: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-xl border border-[var(--gray-200)]">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 border-b border-[var(--gray-200)] bg-[var(--gray-50)] px-3 py-2 text-left"
      >
        {expanded
          ? <ChevronDown className="h-3.5 w-3.5 text-[var(--gray-400)]" strokeWidth={1.5} />
          : <ChevronRight className="h-3.5 w-3.5 text-[var(--gray-400)]" strokeWidth={1.5} />}
        <span className="text-[11px] font-semibold text-[var(--gray-950)]">{title}</span>
      </button>
      {expanded && (
        <div className="max-h-[320px] overflow-auto">
          {lines.length === 0 ? (
            <div className="px-3 py-5 text-center text-[12px] text-[var(--gray-400)]">{empty}</div>
          ) : (
            <table className="w-full min-w-[460px] text-[11.5px]">
              <thead className="text-left text-[10px] uppercase tracking-wider text-[var(--gray-400)]">
                <tr>
                  <th className="px-3 py-2">Documento</th>
                  <th className="px-3 py-2">Fecha</th>
                  <th className="px-3 py-2 text-right">Base</th>
                  <th className="px-3 py-2 text-right">IVA</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={`${line.movementId}-${line.date}`} className="border-t border-[var(--gray-100)]">
                    <td className="px-3 py-2">
                      <div className="truncate font-medium text-[var(--gray-950)]">{line.concept}</div>
                      <div className="truncate text-[10.5px] text-[var(--gray-400)]">{line.counterpartyName ?? line.sourceSystem}</div>
                    </td>
                    <td className="px-3 py-2 tabular-nums text-[var(--gray-600)]">{fmtDate(line.date)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtCurrency(line.taxBase)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{line.taxRate ? `${line.taxRate}% · ${fmtCurrency(line.taxAmount)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function PaymentPlanDetail({
  obligations,
  onApprovePayment,
  onUpdatePayment,
}: {
  obligations: TaxObligation[];
  onApprovePayment: (obligation: TaxObligation) => void;
  onUpdatePayment: (obligation: TaxObligation, paymentId: string, patch: Partial<TaxPaymentPlanItem>) => void;
}) {
  return (
    <div className="divide-y divide-[var(--gray-100)]">
      {obligations.map((obligation) => (
        <div key={obligation.id} className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-semibold text-[var(--gray-950)]">{obligation.label}</div>
              <div className="mt-0.5 text-[11px] text-[var(--gray-400)]">
                {obligation.source} · vence {fmtDate(obligation.dueDate)} · pendiente {fmtCompact(obligation.pendingAmount)}
              </div>
            </div>
            <button onClick={() => onApprovePayment(obligation)} className={taxButtonClass}>
              <CalendarDays className="h-4 w-4" strokeWidth={1.5} />
              Programar pago
            </button>
          </div>
          {obligation.paymentPlan.length === 0 ? (
            <div className="rounded-xl border border-[var(--gray-200)] px-3 py-4 text-center text-[12px] text-[var(--gray-400)]">
              Sin pagos parciales programados.
            </div>
          ) : (
            <div className="space-y-2">
              {obligation.paymentPlan.map((payment) => (
                <div key={payment.id} className="grid gap-2 rounded-xl border border-[var(--gray-200)] p-2 md:grid-cols-[130px_1fr_120px_110px]">
                  <input
                    type="date"
                    value={payment.date}
                    onChange={(event) => onUpdatePayment(obligation, payment.id, { date: event.target.value })}
                    className={taxInputClass}
                  />
                  <input
                    value={payment.note ?? ''}
                    onChange={(event) => onUpdatePayment(obligation, payment.id, { note: event.target.value })}
                    className={taxInputClass}
                    placeholder="Nota"
                  />
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={payment.amount}
                    onChange={(event) => onUpdatePayment(obligation, payment.id, { amount: Number(event.target.value) })}
                    className={`${taxInputClass} text-right tabular-nums`}
                  />
                  <select
                    value={payment.status}
                    onChange={(event) => onUpdatePayment(obligation, payment.id, { status: event.target.value as TaxPaymentPlanItem['status'] })}
                    className={taxInputClass}
                  >
                    <option value="DRAFT">Borrador</option>
                    <option value="APPROVED">Aprobado</option>
                    <option value="PAID">Pagado</option>
                  </select>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      {obligations.length === 0 && (
        <div className="px-4 py-8 text-center text-[12px] text-[var(--gray-400)]">Sin obligaciones fiscales en este periodo.</div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Shared UI components                                          */
/* ────────────────────────────────────────────────────────────── */

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--gray-200)] bg-[var(--gray-50)] px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">{label}</div>
      <div className="mt-1 text-[13px] font-semibold tabular-nums text-[var(--gray-950)]">{value}</div>
    </div>
  );
}

function TaxStatusPill({ status }: { status: TaxObligation['status'] }) {
  const cls = status === 'PAID'
    ? 'bg-[var(--success-muted)] text-[var(--success)]'
    : status === 'CONFIRMED'
      ? 'bg-[var(--primary-muted)] text-[var(--primary)]'
      : status === 'PENDING'
        ? 'bg-[var(--danger)]/10 text-[var(--danger)]'
        : 'bg-[var(--gray-100)] text-[var(--gray-600)]';
  const label = status === 'PAID' ? 'Pagado' : status === 'CONFIRMED' ? 'Confirmado' : status === 'PENDING' ? 'Pendiente' : 'Proyectado';
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium ${cls}`}>{label}</span>;
}

interface SegmentedOption<T extends string> {
  id: T;
  label: string;
}

function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label?: string;
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      {label && <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">{label}</span>}
      <div className="inline-flex h-9 items-center rounded-xl border border-[var(--gray-200)] bg-white p-0.5">
        {options.map((option) => {
          const active = value === option.id;
          return (
            <button
              key={option.id}
              onClick={() => onChange(option.id)}
              className="h-8 rounded-lg px-3 text-[12px] font-medium transition-colors"
              style={{
                background: active ? 'var(--gray-950)' : 'transparent',
                color: active ? 'white' : 'var(--gray-700)',
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

const taxInputClass = 'h-10 w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)]';
const taxButtonClass = 'inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[13px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)] disabled:opacity-40 disabled:cursor-not-allowed';
/* ────────────────────────────────────────────────────────────── */
/* Trajectory Chart                                              */
/* ────────────────────────────────────────────────────────────── */

function TaxTrajectoryChart({ view }: { view: TaxDashboardView }) {
  const data = useMemo(() => {
    let runningTotal = view.overdueBalance;
    return view.periods.map((period) => {
      runningTotal += period.total;
      runningTotal -= period.cashImpact;
      return {
        name: period.period,
        nuevos: period.total,
        pagos: period.cashImpact,
        acumulado: runningTotal,
      };
    });
  }, [view.overdueBalance, view.periods]);

  return (
    <div className="rounded-2xl border border-[var(--gray-200)] bg-white p-4">
      <div className="mb-4">
        <h3 className="text-[13px] font-semibold text-[var(--gray-950)]">Trayectoria de Deuda Fiscal</h3>
        <p className="text-[11px] text-[var(--gray-400)]">Evolución del saldo acumulado proyectado vs pagos aprobados.</p>
      </div>
      <div className="h-[180px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
            <XAxis dataKey="name" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={fmtCompact} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={40} />
            <Tooltip
              formatter={(value: number) => fmtCurrency(value)}
              contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.1)', fontSize: '12px' }}
            />
            <Bar dataKey="nuevos" fill="var(--warning)" radius={[4, 4, 0, 0]} barSize={20} name="Nuevos" />
            <Bar dataKey="pagos" fill="var(--success)" radius={[4, 4, 0, 0]} barSize={20} name="Pagos" />
            <Line type="monotone" dataKey="acumulado" stroke="var(--danger)" strokeWidth={2} dot={{ r: 3 }} name="Saldo Acumulado" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
