/**
 * Midas Design System - Single source of truth
 *
 * Follows the Impeccable framework:
 * - OKLCH color space for perceptually uniform palette
 * - 4pt spacing grid
 * - Modular type scale (1.25 ratio)
 * - Semantic variables for every visual decision
 */

/* Color Palette (OKLCH) — slate-blue corporate accent at hue 248. */
export const color = {
  // Primary — slate-blue accent, perceptually balanced for finance UIs.
  primary:       'oklch(52% 0.13 248)',
  primaryHover:  'oklch(58% 0.14 248)',
  primaryMuted:  'oklch(95% 0.03 248)',
  primarySubtle: 'oklch(97% 0.015 248)',

  // Neutrals — chroma 0.008-0.018 tinted toward slate-blue 248.
  gray950: 'oklch(20% 0.018 248)',
  gray900: 'oklch(26% 0.020 248)',
  gray700: 'oklch(38% 0.018 248)',
  gray500: 'oklch(52% 0.016 248)',
  gray400: 'oklch(60% 0.014 248)',
  gray300: 'oklch(72% 0.012 248)',
  gray200: 'oklch(89% 0.010 248)',
  gray100: 'oklch(95% 0.008 248)',
  gray50:  'oklch(98% 0.006 248)',

  // Semantic — status colors hold their natural hue.
  success:       'oklch(58% 0.14 152)',
  successMuted:  'oklch(95% 0.04 152)',
  warning:       'oklch(66% 0.16 65)',
  warningMuted:  'oklch(95% 0.06 75)',
  danger:        'oklch(58% 0.20 25)',
  dangerMuted:   'oklch(95% 0.05 25)',
  info:          'oklch(56% 0.10 248)',
  infoMuted:     'oklch(95% 0.02 248)',

  // Surfaces
  surface:     'var(--card)',
  surfaceAlt:  'oklch(98% 0.006 248)',
  surfaceRaised: 'var(--card)',

  // Chart palette — slate-blue lead with status accents spaced for
  // categorical reads. Greens/ambers/reds carry semantic weight so
  // they appear later in the sequence.
  chart: [
    'oklch(52% 0.13 248)',  // slate-blue (primary)
    'oklch(36% 0.10 248)',  // deep slate-blue
    'oklch(72% 0.08 248)',  // pale slate-blue
    'oklch(58% 0.14 152)',  // success green
    'oklch(66% 0.16 65)',   // warning amber
    'oklch(58% 0.20 25)',   // danger red
    'oklch(58% 0.18 300)',  // purple
    'oklch(48% 0.16 320)',  // plum
  ] as const,

  // Aging buckets — escalation through slate-blue → amber → red.
  aging: [
    'oklch(58% 0.14 152)',  // current (green)
    'oklch(52% 0.13 248)',  // 1-30 (slate-blue)
    'oklch(64% 0.12 248)',  // 31-60 (lighter slate-blue)
    'oklch(72% 0.16 65)',   // 61-90 (amber)
    'oklch(66% 0.18 50)',   // 91-120 (orange)
    'oklch(58% 0.20 25)',   // 121+ (red)
    'oklch(48% 0.18 25)',   // 180+ (deep red)
    'oklch(38% 0.14 25)',   // 360+ (oxblood)
  ] as const,
} as const;

/* CSS variable colors for Tailwind classes and Recharts */
export const hex = {
  primary:      'var(--primary)',
  primaryHover: 'var(--accent)',
  primaryMuted: 'var(--primary-muted)',
  gray950:      'var(--card-foreground)',
  gray700:      'var(--gray-700)',
  gray500:      'var(--gray-500)',
  gray400:      'var(--gray-400)',
  gray300:      'var(--gray-300)',
  gray200:      'var(--gray-200)',
  gray100:      'var(--gray-100)',
  gray50:       'var(--gray-50)',
  success:      'var(--success)',
  warning:      'var(--warning)',
  danger:       'var(--danger)',
  info:         'var(--info)',
} as const;

/* ─── Spacing (4pt grid) ─── */
export const space = {
  0:  '0px',
  1:  '4px',
  2:  '8px',
  3:  '12px',
  4:  '16px',
  5:  '20px',
  6:  '24px',
  8:  '32px',
  10: '40px',
  12: '48px',
  16: '64px',
  20: '80px',
  24: '96px',
} as const;

/* ─── Type Scale (1.25 ratio, base 16px) ─── */
export const type = {
  xs:    { size: '0.75rem',   lh: '1rem' },      // 12px / 16px
  sm:    { size: '0.8125rem', lh: '1.125rem' },   // 13px / 18px
  base:  { size: '0.875rem',  lh: '1.25rem' },    // 14px / 20px
  md:    { size: '0.9375rem', lh: '1.375rem' },   // 15px / 22px
  lg:    { size: '1.125rem',  lh: '1.5rem' },     // 18px / 24px
  xl:    { size: '1.375rem',  lh: '1.75rem' },    // 22px / 28px
  '2xl': { size: '1.75rem',   lh: '2.25rem' },    // 28px / 36px
  '3xl': { size: '2.25rem',   lh: '2.75rem' },    // 36px / 44px
} as const;

/* ─── Shadows (elevation scale) ─── */
export const shadow = {
  xs:  '0 1px 2px rgba(0,0,0,0.04)',
  sm:  '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
  md:  '0 4px 12px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)',
  lg:  '0 8px 25px -5px rgba(0,0,0,0.08), 0 4px 10px -6px rgba(0,0,0,0.04)',
  xl:  '0 20px 40px -8px rgba(0,0,0,0.12), 0 8px 16px -8px rgba(0,0,0,0.06)',
  // Colored shadows
  primarySm: '0 2px 8px rgba(0,113,227,0.15)',
  primaryMd: '0 4px 14px rgba(0,113,227,0.18)',
  successSm: '0 2px 8px rgba(52,199,89,0.15)',
  dangerSm:  '0 2px 8px rgba(255,59,48,0.15)',
} as const;

/* ─── Radii ─── */
export const radius = {
  sm:   '8px',
  md:   '12px',
  lg:   '16px',
  xl:   '20px',
  '2xl':'24px',
  full: '9999px',
} as const;

/* ─── Motion ─── */
export const motion = {
  spring:    'cubic-bezier(0.22, 1, 0.36, 1)',
  easeOut:   'cubic-bezier(0.16, 1, 0.3, 1)',
  smooth:    'cubic-bezier(0.25, 0.1, 0.25, 1)',
  fast:      '150ms',
  normal:    '250ms',
  slow:      '400ms',
  entrance:  '500ms',
} as const;

/* ─── Z-index scale ─── */
export const z = {
  dropdown:      100,
  sticky:        200,
  modalBackdrop: 300,
  modal:         400,
  toast:         500,
  tooltip:       600,
} as const;

/* ─── Breakpoints ─── */
export const bp = {
  sm:  640,
  md:  768,
  lg:  1024,
  xl:  1280,
  '2xl': 1400,
} as const;

/* ─── Layout constants ─── */
export const layout = {
  maxWidth:   '1400px',
  headerH:    '56px',
  sidebarW:   '280px',
  pageGutter: '32px',   // px-8
} as const;

/* ─── Bucket / Aging labels ─── */
export const AGING_LABELS = [
  'Por Vencer', '1-30', '31-60', '61-90', '91-120', '121-180', '181-360', '360+',
] as const;

export const AGING_KEYS = [
  'Por_Vencer', 'V_1_30', 'V_31_60', 'V_61_90', 'V_91_120', 'V_121_180', 'V_181_360', 'V_Mayor_360',
] as const;

/* ─── Month helpers ─── */
export const MONTH_NAMES_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
] as const;

export const MONTH_SHORT_ES = [
  'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
  'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic',
] as const;

export const DOW_SHORT_ES = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'] as const;

/* ─── Page size ─── */
export const PAGE_SIZE = 50;
