/**
 * Versión de la app mostrada en el login. Se inyecta en BUILD desde git
 * (`MAJOR.MINOR.<#PRs>`) vía `define: { __APP_VERSION__ }` en `vite.config.ts`
 * (lógica en `scripts/resolveVersion.mjs`). En entornos sin ese define (tests
 * jsdom) cae a `'dev'` sin tronar — `typeof` sobre un identificador no declarado
 * es seguro (devuelve `'undefined'`).
 */
export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
