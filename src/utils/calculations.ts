export function formatCurrency(value: number): string {
  const sign = value < 0 ? '-' : '';
  const absValue = Math.abs(value);
  return `${sign}$${absValue.toFixed(2)} M`;
}

export function formatCompactNumber(value: number): string {
  return value.toLocaleString('es-MX', { maximumFractionDigits: 0 });
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}
