/**
 * Primitivas de chart compartidas por las sub-pestañas de Nómina.
 *
 * - `useHasBox`: evita que Recharts intente medir un contenedor 0×0 (sucede
 *   cuando la sub-pestaña está oculta o en el primer paint). Mismo patrón que
 *   `CashFlowChart.tsx`.
 * - `ChartCard`: tarjeta con título + subtítulo siguiendo el DS (tokens, no
 *   tailwind raw de color).
 * - `DonutChart` + `CategoryLegend`: composición por categoría.
 */

import { useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { fmtCompact, fmtCurrency } from '../../../formatters';
import type { CategoryTotal } from '../services/payrollAnalyticsService';

export function useHasBox<T extends HTMLElement>() {
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

export function ChartCard({
  title,
  subtitle,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-[var(--radius-lg)] border p-4 ${className ?? ''}`}
      style={{ borderColor: 'var(--gray-200)', background: 'var(--surface)' }}
    >
      <header className="mb-3">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--gray-900)' }}>
          {title}
        </h3>
        {subtitle && (
          <p className="text-xs" style={{ color: 'var(--gray-500)' }}>
            {subtitle}
          </p>
        )}
      </header>
      {children}
    </section>
  );
}

const TOOLTIP_STYLE = {
  border: '1px solid var(--gray-200)',
  borderRadius: '10px',
  fontSize: 12,
  background: 'var(--surface)',
} as const;

export { TOOLTIP_STYLE };

/**
 * Marco responsivo para un chart de Recharts con guarda de caja 0×0. El hijo
 * debe ser un único elemento de Recharts (BarChart, LineChart, …).
 */
export function ChartFrame({ height, children }: { height: number; children: ReactElement }) {
  const [boxRef, hasBox] = useHasBox<HTMLDivElement>();
  return (
    <div ref={boxRef} style={{ height }}>
      {hasBox && (
        <ResponsiveContainer width="100%" height="100%" debounce={120}>
          {children}
        </ResponsiveContainer>
      )}
    </div>
  );
}

/** Donut de composición por categoría. */
export function DonutChart({ data, height = 240 }: { data: CategoryTotal[]; height?: number }) {
  const [boxRef, hasBox] = useHasBox<HTMLDivElement>();
  return (
    <div ref={boxRef} style={{ height }}>
      {hasBox && (
        <ResponsiveContainer width="100%" height="100%" debounce={120}>
          <PieChart>
            <Pie
              data={data}
              dataKey="total"
              nameKey="label"
              innerRadius="55%"
              outerRadius="80%"
              paddingAngle={1}
              isAnimationActive={false}
            >
              {data.map((d) => (
                <Cell key={d.key} fill={d.color} stroke="var(--surface)" strokeWidth={1} />
              ))}
            </Pie>
            <Tooltip
              isAnimationActive={false}
              contentStyle={TOOLTIP_STYLE}
              formatter={(value: number, _name, item) => {
                const pct = (item?.payload as CategoryTotal | undefined)?.pct ?? 0;
                return [`${fmtCurrency(value)} · ${pct.toFixed(1)}%`, (item?.payload as CategoryTotal)?.label];
              }}
            />
          </PieChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

/** Leyenda tabular con monto y participación. */
export function CategoryLegend({ data }: { data: CategoryTotal[] }) {
  return (
    <ul className="space-y-1.5 text-sm">
      {data.map((d) => (
        <li key={d.key} className="flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
            style={{ background: d.color }}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--gray-700)' }}>
            {d.label}
          </span>
          <span className="tabular-nums font-medium" style={{ color: 'var(--gray-900)' }}>
            {fmtCompact(d.total)}
          </span>
          <span className="w-12 text-right tabular-nums text-xs" style={{ color: 'var(--gray-500)' }}>
            {d.pct.toFixed(1)}%
          </span>
        </li>
      ))}
    </ul>
  );
}
