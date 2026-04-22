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

  const formatCurrency = (value: number): string => {
    const sign = value < 0 ? '-' : '';
    return `${sign}$${Math.abs(value).toFixed(2)} M`;
  };

  const formatPercent = (value: number): string => {
    return `${(value * 100).toFixed(1)}%`;
  };

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
    { label: 'Ingresos', data: ingresoData, color: 'text-[#0071e3]' },
    { label: 'Egresos', data: egresosData, color: 'text-[#6e6e73]' },
    {
      label: 'Variación',
      data: variacionValues,
      getColor: (val: number) => (val >= 0 ? 'text-[#34c759]' : 'text-[#ff3b30]'),
    },
    {
      label: 'Caja Final',
      data: cajaFinalValues,
      getColor: (val: number) => (val < 0 ? 'text-[#ff3b30]' : 'text-[#1d1d1f]'),
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
        <div className="bg-white border border-[#d2d2d7]/60 rounded-xl p-3.5 shadow-lg shadow-black/5">
          <p className="text-[13px] font-semibold text-[#1d1d1f] mb-1.5">{label}</p>
          {payload.map((entry: any, idx: number) => (
            <p key={idx} style={{ color: entry.color }} className="font-mono text-[12px] leading-5">
              {entry.name}: {formatCurrency(entry.value)}
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
    if (concept.conceptType === 'ingreso') return '#0071e3';
    if (Math.abs(value) > drillDownTotal / drillDownData.length) return '#ff3b30';
    return '#86868b';
  };

  // KPI card data
  const kpis = [
    {
      label: 'Caja Inicial',
      value: formatCurrency(cajaInicial),
      icon: Wallet,
      accentColor: '#0071e3',
      textColor: 'text-[#1d1d1f]',
    },
    {
      label: 'Caja Mínima',
      value: formatCurrency(cajaMinimaValue),
      icon: TrendingDown,
      accentColor: cajaMinimaValue < 0 ? '#ff3b30' : '#ff9f0a',
      textColor: cajaMinimaValue < 0 ? 'text-[#ff3b30]' : 'text-[#1d1d1f]',
    },
    {
      label: 'Flujo Neto Anual',
      value: formatCurrency(flujoNetoAnual),
      icon: flujoNetoAnual >= 0 ? TrendingUp : TrendingDown,
      accentColor: flujoNetoAnual >= 0 ? '#34c759' : '#ff3b30',
      textColor: flujoNetoAnual >= 0 ? 'text-[#34c759]' : 'text-[#ff3b30]',
    },
    {
      label: 'Caja Final Año',
      value: formatCurrency(cajaFinalAno),
      icon: DollarSign,
      accentColor: '#0071e3',
      textColor: 'text-[#1d1d1f]',
    },
  ];

  return (
    <div className="space-y-5">
      {/* Liquidity Alert Banner */}
      {negativeCajaMonths.length > 0 && (
        <div className="bg-[#fff5f5] border border-red-100 rounded-2xl px-5 py-4 flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-[#ffe5e5] flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="w-4 h-4 text-[#ff3b30]" />
          </div>
          <p className="text-[13px] text-[#1d1d1f]">
            <span className="font-semibold">Alerta de Liquidez</span> — Caja negativa en{' '}
            {negativeCajaMonths.map((m) => `${m.month} (${formatCurrency(m.value)})`).join(', ')}
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
              className="bg-white rounded-2xl border border-[#d2d2d7]/40 p-5 shadow-sm hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between mb-3">
                <p className="text-[12px] font-medium text-[#86868b] uppercase tracking-wide">{kpi.label}</p>
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
      <div className="bg-white rounded-2xl border border-[#d2d2d7]/40 p-6 shadow-sm">
        <h2 className="text-[16px] font-semibold text-[#1d1d1f] mb-5">
          Flujo de Efectivo Mensual — {plan.year}
        </h2>
        <ResponsiveContainer width="100%" height={380}>
          <ComposedChart
            data={mainChartData}
            margin={{ top: 10, right: 20, left: 10, bottom: 10 }}
          >
            <CartesianGrid stroke="#e8e8ed" strokeDasharray="0" vertical={false} />
            <XAxis
              dataKey="month"
              tick={{ fill: '#86868b', fontSize: 12 }}
              axisLine={{ stroke: '#e8e8ed' }}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: '#86868b', fontSize: 12 }}
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
                <span style={{ color: '#6e6e73', fontSize: 12, fontWeight: 500 }}>{value}</span>
              )}
            />
            <ReferenceLine y={0} stroke="#ff3b30" strokeDasharray="5 5" strokeWidth={1} strokeOpacity={0.5} />
            <Bar
              dataKey="Ingresos"
              fill="#0071e3"
              fillOpacity={0.85}
              radius={[4, 4, 0, 0]}
              cursor="pointer"
              onClick={(_data: any, index: number) => handleMonthClick(index)}
            />
            <Bar
              dataKey="Egresos"
              fill="#c7c7cc"
              fillOpacity={0.7}
              radius={[4, 4, 0, 0]}
              cursor="pointer"
              onClick={(_data: any, index: number) => handleMonthClick(index)}
            />
            <Line
              type="monotone"
              dataKey="Caja Final"
              stroke="#ff9f0a"
              strokeWidth={2.5}
              dot={{ fill: '#ff9f0a', r: 4, strokeWidth: 2, stroke: '#fff' }}
              activeDot={{ r: 6, stroke: '#ff9f0a', strokeWidth: 2 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Drill-Down Section */}
      {drillPath.length > 0 && currentMonth !== null && (
        <div className="bg-white rounded-2xl border border-[#d2d2d7]/40 p-6 shadow-sm">
          {/* Breadcrumb */}
          <div className="flex items-center gap-1.5 mb-5 flex-wrap">
            <button
              onClick={() => handleBreadcrumbClick(-1)}
              className="text-[13px] font-medium text-[#0071e3] hover:text-[#0077ED] transition"
            >
              Año {plan.year}
            </button>
            {drillPath.map((item, idx) => (
              <React.Fragment key={idx}>
                <ChevronRight className="w-3.5 h-3.5 text-[#c7c7cc]" />
                <button
                  onClick={() => handleBreadcrumbClick(idx)}
                  className="text-[13px] font-medium text-[#0071e3] hover:text-[#0077ED] transition"
                >
                  {item.label}
                </button>
              </React.Fragment>
            ))}
          </div>

          <h3 className="text-[12px] font-semibold text-[#86868b] mb-4 uppercase tracking-wider">
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
                  className={`group flex items-center gap-4 py-2 px-3 rounded-xl transition ${
                    isClickable ? 'cursor-pointer hover:bg-[#f5f5f7]' : ''
                  }`}
                >
                  <div className="w-36 flex-shrink-0">
                    <p className="text-[13px] font-medium text-[#1d1d1f] truncate">{concept.name}</p>
                    {concept.responsible && (
                      <p className="text-[11px] text-[#86868b]">{concept.responsible}</p>
                    )}
                  </div>
                  <div className="flex-1">
                    <div className="bg-[#f5f5f7] rounded-full h-5 overflow-hidden">
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
                    <p className="text-[13px] font-mono font-semibold text-[#1d1d1f]">
                      {formatCurrency(concept.displayValue)}
                    </p>
                    <p className="text-[11px] text-[#86868b]">{formatPercent(percentage)}</p>
                  </div>
                </div>
              );
            })}
          </div>

          {drillDownData.length === 0 && (
            <p className="text-[13px] text-[#86868b] py-8 text-center">No hay datos para este período</p>
          )}
        </div>
      )}

      {/* Monthly Summary Table */}
      <div className="bg-white rounded-2xl border border-[#d2d2d7]/40 p-6 shadow-sm">
        <h2 className="text-[16px] font-semibold text-[#1d1d1f] mb-5">Resumen Mensual</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-[#e8e8ed]">
                <th className="text-left py-3 px-3 text-[#86868b] font-semibold">Concepto</th>
                {MONTHS.map((month, idx) => (
                  <th
                    key={month}
                    className="text-right py-3 px-2 text-[#86868b] font-semibold cursor-pointer hover:text-[#0071e3] transition"
                    onClick={() => handleMonthClick(idx)}
                  >
                    {month}
                  </th>
                ))}
                <th className="text-right py-3 px-3 text-[#86868b] font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              {monthlySummaryRows.map((row, rowIdx) => (
                <tr
                  key={rowIdx}
                  className="border-b border-[#f5f5f7] hover:bg-[#fbfbfd] transition"
                >
                  <td className="py-3 px-3 font-medium text-[#1d1d1f]">{row.label}</td>
                  {row.data.map((value, colIdx) => (
                    <td
                      key={colIdx}
                      className={`text-right py-3 px-2 font-mono ${
                        row.getColor ? row.getColor(value) : row.color
                      }`}
                    >
                      {formatCurrency(value)}
                    </td>
                  ))}
                  <td
                    className={`text-right py-3 px-3 font-mono font-semibold ${
                      row.getColor
                        ? row.getColor(row.data.reduce((a, b) => a + b, 0))
                        : row.color
                    }`}
                  >
                    {formatCurrency(row.data.reduce((a, b) => a + b, 0))}
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
