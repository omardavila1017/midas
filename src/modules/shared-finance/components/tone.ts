/**
 * Canonical tone helpers — single source of truth for color semantics across
 * Dashboard / Proyección / Planeación / Impuestos.
 *
 * Why this exists:
 *   Each dashboard used to inline its own `tone()` ternary (some used
 *   `value < minimum`, others `value > 0`, Tax inlined per-card). Result:
 *   "Sin programar" had no tone, "Caja final" used a different threshold
 *   than "Crédito requerido". Now every KPI delta picks from this file.
 *
 * Token names match Senda DS variables in index.css. We return CSS variable
 * strings so the caller doesn't need to import tokens. Switching the DS to
 * OKLCH (see :root --tone-* tokens) updates every consumer automatically.
 */

export type ToneColor = string;

/** Default safe / informational neutral. */
export const TONE_NEUTRAL: ToneColor = 'var(--gray-950)';
export const TONE_MUTED: ToneColor = 'var(--gray-500)';
export const TONE_SUCCESS: ToneColor = 'var(--tone-success, var(--success))';
export const TONE_WARNING: ToneColor = 'var(--tone-warning, var(--warning))';
export const TONE_DANGER: ToneColor = 'var(--tone-danger, var(--danger))';

/**
 * Tone a cash value against a minimum floor.
 *   below floor       → danger
 *   within 20% buffer → warning
 *   safely above      → neutral
 */
export function toneByFloor(value: number, minimum: number): ToneColor {
  if (!Number.isFinite(value) || !Number.isFinite(minimum)) return TONE_NEUTRAL;
  if (value < minimum) return TONE_DANGER;
  if (value < minimum * 1.2) return TONE_WARNING;
  return TONE_NEUTRAL;
}

/**
 * Tone a delta where "higher is better" (cash, margin, runway).
 *   positive → success
 *   zero     → neutral
 *   negative → danger
 */
export function toneByDelta(delta: number): ToneColor {
  if (!Number.isFinite(delta) || delta === 0) return TONE_NEUTRAL;
  return delta > 0 ? TONE_SUCCESS : TONE_DANGER;
}

/**
 * Tone an outstanding amount where "higher is worse" (debt, unscheduled).
 *   zero     → success (good)
 *   any      → danger
 *   With optional warning threshold below which it's warning not danger.
 */
export function toneByOutstanding(amount: number, dangerAbove = 0): ToneColor {
  if (!Number.isFinite(amount) || amount <= dangerAbove) return TONE_SUCCESS;
  return TONE_DANGER;
}

/**
 * Tone a count where any non-zero is bad (deficit days, breaches).
 */
export function toneByCount(count: number): ToneColor {
  if (!Number.isFinite(count) || count <= 0) return TONE_SUCCESS;
  return TONE_DANGER;
}

/**
 * Tone a credit requirement — zero is good, any > 0 is a warning (not yet
 * danger because the company has lines available).
 */
export function toneByRequirement(amount: number): ToneColor {
  if (!Number.isFinite(amount) || amount <= 0) return TONE_NEUTRAL;
  return TONE_WARNING;
}
