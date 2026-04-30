import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { fmtCompact, fmtCurrency, fmtDate, fmtYearMonthLong } from '../../../formatters';
import {
  effectiveAmount,
  effectiveMovementDate,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import { ConfidenceBadge, StatusBadge } from '../../shared-finance/components/FinanceBadges';
import type { FinancialMovement, ProjectionGranularity } from '../../shared-finance/types';

export type MovementsGroupBy = 'period' | 'counterparty';
export type MovementsTypeFilter = 'ALL' | 'INFLOW' | 'OUTFLOW';

export interface MovementsTableProps {
  movements: FinancialMovement[];
  granularity: ProjectionGranularity;
  today: string;
  onSelectMovement: (movement: FinancialMovement, anchor: DOMRect) => void;
}

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

export function MovementsTable(props: MovementsTableProps) {
  const { movements, granularity, today, onSelectMovement } = props;

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<MovementsTypeFilter>('ALL');
  const [groupBy, setGroupBy] = useState<MovementsGroupBy>('period');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    return movements.filter((movement) => {
      if (typeFilter !== 'ALL' && movement.type !== typeFilter) return false;
      if (search) {
        const haystack = `${movement.counterpartyName ?? ''} ${movement.concept} ${movement.category}`.toLowerCase();
        if (!haystack.includes(search.toLowerCase())) return false;
      }
      return true;
    }).sort((a, b) => effectiveMovementDate(a).localeCompare(effectiveMovementDate(b)));
  }, [movements, typeFilter, search]);

  const groups = useMemo(() => buildGroups(filtered, groupBy, granularity, today), [filtered, groupBy, granularity, today]);

  useEffect(() => {
    if (groups.length === 0) {
      setExpanded(new Set());
      return;
    }
    setExpanded((current) => {
      const validKeys = new Set(groups.map((group) => group.key));
      const intersection = new Set([...current].filter((key) => validKeys.has(key)));
      if (intersection.size > 0) return intersection;
      return new Set([defaultExpandedKey(groups, groupBy, today)]);
    });
  }, [groups, groupBy, today]);

  const toggleGroup = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const allExpanded = groups.length > 0 && groups.every((group) => expanded.has(group.key));
  const toggleAll = () => {
    if (allExpanded) setExpanded(new Set());
    else setExpanded(new Set(groups.map((group) => group.key)));
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--gray-200)] px-4 py-2.5 bg-[var(--gray-50)]/40">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--gray-400)]" strokeWidth={1.5} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar contraparte o concepto"
              className="h-9 w-[240px] rounded-xl border border-[var(--gray-200)] bg-white pl-8 pr-3 text-[12px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)]"
            />
          </div>
          <Segmented
            value={typeFilter}
            options={[
              { id: 'ALL', label: 'Todos' },
              { id: 'INFLOW', label: 'Ingresos' },
              { id: 'OUTFLOW', label: 'Egresos' },
            ]}
            onChange={setTypeFilter}
          />
          <Segmented
            label="Agrupar por"
            value={groupBy}
            options={[
              { id: 'period', label: granularity === 'monthly' ? 'Mes' : granularity === 'weekly' ? 'Semana' : 'Día' },
              { id: 'counterparty', label: 'Contraparte' },
            ]}
            onChange={setGroupBy}
          />
        </div>
        <button
          type="button"
          onClick={toggleAll}
          disabled={groups.length === 0}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--gray-200)] bg-white px-2.5 text-[12px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)] disabled:opacity-50"
        >
          {allExpanded
            ? <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.5} />
            : <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.5} />}
          {allExpanded ? 'Contraer todo' : 'Expandir todo'}
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="px-4 py-12 text-center text-[12px] text-[var(--gray-400)]">
          No hay movimientos para los filtros aplicados.
        </div>
      ) : (
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
              {groups.map((group) => (
                <GroupRows
                  key={group.key}
                  group={group}
                  expanded={expanded.has(group.key)}
                  onToggle={() => toggleGroup(group.key)}
                  onSelectMovement={onSelectMovement}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
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
  useEffect(() => { setVisibleLimit(120); }, [group.key]);
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
              ? <ChevronDown className="h-4 w-4 text-[var(--gray-500)]" strokeWidth={2} />
              : <ChevronRight className="h-4 w-4 text-[var(--gray-500)]" strokeWidth={2} />}
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-[var(--gray-950)]">{group.label}</span>
                {group.containsToday && (
                  <span className="inline-flex h-5 items-center rounded-full bg-[var(--gray-100)] px-2 text-[10px] font-medium text-[var(--gray-700)]">
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
          style={{ color: group.netTotal > 0 ? 'var(--success)' : group.netTotal < 0 ? 'var(--danger)' : 'var(--gray-700)' }}
        >
          {group.netTotal === 0 ? '$0' : `${group.netTotal > 0 ? '+' : '-'}${fmtCompact(Math.abs(group.netTotal))}`}
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
                          type="button"
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

function buildGroups(
  movements: FinancialMovement[],
  groupBy: MovementsGroupBy,
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
    items.sort((a, b) => effectiveMovementDate(a).localeCompare(effectiveMovementDate(b)));
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

function groupKeyFor(movement: FinancialMovement, groupBy: MovementsGroupBy, granularity: ProjectionGranularity): string {
  if (groupBy === 'counterparty') return movement.counterpartyType ?? '__UNCATEGORIZED__';
  const date = effectiveMovementDate(movement);
  if (granularity === 'daily') return date;
  if (granularity === 'monthly') return date.slice(0, 7);
  const d = new Date(`${date}T00:00:00.000Z`);
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (dow - 1));
  return d.toISOString().slice(0, 10);
}

function groupLabelFor(
  key: string,
  groupBy: MovementsGroupBy,
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

function defaultExpandedKey(groups: MovementGroup[], groupBy: MovementsGroupBy, today: string): string {
  if (groupBy === 'period') {
    const containing = groups.find((group) => group.containsToday);
    if (containing) return containing.key;
    const upcoming = groups.find((group) => group.key >= today);
    if (upcoming) return upcoming.key;
  }
  return groups[0].key;
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

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label?: string;
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      {label && (
        <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">
          {label}
        </span>
      )}
      <div className="inline-flex h-8 items-center rounded-lg border border-[var(--gray-200)] bg-white p-0.5">
        {options.map((option) => {
          const active = value === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onChange(option.id)}
              aria-pressed={active}
              className="h-7 rounded-md px-2.5 text-[11px] font-medium transition-colors"
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
