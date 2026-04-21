import { useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  showDot?: boolean;
  areaFill?: boolean;
  className?: string;
}

interface ChartDataPoint {
  value: number;
  index: number;
}

/**
 * Sparkline — A minimal inline chart for displaying small data series
 *
 * Displays a single-line chart with optional gradient fill and last-point indicator.
 * Handles edge cases: empty data, single point, and uniform values.
 *
 * @example
 * <Sparkline data={[10, 12, 11, 15, 14]} width={60} height={20} color="#0071e3" />
 */
const Sparkline = ({
  data,
  width = 60,
  height = 20,
  color = '#0071e3',
  showDot = false,
  areaFill = false,
  className = '',
}: SparklineProps) => {
  // Transform flat number array into recharts-compatible format
  const chartData: ChartDataPoint[] = useMemo(() => {
    return data.map((value, index) => ({
      value,
      index,
    }));
  }, [data]);

  // Generate unique ID for gradient definition
  const gradientId = useMemo(() => `sparkline-gradient-${Math.random().toString(36).slice(2, 9)}`, []);

  // Early return for empty data
  if (data.length === 0) {
    return (
      <div
        className={`flex items-center justify-center bg-gray-50 ${className}`}
        style={{ width, height }}
      >
        <span className="text-xs text-gray-400">—</span>
      </div>
    );
  }

  // Single data point: show as a minimal dot
  if (data.length === 1) {
    return (
      <div
        className={`flex items-center justify-center ${className}`}
        style={{ width, height }}
      >
        <div
          className="rounded-full"
          style={{
            width: '3px',
            height: '3px',
            backgroundColor: color,
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={className}
      style={{ width, height }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={chartData}
          margin={{ top: 2, right: 2, bottom: 2, left: 2 }}
        >
          <defs>
            {areaFill && (
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.1} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            )}
          </defs>

          {/* Invisible axes for proper scaling */}
          <XAxis dataKey="index" hide />
          <YAxis hide domain={['dataMin', 'dataMax']} />

          {/* Tooltip disabled per requirements */}
          <Tooltip content={<></>} />

          {/* Main line */}
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={1.5}
            dot={false}
            fill={areaFill ? `url(#${gradientId})` : 'none'}
            isAnimationActive={false}
          />

          {/* Optional last-point indicator */}
          {showDot && chartData.length > 0 && (
            <Line
              type="monotone"
              dataKey="value"
              stroke="none"
              strokeWidth={0}
              dot={{
                fill: color,
                r: 1.5,
              }}
              isAnimationActive={false}
              data={[chartData[chartData.length - 1]]}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default Sparkline;
