import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { fmtCompact, fmtCurrency } from '../../../formatters';
import type {
  CellOverride,
  FinancialMovement,
  PlanningRow,
  ProjectionBucket,
  ProjectionGranularity,
} from '../../shared-finance/types';
import { conceptKeyForMovement } from '../../financial-planning/services/planningRowTaxonomy';

export interface BucketDetailTableProps {
  buckets: ProjectionBucket[];
  movements: FinancialMovement[];
  rows: PlanningRow[];
  overrides: CellOverride[];
  granularity: ProjectionGranularity;
  comparisonBuckets?: ProjectionBucket[];
  onSelectMovement?: (movement: FinancialMovement, anchor: DOMRect) => void;
}

interface ConceptAggregate {
  conceptKey: string;
  rowLabel: string;
  type: 'INFLOW' | 'OUTFLOW';
  baseValue: number;
  effectiveValue: number;
  hasOverride: boolean;
  contributingMovements: FinancialMovement[];
}

export function BucketDetailTable(props: BucketDetailTableProps) {
  const {
    buckets,
    movements,
    rows,
    overrides,
    granularity,
    comparisonBuckets,
    onSelectMovement,
  } = props;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const movementById = useMemo(() => {
    const map = new Map<string, FinancialMovement>();
    for (const movement of movements) map.set(movement.id, movement);
    return map;
  }, [movements]);

  const overrideIndex = useMemo(() => {
    const map = new Map<string, CellOverride>();
    for (const override of overrides) {
      if (override.granularity !== granularity) continue;
      map.set(`${override.conceptKey}::${override.bucketKey}`, override);
    }
    return map;
  }, [overrides, granularity]);

  const compareByDate = useMemo(() => {
    const map = new Map<string, ProjectionBucket>();
    if (comparisonBuckets) {
      for (const bucket of comparisonBuckets) map.set(bucket.date, bucket);
    }
    return map;
  }, [comparisonBuckets]);

  // Pre-bucket movements by their conceptKey so expand is O(rows) not O(rows × bucketMovements).
  const conceptIndexByBucket = useMemo(() => {
    const map = new Map<string, Map<string, FinancialMovement[]>>();
    for (const bucket of buckets) {
      const inner = new Map<string, FinancialMovement[]>();
      for (const id of bucket.movementIds) {
        const movement = movementById.get(id);
        if (!movement) continue;
        const key = conceptKeyForMovement(movement);
        const list = inner.get(key);
        if (list) list.push(movement);
        else inner.set(key, [movement]);
      }
      map.set(bucket.date, inner);
    }
    return map;
  }, [buckets, movementById]);

  const aggregatesCache = useMemo(() => new Map<string, ConceptAggregate[]>(), [rows, conceptIndexByBucket, overrideIndex]);

  const toggle = (date: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  const aggregateConceptsForBucket = (bucket: ProjectionBucket): ConceptAggregate[] => {
    const cached = aggregatesCache.get(bucket.date);
    if (cached) return cached;
    const conceptMap = conceptIndexByBucket.get(bucket.date) ?? new Map();
    const grouped: ConceptAggregate[] = [];
    for (const row of rows) {
      const contributing = conceptMap.get(row.conceptKey) ?? [];
      let baseValue = 0;
      for (const m of contributing) baseValue += Math.max(0, m.adjustedAmount ?? m.projectedAmount);
      const override = overrideIndex.get(`${row.conceptKey}::${bucket.date}`);
      if (baseValue === 0 && !override) continue;
      grouped.push({
        conceptKey: row.conceptKey,
        rowLabel: row.label,
        type: row.type,
        baseValue,
        effectiveValue: override ? override.value : baseValue,
        hasOverride: Boolean(override),
        contributingMovements: contributing,
      });
    }
    grouped.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'INFLOW' ? -1 : 1;
      return b.effectiveValue - a.effectiveValue;
    });
    aggregatesCache.set(bucket.date, grouped);
    return grouped;
  };

  if (buckets.length === 0) {
    return (
      <div className="px-4 py-12 text-center text-[12px] text-[var(--gray-400)]">
        Sin períodos en el rango seleccionado.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] text-[13px]">
        <thead className="bg-[var(--gray-50)] text-left text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">
          <tr>
            <th className="px-4 py-2.5 w-[28%]">Período</th>
            <th className="px-4 py-2.5 text-right">Ingresos</th>
            <th className="px-4 py-2.5 text-right">Egresos</th>
            <th className="px-4 py-2.5 text-right">Neto</th>
            <th className="px-4 py-2.5 text-right">Cierre</th>
            {comparisonBuckets && <th className="px-4 py-2.5 text-right">Δ comp.</th>}
            <th className="px-4 py-2.5 text-right">Déficit</th>
            <th className="px-4 py-2.5"></th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((bucket) => {
            const isExpanded = expanded.has(bucket.date);
            const compare = compareByDate.get(bucket.date);
            const comparisonDelta = compare ? bucket.closingCash - compare.closingCash : 0;
            return (
              <BucketRow
                key={bucket.date}
                bucket={bucket}
                expanded={isExpanded}
                onToggle={() => toggle(bucket.date)}
                aggregates={isExpanded ? aggregateConceptsForBucket(bucket) : null}
                comparisonDelta={compare ? comparisonDelta : undefined}
                hasComparison={Boolean(comparisonBuckets)}
                onSelectMovement={onSelectMovement}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BucketRow({
  bucket,
  expanded,
  onToggle,
  aggregates,
  comparisonDelta,
  hasComparison,
  onSelectMovement,
}: {
  bucket: ProjectionBucket;
  expanded: boolean;
  onToggle: () => void;
  aggregates: ConceptAggregate[] | null;
  comparisonDelta?: number;
  hasComparison: boolean;
  onSelectMovement?: (movement: FinancialMovement, anchor: DOMRect) => void;
}) {
  const netColor = bucket.net > 0 ? 'var(--success)' : bucket.net < 0 ? 'var(--danger)' : 'var(--gray-700)';
  const compColor = comparisonDelta && comparisonDelta > 0
    ? 'var(--success)'
    : comparisonDelta && comparisonDelta < 0
      ? 'var(--danger)'
      : 'var(--gray-400)';
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
              ? <ChevronDown className="h-4 w-4 text-[var(--gray-500)]" strokeWidth={2} />
              : <ChevronRight className="h-4 w-4 text-[var(--gray-500)]" strokeWidth={2} />}
            <div>
              <div className="font-semibold text-[var(--gray-950)]">{bucket.label}</div>
              <div className="text-[10.5px] text-[var(--gray-400)]">{bucket.date}</div>
            </div>
          </div>
        </td>
        <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap" style={{ color: 'var(--success)' }}>
          {bucket.inflows > 0 ? fmtCompact(bucket.inflows) : '—'}
        </td>
        <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap" style={{ color: 'var(--danger)' }}>
          {bucket.outflows > 0 ? `-${fmtCompact(bucket.outflows)}` : '—'}
        </td>
        <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap font-semibold" style={{ color: netColor }}>
          {bucket.net === 0 ? '—' : `${bucket.net > 0 ? '+' : ''}${fmtCompact(bucket.net)}`}
        </td>
        <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap font-medium text-[var(--gray-950)]">
          {fmtCompact(bucket.closingCash)}
        </td>
        {hasComparison && (
          <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap font-semibold" style={{ color: compColor }}>
            {comparisonDelta === undefined
              ? '—'
              : comparisonDelta === 0
                ? '±0'
                : `${comparisonDelta > 0 ? '+' : ''}${fmtCompact(comparisonDelta)}`}
          </td>
        )}
        <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap" style={{ color: bucket.deficit > 0 ? 'var(--danger)' : 'var(--gray-400)' }}>
          {bucket.deficit > 0 ? `-${fmtCompact(bucket.deficit)}` : '—'}
        </td>
        <td className="px-4 py-3 text-right">
          <span className="text-[11px] font-medium text-[var(--gray-400)]">
            {expanded ? 'Ocultar' : 'Ver conceptos'}
          </span>
        </td>
      </tr>
      {expanded && aggregates && (
        <tr>
          <td colSpan={hasComparison ? 8 : 7} className="p-0 bg-white">
            <ConceptBreakdown
              aggregates={aggregates}
              onSelectMovement={onSelectMovement}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function ConceptBreakdown({
  aggregates,
  onSelectMovement,
}: {
  aggregates: ConceptAggregate[];
  onSelectMovement?: (movement: FinancialMovement, anchor: DOMRect) => void;
}) {
  if (aggregates.length === 0) {
    return (
      <div className="border-t border-[var(--gray-200)] px-4 py-6 pl-10 text-[12px] text-[var(--gray-400)]">
        Este período no tiene movimientos contribuyentes. El total bucket viene de overrides agregados o saldo carry-over.
      </div>
    );
  }

  return (
    <div className="border-t border-[var(--gray-200)]">
      <table className="w-full text-[12.5px]">
        <thead className="text-left text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)] bg-[var(--gray-50)]/50">
          <tr>
            <th className="px-4 py-2 pl-10">Concepto</th>
            <th className="px-4 py-2">Tipo</th>
            <th className="px-4 py-2 text-right">Base</th>
            <th className="px-4 py-2 text-right">Efectivo</th>
            <th className="px-4 py-2 text-right">Δ</th>
            <th className="px-4 py-2 text-right"># mov.</th>
            <th className="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {aggregates.map((agg) => {
            const delta = agg.effectiveValue - agg.baseValue;
            return (
              <tr
                key={agg.conceptKey}
                className="border-t border-[var(--gray-100)] hover:bg-[var(--gray-50)] transition-colors"
              >
                <td className="px-4 py-2.5 pl-10">
                  <div className="flex items-center gap-1.5">
                    {agg.hasOverride && (
                      <Sparkles className="h-3 w-3 text-[var(--primary)]" strokeWidth={2} aria-label="Override de Planeación" />
                    )}
                    <span className="font-medium text-[var(--gray-950)]">{agg.rowLabel}</span>
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className="inline-flex h-5 items-center rounded-full px-1.5 text-[10px] font-medium"
                    style={{
                      background: agg.type === 'INFLOW' ? 'var(--success-muted)' : 'var(--danger-muted)',
                      color: agg.type === 'INFLOW' ? 'var(--success)' : 'var(--danger)',
                    }}
                  >
                    {agg.type === 'INFLOW' ? 'Ingreso' : 'Egreso'}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-[var(--gray-700)]">
                  {agg.baseValue === 0 ? '—' : fmtCurrency(agg.baseValue)}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums font-medium text-[var(--gray-950)]">
                  {agg.effectiveValue === 0 ? '—' : fmtCurrency(agg.effectiveValue)}
                </td>
                <td
                  className="px-4 py-2.5 text-right tabular-nums font-semibold"
                  style={{ color: delta > 0 ? 'var(--success)' : delta < 0 ? 'var(--danger)' : 'var(--gray-400)' }}
                >
                  {delta === 0 ? '—' : `${delta > 0 ? '+' : ''}${fmtCompact(delta)}`}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-[var(--gray-500)]">
                  {agg.contributingMovements.length}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {agg.contributingMovements.length === 1 && onSelectMovement ? (
                    <button
                      type="button"
                      onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        onSelectMovement(agg.contributingMovements[0], rect);
                      }}
                      className="text-[10.5px] font-medium text-[var(--primary)] hover:underline"
                    >
                      Detalle →
                    </button>
                  ) : agg.contributingMovements.length > 1 && onSelectMovement ? (
                    <span className="text-[10.5px] text-[var(--gray-400)]">
                      {agg.contributingMovements.length} movimientos
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
