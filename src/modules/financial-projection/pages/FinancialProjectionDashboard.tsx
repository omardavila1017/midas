import { useMemo, useState } from 'react';
import { AlertTriangle, CalendarDays, RotateCcw } from 'lucide-react';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import { fmtCompact } from '../../../formatters';
import {
  calculateBaseProjection,
  calculateScenarioProjection,
  compareProjectionVsScenario,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type { FinancialMovement, ProjectionGranularity } from '../../shared-finance/types';
import { ProjectionKpiCards } from '../components/ProjectionKpiCards';
import { CashFlowChart } from '../components/CashFlowChart';
import { ProjectionTable, type ProjectionTableFilters } from '../components/ProjectionTable';
import { MovementDrillDownDrawer } from '../components/MovementDrillDownDrawer';
import {
  CustomerCollectionPanel,
  SupplierRiskPanel,
} from '../components/FinanceContextPanels';
import {
  buildFinancialProjectionSourceData,
  calculateInitialCash,
} from '../services/financialProjectionService';
import { loadPlanningAdjustments } from '../../financial-planning/services/financialPlanningStorage';
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

const DEFAULT_FILTERS: ProjectionTableFilters = {
  search: '',
  type: 'ALL',
  category: 'ALL',
  status: 'ALL',
  confidence: 'ALL',
};

const GRANULARITY_LABELS: Record<ProjectionGranularity, string> = {
  daily: 'Diaria',
  weekly: 'Semanal',
  monthly: 'Mensual',
};

/**
 * Proyección Financiera — vista forward-looking, solo lectura.
 *
 * Reglas que cumple este módulo (post-refactor):
 *
 *   1. La trayectoria de caja viene del motor canónico del Dashboard. La
 *      caja final mensual coincide byte-a-byte con la del Dashboard.
 *   2. NO hay fallback a mock data. Si los catálogos no son suficientes,
 *      se muestra empty state con el mismo mensaje que Dashboard.
 *   3. Por defecto el horizonte llega a fin de año (igual que Dashboard).
 *      El usuario puede mover el rango pero no más allá del horizonte
 *      del motor canónico.
 *   4. Crear/editar ajustes vive en Planeación Financiera. Aquí solo se
 *      visualiza y se hace drilldown — antes había un botón "Ajustar"
 *      duplicado que cruzaba responsabilidades.
 *   5. Lenguaje visual idéntico al Dashboard: PageHeader, KpiCard,
 *      tarjetas blancas con border var(--gray-200), tipografía 13/15px.
 */
export default function FinancialProjectionDashboard(props: Props) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // Horizonte default: hoy → fin del año en curso. Mismo criterio que el
  // Dashboard, donde el motor canónico se corta en el último mes del año.
  const yearEnd = useMemo(() => {
    const year = Number(today.slice(0, 4));
    return `${year}-12-31`;
  }, [today]);

  const [granularity, setGranularity] = useState<ProjectionGranularity>('monthly');
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(yearEnd);
  const [filters, setFilters] = useState<ProjectionTableFilters>(DEFAULT_FILTERS);
  const [selectedMovement, setSelectedMovement] = useState<FinancialMovement | null>(null);

  const source = useMemo(
    () => buildFinancialProjectionSourceData({ ...props, asOfDate: today }),
    [props, today],
  );

  // El usuario puede haber creado ajustes en Planeación Financiera. Aquí
  // los leemos solo lectura para mostrar el "qué pasa con esos ajustes
  // aplicados" — la creación/edición sigue viviendo en Planeación.
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
    [baseScenario.id, baseScenario.name, endDate, granularity, props, source.movements, startDate],
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
        return date >= startDate && date <= endDate;
      })
      .sort((a, b) => {
        const da = a.actualDate ?? a.adjustedDate ?? a.projectedDate;
        const db = b.actualDate ?? b.adjustedDate ?? b.projectedDate;
        return da.localeCompare(db);
      }),
    [endDate, previewProjection.movements, startDate],
  );

  const resetView = () => {
    setFilters(DEFAULT_FILTERS);
    setGranularity('monthly');
    setStartDate(today);
    setEndDate(yearEnd);
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
    <div className="space-y-5">
      <PageHeader
        title="Proyección Financiera"
        actions={
          <button
            onClick={resetView}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[13px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)]"
          >
            <RotateCcw className="h-4 w-4" strokeWidth={1.5} />
            Restablecer vista
          </button>
        }
      />
      <p className="text-[12px] text-[var(--gray-500)] -mt-3 max-w-[820px]">
        Calcula la trayectoria de caja a partir del Dashboard y los movimientos derivados de bancos, cobranza y proveedores.
        Para crear ajustes o escenarios, abre <strong className="text-[var(--gray-700)]">Planeación Financiera</strong>.
      </p>

      {/* Controles compactos: horizonte + granularidad. */}
      <section className="rounded-xl border border-[var(--gray-200)] bg-white px-4 py-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <DateField label="Inicio" value={startDate} onChange={setStartDate} />
            <DateField label="Fin" value={endDate} onChange={setEndDate} />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">
                Granularidad
              </span>
              <div className="inline-flex h-10 items-center rounded-xl border border-[var(--gray-200)] bg-white p-0.5">
                {(['daily', 'weekly', 'monthly'] as ProjectionGranularity[]).map((option) => {
                  const active = granularity === option;
                  return (
                    <button
                      key={option}
                      onClick={() => setGranularity(option)}
                      aria-pressed={active}
                      className="h-9 rounded-lg px-3 text-[12px] font-medium transition-colors"
                      style={{
                        background: active ? 'var(--gray-950)' : 'transparent',
                        color: active ? 'white' : 'var(--gray-700)',
                      }}
                    >
                      {GRANULARITY_LABELS[option]}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex h-10 items-center gap-2 px-3 text-[12px] text-[var(--gray-500)]">
              <CalendarDays className="h-4 w-4" strokeWidth={1.5} />
              {previewProjection.buckets.length} {previewProjection.buckets.length === 1 ? 'periodo' : 'periodos'} ·
              {' '}ingresos {fmtCompact(previewProjection.summary.totalInflows)} · egresos {fmtCompact(previewProjection.summary.totalOutflows)}
            </div>
          </div>
        </div>
      </section>

      <ProjectionKpiCards projection={previewProjection} comparison={comparison} />

      <CashFlowChart
        projection={previewProjection}
        baseProjection={previewProjection.scenarioId === baseProjection.scenarioId ? undefined : baseProjection}
      />

      {/* Solo dos paneles de contexto en Proyección — impuestos quedan
          dentro de Planeación porque ahí se aprueban. Antes ambos
          módulos repetían los tres paneles idénticos. */}
      <div className="grid gap-4 xl:grid-cols-2">
        <CustomerCollectionPanel customers={source.customers} />
        <SupplierRiskPanel suppliers={source.suppliers} />
      </div>

      <ProjectionTable
        movements={tableMovements}
        filters={filters}
        onFiltersChange={setFilters}
        onSelectMovement={setSelectedMovement}
      />

      <MovementDrillDownDrawer
        movement={selectedMovement}
        onClose={() => setSelectedMovement(null)}
      />
    </div>
  );
}

/**
 * Caja mínima por defecto: 30% del piso operativo del Dashboard si está
 * disponible vía budget.expenseTotal[mes]. Si no, $20M (heurística previa).
 * Esto evita que la caja mínima se quede en un número arbitrario distinto
 * al que el Dashboard considera piso operativo.
 */
function minimumCashFor(props: Props): number {
  const fallback = 20_000_000;
  if (!props.budget) return fallback;
  const month = new Date().getUTCMonth();
  const monthlyExpense = props.budget.expenseTotal?.[month] ?? 0;
  return monthlyExpense > 0 ? Math.round(monthlyExpense * 0.3) : fallback;
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)]"
      />
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
        Aún no hay datos suficientes para proyectar
      </h2>
      <p className="mx-auto mt-2 max-w-[480px] text-[12px] leading-relaxed text-[var(--gray-500)]">
        Para que la proyección financiera sea confiable, necesitamos al menos estados de cuenta bancarios
        cargados y uno de los siguientes: catálogo de clientes, antigüedad de saldos, o presupuesto del año.
      </p>
      <p className="mx-auto mt-3 max-w-[480px] text-[12px] text-[var(--gray-400)]">
        Carga los datos desde <strong>Bancos</strong>, <strong>CXP</strong> o <strong>Operativa</strong>{' '}
        y vuelve a esta pestaña.
      </p>
    </div>
  );
}
