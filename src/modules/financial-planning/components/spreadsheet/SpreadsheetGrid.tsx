import type { CSSProperties } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Lock, Plus, Sparkles, TrendingDown, TrendingUp } from 'lucide-react';
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
  computeVirtualWindow,
} from './gridGeometry';
import { bucketVisual } from './bucketVisuals';
import {
  INTERNAL_PAGADORA_BUCKET,
  INTERNAL_RECON_BUCKET,
  UNIDENTIFIED_BANK_OUTFLOW_BUCKET,
} from '../../services/planningRowTaxonomy';
import { INTERNAL_GROUP_BUCKET } from '../../services/providerCategoryGeneralization';
import { SIN_PAY_CLASS_BUCKET } from '../../services/paymentClassTaxonomy';

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
  /** Click en una celda de datos → detalle de ESA celda (concepto × período). */
  onClickCell?: (conceptKey: string, bucketKey: string) => void;
  onInspectCell?: (conceptKey: string, bucketKey: string) => void;
  onReadOnlyAttempt?: () => void;
  /**
   * Etiqueta de la fila footer de caja. Default 'Caja final'. En vistas sólo
   * históricas (Escenario Base, sin futuro) pasar 'Caja actual': la última
   * columna es el período en curso, no un cierre futuro.
   */
  closingCashLabel?: string;
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

// Chip de criticidad de proveedor (Operativo/Prioritario/Negociable/Flexible).
// Misma paleta que el chip de score del Catálogo de Proveedores para que el
// usuario reconozca el código de color (rojo→verde por flexibilidad de pago).
function providerScoreChipStyle(bucket: 'CRITICO' | 'ALTO' | 'MEDIO' | 'BAJO'): CSSProperties {
  switch (bucket) {
    case 'CRITICO':
      return { background: 'var(--danger-muted)', color: 'var(--danger)' };
    case 'ALTO':
      return { background: '#FEE2E2', color: '#B91C1C' };
    case 'MEDIO':
      return { background: '#FFEDD5', color: '#9A3412' };
    case 'BAJO':
    default:
      return { background: 'var(--success-muted)', color: 'var(--success)' };
  }
}

// Column overscan: extra columns rendered each side of the viewport so fast
// horizontal scroll/keyboard nav never shows a blank edge. Scroll-driven
// virtualization lags the native paint by ~1 frame, so a slightly wider band
// hides the gutter on fast flings without bloating the DOM (a few extra cells).
const COL_OVERSCAN = 5;
// Row overscan: extra rows above/below the viewport per virtualized section.
const ROW_OVERSCAN = 8;
// Two sticky footer rows (Neto + Caja final) reserve space at the bottom so
// keyboard scroll-into-view never parks the selected cell behind them.
const FOOTER_RESERVE = ROW_HEIGHT * 2;

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
    onClickCell,
    onInspectCell,
    onReadOnlyAttempt,
    closingCashLabel = 'Caja final',
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
        const label = displayBucketLabelForRow(row, type);
        const bucket = byBucket.get(label);
        if (bucket) bucket.push(row);
        else byBucket.set(label, [row]);
      }
      return Array.from(byBucket.entries())
        .sort(([a], [b]) => compareBucketLabels(a, b, type))
        .flatMap<DisplayRow>(([label, groupRows]) => {
          const id = bucketId(type, label);
          const sortedRows = [...groupRows].sort((a, b) => a.label.localeCompare(b.label, 'es-MX'));
          const header: DisplayRow = { kind: 'bucket', id, label, rows: sortedRows, type };
          // Los buckets arrancan colapsados; el usuario expande con click.
          const expanded = expandedBuckets[id] ?? false;
          if (!expanded) return [header];
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

  // Pre-aggregated bucket header totals: bucketId → (colKey → Σ of child cells).
  // The bucket header row used to reduce over ALL child rows × the visible
  // columns on EVERY scroll frame (renderBucketRow). That froze the grid the
  // moment a huge bucket entered the viewport — "Proveedores sin categoría"
  // can hold thousands of one-row-per-person movements. Computing the sums once
  // per run / override change (off the scroll path) keeps the header render
  // O(visibleCols) regardless of bucket size. Honors overrides exactly like the
  // previous inline reduce. The window for daily/weekly is bounded
  // (projectionWindowFor), so iterating every column once is cheap.
  const bucketColumnTotals = useMemo(() => {
    const totals = new Map<string, Map<string, number>>();
    const accumulate = (list: DisplayRow[]) => {
      for (const entry of list) {
        if (entry.kind !== 'bucket') continue;
        const colSums = new Map<string, number>();
        for (const child of entry.rows) {
          for (const column of columns) {
            const override = overrideFor(child.conceptKey, column.key);
            const value = override ? override.value : baseValueFor(child.conceptKey, column.key);
            if (value) colSums.set(column.key, (colSums.get(column.key) ?? 0) + value);
          }
        }
        totals.set(entry.id, colSums);
      }
    };
    accumulate(visibleInflowDisplayRows);
    accumulate(visibleOutflowDisplayRows);
    return totals;
  }, [visibleInflowDisplayRows, visibleOutflowDisplayRows, columns, baseValueFor, overrideFor]);

  const colWidth = colWidthForGranularity(granularity);
  // Ancho total scrolleable (label sticky + todas las columnas). Cada fila lo
  // toma como `minWidth` para que su fondo/borde/hover cubra TODO el ancho al
  // hacer scroll horizontal — sin esto, la fila es `width:auto` (= ancho del
  // viewport) y sus columnas a la derecha quedan sin fondo ni borde ("jala mal").
  const contentWidth = LABEL_COL_WIDTH + columns.length * colWidth;

  const [selection, setSelection] = useState<CellCoord | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [draftValue, setDraftValue] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Sólo auto-scrolleamos la celda a la vista cuando el usuario navega por
  // teclado. Un click ya la deja visible, y los recomputes en background
  // (cambio de granularidad, expandir bucket, refetch que cambia el conteo de
  // filas) NO deben jalar la vista de regreso a la selección — esa era la causa
  // del "scroll jala mal".
  const scrollSelectionIntoView = useRef(false);

  // ---- Virtualization DISABLED (2026-06-10) -------------------------------
  // El scroll virtualizado daba problemas persistentes; por decisión del
  // usuario se renderiza TODO (todas las filas y columnas) y el grid crece a su
  // alto natural — sin scroll vertical interno. Se reutiliza la rama
  // `measured === false` que `computeVirtualWindow`/`VirtualRowList` ya usaban
  // en jsdom/primer paint para renderizar la lista completa, así que no hay que
  // reescribir el render. La infraestructura de medición se conserva (inerte)
  // para no propagar cambios; sólo el scroll horizontal nativo sigue activo
  // (necesario para la columna sticky de etiquetas).
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const measured = false;

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setViewport({ w: el.clientWidth, h: el.clientHeight });
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scrollRaf = useRef<number | null>(null);
  const handleScroll = useCallback(() => {
    if (scrollRaf.current != null) return;
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = null;
      const el = containerRef.current;
      if (!el) return;
      const top = el.scrollTop;
      const left = el.scrollLeft;
      // Skip the trailing no-op render when the gesture settled on the same
      // position (a fresh {top,left} object would always re-render).
      setScroll((p) => (p.top === top && p.left === left ? p : { top, left }));
    });
  }, []);
  useEffect(() => () => {
    if (scrollRaf.current != null) cancelAnimationFrame(scrollRaf.current);
  }, []);

  // Ventana de columnas. El clamp de `computeVirtualWindow` es necesario aquí
  // también: un flip de granularidad (daily → monthly) con el scroll a la
  // derecha deja `scroll.left` apuntando más allá de las columnas nuevas; sin
  // clamp, el spacer izquierdo mantenía el ancho inflado y el grid quedaba en
  // blanco sin que el navegador pudiera re-acotar scrollLeft.
  const colCount = columns.length;
  const colWindow = computeVirtualWindow({
    count: colCount,
    itemSize: colWidth,
    scrollOffset: scroll.left,
    viewportSize: viewport.w,
    originOffset: LABEL_COL_WIDTH,
    overscan: COL_OVERSCAN,
    measured,
  });
  const colStart = colWindow.start;
  const colLeftPad = colWindow.leadPx;
  const colRightPad = colWindow.trailPx;
  const visibleColumns = columns.slice(colWindow.start, colWindow.end);

  const leftSpacer = colLeftPad > 0
    ? <div aria-hidden="true" style={{ width: colLeftPad, flex: `0 0 ${colLeftPad}px` }} />
    : null;
  const rightSpacer = colRightPad > 0
    ? <div aria-hidden="true" style={{ width: colRightPad, flex: `0 0 ${colRightPad}px` }} />
    : null;

  // Section vertical offsets (reported by each virtualized list) so keyboard
  // navigation can scroll an off-screen selected cell back into view.
  const inflowTopRef = useRef(0);
  const outflowTopRef = useRef(0);

  const moveSelection = useCallback((dr: number, dc: number) => {
    scrollSelectionIntoView.current = true;
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

  // Keep the selected cell visible when navigating by keyboard while the grid
  // is virtualized. Uniform geometry => exact target coordinates.
  //
  // Anti-forced-reflow: leemos TODAS las props de layout primero (scrollLeft,
  // scrollTop, clientWidth, clientHeight), calculamos los targets, y SOLO al
  // final aplicamos los writes. La versión previa intercalaba un read de
  // scrollTop después de un write a scrollLeft — eso forzaba al navegador a
  // recalcular layout entre los dos bloques (Layout event de ~1.2s en perf
  // traces). Además guard de equality antes del write para evitar
  // re-disparar scroll listeners cuando no cambia el valor.
  useEffect(() => {
    if (!measured || !selection) return;
    // Sólo seguir a la celda cuando la selección la movió el teclado. Sin este
    // guard, un cambio de granularidad (colWidth) o del conteo de filas
    // (visibleInflowDisplayRows.length) re-disparaba el efecto y jalaba el
    // scroll a la selección de golpe.
    if (!scrollSelectionIntoView.current) return;
    scrollSelectionIntoView.current = false;
    const el = containerRef.current;
    if (!el) return;
    const scrollLeft = el.scrollLeft;
    const scrollTop = el.scrollTop;
    const clientWidth = el.clientWidth;
    const clientHeight = el.clientHeight;
    const targetLeft = LABEL_COL_WIDTH + selection.colIndex * colWidth;
    const targetRight = targetLeft + colWidth;
    let nextScrollLeft = scrollLeft;
    if (targetLeft < scrollLeft + LABEL_COL_WIDTH) {
      nextScrollLeft = Math.max(0, targetLeft - LABEL_COL_WIDTH);
    } else if (targetRight > scrollLeft + clientWidth) {
      nextScrollLeft = targetRight - clientWidth;
    }
    const inflowLen = visibleInflowDisplayRows.length;
    const localTop = selection.rowIndex < inflowLen
      ? inflowTopRef.current + selection.rowIndex * ROW_HEIGHT
      : outflowTopRef.current + (selection.rowIndex - inflowLen) * ROW_HEIGHT;
    const targetTop = localTop;
    const targetBottom = localTop + ROW_HEIGHT;
    let nextScrollTop = scrollTop;
    if (targetTop < scrollTop) {
      nextScrollTop = targetTop;
    } else if (targetBottom > scrollTop + clientHeight - FOOTER_RESERVE) {
      nextScrollTop = targetBottom - clientHeight + FOOTER_RESERVE;
    }
    if (nextScrollLeft !== scrollLeft) el.scrollLeft = nextScrollLeft;
    if (nextScrollTop !== scrollTop) el.scrollTop = nextScrollTop;
  }, [selection, measured, colWidth, visibleInflowDisplayRows.length]);

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
      style={{ height: ROW_HEIGHT, minWidth: contentWidth }}
    >
      <StickyLeftCell width={LABEL_COL_WIDTH} left={0} shadow>
        <button
          type="button"
          onClick={() => onClickRow?.(row.conceptKey)}
          // `title` muestra la subcategoría fina del egreso (Combustibles,
          // Indirectos, Servicios TI, etc.) o providerCategory cuando el
          // catálogo lo enriqueció. Discoverable via hover sin romper la
          // altura uniforme de fila que requiere la virtualización del grid.
          title={[
            row.label,
            row.providerCategoryLabel && row.providerCategoryLabel !== row.label
              ? row.providerCategoryLabel
              : row.subgroupLabel && row.subgroupLabel !== row.label
                ? row.subgroupLabel
                : null,
            row.providerScoreLabel ? `Criticidad: ${row.providerScoreLabel}` : null,
          ].filter(Boolean).join(' · ')}
          className="flex w-full items-center gap-1.5 truncate text-left text-[12px] font-medium text-[var(--gray-950)] hover:text-[var(--primary)]"
          style={{ paddingLeft: depth * 18 }}
        >
          {row.isCustom && <Sparkles className="h-3 w-3 text-[var(--primary)]" strokeWidth={1.5} />}
          <span className="truncate">{row.label}</span>
          {row.providerScoreLabel && row.providerScoreBucket && (
            <span
              className="ml-auto shrink-0 truncate rounded-sm px-1 text-[9px] font-medium"
              style={providerScoreChipStyle(row.providerScoreBucket)}
            >
              {row.providerScoreLabel}
            </span>
          )}
          {row.providerCategoryLabel && row.providerCategoryLabel !== row.label && (
            <span
              className={`${row.providerScoreLabel ? '' : 'ml-auto'} shrink-0 truncate rounded-sm bg-[var(--gray-100)] px-1 text-[9px] font-normal text-[var(--gray-600)]`}
            >
              {row.providerCategoryLabel}
            </span>
          )}
        </button>
      </StickyLeftCell>
      {leftSpacer}
      {visibleColumns.map((column, vi) => {
        const colIndex = colStart + vi;
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
              onClickCell?.(row.conceptKey, column.key);
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
      {rightSpacer}
    </div>
  );

  const renderBucketRow = (group: Extract<DisplayRow, { kind: 'bucket' }>, rowIndex: number) => {
    const expanded = expandedBuckets[group.id] ?? false;
    const visual = bucketVisual(group.label, group.type);
    const colSums = bucketColumnTotals.get(group.id);
    return (
      <div
        key={group.id}
        role="row"
        className="flex border-b border-[var(--gray-100)] bg-[var(--gray-50)]/70 hover:bg-[var(--gray-100)]/70"
        style={{ height: ROW_HEIGHT, minWidth: contentWidth }}
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
            <visual.Icon className="h-3.5 w-3.5 shrink-0" style={{ color: visual.color }} strokeWidth={1.75} />
            <span className="truncate">{group.label}</span>
            <span className="ml-auto rounded bg-white px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-[var(--gray-500)]">
              {group.rows.length}
            </span>
          </button>
        </StickyLeftCell>
        {leftSpacer}
        {visibleColumns.map((column, vi) => {
          const colIndex = colStart + vi;
          const value = colSums?.get(column.key) ?? 0;
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
        {rightSpacer}
      </div>
    );
  };

  const renderAddRow = (type: FinancialMovementType) => {
    if (isReadOnly) return null;
    return (
      <div className="flex border-b border-[var(--gray-100)] bg-[var(--gray-50)]/40" style={{ minWidth: contentWidth }}>
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

  // `bottom` apila los footers sticky (Neto sobre Caja). Con ambos en bottom:0
  // se encimaban al scrollear y la fila Neto quedaba oculta bajo Caja final.
  // zIndex 22: el footer debe taparlo TODO lo que scrollea por debajo — las
  // celdas sticky de etiqueta de las filas (z 15) y el botón de header de
  // sección (z 18) crean stacking contexts en el contexto raíz; con el footer
  // en z 5 esas etiquetas se pintaban ENCIMA de Neto/Caja al pasar por detrás
  // (filas "fantasma" bajo la Caja que parecían inalcanzables) y además
  // interceptaban los clicks del footer (un click en Caja expandía un bucket).
  // 22 queda debajo del header de columnas (z 25/30) y del pill read-only (40).
  const renderFooterRow = (label: string, kind: 'inflows' | 'outflows' | 'net' | 'closingCash', tone: 'neutral' | 'positive' | 'negative' | 'highlight', bottom = 0) => (
    <div
      className="flex border-t border-[var(--gray-200)] sticky"
      style={{ height: ROW_HEIGHT, bottom, zIndex: 22, minWidth: contentWidth, background: tone === 'highlight' ? 'var(--gray-50)' : 'white' }}
      role="row"
    >
      <StickyLeftCell
        width={LABEL_COL_WIDTH}
        left={0}
        className="text-[12px] font-bold text-[var(--gray-950)]"
        style={{ background: tone === 'highlight' ? 'var(--gray-50)' : undefined }}
        accent={tone === 'highlight' ? 'var(--primary)' : undefined}
        shadow
      >
        {label}
      </StickyLeftCell>
      {leftSpacer}
      {visibleColumns.map((column) => {
        const value = totalsFor(kind, column.key);
        const color = tone === 'highlight'
          ? (value < 0 ? 'var(--danger)' : 'var(--gray-950)')
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
      {rightSpacer}
    </div>
  );

  const renderSubtotalRow = (label: string, kind: 'inflows' | 'outflows') => {
    const isIncome = kind === 'inflows';
    const accent = isIncome ? 'var(--success)' : 'var(--danger)';
    const tint = isIncome ? 'var(--success-muted)' : 'var(--danger-muted)';
    return (
      <div
        className="flex border-b-2 border-[var(--gray-300)]"
        style={{ height: ROW_HEIGHT, minWidth: contentWidth, background: tint }}
        role="row"
      >
        <StickyLeftCell
          width={LABEL_COL_WIDTH}
          left={0}
          className="text-[12px] font-bold uppercase tracking-[0.04em]"
          style={{ background: tint, color: accent }}
          accent={accent}
          shadow
        >
          {label}
        </StickyLeftCell>
        {leftSpacer}
        {visibleColumns.map((column) => {
          const value = totalsFor(kind, column.key);
          return (
            <div
              key={column.key}
              className="flex h-full items-center justify-end px-2 text-[12px] font-bold tabular-nums border-l border-[var(--gray-100)]"
              style={{ width: colWidth, flex: `0 0 ${colWidth}px`, color: accent }}
            >
              <span className={value === 0 ? 'text-[var(--gray-300)]' : ''}>
                {value === 0 ? '—' : fmtCompact(value)}
              </span>
            </div>
          );
        })}
        {rightSpacer}
      </div>
    );
  };

  const renderDisplayRow = (displayRow: DisplayRow, rowIndex: number) =>
    displayRow.kind === 'data'
      ? renderDataRow(displayRow.row, rowIndex, displayRow.depth)
      : renderBucketRow(displayRow, rowIndex);

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onScroll={handleScroll}
      role="grid"
      aria-readonly={isReadOnly}
      aria-rowcount={displayRows.length}
      className="relative overflow-x-auto overflow-y-visible overscroll-contain rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-white outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
      // Sin virtualización: el grid se muestra completo, a su alto natural (sin
      // `maxHeight` → no hay scroll vertical interno; el desbordamiento vertical
      // lo maneja la página). Sólo queda `overflow-x-auto` para el scroll
      // horizontal nativo, que la columna sticky de etiquetas necesita.
      style={{}}
    >
      {/* Header row */}
      <div className="sticky top-0 z-30 flex border-b border-[var(--gray-200)] bg-[var(--gray-50)]" style={{ height: HEADER_HEIGHT, minWidth: contentWidth }}>
        <StickyLeftCell width={LABEL_COL_WIDTH} left={0} className="text-[10px] uppercase tracking-[0.08em] text-[var(--gray-400)]" header shadow>
          Concepto
        </StickyLeftCell>
        {leftSpacer}
        {visibleColumns.map((column) => (
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
        {rightSpacer}
      </div>

      {/* Section: Ingresos */}
      <SectionHeader
        label="Ingresos"
        count={inflowRows.length}
        collapsed={collapsed.INFLOW}
        onToggle={() => toggleSection('INFLOW')}
        width={LABEL_COL_WIDTH}
        type="INFLOW"
      />
      {!collapsed.INFLOW && (inflowRows.length === 0 ? (
        <EmptyRow message="Sin ingresos en este escenario." />
      ) : (
        <VirtualRowList
          list={visibleInflowDisplayRows}
          rowIndexOffset={0}
          scrollTop={scroll.top}
          viewportH={viewport.h}
          measured={measured}
          renderRow={renderDisplayRow}
          onTop={(t) => { inflowTopRef.current = t; }}
        />
      ))}
      {!collapsed.INFLOW && renderAddRow('INFLOW')}

      {/* Subtotal: total de ingresos antes de egresos */}
      {inflowRows.length > 0 && renderSubtotalRow('Total Ingresos', 'inflows')}

      {/* Section: Egresos */}
      <SectionHeader
        label="Egresos"
        count={outflowRows.length}
        collapsed={collapsed.OUTFLOW}
        onToggle={() => toggleSection('OUTFLOW')}
        width={LABEL_COL_WIDTH}
        type="OUTFLOW"
      />
      {!collapsed.OUTFLOW && (outflowRows.length === 0 ? (
        <EmptyRow message="Sin egresos en este escenario." />
      ) : (
        <VirtualRowList
          list={visibleOutflowDisplayRows}
          rowIndexOffset={visibleInflowDisplayRows.length}
          scrollTop={scroll.top}
          viewportH={viewport.h}
          measured={measured}
          renderRow={renderDisplayRow}
          onTop={(t) => { outflowTopRef.current = t; }}
        />
      ))}
      {!collapsed.OUTFLOW && renderAddRow('OUTFLOW')}

      {/* Subtotal: total de egresos antes del neto */}
      {outflowRows.length > 0 && renderSubtotalRow('Total Egresos', 'outflows')}

      {/* Footer */}
      {renderFooterRow('Neto', 'net', 'neutral', ROW_HEIGHT)}
      {renderFooterRow(closingCashLabel, 'closingCash', 'highlight')}

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

/**
 * Grupos de egreso que NO describen un gasto: son residuos o movimientos
 * internos. Van al final para que la lista arranque con la clasificación de
 * pago real; el resto ordena alfabético (es-MX), así que todos los
 * `Servicios · …` quedan juntos y los numerados (`010 - …`, `220 - …`) salen en
 * orden de código dentro de su clasificación general.
 */
const OUTFLOW_TAIL_BUCKETS = [
  SIN_PAY_CLASS_BUCKET,
  INTERNAL_PAGADORA_BUCKET,
  INTERNAL_GROUP_BUCKET,
  UNIDENTIFIED_BANK_OUTFLOW_BUCKET,
  INTERNAL_RECON_BUCKET,
  'Manual',
];

function compareBucketLabels(a: string, b: string, type: FinancialMovementType): number {
  if (type === 'INFLOW') return a.localeCompare(b, 'es-MX');
  const ai = OUTFLOW_TAIL_BUCKETS.indexOf(a);
  const bi = OUTFLOW_TAIL_BUCKETS.indexOf(b);
  if (ai !== -1 || bi !== -1) {
    if (ai === -1) return -1;
    if (bi === -1) return 1;
    if (ai !== bi) return ai - bi;
  }
  return a.localeCompare(b, 'es-MX');
}

/**
 * Etiqueta del grupo. Para egresos, `bucketLabel` YA es la clasificación de pago
 * cruda de JDE (`paymentClassTaxonomy`), así que no se le cuelga el sufijo
 * `· categoría` que usaba el bucketing generalizado — sería duplicar la misma
 * información y fragmentaría el grupo.
 */
function displayBucketLabelForRow(row: PlanningRow, type: FinancialMovementType): string {
  const fallback = type === 'INFLOW' ? 'Otros ingresos' : UNIDENTIFIED_BANK_OUTFLOW_BUCKET;
  return row.bucketLabel || fallback;
}

// Renders only the rows intersecting the scroll viewport. Row height is
// uniform so a top/bottom spacer reproduces full scroll height exactly,
// keeping every sibling (subtotals, footers, the other section) in place.
// Until the grid is measured it renders the whole list (tests / first paint).
function VirtualRowList({
  list,
  rowIndexOffset,
  scrollTop,
  viewportH,
  measured,
  renderRow,
  onTop,
}: {
  list: DisplayRow[];
  rowIndexOffset: number;
  scrollTop: number;
  viewportH: number;
  measured: boolean;
  renderRow: (displayRow: DisplayRow, rowIndex: number) => React.ReactNode;
  onTop: (top: number) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);

  useLayoutEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const offset = node.offsetTop;
    // Only react when the section actually moved (sibling collapse shifts it).
    // Unguarded, this fired setTop + a re-render on every render/scroll frame.
    if (offset !== top) {
      setTop(offset);
      onTop(offset);
    }
  });

  // El clamp de `computeVirtualWindow` preserva la altura total de la sección
  // (padTop + filas + padBottom == n × ROW_HEIGHT) aunque el scroll esté más
  // allá de su final — p.ej. scrolleando profundo en Egresos, la ventana de
  // Ingresos queda pasada de largo. Sin clamp, padTop crecía 1px por cada 1px
  // de scroll y el fondo del grid se volvía inalcanzable.
  const n = list.length;
  const win = computeVirtualWindow({
    count: n,
    itemSize: ROW_HEIGHT,
    scrollOffset: scrollTop,
    viewportSize: viewportH,
    originOffset: top,
    overscan: ROW_OVERSCAN,
    measured,
  });

  return (
    <div ref={wrapRef}>
      {win.leadPx > 0 && <div aria-hidden="true" style={{ height: win.leadPx }} />}
      {list.slice(win.start, win.end).map((displayRow, i) => renderRow(displayRow, rowIndexOffset + win.start + i))}
      {win.trailPx > 0 && <div aria-hidden="true" style={{ height: win.trailPx }} />}
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
  accent,
  style,
}: {
  width: number;
  left: number;
  children: React.ReactNode;
  className?: string;
  header?: boolean;
  shadow?: boolean;
  /** Barra de acento (inset) en el borde izquierdo, p.ej. para subtotales. */
  accent?: string;
  /** Estilos extra (background/color). El boxShadow lo gobierna shadow+accent. */
  style?: CSSProperties;
}) {
  const boxShadow = [
    accent ? `inset 3px 0 0 ${accent}` : null,
    shadow ? '4px 0 6px -4px rgba(15,23,42,0.18)' : null,
  ]
    .filter(Boolean)
    .join(', ') || undefined;
  return (
    <div
      className={`sticky flex h-full items-center px-3 ${header ? 'bg-[var(--gray-50)]' : 'bg-white'} border-r border-[var(--gray-200)] ${className}`}
      style={{
        width,
        flex: `0 0 ${width}px`,
        left,
        zIndex: header ? 25 : 15,
        ...style,
        boxShadow,
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
  type,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  width: number;
  type: FinancialMovementType;
}) {
  const isIncome = type === 'INFLOW';
  const accent = isIncome ? 'var(--success)' : 'var(--danger)';
  const TrendIcon = isIncome ? TrendingUp : TrendingDown;
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
        className="sticky left-0 flex h-full items-center gap-1.5 pr-2 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--gray-700)] bg-[var(--gray-50)] hover:bg-[var(--gray-100)] transition-colors"
        style={{ width, zIndex: 18, paddingLeft: 8, boxShadow: `inset 3px 0 0 ${accent}, 4px 0 6px -4px rgba(15,23,42,0.18)` }}
      >
        {collapsed
          ? <ChevronRight className="h-3 w-3 shrink-0" strokeWidth={1.5} />
          : <ChevronDown className="h-3 w-3 shrink-0" strokeWidth={1.5} />}
        <TrendIcon className="h-3.5 w-3.5 shrink-0" style={{ color: accent }} strokeWidth={2} />
        <span style={{ color: accent }}>{label}</span>
        <span
          className="ml-1 rounded px-1.5 py-0.5 text-[9px] font-bold tabular-nums"
          style={{ background: isIncome ? 'var(--success-muted)' : 'var(--danger-muted)', color: accent }}
        >
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
