import React from 'react';
import {
  ComposedChart,
  Line,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Customized,
} from 'recharts';
import { fmtCompact, fmtCurrency, fmtYearMonthLong, fmtYearMonthShort } from '../formatters';

export interface DashboardChartDatum {
  yearMonth: string;
  phase?: 'past' | 'current' | 'future';
  realIncome?: number;
  projIncomeGap?: number;
  projIncomeTotal?: number;
  realExpense?: number;
  projExpenseGap?: number;
  projExpenseTotal?: number;
  gastoMinFloor?: number;
  realExpenseAboveFloor?: number;
  projExpenseGapAboveFloor?: number;
  cashBase?: number;
  projIncomeOverrun?: number | null;
  projExpenseOverrun?: number | null;
  floorReference?: number | null;
}

interface DashboardMonthlyChartProps {
  data: DashboardChartDatum[];
  onSelectMonth: (yearMonth: string) => void;
}

const CHART_COLORS = {
  income: '#16a34a',
  incomePattern: '#22c55e',
  incomeBg: '#dcfce7',
  expense: '#dc2626',
  expensePattern: '#ef4444',
  expenseBg: '#fee2e2',
  cash: '#1e293b',
} as const;

const TOOLTIP_LABELS: Record<string, string> = {
  realIncome: 'Ingresos (real)',
  projIncomeGap: 'Ingresos (proy.)',
  realExpense: 'Egresos (real)',
  projExpenseGap: 'Egresos (proy.)',
  gastoMinFloor: 'Piso operativo',
  realExpenseAboveFloor: 'Egresos (real)',
  projExpenseGapAboveFloor: 'Egresos (proy.)',
  cashBase: 'Caja Final',
};

interface TooltipPayloadItem {
  dataKey: string;
  value: number;
  payload: DashboardChartDatum;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const OverrunMarkers: React.FC<any> = (props) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { yAxisMap, formattedGraphicalItems } = props as any;
  const incomeBar = formattedGraphicalItems?.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gi: any) => gi?.item?.props?.dataKey === 'projIncomeGap',
  );
  const expenseBar = formattedGraphicalItems?.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gi: any) => gi?.item?.props?.dataKey === 'projExpenseGapAboveFloor',
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const yScale = (Object.values(yAxisMap ?? {})[0] as any)?.scale;
  if (!yScale) return null;

  const lines: React.ReactNode[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  incomeBar?.props?.data?.forEach((bar: any, idx: number) => {
    const v = bar?.payload?.projIncomeOverrun;
    if (v == null) return;
    const y = yScale(v);
    lines.push(
      <line key={`oi-${idx}`} x1={bar.x} x2={bar.x + bar.width} y1={y} y2={y} stroke={CHART_COLORS.incomePattern} strokeWidth={1.5} strokeDasharray="3 3" />,
    );
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expenseBar?.props?.data?.forEach((bar: any, idx: number) => {
    const overrun = bar?.payload?.projExpenseOverrun;
    if (overrun != null) {
      const y = yScale(overrun);
      lines.push(
        <line key={`oe-${idx}`} x1={bar.x} x2={bar.x + bar.width} y1={y} y2={y} stroke={CHART_COLORS.expensePattern} strokeWidth={1.5} strokeDasharray="3 3" />,
      );
    }

    const floorReference = bar?.payload?.floorReference;
    if (floorReference != null && floorReference > 0) {
      const y = yScale(floorReference);
      lines.push(
        <line key={`floorref-${idx}`} x1={bar.x} x2={bar.x + bar.width} y1={y} y2={y} stroke="#d97706" strokeWidth={2} strokeDasharray="4 2" />,
      );
    }
  });
  return <g>{lines}</g>;
};

const MonthTooltip: React.FC<{ active?: boolean; payload?: TooltipPayloadItem[]; label?: string }> = ({
  active,
  payload,
  label,
}) => {
  if (!active || !payload || payload.length === 0) return null;
  const ym = label ?? payload[0]?.payload?.yearMonth ?? '';
  const data = payload[0]?.payload;
  const phase = data?.phase;
  const phaseText =
    phase === 'past' ? 'Historico' :
    phase === 'current' ? 'En curso (real + proy.)' :
    phase === 'future' ? 'Proyectado' : '';
  return (
    <div className="rounded-[var(--radius-md)] border shadow-sm px-3 py-2 text-[12px]" style={{ background: 'var(--popover)', borderColor: 'var(--border)', color: 'var(--popover-foreground)' }}>
      <p className="font-bold mb-0.5" style={{ color: 'var(--gray-950)' }}>{fmtYearMonthLong(ym)}</p>
      {phaseText && <p className="text-[11px] mb-1.5" style={{ color: 'var(--gray-400)' }}>{phaseText}</p>}
      <ul className="space-y-0.5">
        {payload
          .filter((p) => p.value !== 0 && p.value !== null && p.value !== undefined)
          .map((p) => {
            let displayValue = p.value;
            if (p.dataKey === 'projIncomeGap' && data?.projIncomeTotal !== undefined) displayValue = data.projIncomeTotal;
            if (p.dataKey === 'projExpenseGap' && data?.projExpenseTotal !== undefined) displayValue = data.projExpenseTotal;
            if (p.dataKey === 'realExpenseAboveFloor' && data?.realExpense !== undefined) displayValue = data.realExpense;
            if (p.dataKey === 'projExpenseGapAboveFloor' && data?.projExpenseTotal !== undefined) displayValue = data.projExpenseTotal;
            return (
              <li key={p.dataKey} className="flex items-center justify-between gap-4">
                <span style={{ color: 'var(--gray-600)' }}>{TOOLTIP_LABELS[p.dataKey] ?? p.dataKey}</span>
                <span className="tabular-nums font-medium" style={{ color: 'var(--gray-950)' }}>
                  {fmtCurrency(displayValue)}
                </span>
              </li>
            );
          })}
      </ul>
      {data?.phase === 'past' && data?.projIncomeOverrun != null && (
        <p className="text-[10px] mt-1" style={{ color: CHART_COLORS.incomePattern }}>
          Ingreso real excedio proyectado por {fmtCurrency((data.realIncome ?? 0) - data.projIncomeOverrun)}
        </p>
      )}
      {data?.phase === 'past' && data?.projExpenseOverrun != null && (
        <p className="text-[10px]" style={{ color: CHART_COLORS.expensePattern }}>
          Egreso real excedio proyectado por {fmtCurrency((data.realExpense ?? 0) - data.projExpenseOverrun)}
        </p>
      )}
      <p className="text-[10px] mt-1.5" style={{ color: 'var(--gray-400)' }}>
        Clic para ver el detalle abajo
      </p>
    </div>
  );
};

export default function DashboardMonthlyChart({ data, onSelectMonth }: DashboardMonthlyChartProps) {
  const handleBarClick = (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return;
    const p = payload as { activeLabel?: string; activePayload?: { payload?: { yearMonth?: string } }[] };
    const ym = p.activeLabel ?? p.activePayload?.[0]?.payload?.yearMonth;
    if (ym) onSelectMonth(ym);
  };

  return (
    <div className="rounded-[var(--radius-lg)] border p-5" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <defs>
          <pattern id="hatchIncome" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
            <rect width="6" height="6" fill={CHART_COLORS.incomeBg} />
            <line x1="0" y1="0" x2="0" y2="6" stroke={CHART_COLORS.incomePattern} strokeWidth="2.5" />
          </pattern>
          <pattern id="hatchExpense" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
            <rect width="6" height="6" fill={CHART_COLORS.expenseBg} />
            <line x1="0" y1="0" x2="0" y2="6" stroke={CHART_COLORS.expensePattern} strokeWidth="2.5" />
          </pattern>
          <pattern id="hatchMinimum" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
            <rect width="8" height="8" fill="#fef3c7" />
            <line x1="0" y1="0" x2="0" y2="8" stroke="#d97706" strokeWidth="3" opacity="0.95" />
          </pattern>
        </defs>
      </svg>
      <h2 className="text-[15px] font-bold tracking-tight mb-1" style={{ color: 'var(--gray-950)' }}>
        Flujo mensual
      </h2>
      <div style={{ height: 340 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 10, right: 20, left: 10, bottom: 10 }} onClick={handleBarClick}>
            <CartesianGrid strokeDasharray="3 3" className="recharts-cartesian-grid" />
            <XAxis dataKey="yearMonth" tick={{ fontSize: 11 }} tickFormatter={fmtYearMonthShort} />
            <YAxis tickFormatter={(v) => fmtCompact(v)} tick={{ fontSize: 11 }} width={70} />
            <Tooltip content={<MonthTooltip />} cursor={{ fill: 'rgba(99, 102, 241, 0.06)' }} />
            <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
            <Bar dataKey="realIncome" stackId="income" fill={CHART_COLORS.income} name="Ingresos (real)" radius={[0, 0, 0, 0]} cursor="pointer" />
            <Bar dataKey="projIncomeGap" stackId="income" fill="url(#hatchIncome)" stroke={CHART_COLORS.incomePattern} strokeWidth={1} name="Ingresos (proy.)" radius={[4, 4, 0, 0]} cursor="pointer" />
            <Bar dataKey="gastoMinFloor" stackId="expense" fill="#f59e0b" stroke="#d97706" strokeWidth={1.5} name="Piso operativo" radius={[0, 0, 0, 0]} cursor="pointer" legendType="square">
              {data.map((row) => (
                <Cell key={`floor-${row.yearMonth}`} fill={row.phase === 'past' ? '#f59e0b' : 'url(#hatchMinimum)'} />
              ))}
            </Bar>
            <Bar dataKey="realExpenseAboveFloor" stackId="expense" fill={CHART_COLORS.expense} name="Egresos (real)" radius={[0, 0, 0, 0]} cursor="pointer" />
            <Bar dataKey="projExpenseGapAboveFloor" stackId="expense" fill="url(#hatchExpense)" stroke={CHART_COLORS.expensePattern} strokeWidth={1} name="Egresos (proy.)" radius={[4, 4, 0, 0]} cursor="pointer" />
            <Customized component={OverrunMarkers} />
            <Line type="monotone" dataKey="cashBase" stroke={CHART_COLORS.cash} strokeWidth={1.5} dot={{ r: 2 }} name="Caja Final" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
