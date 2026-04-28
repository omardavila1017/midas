import { useMemo, useState } from 'react';
import { AlertTriangle, RotateCcw, Search } from 'lucide-react';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import { fmtCompact, fmtCurrency } from '../../../formatters';
import {
  calculateBaseProjection,
  calculateScenarioProjection,
  compareProjectionVsScenario,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type { FinancialMovement, ProjectionGranularity } from '../../shared-finance/types';
import { CashFlowChart } from '../components/CashFlowChart';
import { MovementDrillDownDrawer } from '../components/MovementDrillDownDrawer';
import {
  buildFinancialProjectionSourceData,
  calculateInitialCash,
} from '../services/financialProjectionService';
import { loadPlanningAdjustments } from '../../financial-planning/services/financialPlanningStorage';
import { ConfidenceBadge, StatusBadge } from '../../shared-finance/components/FinanceBadges';
import {
  effectiveAmount,
  effectiveMovementDate,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import KpiCard from '../../../components/ui/KpiCard';
import PageHeader from '../../../components/ui/PageHeader';
import { Wallet, AlertTriangle as AlertIcon, ArrowDownCircle, ArrowUpCircle } from 'lucide-react';

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

  const adjustments = useMemo(() => loadPlanningAdjustments([]), []);
  const baseScenario = source.scenarios.find((scenario) => scenario.isBase) ?? source.scenarios[0];
  const previewScenario = source.scenarios.find((scenario) => !scenario.isBase);

  const baseProjection = useMemo(
    () => calculateBaseProjection(source.movements, {
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
      source.movements,
      startDate,
    ],
  );

  const previewProjection = useMemo(() => {
    if (!previewScenario || adjustments.length === 0) return baseProjection;
    return calculateScenarioProjection(baseProjection, previewScenario, adjustments, { granularity });
  }, [adjustments, baseProjection, granularity, previewScenario]);

  const comparison = previewScenario && adjustments.length > 0
    ? compareProjectionVsScenario(baseProjection, previewProjection)
    : undefined;

  const tableMovements = useMemo(
    () => previewProjection.movements
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
      })
      .slice(0, 200),
    [endDate, previewProjection.movements, search, startDate, typeFilter],
  );

  const resetView = () => {
    setSearch('');
    setTypeFilter('ALL');
    setGranularity('weekly');
    setPreset('eoy');
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

  const summary = previewProjection.summary;

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
              {previewProjection.buckets.length} {previewProjection.buckets.length === 1 ? 'periodo' : 'periodos'}
            </span>
          </div>
        </div>
      </section>

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
        projection={previewProjection}
        baseProjection={previewProjection.scenarioId === baseProjection.scenarioId ? undefined : baseProjection}
      />

      {/* Tabla con filtros inline en su mismo header — sin card extra. */}
      <section className="rounded-2xl border border-[var(--gray-200)] bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--gray-200)] px-4 py-3">
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight text-[var(--gray-950)]">
              Movimientos proyectados
            </h2>
            <p className="mt-0.5 text-[12px] text-[var(--gray-400)]">
              {tableMovements.length} {tableMovements.length === 1 ? 'movimiento' : 'movimientos'} en el rango.
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
        <MovementsTable
          movements={tableMovements}
          onSelectMovement={handleSelectMovement}
        />
      </section>

      <MovementDrillDownDrawer
        movement={drillMovement}
        anchor={drillAnchor}
        onClose={() => { setDrillMovement(null); setDrillAnchor(null); }}
      />
    </div>
  );
}

/**
 * Tabla densa, embebida en el card padre (no card propio) para que el
 * conjunto (header + tabla) se lea como una sola unidad.
 */
function MovementsTable({
  movements,
  onSelectMovement,
}: {
  movements: FinancialMovement[];
  onSelectMovement: (movement: FinancialMovement, anchor: DOMRect) => void;
}) {
  if (movements.length === 0) {
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
            <th className="px-4 py-2.5">Fecha</th>
            <th className="px-4 py-2.5">Tipo</th>
            <th className="px-4 py-2.5">Contraparte</th>
            <th className="px-4 py-2.5">Concepto</th>
            <th className="px-4 py-2.5 text-right">Monto</th>
            <th className="px-4 py-2.5">Estado</th>
            <th className="px-4 py-2.5"></th>
          </tr>
        </thead>
        <tbody>
          {movements.map((movement) => (
            <tr
              key={movement.id}
              className="border-t border-[var(--gray-200)] cursor-pointer hover:bg-[var(--gray-50)] transition-colors"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                onSelectMovement(movement, rect);
              }}
            >
              <td className="px-4 py-3 tabular-nums text-[var(--gray-700)] whitespace-nowrap">
                {effectiveMovementDate(movement)}
              </td>
              <td className="px-4 py-3 whitespace-nowrap">
                <span
                  className="inline-flex h-6 items-center rounded-full px-2 text-[11px] font-medium"
                  style={{
                    background: movement.type === 'INFLOW' ? 'var(--success-muted)' : 'var(--danger-muted)',
                    color: movement.type === 'INFLOW' ? 'var(--success)' : 'var(--danger)',
                  }}
                >
                  {movement.type === 'INFLOW' ? 'Ingreso' : 'Egreso'}
                </span>
              </td>
              <td className="px-4 py-3 max-w-[240px]">
                <div className="truncate font-medium text-[var(--gray-950)]">
                  {movement.counterpartyName ?? '—'}
                </div>
                <div className="text-[11px] text-[var(--gray-400)]">
                  {counterpartyTypeLabel(movement.counterpartyType)}
                </div>
              </td>
              <td className="px-4 py-3 max-w-[300px]">
                <div className="truncate text-[var(--gray-700)]">{movement.concept}</div>
                <div className="text-[11px] text-[var(--gray-400)] truncate">
                  {movement.ruleApplied ?? movement.category}
                </div>
              </td>
              <td className="px-4 py-3 text-right tabular-nums font-medium text-[var(--gray-950)] whitespace-nowrap">
                {fmtCurrency(effectiveAmount(movement))}
              </td>
              <td className="px-4 py-3 whitespace-nowrap">
                <div className="flex items-center gap-1.5">
                  <StatusBadge status={movement.status} />
                  <ConfidenceBadge band={movement.confidenceBand} />
                </div>
              </td>
              <td className="px-4 py-3 text-right">
                <span className="text-[11px] font-medium text-[var(--primary)]">Ver detalle →</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
