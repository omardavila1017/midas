import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Check, FileText, Landmark, Plus, RotateCcw, Wallet } from 'lucide-react';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import { fmtCompact, fmtCurrency, fmtDate } from '../../../formatters';
import KpiCard from '../../../components/ui/KpiCard';
import PageHeader from '../../../components/ui/PageHeader';
import { CashFlowChart } from '../../financial-projection/components/CashFlowChart';
import {
  buildFinancialProjectionSourceData,
  calculateInitialCash,
} from '../../financial-projection/services/financialProjectionService';
import {
  applyAdjustmentsToMovements,
  calculateBaseProjection,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import {
  convertLegacyScenariosToFinancial,
  isLegacyScenarioId,
  legacyProposalToAdjustments,
  legacyProposalsForActiveScenario,
  legacyScenarioId,
} from '../../shared-finance/calculation-engine/legacyScenarioBridge';
import type {
  FinancialAdjustment,
  FinancialScenario,
  ManualPlanningEntry,
  ProjectionGranularity,
  TaxManualAdjustment,
  TaxObligation,
  TaxPaymentPlanItem,
  TaxType,
} from '../../shared-finance/types';
import {
  expandManualPlanningEntriesToMovements,
  loadManualPlanningEntries,
} from '../../financial-planning/services/manualPlanningEntries';
import {
  loadPlanningAdjustments,
  loadPlanningScenarios,
} from '../../financial-planning/services/financialPlanningStorage';
import type { Proposal, Scenario as LegacyScenario } from '../../../types';
import {
  addTaxPaymentPlanItem,
  buildApprovedTaxPaymentMovements,
  buildTaxDashboardView,
  createManualTaxObligation,
  createTaxManualAdjustment,
  defaultTaxStore,
  loadTaxStore,
  saveTaxStore,
  suggestTaxPaymentDate,
  taxDueDate,
  updateTaxPaymentPlanItem,
  upsertTaxObligation,
  type IvaPeriodDetail,
  type TaxDashboardView,
  type TaxPeriodSummary,
  type TaxSourceLine,
  type TaxStore,
} from '../services/taxModuleService';

interface Props {
  companyCode: string;
  bankStatements: BankAccountStatement[];
  clients: Client[];
  providers: Provider[];
  cxpRecords: CXPRecord[];
  assumptions: CashFlowAssumptions;
  budget: Budget | null;
  startingBalance: number;
  legacyProposals?: Proposal[];
  legacyScenarios?: LegacyScenario[];
  legacyActiveScenarioId?: string | null;
}

type RangePreset = '90d' | 'eoy';
type DetailTab = 'iva' | 'isn' | 'imss' | 'payments';

const RANGE_PRESETS: Array<{ id: RangePreset; label: string }> = [
  { id: '90d', label: '90 días' },
  { id: 'eoy', label: 'Fin de año' },
];

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

export default function TaxDashboard(props: Props) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const monthStart = useMemo(() => `${today.slice(0, 7)}-01`, [today]);
  const yearEnd = useMemo(() => `${Number(today.slice(0, 4))}-12-31`, [today]);
  const horizonYearMonth = yearEnd.slice(0, 7);

  const [preset, setPreset] = useState<RangePreset>('eoy');
  const [granularity] = useState<ProjectionGranularity>('monthly');
  const endDate = useMemo(() => preset === 'eoy' ? yearEnd : addDays(today, 90), [preset, today, yearEnd]);

  const [taxStore, setTaxStore] = useState<TaxStore>(() => loadTaxStore(defaultTaxStore()));
  const [selectedPeriod, setSelectedPeriod] = useState<string>(today.slice(0, 7));
  const [detailTab, setDetailTab] = useState<DetailTab>('iva');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

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
      props.assumptions,
      props.budget,
      props.startingBalance,
      today,
    ],
  );
  const [storedScenarios] = useState<FinancialScenario[]>(() => loadPlanningScenarios([]));
  const [storedAdjustments] = useState<FinancialAdjustment[]>(() => loadPlanningAdjustments([]));
  const [manualEntries] = useState<ManualPlanningEntry[]>(() => loadManualPlanningEntries([]));

  const sourceBaseScenario = source.scenarios.find((scenario) => scenario.isBase) ?? source.scenarios[0];
  const storedBaseScenario = storedScenarios.find((scenario) => scenario.isBase && !scenario.archivedAt);
  const baseScenario = storedBaseScenario ?? sourceBaseScenario;
  const legacyScenarios = useMemo(
    () => convertLegacyScenariosToFinancial(props.legacyScenarios ?? []),
    [props.legacyScenarios],
  );
  const archivedBaseScenarios = storedScenarios.filter((scenario) => scenario.archivedAt);
  const scenarios = useMemo(
    () => [baseScenario, ...legacyScenarios, ...archivedBaseScenarios],
    [archivedBaseScenarios, baseScenario, legacyScenarios],
  );
  const initialScenarioId = useMemo(() => {
    if (props.legacyActiveScenarioId) return legacyScenarioId({ id: props.legacyActiveScenarioId } as LegacyScenario);
    return baseScenario.id;
  }, [baseScenario.id, props.legacyActiveScenarioId]);
  const [activeScenarioId, setActiveScenarioId] = useState(initialScenarioId);

  useEffect(() => {
    if (!scenarios.some((scenario) => scenario.id === activeScenarioId)) {
      setActiveScenarioId(scenarios[0]?.id ?? activeScenarioId);
    }
  }, [activeScenarioId, scenarios]);

  const activeScenario = scenarios.find((scenario) => scenario.id === activeScenarioId) ?? baseScenario;

  const baseSeedMovements = useMemo(() => {
    const manual = expandManualPlanningEntriesToMovements(manualEntries, {
      scenarioId: baseScenario.id,
      startDate: monthStart,
      endDate,
      asOfDate: today,
    });
    const taxMovements = buildApprovedTaxPaymentMovements({
      obligations: taxStore.obligations,
      scenarioId: baseScenario.id,
      startDate: monthStart,
      endDate,
      asOfDate: today,
    });
    return applyAdjustmentsToMovements(
      [...source.movements, ...manual, ...taxMovements],
      storedAdjustments,
      baseScenario.id,
    );
  }, [baseScenario.id, endDate, manualEntries, monthStart, source.movements, storedAdjustments, taxStore.obligations, today]);

  const baseProjection = useMemo(
    () => calculateBaseProjection(baseSeedMovements, {
      startDate: monthStart,
      endDate,
      initialCash: calculateInitialCash(props.bankStatements, props.startingBalance),
      minimumCash: minimumCashFor(props),
      granularity,
      scenarioId: baseScenario.id,
      name: baseScenario.name,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseScenario.id, baseScenario.name, baseSeedMovements, endDate, granularity, monthStart, props.bankStatements, props.budget, props.startingBalance],
  );

  const activeAdjustments = useMemo<FinancialAdjustment[]>(() => {
    const stored = storedAdjustments.filter((adjustment) => adjustment.scenarioIds.includes(activeScenario.id));
    if (!isLegacyScenarioId(activeScenario.id)) return stored;
    const proposals = legacyProposalsForActiveScenario(
      activeScenario.id,
      props.legacyScenarios ?? [],
      props.legacyProposals ?? [],
    );
    return [
      ...stored,
      ...proposals.flatMap((proposal) =>
        legacyProposalToAdjustments(proposal, activeScenario.id, today, horizonYearMonth),
      ),
    ];
  }, [activeScenario.id, horizonYearMonth, props.legacyProposals, props.legacyScenarios, storedAdjustments, today]);

  const activeManualMovements = useMemo(
    () => expandManualPlanningEntriesToMovements(manualEntries, {
      scenarioId: activeScenario.id,
      startDate: monthStart,
      endDate,
      asOfDate: today,
    }),
    [activeScenario.id, endDate, manualEntries, monthStart, today],
  );

  const activeProjection = useMemo(() => {
    if (activeScenario.isBase) return baseProjection;
    const taxMovements = buildApprovedTaxPaymentMovements({
      obligations: taxStore.obligations,
      scenarioId: activeScenario.id,
      startDate: monthStart,
      endDate,
      asOfDate: today,
    });
    const seed = activeScenario.archivedAt
      ? [...source.movements, ...activeManualMovements, ...taxMovements]
      : [...baseProjection.movements, ...activeManualMovements, ...taxMovements];
    const adjusted = applyAdjustmentsToMovements(seed, activeAdjustments, activeScenario.id);
    return calculateBaseProjection(adjusted, {
      startDate: monthStart,
      endDate,
      initialCash: baseProjection.buckets[0]?.openingCash ?? baseProjection.summary.currentCash,
      minimumCash: baseProjection.summary.minimumCashRequired,
      granularity,
      scenarioId: activeScenario.id,
      name: activeScenario.name,
    });
  }, [
    activeAdjustments,
    activeManualMovements,
    activeScenario,
    baseProjection,
    endDate,
    granularity,
    monthStart,
    source.movements,
    taxStore.obligations,
    today,
  ]);

  const view = useMemo(
    () => buildTaxDashboardView({
      projection: activeProjection,
      store: taxStore,
      providers: props.providers,
      cxpRecords: props.cxpRecords,
      scenarioId: activeScenario.id,
      today,
    }),
    [activeProjection, activeScenario.id, props.cxpRecords, props.providers, taxStore, today],
  );

  useEffect(() => {
    if (view.periods.length === 0) return;
    setSelectedPeriod((current) => view.periods.some((period) => period.period === current)
      ? current
      : view.periods[0].period);
  }, [view.periods]);

  const selected = view.periods.find((period) => period.period === selectedPeriod) ?? view.periods[0];

  const handleAddAdjustment = (adjustment: TaxManualAdjustment) => {
    setTaxStore((current) => ({ ...current, adjustments: [...current.adjustments, adjustment] }));
    setStatusMessage(`Ajuste fiscal guardado para ${adjustment.taxType} ${adjustment.period}.`);
  };

  const handleAddManualObligation = (obligation: TaxObligation) => {
    setTaxStore((current) => upsertTaxObligation(current, obligation));
    setSelectedPeriod(obligation.period);
    setStatusMessage(`Obligación ${obligation.label} capturada.`);
  };

  const handleApproveSuggestedPayment = (obligation: TaxObligation) => {
    const pending = Math.max(0, obligation.totalAmount - obligation.paymentPlan
      .filter((payment) => payment.status === 'PAID')
      .reduce((sum, payment) => sum + payment.amount, 0));
    if (pending <= 0) return;
    const suggestion = suggestTaxPaymentDate(activeProjection, obligation.dueDate, pending);
    const next = addTaxPaymentPlanItem({
      obligation,
      date: suggestion?.date ?? obligation.dueDate,
      amount: pending,
      status: 'APPROVED',
      scenarioId: activeScenario.id,
      note: suggestion?.reason ?? 'Pago fiscal aprobado desde módulo de impuestos.',
    });
    setTaxStore((current) => upsertTaxObligation(current, next));
    setStatusMessage(`Pago aprobado para ${obligation.taxType} ${obligation.period}.`);
  };

  const handleUpdatePayment = (obligation: TaxObligation, paymentId: string, patch: Partial<TaxPaymentPlanItem>) => {
    const next = updateTaxPaymentPlanItem(obligation, paymentId, patch);
    setTaxStore((current) => upsertTaxObligation(current, next));
  };

  const resetView = () => {
    setPreset('eoy');
    setSelectedPeriod(today.slice(0, 7));
    setDetailTab('iva');
  };

  if (!source.hasData) {
    return (
      <div className="space-y-5">
        <PageHeader title="Impuestos" />
        <div className="rounded-2xl border border-[var(--gray-200)] bg-white p-10 text-center text-[12px] text-[var(--gray-500)]">
          Carga bancos y al menos clientes, CXP o presupuesto para calcular obligaciones fiscales.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 animate-page-in">
      <PageHeader
        title="Impuestos"
        actions={
          <button
            onClick={resetView}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[13px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)]"
          >
            <RotateCcw className="h-4 w-4" strokeWidth={1.5} />
            Restablecer
          </button>
        }
      />

      {statusMessage && (
        <div className="rounded-xl border border-[var(--gray-200)] bg-white px-4 py-2 text-[12px] font-medium text-[var(--gray-700)]">
          {statusMessage}
        </div>
      )}

      <section className="rounded-2xl border border-[var(--gray-200)] bg-white px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <SegmentedControl label="Rango" value={preset} options={RANGE_PRESETS} onChange={setPreset} />
          <label className="flex items-center gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">Escenario</span>
            <select
              value={activeScenario.id}
              onChange={(event) => setActiveScenarioId(event.target.value)}
              className="h-9 min-w-[260px] rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)]"
            >
              {scenarios.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>
                  {scenario.name}{scenario.archivedAt ? ' · archivado' : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="ml-auto text-[12px] text-[var(--gray-500)]">
            Régimen 601 · calendario editable · vencimiento semilla día 17
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="IVA neto" value={fmtCurrency(view.totals.ivaNet)} icon={<FileText className="w-4 h-4" />} color={view.totals.ivaNet > 0 ? 'var(--warning)' : 'var(--success)'} sublabel="Causado menos acreditable" />
        <KpiCard label="ISN" value={fmtCurrency(view.totals.isn)} icon={<Landmark className="w-4 h-4" />} color="var(--gray-950)" sublabel="3% sobre nómina pagada" />
        <KpiCard label="IMSS" value={fmtCurrency(view.totals.imss)} icon={<Check className="w-4 h-4" />} color={view.totals.imss > 0 ? 'var(--danger)' : 'var(--gray-950)'} sublabel="JDE o captura manual" />
        <KpiCard label="Impacto caja" value={fmtCurrency(view.totals.cashImpact)} icon={<Wallet className="w-4 h-4" />} color={view.totals.cashImpact > 0 ? 'var(--danger)' : 'var(--gray-950)'} sublabel="Pagos fiscales aprobados" />
      </div>

      <CashFlowChart
        projection={activeProjection}
        baseProjection={activeProjection.scenarioId === baseProjection.scenarioId ? undefined : baseProjection}
      />

      <TaxForms
        activePeriod={selectedPeriod}
        onAddAdjustment={handleAddAdjustment}
        onAddObligation={handleAddManualObligation}
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_460px]">
        <TaxPeriodTable
          view={view}
          selectedPeriod={selected?.period}
          onSelectPeriod={setSelectedPeriod}
        />
        {selected && (
          <TaxPeriodDetail
            period={selected}
            detailTab={detailTab}
            onDetailTabChange={setDetailTab}
            onApprovePayment={handleApproveSuggestedPayment}
            onUpdatePayment={handleUpdatePayment}
          />
        )}
      </div>
    </div>
  );
}

function TaxForms({
  activePeriod,
  onAddAdjustment,
  onAddObligation,
}: {
  activePeriod: string;
  onAddAdjustment: (adjustment: TaxManualAdjustment) => void;
  onAddObligation: (obligation: TaxObligation) => void;
}) {
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
      <div className="border-b border-[var(--gray-200)] px-4 py-3">
        <h2 className="text-[15px] font-semibold tracking-tight text-[var(--gray-950)]">Captura fiscal flexible</h2>
        <p className="mt-0.5 text-[12px] text-[var(--gray-400)]">Ajustes manuales, overrides y obligaciones pendientes sin tocar JDE ni banco.</p>
      </div>
      <div className="grid gap-3 px-4 py-3 lg:grid-cols-2">
        <div className="grid gap-2 rounded-xl border border-[var(--gray-200)] p-3 md:grid-cols-[90px_110px_150px_130px_minmax(140px,1fr)_auto]">
          <select value={taxType} onChange={(event) => setTaxType(event.target.value as TaxType)} className={taxInputClass}>
            <option value="IVA">IVA</option>
            <option value="ISN">ISN</option>
            <option value="IMSS">IMSS</option>
          </select>
          <input value={period} onChange={(event) => setPeriod(event.target.value)} className={taxInputClass} placeholder="YYYY-MM" />
          <select value={kind} onChange={(event) => setKind(event.target.value as TaxManualAdjustment['kind'])} className={taxInputClass}>
            {ADJUSTMENT_KIND_BY_TAX[taxType].map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          <input value={amount} onChange={(event) => setAmount(event.target.value)} type="number" min="0" step="0.01" className={`${taxInputClass} text-right tabular-nums`} placeholder="Monto" />
          <input value={note} onChange={(event) => setNote(event.target.value)} className={taxInputClass} placeholder="Nota o fuente" />
          <button onClick={addAdjustment} className={taxButtonClass}>
            <Plus className="h-4 w-4" strokeWidth={1.5} />
            Ajuste
          </button>
        </div>
        <div className="grid gap-2 rounded-xl border border-[var(--gray-200)] p-3 md:grid-cols-[90px_110px_130px_130px_minmax(140px,1fr)_auto]">
          <select value={obligationType} onChange={(event) => setObligationType(event.target.value as TaxType)} className={taxInputClass}>
            <option value="IVA">IVA</option>
            <option value="ISN">ISN</option>
            <option value="IMSS">IMSS</option>
          </select>
          <input value={obligationPeriod} onChange={(event) => setObligationPeriod(event.target.value)} className={taxInputClass} placeholder="YYYY-MM" />
          <input value={obligationAmount} onChange={(event) => setObligationAmount(event.target.value)} type="number" min="0" step="0.01" className={`${taxInputClass} text-right tabular-nums`} placeholder="Monto" />
          <input value={obligationDueDate} onChange={(event) => setObligationDueDate(event.target.value)} type="date" className={taxInputClass} />
          <input value={obligationLabel} onChange={(event) => setObligationLabel(event.target.value)} className={taxInputClass} placeholder="IMSS pendiente, convenio..." />
          <button onClick={addObligation} className={taxButtonClass}>
            <Plus className="h-4 w-4" strokeWidth={1.5} />
            Obligación
          </button>
        </div>
      </div>
    </section>
  );
}

function TaxPeriodTable({
  view,
  selectedPeriod,
  onSelectPeriod,
}: {
  view: TaxDashboardView;
  selectedPeriod?: string;
  onSelectPeriod: (period: string) => void;
}) {
  return (
    <section className="rounded-2xl border border-[var(--gray-200)] bg-white">
      <div className="border-b border-[var(--gray-200)] px-4 py-3">
        <h2 className="text-[15px] font-semibold tracking-tight text-[var(--gray-950)]">Obligaciones por periodo</h2>
        <p className="mt-0.5 text-[12px] text-[var(--gray-400)]">IVA, ISN e IMSS separados, con impacto en caja y estatus.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] text-[12px]">
          <thead className="bg-[var(--gray-50)] text-left text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">
            <tr>
              <th className="px-4 py-2.5">Periodo</th>
              <th className="px-4 py-2.5 text-right">IVA neto</th>
              <th className="px-4 py-2.5 text-right">ISN</th>
              <th className="px-4 py-2.5 text-right">IMSS</th>
              <th className="px-4 py-2.5 text-right">Total</th>
              <th className="px-4 py-2.5">Vencimiento</th>
              <th className="px-4 py-2.5">Estatus</th>
              <th className="px-4 py-2.5 text-right">Impacto caja</th>
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
                  <td className="px-4 py-3 text-right tabular-nums">{fmtCurrency(period.ivaNet)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmtCurrency(period.isn)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmtCurrency(period.imss)}</td>
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

function TaxPeriodDetail({
  period,
  detailTab,
  onDetailTabChange,
  onApprovePayment,
  onUpdatePayment,
}: {
  period: TaxPeriodSummary;
  detailTab: DetailTab;
  onDetailTabChange: (tab: DetailTab) => void;
  onApprovePayment: (obligation: TaxObligation) => void;
  onUpdatePayment: (obligation: TaxObligation, paymentId: string, patch: Partial<TaxPaymentPlanItem>) => void;
}) {
  return (
    <section className="rounded-2xl border border-[var(--gray-200)] bg-white">
      <div className="border-b border-[var(--gray-200)] px-4 py-3">
        <h2 className="text-[15px] font-semibold tracking-tight text-[var(--gray-950)]">Detalle {period.period}</h2>
        <p className="mt-0.5 text-[12px] text-[var(--gray-400)]">Drilldown de facturas, nómina, IMSS y pagos parciales.</p>
      </div>
      <div className="border-b border-[var(--gray-200)] px-4 py-2">
        <SegmentedControl
          value={detailTab}
          options={[
            { id: 'iva', label: 'IVA' },
            { id: 'isn', label: 'ISN' },
            { id: 'imss', label: 'IMSS' },
            { id: 'payments', label: 'Pagos' },
          ]}
          onChange={onDetailTabChange}
        />
      </div>
      {detailTab === 'iva' && <IvaDetail iva={period.iva} />}
      {detailTab === 'isn' && <SourceLines title={`Nómina pagada · base ${fmtCurrency(period.payrollBase)}`} lines={period.payrollLines} empty="Sin movimientos de nómina en el periodo." />}
      {detailTab === 'imss' && <SourceLines title="Fuente IMSS" lines={period.imssLines} empty="Sin IMSS detectado en JDE/CXP; captura manualmente si aplica." />}
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

function IvaDetail({ iva }: { iva: IvaPeriodDetail }) {
  return (
    <div className="space-y-3 p-4">
      <div className="grid grid-cols-2 gap-2 text-[12px]">
        <MiniStat label="Ingresos IVA 16%" value={fmtCurrency(iva.incomeBase16)} />
        <MiniStat label="Ingresos IVA 8%" value={fmtCurrency(iva.incomeBase8)} />
        <MiniStat label="IVA causado" value={fmtCurrency(iva.ivaCaused)} />
        <MiniStat label="IVA acreditable" value={fmtCurrency(iva.ivaCreditable)} />
        <MiniStat label="IVA neto" value={fmtCurrency(iva.netIva)} />
        <MiniStat label={iva.payable > 0 ? 'Por pagar' : 'Saldo a favor'} value={fmtCurrency(iva.payable > 0 ? iva.payable : iva.balanceInFavor)} />
      </div>
      <SourceLines title="Facturas cobradas que causan IVA" lines={iva.incomeLines} empty="Sin ingresos con IVA clasificado." />
      <SourceLines title="Facturas pagadas que acreditan IVA" lines={iva.expenseLines} empty="Sin egresos acreditables clasificados." />
      <SourceLines title={`Sin clasificar · ${fmtCompact(iva.unclassifiedIncome + iva.unclassifiedExpense)}`} lines={iva.unclassifiedLines} empty="Sin movimientos sin clasificar." />
    </div>
  );
}

function SourceLines({ title, lines, empty }: { title: string; lines: TaxSourceLine[]; empty: string }) {
  return (
    <div className="rounded-xl border border-[var(--gray-200)]">
      <div className="border-b border-[var(--gray-200)] bg-[var(--gray-50)] px-3 py-2 text-[11px] font-semibold text-[var(--gray-950)]">{title}</div>
      <div className="max-h-[320px] overflow-auto">
        {lines.length === 0 ? (
          <div className="px-3 py-5 text-center text-[12px] text-[var(--gray-400)]">{empty}</div>
        ) : (
          <table className="w-full min-w-[560px] text-[11.5px]">
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
              Aprobar pago
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

function minimumCashFor(props: Props): number {
  const fallback = 20_000_000;
  if (!props.budget) return fallback;
  const month = new Date().getUTCMonth();
  const monthlyExpense = props.budget.expenseTotal?.[month] ?? 0;
  return monthlyExpense > 0 ? Math.round(monthlyExpense * 0.3) : fallback;
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

const taxInputClass = 'h-10 w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)]';
const taxButtonClass = 'inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[13px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)]';
