import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Lock, Plus, Sparkles } from 'lucide-react';
import { fmtCompact } from '../../../../formatters';
import type {
  CellOverride,
  FinancialMovementType,
  PlanningRow,
  ProjectionGranularity,
} from '../../../shared-finance/types';
import {
  BucketColumn,
  HEADER_HEIGHT,
  LABEL_COL_WIDTH,
  parseNumericInput,
  ROW_HEIGHT,
  colWidthForGranularity,
} from './gridGeometry';

export interface SpreadsheetGridProps {
  rows: PlanningRow[];
  columns: BucketColumn[];
  granularity: ProjectionGranularity;
  isReadOnly: boolean;
  asOfDate: string;
  baseValueFor: (conceptKey: string, bucketKey: string) => number;
  overrideFor: (conceptKey: string, bucketKey: string) => CellOverride | undefined;
  isAiTouched?: (conceptKey: string, bucketKey: string) => boolean;
  totalsFor: (kind: 'inflows' | 'outflows' | 'net' | 'closingCash', bucketKey: string) => number;
  onCommitCell: (conceptKey: string, bucketKey: string, value: number, type: FinancialMovementType) => void;
  onClearCell: (conceptKey: string, bucketKey: string) => void;
  onAddRow: (type: FinancialMovementType) => void;
  onClickRow?: (conceptKey: string) => void;
  onInspectCell?: (conceptKey: string, bucketKey: string) => void;
  onReadOnlyAttempt?: () => void;
}

interface CellCoord {
  rowIndex: number;
  colIndex: number;
}

type DisplayRow =
  | { kind: 'data'; row: PlanningRow; depth: number }
  | { kind: 'bucket'; id: string; label: string; rows: PlanningRow[]; type: FinancialMovementType };

function bucketId(type: FinancialMovementType, label: string): string {
  return `${type}:${label}`;
}

export function SpreadsheetGrid(props: SpreadsheetGridProps) {
  const {
    rows,
    columns,
    granularity,
    isReadOnly,
    baseValueFor,
    overrideFor,
    isAiTouched,
    totalsFor,
    onCommitCell,
    onClearCell,
    onAddRow,
    onClickRow,
    onInspectCell,
    onReadOnlyAttempt,
  } = props;

  const inflowRows = useMemo(() => rows.filter((row) => row.type === 'INFLOW'), [rows]);
  const outflowRows = useMemo(() => rows.filter((row) => row.type === 'OUTFLOW'), [rows]);

  const [collapsed, setCollapsed] = useState<Record<FinancialMovementType, boolean>>({ INFLOW: false, OUTFLOW: false });
  const [expandedBuckets, setExpandedBuckets] = useState<Record<string, boolean>>({});
  const toggleSection = (type: FinancialMovementType) => {
    setCollapsed((current) => ({ ...current, [type]: !current[type] }));
  };
  const toggleBucket = (id: string) => {
    setExpandedBuckets((current) => ({ ...current, [id]: !current[id] }));
  };

  const groupByBucket = useCallback(
    (inputRows: PlanningRow[], type: FinancialMovementType): DisplayRow[] => {
      const byBucket = new Map<string, PlanningRow[]>();
      for (const row of inputRows) {
        const label = row.bucketLabel || (type === 'INFLOW' ? 'Otros ingresos' : 'Otros egresos');
        const bucket = byBucket.get(label);
        if (bucket) bucket.push(row);
        else byBucket.set(label, [row]);
      }
      return Array.from(byBucket.entries())
        .sort(([a], [b]) => a.localeCompare(b, 'es-MX'))
        .flatMap<DisplayRow>(([label, groupRows]) => {
          const id = bucketId(type, label);
          const sortedRows = [...groupRows].sort((a, b) => a.label.localeCompare(b.label, 'es-MX'));
          const header: DisplayRow = { kind: 'bucket', id, label, rows: sortedRows, type };
          if (!expandedBuckets[id]) return [header];
          return [header, ...sortedRows.map((row) => ({ kind: 'data' as const, row, depth: 1 }))];
        });
    },
    [expandedBuckets],
  );

  const visibleInflowRows = collapsed.INFLOW ? [] : inflowRows;
  const visibleOutflowRows = collapsed.OUTFLOW ? [] : outflowRows;
  const visibleInflowDisplayRows = useMemo<DisplayRow[]>(
    () => groupByBucket(visibleInflowRows, 'INFLOW'),
    [groupByBucket, visibleInflowRows],
  );
  const visibleOutflowDisplayRows = useMemo<DisplayRow[]>(
    () => groupByBucket(visibleOutflowRows, 'OUTFLOW'),
    [groupByBucket, visibleOutflowRows],
  );
  const displayRows = useMemo(
    () => [...visibleInflowDisplayRows, ...visibleOutflowDisplayRows],
    [visibleInflowDisplayRows, visibleOutflowDisplayRows],
  );

  const colWidth = colWidthForGranularity(granularity);

  const [selection, setSelection] = useState<CellCoord | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [draftValue, setDraftValue] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const moveSelection = useCallback((dr: number, dc: number) => {
    setSelection((current) => {
      const baseRow = current?.rowIndex ?? 0;
      const baseCol = current?.colIndex ?? 0;
      let nextRow = baseRow + dr;
      let nextCol = baseCol + dc;
      if (nextRow < 0) nextRow = 0;
      if (nextRow > displayRows.length - 1) nextRow = displayRows.length - 1;
      if (nextCol < 0) {
        if (nextRow > 0) {
          nextRow -= 1;
          nextCol = columns.length - 1;
        } else {
          nextCol = 0;
        }
      }
      if (nextCol > columns.length - 1) {
        if (nextRow < displayRows.length - 1) {
          nextRow += 1;
          nextCol = 0;
        } else {
          nextCol = columns.length - 1;
        }
      }
      if (displayRows.length === 0) return null;
      return { rowIndex: nextRow, colIndex: nextCol };
    });
    setIsEditing(false);
  }, [columns.length, displayRows.length]);

  const startEdit = useCallback((seed?: string) => {
    if (isReadOnly) {
      onReadOnlyAttempt?.();
      return;
    }
    if (!selection) return;
    const displayRow = displayRows[selection.rowIndex];
    const col = columns[selection.colIndex];
    if (!displayRow || displayRow.kind !== 'data' || !col) return;
    const row = displayRow.row;
    if (col.isPast) return;
    if (seed !== undefined) {
      setDraftValue(seed);
    } else {
      const override = overrideFor(row.conceptKey, col.key);
      const initial = override ? override.value : baseValueFor(row.conceptKey, col.key);
      setDraftValue(initial > 0 ? String(Math.round(initial)) : '');
    }
    setIsEditing(true);
  }, [baseValueFor, columns, displayRows, isReadOnly, onReadOnlyAttempt, overrideFor, selection]);

  const commitEdit = useCallback(() => {
    if (!selection || !isEditing) {
      setIsEditing(false);
      return;
    }
    const displayRow = displayRows[selection.rowIndex];
    const col = columns[selection.colIndex];
    if (!displayRow || displayRow.kind !== 'data' || !col) {
      setIsEditing(false);
      return;
    }
    const row = displayRow.row;
    const parsed = parseNumericInput(draftValue);
    if (parsed === null) {
      setIsEditing(false);
      return;
    }
    onCommitCell(row.conceptKey, col.key, Math.max(0, parsed), row.type);
    setIsEditing(false);
  }, [columns, displayRows, draftValue, isEditing, onCommitCell, selection]);

  const clearSelectedCell = useCallback(() => {
    if (!selection || isReadOnly) return;
    const displayRow = displayRows[selection.rowIndex];
    const col = columns[selection.colIndex];
    if (!displayRow || displayRow.kind !== 'data' || !col) return;
    const row = displayRow.row;
    if (col.isPast) return;
    onClearCell(row.conceptKey, col.key);
  }, [columns, displayRows, isReadOnly, onClearCell, selection]);

  useEffect(() => {
    if (!isEditing) return;
    const node = inputRef.current;
    if (!node) return;
    node.focus();
    node.select();
  }, [isEditing]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isEditing) {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitEdit();
        moveSelection(1, 0);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        setIsEditing(false);
      } else if (event.key === 'Tab') {
        event.preventDefault();
        commitEdit();
        moveSelection(0, event.shiftKey ? -1 : 1);
      }
      return;
    }

    if (event.metaKey || event.ctrlKey) {
      if (event.key.toLowerCase() === 'z' || event.key === 'Backspace') {
        event.preventDefault();
        clearSelectedCell();
        return;
      }
    }

    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        moveSelection(-1, 0);
        break;
      case 'ArrowDown':
        event.preventDefault();
        moveSelection(1, 0);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        moveSelection(0, -1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        moveSelection(0, 1);
        break;
      case 'Tab':
        event.preventDefault();
        moveSelection(0, event.shiftKey ? -1 : 1);
        break;
      case 'Enter':
      case 'F2':
        event.preventDefault();
        startEdit();
        break;
      case 'i':
      case 'I':
        if (selection && onInspectCell) {
          const displayRow = displayRows[selection.rowIndex];
          const col = columns[selection.colIndex];
          if (displayRow?.kind === 'data' && col) {
            const row = displayRow.row;
            event.preventDefault();
            onInspectCell(row.conceptKey, col.key);
          }
        }
        break;
      default:
        if (event.key.length === 1 && /[0-9.\-]/.test(event.key)) {
          event.preventDefault();
          startEdit(event.key);
        }
    }
  }, [clearSelectedCell, columns, commitEdit, displayRows, isEditing, moveSelection, onInspectCell, selection, startEdit]);

  const renderDataRow = (row: PlanningRow, rowIndex: number, depth: number) => (
    <div
      key={row.conceptKey}
      role="row"
      className="flex border-b border-[var(--gray-100)] hover:bg-[var(--gray-50)]/40"
      style={{ height: ROW_HEIGHT }}
    >
      <StickyLeftCell width={LABEL_COL_WIDTH} left={0} shadow>
        <button
          type="button"
          onClick={() => onClickRow?.(row.conceptKey)}
          className="flex w-full items-center gap-1.5 truncate text-left text-[12px] font-medium text-[var(--gray-950)] hover:text-[var(--primary)]"
          style={{ paddingLeft: depth * 18 }}
        >
          {row.isCustom && <Sparkles className="h-3 w-3 text-[var(--primary)]" strokeWidth={1.5} />}
          <span className="truncate">{row.label}</span>
        </button>
      </StickyLeftCell>
      {columns.map((column, colIndex) => {
        const override = overrideFor(row.conceptKey, column.key);
        const baseValue = baseValueFor(row.conceptKey, column.key);
        const value = override ? override.value : baseValue;
        const isSelected = selection?.rowIndex === rowIndex && selection?.colIndex === colIndex;
        const isPast = column.isPast;
        const aiTouched = !isPast && isAiTouched?.(row.conceptKey, column.key);
        const aiBg = aiTouched && !isSelected ? 'bg-[#EEF2FF]' : '';
        const aiText = aiTouched ? 'text-[#4338CA] font-semibold' : '';
        const cellClass = `relative flex h-full items-center justify-end px-2 text-[12px] tabular-nums border-l border-[var(--gray-100)] cursor-${isReadOnly || isPast ? 'default' : 'cell'} select-none ${
          isPast ? 'bg-[var(--gray-50)] text-[var(--gray-400)]' : `${aiBg} ${aiText} text-[var(--gray-950)]`
        } ${isSelected ? 'ring-2 ring-inset ring-[var(--primary)] z-10 bg-white' : ''}`;
        return (
          <div
            key={column.key}
            role="gridcell"
            aria-selected={isSelected}
            onClick={() => {
              setSelection({ rowIndex, colIndex });
              setIsEditing(false);
              onInspectCell?.(row.conceptKey, column.key);
              if (isReadOnly) onReadOnlyAttempt?.();
            }}
            onDoubleClick={() => {
              setSelection({ rowIndex, colIndex });
              startEdit();
            }}
            className={cellClass}
            style={{ width: colWidth, flex: `0 0 ${colWidth}px` }}
          >
            {isSelected && isEditing ? (
              <input
                ref={inputRef}
                type="text"
                inputMode="decimal"
                value={draftValue}
                onChange={(event) => setDraftValue(event.target.value)}
                onBlur={() => commitEdit()}
                className="absolute inset-0 w-full bg-white px-2 text-right text-[12px] tabular-nums text-[var(--gray-950)] outline-none ring-2 ring-inset ring-[var(--primary)]"
              />
            ) : (
              <>
                {override && (
                  <span
                    aria-hidden="true"
                    className="absolute left-1 top-1 h-1.5 w-1.5 rounded-full"
                    style={{ background: 'var(--primary)' }}
                  />
                )}
                {aiTouched && !override && (
                  <span
                    aria-hidden="true"
                    title="Ajuste MIDAS"
                    className="absolute left-1 top-1 h-1.5 w-1.5 rounded-full"
                    style={{ background: '#7C3AED' }}
                  />
                )}
                <span className={value === 0 ? 'text-[var(--gray-300)]' : ''}>
                  {value === 0 ? '—' : fmtCompact(value)}
                </span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );

  const renderBucketRow = (group: Extract<DisplayRow, { kind: 'bucket' }>, rowIndex: number) => {
    const expanded = !!expandedBuckets[group.id];
    return (
      <div
        key={group.id}
        role="row"
        className="flex border-b border-[var(--gray-100)] bg-[var(--gray-50)]/70 hover:bg-[var(--gray-100)]/70"
        style={{ height: ROW_HEIGHT }}
      >
        <StickyLeftCell width={LABEL_COL_WIDTH} left={0} shadow className="bg-[var(--gray-50)]/70">
          <button
            type="button"
            onClick={() => toggleBucket(group.id)}
            aria-expanded={expanded}
            className="flex w-full items-center gap-1.5 truncate text-left text-[12px] font-bold text-[var(--gray-950)] hover:text-[var(--primary)]"
          >
            {expanded
              ? <ChevronDown className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
              : <ChevronRight className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />}
            <span className="truncate">{group.label}</span>
            <span className="ml-auto rounded bg-white px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-[var(--gray-500)]">
              {group.rows.length}
            </span>
          </button>
        </StickyLeftCell>
        {columns.map((column, colIndex) => {
          const value = group.rows.reduce((sum, child) => {
            const override = overrideFor(child.conceptKey, column.key);
            return sum + (override ? override.value : baseValueFor(child.conceptKey, column.key));
          }, 0);
          const isSelected = selection?.rowIndex === rowIndex && selection?.colIndex === colIndex;
          return (
            <div
              key={column.key}
              role="gridcell"
              aria-selected={isSelected}
              onClick={() => {
                setSelection({ rowIndex, colIndex });
                setIsEditing(false);
                toggleBucket(group.id);
              }}
              className={`flex h-full items-center justify-end px-2 text-[12px] font-bold tabular-nums border-l border-[var(--gray-100)] cursor-pointer select-none ${
                column.isPast ? 'bg-[var(--gray-100)] text-[var(--gray-500)]' : 'text-[var(--gray-950)]'
              } ${isSelected ? 'ring-2 ring-inset ring-[var(--primary)] z-10 bg-white' : ''}`}
              style={{ width: colWidth, flex: `0 0 ${colWidth}px` }}
            >
              <span className={value === 0 ? 'text-[var(--gray-300)]' : ''}>
                {value === 0 ? '—' : fmtCompact(value)}
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  const renderAddRow = (type: FinancialMovementType) => {
    if (isReadOnly) return null;
    return (
      <div className="flex border-b border-[var(--gray-100)] bg-[var(--gray-50)]/40">
        <div
          className="sticky left-0 z-20 flex items-center bg-[var(--gray-50)]/40"
          style={{ width: LABEL_COL_WIDTH, paddingLeft: 8 }}
        >
          <button
            type="button"
            onClick={() => onAddRow(type)}
            className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-[var(--gray-200)] bg-white px-2.5 py-1 text-[11px] font-medium text-[var(--gray-500)] hover:border-[var(--primary)] hover:text-[var(--primary)] transition-colors"
          >
            <Plus className="h-3 w-3" strokeWidth={1.5} />
            Agregar fila en {type === 'INFLOW' ? 'Ingresos' : 'Egresos'}
          </button>
        </div>
        <div style={{ flex: 1 }} />
      </div>
    );
  };

  const renderFooterRow = (label: string, kind: 'inflows' | 'outflows' | 'net' | 'closingCash', tone: 'neutral' | 'positive' | 'negative' | 'highlight') => (
    <div
      className="flex border-t border-[var(--gray-200)] bg-white sticky bottom-0"
      style={{ height: ROW_HEIGHT, zIndex: 5 }}
      role="row"
    >
      <StickyLeftCell
        width={LABEL_COL_WIDTH}
        left={0}
        className="text-[12px] font-bold text-[var(--gray-950)]"
        shadow
      >
        {label}
      </StickyLeftCell>
      {columns.map((column) => {
        const value = totalsFor(kind, column.key);
        const color = tone === 'highlight'
          ? 'var(--gray-950)'
          : value > 0
            ? 'var(--success)'
            : value < 0
              ? 'var(--danger)'
              : 'var(--gray-400)';
        return (
          <div
            key={column.key}
            className="flex h-full items-center justify-end px-2 text-[12px] font-bold tabular-nums border-l border-[var(--gray-100)]"
            style={{ width: colWidth, flex: `0 0 ${colWidth}px`, color }}
          >
            {value === 0 ? '—' : fmtCompact(value)}
          </div>
        );
      })}
    </div>
  );

  const renderGroupedRows = (
    list: DisplayRow[],
    rowIndexOffset: number,
  ) => list.map((displayRow, index) => {
    const rowIndex = rowIndexOffset + index;
    return displayRow.kind === 'data'
      ? renderDataRow(displayRow.row, rowIndex, displayRow.depth)
      : renderBucketRow(displayRow, rowIndex);
  });

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      role="grid"
      aria-readonly={isReadOnly}
      aria-rowcount={displayRows.length}
      className="relative overflow-auto rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-white outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
      style={{ maxHeight: 560 }}
    >
      {/* Header row */}
      <div className="sticky top-0 z-30 flex border-b border-[var(--gray-200)] bg-[var(--gray-50)]" style={{ height: HEADER_HEIGHT }}>
        <StickyLeftCell width={LABEL_COL_WIDTH} left={0} className="text-[10px] uppercase tracking-[0.08em] text-[var(--gray-400)]" header shadow>
          Concepto
        </StickyLeftCell>
        {columns.map((column) => (
          <div
            key={column.key}
            className={`flex h-full items-center justify-end px-2 text-[10px] uppercase tracking-[0.08em] border-l border-[var(--gray-200)] ${
              column.isCurrent ? 'text-[var(--primary)]' : 'text-[var(--gray-500)]'
            } ${column.isPast ? 'bg-[var(--gray-100)]' : 'bg-[var(--gray-50)]'}`}
            style={{ width: colWidth, flex: `0 0 ${colWidth}px` }}
            title={column.key}
          >
            {column.label}
          </div>
        ))}
      </div>

      {/* Section: Ingresos */}
      <SectionHeader
        label="Ingresos"
        count={inflowRows.length}
        collapsed={collapsed.INFLOW}
        onToggle={() => toggleSection('INFLOW')}
        width={LABEL_COL_WIDTH}
      />
      {!collapsed.INFLOW && (inflowRows.length === 0 ? (
        <EmptyRow message="Sin ingresos en este escenario." />
      ) : (
        renderGroupedRows(visibleInflowDisplayRows, 0)
      ))}
      {!collapsed.INFLOW && renderAddRow('INFLOW')}

      {/* Section: Egresos */}
      <SectionHeader
        label="Egresos"
        count={outflowRows.length}
        collapsed={collapsed.OUTFLOW}
        onToggle={() => toggleSection('OUTFLOW')}
        width={LABEL_COL_WIDTH}
      />
      {!collapsed.OUTFLOW && (outflowRows.length === 0 ? (
        <EmptyRow message="Sin egresos en este escenario." />
      ) : (
        renderGroupedRows(visibleOutflowDisplayRows, visibleInflowDisplayRows.length)
      ))}
      {!collapsed.OUTFLOW && renderAddRow('OUTFLOW')}

      {/* Footer */}
      {renderFooterRow('Neto', 'net', 'neutral')}
      {renderFooterRow('Caja final', 'closingCash', 'highlight')}

      {isReadOnly && (
        <div className="pointer-events-none sticky top-2 z-40 flex justify-end px-3">
          <span className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-[var(--gray-950)]/85 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.08em] text-white">
            <Lock className="h-3 w-3" strokeWidth={1.5} />
            Solo lectura
          </span>
        </div>
      )}
    </div>
  );
}

function StickyLeftCell({
  width,
  left,
  children,
  className = '',
  header = false,
  shadow = false,
}: {
  width: number;
  left: number;
  children: React.ReactNode;
  className?: string;
  header?: boolean;
  shadow?: boolean;
}) {
  return (
    <div
      className={`sticky flex h-full items-center px-3 ${header ? 'bg-[var(--gray-50)]' : 'bg-white'} border-r border-[var(--gray-200)] ${className}`}
      style={{
        width,
        flex: `0 0 ${width}px`,
        left,
        zIndex: header ? 25 : 15,
        boxShadow: shadow ? '4px 0 6px -4px rgba(15,23,42,0.18)' : undefined,
      }}
    >
      {children}
    </div>
  );
}

function SectionHeader({
  label,
  count,
  collapsed,
  onToggle,
  width,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  width: number;
}) {
  return (
    <div
      className="sticky left-0 flex border-b border-[var(--gray-200)] bg-[var(--gray-50)]"
      style={{ height: 28 }}
      role="row"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="sticky left-0 flex h-full items-center gap-1.5 px-2 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--gray-700)] bg-[var(--gray-50)] hover:bg-[var(--gray-100)] transition-colors"
        style={{ width, zIndex: 18, boxShadow: '4px 0 6px -4px rgba(15,23,42,0.18)' }}
      >
        {collapsed
          ? <ChevronRight className="h-3 w-3" strokeWidth={1.5} />
          : <ChevronDown className="h-3 w-3" strokeWidth={1.5} />}
        <span>{label}</span>
        <span className="ml-1 rounded bg-[var(--gray-200)] px-1.5 py-0.5 text-[9px] font-bold tabular-nums text-[var(--gray-600)]">
          {count}
        </span>
      </button>
    </div>
  );
}

function EmptyRow({ message }: { message: string }) {
  return (
    <div className="px-4 py-3 text-[12px] text-[var(--gray-400)] sticky left-0">{message}</div>
  );
}
