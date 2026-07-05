/**
 * Midas — Unified formatting functions
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
  // Bare YYYY-MM-DD strings parse as UTC midnight per spec, so the local
  // getters below would render them a day early in America/Mexico_City
  // (UTC-6). Anchor them to local noon — same trick callers were applying
  // by hand with `${iso}T12:00:00`.
  const d = typeof date === 'string'
    ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00` : date)
    : date;
  // Defensive: malformed/empty date strings (legacy payloads, un-facturado
  // CITI/JDE fields) yield an Invalid Date — render '' instead of the
  // user-hostile "NaN undefined NaN". Mirrors the guards in
  // fmtYearMonthShort/fmtYearMonthLong below.
  if (Number.isNaN(d.getTime())) return '';
  const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

/** ISO date string: "2026-04-20" */
export function fmtISO(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * "Today" as YYYY-MM-DD in America/Mexico_City (the only locale this app
 * serves). Replaces `new Date().toISOString().slice(0, 10)` which returns
 * the UTC date — that crosses midnight 6h early for users in CST, so any
 * boundary check ("is this in the past?", asOfDate, daily cache keys)
 * drifts a day after 6pm local.
 */
const TODAY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Mexico_City',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
export function todayISO(): string {
  return TODAY_FORMATTER.format(new Date());
}

/** "YYYY-MM" → "Ago 26" (para ejes compactos de mes-año). */
export function fmtYearMonthShort(yearMonth: string): string {
  const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const [y, m] = yearMonth.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return yearMonth;
  return `${months[m - 1]} ${String(y).slice(-2)}`;
}

/** "YYYY-MM" → "Agosto 2026" (para títulos de detalle). */
export function fmtYearMonthLong(yearMonth: string): string {
  const months = [
    'Enero','Febrero','Marzo','Abril','Mayo','Junio',
    'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre',
  ];
  const [y, m] = yearMonth.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return yearMonth;
  return `${months[m - 1]} ${y}`;
}

/** Relative date: "Hoy", "Ayer", "Hace 3 días" */
export function fmtRelative(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const diff = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  // Future dates (diff < 0) would otherwise fall through to "Hace -3 días";
  // render the absolute date, mirroring the >30-day branch.
  if (diff < 0) return fmtDate(d);
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

/** Token color for positive/negative values. */
export function signHex(value: number): string {
  if (value > 0) return 'var(--success)';
  if (value < 0) return 'var(--danger)';
  return 'var(--gray-400)';
}
