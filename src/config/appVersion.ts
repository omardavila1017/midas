/**
 * Versión de la app mostrada en el login: `MAJOR.<#PR>` (se pinta `V1.259`). Se
 * inyecta en BUILD vía `define: { __APP_VERSION__ }` en `vite.config.ts`; la
 * lógica vive en `scripts/resolveVersion.mjs` y la fuente es `version.json`
 * (archivo COMMITEADO) — NO se deriva de git a propósito: el deploy se alimenta
 * con `rsync --exclude='.git'`, así que allá cualquier cálculo desde el
 * historial cae a un fallback constante y la versión queda clavada (fue el
 * defecto vivo hasta 2026-08-04). En entornos sin ese define (tests jsdom) cae a
 * `'dev'` sin tronar — `typeof` sobre un identificador no declarado es seguro
 * (devuelve `'undefined'`).
 *
 * NO uses esto para llavear salidas del motor: eso es `BUILD_ID` (`./buildId`).
 */
export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
