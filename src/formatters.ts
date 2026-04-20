/**
 * FlowSense — Unified formatting functions
 *
 * SINGLE SOURCE OF TRUTH for currency, number, and date display.
 * Every component imports from here — never define local formatters.
 */

const MXN = new Intl.NumberFormat('es-MX', {
  style: 'currency', currency: 'MXN',
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

const MXN_COMPACT = new Intl.NumberFormat('es-MX', {
  style: 'currency', currency: 'MXN',
  notation: 'compact', compactDisplay: 'short',
  minimumFractionDigits: 1, maximumFractionDigits: 1,
});

const NUM = new Intl.NumberFormat('es-MX', {
  minimumFractionDigits: 0, maximumFractionDigits: 0,
});

const NUM2 = new Intl.NumberFormat('es-MX', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

const PCT = new Intl.NumberFormat('es-MX', {
  style: 'percent',
  minimumFractionDigits: 1, maximumFractionDigits: 1,
});

/* ─── Currency ─── */

/** Full currency: $1,234,567.89 */
export function fmtCurrency(value: number): string {
  return MXN.format(value);
}

/** Compact currency: $1.2M, $345K */
export function fmtCompact(value: number): string {
  return MXN_COMPACT.format(value);
}

/** Smart currency: compact for |value| >= 100K, full otherwise */
export function fmtSmart(value: number): string {
  return Math.abs(value) >= 100_000 ? fmtCompact(value) : fmtCurrency(value);
}

/** Currency for KPI display: $1.2M with sign */
export function fmtKpi(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const m = value / 1_000_000;
    return `$${m >= 0 ? '' : '-'}${Math.abs(m).toFixed(1)}M`;
  }
  if (abs >= 1_000) {
    const k = value / 1_000;
    return `$${k >= 0 ? '' : '-'}${Math.abs(k).toFixed(0)}K`;
  }
  return fmtCurrency(value);
}

/* ─── Numbers ─── */

/** Integer with grouping: 1,234,567 */
export function fmtInt(value: number): string {
  return NUM.format(value);
}

/** Two decimals with grouping: 1,234.56 */
export function fmtNum(value: number): string {
  return NUM2.format(value);
}

/* ─── Percentages ─── */

/** Percent from decimal: 0.85 → "85.0%" */
export function fmtPct(value: number): string {
  return PCT.format(value);
}

/** Percent from integer: 85 → "85.0%" */
export function fmtPctInt(value: number): string {
  return PCT.format(value / 100);
}

/** Delta percent with sign: +12.5% / -3.2% */
export function fmtDelta(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(1)}%`;
}

/* ─── Dates ─── */

/** Short date: "20 Abr 2026" */
export function fmtDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

/** ISO date string: "2026-04-20" */
export function fmtISO(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Relative date: "Hoy", "Ayer", "Hace 3 días" */
export function fmtRelative(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const now = new Date();
  const diff = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Ayer';
  if (diff < 7) return `Hace ${diff} días`;
  if (diff < 30) return `Hace ${Math.floor(diff / 7)} sem`;
  return fmtDate(d);
}

/* ─── Utility ─── */

/** Positive/negative sign class */
export function signClass(value: number): 'positive' | 'negative' | 'neutral' {
  if (value > 0) return 'positive';
  if (value < 0) return 'negative';
  return 'neutral';
}

/** Color for positive/negative values */
export function signColor(value: number): string {
  if (value > 0) return 'oklch(62% 0.19 145)';   // success green
  if (value < 0) return 'oklch(58% 0.22 25)';     // danger red
  return 'oklch(56% 0.008 255)';                    // neutral gray
}

/** Hex color for positive/negative (Tailwind/Recharts compatible) */
export function signHex(value: number): string {
  if (value > 0) return '#34c759';
  if (value < 0) return '#ff3b30';
  return '#86868b';
}
