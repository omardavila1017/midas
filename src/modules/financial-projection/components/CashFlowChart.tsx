import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { fmtCompact, fmtCurrency } from '../../../formatters';
import type {
  FinancialMovement,
  ForecastRun,
  ProbabilisticForecastRun,
  ProjectionBucket,
} from '../../shared-finance/types';
import {
  effectiveAmount,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';

interface CategoryBreakdown {
  key: string;
  label: string;
  inflows: number;
  outflows: number;
  movements: FinancialMovement[];
}

interface SupplierLine {
  name: string;
  amount: number;
  count: number;
}

function isRealMovement(movement: FinancialMovement): boolean {
  return movement.status === 'REAL'
    || movement.status === 'EXECUTED'
    || movement.sourceSystem === 'BANK'
    || Boolean(movement.actualDate);
}

function buildCategoryBreakdown(movements: FinancialMovement[]): CategoryBreakdown[] {
  const map = new Map<string, { inflows: number; outflows: number; movements: FinancialMovement[] }>();
  for (const m of movements) {
    const key = m.category;
    const entry = map.get(key) ?? { inflows: 0, outflows: 0, movements: [] };
    const amount = effectiveAmount(m);
    if (m.type === 'INFLOW') entry.inflows += amount;
    else entry.outflows += amount;
    entry.movements.push(m);
    map.set(key, entry);
  }
  const labels: Record<string, string> = {
    AR_COLLECTION: 'Cobranza',
    AP_PAYMENT: 'Proveedores',
    PAYROLL: 'Nómina',
    TAX: 'Impuestos',
    DEBT: 'Deuda',
    CAPEX: 'CAPEX',
    OPEX: 'OPEX',
    TRANSFER: 'Otros Egresos',
    MANUAL: 'Manual',
  };
  return Array.from(map.entries())
    .map(([key, data]) => ({
      key,
      label: labels[key] ?? key,
      ...data,
    }))
    .sort((a, b) => (b.inflows + b.outflows) - (a.inflows + a.outflows));
}

function buildSupplierLines(movements: FinancialMovement[]): SupplierLine[] {
  const map = new Map<string, { amount: number; count: number }>();
  for (const m of movements) {
    const name = m.counterpartyName ?? 'Sin nombre';
    const entry = map.get(name) ?? { amount: 0, count: 0 };
    entry.amount += effectiveAmount(m);
    entry.count += 1;
    map.set(name, entry);
  }
  return Array.from(map.entries())
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.amount - a.amount);
}

const MONTH_LABELS_SHORT_ES = [
  'ene', 'feb', 'mar', 'abr', 'may', 'jun',
  'jul', 'ago', 'sep', 'oct', 'nov', 'dic',
];

// Tooltip header for the projection chart. Granularity-aware so the
// monthly view shows "ene 2026" instead of the raw bucket start date
// "2026-01-01" (Recharts pasaba el ISO crudo y se leía como "1 de enero").
function formatBucketHeader(rawDate: string, granularity: ForecastRun['granularity']): string {
  if (!rawDate) return '';
  const [y, m, d] = rawDate.split('-').map(Number);
  if (!y || !m) return rawDate;
  const monthName = MONTH_LABELS_SHORT_ES[(m - 1) % 12];
  if (granularity === 'monthly') return `${monthName} ${y}`;
  if (granularity === 'weekly') return `Sem ${d ?? 1} ${monthName} ${y}`;
  return `${d ?? 1} ${monthName} ${y}`;
}

// KeepAlivePanel (App.tsx) keeps inactive modules mounted with `display:none`.
// A still-mounted Recharts ResponsiveContainer then measures 0×0 every
// hide/show and floods the console. Gate the chart on the container actually
// having a box so it skips render (and Recharts work) while hidden.
function useHasBox<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [hasBox, setHasBox] = useState(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setHasBox(el.offsetWidth > 0 && el.offsetHeight > 0);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, hasBox] as const;
}

function CashFlowChartImpl({
  projection,
  baseProjection,
  comparisonProjection,
  probabilisticProjection,
  onNavigateToTax,
  operatingFloor,
}: {
  projection: ForecastRun;
  baseProjection?: ForecastRun;
  comparisonProjection?: ForecastRun;
  probabilisticProjection?: ProbabilisticForecastRun | null;
  onNavigateToTax?: () => void;
  /**
   * Piso operativo mensual (proveedores Operación + nómina). Rescatado del
   * Dashboard. Sólo tiene sentido como línea plana en granularidad mensual,
   * así que el padre pasa `undefined` en semanal/diario.
   */
  operatingFloor?: number;
}) {
  const showFloor = typeof operatingFloor === 'number' && operatingFloor > 0;
  const [chartBoxRef, chartHasBox] = useHasBox<HTMLDivElement>();
  const [selectedBucketIdx, setSelectedBucketIdx] = useState<number | null>(null);

  // At daily resolution we render ~365 bars in a few hundred px — individual
  // bars become a fraction of a pixel wide and clicking a specific day is
  // not a useful interaction. We disable the click target there both to
  // avoid the misleading affordance and to skip the hover/click state work
  // Recharts performs per-bar.
  const interactiveBars = projection.buckets.length <= 56;
  // High-bucket-count guard (2026-05-20): at daily granularity Recharts was
  // rendering ~95 bars × 8 series (~760 SVG nodes), which combined with
  // grain-flip churn caused "Aw Snap" OOM after 3-4 flips. Skip optional
  // overlay series (base/comparison closing-cash, probabilistic risk band)
  // when buckets exceed the threshold — the user can still compare via the
  // ScenarioComparisonBar above; the chart focuses on the active line. KPIs
  // and tooltips read from `data` (which keeps the values), so only the
  // visual overlay is gated.
  const renderOverlaySeries = projection.buckets.length <= 56;

  // movementById is gran-independent — only rebuilds when projection.movements
  // ref changes (new scenario run). Splitting it out of `data` skips an 88k
  // Map.set loop on every grain flip when only buckets changed.
  const movementById = useMemo(() => {
    const m = new Map<string, FinancialMovement>();
    for (const x of projection.movements) m.set(x.id, x);
    return m;
  }, [projection.movements]);

  const data = useMemo(() => {
    // Build O(1) lookups for the optional series so the main loop stays a
    // single pass over the active buckets. Skip them entirely when overlay
    // series won't render (daily+ granularity) — the Maps over a 365-bucket
    // baseProjection are wasteful if no Line consumes them.
    const baseByDate = renderOverlaySeries && baseProjection?.buckets.length
      ? new Map(baseProjection.buckets.map((bucket) => [bucket.date, bucket.closingCash]))
      : null;
    const comparisonByDate = renderOverlaySeries && comparisonProjection?.buckets.length
      ? new Map(comparisonProjection.buckets.map((bucket) => [bucket.date, bucket.closingCash]))
      : null;
    const probabilisticByDate = renderOverlaySeries && probabilisticProjection?.buckets.length
      ? new Map(probabilisticProjection.buckets.map((bucket) => [bucket.date, bucket]))
      : null;
    const activeBuckets = projection.buckets;
    const out = new Array(activeBuckets.length);
    for (let i = 0; i < activeBuckets.length; i++) {
      const bucket = activeBuckets[i];
      // Split bucket totals into real vs projected so the chart can render
      // solid bars for what already happened and striped bars for what's
      // still forecast — same convention as Flujo mensual on the Dashboard.
      // Mes en curso queda mixto: días pasados ya están como BANK/REAL,
      // días por venir entran como PROJECTED_BASE.
      let realInflows = 0;
      let realOutflows = 0;
      for (const id of bucket.movementIds) {
        const movement = movementById.get(id);
        if (!movement) continue;
        const amount = effectiveAmount(movement);
        if (isRealMovement(movement)) {
          if (movement.type === 'INFLOW') realInflows += amount;
          else realOutflows += amount;
        }
      }
      const realInflowsClamped = Math.min(realInflows, bucket.inflows);
      const realOutflowsClamped = Math.min(realOutflows, bucket.outflows);
      out[i] = {
        date: bucket.label,
        rawDate: bucket.date,
        entradasReal: realInflowsClamped,
        entradasProy: Math.max(0, bucket.inflows - realInflowsClamped),
        salidasReal: realOutflowsClamped,
        salidasProy: Math.max(0, bucket.outflows - realOutflowsClamped),
        entradasTotal: bucket.inflows,
        salidasTotal: bucket.outflows,
        caja: bucket.closingCash,
        minimo: bucket.minimumCash,
        base: baseByDate ? baseByDate.get(bucket.date) : undefined,
        comparison: comparisonByDate ? comparisonByDate.get(bucket.date) : undefined,
        riskBand: probabilisticByDate?.get(bucket.date)
          ? [
            probabilisticByDate.get(bucket.date)?.cash.p10 ?? bucket.closingCash,
            probabilisticByDate.get(bucket.date)?.cash.p90 ?? bucket.closingCash,
          ]
          : undefined,
        piso: showFloor ? operatingFloor : undefined,
      };
    }
    return out;
  }, [
    projection.buckets,
    movementById,
    baseProjection?.buckets,
    comparisonProjection?.buckets,
    probabilisticProjection?.buckets,
    showFloor,
    operatingFloor,
    renderOverlaySeries,
  ]);

  // Reset the open breakdown when the underlying buckets change shape (e.g.
  // granularity flipped) — the previous index would point to the wrong row.
  useEffect(() => {
    setSelectedBucketIdx(null);
  }, [projection.buckets]);

  const selectedBucket = selectedBucketIdx != null ? projection.buckets[selectedBucketIdx] : null;

  const breakdown = useMemo(() => {
    if (!selectedBucket) return null;
    const idSet = new Set(selectedBucket.movementIds);
    const movements: FinancialMovement[] = [];
    for (const m of projection.movements) if (idSet.has(m.id)) movements.push(m);
    return buildCategoryBreakdown(movements);
  }, [selectedBucket, projection.movements]);

  const handleBarClick = useMemo(
    () => interactiveBars
      ? (_data: unknown, index: number) => {
        setSelectedBucketIdx((prev) => (prev === index ? null : index));
      }
      : undefined,
    [interactiveBars],
  );

  return (
    <section className="rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-bold tracking-tight text-[var(--gray-950)]">
            Caja proyectada
          </h2>
          <p className="mt-1 text-[12px] text-[var(--gray-400)]">
            La línea azul es el saldo de caja. Las barras son ingresos y egresos
            del periodo: relleno sólido = real, rayado = proyectado.
            {interactiveBars ? ' Clic en una barra para el desglose.' : ''}
          </p>
        </div>
        <div className="text-right text-[12px] text-[var(--gray-400)]">
          {projection.startDate} → {projection.endDate}
        </div>
      </div>
      {/* Patrones SVG para las barras proyectadas — convenio idéntico al
          chart de Flujo mensual del Dashboard: relleno sólido = real,
          relleno rayado = proyectado. */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <defs>
          <pattern id="cfcHatchIncome" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="#ecfdf5" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="#10b981" strokeWidth="2.5" />
          </pattern>
          <pattern id="cfcHatchExpense" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="#fef2f2" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="#ef4444" strokeWidth="2.5" />
          </pattern>
        </defs>
      </svg>
      <div ref={chartBoxRef} className="mt-4" style={{ height: 340 }}>
        {/* `debounce` rate-limits Recharts' resize storm during layout shifts
            (the page has many collapsibles), which used to thrash the chart
            on first mount. `isAnimationActive=false` on every series cuts
            Recharts' default 1500ms enter animation — silky immediate paint
            instead of a 1.5s cascade where each series re-tweens. */}
        {chartHasBox && (
        <ResponsiveContainer width="100%" height="100%" debounce={120}>
          <ComposedChart data={data} margin={{ top: 12, right: 8, bottom: 0, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" className="recharts-cartesian-grid" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: 'var(--gray-400)' }}
              minTickGap={18}
              tickFormatter={(v: string) => {
                if (projection.granularity !== 'monthly') return v;
                const [yy, mm] = v.split('-').map(Number);
                if (!yy || !mm) return v;
                return `${MONTH_LABELS_SHORT_ES[(mm - 1) % 12]} ${String(yy).slice(2)}`;
              }}
            />
            {/* Un solo eje: el doble eje (flujo izq / saldo der) mostraba dos
                escalas distintas sobre la misma rejilla, así que la línea no
                "matcheaba" con sus gridlines y confundía. El chart es "Caja
                proyectada" → el saldo (línea) es el valor primario; las barras
                comparten esa escala. El eje incluye negativos para que el
                déficit se vea. */}
            <YAxis
              tickFormatter={fmtCompact}
              tick={{ fontSize: 11, fill: 'var(--gray-400)' }}
              width={60}
            />
            <Tooltip
              formatter={(value: number | [number, number], name: string) => {
                if (Array.isArray(value)) return [`${fmtCurrency(value[0])} a ${fmtCurrency(value[1])}`, name];
                return [fmtCurrency(value), name];
              }}
              labelFormatter={(_, payload) => formatBucketHeader(payload?.[0]?.payload?.rawDate ?? '', projection.granularity)}
              isAnimationActive={false}
              contentStyle={{
                border: '1px solid var(--gray-200)',
                borderRadius: '10px',
                fontSize: 12,
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
            {/* Barras = contexto tenue. Bajamos opacidad para que la línea de
                caja (protagonista) lea claramente por encima. Banda P10–P90,
                Caja P50 y Caja base se quitaron: eran el ruido que hacía el
                chart indigerible (el Δ vs base ya vive en los KPIs). */}
            <Bar
              dataKey="entradasReal"
              stackId="entradas"
              name="Ingresos (real)"
              fill="#059669"
              fillOpacity={0.55}
              barSize={interactiveBars ? 12 : 4}
              radius={[0, 0, 0, 0]}
              cursor={interactiveBars ? 'pointer' : 'default'}
              isAnimationActive={false}
              onClick={handleBarClick}
            />
            <Bar
              dataKey="entradasProy"
              stackId="entradas"
              name="Ingresos (proy.)"
              fill="url(#cfcHatchIncome)"
              fillOpacity={0.55}
              barSize={interactiveBars ? 12 : 4}
              radius={[3, 3, 0, 0]}
              cursor={interactiveBars ? 'pointer' : 'default'}
              isAnimationActive={false}
              onClick={handleBarClick}
            />
            <Bar
              dataKey="salidasReal"
              stackId="salidas"
              name="Egresos (real)"
              fill="#dc2626"
              fillOpacity={0.55}
              barSize={interactiveBars ? 12 : 4}
              radius={[0, 0, 0, 0]}
              cursor={interactiveBars ? 'pointer' : 'default'}
              isAnimationActive={false}
              onClick={handleBarClick}
            />
            <Bar
              dataKey="salidasProy"
              stackId="salidas"
              name="Egresos (proy.)"
              fill="url(#cfcHatchExpense)"
              fillOpacity={0.55}
              barSize={interactiveBars ? 12 : 4}
              radius={[3, 3, 0, 0]}
              cursor={interactiveBars ? 'pointer' : 'default'}
              isAnimationActive={false}
              onClick={handleBarClick}
            />
            {showFloor && (
              <Line
                type="monotone"
                dataKey="piso"
                name="Piso operativo"
                stroke="var(--color-floor, #d97706)"
                strokeWidth={1.25}
                strokeDasharray="6 3"
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            )}
            {comparisonProjection && renderOverlaySeries && (
              <Line
                type="monotone"
                dataKey="comparison"
                name={`Comparación · ${comparisonProjection.name}`}
                stroke="var(--warning)"
                strokeWidth={1.5}
                strokeDasharray="2 4"
                dot={false}
                isAnimationActive={false}
              />
            )}
            <Line
              type="monotone"
              dataKey="caja"
              name="Caja final"
              stroke="#1d4ed8"
              strokeWidth={2.75}
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
        )}
      </div>

      {selectedBucket && breakdown && (
        <BreakdownPanel
          bucket={selectedBucket}
          breakdown={breakdown}
          onClose={() => setSelectedBucketIdx(null)}
          onNavigateToTax={onNavigateToTax}
        />
      )}
    </section>
  );
}

/**
 * Custom equality keeps Recharts off the critical path: identity-compare the
 * three `ForecastRun` slots and the navigation callback. The dashboard uses
 * the LRU cache so identical inputs produce identical run references, which
 * makes this check a single pointer compare in the common case.
 */
export const CashFlowChart = memo(CashFlowChartImpl, (prev, next) =>
  prev.projection === next.projection
  && prev.baseProjection === next.baseProjection
  && prev.comparisonProjection === next.comparisonProjection
  && prev.probabilisticProjection === next.probabilisticProjection
  && prev.onNavigateToTax === next.onNavigateToTax
  && prev.operatingFloor === next.operatingFloor,
);

function BreakdownPanel({
  bucket,
  breakdown,
  onClose,
  onNavigateToTax,
}: {
  bucket: ProjectionBucket;
  breakdown: CategoryBreakdown[];
  onClose: () => void;
  onNavigateToTax?: () => void;
}) {
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

  const totalInflows = breakdown.reduce((s, c) => s + c.inflows, 0);
  const totalOutflows = breakdown.reduce((s, c) => s + c.outflows, 0);

  const inflowCategories = breakdown.filter((c) => c.inflows > 0);
  const outflowCategories = breakdown.filter((c) => c.outflows > 0);

  return (
    <div className="mt-4 rounded-[var(--radius)] border border-[var(--gray-200)] bg-[var(--gray-50)]">
      <div className="flex items-center justify-between border-b border-[var(--gray-200)] px-4 py-2.5">
        <div>
          <span className="text-[13px] font-bold text-[var(--gray-950)]">
            Desglose: {bucket.label}
          </span>
          <span className="ml-2 text-[11px] text-[var(--gray-400)]">
            {bucket.movementIds.length} movimientos
          </span>
        </div>
        <button
          onClick={onClose}
          className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)] hover:bg-[var(--gray-200)] transition-colors"
        >
          <X className="h-4 w-4 text-[var(--gray-500)]" strokeWidth={1.5} />
        </button>
      </div>

      <div className="grid gap-4 p-4 lg:grid-cols-2">
        {/* Entradas */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--gray-400)]">Entradas</span>
            <span className="text-[13px] font-bold tabular-nums" style={{ color: 'var(--success)' }}>
              {fmtCompact(totalInflows)}
            </span>
          </div>
          <div className="space-y-1">
            {inflowCategories.map((cat) => (
              <CategoryRow
                key={`in-${cat.key}`}
                category={cat}
                amount={cat.inflows}
                total={totalInflows}
                type="INFLOW"
                expanded={expandedCategory === `in-${cat.key}`}
                onToggle={() => setExpandedCategory((p) => p === `in-${cat.key}` ? null : `in-${cat.key}`)}
                onNavigateToTax={cat.key === 'TAX' ? onNavigateToTax : undefined}
              />
            ))}
            {inflowCategories.length === 0 && (
              <div className="py-3 text-center text-[11px] text-[var(--gray-400)]">Sin entradas</div>
            )}
          </div>
        </div>

        {/* Salidas */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--gray-400)]">Salidas</span>
            <span className="text-[13px] font-bold tabular-nums" style={{ color: 'var(--danger)' }}>
              {fmtCompact(totalOutflows)}
            </span>
          </div>
          <div className="space-y-1">
            {outflowCategories.map((cat) => (
              <CategoryRow
                key={`out-${cat.key}`}
                category={cat}
                amount={cat.outflows}
                total={totalOutflows}
                type="OUTFLOW"
                expanded={expandedCategory === `out-${cat.key}`}
                onToggle={() => setExpandedCategory((p) => p === `out-${cat.key}` ? null : `out-${cat.key}`)}
                onNavigateToTax={cat.key === 'TAX' ? onNavigateToTax : undefined}
              />
            ))}
            {outflowCategories.length === 0 && (
              <div className="py-3 text-center text-[11px] text-[var(--gray-400)]">Sin salidas</div>
            )}
          </div>
        </div>
      </div>

      {/* Resumen de caja */}
      <div className="border-t border-[var(--gray-200)] px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[11px]">
          <span className="text-[var(--gray-400)]">Apertura: <strong className="text-[var(--gray-700)] tabular-nums">{fmtCompact(bucket.openingCash)}</strong></span>
          <span className="text-[var(--gray-400)]">Neto: <strong className="tabular-nums" style={{ color: bucket.net >= 0 ? 'var(--success)' : 'var(--danger)' }}>{bucket.net >= 0 ? '+' : ''}{fmtCompact(bucket.net)}</strong></span>
          <span className="text-[var(--gray-400)]">Cierre: <strong className="text-[var(--gray-700)] tabular-nums">{fmtCompact(bucket.closingCash)}</strong></span>
          {bucket.deficit > 0 && (
            <span className="text-[var(--danger)]">Déficit: <strong className="tabular-nums">{fmtCompact(bucket.deficit)}</strong></span>
          )}
        </div>
      </div>
    </div>
  );
}

function CategoryRow({
  category,
  amount,
  total,
  type,
  expanded,
  onToggle,
  onNavigateToTax,
}: {
  category: CategoryBreakdown;
  amount: number;
  total: number;
  type: 'INFLOW' | 'OUTFLOW';
  expanded: boolean;
  onToggle: () => void;
  onNavigateToTax?: () => void;
}) {
  const pct = total > 0 ? (amount / total) * 100 : 0;
  const movements = category.movements.filter((m) => m.type === type);
  const supplierLines = useMemo(
    () => (category.key === 'AP_PAYMENT' || category.key === 'TAX' || category.key === 'PAYROLL' || category.key === 'AR_COLLECTION')
      ? buildSupplierLines(movements)
      : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [category.key, movements.length],
  );
  const showDetail = supplierLines.length > 0;

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--gray-200)] bg-white">
      <button
        onClick={showDetail ? onToggle : undefined}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        style={{ cursor: showDetail ? 'pointer' : 'default' }}
      >
        {showDetail ? (
          expanded
            ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--gray-400)]" strokeWidth={1.5} />
            : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--gray-400)]" strokeWidth={1.5} />
        ) : (
          <span className="inline-block h-3.5 w-3.5 shrink-0" />
        )}
        <span className="flex-1 text-[12px] font-medium text-[var(--gray-950)]">
          {category.label}
          <span className="ml-1.5 text-[10px] text-[var(--gray-400)]">{movements.length} mov.</span>
        </span>
        <span className="text-[12px] font-bold tabular-nums text-[var(--gray-950)]">
          {fmtCompact(amount)}
        </span>
        <span className="w-[40px] text-right text-[10px] tabular-nums text-[var(--gray-400)]">
          {pct.toFixed(0)}%
        </span>
      </button>

      {/* Progress bar */}
      <div className="mx-3 mb-2 h-1 rounded-full bg-[var(--gray-100)]">
        <div
          className="h-1 rounded-full transition-all"
          style={{
            width: `${Math.min(100, pct)}%`,
            background: type === 'INFLOW' ? 'var(--success)' : 'var(--danger)',
          }}
        />
      </div>

      {expanded && showDetail && (
        <div className="border-t border-[var(--gray-100)] px-3 pb-2 pt-1">
          <div className="max-h-[200px] space-y-0.5 overflow-auto">
            {supplierLines.map((line) => (
              <div key={line.name} className="flex items-center gap-2 rounded px-1 py-1 text-[11px] hover:bg-[var(--gray-50)]">
                <span className="flex-1 truncate text-[var(--gray-700)]">{line.name}</span>
                <span className="tabular-nums text-[var(--gray-500)]">{line.count > 1 ? `${line.count}x` : ''}</span>
                <span className="font-medium tabular-nums text-[var(--gray-950)]">{fmtCompact(line.amount)}</span>
              </div>
            ))}
          </div>
          {onNavigateToTax && (
            <button
              onClick={(e) => { e.stopPropagation(); onNavigateToTax(); }}
              className="mt-2 inline-flex h-7 items-center rounded-[var(--radius-md)] border border-[var(--gray-200)] bg-white px-2.5 text-[11px] font-medium text-[var(--primary)] hover:bg-[var(--gray-50)]"
            >
              Ver módulo de impuestos →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
