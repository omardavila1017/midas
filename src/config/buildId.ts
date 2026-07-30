/**
 * Huella del código que produjo este bundle. Se inyecta en BUILD vía
 * `define: { __BUILD_ID__ }` en `vite.config.ts` (lógica en
 * `scripts/resolveBuildId.mjs`, que hashea `src/**` + los configs). En
 * entornos sin ese define (tests jsdom) cae a `'dev'` sin tronar.
 *
 * Regla del módulo: esto NO es la versión que ve el usuario (esa es
 * `APP_VERSION`, en `appVersion.ts`). Es la identidad del MOTOR, y sirve para
 * una sola cosa: invalidar todo lo que sea SALIDA del motor persistida en el
 * cliente (hoy, el cache de proyección en IndexedDB). No lo uses para copy de
 * UI ni lo mezcles con la versión de release — la de release puede quedarse
 * congelada en el deploy real y ésta no.
 */
export const BUILD_ID: string =
  typeof __BUILD_ID__ === 'string' && __BUILD_ID__ ? __BUILD_ID__ : 'dev';
