import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Banknote,
  GitCompare,
  ShieldAlert,
  Wallet,
  AlertTriangle as AlertIcon,
} from 'lucide-react';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import { fmtCompact, fmtCurrency, fmtDate } from '../../../formatters';
import {
  applyAdjustmentsToMovements,
  applyCellOverridesToBuckets,
  buildBucketDates,
  calculateBaseProjection,
  summarizeBucketsForScenario,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type {
  CellOverride,
  FinancialAdjustment,
  FinancialMovement,
  FinancialScenario,
  ForecastRun,
  ManualPlanningEntry,
  PlanningCustomRow,
  PlanningRow,
  ProjectionAlert,
  ProjectionGranularity,
} from '../../shared-finance/types';

type ScenarioRun = ForecastRun & {
  rows: PlanningRow[];
  overrides: CellOverride[];
};
import { CashFlowChart } from '../components/CashFlowChart';
import { MovementDrillDownDrawer } from '../components/MovementDrillDownDrawer';
import { ScenarioReadOnlyTabs } from '../components/ScenarioReadOnlyTabs';
import { ComparisonControl } from '../components/ComparisonControl';
import { CollapsibleSection } from '../components/CollapsibleSection';
import { BucketDetailTable } from '../components/BucketDetailTable';
import { AlertsPanel } from '../components/AlertsPanel';
import { MovementsTable } from '../components/MovementsTable';
import {
  buildFinancialProjectionSourceData,
  calculateInitialCash,
} from '../services/financialProjectionService';
import {
  loadManualPlanningEntries,
  expandManualPlanningEntriesToMovements,
} from '../../financial-planning/services/manualPlanningEntries';
import {
  loadPlanningAdjustments,
  loadPlanningScenarios,
} from '../../financial-planning/services/financialPlanningStorage';
import { loadCellOverrides } from '../../financial-planning/services/cellOverridesStorage';
import { loadCustomRows } from '../../financial-planning/services/customRowsStorage';
import { buildPlanningRows, conceptKeyForMovement } from '../../financial-planning/services/planningRowTaxonomy';
import {
  buildSupplierCriticalAlerts,
  type SupplierCriticalAlert,
} from '../services/supplierCriticalAlerts';
import {
  buildApprovedTaxPaymentMovements,
  buildTaxDashboardView,
  defaultTaxStore,
  loadTaxStore,
} from '../../taxes/services/taxModuleService';
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
  onNavigateToTax?: () => void;
}

const GRANULARITY_OPTIONS: Array<{ id: ProjectionGranularity; label: string }> = [
  { id: 'monthly', label: 'Mes' },
  { id: 'weekly', label: 'Sem' },
  { id: 'daily', label: 'Día' },
];

/**
 * Proyección Financiera — visualización read-only de escenarios.
 *
 * - Default activo: Aprobado (main branch).
 * - Selector: Base + Aprobado + drafts activos.
 * - Pipeline: movements ∪ manual ∪ tax → adjustments → projection → cell overrides
 *   (sincroniza con Planeación).
 * - Layout: secciones colapsables persistidas en sessionStorage.
 * - Toda mutación se canaliza a Planeación.
 */
export default function FinancialProjectionDashboard(props: Props) {
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

  const [storedScenarios] = useState<FinancialScenario[]>(() => loadPlanningScenarios([]));
  const [storedAdjustments] = useState<FinancialAdjustment[]>(() => loadPlanningAdjustments([]));
  const [manualEntries] = useState<ManualPlanningEntry[]>(() => loadManualPlanningEntries([]));
  const [cellOverrides] = useState<CellOverride[]>(() => loadCellOverrides([]));
  const [customRows] = useState<PlanningCustomRow[]>(() => loadCustomRows([]));
  const [taxStore] = useState(() => loadTaxStore(defaultTaxStore()));

  const sourceBaseScenario = source.scenarios.find((scenario) => scenario.kind === 'BASE') ?? source.scenarios[0];
  const baseScenario = storedScenarios.find((scenario) => scenario.kind === 'BASE' && !scenario.archivedAt) ?? sourceBaseScenario;
  const approvedScenario = storedScenarios.find((scenario) => scenario.kind === 'APPROVED' && !scenario.archivedAt)
    ?? source.scenarios.find((scenario) => scenario.kind === 'APPROVED')
    ?? baseScenario;
  const drafts = useMemo(
    () => storedScenarios.filter((scenario) => scenario.kind === 'DRAFT' && !scenario.archivedAt),
    [storedScenarios],
  );
  const scenarios = useMemo(
    () => [baseScenario, approvedScenario, ...drafts],
    [baseScenario, approvedScenario, drafts],
  );

  const [activeScenarioId, setActiveScenarioId] = useState<string>(approvedScenario.id);
  const [comparisonScenarioId, setComparisonScenarioId] = useState<string | null>(null);
  const [granularity, setGranularity] = useState<ProjectionGranularity>('monthly');
  const [drillMovement, setDrillMovement] = useState<FinancialMovement | null>(null);
  const [drillAnchor, setDrillAnchor] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!scenarios.some((s) => s.id === activeScenarioId)) {
      setActiveScenarioId(approvedScenario.id);
    }
  }, [scenarios, activeScenarioId, approvedScenario.id]);

  useEffect(() => {
    if (comparisonScenarioId === activeScenarioId) setComparisonScenarioId(null);
  }, [comparisonScenarioId, activeScenarioId]);

  const initialCash = useMemo(
    () => calculateInitialCash(props.bankStatements, props.startingBalance),
    [props.bankStatements, props.startingBalance],
  );
  const minimumCash = useMemo(() => minimumCashFor(props), [props.budget]);

  // Pre-index storage by scenario for O(1) per-scenario lookups.
  const customRowsByScenario = useMemo(() => {
    const map = new Map<string, PlanningCustomRow[]>();
    for (const row of customRows) {
      const list = map.get(row.scenarioId);
      if (list) list.push(row);
      else map.set(row.scenarioId, [row]);
    }
    return map;
  }, [customRows]);

  const cellOverridesByScenario = useMemo(() => {
    const map = new Map<string, CellOverride[]>();
    for (const override of cellOverrides) {
      const list = map.get(override.scenarioId);
      if (list) list.push(override);
      else map.set(override.scenarioId, [override]);
    }
    return map;
  }, [cellOverrides]);

  const scenarioNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const scenario of scenarios) map.set(scenario.id, scenario.name);
    return map;
  }, [scenarios]);

  // Single pass that computes every projection used by the page in one memo.
  // Reuses pre-indexed storage and scenario name lookups.
  const projectionTargets = useMemo(() => {
    const ids = new Set<string>([baseScenario.id, approvedScenario.id, activeScenarioId]);
    if (comparisonScenarioId) ids.add(comparisonScenarioId);
    for (const draft of drafts) ids.add(draft.id);
    return Array.from(ids);
  }, [baseScenario.id, approvedScenario.id, activeScenarioId, comparisonScenarioId, drafts]);

  const projectionsByScenario = useMemo(() => {
    const map = new Map<string, ScenarioRun>();
    for (const scenarioId of projectionTargets) {
      const scenarioName = scenarioNameById.get(scenarioId) ?? scenarioId;
      const taxMovements = buildApprovedTaxPaymentMovements({
        obligations: taxStore.obligations,
        scenarioId,
        startDate: yearStart,
        endDate: yearEnd,
        asOfDate: today,
      });
      const manualMovements = expandManualPlanningEntriesToMovements(manualEntries, {
        scenarioId,
        startDate: yearStart,
        endDate: yearEnd,
        asOfDate: today,
      });
      const adjustedMovements = applyAdjustmentsToMovements(
        [...source.movements, ...manualMovements, ...taxMovements],
        storedAdjustments,
        scenarioId,
      );
      const rawProjection = calculateBaseProjection(adjustedMovements, {
        startDate: yearStart,
        endDate: yearEnd,
        initialCash,
        minimumCash,
        granularity,
        scenarioId,
        name: scenarioName,
      });
      const scenarioCustomRows = customRowsByScenario.get(scenarioId) ?? [];
      const scenarioOverrides = cellOverridesByScenario.get(scenarioId) ?? [];
      const rows = buildPlanningRows({
        movements: rawProjection.movements,
        customRows: scenarioCustomRows,
        overrides: scenarioOverrides,
      });
      const buckets = applyCellOverridesToBuckets({
        buckets: rawProjection.buckets,
        overrides: scenarioOverrides,
        movements: rawProjection.movements,
        rows,
        granularity,
        conceptKeyForMovement,
        asOfDate: today,
        initialCash,
      });
      map.set(scenarioId, {
        ...rawProjection,
        buckets,
        summary: summarizeBucketsForScenario(buckets, rawProjection.movements, minimumCash),
        rows,
        overrides: scenarioOverrides,
      });
    }
    return map;
  }, [
    projectionTargets,
    scenarioNameById,
    source.movements,
    storedAdjustments,
    manualEntries,
    customRowsByScenario,
    cellOverridesByScenario,
    taxStore.obligations,
    granularity,
    yearStart,
    yearEnd,
    today,
    initialCash,
    minimumCash,
  ]);

  const baseRun = projectionsByScenario.get(baseScenario.id)!;
  const activeRun = projectionsByScenario.get(activeScenarioId) ?? baseRun;
  const comparisonRun = comparisonScenarioId
    ? (projectionsByScenario.get(comparisonScenarioId) ?? null)
    : null;

  // Bucket columns for chart range info.
  const bucketDates = useMemo(
    () => buildBucketDates(yearStart, yearEnd, granularity),
    [yearStart, yearEnd, granularity],
  );

  // KPIs.
  const summary = activeRun.summary;
  const comparisonReference = comparisonRun ? comparisonRun.summary.finalCash : baseRun.summary.finalCash;
  const finalCashDelta = summary.finalCash - comparisonReference;
  const comparisonLabel = comparisonRun ? comparisonRun.name : baseRun.name;

  const finalCashFor = (scenarioId: string): number =>
    projectionsByScenario.get(scenarioId)?.summary.finalCash ?? 0;

  // Auxiliary computations.
  const taxView = useMemo(
    () => buildTaxDashboardView({
      projection: activeRun,
      store: taxStore,
      providers: props.providers,
      cxpRecords: props.cxpRecords,
      scenarioId: activeScenarioId,
      today,
    }),
    [activeRun, activeScenarioId, props.cxpRecords, props.providers, taxStore, today],
  );
  const supplierAlerts = useMemo(
    () => buildSupplierCriticalAlerts({
      providers: props.providers,
      cxpRecords: props.cxpRecords,
      movements: activeRun.movements,
      manualEntries,
      bankStatements: props.bankStatements,
      scenarioId: activeScenarioId,
      today,
    }),
    [activeRun.movements, activeScenarioId, manualEntries, props.bankStatements, props.cxpRecords, props.providers, today],
  );

  const tableMovements = useMemo(
    () => activeRun.movements
      .filter((movement) => {
        const date = movement.actualDate ?? movement.adjustedDate ?? movement.projectedDate;
        return date >= yearStart && date <= yearEnd;
      }),
    [activeRun.movements, yearStart, yearEnd],
  );

  const handleSelectMovement = (movement: FinancialMovement, anchor: DOMRect) => {
    setDrillMovement(movement);
    setDrillAnchor(anchor);
  };

  if (!source.hasData) {
    return (
      <div className="space-y-5">
        <PageHeader title="Proyección Financiera" />
        <EmptyDataState />
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-page-in">
      <PageHeader
        title="Proyección Financiera"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              value={granularity}
              options={GRANULARITY_OPTIONS}
              onChange={setGranularity}
            />
            <ComparisonControl
              scenarios={scenarios}
              activeScenarioId={activeScenarioId}
              comparisonScenarioId={comparisonScenarioId}
              onChange={setComparisonScenarioId}
            />
          </div>
        }
      />

      <ScenarioReadOnlyTabs
        scenarios={scenarios}
        activeScenarioId={activeScenarioId}
        approvedFinalCash={baseRun.summary.finalCash}
        finalCashFor={finalCashFor}
        onSelect={setActiveScenarioId}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="Caja final"
          value={fmtCurrency(summary.finalCash)}
          icon={<Wallet className="w-4 h-4" />}
          color={tone(summary.finalCash, summary.minimumCashRequired)}
          sublabel={`${currentYear} · mínimo ${fmtCompact(summary.minimumCashRequired)}`}
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
          sublabel={`Ingresos ${fmtCompact(summary.totalInflows)} · egresos ${fmtCompact(summary.totalOutflows)}`}
        />
        <KpiCard
          label={`Δ vs ${comparisonLabel}`}
          value={`${finalCashDelta === 0 ? '±0' : (finalCashDelta > 0 ? '+' : '') + fmtCompact(finalCashDelta)}`}
          icon={<GitCompare className="w-4 h-4" />}
          color={finalCashDelta > 0 ? 'var(--success)' : finalCashDelta < 0 ? 'var(--danger)' : 'var(--gray-950)'}
          sublabel={comparisonRun ? 'Comparación activa' : 'vs Base'}
        />
      </div>

      <CollapsibleSection
        title="Trayectoria de caja"
        storageKey="proyeccion.section.trajectory"
        description="Ingresos, egresos, cierre y caja mínima a lo largo del año."
        actions={
          <span className="text-[11px] text-[var(--gray-400)] tabular-nums">
            {bucketDates.length} {bucketDates.length === 1 ? 'período' : 'períodos'} · {yearStart} → {yearEnd}
          </span>
        }
      >
        <div className="px-4 py-3">
          <CashFlowChart
            projection={activeRun}
            baseProjection={activeRun.scenarioId === baseRun.scenarioId ? undefined : baseRun}
            comparisonProjection={comparisonRun ?? undefined}
            onNavigateToTax={props.onNavigateToTax}
          />
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        title="Detalle por período"
        storageKey="proyeccion.section.bucket"
        description="Cada período se desglosa en conceptos de Planeación al expandir."
        count={activeRun.buckets.length}
      >
        <BucketDetailTable
          buckets={activeRun.buckets}
          movements={activeRun.movements}
          rows={activeRun.rows}
          overrides={activeRun.overrides}
          granularity={granularity}
          comparisonBuckets={comparisonRun?.buckets}
          onSelectMovement={handleSelectMovement}
        />
      </CollapsibleSection>

      <CollapsibleSection
        title="Movimientos"
        storageKey="proyeccion.section.movements"
        description="Lista filtrable. Clic en una fila para ver factura y origen."
        count={tableMovements.length}
      >
        <MovementsTable
          movements={tableMovements}
          granularity={granularity}
          today={today}
          onSelectMovement={handleSelectMovement}
        />
      </CollapsibleSection>

      <CollapsibleSection
        title="Proveedores críticos"
        storageKey="proyeccion.section.suppliers"
        defaultOpen={false}
        count={supplierAlerts.length}
        badge={supplierAlerts.some((alert) => alert.severity === 'CRITICAL') ? <ShieldAlert className="h-3.5 w-3.5 text-[var(--danger)]" /> : undefined}
        description="Estatus de pago consolidado: real, programado, manual o pendiente."
      >
        <SupplierAlertsList alerts={supplierAlerts} />
      </CollapsibleSection>

      <CollapsibleSection
        title="Impuestos"
        storageKey="proyeccion.section.taxes"
        defaultOpen={false}
        description="IVA neto, ISN, IMSS y total con saldo vencido."
        actions={props.onNavigateToTax ? (
          <button
            type="button"
            onClick={props.onNavigateToTax}
            className="text-[11px] font-medium text-[var(--primary)] hover:underline"
          >
            Abrir módulo →
          </button>
        ) : undefined}
      >
        <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
          <TaxStat label="Saldo vencido" value={fmtCompact(taxView.overdueBalance)} tone="danger" />
          <TaxStat label="IVA período" value={fmtCompact(taxView.totals.ivaNet)} tone={taxView.totals.ivaNet > 0 ? 'warning' : 'neutral'} />
          <TaxStat label="ISN/IMSS" value={fmtCompact(taxView.totals.isn + taxView.totals.imss)} tone="warning" />
          <TaxStat label="Total acumulado" value={fmtCompact(taxView.totals.totalWithOverdue)} tone="danger" />
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        title="Alertas"
        storageKey="proyeccion.section.alerts"
        defaultOpen={false}
        count={activeRun.alerts.length}
        badge={activeRun.alerts.some((alert) => alert.severity === 'CRITICAL')
          ? <span className="rounded-full bg-[var(--danger)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white">crítica</span>
          : undefined}
        description="Caja bajo mínimo, confianza baja, impuestos vencidos."
      >
        <AlertsPanel alerts={activeRun.alerts as ProjectionAlert[]} />
      </CollapsibleSection>

      <MovementDrillDownDrawer
        movement={drillMovement}
        anchor={drillAnchor}
        onClose={() => { setDrillMovement(null); setDrillAnchor(null); }}
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

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (next: T) => void;
}) {
  return (
    <div className="inline-flex h-10 rounded-xl border border-[var(--gray-200)] bg-[var(--gray-50)] p-0.5">
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            aria-pressed={active}
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

function SupplierAlertsList({ alerts }: { alerts: SupplierCriticalAlert[] }) {
  if (alerts.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-[12px] text-[var(--gray-400)]">
        Sin proveedores críticos pendientes.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-[var(--gray-100)]">
      {alerts.slice(0, 12).map((alert) => (
        <li key={alert.id} className="px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium text-[var(--gray-950)]">{alert.providerName}</div>
              <div className="mt-0.5 text-[11px] text-[var(--gray-400)]">
                {alert.invoiceNumber ? `Factura ${alert.invoiceNumber}` : 'Factura s/n'} · {alert.dueDate ? `vence ${fmtDate(alert.dueDate)}` : 'sin vencimiento'}
              </div>
              {alert.detail && (
                <div className="mt-1 text-[11px] text-[var(--gray-500)] leading-snug">{alert.detail}</div>
              )}
            </div>
            <div className="shrink-0 text-right">
              <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium ${supplierAlertClass(alert.severity)}`}>
                {alert.statusLabel}
              </span>
              <div className="mt-1 text-[12px] font-semibold tabular-nums text-[var(--gray-950)]">{fmtCompact(alert.pendingAmount)}</div>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function supplierAlertClass(severity: SupplierCriticalAlert['severity']): string {
  if (severity === 'CRITICAL') return 'bg-[var(--danger)]/10 text-[var(--danger)]';
  if (severity === 'WARNING') return 'bg-[var(--warning-muted)] text-[var(--warning)]';
  return 'bg-[var(--success)]/10 text-[var(--success)]';
}

function TaxStat({
  label,
  value,
  tone: statTone,
}: {
  label: string;
  value: string;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
}) {
  const toneClass = statTone === 'success'
    ? 'text-[var(--success)]'
    : statTone === 'warning'
      ? 'text-[var(--warning)]'
      : statTone === 'danger'
        ? 'text-[var(--danger)]'
        : 'text-[var(--gray-950)]';
  return (
    <div className="rounded-xl border border-[var(--gray-200)] bg-[var(--gray-50)] px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">{label}</div>
      <div className={`mt-1 text-[14px] font-semibold tabular-nums ${toneClass}`}>{value}</div>
    </div>
  );
}

function tone(value: number, minimum: number): string {
  if (value < minimum) return 'var(--danger)';
  if (value < minimum * 1.2) return 'var(--warning)';
  return 'var(--gray-950)';
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
        Aún no hay datos suficientes para proyectar
      </h2>
      <p className="mx-auto mt-2 max-w-[480px] text-[12px] leading-relaxed text-[var(--gray-500)]">
        Necesitamos estados de cuenta bancarios y al menos uno de:
        catálogo de clientes, antigüedad de saldos, o presupuesto del año.
      </p>
    </div>
  );
}
