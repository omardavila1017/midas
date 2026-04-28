import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Plus } from 'lucide-react';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import { fmtCurrency } from '../../../formatters';
import {
  calculateBaseProjection,
  calculateScenarioProjection,
  compareScenarios,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type {
  AuditEvent,
  FinancialAdjustment,
  FinancialMovement,
  FinancialScenario,
} from '../../shared-finance/types';
import { appendAuditEvent } from '../../shared-finance/audit/audit';
import { CashFlowChart } from '../../financial-projection/components/CashFlowChart';
import { TaxPlanningPanel } from '../../financial-projection/components/FinanceContextPanels';
import {
  buildFinancialProjectionSourceData,
  calculateInitialCash,
} from '../../financial-projection/services/financialProjectionService';
import { AdjustmentEditorModal } from '../components/AdjustmentEditorModal';
import { AdjustmentLibrary } from '../components/AdjustmentLibrary';
import { ApprovalWorkflowPanel } from '../components/ApprovalWorkflowPanel';
import { AuditTrailPanel } from '../components/AuditTrailPanel';
import { EditablePlanningGrid, splitAdjustmentForMovement } from '../components/EditablePlanningGrid';
import { ScenarioComparison } from '../components/ScenarioComparison';
import { ScenarioSelector } from '../components/ScenarioSelector';
import {
  approveAdjustment,
  approveScenario,
  publishPlan,
  rejectAdjustment,
} from '../services/financialPlanningService';
import {
  loadPlanningAdjustments,
  loadPlanningAudit,
  loadPlanningScenarios,
  savePlanningAdjustments,
  savePlanningAudit,
  savePlanningScenarios,
} from '../services/financialPlanningStorage';
import KpiCard from '../../../components/ui/KpiCard';
import PageHeader from '../../../components/ui/PageHeader';

interface Props {
  companyCode: string;
  bankStatements: BankAccountStatement[];
  clients: Client[];
  providers: Provider[];
  cxpRecords: CXPRecord[];
  assumptions: CashFlowAssumptions;
  budget: Budget | null;
  startingBalance: number;
}

/**
 * Planeación Financiera — escenarios, ajustes, aprobaciones y plan
 * oficial sobre la trayectoria canónica del Dashboard.
 *
 * Cambios post-refactor:
 *
 *   1. Hereda la trayectoria canónica del Dashboard vía
 *      `buildFinancialProjectionSourceData`. Antes calculaba su propia
 *      caja con datos parcialmente mock.
 *   2. PageHeader idéntico al resto del producto. Antes el header era
 *      `<header>` HTML inline con `bg-white/8` y métricas en chips
 *      transparentes.
 *   3. Empty state honesto cuando no hay datos. Antes mostraba "Diesel
 *      Norte", "Carrier Planta A", etc.
 *   4. Eliminados los paneles de Cobranza y Proveedores — esos viven
 *      ahora SOLO en Proyección Financiera. Aquí dejamos únicamente
 *      Impuestos porque su workflow de aprobación es parte de
 *      Planeación.
 *   5. Métricas de cabecera ahora son `<KpiCard>` reales (no chips
 *      blancos transparentes).
 */
export default function FinancialPlanningDashboard(props: Props) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const yearEnd = useMemo(() => `${Number(today.slice(0, 4))}-12-31`, [today]);

  const source = useMemo(
    () => buildFinancialProjectionSourceData({ ...props, asOfDate: today }),
    [props, today],
  );
  const [scenarios, setScenarios] = useState<FinancialScenario[]>(
    () => loadPlanningScenarios(source.scenarios),
  );
  const [adjustments, setAdjustments] = useState<FinancialAdjustment[]>(
    () => loadPlanningAdjustments([]),
  );
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>(() => loadPlanningAudit());
  const [activeScenarioId, setActiveScenarioId] = useState<string>(
    () => scenarios.find((scenario) => !scenario.isBase)?.id ?? scenarios[0]?.id ?? 'liquidity',
  );
  const [editorMovement, setEditorMovement] = useState<FinancialMovement | null>(null);

  useEffect(() => { savePlanningScenarios(scenarios); }, [scenarios]);
  useEffect(() => { savePlanningAdjustments(adjustments); }, [adjustments]);
  useEffect(() => { savePlanningAudit(auditEvents); }, [auditEvents]);

  const baseScenario = scenarios.find((scenario) => scenario.isBase) ?? source.scenarios[0];
  const activeScenario = scenarios.find((scenario) => scenario.id === activeScenarioId) ?? baseScenario;

  const baseProjection = useMemo(
    () => calculateBaseProjection(source.movements, {
      startDate: today,
      endDate: yearEnd,
      initialCash: calculateInitialCash(props.bankStatements, props.startingBalance),
      minimumCash: minimumCashFor(props),
      granularity: 'monthly',
      scenarioId: baseScenario.id,
      name: baseScenario.name,
    }),
    [baseScenario.id, baseScenario.name, props, source.movements, today, yearEnd],
  );

  const scenarioProjections = useMemo(
    () => scenarios.map((scenario) => calculateScenarioProjection(baseProjection, scenario, adjustments)),
    [adjustments, baseProjection, scenarios],
  );
  const activeProjection = scenarioProjections.find(
    (projection) => projection.scenarioId === activeScenario.id,
  ) ?? baseProjection;
  const comparisons = compareScenarios(
    baseProjection,
    scenarioProjections.filter((projection) => projection.scenarioId !== baseProjection.scenarioId),
  );

  const activeMovements = useMemo(
    () => activeProjection.movements
      .filter((movement) => movement.status !== 'REAL')
      .sort((a, b) =>
        (a.adjustedDate ?? a.projectedDate).localeCompare(b.adjustedDate ?? b.projectedDate),
      ),
    [activeProjection.movements],
  );

  const handleSaveAdjustment = (adjustment: FinancialAdjustment) => {
    setAdjustments((current) => [adjustment, ...current.filter((item) => item.id !== adjustment.id)]);
    setAuditEvents((current) => appendAuditEvent(current, {
      entityType: 'ADJUSTMENT',
      entityId: adjustment.id,
      action: 'CREATE',
      newValue: adjustment,
      comment: adjustment.justification,
      userId: adjustment.createdBy,
    }));
  };

  const handleSubmitAdjustment = (adjustment: FinancialAdjustment) => {
    const submitted = { ...adjustment, status: 'IN_REVIEW' as const };
    updateAdjustment(submitted);
    setAuditEvents((current) => appendAuditEvent(current, {
      entityType: 'ADJUSTMENT',
      entityId: adjustment.id,
      action: 'UPDATE',
      previousValue: adjustment.status,
      newValue: submitted.status,
      comment: 'Ajuste enviado a revisión.',
      userId: 'analyst@senda.local',
    }));
  };

  const handleApproveAdjustment = (adjustment: FinancialAdjustment) => {
    const result = approveAdjustment(adjustment);
    updateAdjustment(result.adjustment);
    setAuditEvents((current) => [result.auditEvent, ...current]);
  };

  const handleRejectAdjustment = (adjustment: FinancialAdjustment) => {
    const result = rejectAdjustment(adjustment);
    updateAdjustment(result.adjustment);
    setAuditEvents((current) => [result.auditEvent, ...current]);
  };

  const handleApproveScenario = () => {
    const result = approveScenario(activeScenario);
    setScenarios((current) =>
      current.map((scenario) => scenario.id === activeScenario.id ? result.scenario : scenario),
    );
    setAuditEvents((current) => [result.auditEvent, ...current]);
  };

  const handlePublishPlan = () => {
    const result = publishPlan(activeScenario);
    setScenarios((current) =>
      current.map((scenario) => scenario.id === activeScenario.id ? result.scenario : scenario),
    );
    setAuditEvents((current) => [result.auditEvent, ...current]);
  };

  const handleCreateScenario = () => {
    const now = new Date().toISOString();
    const scenario: FinancialScenario = {
      id: `custom-${Date.now()}`,
      name: `Escenario personalizado ${scenarios.filter((item) => item.kind === 'CUSTOM').length + 1}`,
      kind: 'CUSTOM',
      adjustmentIds: [],
      status: 'DRAFT',
      createdBy: 'analyst@senda.local',
      createdAt: now,
      updatedAt: now,
    };
    setScenarios((current) => [...current, scenario]);
    setActiveScenarioId(scenario.id);
  };

  const handleSplitMovement = (movement: FinancialMovement) => {
    handleSaveAdjustment(splitAdjustmentForMovement(movement, activeScenario.id));
  };

  const handleRevertMovement = (movement: FinancialMovement) => {
    setAdjustments((current) =>
      current.filter((adjustment) =>
        !(adjustment.scenarioIds.includes(activeScenario.id)
          && adjustment.targetType === 'MOVEMENT'
          && (adjustment.targetExpression === movement.id
            || adjustment.targetExpression === movement.sourceObjectId)),
      ),
    );
    setAuditEvents((current) => appendAuditEvent(current, {
      entityType: 'MOVEMENT',
      entityId: movement.id,
      action: 'UPDATE',
      comment: 'Overrides del movimiento removidos para restaurar base.',
      userId: 'analyst@senda.local',
    }));
  };

  if (!source.hasData) {
    return (
      <div className="space-y-5">
        <PageHeader title="Planeación Financiera" />
        <EmptyDataState />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Planeación Financiera"
        actions={
          <button
            onClick={handleCreateScenario}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-[var(--primary)] px-3 text-[13px] font-medium text-white hover:bg-[var(--primary-hover)]"
          >
            <Plus className="h-4 w-4" strokeWidth={1.5} />
            Nuevo escenario
          </button>
        }
      />

      <p className="text-[12px] text-[var(--gray-500)] -mt-3 max-w-[820px]">
        Decide qué hacer sobre la proyección. Crea escenarios, ajusta movimientos y aprueba el plan oficial sin sobrescribir el base.
      </p>

      {/* KPIs del escenario activo. Antes eran chips blancos translúcidos
          en el header — ahora se rinden con KpiCard real y son leibles. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <KpiCard
          label="Caja final escenario"
          value={fmtCurrency(activeProjection.summary.finalCash)}
          color="var(--gray-950)"
          sublabel={`${activeScenario.name} · ${activeProjection.granularity}`}
        />
        <KpiCard
          label="Días en déficit"
          value={String(activeProjection.summary.deficitDays)}
          color={activeProjection.summary.deficitDays > 0 ? 'var(--danger)' : 'var(--success)'}
          sublabel={
            activeProjection.summary.maxRiskDate
              ? `Mayor riesgo: ${activeProjection.summary.maxRiskDate}`
              : 'Sin fecha crítica'
          }
        />
        <KpiCard
          label="Crédito requerido"
          value={fmtCurrency(activeProjection.summary.creditRequired)}
          color={activeProjection.summary.creditRequired > 0 ? 'var(--warning)' : 'var(--gray-950)'}
          sublabel={`Mínimo ${fmtCurrency(activeProjection.summary.minimumCashRequired)}`}
        />
      </div>

      <ScenarioSelector
        scenarios={scenarios}
        activeScenarioId={activeScenario.id}
        comparisons={comparisons}
        onSelect={setActiveScenarioId}
        onCreate={handleCreateScenario}
      />

      <div className="grid gap-4 xl:grid-cols-[1.4fr_0.9fr]">
        <CashFlowChart projection={activeProjection} baseProjection={baseProjection} />
        <ApprovalWorkflowPanel
          scenario={activeScenario}
          onApproveScenario={handleApproveScenario}
          onPublishPlan={handlePublishPlan}
        />
      </div>

      <ScenarioComparison comparisons={comparisons} />

      <div className="grid gap-4 xl:grid-cols-[0.95fr_1.35fr]">
        <AdjustmentLibrary
          adjustments={adjustments}
          activeScenarioId={activeScenario.id}
          onSubmit={handleSubmitAdjustment}
          onApprove={handleApproveAdjustment}
          onReject={handleRejectAdjustment}
        />
        <AuditTrailPanel events={auditEvents} />
      </div>

      <EditablePlanningGrid
        movements={activeMovements}
        activeScenarioId={activeScenario.id}
        onAdjust={setEditorMovement}
        onSplit={handleSplitMovement}
        onRevertMovement={handleRevertMovement}
      />

      {/* Solo Impuestos vive aquí — los otros dos paneles (clientes y
          proveedores) están en Proyección. Antes los tres se duplicaban
          en ambos módulos sin ganar nada. */}
      <TaxPlanningPanel taxes={source.taxes} />

      <AdjustmentEditorModal
        movement={editorMovement}
        scenarios={scenarios}
        defaultScenarioId={activeScenario.id}
        onClose={() => setEditorMovement(null)}
        onSave={handleSaveAdjustment}
      />
    </div>
  );

  function updateAdjustment(adjustment: FinancialAdjustment) {
    setAdjustments((current) => current.map((item) =>
      item.id === adjustment.id ? adjustment : item,
    ));
  }
}

function minimumCashFor(props: Props): number {
  const fallback = 20_000_000;
  if (!props.budget) return fallback;
  const month = new Date().getUTCMonth();
  const monthlyExpense = props.budget.expenseTotal?.[month] ?? 0;
  return monthlyExpense > 0 ? Math.round(monthlyExpense * 0.3) : fallback;
}

function EmptyDataState() {
  return (
    <div className="rounded-2xl border border-[var(--gray-200)] bg-white p-10 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--warning-muted)]">
        <AlertTriangle className="h-5 w-5" style={{ color: 'var(--warning)' }} strokeWidth={1.5} />
      </div>
      <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">
        Aún no hay datos suficientes para planear
      </h2>
      <p className="mx-auto mt-2 max-w-[480px] text-[12px] leading-relaxed text-[var(--gray-500)]">
        Necesitamos la trayectoria base del Dashboard para que los escenarios y ajustes tengan sentido.
        Carga estados de cuenta en <strong>Bancos</strong> y configura el <strong>presupuesto</strong>{' '}
        en Operativa para empezar.
      </p>
    </div>
  );
}
