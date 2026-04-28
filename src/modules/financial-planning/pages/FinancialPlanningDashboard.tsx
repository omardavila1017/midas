import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Plus, Pencil, Wallet, AlertTriangle as AlertIcon, Banknote } from 'lucide-react';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import { fmtCompact, fmtCurrency } from '../../../formatters';
import {
  calculateBaseProjection,
  calculateScenarioProjection,
  compareProjectionVsScenario,
  effectiveAmount,
  effectiveMovementDate,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import {
  convertLegacyScenariosToFinancial,
  isLegacyScenarioId,
  legacyProposalToAdjustments,
  legacyProposalsForActiveScenario,
  legacyScenarioId,
} from '../../shared-finance/calculation-engine/legacyScenarioBridge';
import { ConfidenceBadge } from '../../shared-finance/components/FinanceBadges';
import type {
  FinancialAdjustment,
  FinancialMovement,
  FinancialScenario,
} from '../../shared-finance/types';
import { CashFlowChart } from '../../financial-projection/components/CashFlowChart';
import {
  buildFinancialProjectionSourceData,
  calculateInitialCash,
} from '../../financial-projection/services/financialProjectionService';
import { AdjustmentEditorPopover } from '../components/AdjustmentEditorPopover';
import KpiCard from '../../../components/ui/KpiCard';
import PageHeader from '../../../components/ui/PageHeader';
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
  legacyProposals: Proposal[];
  legacyScenarios: LegacyScenario[];
  legacyActiveScenarioId?: string | null;
  onLegacyScenariosChange?: (next: LegacyScenario[]) => void;
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
  const horizonYearMonth = yearEnd.slice(0, 7);

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

  const baseScenario: FinancialScenario = useMemo(
    () => source.scenarios.find((s) => s.isBase) ?? source.scenarios[0],
    [source.scenarios],
  );
  const legacyAsFinancial = useMemo(
    () => convertLegacyScenariosToFinancial(props.legacyScenarios),
    [props.legacyScenarios],
  );
  const scenarios = useMemo(() => [baseScenario, ...legacyAsFinancial], [baseScenario, legacyAsFinancial]);

  const initialActiveId = useMemo(() => {
    if (props.legacyActiveScenarioId) {
      return legacyScenarioId({ id: props.legacyActiveScenarioId } as LegacyScenario);
    }
    return legacyAsFinancial[0]?.id ?? baseScenario.id;
  }, [baseScenario.id, legacyAsFinancial, props.legacyActiveScenarioId]);

  const [activeScenarioId, setActiveScenarioId] = useState(initialActiveId);
  const [editorMovement, setEditorMovement] = useState<FinancialMovement | null>(null);
  const [editorAnchor, setEditorAnchor] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!scenarios.some((s) => s.id === activeScenarioId)) {
      setActiveScenarioId(scenarios.find((s) => !s.isBase)?.id ?? scenarios[0]?.id ?? activeScenarioId);
    }
  }, [activeScenarioId, scenarios]);

  const activeScenario = scenarios.find((s) => s.id === activeScenarioId) ?? baseScenario;

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      baseScenario.id,
      baseScenario.name,
      props.bankStatements,
      props.budget,
      props.startingBalance,
      source.movements,
      today,
      yearEnd,
    ],
  );

  const activeAdjustments = useMemo<FinancialAdjustment[]>(() => {
    if (!isLegacyScenarioId(activeScenario.id)) return [];
    const proposals = legacyProposalsForActiveScenario(
      activeScenario.id,
      props.legacyScenarios,
      props.legacyProposals,
    );
    return proposals.flatMap((p) => legacyProposalToAdjustments(p, activeScenario.id, today, horizonYearMonth));
  }, [activeScenario.id, horizonYearMonth, props.legacyProposals, props.legacyScenarios, today]);

  const activeProjection = useMemo(() => {
    if (activeScenario.isBase || activeAdjustments.length === 0) return baseProjection;
    return calculateScenarioProjection(baseProjection, activeScenario, activeAdjustments);
  }, [activeAdjustments, activeScenario, baseProjection]);

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

  const handleCreateLegacyScenario = () => {
    if (!props.onLegacyScenariosChange) return;
    const now = new Date().toISOString();
    const next: LegacyScenario = {
      id: `simulacion-${Date.now()}`,
      name: `Escenario ${props.legacyScenarios.length + 1}`,
      description: 'Creado desde Planeación Financiera.',
      proposalStates: {},
      createdAt: now,
      updatedAt: now,
    };
    props.onLegacyScenariosChange([...props.legacyScenarios, next]);
    setActiveScenarioId(legacyScenarioId(next));
  };

  const handleAdjustClick = (movement: FinancialMovement, anchor: DOMRect) => {
    setEditorMovement(movement);
    setEditorAnchor(anchor);
  };

  const handleSaveAdjustment = () => {
    setEditorMovement(null);
    setEditorAnchor(null);
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
          <button
            onClick={handleCreateLegacyScenario}
            disabled={!props.onLegacyScenariosChange}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-[var(--primary)] px-3 text-[13px] font-medium text-white hover:bg-[var(--primary-hover)] disabled:opacity-40 transition-colors"
          >
            <Plus className="h-4 w-4" strokeWidth={1.5} />
            Nuevo escenario
          </button>
        }
      />

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

      {/* Chart hero. */}
      <CashFlowChart
        projection={activeProjection}
        baseProjection={isLegacyScenarioId(activeScenario.id) ? baseProjection : undefined}
      />

      {/* Tabla de movimientos del escenario activo, single-action. */}
      <section className="rounded-2xl border border-[var(--gray-200)] bg-white">
        <div className="border-b border-[var(--gray-200)] px-4 py-3">
          <h2 className="text-[15px] font-semibold tracking-tight text-[var(--gray-950)]">
            Movimientos del escenario
          </h2>
          <p className="mt-0.5 text-[12px] text-[var(--gray-400)]">
            Click en <strong>Editar</strong> para crear un ajuste sobre <strong>{activeScenario.name}</strong>.
            El movimiento base no se modifica.
          </p>
        </div>
        <PlanningMovementsTable
          movements={activeMovements}
          onAdjust={handleAdjustClick}
        />
      </section>

      <AdjustmentEditorPopover
        movement={editorMovement}
        anchor={editorAnchor}
        scenarios={scenarios}
        defaultScenarioId={activeScenario.id}
        onClose={() => { setEditorMovement(null); setEditorAnchor(null); }}
        onSave={handleSaveAdjustment}
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

function PlanningMovementsTable({
  movements,
  onAdjust,
}: {
  movements: FinancialMovement[];
  onAdjust: (movement: FinancialMovement, anchor: DOMRect) => void;
}) {
  if (movements.length === 0) {
    return (
      <div className="px-4 py-12 text-center text-[12px] text-[var(--gray-400)]">
        Sin movimientos editables para este escenario.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] text-[13px]">
        <thead className="bg-[var(--gray-50)] text-left text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">
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
          {movements.map((movement) => {
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
                className="border-t border-[var(--gray-200)] hover:bg-[var(--gray-50)] transition-colors"
              >
                <td className="px-4 py-3 tabular-nums text-[var(--gray-700)] whitespace-nowrap">
                  {effectiveMovementDate(movement)}
                </td>
                <td className="px-4 py-3 max-w-[300px]">
                  <div className="font-medium text-[var(--gray-950)] truncate">{movement.concept}</div>
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
                  <button
                    onClick={(event) => {
                      if (!editable) return;
                      const rect = event.currentTarget.getBoundingClientRect();
                      onAdjust(movement, rect);
                    }}
                    disabled={!editable}
                    title={editable ? 'Crear ajuste' : lockReason}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--gray-200)] bg-white px-3 text-[12px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
                    Editar
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
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
