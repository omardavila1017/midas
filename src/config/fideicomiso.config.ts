/**
 * Parámetros del módulo "Fideicomiso Dina".
 *
 * La obligación mensual a Transportes Logística Jalisco (DINA) por
 * arrendamiento estaba hardcodeada dentro del componente. Se externaliza aquí
 * como único punto de cambio para que Finanzas pueda confirmarla/ajustarla sin
 * tocar la UI. El valor por defecto se mantiene en $14.4M hasta confirmación.
 *
 * Override en tiempo de build vía `VITE_DINA_MONTHLY_OBLIGATION` /
 * `VITE_DINA_PAYMENT_DAY` si Finanzas necesita un valor distinto sin redeploy
 * de código.
 */

function num(envValue: string | undefined, fallback: number): number {
  if (envValue == null || envValue.trim() === '') return fallback;
  const n = Number(envValue);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Obligación mensual a DINA por arrendamiento (MXN). Default $14.4M. */
export const DINA_MONTHLY_OBLIGATION = num(
  import.meta.env.VITE_DINA_MONTHLY_OBLIGATION as string | undefined,
  14_400_000,
);

/** Día del mes en que el fideicomiso liquida a DINA. Default 15. */
export const DINA_PAYMENT_DAY = num(
  import.meta.env.VITE_DINA_PAYMENT_DAY as string | undefined,
  15,
);
