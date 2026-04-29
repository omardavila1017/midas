import { useMemo, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { fmtCompact, fmtCurrency } from '../../../formatters';
import type { FinancialMovement, ForecastRun, ProjectionBucket } from '../../shared-finance/types';
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
    TRANSFER: 'Transferencias',
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

export function CashFlowChart({
  projection,
  baseProjection,
  onNavigateToTax,
}: {
  projection: ForecastRun;
  baseProjection?: ForecastRun;
  onNavigateToTax?: () => void;
}) {
  const [selectedBucketIdx, setSelectedBucketIdx] = useState<number | null>(null);

  const baseByDate = new Map(
    baseProjection?.buckets.map((bucket) => [bucket.date, bucket.closingCash]) ?? [],
  );
  const data = projection.buckets.map((bucket) => ({
    date: bucket.label,
    rawDate: bucket.date,
    entradas: bucket.inflows,
    salidas: bucket.outflows,
    caja: bucket.closingCash,
    minimo: bucket.minimumCash,
    base: baseByDate.get(bucket.date),
  }));

  const selectedBucket = selectedBucketIdx != null ? projection.buckets[selectedBucketIdx] : null;

  const breakdown = useMemo(() => {
    if (!selectedBucket) return null;
    const idSet = new Set(selectedBucket.movementIds);
    const movements = projection.movements.filter((m) => idSet.has(m.id));
    return buildCategoryBreakdown(movements);
  }, [selectedBucket, projection.movements]);

  const handleBarClick = (_data: unknown, index: number) => {
    setSelectedBucketIdx((prev) => (prev === index ? null : index));
  };

  return (
    <section className="rounded-2xl border border-[var(--gray-200)] bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight text-[var(--gray-950)]">
            Caja proyectada
          </h2>
          <p className="mt-1 text-[12px] text-[var(--gray-400)]">
            Entradas, salidas, cierre y caja mínima.
            {baseProjection ? ' La línea punteada es el escenario base.' : ' Vista del escenario base.'}
            {' '}Haz clic en una barra para ver el desglose.
          </p>
        </div>
        <div className="text-right text-[12px] text-[var(--gray-400)]">
          {projection.startDate} → {projection.endDate}
        </div>
      </div>
      <div className="mt-4" style={{ height: 340 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 12, right: 18, bottom: 0, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: 'var(--gray-400)' }}
              minTickGap={18}
            />
            <YAxis
              tickFormatter={fmtCompact}
              tick={{ fontSize: 11, fill: 'var(--gray-400)' }}
              width={72}
            />
            <Tooltip
              formatter={(value: number, name: string) => [fmtCurrency(value), name]}
              labelFormatter={(_, payload) => payload?.[0]?.payload?.rawDate ?? ''}
              contentStyle={{
                border: '1px solid var(--gray-200)',
                borderRadius: '10px',
                fontSize: 12,
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
            <Bar
              dataKey="entradas"
              name="Ingresos"
              fill="var(--success)"
              barSize={12}
              radius={[4, 4, 0, 0]}
              cursor="pointer"
              onClick={handleBarClick}
            />
            <Bar
              dataKey="salidas"
              name="Egresos"
              fill="var(--danger)"
              barSize={12}
              radius={[4, 4, 0, 0]}
              cursor="pointer"
              onClick={handleBarClick}
            />
            <Line
              type="monotone"
              dataKey="caja"
              name="Caja final"
              stroke="#1d4ed8"
              strokeWidth={2.5}
              dot={false}
            />
            {baseProjection && (
              <Line
                type="monotone"
                dataKey="base"
                name="Caja base"
                stroke="var(--gray-400)"
                strokeWidth={1.5}
                strokeDasharray="4 4"
                dot={false}
              />
            )}
            <ReferenceLine
              y={projection.summary.minimumCashRequired}
              stroke="var(--warning)"
              strokeDasharray="3 3"
              label={{
                value: 'Caja mínima',
                position: 'right',
                fill: 'var(--warning)',
                fontSize: 10,
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
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
    <div className="mt-4 rounded-xl border border-[var(--gray-200)] bg-[var(--gray-50)]">
      <div className="flex items-center justify-between border-b border-[var(--gray-200)] px-4 py-2.5">
        <div>
          <span className="text-[13px] font-semibold text-[var(--gray-950)]">
            Desglose: {bucket.label}
          </span>
          <span className="ml-2 text-[11px] text-[var(--gray-400)]">
            {bucket.movementIds.length} movimientos
          </span>
        </div>
        <button
          onClick={onClose}
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg hover:bg-[var(--gray-200)] transition-colors"
        >
          <X className="h-4 w-4 text-[var(--gray-500)]" strokeWidth={1.5} />
        </button>
      </div>

      <div className="grid gap-4 p-4 lg:grid-cols-2">
        {/* Entradas */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--gray-400)]">Entradas</span>
            <span className="text-[13px] font-semibold tabular-nums" style={{ color: 'var(--success)' }}>
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
            <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--gray-400)]">Salidas</span>
            <span className="text-[13px] font-semibold tabular-nums" style={{ color: 'var(--danger)' }}>
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
    () => (category.key === 'AP_PAYMENT' || category.key === 'TAX' || category.key === 'PAYROLL')
      ? buildSupplierLines(movements)
      : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [category.key, movements.length],
  );
  const showDetail = supplierLines.length > 0;

  return (
    <div className="rounded-lg border border-[var(--gray-200)] bg-white">
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
        <span className="text-[12px] font-semibold tabular-nums text-[var(--gray-950)]">
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
              className="mt-2 inline-flex h-7 items-center rounded-lg border border-[var(--gray-200)] bg-white px-2.5 text-[11px] font-medium text-[var(--primary)] hover:bg-[var(--gray-50)]"
            >
              Ver módulo de impuestos →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
