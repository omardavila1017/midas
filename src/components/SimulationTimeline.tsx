import React, { useMemo, useState } from 'react';
import { CATEGORY_COLORS } from '../types';
import type { SimulationCategory } from '../types';

const MONTH_SHORT_ES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'] as const;

/* ─────────────────────────────────────────────────
   Types
   ───────────────────────────────────────────────── */

interface Simulation {
  id: string;
  name: string;
  category: SimulationCategory;
  startYearMonth: string; // "2025-01"
  endYearMonth?: string; // "2025-06"
}

interface SimulationTimelineProps {
  simulations: Simulation[];
  year: number;
  onSimulationClick?: (id: string) => void;
}

interface ParsedSimulation extends Simulation {
  startMonth: number; // 0-11
  endMonth: number; // 0-11
}

interface TimelineRow {
  rowIndex: number;
  simulation: ParsedSimulation;
}

interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  simulation: ParsedSimulation | null;
}

/* ─────────────────────────────────────────────────
   Helper Functions
   ───────────────────────────────────────────────── */

/**
 * Parse "2025-01" format into month index (0-11)
 */
function parseYearMonth(yearMonth: string): number {
  const parts = yearMonth.split('-');
  const month = parseInt(parts[1], 10);
  return month - 1; // Convert to 0-based index
}

/**
 * Determine row assignment for stacked bars
 * Returns the minimum row where this bar doesn't overlap with existing bars
 */
function assignRow(
  simulation: ParsedSimulation,
  assignedRows: Map<number, { start: number; end: number }[]>,
): number {
  let row = 0;
  const { startMonth, endMonth } = simulation;

  while (assignedRows.has(row)) {
    const occupants = assignedRows.get(row)!;
    const hasOverlap = occupants.some(
      occupant =>
        !(endMonth < occupant.start || startMonth > occupant.end),
    );

    if (hasOverlap) {
      row++;
    } else {
      break;
    }
  }

  if (!assignedRows.has(row)) {
    assignedRows.set(row, []);
  }
  assignedRows.get(row)!.push({ start: startMonth, end: endMonth });

  return row;
}

/**
 * Format date range for tooltip
 */
function formatDateRange(start: number, end: number, year: number): string {
  const startLabel = MONTH_SHORT_ES[start];
  const endLabel = MONTH_SHORT_ES[end];
  return startLabel === endLabel
    ? `${startLabel} ${year}`
    : `${startLabel} - ${endLabel} ${year}`;
}

/* ─────────────────────────────────────────────────
   Component: SimulationBar
   ───────────────────────────────────────────────── */

interface SimulationBarProps {
  simulation: ParsedSimulation;
  startMonth: number;
  endMonth: number;
  row: number;
  onHover: (sim: ParsedSimulation | null, x: number, y: number) => void;
  onClick: () => void;
  year: number;
}

const SimulationBar: React.FC<SimulationBarProps> = ({
  simulation,
  startMonth,
  endMonth,
  row,
  onHover,
  onClick,
  year,
}) => {
  const columnWidth = 100 / 12; // Each month is 1/12 of the container
  const barStart = startMonth * columnWidth;
  const barWidth = (endMonth - startMonth + 1) * columnWidth;
  const barHeight = 32;
  const barGap = 8;
  const topOffset = row * (barHeight + barGap);

  const categoryColor = CATEGORY_COLORS[simulation.category];
  const truncatedName =
    simulation.name.length > 20
      ? simulation.name.substring(0, 17) + '...'
      : simulation.name;

  return (
    <div
      className="absolute transition-all duration-200 cursor-pointer group hover:z-10"
      style={{
        left: `${barStart}%`,
        top: `${topOffset}px`,
        width: `${barWidth}%`,
        height: `${barHeight}px`,
        animation: `cardIn 0.5s cubic-bezier(0.22, 1, 0.36, 1) forwards`,
        animationDelay: `${row * 50}ms`,
      }}
      onMouseEnter={e => {
        const rect = e.currentTarget.getBoundingClientRect();
        onHover(simulation, rect.left, rect.top - 8);
      }}
      onMouseLeave={() => onHover(null, 0, 0)}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      aria-label={`${simulation.name} - ${simulation.category}`}
    >
      {/* Bar background */}
      <div
        className="h-full rounded-md px-3 py-1 flex items-center group-hover:shadow-md transition-shadow"
        style={{
          backgroundColor: categoryColor,
          opacity: 0.9,
        }}
      >
        {/* Bar label text */}
        <span className="text-xs font-medium text-white truncate">
          {truncatedName}
        </span>
      </div>

      {/* Hover indicator border */}
      <div
        className="absolute inset-0 rounded-md border-2 border-white opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
        style={{
          borderColor: categoryColor,
        }}
      />
    </div>
  );
};

/* ─────────────────────────────────────────────────
   Component: Tooltip
   ───────────────────────────────────────────────── */

interface TooltipProps {
  visible: boolean;
  x: number;
  y: number;
  simulation: ParsedSimulation | null;
  year: number;
}

const Tooltip: React.FC<TooltipProps> = ({
  visible,
  x,
  y,
  simulation,
  year,
}) => {
  if (!visible || !simulation) return null;

  const categoryColor = CATEGORY_COLORS[simulation.category];
  const dateRange = formatDateRange(simulation.startMonth, simulation.endMonth, year);

  return (
    <div
      className="fixed z-50 pointer-events-none"
      style={{
        left: `${x}px`,
        top: `${y}px`,
        transform: 'translateX(-50%)',
      }}
    >
      <div
        className="bg-gray-950 text-white rounded-md px-3 py-2 shadow-lg text-xs whitespace-nowrap"
        style={{
          boxShadow: '0 8px 25px -5px rgba(0,0,0,0.12)',
        }}
      >
        <div className="font-semibold">{simulation.name}</div>
        <div className="text-gray-300 mt-1">{simulation.category}</div>
        <div className="text-gray-400 mt-1">{dateRange}</div>

        {/* Tooltip arrow */}
        <div
          className="absolute w-2 h-2 bg-gray-950 transform -bottom-1 left-1/2 -translate-x-1/2 rotate-45"
          style={{
            boxShadow: '0 8px 25px -5px rgba(0,0,0,0.12)',
          }}
        />
      </div>
    </div>
  );
};

/* ─────────────────────────────────────────────────
   Component: Legend
   ───────────────────────────────────────────────── */

const Legend: React.FC = () => {
  const categories: SimulationCategory[] = [
    'Reducción de Costos',
    'Incremento de Ingresos',
    'Diferimiento',
    'Renegociación',
  ];

  return (
    <div className="flex flex-wrap gap-4 mt-6 pt-4 border-t border-gray-200">
      {categories.map(category => (
        <div key={category} className="flex items-center gap-2">
          <div
            className="w-3 h-3 rounded-sm"
            style={{
              backgroundColor: CATEGORY_COLORS[category],
            }}
          />
          <span className="text-xs text-gray-700 font-medium">{category}</span>
        </div>
      ))}
    </div>
  );
};

/* ─────────────────────────────────────────────────
   Main Component: SimulationTimeline
   ───────────────────────────────────────────────── */

const SimulationTimeline: React.FC<SimulationTimelineProps> = ({
  simulations,
  year,
  onSimulationClick,
}) => {
  const [tooltip, setTooltip] = useState<TooltipState>({
    visible: false,
    x: 0,
    y: 0,
    simulation: null,
  });

  // Parse simulations and assign to rows
  const { parsedSimulations, rowMap, rowCount, timelineHeight } = useMemo(() => {
    const parsed: ParsedSimulation[] = simulations.map(sim => ({
      ...sim,
      startMonth: parseYearMonth(sim.startYearMonth),
      endMonth: sim.endYearMonth
        ? parseYearMonth(sim.endYearMonth)
        : parseYearMonth(sim.startYearMonth),
    }));

    const assignedRows = new Map<number, { start: number; end: number }[]>();
    const idToRow = new Map<string, number>();

    parsed.forEach(sim => {
      const row = assignRow(sim, assignedRows);
      idToRow.set(sim.id, row);
    });

    const maxRow = Math.max(0, ...Array.from(idToRow.values()));
    const numRows = maxRow + 1;
    const barHeight = 32;
    const barGap = 8;
    const totalHeight = numRows * (barHeight + barGap) + 16; // 16px bottom padding

    return {
      parsedSimulations: parsed,
      rowMap: idToRow,
      rowCount: numRows,
      timelineHeight: totalHeight,
    };
  }, [simulations]);

  // Empty state
  if (simulations.length === 0) {
    return (
      <div className="w-full bg-gray-50 rounded-lg border border-gray-200 p-8">
        <div className="flex flex-col items-center justify-center text-center">
          <div className="w-12 h-12 rounded-full bg-gray-200 flex items-center justify-center mb-3">
            <span className="text-gray-500">—</span>
          </div>
          <p className="text-sm font-medium text-gray-700">Sin simulaciones activas</p>
          <p className="text-xs text-gray-500 mt-1">
            Crea una simulación para visualizarla aquí
          </p>
        </div>
      </div>
    );
  }

  const handleBarClick = (id: string) => {
    onSimulationClick?.(id);
  };

  const handleHover = (sim: ParsedSimulation | null, x: number, y: number) => {
    setTooltip({
      visible: !!sim,
      x,
      y,
      simulation: sim,
    });
  };

  return (
    <div className="w-full">
      {/* Timeline container */}
      <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
        {/* Header row with month labels */}
        <div className="flex bg-gray-50 border-b border-gray-200">
          {MONTH_SHORT_ES.map((month: string, index: number) => (
            <div
              key={index}
              className="flex-1 px-2 py-3 text-center text-xs font-semibold text-gray-700 border-r border-gray-200 last:border-r-0"
            >
              {month}
            </div>
          ))}
        </div>

        {/* Simulation bars container */}
        <div
          className="relative w-full bg-white"
          style={{
            minHeight: `${Math.max(120, timelineHeight)}px`,
            display: 'flex',
            flexDirection: 'row',
          }}
        >
          {/* Vertical month dividers */}
          <div className="absolute inset-0 flex pointer-events-none">
            {Array.from({ length: 11 }).map((_, index) => (
              <div
                key={index}
                className="flex-1 border-r border-gray-100"
                style={{
                  borderRightWidth: '1px',
                }}
              />
            ))}
          </div>

          {/* Bars container */}
          <div className="relative w-full p-4">
            {parsedSimulations.map(sim => {
              const row = rowMap.get(sim.id) ?? 0;

              return (
                <SimulationBar
                  key={sim.id}
                  simulation={sim}
                  startMonth={sim.startMonth}
                  endMonth={sim.endMonth}
                  row={row}
                  onHover={handleHover}
                  onClick={() => handleBarClick(sim.id)}
                  year={year}
                />
              );
            })}
          </div>
        </div>
      </div>

      {/* Legend */}
      <Legend />

      {/* Tooltip */}
      <Tooltip
        visible={tooltip.visible}
        x={tooltip.x}
        y={tooltip.y}
        simulation={tooltip.simulation}
        year={year}
      />

      {/* Animation keyframes */}
      <style>{`
        @keyframes cardIn {
          from {
            opacity: 0;
            transform: translateY(8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  );
};

export default SimulationTimeline;
