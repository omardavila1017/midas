import React, { useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { hex } from '../theme';

export interface WaterfallChartProps {
  data: {
    label: string;
    value: number;
    category?: 'income' | 'expense' | 'balance';
  }[];
  height?: number;
  className?: string;
}

/**
 * Waterfall chart component using Recharts BarChart with stacked bars.
 * Positive values (income) render green, negative (expense) red, balance blue.
 * Uses invisible connector bars to position each bar at the correct height.
 */
export default function WaterfallChart({
  data,
  height = 400,
  className = '',
}: WaterfallChartProps) {
  // Transform data into stacked bar format with connectors
  const chartData = useMemo(() => {
    let runningTotal = 0;

    return data.map((item) => {
      const isExpense = item.value < 0;
      const isBalance = item.category === 'balance';
      const absoluteValue = Math.abs(item.value);

      let connector = 0;
      let bar = 0;

      if (isBalance) {
        // Balance bars show absolute value from zero
        bar = item.value;
      } else {
        // Income/expense bars: connector positions the bar at running total
        connector = runningTotal;
        bar = absoluteValue;
        runningTotal += item.value;
      }

      return {
        label: item.label,
        connector,
        bar,
        value: item.value,
        isExpense,
        isBalance,
        runningTotal: isBalance ? item.value : runningTotal,
      };
    });
  }, [data]);

  // Format currency for Y-axis (compact: 1M, 1.2M, etc.)
  const formatCurrency = (value: number): string => {
    if (value === 0) return '0';
    const absValue = Math.abs(value);
    if (absValue >= 1_000_000) {
      return `$${(value / 1_000_000).toFixed(1)}M`;
    }
    if (absValue >= 1_000) {
      return `$${(value / 1_000).toFixed(1)}K`;
    }
    return `$${value}`;
  };

  // Custom tooltip
  const CustomTooltip = ({
    active,
    payload,
  }: {
    active?: boolean;
    payload?: Array<{ payload: (typeof chartData)[0] }>;
  }) => {
    if (!active || !payload || payload.length === 0) return null;

    const item = payload[0].payload;
    return (
      <div
        className="rounded-lg border border-gray-300 bg-white p-2 shadow-md"
        style={{ borderColor: hex.gray200, backgroundColor: '#ffffff' }}
      >
        <p className="text-sm font-medium" style={{ color: hex.gray950 }}>
          {item.label}
        </p>
        <p className="text-xs" style={{ color: hex.gray700 }}>
          Value: {formatCurrency(item.value)}
        </p>
        <p className="text-xs" style={{ color: hex.gray700 }}>
          Total: {formatCurrency(item.runningTotal)}
        </p>
      </div>
    );
  };

  return (
    <div className={className}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          data={chartData}
          margin={{ top: 16, right: 32, left: 32, bottom: 16 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke={hex.gray200}
            vertical={false}
          />

          <XAxis
            dataKey="label"
            tick={{ fill: hex.gray700, fontSize: 12 }}
            axisLine={{ stroke: hex.gray200 }}
            tickLine={false}
          />

          <YAxis
            tickFormatter={formatCurrency}
            tick={{ fill: hex.gray700, fontSize: 12 }}
            axisLine={{ stroke: hex.gray200 }}
            tickLine={false}
          />

          <Tooltip content={<CustomTooltip />} cursor={false} />

          {/* Connector bars (invisible, just for positioning) */}
          <Bar
            dataKey="connector"
            stackId="waterfall"
            fill="transparent"
            isAnimationActive={false}
          />

          {/* Colored bars (income/expense/balance) */}
          <Bar
            dataKey="bar"
            stackId="waterfall"
            fill={hex.success}
            isAnimationActive={false}
            radius={[4, 4, 0, 0]}
          >
            {chartData.map((entry, index) => {
              let fillColor: string = hex.success; // default: income (green)
              if (entry.isBalance) {
                fillColor = hex.primary; // balance (blue)
              } else if (entry.isExpense) {
                fillColor = hex.danger; // expense (red)
              }
              return <Cell key={`cell-${index}`} fill={fillColor} />;
            })}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
