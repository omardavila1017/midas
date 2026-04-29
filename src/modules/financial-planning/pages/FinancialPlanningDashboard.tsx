import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Eye, Plus, Pencil, Wallet, AlertTriangle as AlertIcon, Banknote, ShieldCheck, Trash2, Search, Lock } from 'lucide-react';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import { fmtCompact, fmtCurrency } from '../../../formatters';
import {
  applyAdjustmentsToMovements,
  calculateBaseProjection,
  compareProjectionVsScenario,
  effectiveAmount,
  effectiveMovementDate,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import { ConfidenceBadge } from '../../shared-finance/components/FinanceBadges';
import type {
  FinancialAdjustment,
  FinancialMovement,
  FinancialScenario,
  ManualPlanningCategory,
  ManualPlanningEntry,
  ManualPlanningRecurrence,
} from '../../shared-finance/types';
import { createAuditEvent } from '../../shared-finance/audit/audit';
import { MovementDrillDownDrawer } from '../../financial-projection/components/MovementDrillDownDrawer';
import { CashTrajectoryChart } from '../components/CashTrajectoryChart';
import { MonthlyCashTable } from '../components/MonthlyCashTable';
import {
  buildFinancialProjectionSourceData,
  calculateInitialCash,
} from '../../financial-projection/services/financialProjectionService';
import {
  buildApprovedTaxPaymentMovements,
  defaultTaxStore,
  loadTaxStore,
} from '../../taxes/services/taxModuleService';
import { AdjustmentEditorPopover } from '../components/AdjustmentEditorPopover';
import {
  countManualEntryOccurrences,
  createManualPlanningEntry,
  expandManualPlanningEntriesToMovements,
  loadManualPlanningEntries,
  MANUAL_PLANNING_CATEGORY_LABELS,
  MANUAL_PLANNING_RECURRENCE_LABELS,
  saveManualPlanningEntries,
} from '../services/manualPlanningEntries';
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
 * Planeación Financiera — vista única, sin paneles laterales.
 *
 * Layout consolidado:
 *   1. Page header (título + nuevo escenario)
 *   2. Selector de escenarios horizontal (chips) — Base + los de Simulación
 *   3. 3 KPIs del escenario activo
 *   4. Chart hero comparando escenario vs base
 *   5. Tabla de movimientos con acción "Editar" anclada al row
 *   6. Popover de edición anclado al click
 *
 * Diferencias clave respecto a la versión previa:
 *   - Sin ApprovalWorkflowPanel, AdjustmentLibrary, AuditTrailPanel,
 *     TaxPlanningPanel ni paneles laterales — eran ruido para el flujo.
 *   - El selector de escenarios es chips horizontales, no card aparte.
 *   - Solo computa la proyección del escenario activo.
 */
export default function FinancialPlanningDashboard(props: Props) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const yearEnd = useMemo(() => `${Number(today.slice(0, 4))}-12-31`, [today]);

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

  const [storedScenarios, setStoredScenarios] = useState<FinancialScenario[]>(() => loadPlanningScenarios([]));
  const [storedAdjustments, setStoredAdjustments] = useState<FinancialAdjustment[]>(() => loadPlanningAdjustments([]));
  const [manualEntries, setManualEntries] = useState<ManualPlanningEntry[]>(() => loadManualPlanningEntries([]));
  const [taxStore] = useState(() => loadTaxStore(defaultTaxStore()));
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    savePlanningScenarios(storedScenarios);
  }, [storedScenarios]);
  useEffect(() => {
    savePlanningAdjustments(storedAdjustments);
  }, [storedAdjustments]);
  useEffect(() => {
    saveManualPlanningEntries(manualEntries);
  }, [manualEntries]);

  const sourceBaseScenario = useMemo(
    () => source.scenarios.find((s) => s.isBase) ?? source.scenarios[0],
    [source.scenarios],
  );
  const storedBaseScenario = storedScenarios.find((s) => s.isBase && !s.archivedAt);
  const baseScenario: FinancialScenario = storedBaseScenario ?? sourceBaseScenario;
  const archivedBaseScenarios = useMemo(
    () => storedScenarios.filter((scenario) => scenario.archivedAt),
    [storedScenarios],
  );
  const userScenarios = useMemo(
    () => storedScenarios.filter((scenario) => !scenario.isBase && !scenario.archivedAt),
    [storedScenarios],
  );
  const scenarios = useMemo(
    () => [baseScenario, ...userScenarios, ...archivedBaseScenarios],
    [archivedBaseScenarios, baseScenario, userScenarios],
  );

  const initialActiveId = useMemo(
    () => userScenarios[0]?.id ?? baseScenario.id,
    [baseScenario.id, userScenarios],
  );

  const [activeScenarioId, setActiveScenarioId] = useState(initialActiveId);
  const [editorMovement, setEditorMovement] = useState<FinancialMovement | null>(null);
  const [editorAnchor, setEditorAnchor] = useState<DOMRect | null>(null);
  const [detailMovement, setDetailMovement] = useState<FinancialMovement | null>(null);
  const [detailAnchor, setDetailAnchor] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!scenarios.some((s) => s.id === activeScenarioId)) {
      setActiveScenarioId(scenarios.find((s) => !s.isBase)?.id ?? scenarios[0]?.id ?? activeScenarioId);
    }
  }, [activeScenarioId, scenarios]);

  const activeScenario = scenarios.find((s) => s.id === activeScenarioId) ?? baseScenario;

  const baseSeedMovements = useMemo(() => {
    const baseManualMovements = expandManualPlanningEntriesToMovements(manualEntries, {
      scenarioId: baseScenario.id,
      startDate: today,
      endDate: yearEnd,
      asOfDate: today,
    });
    const baseTaxMovements = buildApprovedTaxPaymentMovements({
      obligations: taxStore.obligations,
      scenarioId: baseScenario.id,
      startDate: today,
      endDate: yearEnd,
      asOfDate: today,
    });
    return applyAdjustmentsToMovements(
      [...source.movements, ...baseManualMovements, ...baseTaxMovements],
      storedAdjustments,
      baseScenario.id,
    );
  }, [baseScenario.id, manualEntries, source.movements, storedAdjustments, taxStore.obligations, today, yearEnd]);

  const baseProjection = useMemo(
    () => calculateBaseProjection(baseSeedMovements, {
      startDate: today,
      endDate: yearEnd,
      initialCash: calculateInitialCash(props.bankStatements, props.startingBalance),
      minimumCash: minimumCashFor(props),
      granularity: 'monthly',
      scenarioId: baseScenario.id,
      name: baseScenario.name,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      baseScenario.id,
      baseScenario.name,
      props.bankStatements,
      props.budget,
      props.startingBalance,
      baseSeedMovements,
      today,
      yearEnd,
    ],
  );

  const activeAdjustments = useMemo<FinancialAdjustment[]>(
    () => storedAdjustments.filter((adjustment) => adjustment.scenarioIds.includes(activeScenario.id)),
    [activeScenario.id, storedAdjustments],
  );

  const activeManualMovements = useMemo(
    () => expandManualPlanningEntriesToMovements(manualEntries, {
      scenarioId: activeScenario.id,
      startDate: today,
      endDate: yearEnd,
      asOfDate: today,
    }),
    [activeScenario.id, manualEntries, today, yearEnd],
  );

  const activeProjection = useMemo(() => {
    const activeTaxMovements = buildApprovedTaxPaymentMovements({
      obligations: taxStore.obligations,
      scenarioId: activeScenario.id,
      startDate: today,
      endDate: yearEnd,
      asOfDate: today,
    });
    if (activeScenario.isBase) return baseProjection;
    if (activeScenario.archivedAt) {
      const archivedMovements = applyAdjustmentsToMovements(
        [...source.movements, ...activeManualMovements, ...activeTaxMovements],
        activeAdjustments,
        activeScenario.id,
      );
      return calculateBaseProjection(archivedMovements, {
        startDate: today,
        endDate: yearEnd,
        initialCash: calculateInitialCash(props.bankStatements, props.startingBalance),
        minimumCash: minimumCashFor(props),
        granularity: baseProjection.granularity,
        scenarioId: activeScenario.id,
        name: activeScenario.name,
      });
    }
    const adjustedMovements = applyAdjustmentsToMovements(
      [...baseProjection.movements, ...activeManualMovements, ...activeTaxMovements],
      activeAdjustments,
      activeScenario.id,
    );
    return calculateBaseProjection(adjustedMovements, {
      startDate: baseProjection.startDate,
      endDate: baseProjection.endDate,
      initialCash: baseProjection.buckets[0]?.openingCash ?? baseProjection.summary.currentCash,
      minimumCash: baseProjection.summary.minimumCashRequired,
      granularity: baseProjection.granularity,
      scenarioId: activeScenario.id,
      name: activeScenario.name,
    });
  }, [
    activeAdjustments,
    activeManualMovements,
    activeScenario,
    baseProjection,
    props.bankStatements,
    props.budget,
    props.startingBalance,
    source.movements,
    taxStore.obligations,
    today,
    yearEnd,
  ]);

  const comparison = useMemo(() => {
    if (activeScenario.id === baseProjection.scenarioId) return null;
    return compareProjectionVsScenario(baseProjection, activeProjection);
  }, [activeProjection, activeScenario.id, baseProjection]);

  const activeMovements = useMemo(
    () => activeProjection.movements
      .filter((movement) => movement.status !== 'REAL')
      .sort((a, b) =>
        (a.adjustedDate ?? a.projectedDate).localeCompare(b.adjustedDate ?? b.projectedDate),
      )
      .slice(0, 200),
    [activeProjection.movements],
  );

  const handleCreateScenario = () => {
    const now = new Date().toISOString();
    const id = `scn-${Date.now().toString(36)}`;
    const next: FinancialScenario = {
      ...baseScenario,
      id,
      name: `Escenario ${userScenarios.length + 1}`,
      kind: 'CUSTOM',
      description: 'Creado desde Planeación Financiera.',
      isBase: false,
      status: 'DRAFT',
      adjustmentIds: [],
      archivedAt: undefined,
      promotedFromScenarioId: undefined,
      promotedAt: undefined,
      createdAt: now,
      updatedAt: now,
    };
    setStoredScenarios((current) => [...current, next]);
    setActiveScenarioId(id);
  };

  const handleAdjustClick = (movement: FinancialMovement, anchor: DOMRect) => {
    setEditorMovement(movement);
    setEditorAnchor(anchor);
  };

  const handleSaveAdjustment = (adjustment: FinancialAdjustment) => {
    setStoredAdjustments((current) => [...current, adjustment]);
    setStatusMessage(`Ajuste guardado en ${activeScenario.name}.`);
    setEditorMovement(null);
    setEditorAnchor(null);
  };

  const handleAddManualEntry = (entry: ManualPlanningEntry) => {
    setManualEntries((current) => [...current, entry]);
    setStatusMessage(`Alta manual guardada: ${entry.name}.`);
  };

  const handleRemoveManualEntry = (id: string) => {
    setManualEntries((current) => current.filter((entry) => entry.id !== id));
  };

  const handlePromoteActiveScenarioToBase = () => {
    if (activeScenario.isBase) return;
    const now = new Date().toISOString();
    const archivedBaseId = `archived-base-${Date.now()}`;
    const archivedBase: FinancialScenario = {
      ...baseScenario,
      id: archivedBaseId,
      name: `Base anterior · ${today}`,
      isBase: false,
      status: 'PUBLISHED',
      archivedAt: now,
      updatedAt: now,
    };
    const newBase: FinancialScenario = {
      ...baseScenario,
      id: 'base',
      name: 'Escenario Base',
      description: `Promovido desde ${activeScenario.name}.`,
      isBase: true,
      status: 'PUBLISHED',
      promotedFromScenarioId: activeScenario.id,
      promotedAt: now,
      updatedAt: now,
    };

    setStoredScenarios((current) => [
      newBase,
      archivedBase,
      ...current.filter((scenario) => scenario.id !== 'base' && !scenario.isBase),
    ]);
    setManualEntries((current) => {
      const reassignedBase = current.map((entry) => (
        entry.scenarioIds.includes(baseScenario.id)
          ? {
            ...entry,
            scenarioIds: entry.scenarioIds.map((id) => (id === baseScenario.id ? archivedBaseId : id)),
            updatedAt: now,
          }
          : entry
      ));
      const promoted = current
        .filter((entry) => entry.scenarioIds.includes(activeScenario.id))
        .map((entry) => ({
          ...entry,
          id: `${entry.id}:base:${Date.now()}`,
          scenarioIds: ['base'],
          description: [entry.description, `Promovido desde ${activeScenario.name}`].filter(Boolean).join(' · '),
          updatedAt: now,
        }));
      return [...reassignedBase, ...promoted];
    });
    setStoredAdjustments((current) => {
      const reassignedBase = current.map((adjustment) => (
        adjustment.scenarioIds.includes(baseScenario.id)
          ? {
            ...adjustment,
            scenarioIds: adjustment.scenarioIds.map((id) => (id === baseScenario.id ? archivedBaseId : id)),
          }
          : adjustment
      ));
      const promoted = activeAdjustments.map((adjustment, index) => ({
        ...adjustment,
        id: `${adjustment.id}:base:${Date.now()}:${index}`,
        scenarioIds: ['base'],
        status: adjustment.status === 'REJECTED' ? 'DRAFT' : adjustment.status,
        justification: `${adjustment.justification} · Promovido desde ${activeScenario.name}.`,
      }));
      return [...reassignedBase, ...promoted];
    });
    const audit = createAuditEvent({
      entityType: 'SCENARIO',
      entityId: activeScenario.id,
      action: 'PUBLISH',
      previousValue: baseScenario.id,
      newValue: 'base',
      comment: `Escenario promovido como nuevo base. Base anterior archivada como ${archivedBaseId}.`,
      userId: 'cfo@senda.local',
    });
    savePlanningAudit([audit, ...loadPlanningAudit([])]);
    setActiveScenarioId('base');
    setStatusMessage(`${activeScenario.name} ahora es el Escenario Base.`);
  };

  const handleViewDetail = (movement: FinancialMovement, anchor: DOMRect) => {
    setDetailMovement(movement);
    setDetailAnchor(anchor);
  };

  if (!source.hasData) {
    return (
      <div className="space-y-5">
        <PageHeader title="Planeación Financiera" />
        <EmptyDataState />
      </div>
    );
  }

  const summary = activeProjection.summary;

  return (
    <div className="space-y-5 animate-page-in">
      <PageHeader
        title="Planeación Financiera"
        actions={
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handlePromoteActiveScenarioToBase}
              disabled={activeScenario.isBase || Boolean(activeScenario.archivedAt)}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[13px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ShieldCheck className="h-4 w-4" strokeWidth={1.5} />
              Hacer base vigente
            </button>
            <button
              onClick={handleCreateScenario}
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-[var(--primary)] px-3 text-[13px] font-medium text-white hover:bg-[var(--primary-hover)] disabled:opacity-40 transition-colors"
            >
              <Plus className="h-4 w-4" strokeWidth={1.5} />
              Nuevo escenario
            </button>
          </div>
        }
      />

      {statusMessage && (
        <div className="rounded-xl border border-[var(--gray-200)] bg-white px-4 py-2 text-[12px] font-medium text-[var(--gray-700)]">
          {statusMessage}
        </div>
      )}

      {/* Selector de escenarios como chips horizontales — antes era un
          card aparte con grid de 3 columnas; ahora se lee como un control
          compacto al estilo "tabs". */}
      <ScenarioChips
        scenarios={scenarios}
        baseFinalCash={baseProjection.summary.finalCash}
        activeScenarioId={activeScenario.id}
        onSelect={setActiveScenarioId}
        previewProjection={activeProjection}
        baseProjection={baseProjection}
      />

      {/* 3 KPIs críticos — alineados al patrón del Dashboard. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <KpiCard
          label="Caja final del escenario"
          value={fmtCurrency(summary.finalCash)}
          icon={<Wallet className="w-4 h-4" />}
          color="var(--gray-950)"
          sublabel={comparison
            ? `${formatDelta(comparison.finalCashDelta)} vs base`
            : 'Igual al base'}
        />
        <KpiCard
          label="Días en déficit"
          value={String(summary.deficitDays)}
          icon={<AlertIcon className="w-4 h-4" />}
          color={summary.deficitDays > 0 ? 'var(--danger)' : 'var(--success)'}
          sublabel={summary.maxRiskDate ? `Mayor riesgo: ${summary.maxRiskDate}` : 'Sin fecha crítica'}
        />
        <KpiCard
          label="Crédito requerido"
          value={fmtCurrency(summary.creditRequired)}
          icon={<Banknote className="w-4 h-4" />}
          color={summary.creditRequired > 0 ? 'var(--warning)' : 'var(--gray-950)'}
          sublabel={`Mínimo ${fmtCompact(summary.minimumCashRequired)}`}
        />
      </div>

      {/* Chart hero — trayectoria mensual rescatada del módulo de Simulación.
          Cuando el escenario activo no es base, mostramos la línea base
          punteada para ver el delta de un vistazo. */}
      <CashTrajectoryChart
        projection={activeProjection}
        baseProjection={activeScenario.isBase ? undefined : baseProjection}
      />

      {/* Detalle mensual — tabla rescatada de Simulación, alimentada con la
          misma proyección que el chart. Da los números exactos por mes. */}
      <MonthlyCashTable
        projection={activeProjection}
        baseProjection={activeScenario.isBase ? undefined : baseProjection}
        scenarioName={activeScenario.name}
      />

      <ManualPlanningEntriesPanel
        scenarios={scenarios.filter((scenario) => !scenario.archivedAt)}
        activeScenario={activeScenario}
        entries={manualEntries}
        horizonEnd={yearEnd}
        onAdd={handleAddManualEntry}
        onRemove={handleRemoveManualEntry}
      />

      {/* Tabla de movimientos del escenario activo. Filtros + agrupación por
          mes. Cada movimiento se puede editar (crea un ajuste) o abrir en
          detalle (factura/origen). */}
      <PlanningMovementsSection
        movements={activeMovements}
        scenarioName={activeScenario.name}
        onAdjust={handleAdjustClick}
        onViewDetail={handleViewDetail}
      />

      <AdjustmentEditorPopover
        movement={editorMovement}
        anchor={editorAnchor}
        scenarios={scenarios}
        defaultScenarioId={activeScenario.id}
        onClose={() => { setEditorMovement(null); setEditorAnchor(null); }}
        onSave={handleSaveAdjustment}
      />

      <MovementDrillDownDrawer
        movement={detailMovement}
        anchor={detailAnchor}
        onClose={() => { setDetailMovement(null); setDetailAnchor(null); }}
        invoiceContext={{
          cxpRecords: props.cxpRecords,
          clients: props.clients,
          assumptions: props.assumptions,
          budget: props.budget,
        }}
      />
    </div>
  );
}

/**
 * Chips horizontales para los escenarios. Cada chip muestra nombre +
 * caja final + delta vs base. El chip activo tiene fondo gris-950 y
 * texto blanco, igual que el segmented control de la página de
 * Proyección — coherencia visual entre módulos.
 */
function ScenarioChips({
  scenarios,
  baseFinalCash,
  activeScenarioId,
  onSelect,
  previewProjection,
  baseProjection,
}: {
  scenarios: FinancialScenario[];
  baseFinalCash: number;
  activeScenarioId: string;
  onSelect: (id: string) => void;
  previewProjection: { scenarioId: string; summary: { finalCash: number } };
  baseProjection: { scenarioId: string };
}) {
  return (
    <section className="rounded-2xl border border-[var(--gray-200)] bg-white px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">
          Escenarios
        </span>
        <div className="flex flex-wrap gap-1.5">
          {scenarios.map((scenario) => {
            const active = scenario.id === activeScenarioId;
            const isPreview = previewProjection.scenarioId === scenario.id;
            const finalCash = isPreview ? previewProjection.summary.finalCash : baseFinalCash;
            const delta = scenario.isBase ? 0 : finalCash - baseFinalCash;
            return (
              <button
                key={scenario.id}
                onClick={() => onSelect(scenario.id)}
                aria-pressed={active}
                className="inline-flex items-center gap-2 rounded-xl border px-3 h-9 text-[12px] font-medium transition-colors"
                style={{
                  background: active ? 'var(--gray-950)' : 'white',
                  color: active ? 'white' : 'var(--gray-700)',
                  borderColor: active ? 'var(--gray-950)' : 'var(--gray-200)',
                }}
                title={scenario.description ?? scenario.name}
              >
                <span className="truncate max-w-[180px]">{scenario.name}</span>
                {!scenario.isBase && (
                  <span
                    className="tabular-nums text-[11px] font-semibold"
                    style={{
                      color: active
                        ? 'rgba(255,255,255,0.85)'
                        : delta > 0 ? 'var(--success)' : delta < 0 ? 'var(--danger)' : 'var(--gray-400)',
                    }}
                  >
                    {scenario.id === baseProjection.scenarioId
                      ? '—'
                      : delta === 0 ? '±0' : `${delta > 0 ? '+' : ''}${fmtCompact(delta)}`}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ManualPlanningEntriesPanel({
  scenarios,
  activeScenario,
  entries,
  horizonEnd,
  onAdd,
  onRemove,
}: {
  scenarios: FinancialScenario[];
  activeScenario: FinancialScenario;
  entries: ManualPlanningEntry[];
  horizonEnd: string;
  onAdd: (entry: ManualPlanningEntry) => void;
  onRemove: (id: string) => void;
}) {
  const editableScenarios = useMemo(
    () => scenarios.filter((scenario) => !scenario.isBase && !scenario.archivedAt),
    [scenarios],
  );
  const defaultScenarioId = activeScenario.isBase
    ? editableScenarios[0]?.id ?? ''
    : activeScenario.id;
  const [scenarioId, setScenarioId] = useState(defaultScenarioId);
  const [type, setType] = useState<ManualPlanningEntry['type']>('INFLOW');
  const [category, setCategory] = useState<ManualPlanningCategory>('MANUAL_INFLOW');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState('');
  const [recurrence, setRecurrence] = useState<ManualPlanningRecurrence>('ONE_TIME');
  const [counterpartyName, setCounterpartyName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<ManualPlanningEntry['status']>('APPROVED');
  const [taxTreatment, setTaxTreatment] = useState<ManualPlanningEntry['taxTreatment']>('UNCLASSIFIED');
  const [taxRate, setTaxRate] = useState<ManualPlanningEntry['taxRate'] | ''>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const next = activeScenario.isBase ? editableScenarios[0]?.id ?? '' : activeScenario.id;
    setScenarioId((current) => (editableScenarios.some((scenario) => scenario.id === current) ? current : next));
  }, [activeScenario.id, activeScenario.isBase, editableScenarios]);

  const scenarioEntries = useMemo(
    () => entries.filter((entry) => entry.scenarioIds.includes(activeScenario.id)),
    [activeScenario.id, entries],
  );
  const parsedAmount = Number(amount);
  const occurrenceCount = countManualEntryOccurrences({
    startDate,
    endDate: endDate || undefined,
    recurrence,
  }, horizonEnd);
  const previewTotal = Number.isFinite(parsedAmount) && parsedAmount > 0
    ? parsedAmount * Math.max(1, occurrenceCount)
    : 0;
  const canAdd = Boolean(scenarioId) && name.trim() && Number.isFinite(parsedAmount) && parsedAmount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(startDate);

  const handleAdd = () => {
    try {
      const entry = createManualPlanningEntry({
        scenarioIds: [scenarioId],
        type,
        category,
        name,
        amount: parsedAmount,
        startDate,
        endDate: endDate || undefined,
        recurrence,
        counterpartyName,
        description,
        status,
        taxTreatment,
        taxRate: taxRate === '' ? undefined : taxRate,
      });
      onAdd(entry);
      setName('');
      setAmount('');
      setCounterpartyName('');
      setDescription('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear el alta manual.');
    }
  };

  return (
    <section className="rounded-2xl border border-[var(--gray-200)] bg-white">
      <div className="flex flex-col gap-3 border-b border-[var(--gray-200)] px-4 py-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight text-[var(--gray-950)]">Altas manuales</h2>
          <p className="mt-0.5 text-[12px] text-[var(--gray-400)]">
            Ingresos sin factura y pagos manuales por escenario. La base se conserva hasta promover un escenario.
          </p>
        </div>
        <div className="text-right text-[12px] text-[var(--gray-500)]">
          <div className="font-semibold tabular-nums text-[var(--gray-950)]">{fmtCurrency(previewTotal)}</div>
          <div>{Math.max(1, occurrenceCount)} ocurrencia{occurrenceCount === 1 ? '' : 's'} previstas</div>
        </div>
      </div>

      <div className="grid gap-3 border-b border-[var(--gray-200)] px-4 py-3 lg:grid-cols-[170px_120px_160px_minmax(160px,1fr)_140px_140px_140px]">
        <PlanningField label="Escenario">
          <select
            value={scenarioId}
            onChange={(event) => setScenarioId(event.target.value)}
            disabled={editableScenarios.length === 0}
            className={planningInputClass}
          >
            {editableScenarios.length === 0 && <option value="">Crea un escenario</option>}
            {editableScenarios.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>{scenario.name}</option>
            ))}
          </select>
        </PlanningField>
        <PlanningField label="Tipo">
          <select
            value={type}
            onChange={(event) => {
              const next = event.target.value as ManualPlanningEntry['type'];
              setType(next);
              setCategory(next === 'INFLOW' ? 'MANUAL_INFLOW' : 'MANUAL_OUTFLOW');
            }}
            className={planningInputClass}
          >
            <option value="INFLOW">Ingreso</option>
            <option value="OUTFLOW">Pago</option>
          </select>
        </PlanningField>
        <PlanningField label="Categoría">
          <select value={category} onChange={(event) => setCategory(event.target.value as ManualPlanningCategory)} className={planningInputClass}>
            {(Object.keys(MANUAL_PLANNING_CATEGORY_LABELS) as ManualPlanningCategory[]).map((value) => (
              <option key={value} value={value}>{MANUAL_PLANNING_CATEGORY_LABELS[value]}</option>
            ))}
          </select>
        </PlanningField>
        <PlanningField label="Nombre">
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Viaje especial, pago proveedor..." className={planningInputClass} />
        </PlanningField>
        <PlanningField label="Monto">
          <input value={amount} onChange={(event) => setAmount(event.target.value)} type="number" min="0" step="0.01" className={`${planningInputClass} text-right tabular-nums`} />
        </PlanningField>
        <PlanningField label="Inicio">
          <input value={startDate} onChange={(event) => setStartDate(event.target.value)} type="date" className={planningInputClass} />
        </PlanningField>
        <PlanningField label="Recurrencia">
          <select value={recurrence} onChange={(event) => setRecurrence(event.target.value as ManualPlanningRecurrence)} className={planningInputClass}>
            {(Object.keys(MANUAL_PLANNING_RECURRENCE_LABELS) as ManualPlanningRecurrence[]).map((value) => (
              <option key={value} value={value}>{MANUAL_PLANNING_RECURRENCE_LABELS[value]}</option>
            ))}
          </select>
        </PlanningField>
      </div>

      <div className="grid gap-3 border-b border-[var(--gray-200)] px-4 py-3 lg:grid-cols-[150px_150px_110px_minmax(150px,1fr)_minmax(170px,1fr)_120px_auto]">
        <PlanningField label="Fin">
          <input value={endDate} onChange={(event) => setEndDate(event.target.value)} type="date" className={planningInputClass} />
        </PlanningField>
        <PlanningField label="IVA">
          <select value={taxTreatment} onChange={(event) => setTaxTreatment(event.target.value as ManualPlanningEntry['taxTreatment'])} className={planningInputClass}>
            <option value="UNCLASSIFIED">Sin clasificar</option>
            <option value="IVA_CAUSED">Causa IVA</option>
            <option value="IVA_CREDITABLE">Acredita IVA</option>
            <option value="IVA_EXEMPT">Sin IVA</option>
          </select>
        </PlanningField>
        <PlanningField label="Tasa">
          <select
            value={taxRate}
            onChange={(event) => {
              const value = event.target.value;
              setTaxRate(value === '' ? '' : Number(value) as ManualPlanningEntry['taxRate']);
            }}
            className={planningInputClass}
          >
            <option value="">N/A</option>
            <option value="16">16%</option>
            <option value="8">8%</option>
            <option value="0">0%</option>
          </select>
        </PlanningField>
        <PlanningField label="Contraparte">
          <input value={counterpartyName} onChange={(event) => setCounterpartyName(event.target.value)} placeholder="Cliente, proveedor o autoridad" className={planningInputClass} />
        </PlanningField>
        <PlanningField label="Descripción">
          <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Motivo o evidencia" className={planningInputClass} />
        </PlanningField>
        <PlanningField label="Estado">
          <select value={status} onChange={(event) => setStatus(event.target.value as ManualPlanningEntry['status'])} className={planningInputClass}>
            <option value="APPROVED">Aprobado</option>
            <option value="DRAFT">Borrador</option>
          </select>
        </PlanningField>
        <div className="flex items-end">
          <button
            onClick={handleAdd}
            disabled={!canAdd}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-[var(--primary)] px-3 text-[13px] font-medium text-white hover:bg-[var(--primary-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus className="h-4 w-4" strokeWidth={1.5} />
            Agregar
          </button>
        </div>
        {error && <div className="lg:col-span-6 text-[12px] font-medium text-[var(--danger)]">{error}</div>}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] text-[12px]">
          <thead className="bg-[var(--gray-50)] text-left text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">
            <tr>
              <th className="px-4 py-2.5">Alta</th>
              <th className="px-4 py-2.5">Fecha / recurrencia</th>
              <th className="px-4 py-2.5">Contraparte</th>
              <th className="px-4 py-2.5 text-right">Monto</th>
              <th className="px-4 py-2.5">Estado</th>
              <th className="px-4 py-2.5 text-right">Acción</th>
            </tr>
          </thead>
          <tbody>
            {scenarioEntries.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-[12px] text-[var(--gray-400)]">
                  Sin altas manuales en {activeScenario.name}.
                </td>
              </tr>
            ) : (
              scenarioEntries.map((entry) => (
                <tr key={entry.id} className="border-t border-[var(--gray-200)]">
                  <td className="px-4 py-3">
                    <div className="font-medium text-[var(--gray-950)]">{entry.name}</div>
                    <div className="mt-0.5 text-[11px] text-[var(--gray-400)]">{MANUAL_PLANNING_CATEGORY_LABELS[entry.category]}</div>
                  </td>
                  <td className="px-4 py-3 text-[var(--gray-700)]">
                    {entry.startDate}{entry.endDate ? ` → ${entry.endDate}` : ''} · {MANUAL_PLANNING_RECURRENCE_LABELS[entry.recurrence]}
                  </td>
                  <td className="px-4 py-3 text-[var(--gray-700)]">{entry.counterpartyName ?? '—'}</td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums text-[var(--gray-950)]">{fmtCurrency(entry.amount)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium ${
                      entry.status === 'APPROVED'
                        ? 'bg-[var(--success)]/10 text-[var(--success)]'
                        : 'bg-[var(--warning-muted)] text-[var(--warning)]'
                    }`}>
                      {entry.status === 'APPROVED' ? 'Aprobado' : 'Borrador'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => onRemove(entry.id)}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--gray-200)] text-[var(--gray-500)] hover:bg-[var(--danger)]/8 hover:text-[var(--danger)]"
                      title="Eliminar alta manual"
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type MovementTypeFilter = 'ALL' | 'INFLOW' | 'OUTFLOW';
type MovementConfidenceFilter = 'ALL' | 'HIGH' | 'MEDIUM' | 'LOW';

interface MovementGroup {
  yearMonth: string;
  movements: FinancialMovement[];
  netImpact: number;
}

function groupMovementsByMonth(movements: FinancialMovement[]): MovementGroup[] {
  const map = new Map<string, MovementGroup>();
  for (const movement of movements) {
    const ym = effectiveMovementDate(movement).slice(0, 7);
    let group = map.get(ym);
    if (!group) {
      group = { yearMonth: ym, movements: [], netImpact: 0 };
      map.set(ym, group);
    }
    group.movements.push(movement);
    const delta = movement.type === 'INFLOW'
      ? effectiveAmount(movement) - movement.baseAmount
      : movement.baseAmount - effectiveAmount(movement);
    group.netImpact += delta;
  }
  return Array.from(map.values()).sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
}

function PlanningMovementsSection({
  movements,
  scenarioName,
  onAdjust,
  onViewDetail,
}: {
  movements: FinancialMovement[];
  scenarioName: string;
  onAdjust: (movement: FinancialMovement, anchor: DOMRect) => void;
  onViewDetail: (movement: FinancialMovement, anchor: DOMRect) => void;
}) {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<MovementTypeFilter>('ALL');
  const [confidenceFilter, setConfidenceFilter] = useState<MovementConfidenceFilter>('ALL');
  const [onlyAdjusted, setOnlyAdjusted] = useState(false);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return movements.filter((movement) => {
      if (typeFilter !== 'ALL' && movement.type !== typeFilter) return false;
      if (confidenceFilter !== 'ALL') {
        const band = movement.confidenceBand;
        const bucket: MovementConfidenceFilter = band === 'CONFIRMED' || band === 'HIGH'
          ? 'HIGH'
          : band === 'MEDIUM'
            ? 'MEDIUM'
            : 'LOW';
        if (bucket !== confidenceFilter) return false;
      }
      if (onlyAdjusted) {
        const adjusted = movement.adjustedAmount !== undefined
          && movement.adjustedAmount !== movement.baseAmount;
        if (!adjusted) return false;
      }
      if (needle) {
        const haystack = `${movement.concept} ${movement.counterpartyName ?? ''} ${movement.category}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [movements, typeFilter, confidenceFilter, onlyAdjusted, search]);

  const groups = useMemo(() => groupMovementsByMonth(filtered), [filtered]);

  return (
    <section className="rounded-2xl border border-[var(--gray-200)] bg-white">
      <div className="border-b border-[var(--gray-200)] px-4 py-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight text-[var(--gray-950)]">
            Movimientos del escenario
          </h2>
          <p className="mt-0.5 text-[12px] text-[var(--gray-400)]">
            Click en <strong>Editar</strong> para ajustar el monto o la fecha en <strong>{scenarioName}</strong>. El movimiento base no se modifica.
          </p>
        </div>
        <div className="text-[11px] text-[var(--gray-400)] tabular-nums">
          {filtered.length} de {movements.length} movimientos
        </div>
      </div>

      <div className="border-b border-[var(--gray-200)] px-4 py-2.5 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--gray-400)]" strokeWidth={1.5} />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar por concepto, contraparte o categoría…"
            className="h-8 w-full rounded-lg border border-[var(--gray-200)] bg-white pl-8 pr-3 text-[12px] text-[var(--gray-950)] placeholder:text-[var(--gray-400)] focus:outline-none focus:border-[var(--gray-400)]"
          />
        </div>
        <SegmentedFilter
          value={typeFilter}
          onChange={setTypeFilter}
          options={[
            { value: 'ALL', label: 'Todos' },
            { value: 'INFLOW', label: 'Ingresos' },
            { value: 'OUTFLOW', label: 'Egresos' },
          ]}
        />
        <SegmentedFilter
          value={confidenceFilter}
          onChange={setConfidenceFilter}
          options={[
            { value: 'ALL', label: 'Conf.' },
            { value: 'HIGH', label: 'Alta' },
            { value: 'MEDIUM', label: 'Media' },
            { value: 'LOW', label: 'Baja' },
          ]}
        />
        <label className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-[var(--gray-200)] text-[12px] font-medium text-[var(--gray-700)] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={onlyAdjusted}
            onChange={(event) => setOnlyAdjusted(event.target.checked)}
            className="h-3.5 w-3.5"
          />
          Solo ajustados
        </label>
      </div>

      {filtered.length === 0 ? (
        <div className="px-4 py-12 text-center text-[12px] text-[var(--gray-400)]">
          {movements.length === 0
            ? 'Sin movimientos editables para este escenario.'
            : 'Ningún movimiento coincide con los filtros activos.'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-[13px]">
            <thead className="sticky top-0 z-10 bg-[var(--gray-50)] text-left text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">
              <tr>
                <th className="px-4 py-2.5">Fecha</th>
                <th className="px-4 py-2.5">Movimiento</th>
                <th className="px-4 py-2.5 text-right">Monto base</th>
                <th className="px-4 py-2.5 text-right">Ajustado</th>
                <th className="px-4 py-2.5 text-right">Impacto</th>
                <th className="px-4 py-2.5">Confianza</th>
                <th className="px-4 py-2.5 text-right">Acción</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <MovementGroupRows
                  key={group.yearMonth}
                  group={group}
                  onAdjust={onAdjust}
                  onViewDetail={onViewDetail}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function MovementGroupRows({
  group,
  onAdjust,
  onViewDetail,
}: {
  group: MovementGroup;
  onAdjust: (movement: FinancialMovement, anchor: DOMRect) => void;
  onViewDetail: (movement: FinancialMovement, anchor: DOMRect) => void;
}) {
  const impactColor = group.netImpact > 0
    ? 'var(--success)'
    : group.netImpact < 0
      ? 'var(--danger)'
      : 'var(--gray-400)';
  return (
    <>
      <tr className="bg-[var(--gray-50)] border-t border-[var(--gray-200)]">
        <td colSpan={4} className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--gray-500)]">
          {group.yearMonth} · {group.movements.length} mov.
        </td>
        <td
          className="px-4 py-1.5 text-right text-[11px] font-semibold tabular-nums"
          style={{ color: impactColor }}
        >
          {group.netImpact === 0 ? '—' : `${group.netImpact > 0 ? '+' : ''}${fmtCompact(group.netImpact)}`}
        </td>
        <td colSpan={2} />
      </tr>
      {group.movements.map((movement) => {
        const effective = effectiveAmount(movement);
        const delta = movement.type === 'INFLOW'
          ? effective - movement.baseAmount
          : movement.baseAmount - effective;
        const editable = movement.status !== 'REAL' && movement.lockState !== 'LOCKED';
        const lockReason = movement.status === 'REAL'
          ? 'Movimiento real del banco; no editable.'
          : movement.lockState === 'LOCKED'
            ? 'Movimiento bloqueado.'
            : '';
        return (
          <tr
            key={movement.id}
            className="border-t border-[var(--gray-100)] hover:bg-[var(--gray-50)] transition-colors"
          >
            <td className="px-4 py-3 tabular-nums text-[var(--gray-700)] whitespace-nowrap">
              {effectiveMovementDate(movement)}
            </td>
            <td className="px-4 py-3 max-w-[320px]">
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-[var(--gray-950)] truncate">{movement.concept}</span>
                <MovementStatusBadge movement={movement} />
              </div>
              <div className="text-[11px] text-[var(--gray-400)] truncate">
                {movement.counterpartyName ?? movement.category}
              </div>
            </td>
            <td className="px-4 py-3 text-right tabular-nums text-[var(--gray-700)]">
              {fmtCurrency(movement.baseAmount)}
            </td>
            <td className="px-4 py-3 text-right tabular-nums text-[var(--gray-950)] font-medium">
              {fmtCurrency(effective)}
            </td>
            <td
              className="px-4 py-3 text-right font-medium tabular-nums"
              style={{ color: delta > 0 ? 'var(--success)' : delta < 0 ? 'var(--danger)' : 'var(--gray-400)' }}
            >
              {delta === 0 ? '—' : fmtCurrency(delta)}
            </td>
            <td className="px-4 py-3">
              <ConfidenceBadge band={movement.confidenceBand} />
            </td>
            <td className="px-4 py-3 text-right">
              <div className="inline-flex items-center gap-1.5">
                <button
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    onViewDetail(movement, rect);
                  }}
                  title="Ver factura / origen del movimiento"
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--gray-200)] bg-white px-2.5 text-[12px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)] transition-colors"
                >
                  <Eye className="h-3.5 w-3.5" strokeWidth={1.5} />
                  Detalle
                </button>
                <button
                  onClick={(event) => {
                    if (!editable) return;
                    const rect = event.currentTarget.getBoundingClientRect();
                    onAdjust(movement, rect);
                  }}
                  disabled={!editable}
                  title={editable ? 'Crear ajuste' : lockReason}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--gray-200)] bg-white px-2.5 text-[12px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
                  Editar
                </button>
              </div>
            </td>
          </tr>
        );
      })}
    </>
  );
}

function MovementStatusBadge({ movement }: { movement: FinancialMovement }) {
  if (movement.status === 'REAL') {
    return (
      <span
        title="Movimiento real del banco"
        className="inline-flex items-center h-4 px-1.5 rounded text-[9px] font-semibold uppercase tracking-wider bg-[var(--gray-200)] text-[var(--gray-700)]"
      >
        Real
      </span>
    );
  }
  if (movement.lockState === 'LOCKED') {
    return (
      <span
        title="Movimiento bloqueado"
        className="inline-flex items-center h-4 px-1.5 gap-0.5 rounded text-[9px] font-semibold uppercase tracking-wider bg-[var(--warning-muted)] text-[var(--warning)]"
      >
        <Lock className="h-2.5 w-2.5" strokeWidth={2} />
        Lock
      </span>
    );
  }
  return null;
}

function SegmentedFilter<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (next: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <div className="inline-flex h-8 rounded-lg border border-[var(--gray-200)] bg-[var(--gray-50)] p-0.5">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className="px-2.5 text-[11px] font-medium rounded-md transition-colors"
            style={{
              background: active ? 'white' : 'transparent',
              color: active ? 'var(--gray-950)' : 'var(--gray-500)',
              boxShadow: active ? '0 1px 2px rgba(15, 23, 42, 0.08)' : 'none',
            }}
          >
            {option.label}
          </button>
        );
      })}
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

function formatDelta(value: number): string {
  if (value === 0) return '±0';
  return `${value > 0 ? '+' : ''}${fmtCurrency(value)}`;
}

const planningInputClass = 'h-10 w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)] disabled:bg-[var(--gray-50)] disabled:text-[var(--gray-400)]';

function PlanningField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">{label}</span>
      {children}
    </label>
  );
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
        Carga estados de cuenta en <strong>Bancos</strong> y configura el presupuesto en <strong>Operativa</strong>{' '}
        para empezar.
      </p>
    </div>
  );
}
