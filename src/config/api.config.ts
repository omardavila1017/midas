/**
 * Configuración de APIs para el frontend.
 *
 * AVISO DE SEGURIDAD:
 *   Todas las variables `VITE_*` quedan EMBEBIDAS en el bundle del cliente.
 *   No coloques credenciales reales aquí en producción — usa el proxy
 *   serverless (`api/jde/[...path].ts`) que lee `JDE_TOKEN` server-side.
 *   `VITE_JDE_TOKEN` y `VITE_COGNOS_TOKEN` solo deben tener valor en
 *   `.env.local` para desarrollo. En Vercel deja esas variables vacías.
 *
 * Default `baseUrl = /api/jde`:
 *   En producción la Vercel Function `api/jde/[...path].ts` resuelve la
 *   llamada e inyecta `JDE_TOKEN` server-side. En desarrollo el proxy de
 *   Vite (vite.config.ts) reescribe `/api/jde/*` hacia el upstream JDE.
 *   Por eso el default cubre ambos entornos sin pedir `VITE_JDE_BASE_URL`.
 *   Antes se usaba `?? ''` y, como `??` no atrapa string vacío, el fallback
 *   posterior `?? '/api/jde'` en `jdeClient.resolveBaseUrl` no llegaba a
 *   ejecutarse: las llamadas terminaban en el origen ('/empresas', '/bancos')
 *   y el rewrite SPA devolvía `index.html`, así que todo el cliente JDE se
 *   quedaba "cargando" sin datos en producción.
 */
const DEFAULT_JDE_BASE_URL = '/api/jde';
const DEFAULT_JDE_INDICADORES_BASE_URL = '/api/jde-indicadores';

export const apiConfig = {
  jde: {
    baseUrl: import.meta.env.VITE_JDE_BASE_URL || DEFAULT_JDE_BASE_URL,
    authValue: import.meta.env.VITE_JDE_TOKEN ?? '',
    environment: import.meta.env.VITE_JDE_ENVIRONMENT ?? 'DV920',
  },
  jdeIndicadores: {
    baseUrl: import.meta.env.VITE_JDE_INDICADORES_BASE_URL || DEFAULT_JDE_INDICADORES_BASE_URL,
  },
  cognos: {
    baseUrl: import.meta.env.VITE_COGNOS_BASE_URL ?? '',
    authValue: import.meta.env.VITE_COGNOS_TOKEN ?? '',
    namespace: import.meta.env.VITE_COGNOS_NAMESPACE ?? 'CognosEx',
  },
  atlas: {
    artifactId: import.meta.env.VITE_ATLAS_ARTIFACT_ID ?? 'midas',
  },
  gemini: {
    apiKey: import.meta.env.VITE_GEMINI_API_KEY ?? '',
    model: import.meta.env.VITE_GEMINI_MODEL ?? 'gemini-2.0-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },
} as const;

// Aviso visible en consola si el bundle de producción carga con un token VITE_
// configurado: significa que la credencial está expuesta a cualquier visitante.
if (
  typeof window !== 'undefined' &&
  import.meta.env.PROD &&
  (apiConfig.jde.authValue || apiConfig.cognos.authValue)
) {
  // eslint-disable-next-line no-console
  console.warn(
    '[security] VITE_JDE_TOKEN/VITE_COGNOS_TOKEN definidos en build de ' +
      'producción → la credencial es visible en el bundle público. Migra al ' +
      'proxy serverless (api/jde/[...path].ts) y vacía la VITE_ en Vercel.',
  );
}

export function validateApiConfig(): string[] {
  const missing: string[] = [];
  // JDE: en producción el token vive server-side (`JDE_TOKEN`) y lo inyecta
  // la Vercel Function. Solo flagueamos `VITE_JDE_TOKEN` faltante en dev,
  // donde el proxy de Vite no inyecta credencial.
  if (!apiConfig.jde.baseUrl) missing.push('VITE_JDE_BASE_URL');
  if (import.meta.env.DEV && !apiConfig.jde.authValue) {
    missing.push('VITE_JDE_TOKEN');
  }
  if (!apiConfig.cognos.baseUrl) missing.push('VITE_COGNOS_BASE_URL');
  if (import.meta.env.DEV && !apiConfig.cognos.authValue) {
    missing.push('VITE_COGNOS_TOKEN');
  }
  return missing;
}
