/**
 * Configuración de APIs para el frontend.
 *
 * AVISO DE SEGURIDAD:
 *   Todas las variables `VITE_*` quedan EMBEBIDAS en el bundle del cliente.
 *   No coloques credenciales reales aquí en producción — usa el proxy
 *   serverless (`api/jde/[...path].ts`) que lee `JDE_TOKEN` server-side.
 *   `VITE_JDE_TOKEN` y `VITE_COGNOS_TOKEN` solo deben tener valor en
 *   `.env.local` para desarrollo. En Vercel deja esas variables vacías.
 */
export const apiConfig = {
  jde: {
    baseUrl: import.meta.env.VITE_JDE_BASE_URL ?? '',
    authValue: import.meta.env.VITE_JDE_TOKEN ?? '',
    environment: import.meta.env.VITE_JDE_ENVIRONMENT ?? 'DV920',
  },
  cognos: {
    baseUrl: import.meta.env.VITE_COGNOS_BASE_URL ?? '',
    authValue: import.meta.env.VITE_COGNOS_TOKEN ?? '',
    namespace: import.meta.env.VITE_COGNOS_NAMESPACE ?? 'CognosEx',
  },
  atlas: {
    artifactId: import.meta.env.VITE_ATLAS_ARTIFACT_ID ?? 'midas',
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
  if (!apiConfig.jde.baseUrl) missing.push('VITE_JDE_BASE_URL');
  if (!apiConfig.jde.authValue) missing.push('VITE_JDE_TOKEN');
  if (!apiConfig.cognos.baseUrl) missing.push('VITE_COGNOS_BASE_URL');
  if (!apiConfig.cognos.authValue) missing.push('VITE_COGNOS_TOKEN');
  return missing;
}
