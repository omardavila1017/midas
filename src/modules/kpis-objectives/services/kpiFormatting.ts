import type { KpiUnit } from '../types';

const MXN = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
  maximumFractionDigits: 0,
});

const NUM = new Intl.NumberFormat('es-MX');

export function formatKpiValue(value: number | null, unit: KpiUnit): string {
  if (value === null) return '-';
  if (unit === 'MXN') return MXN.format(value);
  if (unit === 'pct') return `${(value * 100).toFixed(1)}%`;
  if (unit === 'days') return `${Math.round(value)} días`;
  if (unit === 'ratio') return `${value.toFixed(2)}x`;
  return NUM.format(value);
}

export function formatKpiDelta(value: number | null, unit: KpiUnit): string {
  if (value === null) return '-';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${formatKpiValue(value, unit)}`;
}
