import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  BankAccountStatement,
  BankStatementLine,
  CobranzaPayment,
  CobranzaRecord,
  RolRecord,
  ViajeEspecialRecord,
} from '../../../services/jdeTypes';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { AuxiliarReconResult } from '../../../domain/auxiliarReconciliationEngine';
import { todayISO } from '../../../formatters';
import {
  buildFinancialProjectionSourceData,
  calculateCurrentBankCash,
  calculateInitialCash,
} from '../../financial-projection/services/financialProjectionService';
import { APPROVED_SCENARIO_ID, BASE_SCENARIO_ID, ensureCoreScenarios } from '../../financial-planning/services/scenarioBootstrap';
import { loadPlanningAdjustments, loadPlanningScenarios } from '../../financial-planning/services/financialPlanningStorage';
import { loadManualPlanningEntries } from '../../financial-planning/services/manualPlanningEntries';
import { loadCustomRows } from '../../financial-planning/services/customRowsStorage';
import { loadCellOverrides } from '../../financial-planning/services/cellOverridesStorage';
import { loadChangeLog } from '../../financial-planning/services/changeLogStorage';
import { buildScenarioForecastRun } from '../../financial-planning/services/scenarioForecastRun';
import { defaultTaxStore, loadTaxStore } from '../../taxes/services/taxModuleService';
import { useScenarioSelection } from '../../shared-finance/components/ScenarioSelectionContext';
import type { PayrollCostRecord, PurchaseReceiptRecord } from '../../shared-finance/types';
import { KpisTable } from '../components/KpisTable';
import { ObjectivesTable } from '../components/ObjectivesTable';
import { CustomKpiEditor, type CustomKpiInput } from '../components/CustomKpiEditor';
import { ObjectiveEditor, type ObjectiveInput } from '../components/ObjectiveEditor';
import { loadCustomKpis, saveCustomKpis } from '../services/customKpisStorage';
import { loadObjectives, saveObjectives } from '../services/objectivesStorage';
import { buildKpiRows, type KpiPlanningBasis } from '../services/kpiCatalog';
import { formatKpiValue } from '../services/kpiFormatting';
import { evaluateObjective } from '../services/objectiveEvaluator';
import type { CustomKpi, KpiRow, Objective, ObjectiveStatus } from '../types';
import { AlertTriangle, Scale, TrendingDown, TrendingUp, Wallet } from 'lucide-react';

interface Props {
  companyCode?: string;
  bankStatements: BankAccountStatement[];
  bajioStatements?: BankAccountStatement[];
  clients?: Client[];
  providers?: Provider[];
  cobranzaRecords: CobranzaRecord[];
  cobranzaPayments: CobranzaPayment[];
  cxpRecords: CXPRecord[];
  auxiliarReconciliation?: AuxiliarReconResult;
  rolRecords?: RolRecord[];
  viajesEspecialesRecords?: ViajeEspecialRecord[];
  purchaseReceipts?: PurchaseReceiptRecord[];
  payrollCosts?: PayrollCostRecord[];
  assumptions?: CashFlowAssumptions;
  budget?: Budget | null;
  startingBalance?: number;
}

export default function KpisObjectivesDashboard({
  companyCode = 'all',
  bankStatements,
  bajioStatements = [],
  clients = [],
  providers = [],
  cobranzaRecords,
  cobranzaPayments,
  cxpRecords,
  auxiliarReconciliation,
  rolRecords = [],
  viajesEspecialesRecords = [],
  purchaseReceipts = [],
  payrollCosts = [],
  assumptions,
  budget = null,
  startingBalance,
}: Props) {
  const today = useMemo(() => todayISO(), []);
  const scenarioCtx = useScenarioSelection();
  const activeScenarioId = scenarioCtx?.activeScenarioId ?? APPROVED_SCENARIO_ID;
  const bankLines = useMemo<BankStatementLine[]>(
    () => bankStatements.flatMap((s) => s.movimientos ?? []),
    [bankStatements],
  );
  const [customKpis, setCustomKpis] = useState<CustomKpi[]>(() => loadCustomKpis());
  const [objectives, setObjectives] = useState<Objective[]>(() => loadObjectives());

  const [kpiEditorOpen, setKpiEditorOpen] = useState(false);
  const [editingKpiId, setEditingKpiId] = useState<string | null>(null);
  const [objectiveEditorOpen, setObjectiveEditorOpen] = useState(false);
  const [editingObjectiveId, setEditingObjectiveId] = useState<string | null>(null);

  useEffect(() => {
    saveCustomKpis(customKpis);
  }, [customKpis]);
  useEffect(() => {
    saveObjectives(objectives);
  }, [objectives]);

  const planningBasis = useMemo<KpiPlanningBasis | null>(() => {
    if (!assumptions) return null;
    try {
      const source = buildFinancialProjectionSourceData({
        companyCode,
        bankStatements,
        clients,
        providers,
        cxpRecords,
        cobranzaRecords,
        auxiliarReconciliation,
        rolRecords,
        viajesEspecialesRecords,
        purchaseReceipts,
        payrollCosts,
        assumptions,
        budget,
        startingBalance,
        asOfDate: today,
        enablePredictive: false,
      });
      if (!source.hasData) return null;

      const storedScenarios = loadPlanningScenarios([]);
      const storedAdjustments = loadPlanningAdjustments([]);
      const manualEntries = loadManualPlanningEntries([]);
      const customRows = loadCustomRows([]);
      const cellOverrides = loadCellOverrides([]);
      const changeLog = loadChangeLog([]);
      const sourceBaseScenario = source.scenarios.find((scenario) => scenario.kind === 'BASE') ?? source.scenarios[0];
      const bootstrap = ensureCoreScenarios({
        storedScenarios,
        storedAdjustments,
        manualEntries,
        customRows,
        cellOverrides,
        changeLog,
        sourceBaseScenario,
        user: 'tesoreria@senda.local',
      });
      const approvedScenario = bootstrap.scenarios.find(
        (scenario) => scenario.id === APPROVED_SCENARIO_ID && scenario.kind === 'APPROVED' && !scenario.archivedAt,
      ) ?? bootstrap.scenarios.find((scenario) => scenario.kind === 'APPROVED' && !scenario.archivedAt);
      const baseScenario = bootstrap.scenarios.find(
        (scenario) => scenario.id === BASE_SCENARIO_ID && scenario.kind === 'BASE',
      ) ?? sourceBaseScenario;
      const activeScenario = bootstrap.scenarios.find(
        (scenario) => scenario.id === activeScenarioId && !scenario.archivedAt,
      ) ?? approvedScenario ?? baseScenario;
      if (!activeScenario) return null;

      const y = today.slice(0, 4);
      const initialCash = calculateInitialCash(bankStatements, startingBalance, { companyCode });
      const hasScopedBankStatements = !companyCode || companyCode === 'all'
        ? bankStatements.length > 0
        : bankStatements.some((statement) => statement.cia === companyCode);
      const currentCash = hasScopedBankStatements
        ? calculateCurrentBankCash(bankStatements, companyCode, initialCash)
        : null;

      const run = buildScenarioForecastRun({
        scenarioId: activeScenario.id,
        scenarioName: activeScenario.name,
        scenarioKind: activeScenario.kind,
        sourceMovements: source.movements,
        adjustments: bootstrap.adjustments,
        manualEntries: bootstrap.manualEntries,
        customRows: bootstrap.customRows.filter((row) => row.scenarioId === activeScenario.id),
        overrides: bootstrap.cellOverrides.filter((override) => override.scenarioId === activeScenario.id),
        clients,
        providers,
        assumptions,
        cxpRecords,
        purchaseReceipts,
        payrollCosts,
        cobranzaPayments,
        budget,
        companyCode,
        taxStore: loadTaxStore(defaultTaxStore()),
        startDate: `${y}-01-01`,
        endDate: `${y}-12-31`,
        today,
        initialCash,
        supplierInitialCash: currentCash ?? initialCash,
        minimumCash: 20_000_000,
        granularity: 'monthly',
        includeManualEntries: true,
        bajioStatements,
        paidPurchaseOrderKeys: source.paidPurchaseOrderKeys,
      });

      return { run, currentCash };
    } catch (error) {
      console.warn('[kpis-objectives] no se pudo construir base de planeación', error);
      return null;
    }
  }, [
    activeScenarioId,
    assumptions,
    auxiliarReconciliation,
    bajioStatements,
    bankStatements,
    budget,
    clients,
    cobranzaPayments,
    cobranzaRecords,
    companyCode,
    cxpRecords,
    payrollCosts,
    providers,
    purchaseReceipts,
    rolRecords,
    startingBalance,
    today,
    viajesEspecialesRecords,
  ]);

  const kpiRows = useMemo(
    () => buildKpiRows({ bankStatements, cobranzaRecords, cobranzaPayments, cxpRecords, companyCode, planning: planningBasis, today }, customKpis),
    [bankStatements, cobranzaRecords, cobranzaPayments, cxpRecords, companyCode, planningBasis, today, customKpis],
  );

  const objectiveRows = useMemo(
    () =>
      objectives.map((objective) => ({
        objective,
        evaluation: evaluateObjective(objective, {
          bankStatements: bankLines,
          cobranzaPayments,
          kpiRows,
          today,
        }),
      })),
    [objectives, bankLines, cobranzaPayments, kpiRows, today],
  );

  const dashboardKpis = useMemo(() => {
    const byKey = new Map(kpiRows.map((row) => [row.key, row]));
    return {
      caja: byKey.get('system:caja_actual') ?? null,
      cajaFinal: byKey.get('system:caja_final_planeacion') ?? null,
      liquidez: byKey.get('system:liquidez_inmediata') ?? null,
      capitalTrabajo: byKey.get('system:capital_trabajo_operativo') ?? null,
      flujo30d: byKey.get('system:flujo_neto_30d') ?? null,
      cxpVencida: byKey.get('system:cxp_vencida') ?? null,
      pctCxpVencida: byKey.get('system:pct_cxp_vencida') ?? null,
      runway: byKey.get('system:runway_caja_dias') ?? null,
    };
  }, [kpiRows]);

  const financialRatios = useMemo(
    () =>
      [
        'system:liquidez_inmediata',
        'system:cobertura_caja_cxc',
        'system:capital_trabajo_operativo',
        'system:cobertura_flujo_30d',
        'system:dso_cobranza',
        'system:dpo_cxp',
      ]
        .map((key) => kpiRows.find((row) => row.key === key))
        .filter((row): row is KpiRow => Boolean(row)),
    [kpiRows],
  );

  // ── KPI custom CRUD ────────────────────────────────────────────────────────
  const openAddKpi = () => {
    setEditingKpiId(null);
    setKpiEditorOpen(true);
  };
  const openEditKpi = (id: string) => {
    setEditingKpiId(id);
    setKpiEditorOpen(true);
  };
  const submitKpi = useCallback((input: CustomKpiInput) => {
    setCustomKpis((prev) => {
      const now = new Date().toISOString();
      if (input.id) {
        return prev.map((k) =>
          k.id === input.id
            ? {
                ...k,
                name: input.name,
                description: input.description,
                unit: input.unit,
                manualValue: input.manualValue,
                manualValueDate: input.manualValueDate,
                updatedAt: now,
              }
            : k,
        );
      }
      const fresh: CustomKpi = {
        id: `custom-kpi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: input.name,
        description: input.description,
        unit: input.unit,
        manualValue: input.manualValue,
        manualValueDate: input.manualValueDate,
        createdAt: now,
        updatedAt: now,
      };
      return [...prev, fresh];
    });
    setKpiEditorOpen(false);
    setEditingKpiId(null);
  }, []);
  const deleteKpi = (id: string) => {
    if (!window.confirm('¿Borrar este KPI custom? También se desligará de los objetivos que lo usen.')) return;
    setCustomKpis((prev) => prev.filter((k) => k.id !== id));
    setObjectives((prev) =>
      prev.map((o) =>
        o.linkedKpiKey === `custom:${id}` ? { ...o, linkedKpiKey: undefined, updatedAt: new Date().toISOString() } : o,
      ),
    );
  };

  // ── Objetivos CRUD ─────────────────────────────────────────────────────────
  const openAddObjective = () => {
    setEditingObjectiveId(null);
    setObjectiveEditorOpen(true);
  };
  const openEditObjective = (id: string) => {
    setEditingObjectiveId(id);
    setObjectiveEditorOpen(true);
  };
  const submitObjective = useCallback((input: ObjectiveInput) => {
    setObjectives((prev) => {
      const now = new Date().toISOString();
      if (input.id) {
        return prev.map((o) =>
          o.id === input.id
            ? { ...o, ...(stripUndefined(input as unknown as Record<string, unknown>) as Partial<Objective>), updatedAt: now }
            : o,
        );
      }
      const fresh: Objective = {
        id: `objective-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: input.name,
        description: input.description,
        kind: input.kind,
        numericConcept: input.numericConcept,
        targetYearMonth: input.targetYearMonth,
        targetAmount: input.targetAmount,
        comparison: input.comparison,
        linkedKpiKey: input.linkedKpiKey,
        threshold: input.threshold,
        dueDate: input.dueDate,
        notes: input.notes,
        createdAt: now,
        updatedAt: now,
      };
      return [...prev, fresh];
    });
    setObjectiveEditorOpen(false);
    setEditingObjectiveId(null);
  }, []);
  const deleteObjective = (id: string) => {
    if (!window.confirm('¿Borrar este objetivo?')) return;
    setObjectives((prev) => prev.filter((o) => o.id !== id));
  };
  const changeManualStatus = (id: string, status: ObjectiveStatus | null) => {
    setObjectives((prev) =>
      prev.map((o) =>
        o.id === id ? { ...o, manualStatus: status ?? undefined, updatedAt: new Date().toISOString() } : o,
      ),
    );
  };

  const editingKpi = editingKpiId ? customKpis.find((k) => k.id === editingKpiId) ?? null : null;
  const editingObjective = editingObjectiveId
    ? objectives.find((o) => o.id === editingObjectiveId) ?? null
    : null;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.06em]" style={{ color: 'var(--gray-500)' }}>
            Control ejecutivo
          </p>
          <h1 className="mt-1 text-[22px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
            KPIs y Objetivos
          </h1>
          <p className="mt-2 max-w-[72ch] text-[13px] leading-snug" style={{ color: 'var(--gray-500)' }}>
            Lectura consolidada de caja, CXP, cobranza y metas usando los datos reales cargados en la app.
          </p>
        </div>
      </header>

      <section className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.45fr)_minmax(380px,0.9fr)]">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <KpiSpotlight
            icon={Wallet}
            label="Caja disponible"
            kpi={dashboardKpis.caja}
            detail={
              [
                dashboardKpis.liquidez
                  && dashboardKpis.liquidez.value !== null
                  ? `Liquidez ${formatKpiValue(dashboardKpis.liquidez.value, dashboardKpis.liquidez.unit)}`
                  : null,
                dashboardKpis.runway
                  && dashboardKpis.runway.value !== null
                  ? `Días de caja ${formatKpiValue(dashboardKpis.runway.value, dashboardKpis.runway.unit)}`
                  : null,
                dashboardKpis.cajaFinal
                  && dashboardKpis.cajaFinal.value !== null
                  ? `Final planeación ${formatKpiValue(dashboardKpis.cajaFinal.value, dashboardKpis.cajaFinal.unit)}`
                  : null,
              ].filter(Boolean).join(' · ') || 'Liquidez no calculable'
            }
          />
          <KpiSpotlight
            icon={Scale}
            label="Capital trabajo operativo"
            kpi={dashboardKpis.capitalTrabajo}
            detail="Caja + CXC pendiente - CXP pendiente"
            tone={dashboardKpis.capitalTrabajo?.value !== null && (dashboardKpis.capitalTrabajo?.value ?? 0) < 0 ? 'danger' : 'success'}
          />
          <KpiSpotlight
            icon={dashboardKpis.flujo30d?.value !== null && (dashboardKpis.flujo30d?.value ?? 0) < 0 ? TrendingDown : TrendingUp}
            label="Flujo neto 30d"
            kpi={dashboardKpis.flujo30d}
            detail="Cobranza recibida menos cargos bancarios"
            tone={dashboardKpis.flujo30d?.value !== null && (dashboardKpis.flujo30d?.value ?? 0) < 0 ? 'danger' : 'success'}
          />
          <KpiSpotlight
            icon={AlertTriangle}
            label="CXP vencida"
            kpi={dashboardKpis.cxpVencida}
            detail={
              dashboardKpis.pctCxpVencida
                ? `${formatKpiValue(dashboardKpis.pctCxpVencida.value, dashboardKpis.pctCxpVencida.unit)} del saldo pendiente`
                : 'Sin saldo CXP pendiente'
            }
            tone={(dashboardKpis.cxpVencida?.value ?? 0) > 0 ? 'warning' : 'success'}
          />
        </div>

        <FinancialRatiosPanel rows={financialRatios} />
      </section>

      <KpisTable
        rows={kpiRows}
        onAddCustom={openAddKpi}
        onEditCustom={openEditKpi}
        onDeleteCustom={deleteKpi}
      />

      <ObjectivesTable
        rows={objectiveRows}
        kpiRows={kpiRows}
        onAdd={openAddObjective}
        onEdit={openEditObjective}
        onDelete={deleteObjective}
        onChangeManualStatus={changeManualStatus}
      />

      <CustomKpiEditor
        open={kpiEditorOpen}
        initial={editingKpi}
        onClose={() => {
          setKpiEditorOpen(false);
          setEditingKpiId(null);
        }}
        onSubmit={submitKpi}
      />
      <ObjectiveEditor
        open={objectiveEditorOpen}
        initial={editingObjective}
        kpiRows={kpiRows}
        onClose={() => {
          setObjectiveEditorOpen(false);
          setEditingObjectiveId(null);
        }}
        onSubmit={submitObjective}
      />
    </div>
  );
}

function KpiSpotlight({
  icon: Icon,
  label,
  kpi,
  detail,
  tone = 'neutral',
}: {
  icon: typeof Wallet;
  label: string;
  kpi: KpiRow | null;
  detail: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  const toneColor = {
    neutral: 'var(--accent-blue)',
    success: 'var(--success)',
    warning: 'var(--warning)',
    danger: 'var(--danger)',
  }[tone];
  return (
    <article
      className="min-h-[132px] rounded-[var(--radius-lg)] border p-4"
      style={{ borderColor: 'var(--gray-200)', background: 'var(--surface)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.06em]" style={{ color: 'var(--gray-500)' }}>
            {label}
          </p>
          <div className="mt-2 text-[24px] font-semibold tabular-nums tracking-tight" style={{ color: 'var(--gray-950)' }}>
            {kpi ? formatKpiValue(kpi.value, kpi.unit) : '-'}
          </div>
          {kpi?.value === null && kpi.emptyReason && (
            <p className="mt-1 text-[11px] leading-tight" style={{ color: 'var(--gray-400)' }}>
              {kpi.emptyReason}
            </p>
          )}
        </div>
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-md)]"
          style={{ background: 'var(--accent-blue-soft)', color: toneColor }}
        >
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <p className="mt-3 text-[12px] leading-snug" style={{ color: 'var(--gray-500)' }}>
        {detail}
      </p>
      {kpi?.deltaPrev !== null && kpi?.deltaPrev !== undefined && (
        <p className="mt-2 text-[11px] tabular-nums" style={{ color: kpi.deltaPrev >= 0 ? 'var(--success)' : 'var(--danger)' }}>
          Delta periodo previo: {formatKpiValue(kpi.deltaPrev, kpi.unit)}
        </p>
      )}
    </article>
  );
}

function FinancialRatiosPanel({ rows }: { rows: KpiRow[] }) {
  return (
    <div
      className="rounded-[var(--radius-lg)] border"
      style={{ borderColor: 'var(--gray-200)', background: 'var(--surface)' }}
    >
      <div className="border-b px-4 py-3" style={{ borderColor: 'var(--gray-200)' }}>
        <h2 className="text-[15px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
          Razones financieras
        </h2>
        <p className="mt-1 text-[12px] leading-snug" style={{ color: 'var(--gray-500)' }}>
          Indicadores de tesorería operativa sobre caja, CXC, CXP y flujo reciente.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-[12px]">
          <thead className="text-[10px] uppercase tracking-[0.06em]" style={{ color: 'var(--gray-500)', background: 'var(--surface-alt)' }}>
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">Razón</th>
              <th className="px-4 py-2.5 text-right font-medium">Valor</th>
              <th className="px-4 py-2.5 text-left font-medium">Fórmula</th>
              <th className="px-4 py-2.5 text-left font-medium">Lectura</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const meta = ratioMeta(row);
              return (
                <tr key={row.key} className="border-t align-top" style={{ borderColor: 'var(--gray-100)' }}>
                  <td className="px-4 py-3">
                    <div className="font-medium" style={{ color: 'var(--gray-950)' }}>{row.label}</div>
                    <div className="mt-0.5 text-[10px]" style={{ color: 'var(--gray-500)' }}>{row.periodLabel}</div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-semibold" style={{ color: 'var(--gray-950)' }}>
                    {formatKpiValue(row.value, row.unit)}
                    {row.value === null && row.emptyReason && (
                      <div className="mt-0.5 text-[10px] font-normal" style={{ color: 'var(--gray-400)' }}>
                        {row.emptyReason}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3" style={{ color: 'var(--gray-600)' }}>{meta.formula}</td>
                  <td className="px-4 py-3" style={{ color: row.value === null ? 'var(--gray-400)' : meta.color }}>
                    {row.value === null ? 'Sin base' : meta.reading}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ratioMeta(row: KpiRow): { formula: string; reading: string; color: string } {
  const value = row.value ?? 0;
  switch (row.key) {
    case 'system:liquidez_inmediata':
      return {
        formula: 'Caja / CXP',
        reading: value >= 1 ? 'Caja cubre CXP' : value >= 0.5 ? 'Cobertura parcial' : 'Presión de caja',
        color: value >= 1 ? 'var(--success)' : value >= 0.5 ? 'var(--warning)' : 'var(--danger)',
      };
    case 'system:cobertura_caja_cxc':
      return {
        formula: '(Caja + CXC) / CXP',
        reading: value >= 1 ? 'Caja+CXC cubren CXP' : 'No cubre obligaciones',
        color: value >= 1 ? 'var(--success)' : 'var(--danger)',
      };
    case 'system:capital_trabajo_operativo':
      return {
        formula: 'Caja + CXC - CXP',
        reading: value >= 0 ? 'Posición positiva' : 'Déficit operativo',
        color: value >= 0 ? 'var(--success)' : 'var(--danger)',
      };
    case 'system:cobertura_flujo_30d':
      return {
        formula: 'Cobranza 30d / Cargos 30d',
        reading: value >= 1 ? 'Ingresos cubren egresos' : 'Egresos superan ingresos',
        color: value >= 1 ? 'var(--success)' : 'var(--danger)',
      };
    case 'system:dso_cobranza':
      return {
        formula: 'CXC / cobranza diaria 90d',
        reading: value <= 45 ? 'Cobro ágil' : value <= 75 ? 'Cobro medio' : 'Cobro lento',
        color: value <= 45 ? 'var(--success)' : value <= 75 ? 'var(--warning)' : 'var(--danger)',
      };
    case 'system:dpo_cxp':
      return {
        formula: 'CXP / gasto diario 90d',
        reading: value <= 30 ? 'Pago acelerado' : value <= 60 ? 'Pago medio' : 'Pago extendido',
        color: value <= 30 ? 'var(--warning)' : value <= 60 ? 'var(--success)' : 'var(--gray-700)',
      };
    default:
      return { formula: '-', reading: '-', color: 'var(--gray-500)' };
  }
}

function stripUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
