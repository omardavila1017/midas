import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, RotateCcw, Search, ShieldAlert } from 'lucide-react';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import { fmtCompact, fmtCurrency, fmtDate, fmtYearMonthLong } from '../../../formatters';
import {
  applyAdjustmentsToMovements,
  calculateBaseProjection,
  compareProjectionVsScenario,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type { FinancialAdjustment, FinancialMovement, FinancialScenario, ManualPlanningEntry, ProjectionGranularity, ScenarioComparison } from '../../shared-finance/types';
import { CashFlowChart } from '../components/CashFlowChart';
import { MovementDrillDownDrawer } from '../components/MovementDrillDownDrawer';
import {
  buildFinancialProjectionSourceData,
  calculateInitialCash,
} from '../services/financialProjectionService';
import {
  convertLegacyScenariosToFinancial,
  isLegacyScenarioId,
  legacyProposalToAdjustments,
  legacyProposalsForActiveScenario,
  legacyScenarioId,
} from '../../shared-finance/calculation-engine/legacyScenarioBridge';
import {
  loadManualPlanningEntries,
  expandManualPlanningEntriesToMovements,
} from '../../financial-planning/services/manualPlanningEntries';
import {
  loadPlanningAdjustments,
  loadPlanningScenarios,
} from '../../financial-planning/services/financialPlanningStorage';
import {
  buildSupplierCriticalAlerts,
  type SupplierCriticalAlert,
} from '../services/supplierCriticalAlerts';
import {
  buildApprovedTaxPaymentMovements,
  buildTaxDashboardView,
  defaultTaxStore,
  loadTaxStore,
  type TaxDashboardView,
} from '../../taxes/services/taxModuleService';
import { ConfidenceBadge, StatusBadge } from '../../shared-finance/components/FinanceBadges';
import {
  effectiveAmount,
  effectiveMovementDate,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import KpiCard from '../../../components/ui/KpiCard';
import PageHeader from '../../../components/ui/PageHeader';
import { Wallet, AlertTriangle as AlertIcon, ArrowDownCircle, ArrowUpCircle } from 'lucide-react';
import type { Proposal, Scenario as LegacyScenario } from '../../../types';

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
  onNavigateToTax?: () => void;
}

const GRANULARITY_LABELS: Record<ProjectionGranularity, string> = {
  daily: 'Diaria',
  weekly: 'Semanal',
  monthly: 'Mensual',
};

type RangePreset = '30d' | '60d' | '90d' | 'eoy';

const RANGE_PRESETS: Array<{ id: RangePreset; label: string }> = [
  { id: '30d', label: '30 días' },
  { id: '60d', label: '60 días' },
  { id: '90d', label: '90 días' },
  { id: 'eoy', label: 'Fin de año' },
];

/**
 * Proyección Financiera — vista forward-looking, solo lectura.
 *
 * Layout consolidado en una sola superficie de lectura:
 *   1. Page header (título + reset)
 *   2. Toolbar compacta con rango, granularidad y resumen — un solo card
 *   3. 4 KPIs críticos (no 8) — alineados al patrón del Dashboard
 *   4. Chart hero (~380px alto) como artefacto principal
 *   5. Tabla densa de movimientos con filtros inline (no card extra)
 *   6. Popover de drilldown anclado al click
 *
 * Antes había 8 KPI cards en dos filas, dos paneles laterales
 * (clientes/proveedores) duplicando lo que ya muestra la tabla, dos
 * cards separados de filtros y tabla, y la chart compitiendo con todo
 * eso visualmente. Ahora el chart es el protagonista y todo lo demás
 * lo apoya.
 */
export default function FinancialProjectionDashboard(props: Props) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const monthStart = useMemo(() => `${today.slice(0, 7)}-01`, [today]);
  const yearEnd = useMemo(() => `${Number(today.slice(0, 4))}-12-31`, [today]);

  const [granularity, setGranularity] = useState<ProjectionGranularity>('weekly');
  const [preset, setPreset] = useState<RangePreset>('eoy');
  const endDate = useMemo(() => endDateForPreset(preset, today, yearEnd), [preset, today, yearEnd]);
  const startDate = monthStart;

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'ALL' | 'INFLOW' | 'OUTFLOW'>('ALL');
  const [groupBy, setGroupBy] = useState<GroupBy>('period');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const [drillMovement, setDrillMovement] = useState<FinancialMovement | null>(null);
  const [drillAnchor, setDrillAnchor] = useState<DOMRect | null>(null);

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
  const [taxStore] = useState(() => loadTaxStore(defaultTaxStore()));
  const [selectedSupplierAlert, setSelectedSupplierAlert] = useState<SupplierCriticalAlert | null>(null);

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
    if (props.legacyActiveScenarioId) {
      return legacyScenarioId({ id: props.legacyActiveScenarioId } as LegacyScenario);
    }
    return baseScenario.id;
  }, [baseScenario.id, props.legacyActiveScenarioId]);
  const [activeScenarioId, setActiveScenarioId] = useState(initialScenarioId);

  useEffect(() => {
    if (!scenarios.some((scenario) => scenario.id === activeScenarioId)) {
      setActiveScenarioId(scenarios[0]?.id ?? activeScenarioId);
    }
  }, [activeScenarioId, scenarios]);

  const activeScenario = scenarios.find((scenario) => scenario.id === activeScenarioId) ?? baseScenario;
  const horizonYearMonth = yearEnd.slice(0, 7);
  const baseSeedMovements = useMemo(() => {
    const baseManualMovements = expandManualPlanningEntriesToMovements(manualEntries, {
      scenarioId: baseScenario.id,
      startDate,
      endDate,
      asOfDate: today,
    });
    const baseTaxMovements = buildApprovedTaxPaymentMovements({
      obligations: taxStore.obligations,
      scenarioId: baseScenario.id,
      startDate,
      endDate,
      asOfDate: today,
    });
    return applyAdjustmentsToMovements(
      [...source.movements, ...baseManualMovements, ...baseTaxMovements],
      storedAdjustments,
      baseScenario.id,
    );
  }, [baseScenario.id, endDate, manualEntries, source.movements, startDate, storedAdjustments, taxStore.obligations, today]);

  const baseProjection = useMemo(
    () => calculateBaseProjection(baseSeedMovements, {
      startDate,
      endDate,
      initialCash: calculateInitialCash(props.bankStatements, props.startingBalance),
      minimumCash: minimumCashFor(props),
      granularity,
      scenarioId: baseScenario.id,
      name: baseScenario.name,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      baseScenario.id,
      baseScenario.name,
      endDate,
      granularity,
      props.bankStatements,
      props.budget,
      props.startingBalance,
      baseSeedMovements,
      startDate,
    ],
  );

  const activeAdjustments = useMemo<FinancialAdjustment[]>(() => {
    const stored = storedAdjustments.filter((adjustment) => adjustment.scenarioIds.includes(activeScenario.id));
    if (!isLegacyScenarioId(activeScenario.id)) return stored;
    const proposals = legacyProposalsForActiveScenario(
      activeScenario.id,
      props.legacyScenarios ?? [],
      props.legacyProposals ?? [],
    );
    const legacy = proposals.flatMap((proposal) =>
      legacyProposalToAdjustments(proposal, activeScenario.id, today, horizonYearMonth),
    );
    return [...stored, ...legacy];
  }, [activeScenario.id, horizonYearMonth, props.legacyProposals, props.legacyScenarios, storedAdjustments, today]);

  const activeManualMovements = useMemo(
    () => expandManualPlanningEntriesToMovements(manualEntries, {
      scenarioId: activeScenario.id,
      startDate,
      endDate,
      asOfDate: today,
    }),
    [activeScenario.id, endDate, manualEntries, startDate, today],
  );

  const activeProjection = useMemo(() => {
    const activeTaxMovements = buildApprovedTaxPaymentMovements({
      obligations: taxStore.obligations,
      scenarioId: activeScenario.id,
      startDate,
      endDate,
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
        startDate,
        endDate,
        initialCash: calculateInitialCash(props.bankStatements, props.startingBalance),
        minimumCash: minimumCashFor(props),
        granularity,
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
      startDate,
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
    props.bankStatements,
    props.budget,
    props.startingBalance,
    source.movements,
    startDate,
    taxStore.obligations,
    today,
  ]);

  const comparison = activeScenario.id !== baseProjection.scenarioId
    ? compareProjectionVsScenario(baseProjection, activeProjection)
    : undefined;

  const taxView = useMemo(
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
  const supplierAlerts = useMemo(
    () => buildSupplierCriticalAlerts({
      providers: props.providers,
      cxpRecords: props.cxpRecords,
      movements: activeProjection.movements,
      manualEntries,
      bankStatements: props.bankStatements,
      scenarioId: activeScenario.id,
      today,
    }),
    [activeProjection.movements, activeScenario.id, manualEntries, props.bankStatements, props.cxpRecords, props.providers, today],
  );

  const tableMovements = useMemo(
    () => activeProjection.movements
      .filter((movement) => {
        const date = movement.actualDate ?? movement.adjustedDate ?? movement.projectedDate;
        if (date < startDate || date > endDate) return false;
        if (typeFilter !== 'ALL' && movement.type !== typeFilter) return false;
        if (search) {
          const haystack = `${movement.counterpartyName ?? ''} ${movement.concept} ${movement.category}`.toLowerCase();
          if (!haystack.includes(search.toLowerCase())) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const da = a.actualDate ?? a.adjustedDate ?? a.projectedDate;
        const db = b.actualDate ?? b.adjustedDate ?? b.projectedDate;
        return da.localeCompare(db);
      }),
    [activeProjection.movements, endDate, search, startDate, typeFilter],
  );

  const movementGroups = useMemo(
    () => buildMovementGroups(tableMovements, groupBy, granularity, today),
    [tableMovements, groupBy, granularity, today],
  );

  // Por defecto, expandir solo el primer grupo (más cercano a hoy si es por
  // periodo, o el grupo más grande si es por contraparte). Se recalcula cuando
  // cambia el modo de agrupación o cuando la tabla queda vacía.
  useEffect(() => {
    if (movementGroups.length === 0) {
      setExpandedGroups(new Set());
      return;
    }
    setExpandedGroups((current) => {
      const validKeys = new Set(movementGroups.map((g) => g.key));
      const intersection = new Set([...current].filter((key) => validKeys.has(key)));
      if (intersection.size > 0) return intersection;
      return new Set([defaultExpandedKey(movementGroups, groupBy, today)]);
    });
  }, [movementGroups, groupBy, today]);

  const toggleGroup = (key: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const allExpanded = movementGroups.length > 0
    && movementGroups.every((group) => expandedGroups.has(group.key));

  const toggleAllGroups = () => {
    if (allExpanded) setExpandedGroups(new Set());
    else setExpandedGroups(new Set(movementGroups.map((group) => group.key)));
  };

  const resetView = () => {
    setSearch('');
    setTypeFilter('ALL');
    setGranularity('weekly');
    setPreset('eoy');
    setGroupBy('period');
    setExpandedGroups(new Set());
  };

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

  const summary = activeProjection.summary;

  return (
    <div className="space-y-5 animate-page-in">
      <PageHeader
        title="Proyección Financiera"
        actions={
          <button
            onClick={resetView}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[13px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)] transition-colors"
          >
            <RotateCcw className="h-4 w-4" strokeWidth={1.5} />
            Restablecer
          </button>
        }
      />

      {/* Toolbar consolidada — rango + granularidad + resumen en una sola
          fila. Antes había un párrafo + un card de controles + un strip de
          resumen. Todo eso ahora vive en este card. */}
      <section className="rounded-2xl border border-[var(--gray-200)] bg-white px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <SegmentedControl
            label="Rango"
            value={preset}
            options={RANGE_PRESETS}
            onChange={setPreset}
          />
          <SegmentedControl
            label="Granularidad"
            value={granularity}
            options={(['daily', 'weekly', 'monthly'] as ProjectionGranularity[]).map((g) => ({
              id: g,
              label: GRANULARITY_LABELS[g],
            }))}
            onChange={setGranularity}
          />
          <div className="ml-auto flex items-center gap-4 text-[12px] text-[var(--gray-500)]">
            <span>
              <span className="text-[var(--gray-400)]">Hoy → </span>
              <span className="font-medium text-[var(--gray-700)] tabular-nums">{endDate}</span>
            </span>
            <span className="hidden sm:inline">·</span>
            <span className="tabular-nums">
              {activeProjection.buckets.length} {activeProjection.buckets.length === 1 ? 'periodo' : 'periodos'}
            </span>
          </div>
        </div>
      </section>

      <ProjectionScenarioDetail
        scenarios={scenarios}
        activeScenario={activeScenario}
        activeScenarioId={activeScenario.id}
        onSelect={setActiveScenarioId}
        comparison={comparison}
        manualEntries={manualEntries.filter((entry) => entry.scenarioIds.includes(activeScenario.id))}
        adjustments={activeAdjustments}
        taxView={taxView}
        supplierAlerts={supplierAlerts}
      />

      {/* 4 KPIs críticos. Mantengo la jerarquía del Dashboard: caja actual,
          caja proyectada al rango, días en déficit, mayor riesgo. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="Caja actual"
          value={fmtCurrency(summary.currentCash)}
          icon={<Wallet className="w-4 h-4" />}
          color="var(--gray-950)"
          sublabel="Saldo inicial bancario"
        />
        <KpiCard
          label={`Caja al ${endDate}`}
          value={fmtCurrency(summary.finalCash)}
          icon={<Wallet className="w-4 h-4" />}
          color={tone(summary.finalCash, summary.minimumCashRequired)}
          sublabel={comparison ? `${formatDelta(comparison.finalCashDelta)} vs base` : `Mínimo ${fmtCompact(summary.minimumCashRequired)}`}
        />
        <KpiCard
          label="Días en déficit"
          value={String(summary.deficitDays)}
          icon={<AlertIcon className="w-4 h-4" />}
          color={summary.deficitDays > 0 ? 'var(--danger)' : 'var(--success)'}
          sublabel={summary.maxRiskDate ? `Mayor riesgo: ${summary.maxRiskDate}` : 'Sin fechas críticas'}
        />
        <KpiCard
          label="Crédito requerido"
          value={fmtCurrency(summary.creditRequired)}
          icon={summary.totalInflows >= summary.totalOutflows
            ? <ArrowUpCircle className="w-4 h-4" />
            : <ArrowDownCircle className="w-4 h-4" />}
          color={summary.creditRequired > 0 ? 'var(--warning)' : 'var(--gray-950)'}
          sublabel={`Ingresos ${fmtCompact(summary.totalInflows)} · egresos ${fmtCompact(summary.totalOutflows)}`}
        />
      </div>

      {/* Chart hero. */}
      <CashFlowChart
        projection={activeProjection}
        baseProjection={activeProjection.scenarioId === baseProjection.scenarioId ? undefined : baseProjection}
        onNavigateToTax={props.onNavigateToTax}
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(360px,0.8fr)_minmax(0,1.2fr)]">
        <SupplierCriticalAlertsPanel
          alerts={supplierAlerts}
          selectedAlert={selectedSupplierAlert}
          onSelect={setSelectedSupplierAlert}
        />
        <section
          className="rounded-2xl border border-[var(--gray-200)] bg-white transition-colors hover:border-[var(--gray-300)]"
          style={{ cursor: props.onNavigateToTax ? 'pointer' : undefined }}
          onClick={props.onNavigateToTax}
        >
          <div className="flex items-start justify-between gap-3 border-b border-[var(--gray-200)] px-4 py-3">
            <div>
              <h2 className="text-[15px] font-semibold tracking-tight text-[var(--gray-950)]">Impuestos</h2>
              <p className="mt-0.5 text-[12px] text-[var(--gray-400)]">
                {props.onNavigateToTax ? 'Clic para abrir el módulo de impuestos.' : 'El cálculo y los pagos parciales viven en Proyección > Impuestos.'}
              </p>
            </div>
            <div className="text-right text-[12px]">
              <div className="font-semibold tabular-nums text-[var(--gray-950)]">{fmtCurrency(taxView.totals.total)}</div>
              <div className="text-[var(--gray-400)]">obligaciones visibles</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
            <ScenarioMiniStat label="IVA" value={fmtCompact(taxView.totals.ivaNet)} tone={taxView.totals.ivaNet > 0 ? 'warning' : 'neutral'} />
            <ScenarioMiniStat label="ISN" value={fmtCompact(taxView.totals.isn)} tone={taxView.totals.isn > 0 ? 'warning' : 'neutral'} />
            <ScenarioMiniStat label="IMSS" value={fmtCompact(taxView.totals.imss)} tone={taxView.totals.imss > 0 ? 'danger' : 'neutral'} />
            <ScenarioMiniStat label="Caja" value={fmtCompact(taxView.totals.cashImpact)} tone={taxView.totals.cashImpact > 0 ? 'danger' : 'neutral'} />
          </div>
        </section>
      </div>

      {/* Tabla con filtros inline en su mismo header — sin card extra.
          Las filas viven en grupos colapsables (por periodo o por contraparte)
          con subtotal a la derecha, para que un rango completo se lea de un
          vistazo y el detalle se abra solo cuando hace falta. */}
      <section className="rounded-2xl border border-[var(--gray-200)] bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--gray-200)] px-4 py-3">
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight text-[var(--gray-950)]">
              Movimientos proyectados
            </h2>
            <p className="mt-0.5 text-[12px] text-[var(--gray-400)]">
              {tableMovements.length} {tableMovements.length === 1 ? 'movimiento' : 'movimientos'} en el rango ·{' '}
              {movementGroups.length} {movementGroups.length === 1 ? 'grupo' : 'grupos'}.
              Para crear ajustes, abre <strong className="text-[var(--gray-700)]">Planeación</strong>.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--gray-400)]" strokeWidth={1.5} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar contraparte o concepto"
                className="h-9 w-[260px] rounded-xl border border-[var(--gray-200)] bg-white pl-8 pr-3 text-[13px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)]"
              />
            </div>
            <SegmentedControl
              value={typeFilter}
              options={[
                { id: 'ALL', label: 'Todo' },
                { id: 'INFLOW', label: 'Ingresos' },
                { id: 'OUTFLOW', label: 'Egresos' },
              ]}
              onChange={setTypeFilter}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--gray-200)] px-4 py-2.5 bg-[var(--gray-50)]/60">
          <SegmentedControl
            label="Agrupar por"
            value={groupBy}
            options={[
              { id: 'period', label: granularity === 'monthly' ? 'Mes' : granularity === 'weekly' ? 'Semana' : 'Día' },
              { id: 'counterparty', label: 'Contraparte' },
              { id: 'category', label: 'Categoría' },
            ]}
            onChange={(value) => setGroupBy(value)}
          />
          <button
            onClick={toggleAllGroups}
            disabled={movementGroups.length === 0}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--gray-200)] bg-white px-2.5 text-[12px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {allExpanded
              ? <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.5} />
              : <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.5} />}
            {allExpanded ? 'Contraer todo' : 'Expandir todo'}
          </button>
        </div>
        <GroupedMovementsTable
          groups={movementGroups}
          expandedGroups={expandedGroups}
          onToggleGroup={toggleGroup}
          onSelectMovement={handleSelectMovement}
        />
      </section>

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

type GroupBy = 'period' | 'counterparty' | 'category';

interface MovementGroup {
  key: string;
  label: string;
  sublabel?: string;
  movements: FinancialMovement[];
  inflowTotal: number;
  outflowTotal: number;
  netTotal: number;
  containsToday?: boolean;
}

/**
 * Tabla agrupada de movimientos. En lugar de soltar 200+ filas planas (que
 * son ilegibles en cualquier monitor), las divide en grupos colapsables —
 * por periodo (alineado a la granularidad del chart) o por tipo de
 * contraparte. Cada grupo muestra un solo renglón resumen con
 * #movimientos, ingresos, egresos y neto. Al expandir, aparecen las filas
 * densas tradicionales.
 *
 * Patrón: por defecto solo el grupo más cercano a hoy (o el más grande,
 * si se agrupa por contraparte) queda abierto. El usuario abre lo que le
 * importa, el resto se queda recogido.
 */
function GroupedMovementsTable({
  groups,
  expandedGroups,
  onToggleGroup,
  onSelectMovement,
}: {
  groups: MovementGroup[];
  expandedGroups: Set<string>;
  onToggleGroup: (key: string) => void;
  onSelectMovement: (movement: FinancialMovement, anchor: DOMRect) => void;
}) {
  if (groups.length === 0) {
    return (
      <div className="px-4 py-12 text-center text-[12px] text-[var(--gray-400)]">
        No hay movimientos para los filtros aplicados.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] text-[13px]">
        <thead className="bg-[var(--gray-50)] text-left text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">
          <tr>
            <th className="px-4 py-2.5 w-[40%]">Grupo</th>
            <th className="px-4 py-2.5 text-right">Ingresos</th>
            <th className="px-4 py-2.5 text-right">Egresos</th>
            <th className="px-4 py-2.5 text-right">Neto</th>
            <th className="px-4 py-2.5 text-right"># mov.</th>
            <th className="px-4 py-2.5"></th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const expanded = expandedGroups.has(group.key);
            return (
              <GroupRows
                key={group.key}
                group={group}
                expanded={expanded}
                onToggle={() => onToggleGroup(group.key)}
                onSelectMovement={onSelectMovement}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function GroupRows({
  group,
  expanded,
  onToggle,
  onSelectMovement,
}: {
  group: MovementGroup;
  expanded: boolean;
  onToggle: () => void;
  onSelectMovement: (movement: FinancialMovement, anchor: DOMRect) => void;
}) {
  const [visibleLimit, setVisibleLimit] = useState(120);
  useEffect(() => {
    setVisibleLimit(120);
  }, [group.key]);
  const visibleMovements = group.movements.slice(0, visibleLimit);
  const hiddenCount = Math.max(0, group.movements.length - visibleMovements.length);

  return (
    <>
      <tr
        onClick={onToggle}
        className="border-t border-[var(--gray-200)] cursor-pointer hover:bg-[var(--gray-50)] transition-colors"
        style={{ background: expanded ? 'var(--gray-50)' : undefined }}
      >
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            {expanded
              ? <ChevronDown className="h-4 w-4 text-[var(--gray-500)]" strokeWidth={1.75} />
              : <ChevronRight className="h-4 w-4 text-[var(--gray-500)]" strokeWidth={1.75} />}
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-[var(--gray-950)]">{group.label}</span>
                {group.containsToday && (
                  <span className="inline-flex h-5 items-center rounded-full bg-[var(--primary-muted,var(--gray-100))] px-2 text-[10px] font-medium text-[var(--primary,var(--gray-700))]">
                    En curso
                  </span>
                )}
              </div>
              {group.sublabel && (
                <div className="text-[11px] text-[var(--gray-400)]">{group.sublabel}</div>
              )}
            </div>
          </div>
        </td>
        <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap" style={{ color: 'var(--success)' }}>
          {group.inflowTotal > 0 ? fmtCompact(group.inflowTotal) : '—'}
        </td>
        <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap" style={{ color: 'var(--danger)' }}>
          {group.outflowTotal > 0 ? `-${fmtCompact(group.outflowTotal)}` : '—'}
        </td>
        <td
          className="px-4 py-3 text-right tabular-nums whitespace-nowrap font-semibold"
          style={{ color: netColor(group.netTotal) }}
        >
          {formatNet(group.netTotal)}
        </td>
        <td className="px-4 py-3 text-right tabular-nums text-[var(--gray-500)] whitespace-nowrap">
          {group.movements.length}
        </td>
        <td className="px-4 py-3 text-right">
          <span className="text-[11px] font-medium text-[var(--gray-400)]">
            {expanded ? 'Ocultar' : 'Ver'}
          </span>
        </td>
      </tr>
      {expanded && group.movements.length > 0 && (
        <tr>
          <td colSpan={6} className="p-0 bg-white">
            <div className="border-t border-[var(--gray-200)]">
              <table className="w-full text-[12.5px]">
                <thead className="text-left text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)] bg-[var(--gray-50)]/50">
                  <tr>
                    <th className="px-4 py-2 pl-10">Fecha</th>
                    <th className="px-4 py-2">Tipo</th>
                    <th className="px-4 py-2">Contraparte</th>
                    <th className="px-4 py-2">Concepto</th>
                    <th className="px-4 py-2 text-right">Monto</th>
                    <th className="px-4 py-2">Estado</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleMovements.map((movement) => (
                    <tr
                      key={movement.id}
                      className="border-t border-[var(--gray-100)] cursor-pointer hover:bg-[var(--gray-50)] transition-colors"
                      onClick={(event) => {
                        event.stopPropagation();
                        const rect = event.currentTarget.getBoundingClientRect();
                        onSelectMovement(movement, rect);
                      }}
                    >
                      <td className="px-4 py-2.5 pl-10 tabular-nums text-[var(--gray-700)] whitespace-nowrap">
                        {effectiveMovementDate(movement)}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <span
                          className="inline-flex h-5 items-center rounded-full px-1.5 text-[10px] font-medium"
                          style={{
                            background: movement.type === 'INFLOW' ? 'var(--success-muted)' : 'var(--danger-muted)',
                            color: movement.type === 'INFLOW' ? 'var(--success)' : 'var(--danger)',
                          }}
                        >
                          {movement.type === 'INFLOW' ? 'Ingreso' : 'Egreso'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 max-w-[220px]">
                        <div className="truncate font-medium text-[var(--gray-950)]">
                          {movement.counterpartyName ?? '—'}
                        </div>
                        <div className="text-[10.5px] text-[var(--gray-400)]">
                          {counterpartyTypeLabel(movement.counterpartyType)}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 max-w-[280px]">
                        <div className="truncate text-[var(--gray-700)]">{movement.concept}</div>
                        <div className="text-[10.5px] text-[var(--gray-400)] truncate">
                          {movement.ruleApplied ?? movement.category}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-medium text-[var(--gray-950)] whitespace-nowrap">
                        {fmtCurrency(effectiveAmount(movement))}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <div className="flex items-center gap-1">
                          <StatusBadge status={movement.status} />
                          <ConfidenceBadge band={movement.confidenceBand} />
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        <span className="text-[10.5px] font-medium text-[var(--primary)]">Detalle →</span>
                      </td>
                    </tr>
                  ))}
                  {hiddenCount > 0 && (
                    <tr className="border-t border-[var(--gray-100)]">
                      <td colSpan={7} className="px-4 py-3 pl-10">
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            setVisibleLimit((current) => current + 120);
                          }}
                          className="inline-flex h-9 items-center rounded-lg border border-[var(--gray-200)] bg-white px-3 text-[12px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)]"
                        >
                          Cargar 120 más · faltan {hiddenCount}
                        </button>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function buildMovementGroups(
  movements: FinancialMovement[],
  groupBy: GroupBy,
  granularity: ProjectionGranularity,
  today: string,
): MovementGroup[] {
  const buckets = new Map<string, FinancialMovement[]>();
  for (const movement of movements) {
    const key = groupKeyFor(movement, groupBy, granularity);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(movement);
  }
  const groups: MovementGroup[] = [];
  for (const [key, items] of buckets) {
    let inflowTotal = 0;
    let outflowTotal = 0;
    for (const movement of items) {
      const amount = effectiveAmount(movement);
      if (movement.type === 'INFLOW') inflowTotal += amount;
      else outflowTotal += amount;
    }
    items.sort((a, b) => {
      const da = a.actualDate ?? a.adjustedDate ?? a.projectedDate;
      const db = b.actualDate ?? b.adjustedDate ?? b.projectedDate;
      return da.localeCompare(db);
    });
    const labelInfo = groupLabelFor(key, groupBy, granularity, items, today);
    groups.push({
      key,
      label: labelInfo.label,
      sublabel: labelInfo.sublabel,
      movements: items,
      inflowTotal,
      outflowTotal,
      netTotal: inflowTotal - outflowTotal,
      containsToday: labelInfo.containsToday,
    });
  }
  if (groupBy === 'period') {
    groups.sort((a, b) => a.key.localeCompare(b.key));
  } else {
    groups.sort((a, b) => {
      const sizeDiff = b.movements.length - a.movements.length;
      if (sizeDiff !== 0) return sizeDiff;
      return Math.abs(b.netTotal) - Math.abs(a.netTotal);
    });
  }
  return groups;
}

function groupKeyFor(
  movement: FinancialMovement,
  groupBy: GroupBy,
  granularity: ProjectionGranularity,
): string {
  if (groupBy === 'counterparty') return movement.counterpartyType ?? '__UNCATEGORIZED__';
  if (groupBy === 'category') return movement.category;
  const date = movement.actualDate ?? movement.adjustedDate ?? movement.projectedDate;
  if (granularity === 'daily') return date;
  if (granularity === 'monthly') return date.slice(0, 7);
  // weekly: lunes ISO de esa semana
  const d = new Date(`${date}T00:00:00.000Z`);
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (dow - 1));
  return d.toISOString().slice(0, 10);
}

function groupLabelFor(
  key: string,
  groupBy: GroupBy,
  granularity: ProjectionGranularity,
  items: FinancialMovement[],
  today: string,
): { label: string; sublabel?: string; containsToday?: boolean } {
  if (groupBy === 'counterparty') {
    const realKey = key === '__UNCATEGORIZED__' ? undefined : key;
    return {
      label: counterpartyTypeLabel(realKey),
      sublabel: `${items.length} ${items.length === 1 ? 'movimiento' : 'movimientos'}`,
    };
  }
  if (groupBy === 'category') {
    return {
      label: categoryLabel(key),
      sublabel: `${items.length} ${items.length === 1 ? 'movimiento' : 'movimientos'}`,
    };
  }
  if (granularity === 'daily') {
    return {
      label: fmtDate(key),
      sublabel: `${items.length} ${items.length === 1 ? 'movimiento' : 'movimientos'}`,
      containsToday: key === today,
    };
  }
  if (granularity === 'monthly') {
    return {
      label: fmtYearMonthLong(key),
      sublabel: `${items.length} ${items.length === 1 ? 'movimiento' : 'movimientos'}`,
      containsToday: key === today.slice(0, 7),
    };
  }
  // weekly
  const start = new Date(`${key}T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const startISO = start.toISOString().slice(0, 10);
  const endISO = end.toISOString().slice(0, 10);
  return {
    label: `${fmtDate(start)} – ${fmtDate(end)}`,
    sublabel: `Semana · ${items.length} ${items.length === 1 ? 'movimiento' : 'movimientos'}`,
    containsToday: today >= startISO && today <= endISO,
  };
}

function defaultExpandedKey(
  groups: MovementGroup[],
  groupBy: GroupBy,
  today: string,
): string {
  if (groupBy === 'period') {
    const containing = groups.find((g) => g.containsToday);
    if (containing) return containing.key;
    const upcoming = groups.find((g) => g.key >= today);
    if (upcoming) return upcoming.key;
  }
  return groups[0].key;
}

function netColor(value: number): string {
  if (value > 0) return 'var(--success)';
  if (value < 0) return 'var(--danger)';
  return 'var(--gray-700)';
}

function formatNet(value: number): string {
  if (value === 0) return '$0';
  const sign = value > 0 ? '+' : '-';
  return `${sign}${fmtCompact(Math.abs(value))}`;
}

function categoryLabel(category: string): string {
  switch (category) {
    case 'AR_COLLECTION': return 'Cobranza (AR)';
    case 'AP_PAYMENT': return 'Pago a proveedores (AP)';
    case 'PAYROLL': return 'Nómina';
    case 'TAX': return 'Impuestos';
    case 'DEBT': return 'Deuda';
    case 'CAPEX': return 'CAPEX';
    case 'OPEX': return 'OPEX';
    case 'TRANSFER': return 'Transferencia';
    case 'MANUAL': return 'Manual';
    default: return category;
  }
}

function ProjectionScenarioDetail({
  scenarios,
  activeScenario,
  activeScenarioId,
  onSelect,
  comparison,
  manualEntries,
  adjustments,
  taxView,
  supplierAlerts,
}: {
  scenarios: FinancialScenario[];
  activeScenario: FinancialScenario;
  activeScenarioId: string;
  onSelect: (id: string) => void;
  comparison?: ScenarioComparison;
  manualEntries: ManualPlanningEntry[];
  adjustments: FinancialAdjustment[];
  taxView: TaxDashboardView;
  supplierAlerts: SupplierCriticalAlert[];
}) {
  const taxPayable = taxView.totals.total;
  const criticalSuppliers = supplierAlerts.filter((alert) => alert.severity === 'CRITICAL').length;
  return (
    <section className="rounded-2xl border border-[var(--gray-200)] bg-white">
      <div className="flex flex-col gap-3 border-b border-[var(--gray-200)] px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight text-[var(--gray-950)]">Detalle de escenarios</h2>
          <p className="mt-0.5 text-[12px] text-[var(--gray-400)]">
            Base vigente contra escenario activo, incluyendo altas manuales, impuestos y proveedores críticos.
          </p>
        </div>
        <select
          value={activeScenarioId}
          onChange={(event) => onSelect(event.target.value)}
          className="h-10 min-w-[260px] rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)]"
        >
          {scenarios.map((scenario) => (
            <option key={scenario.id} value={scenario.id}>
              {scenario.name}{scenario.archivedAt ? ' · archivado' : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-3 px-4 py-3 md:grid-cols-2 xl:grid-cols-5">
        <ScenarioMiniStat label="Caja vs base" value={comparison ? formatDelta(comparison.finalCashDelta) : 'Base'} tone={!comparison || comparison.finalCashDelta >= 0 ? 'success' : 'danger'} />
        <ScenarioMiniStat label="Días déficit" value={comparison ? `${comparison.deficitDays}` : '0'} tone={comparison && comparison.deficitDays > 0 ? 'danger' : 'neutral'} />
        <ScenarioMiniStat label="Altas manuales" value={String(manualEntries.length)} tone={manualEntries.length > 0 ? 'warning' : 'neutral'} />
        <ScenarioMiniStat label="Impuestos" value={fmtCompact(taxPayable)} tone={taxPayable > 0 ? 'warning' : 'neutral'} />
        <ScenarioMiniStat label="Prov. críticos" value={String(criticalSuppliers)} tone={criticalSuppliers > 0 ? 'danger' : 'neutral'} />
      </div>
      <div className="grid gap-3 border-t border-[var(--gray-200)] px-4 py-3 lg:grid-cols-3">
        <ScenarioChangeList
          title="Altas manuales"
          empty="Sin altas manuales."
          items={manualEntries.slice(0, 5).map((entry) => `${entry.name} · ${fmtCompact(entry.amount)}`)}
        />
        <ScenarioChangeList
          title="Ajustes"
          empty="Sin ajustes del escenario."
          items={adjustments.slice(0, 5).map((adjustment) => adjustment.name)}
        />
        <ScenarioChangeList
          title="Fiscal / proveedores"
          empty="Sin alertas críticas."
          items={[
            ...taxView.periods.filter((row) => row.total > 0).slice(0, 3).map((row) => `${row.period} · ${fmtCompact(row.total)}`),
            ...supplierAlerts.filter((alert) => alert.severity === 'CRITICAL').slice(0, 2).map((alert) => `${alert.providerName} · ${alert.statusLabel}`),
          ]}
        />
      </div>
      {activeScenario.archivedAt && (
        <div className="border-t border-[var(--gray-200)] px-4 py-2 text-[12px] text-[var(--gray-500)]">
          Base archivada el {fmtDate(activeScenario.archivedAt.slice(0, 10))}; se conserva para auditoría.
        </div>
      )}
    </section>
  );
}

function ScenarioMiniStat({
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

function ScenarioChangeList({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: string[];
}) {
  return (
    <div>
      <div className="text-[11px] font-semibold text-[var(--gray-950)]">{title}</div>
      <div className="mt-2 space-y-1.5">
        {items.length === 0 ? (
          <div className="text-[12px] text-[var(--gray-400)]">{empty}</div>
        ) : (
          items.map((item, index) => (
            <div key={`${item}-${index}`} className="truncate rounded-lg border border-[var(--gray-200)] bg-white px-2.5 py-1.5 text-[11px] text-[var(--gray-700)]">
              {item}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function SupplierCriticalAlertsPanel({
  alerts,
  selectedAlert,
  onSelect,
}: {
  alerts: SupplierCriticalAlert[];
  selectedAlert: SupplierCriticalAlert | null;
  onSelect: (alert: SupplierCriticalAlert | null) => void;
}) {
  const visible = alerts.slice(0, 10);
  return (
    <section className="rounded-2xl border border-[var(--gray-200)] bg-white">
      <div className="flex items-start justify-between gap-3 border-b border-[var(--gray-200)] px-4 py-3">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight text-[var(--gray-950)]">Proveedores críticos</h2>
          <p className="mt-0.5 text-[12px] text-[var(--gray-400)]">Pagado real, programado, parcial o pendiente.</p>
        </div>
        <ShieldAlert className="h-5 w-5 text-[var(--warning)]" strokeWidth={1.5} />
      </div>
      <div className="divide-y divide-[var(--gray-100)]">
        {visible.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-[var(--gray-400)]">Sin alertas de proveedores críticos.</div>
        ) : (
          visible.map((alert) => (
            <button
              key={alert.id}
              onClick={() => onSelect(selectedAlert?.id === alert.id ? null : alert)}
              className="block w-full px-4 py-3 text-left hover:bg-[var(--gray-50)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-[var(--gray-950)]">{alert.providerName}</div>
                  <div className="mt-0.5 text-[11px] text-[var(--gray-400)]">
                    {alert.invoiceNumber ? `Factura ${alert.invoiceNumber}` : 'Factura s/n'} · {alert.dueDate ? `vence ${fmtDate(alert.dueDate)}` : 'sin vencimiento'}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium ${supplierAlertClass(alert.severity)}`}>
                    {alert.statusLabel}
                  </span>
                  <div className="mt-1 text-[12px] font-semibold tabular-nums text-[var(--gray-950)]">{fmtCompact(alert.pendingAmount)}</div>
                </div>
              </div>
              {selectedAlert?.id === alert.id && (
                <div className="mt-3 grid gap-2 rounded-xl border border-[var(--gray-200)] bg-white p-3 text-[11px] text-[var(--gray-600)]">
                  <div>{alert.detail}</div>
                  <div>Programado: {fmtCurrency(alert.scheduledAmount)} · Manual: {fmtCurrency(alert.manualAmount)}</div>
                  <div>Evidencia banco/JDE: {alert.bankEvidenceCount}</div>
                </div>
              )}
            </button>
          ))
        )}
      </div>
    </section>
  );
}

function supplierAlertClass(severity: SupplierCriticalAlert['severity']): string {
  if (severity === 'CRITICAL') return 'bg-[var(--danger)]/10 text-[var(--danger)]';
  if (severity === 'WARNING') return 'bg-[var(--warning-muted)] text-[var(--warning)]';
  return 'bg-[var(--success)]/10 text-[var(--success)]';
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
      {label && (
        <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">
          {label}
        </span>
      )}
      <div className="inline-flex h-9 items-center rounded-xl border border-[var(--gray-200)] bg-white p-0.5">
        {options.map((option) => {
          const active = value === option.id;
          return (
            <button
              key={option.id}
              onClick={() => onChange(option.id)}
              aria-pressed={active}
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

function counterpartyTypeLabel(type?: string): string {
  if (!type) return 'Sin contraparte';
  switch (type) {
    case 'CUSTOMER': return 'Cliente';
    case 'SUPPLIER': return 'Proveedor';
    case 'EMPLOYEE': return 'Nómina';
    case 'TAX_AUTHORITY': return 'Autoridad fiscal';
    case 'BANK': return 'Banco';
    case 'INTERNAL': return 'Interno';
    default: return type;
  }
}

function endDateForPreset(preset: RangePreset, today: string, yearEnd: string): string {
  if (preset === 'eoy') return yearEnd;
  const days = preset === '30d' ? 30 : preset === '60d' ? 60 : 90;
  const parsed = new Date(`${today}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function tone(value: number, minimum: number): string {
  if (value < minimum) return 'var(--danger)';
  if (value < minimum * 1.2) return 'var(--warning)';
  return 'var(--gray-950)';
}

function formatDelta(value: number): string {
  if (value === 0) return '±0';
  return `${value > 0 ? '+' : ''}${fmtCompact(value)}`;
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
