/**
 * Configuración del modo ONLINE de Usuarios/Seguridad (backend `WS/midas`).
 *
 * Este módulo aísla el KILL-SWITCH y los parámetros de sesión del modo en línea
 * (contra `POST /api/midas/usuarios/validate`) para que TODO el resto del código
 * consulte una sola fuente:
 *
 *   - `isMidasUsersEnabled()` — ¿usamos la API real de usuarios? Default `true`
 *     (`VITE_MIDAS_USERS_ENABLED !== 'false'`). Con `false` la app revierte al
 *     modo local previo (`localAuth.ts` + `authLocalUsers.json`) SIN tocar nada
 *     más — el switch de reversa vive aquí.
 *   - `midasSessionTtlHours()` — duración del marcador de sesión local
 *     (`VITE_MIDAS_SESSION_TTL_HOURS`, default 12 h). El backend NO expone
 *     endpoint de sesión (solo `/validate`), así que la sesión se sostiene con
 *     el marcador `midas.auth.session.v2` + este TTL.
 *
 * ⚠️ NO es una frontera de seguridad: la autorización vinculante la hace el
 * backend (`[Authorize]` + reglas del API). Esto solo decide la fuente de la
 * identidad/permisos que la UI usa para MOSTRAR módulos.
 */

// Override SOLO para tests (permite ejercitar el modo online sin depender del
// env). `null` = usar el flag del entorno. Espejo de `__setLocalAuthEnabledForTests`.
let enabledOverride: boolean | null = null;

export function __setMidasUsersEnabledForTests(value: boolean | null): void {
  enabledOverride = value;
}

/**
 * ¿Está activo el modo ONLINE de usuarios (API `WS/midas/usuarios`)? Default
 * `true`. `VITE_MIDAS_USERS_ENABLED='false'` lo apaga y revierte al modo local.
 */
export function isMidasUsersEnabled(): boolean {
  if (enabledOverride !== null) return enabledOverride;
  return import.meta.env.VITE_MIDAS_USERS_ENABLED !== 'false';
}

/** Duración (horas) del marcador de sesión local. Default 12 h. */
export function midasSessionTtlHours(): number {
  const raw = import.meta.env.VITE_MIDAS_SESSION_TTL_HOURS;
  const parsed = raw ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 12;
}
