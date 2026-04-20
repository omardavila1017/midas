'use client';

import React, { useMemo, useState } from 'react';
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import {
  TrendingUp,
  TrendingDown,
  DollarSign,
  Wallet,
  AlertTriangle,
  ChevronRight,
} from 'lucide-react';
import { FlowPlan, FlowConcept, Proposal, MONTHS } from '../types';
import { hex } from '../theme';
import { fmtCompact, fmtCurrency, fmtPct } from '../formatters';

interface DashboardProps {
  plan: FlowPlan;
  proposals: Proposal[];
}

interface DrillPathItem {
  label: string;
  conceptId: string | null;
  month: number | null;
}

const Dashboard: React.FC<DashboardProps> = ({ plan, proposals }) => {
  const [drillPath, setDrillPath] = useState<DrillPathItem[]>([]);


  const findConceptByName = (name: string): FlowConcept | undefined => {
    const search = (concepts: FlowConcept[]): FlowConcept | undefined => {
      for (const concept of concepts) {
        if (concept.name === name) return concept;
        if (concept.children) {
          const found = search(concept.children);
          if (found) return found;
        }
      }
      return undefined;
    };
    return search(plan.concepts);
  };

  const getRootConcepts = (): FlowConcept[] => {
    return plan.concepts.filter((c) => !c.parentId);
  };

  const getChildConcepts = (parentId: string): FlowConcept[] => {
    return plan.concepts.filter((c) => c.parentId === parentId);
  };

  const currentMonth = drillPath.length > 0 ? drillPath[drillPath.length - 1].month : null;
  const currentConceptId = drillPath.length > 0 ? drillPath[drillPath.length - 1].conceptId : null;

  const getDrillDownConcepts = (): FlowConcept[] => {
    if (currentConceptId) {
      return getChildConcepts(currentConceptId);
    }
    return getRootConcepts().filter(
      (c) => c.conceptType === 'ingreso' || c.conceptType === 'egreso'
    );
  };

  const cajaInicial = plan.cajaInicial;
  const cajaFinalConcept = findConceptByName('Caja Final');
  const variacionConcept = findConceptByName('Variación en Caja');
  const cajaFinalValues = cajaFinalConcept?.monthlyData || Array(12).fill(0);
  const variacionValues = variacionConcept?.monthlyData || Array(12).fill(0);
  const cajaMinimaValue = Math.min(...cajaFinalValues);
  const flujoNetoAnual = variacionValues.reduce((sum, val) => sum + val, 0);
  const cajaFinalAno = cajaFinalValues[11] || 0;

  const negativeCajaMonths = cajaFinalValues
    .map((val, idx) => (val < 0 ? { month: MONTHS[idx], value: val } : null))
    .filter((x) => x !== null) as { month: string; value: number }[];

  const ingresoConcept = findConceptByName('Ingresos') || plan.concepts.find((c) => c.excelRow === 7);
  const ingresoData = ingresoConcept?.monthlyData || Array(12).fill(0);
  const egresosData = ingresoData.map((ing, idx) => ing - variacionValues[idx]);

  const mainChartData = MONTHS.map((month, idx) => ({
    month,
    Ingresos: ingresoData[idx],
    Egresos: egresosData[idx],
    'Caja Final': cajaFinalValues[idx],
  }));

  const monthlySummaryRows = [
    { label: 'Ingresos', data: ingresoData, color: 'text-[var(--primary)]' },
    { label: 'Egresos', data: egresosData, color: 'text-[var(--gray-500)]' },
    {
      label: 'Variación',
      data: variacionValues,
      getColor: (val: number) => (val >= 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]'),
      showSign: true,
    },
    {
      label: 'Caja Final',
      data: cajaFinalValues,
      getColor: (val: number) => (val < 0 ? 'text-[var(--danger)]' : 'text-[var(--gray-950)]'),
      showSign: true,
    },
  ];

  const drillDownConcepts = getDrillDownConcepts();
  const drillDownData = drillDownConcepts
    .map((concept) => {
      const monthIdx = currentMonth !== null ? currentMonth : 0;
      const value = concept.monthlyData[monthIdx] || 0;
      return { ...concept, displayValue: value };
    })
    .filter((c) => c.displayValue !== 0)
    .sort((a, b) => Math.abs(b.displayValue) - Math.abs(a.displayValue));

  const drillDownTotal = drillDownData.reduce((sum, item) => sum + Math.abs(item.displayValue), 0);

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl p-3.5 shadow-lg shadow-black/5">
          <p className="text-[13px] font-semibold text-[var(--gray-950)] mb-1.5">{label}</p>
          {payload.map((entry: any, idx: number) => (
            <p key={idx} style={{ color: entry.color }} className="font-mono text-[12px] leading-5">
              {entry.name}: {fmtCurrency(entry.value)}
            </p>
          ))}
        </div>
      );
    }
    return null;
  };

  const handleMonthClick = (monthIdx: number) => {
    setDrillPath([{ label: `${MONTHS[monthIdx]}`, conceptId: null, month: monthIdx }]);
  };

  const handleConceptClick = (concept: FlowConcept, monthIdx: number) => {
    setDrillPath([...drillPath, { label: concept.name, conceptId: concept.id, month: monthIdx }]);
  };

  const handleBreadcrumbClick = (index: number) => {
    if (index === -1) {
      setDrillPath([]);
    } else {
      setDrillPath(drillPath.slice(0, index + 1));
    }
  };

  const getDrillDownBarColor = (concept: FlowConcept, value: number) => {
    if (concept.conceptType === 'ingreso') return hex.primary;
    if (Math.abs(value) > drillDownTotal / drillDownData.length) return hex.danger;
    return hex.gray400;
  };

  // KPI card data
  const kpis = [
    {
      label: 'Caja Inicial',
      value: fmtCurrency(cajaInicial),
      icon: Wallet,
      accentColor: hex.primary,
      textColor: 'text-[var(--gray-950)]',
    },
    {
      label: 'Caja Mínima',
      value: fmtCurrency(cajaMinimaValue),
      icon: TrendingDown,
      accentColor: cajaMinimaValue < 0 ? hex.danger : hex.warning,
      textColor: cajaMinimaValue < 0 ? 'text-[var(--danger)]' : 'text-[var(--gray-950)]',
    },
    {
      label: 'Flujo Neto Anual',
      value: fmtCurrency(flujoNetoAnual),
      icon: flujoNetoAnual >= 0 ? TrendingUp : TrendingDown,
      accentColor: flujoNetoAnual >= 0 ? hex.success : hex.danger,
      textColor: flujoNetoAnual >= 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]',
    },
    {
      label: 'Caja Final Año',
      value: fmtCurrency(cajaFinalAno),
      icon: DollarSign,
      accentColor: hex.primary,
      textColor: 'text-[var(--gray-950)]',
    },
  ];

  return (
    <div className="space-y-5">
      {/* Liquidity Alert Banner */}
      {negativeCajaMonths.length > 0 && (
        <div className="bg-[var(--danger-muted)] border border-red-100 rounded-2xl px-5 py-4 flex items-center gap-3">
          <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0" style={{ backgroundColor: hex.danger + '14' }}>
            <AlertTriangle className="w-4 h-4 text-[var(--danger)]" />
          </div>
          <p className="text-[13px] text-[var(--gray-950)]">
            <span className="font-semibold">Alerta de Liquidez</span> — Caja negativa en{' '}
            {negativeCajaMonths.map((m) => `${m.month} (${fmtCurrency(m.value)})`).join(', ')}
          </p>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-4 gap-4">
        {kpis.map((kpi, idx) => {
          const Icon = kpi.icon;
          return (
            <div
              key={idx}
              className={`bg-white rounded-2xl border border-[var(--gray-200)] p-5 shadow-sm hover:shadow-md transition-shadow animate-card-in hover-lift ${['stagger-1', 'stagger-2', 'stagger-3', 'stagger-4'][idx]}`}
            >
              <div className="flex items-start justify-between mb-3">
                <p className="text-[12px] font-medium text-[var(--gray-400)] uppercase tracking-wide">{kpi.label}</p>
                <div
                  className="w-8 h-8 rounded-xl flex items-center justify-center"
                  style={{ backgroundColor: kpi.accentColor + '12' }}
                >
                  <Icon className="w-4 h-4" style={{ color: kpi.accentColor }} />
                </div>
              </div>
              <p className={`text-[22px] font-bold font-mono tracking-tight ${kpi.textColor}`}>
                {kpi.value}
              </p>
            </div>
          );
        })}
      </div>

      {/* Main Chart */}
      <div className="bg-white rounded-2xl border border-[var(--gray-200)] p-6 shadow-sm animate-card-in hover-lift stagger-5">
        <div className="flex items-baseline justify-between mb-5">
          <h2 className="text-[16px] font-semibold text-[var(--gray-950)]">
            Flujo de Efectivo Mensual — {plan.year}
          </h2>
          <span className="text-[11px] font-medium" style={{ color: 'var(--gray-400)' }}>
            Haz clic en un mes para ver el desglose
          </span>
        </div>
        <ResponsiveContainer width="100%" height={380}>
          <ComposedChart
            data={mainChartData}
            margin={{ top: 10, right: 20, left: 10, bottom: 10 }}
          >
            <CartesianGrid stroke={hex.gray100} strokeDasharray="0" vertical={false} />
            <XAxis
              dataKey="month"
              tick={{ fill: hex.gray400, fontSize: 12 }}
              axisLine={{ stroke: hex.gray100 }}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: hex.gray400, fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(value) => `$${value}M`}
            />
            <Tooltip content={<CustomTooltip />} />
            <Legend
              wrapperStyle={{ paddingTop: '16px' }}
              iconType="circle"
              iconSize={8}
              formatter={(value: string) => (
                <span style={{ color: hex.gray500, fontSize: 12, fontWeight: 500 }}>{value}</span>
              )}
            />
            <ReferenceLine y={0} stroke={hex.danger} strokeDasharray="5 5" strokeWidth={1} strokeOpacity={0.5} />
            <Bar
              dataKey="Ingresos"
              fill={hex.primary}
              fillOpacity={0.85}
              radius={[4, 4, 0, 0]}
              cursor="pointer"
              onClick={(_data: any, index: number) => handleMonthClick(index)}
            />
            <Bar
              dataKey="Egresos"
              fill={hex.gray300}
              fillOpacity={0.7}
              radius={[4, 4, 0, 0]}
              cursor="pointer"
              onClick={(_data: any, index: number) => handleMonthClick(index)}
            />
            <Line
              type="monotone"
              dataKey="Caja Final"
              stroke={hex.warning}
              strokeWidth={2.5}
              dot={{ fill: hex.warning, r: 4, strokeWidth: 2, stroke: '#fff' }}
              activeDot={{ r: 6, stroke: hex.warning, strokeWidth: 2 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Drill-Down Section */}
      {drillPath.length > 0 && currentMonth !== null && (
        <div className="bg-white rounded-2xl border border-[var(--gray-200)] p-6 shadow-sm animate-card-in hover-lift stagger-6">
          {/* Breadcrumb */}
          <div className="flex items-center gap-1.5 mb-5 flex-wrap">
            <button
              onClick={() => handleBreadcrumbClick(-1)}
              className="text-[13px] font-medium text-[var(--primary)] hover:text-[var(--primary-hover)] transition"
            >
              Año {plan.year}
            </button>
            {drillPath.map((item, idx) => (
              <React.Fragment key={idx}>
                <ChevronRight className="w-3.5 h-3.5 text-[var(--gray-300)]" />
                <button
                  onClick={() => handleBreadcrumbClick(idx)}
                  className="text-[13px] font-medium text-[var(--primary)] hover:text-[var(--primary-hover)] transition"
                >
                  {item.label}
                </button>
              </React.Fragment>
            ))}
          </div>

          <h3 className="text-[12px] font-semibold text-[var(--gray-400)] mb-4 uppercase tracking-wider">
            Desglose por Concepto
          </h3>

          <div className="space-y-2.5">
            {drillDownData.map((concept) => {
              const percentage = drillDownTotal > 0 ? concept.displayValue / drillDownTotal : 0;
              const barColor = getDrillDownBarColor(concept, concept.displayValue);
              const isClickable = getChildConcepts(concept.id).length > 0;

              return (
                <div
                  key={concept.id}
                  onClick={() => isClickable && handleConceptClick(concept, currentMonth!)}
                  className={`group flex items-center gap-4 py-2 px-3 rounded-xl transition hover-row ${
                    isClickable ? 'cursor-pointer hover:bg-[var(--gray-50)]' : ''
                  }`}
                >
                  <div className="w-36 flex-shrink-0">
                    <p className="text-[13px] font-medium text-[var(--gray-950)] truncate">{concept.name}</p>
                    {concept.responsible && (
                      <p className="text-[11px] text-[var(--gray-400)]">{concept.responsible}</p>
                    )}
                  </div>
                  <div className="flex-1">
                    <div className="bg-[var(--gray-50)] rounded-full h-5 overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${Math.min(Math.abs(percentage) * 100, 100)}%`,
                          backgroundColor: barColor,
                          opacity: 0.75,
                        }}
                      />
                    </div>
                  </div>
                  <div className="text-right w-36 flex-shrink-0">
                    <p className="text-[13px] font-mono font-semibold text-[var(--gray-950)]">
                      {fmtCurrency(concept.displayValue)}
                    </p>
                    <p className="text-[11px] text-[var(--gray-400)]">{fmtPct(percentage)}</p>
                  </div>
                </div>
              );
            })}
          </div>

          {drillDownData.length === 0 && (
            <p className="text-[13px] text-[var(--gray-400)] py-8 text-center">No hay datos para este período</p>
          )}
        </div>
      )}

      {/* Monthly Summary Table */}
      <div className="bg-white rounded-2xl border border-[var(--gray-200)] p-6 shadow-sm animate-card-in hover-lift stagger-7">
        <div className="flex items-baseline justify-between mb-5">
          <h2 className="text-[16px] font-semibold text-[var(--gray-950)]">Resumen Mensual</h2>
          <span className="text-[11px] font-medium" style={{ color: 'var(--gray-400)' }}>
            Clic en mes para desglose
          </span>
        </div>
        <div className="overflow-x-auto -mx-2 px-2" style={{ scrollbarWidth: 'thin' }}>
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-[var(--gray-100)]">
                <th className="text-left py-3 px-3 text-[var(--gray-400)] font-semibold sticky left-0 bg-white z-10">Concepto</th>
                {MONTHS.map((month, idx) => (
                  <th
                    key={month}
                    className="text-right py-3 px-2 text-[var(--gray-400)] font-semibold cursor-pointer hover:text-[var(--primary)] transition whitespace-nowrap"
                    onClick={() => handleMonthClick(idx)}
                    title={`Ver desglose de ${month}`}
                  >
                    {month}
                  </th>
                ))}
                <th className="text-right py-3 px-3 text-[var(--gray-400)] font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              {monthlySummaryRows.map((row, rowIdx) => (
                <tr
                  key={rowIdx}
                  className="border-b border-[var(--gray-50)] hover:bg-[var(--surface-alt)] transition hover-row"
                >
                  <td className="py-3 px-3 font-medium text-[var(--gray-950)] sticky left-0 bg-white z-10">{row.label}</td>
                  {row.data.map((value, colIdx) => {
                    const signPrefix = (row as any).showSign && value !== 0
                      ? (value > 0 ? '+ ' : '- ')
                      : '';
                    const displayVal = (row as any).showSign && value < 0 ? Math.abs(value) : value;
                    return (
                      <td
                        key={colIdx}
                        className={`text-right py-3 px-2 font-mono whitespace-nowrap ${
                          row.getColor ? row.getColor(value) : row.color
                        }`}
                      >
                        {signPrefix}{fmtCurrency(displayVal)}
                      </td>
                    );
                  })}
                  <td
                    className={`text-right py-3 px-3 font-mono font-semibold ${
                      row.getColor
                        ? row.getColor(row.data.reduce((a, b) => a + b, 0))
                        : row.color
                    }`}
                  >
                    {fmtCurrency(row.data.reduce((a, b) => a + b, 0))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
