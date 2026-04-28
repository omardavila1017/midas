import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import { fmtCompact } from '../../../formatters';
import {
  calculateBaseProjection,
  calculateScenarioProjection,
  compareScenarios,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type { AuditEvent, FinancialAdjustment, FinancialMovement, FinancialScenario } from '../../shared-finance/types';
import { appendAuditEvent } from '../../shared-finance/audit/audit';
import { CashFlowChart } from '../../financial-projection/components/CashFlowChart';
import { CustomerCollectionPanel, SupplierRiskPanel, TaxPlanningPanel } from '../../financial-projection/components/FinanceContextPanels';
import { buildFinancialProjectionSourceData, calculateInitialCash } from '../../financial-projection/services/financialProjectionService';
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

export default function FinancialPlanningDashboard(props: Props) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const source = useMemo(
    () => buildFinancialProjectionSourceData({ ...props, asOfDate: today }),
    [props, today],
  );
  const [scenarios, setScenarios] = useState<FinancialScenario[]>(() => loadPlanningScenarios(source.scenarios));
  const [adjustments, setAdjustments] = useState<FinancialAdjustment[]>(() => loadPlanningAdjustments(source.adjustments));
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>(() => loadPlanningAudit());
  const [activeScenarioId, setActiveScenarioId] = useState(() => scenarios.find((scenario) => !scenario.isBase)?.id ?? 'liquidity');
  const [editorMovement, setEditorMovement] = useState<FinancialMovement | null>(null);

  useEffect(() => { savePlanningScenarios(scenarios); }, [scenarios]);
  useEffect(() => { savePlanningAdjustments(adjustments); }, [adjustments]);
  useEffect(() => { savePlanningAudit(auditEvents); }, [auditEvents]);

  const baseScenario = scenarios.find((scenario) => scenario.isBase) ?? source.scenarios[0];
  const activeScenario = scenarios.find((scenario) => scenario.id === activeScenarioId) ?? baseScenario;

  const baseProjection = useMemo(
    () => calculateBaseProjection(source.movements, {
      startDate: today,
      endDate: shift(today, 90),
      initialCash: calculateInitialCash(props.bankStatements, props.startingBalance),
      minimumCash: 20_000_000,
      granularity: 'daily',
      scenarioId: baseScenario.id,
      name: baseScenario.name,
    }),
    [baseScenario.id, baseScenario.name, props.bankStatements, props.startingBalance, source.movements, today],
  );

  const scenarioProjections = useMemo(
    () => scenarios.map((scenario) => calculateScenarioProjection(baseProjection, scenario, adjustments)),
    [adjustments, baseProjection, scenarios],
  );
  const activeProjection = scenarioProjections.find((projection) => projection.scenarioId === activeScenario.id) ?? baseProjection;
  const comparisons = compareScenarios(baseProjection, scenarioProjections.filter((projection) => projection.scenarioId !== baseProjection.scenarioId));

  const activeMovements = useMemo(
    () => activeProjection.movements
      .filter((movement) => movement.status !== 'REAL')
      .sort((a, b) => (a.adjustedDate ?? a.projectedDate).localeCompare(b.adjustedDate ?? b.projectedDate)),
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
    setScenarios((current) => current.map((scenario) => scenario.id === activeScenario.id ? result.scenario : scenario));
    setAuditEvents((current) => [result.auditEvent, ...current]);
  };

  const handlePublishPlan = () => {
    const result = publishPlan(activeScenario);
    setScenarios((current) => current.map((scenario) => scenario.id === activeScenario.id ? result.scenario : scenario));
    setAuditEvents((current) => [result.auditEvent, ...current]);
  };

  const handleCreateScenario = () => {
    const now = new Date().toISOString();
    const scenario: FinancialScenario = {
      id: `custom-${Date.now()}`,
      name: `Escenario Personalizado ${scenarios.filter((item) => item.kind === 'CUSTOM').length + 1}`,
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
    setAdjustments((current) => current.filter((adjustment) =>
      !(adjustment.scenarioIds.includes(activeScenario.id)
        && adjustment.targetType === 'MOVEMENT'
        && (adjustment.targetExpression === movement.id || adjustment.targetExpression === movement.sourceObjectId)),
    ));
    setAuditEvents((current) => appendAuditEvent(current, {
      entityType: 'MOVEMENT',
      entityId: movement.id,
      action: 'UPDATE',
      comment: 'Overrides del movimiento removidos para restaurar base.',
      userId: 'analyst@senda.local',
    }));
  };

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.05em] text-white/70">FP&A · Planeación</div>
          <h1 className="mt-1 text-[22px] font-semibold text-white">Planeación Financiera</h1>
          <p className="mt-1 max-w-[820px] text-[13px] text-white/75">
            Decide qué hacer sobre la proyección: escenarios, ajustes, aprobaciones y plan oficial sin sobrescribir el base.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 text-right">
          <HeaderMetric label="Caja final" value={fmtCompact(activeProjection.summary.finalCash)} />
          <HeaderMetric label="Déficit" value={String(activeProjection.summary.deficitDays)} />
          <HeaderMetric label="Crédito req." value={fmtCompact(activeProjection.summary.creditRequired)} />
        </div>
      </header>

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

      <div className="grid gap-4 xl:grid-cols-3">
        <TaxPlanningPanel taxes={source.taxes} />
        <SupplierRiskPanel suppliers={source.suppliers} />
        <CustomerCollectionPanel customers={source.customers} />
      </div>

      <AdjustmentEditorModal
        movement={editorMovement}
        scenarios={scenarios}
        defaultScenarioId={activeScenario.id}
        onClose={() => setEditorMovement(null)}
        onSave={handleSaveAdjustment}
      />

      <button
        onClick={handleCreateScenario}
        className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/15 bg-white/8 px-3 text-[12px] font-medium text-white hover:bg-white/12"
      >
        <Plus className="h-4 w-4" strokeWidth={1.5} />
        Crear escenario personalizado
      </button>
    </div>
  );

  function updateAdjustment(adjustment: FinancialAdjustment) {
    setAdjustments((current) => current.map((item) => item.id === adjustment.id ? adjustment : item));
  }
}

function HeaderMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/15 bg-white/8 px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.04em] text-white/60">{label}</div>
      <div className="mt-1 text-[14px] font-semibold text-white tabular-nums">{value}</div>
    </div>
  );
}

function shift(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}
