import { APP_VERSION } from './appVersion';
import { BUILD_ID } from './buildId';

/**
 * Expone `window.__midas__.build` = `{ appVersion, buildId }`.
 *
 * Existe por una razón operativa concreta: cuando un fix "no funciona", el
 * primer dato que hace falta es QUÉ código está corriendo el navegador. La
 * versión del login no lo dice (se congela en el deploy real, que recibe los
 * archivos por rsync sin `.git`), así que sin el `buildId` no se distingue
 * "el fix está mal" de "el fix no llegó" — la confusión de los PRs #239/#240.
 *
 * Idempotente y tolerante: sin `window` no hace nada.
 */
export function installBuildInfo(): void {
  try {
    if (typeof window === 'undefined') return;
    const w = window as unknown as { __midas__?: Record<string, unknown> };
    w.__midas__ = { ...(w.__midas__ ?? {}), build: { appVersion: APP_VERSION, buildId: BUILD_ID } };
  } catch {
    /* diagnóstico best-effort */
  }
}
