import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, GitMerge, History, Wallet, AlertTriangle as AlertIcon, Banknote } from 'lucide-react';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import { fmtCompact, fmtCurrency } from '../../../formatters';
import {
  applyAdjustmentsToMovements,
  applyCellOverridesToBuckets,
  bucketKeyForDate,
  bucketLabel as engineBucketLabel,
  buildBucketDates,
  calculateBaseProjection,
  effectiveAmount,
  summarizeBucketsForScenario,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type {
  CellOverride,
  FinancialAdjustment,
  FinancialMovement,
  FinancialMovementCategory,
  FinancialMovementType,
  FinancialScenario,
  ManualPlanningEntry,
  PlanningCustomRow,
  ProjectionGranularity,
  ScenarioChangeLogEntry,
} from '../../shared-finance/types';
import { CashTrajectoryChart } from '../components/CashTrajectoryChart';
import { ScenarioTabs } from '../components/ScenarioTabs';
import { ChangeLogDrawer } from '../components/ChangeLogDrawer';
import { MergeDialog } from '../components/MergeDialog';
import { AddRowPopover } from '../components/AddRowPopover';
import { SpreadsheetGrid } from '../components/spreadsheet/SpreadsheetGrid';
import { BucketColumn } from '../components/spreadsheet/gridGeometry';
import { MovementDrillDownDrawer } from '../../financial-projection/components/MovementDrillDownDrawer';
import { buildFinancialProjectionSourceData, calculateInitialCash } from '../../financial-projection/services/financialProjectionService';
import { buildApprovedTaxPaymentMovements, defaultTaxStore, loadTaxStore } from '../../taxes/services/taxModuleService';
import {
  expandManualPlanningEntriesToMovements,
  loadManualPlanningEntries,
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
import { loadCellOverrides, saveCellOverrides } from '../services/cellOverridesStorage';
import { buildCustomConceptKey, loadCustomRows, saveCustomRows } from '../services/customRowsStorage';
import { loadChangeLog, saveChangeLog } from '../services/changeLogStorage';
import {
  describeAddRow,
  describeClearCell,
  describeEditCell,
  describeOverridePayload,
  newChangeLogEntry,
} from '../services/changeLogTemplates';
import { APPROVED_SCENARIO_ID, BASE_SCENARIO_ID, ensureCoreScenarios } from '../services/scenarioBootstrap';
import { conceptKeyForMovement, buildPlanningRows } from '../services/planningRowTaxonomy';
import { applyMerge, buildMergeDiff, type MergeDiffEntry } from '../services/scenarioMerge';
import { createNewDraft, duplicateDraft } from '../services/scenarioDuplicate';
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

const USER = 'tesoreria@senda.local';

export default function FinancialPlanningDashboard(props: Props) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const currentYear = useMemo(() => Number(today.slice(0, 4)), [today]);
  const yearStart = `${currentYear}-01-01`;
  const yearEnd = `${currentYear}-12-31`;

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

  const sourceBaseScenario = useMemo(
    () => source.scenarios.find((s) => s.kind === 'BASE') ?? source.scenarios[0],
    [source.scenarios],
  );

  const [storedScenarios, setStoredScenarios] = useState<FinancialScenario[]>(() => loadPlanningScenarios([]));
  const [storedAdjustments, setStoredAdjustments] = useState<FinancialAdjustment[]>(() => loadPlanningAdjustments([]));
  const [manualEntries, setManualEntries] = useState<ManualPlanningEntry[]>(() => loadManualPlanningEntries([]));
  const [customRows, setCustomRows] = useState<PlanningCustomRow[]>(() => loadCustomRows([]));
  const [cellOverrides, setCellOverrides] = useState<CellOverride[]>(() => loadCellOverrides([]));
  const [changeLog, setChangeLog] = useState<ScenarioChangeLogEntry[]>(() => loadChangeLog([]));
  const [taxStore] = useState(() => loadTaxStore(defaultTaxStore()));

  // Persistence — write through whenever state changes.
  useEffect(() => { savePlanningScenarios(storedScenarios); }, [storedScenarios]);
  useEffect(() => { savePlanningAdjustments(storedAdjustments); }, [storedAdjustments]);
  useEffect(() => { saveManualPlanningEntries(manualEntries); }, [manualEntries]);
  useEffect(() => { saveCustomRows(customRows); }, [customRows]);
  useEffect(() => { saveCellOverrides(cellOverrides); }, [cellOverrides]);
  useEffect(() => { saveChangeLog(changeLog); }, [changeLog]);

  // Bootstrap: enforce Base + Approved + clean legacy on every relevant change.
  const bootstrap = useMemo(
    () => ensureCoreScenarios({
      storedScenarios,
      storedAdjustments,
      manualEntries,
      customRows,
      cellOverrides,
      changeLog,
      sourceBaseScenario,
      user: USER,
    }),
    [storedScenarios, storedAdjustments, manualEntries, customRows, cellOverrides, changeLog, sourceBaseScenario],
  );

  useEffect(() => {
    if (!bootstrap.changed) return;
    setStoredScenarios(bootstrap.scenarios);
    setStoredAdjustments(bootstrap.adjustments);
    setManualEntries(bootstrap.manualEntries);
    setCustomRows(bootstrap.customRows);
    setCellOverrides(bootstrap.cellOverrides);
    setChangeLog(bootstrap.changeLog);
    if (bootstrap.auditEvents.length > 0) {
      const previous = loadPlanningAudit([]);
      savePlanningAudit([...bootstrap.auditEvents, ...previous]);
    }
  }, [bootstrap]);

  const scenarios = bootstrap.scenarios;
  const baseScenario = scenarios.find((s) => s.id === BASE_SCENARIO_ID && s.kind === 'BASE')!;
  const approvedScenario = scenarios.find((s) => s.id === APPROVED_SCENARIO_ID && s.kind === 'APPROVED')!;

  const [activeScenarioId, setActiveScenarioId] = useState<string>(() => APPROVED_SCENARIO_ID);
  const [granularity, setGranularity] = useState<ProjectionGranularity>('monthly');
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [mergeOpen, setMergeOpen] = useState<string | null>(null);
  const [addRowFor, setAddRowFor] = useState<FinancialMovementType | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [detailMovement, setDetailMovement] = useState<FinancialMovement | null>(null);
  const [detailAnchor, setDetailAnchor] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!scenarios.some((s) => s.id === activeScenarioId && !s.archivedAt)) {
      setActiveScenarioId(approvedScenario.id);
    }
  }, [scenarios, activeScenarioId, approvedScenario.id]);

  useEffect(() => {
    if (!statusMessage) return;
    const handle = setTimeout(() => setStatusMessage(null), 4500);
    return () => clearTimeout(handle);
  }, [statusMessage]);

  const activeScenario = scenarios.find((s) => s.id === activeScenarioId) ?? approvedScenario;
  const isReadOnly = activeScenario.kind !== 'DRAFT';

  const initialCash = useMemo(
    () => calculateInitialCash(props.bankStatements, props.startingBalance),
    [props.bankStatements, props.startingBalance],
  );
  const minimumCash = useMemo(() => minimumCashFor(props), [props.budget]);

  const buildScenarioRun = (scenarioId: string, includeManualEntries: boolean) => {
    const taxMovements = buildApprovedTaxPaymentMovements({
      obligations: taxStore.obligations,
      scenarioId,
      startDate: yearStart,
      endDate: yearEnd,
      asOfDate: today,
    });
    const manualMovements = includeManualEntries
      ? expandManualPlanningEntriesToMovements(manualEntries, {
        scenarioId,
        startDate: yearStart,
        endDate: yearEnd,
        asOfDate: today,
      })
      : [];
    const movementsBeforeAdjust = [...source.movements, ...manualMovements, ...taxMovements];
    const adjustedMovements = applyAdjustmentsToMovements(movementsBeforeAdjust, storedAdjustments, scenarioId);
    return calculateBaseProjection(adjustedMovements, {
      startDate: yearStart,
      endDate: yearEnd,
      initialCash,
      minimumCash,
      granularity,
      scenarioId,
      name: scenarios.find((s) => s.id === scenarioId)?.name ?? scenarioId,
    });
  };

  // Approved baseline used for diff reference.
  const approvedRun = useMemo(
    () => buildScenarioRun(approvedScenario.id, true),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [approvedScenario.id, yearStart, yearEnd, source.movements, storedAdjustments, manualEntries, taxStore.obligations, granularity, today],
  );

  const baseRun = useMemo(
    () => buildScenarioRun(baseScenario.id, true),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseScenario.id, yearStart, yearEnd, source.movements, storedAdjustments, manualEntries, taxStore.obligations, granularity, today],
  );

  const activeRunRaw = useMemo(
    () => buildScenarioRun(activeScenario.id, true),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeScenario.id, yearStart, yearEnd, source.movements, storedAdjustments, manualEntries, taxStore.obligations, granularity, today],
  );

  const activeOverrides = useMemo(
    () => cellOverrides.filter((override) => override.scenarioId === activeScenarioId),
    [cellOverrides, activeScenarioId],
  );
  const activeCustomRows = useMemo(
    () => customRows.filter((row) => row.scenarioId === activeScenarioId),
    [customRows, activeScenarioId],
  );

  const rows = useMemo(
    () => buildPlanningRows({
      movements: activeRunRaw.movements,
      customRows: activeCustomRows,
      overrides: activeOverrides,
    }),
    [activeRunRaw.movements, activeCustomRows, activeOverrides],
  );

  const activeRun = useMemo(() => {
    const buckets = applyCellOverridesToBuckets({
      buckets: activeRunRaw.buckets,
      overrides: activeOverrides,
      movements: activeRunRaw.movements,
      rows,
      granularity,
      conceptKeyForMovement,
      asOfDate: today,
      initialCash,
    });
    return {
      ...activeRunRaw,
      buckets,
      summary: summarizeBucketsForScenario(buckets, activeRunRaw.movements, minimumCash),
    };
  }, [activeRunRaw, activeOverrides, rows, granularity, today, initialCash, minimumCash]);

  // Approved overrides for the diff and merge logic
  const approvedOverrides = useMemo(
    () => cellOverrides.filter((override) => override.scenarioId === approvedScenario.id),
    [cellOverrides, approvedScenario.id],
  );

  const approvedRunWithOverrides = useMemo(() => {
    const approvedCustomRowsScoped = customRows.filter((row) => row.scenarioId === approvedScenario.id);
    const approvedRows = buildPlanningRows({
      movements: approvedRun.movements,
      customRows: approvedCustomRowsScoped,
      overrides: approvedOverrides,
    });
    const buckets = applyCellOverridesToBuckets({
      buckets: approvedRun.buckets,
      overrides: approvedOverrides,
      movements: approvedRun.movements,
      rows: approvedRows,
      granularity,
      conceptKeyForMovement,
      asOfDate: today,
      initialCash,
    });
    return {
      ...approvedRun,
      buckets,
      summary: summarizeBucketsForScenario(buckets, approvedRun.movements, minimumCash),
    };
  }, [approvedRun, approvedOverrides, customRows, approvedScenario.id, granularity, today, initialCash, minimumCash]);

  // Pre-override per-row aggregates (for cell display when no override).
  const rowAggregateMap = useMemo(() => {
    const map = new Map<string, number>();
    const movementById = new Map<string, FinancialMovement>();
    for (const movement of activeRunRaw.movements) movementById.set(movement.id, movement);
    for (const bucket of activeRunRaw.buckets) {
      for (const id of bucket.movementIds) {
        const movement = movementById.get(id);
        if (!movement) continue;
        const key = `${conceptKeyForMovement(movement)}::${bucket.date}`;
        map.set(key, (map.get(key) ?? 0) + effectiveAmount(movement));
      }
    }
    return map;
  }, [activeRunRaw]);

  const overrideMap = useMemo(() => {
    const map = new Map<string, CellOverride>();
    for (const override of activeOverrides) {
      map.set(`${override.conceptKey}::${override.bucketKey}::${override.granularity}`, override);
    }
    return map;
  }, [activeOverrides]);

  const columns: BucketColumn[] = useMemo(() => {
    const dates = buildBucketDates(yearStart, yearEnd, granularity);
    const todayKey = bucketKeyForDate(today, granularity);
    return dates.map((date) => ({
      key: date,
      label: engineBucketLabel(date, granularity),
      isPast: date < todayKey,
      isCurrent: date === todayKey,
    }));
  }, [granularity, yearStart, yearEnd, today]);

  const totalsForKind = (kind: 'inflows' | 'outflows' | 'net' | 'closingCash', bucketKey: string): number => {
    const bucket = activeRun.buckets.find((b) => b.date === bucketKey);
    if (!bucket) return 0;
    return bucket[kind];
  };

  const baseValueFor = (conceptKey: string, bucketKey: string): number =>
    rowAggregateMap.get(`${conceptKey}::${bucketKey}`) ?? 0;

  const overrideFor = (conceptKey: string, bucketKey: string): CellOverride | undefined =>
    overrideMap.get(`${conceptKey}::${bucketKey}::${granularity}`);

  const handleCommitCell = (conceptKey: string, bucketKey: string, value: number, type: FinancialMovementType) => {
    if (isReadOnly) return;
    const previousAggregate = baseValueFor(conceptKey, bucketKey);
    const existing = overrideFor(conceptKey, bucketKey);
    const oldValue = existing ? existing.value : previousAggregate;
    if (Math.round(oldValue) === Math.round(value)) return;
    const now = new Date().toISOString();
    const next: CellOverride = existing
      ? { ...existing, value, updatedAt: now }
      : {
        id: `co-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        scenarioId: activeScenarioId,
        conceptKey,
        granularity,
        bucketKey,
        type,
        mode: 'REPLACE',
        value,
        previousAggregatedValue: previousAggregate,
        createdBy: USER,
        createdAt: now,
        updatedAt: now,
      };
    setCellOverrides((current) => {
      const filtered = current.filter((o) => o.id !== (existing?.id ?? next.id));
      return [...filtered, next];
    });
    const row = rows.find((r) => r.conceptKey === conceptKey);
    setChangeLog((current) => [
      newChangeLogEntry({
        scenarioId: activeScenarioId,
        kind: 'EDIT_CELL',
        autoDescription: describeEditCell({
          rowLabel: row?.label ?? conceptKey,
          bucketLabel: engineBucketLabel(bucketKey, granularity),
          oldValue,
          newValue: value,
        }),
        payload: describeOverridePayload(next),
        createdBy: USER,
      }),
      ...current,
    ]);
  };

  const handleClearCell = (conceptKey: string, bucketKey: string) => {
    if (isReadOnly) return;
    const existing = overrideFor(conceptKey, bucketKey);
    if (!existing) return;
    const baseValue = baseValueFor(conceptKey, bucketKey);
    setCellOverrides((current) => current.filter((o) => o.id !== existing.id));
    const row = rows.find((r) => r.conceptKey === conceptKey);
    setChangeLog((current) => [
      newChangeLogEntry({
        scenarioId: activeScenarioId,
        kind: 'CLEAR_CELL',
        autoDescription: describeClearCell({
          rowLabel: row?.label ?? conceptKey,
          bucketLabel: engineBucketLabel(bucketKey, granularity),
          baseValue,
        }),
        payload: describeOverridePayload(existing),
        createdBy: USER,
      }),
      ...current,
    ]);
  };

  const handleAddRow = (type: FinancialMovementType) => {
    if (isReadOnly) return;
    setAddRowFor(type);
  };

  const handleCreateRow = (input: { type: FinancialMovementType; label: string; category: FinancialMovementCategory }) => {
    if (isReadOnly) return;
    const now = new Date().toISOString();
    const id = `custom-row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const conceptKey = buildCustomConceptKey(input.type, input.label, id);
    const row: PlanningCustomRow = {
      id,
      scenarioId: activeScenarioId,
      conceptKey,
      label: input.label,
      type: input.type,
      category: input.category,
      createdBy: USER,
      createdAt: now,
      updatedAt: now,
    };
    setCustomRows((current) => [...current, row]);
    setChangeLog((current) => [
      newChangeLogEntry({
        scenarioId: activeScenarioId,
        kind: 'ADD_ROW',
        autoDescription: describeAddRow(row),
        payload: { conceptKey: row.conceptKey, label: row.label, type: row.type, category: row.category },
        createdBy: USER,
      }),
      ...current,
    ]);
    setAddRowFor(null);
    setStatusMessage(`Fila "${row.label}" agregada.`);
  };

  const handleCreateDraft = () => {
    const { newScenario, seedEntry } = createNewDraft({ approved: approvedScenario, user: USER });
    setStoredScenarios((current) => [...current, newScenario]);
    setChangeLog((current) => [seedEntry, ...current]);
    setActiveScenarioId(newScenario.id);
    setStatusMessage(`Propuesta "${newScenario.name}" creada.`);
  };

  const handleDuplicateDraft = (scenarioId: string) => {
    const sourceDraft = scenarios.find((s) => s.id === scenarioId);
    if (!sourceDraft) return;
    const result = duplicateDraft({
      source: sourceDraft,
      approvedScenarioId: approvedScenario.id,
      allOverrides: cellOverrides,
      allCustomRows: customRows,
      changeLog,
      user: USER,
    });
    setStoredScenarios((current) => [...current, result.newScenario]);
    setCellOverrides(result.cellOverrides);
    setCustomRows(result.customRows);
    setChangeLog(result.changeLog);
    setActiveScenarioId(result.newScenario.id);
    setStatusMessage(`Propuesta duplicada como "${result.newScenario.name}".`);
  };

  const handleRenameDraft = (scenarioId: string, name: string) => {
    setStoredScenarios((current) => current.map((s) => (s.id === scenarioId ? { ...s, name, updatedAt: new Date().toISOString() } : s)));
  };

  const handleDiscardDraft = (scenarioId: string) => {
    if (!confirm('¿Descartar este borrador? Esta acción no se puede deshacer.')) return;
    const now = new Date().toISOString();
    setStoredScenarios((current) => current.map((s) => (s.id === scenarioId ? { ...s, archivedAt: now, updatedAt: now } : s)));
    setActiveScenarioId(approvedScenario.id);
    setStatusMessage('Borrador descartado.');
  };

  // ------- Merge flow ---------
  const mergeDiff: MergeDiffEntry[] = useMemo(() => {
    if (!mergeOpen) return [];
    const draft = scenarios.find((s) => s.id === mergeOpen);
    if (!draft) return [];
    const draftOverrides = cellOverrides.filter((o) => o.scenarioId === draft.id);
    const draftCustomScoped = customRows.filter((r) => r.scenarioId === draft.id);
    const approvedCustomScoped = customRows.filter((r) => r.scenarioId === approvedScenario.id);
    const allRows = buildPlanningRows({
      movements: approvedRun.movements,
      customRows: [...approvedCustomScoped, ...draftCustomScoped],
      overrides: [...approvedOverrides, ...draftOverrides],
    });
    const labelByKey = new Map(allRows.map((row) => [row.conceptKey, row.label]));
    const approvedAggregateMap = new Map<string, number>();
    const movementById = new Map(approvedRun.movements.map((m) => [m.id, m]));
    for (const bucket of approvedRun.buckets) {
      for (const id of bucket.movementIds) {
        const movement = movementById.get(id);
        if (!movement) continue;
        const key = `${conceptKeyForMovement(movement)}::${bucket.date}::${granularity}`;
        approvedAggregateMap.set(key, (approvedAggregateMap.get(key) ?? 0) + effectiveAmount(movement));
      }
    }
    return buildMergeDiff({
      approved: approvedScenario,
      draft,
      approvedOverrides,
      draftOverrides,
      approvedCustomRows: approvedCustomScoped,
      draftCustomRows: draftCustomScoped,
      rowLabelLookup: (key) => labelByKey.get(key) ?? key,
      bucketLabelLookup: (key, gran) => engineBucketLabel(key, gran),
      approvedAggregateLookup: (key, bucketKey, gran) => {
        const aggKey = `${key}::${bucketKey}::${gran}`;
        return approvedAggregateMap.get(aggKey) ?? 0;
      },
    });
  }, [mergeOpen, scenarios, cellOverrides, customRows, approvedScenario, approvedOverrides, approvedRun, granularity]);

  const handleConfirmMerge = (args: { selectedKeys: MergeDiffEntry[]; archiveDraft: boolean }) => {
    if (!mergeOpen) return;
    const draft = scenarios.find((s) => s.id === mergeOpen);
    if (!draft) return;
    const draftOverrides = cellOverrides.filter((o) => o.scenarioId === draft.id);
    const draftCustomScoped = customRows.filter((r) => r.scenarioId === draft.id);
    const approvedCustomScoped = customRows.filter((r) => r.scenarioId === approvedScenario.id);
    const result = applyMerge({
      approved: approvedScenario,
      draft,
      scenarios,
      approvedOverrides,
      draftOverrides,
      allOverrides: cellOverrides,
      approvedCustomRows: approvedCustomScoped,
      draftCustomRows: draftCustomScoped,
      allCustomRows: customRows,
      manualEntries,
      changeLog,
      selectedKeys: args.selectedKeys.map((entry) => ({
        conceptKey: entry.conceptKey,
        bucketKey: entry.bucketKey,
        granularity: entry.granularity,
      })),
      archiveDraft: args.archiveDraft,
      user: USER,
    });
    setStoredScenarios(result.scenarios);
    setCellOverrides(result.cellOverrides);
    setCustomRows(result.customRows);
    setChangeLog(result.changeLog);
    if (result.auditEvents.length > 0) {
      const previous = loadPlanningAudit([]);
      savePlanningAudit([...result.auditEvents, ...previous]);
    }
    setMergeOpen(null);
    setActiveScenarioId(approvedScenario.id);
    setStatusMessage(`Merge aplicado: ${args.selectedKeys.length} cambio${args.selectedKeys.length === 1 ? '' : 's'}.`);
  };

  // ------- KPIs ---------
  const summary = activeRun.summary;
  const finalCashDelta = activeRun.summary.finalCash - approvedRunWithOverrides.summary.finalCash;
  const isDraft = activeScenario.kind === 'DRAFT';

  const finalCashFor = (scenarioId: string): number => {
    if (scenarioId === activeScenario.id) return activeRun.summary.finalCash;
    if (scenarioId === approvedScenario.id) return approvedRunWithOverrides.summary.finalCash;
    if (scenarioId === baseScenario.id) return baseRun.summary.finalCash;
    return 0;
  };

  if (!source.hasData) {
    return (
      <div className="space-y-5">
        <PageHeader title="Planeación Financiera" />
        <EmptyDataState />
      </div>
    );
  }

  const draftEntries = changeLog.filter((entry) => entry.scenarioId === activeScenarioId);

  return (
    <div className="space-y-4 animate-page-in">
      <PageHeader
        title="Planeación Financiera"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedFilter
              value={granularity}
              onChange={setGranularity}
              options={[
                { value: 'monthly', label: 'Mes' },
                { value: 'weekly', label: 'Sem' },
                { value: 'daily', label: 'Día' },
              ]}
            />
            <button
              type="button"
              onClick={() => setDrawerOpen((open) => !open)}
              className={`inline-flex h-10 items-center gap-2 rounded-xl border px-3 text-[12px] font-medium transition-colors ${
                drawerOpen
                  ? 'border-[var(--gray-950)] bg-[var(--gray-950)] text-white'
                  : 'border-[var(--gray-200)] bg-white text-[var(--gray-700)] hover:bg-[var(--gray-50)]'
              }`}
            >
              <History className="h-3.5 w-3.5" strokeWidth={2} />
              Cambios
            </button>
            {isDraft && (
              <button
                type="button"
                onClick={() => setMergeOpen(activeScenarioId)}
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-[var(--primary)] px-3 text-[12px] font-medium text-white hover:bg-[var(--primary-hover)]"
              >
                <GitMerge className="h-3.5 w-3.5" strokeWidth={2} />
                Mergear a Aprobado
              </button>
            )}
          </div>
        }
      />

      {statusMessage && (
        <div className="rounded-xl border border-[var(--gray-200)] bg-white px-4 py-2 text-[12px] font-medium text-[var(--gray-700)]">
          {statusMessage}
        </div>
      )}

      <ScenarioTabs
        scenarios={scenarios}
        activeScenarioId={activeScenarioId}
        approvedFinalCash={approvedRunWithOverrides.summary.finalCash}
        finalCashFor={finalCashFor}
        onSelect={setActiveScenarioId}
        onCreateDraft={handleCreateDraft}
        onDuplicateDraft={handleDuplicateDraft}
        onRenameDraft={handleRenameDraft}
        onDiscardDraft={handleDiscardDraft}
        onMergeDraft={(id) => setMergeOpen(id)}
      />

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <KpiCard
          label="Caja final"
          value={fmtCurrency(summary.finalCash)}
          icon={<Wallet className="w-4 h-4" />}
          color="var(--gray-950)"
          sublabel={`${currentYear}`}
        />
        <KpiCard
          label="Días en déficit"
          value={String(summary.deficitDays)}
          icon={<AlertIcon className="w-4 h-4" />}
          color={summary.deficitDays > 0 ? 'var(--danger)' : 'var(--success)'}
          sublabel={summary.maxRiskDate ? `Máx riesgo ${summary.maxRiskDate}` : 'Sin fecha crítica'}
        />
        <KpiCard
          label="Crédito requerido"
          value={fmtCurrency(summary.creditRequired)}
          icon={<Banknote className="w-4 h-4" />}
          color={summary.creditRequired > 0 ? 'var(--warning)' : 'var(--gray-950)'}
          sublabel={`Mínimo ${fmtCompact(summary.minimumCashRequired)}`}
        />
        <KpiCard
          label="Δ vs Aprobado"
          value={`${finalCashDelta === 0 ? '±0' : (finalCashDelta > 0 ? '+' : '') + fmtCompact(finalCashDelta)}`}
          icon={<GitMerge className="w-4 h-4" />}
          color={finalCashDelta > 0 ? 'var(--success)' : finalCashDelta < 0 ? 'var(--danger)' : 'var(--gray-950)'}
          sublabel={isDraft ? 'Borrador activo' : 'Misma referencia'}
        />
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: drawerOpen ? 'minmax(0, 1fr) 320px' : 'minmax(0, 1fr)' }}>
        <SpreadsheetGrid
          rows={rows}
          columns={columns}
          granularity={granularity}
          isReadOnly={isReadOnly}
          asOfDate={today}
          baseValueFor={baseValueFor}
          overrideFor={overrideFor}
          totalsFor={totalsForKind}
          onCommitCell={handleCommitCell}
          onClearCell={handleClearCell}
          onAddRow={handleAddRow}
          onClickRow={() => { /* drill-down hook if needed */ }}
          onReadOnlyAttempt={() => setStatusMessage('Solo lectura. Crea una propuesta para editar.')}
        />
        <ChangeLogDrawer
          open={drawerOpen}
          scenarioName={activeScenario.name}
          entries={draftEntries}
          onClose={() => setDrawerOpen(false)}
        />
      </div>

      <CashTrajectoryChart
        projection={activeRun}
        baseProjection={activeScenario.kind === 'BASE' ? undefined : approvedRunWithOverrides}
      />

      {addRowFor && (
        <AddRowPopover
          type={addRowFor}
          onClose={() => setAddRowFor(null)}
          onCreate={handleCreateRow}
        />
      )}

      <MergeDialog
        open={Boolean(mergeOpen)}
        draft={mergeOpen ? scenarios.find((s) => s.id === mergeOpen) ?? null : null}
        approved={approvedScenario}
        diff={mergeDiff}
        changeLog={changeLog.filter((entry) => entry.scenarioId === mergeOpen)}
        draftFinalCash={mergeOpen ? finalCashFor(mergeOpen) : 0}
        approvedFinalCash={approvedRunWithOverrides.summary.finalCash}
        draftDeficitDays={mergeOpen ? activeRun.summary.deficitDays : 0}
        approvedDeficitDays={approvedRunWithOverrides.summary.deficitDays}
        onClose={() => setMergeOpen(null)}
        onConfirm={handleConfirmMerge}
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
    <div className="inline-flex h-10 rounded-xl border border-[var(--gray-200)] bg-[var(--gray-50)] p-0.5">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className="px-3 text-[12px] font-medium rounded-lg transition-colors"
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
