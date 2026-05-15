/**
 * Configuración de APIs para el frontend.
 *
 * AVISO: Todas las variables `VITE_*` quedan embebidas en el bundle del
 * cliente. Hoy la app corre solo en localhost; cuando se migre a un servidor
 * con proxy real, los Bearer tokens deben moverse a un namespace server-side.
 *
 * Default `baseUrl = /api/jde`: el proxy de Vite (vite.config.ts) reescribe
 * `/api/jde/*` hacia el upstream JDE para evitar CORS en dev.
 */
const DEFAULT_JDE_BASE_URL = '/api/jde';
const DEFAULT_TRESS_BASE_URL = '/api/tress';
const DEFAULT_CITI_BASE_URL = '/api/citi';

export const apiConfig = {
  jde: {
    baseUrl: import.meta.env.VITE_JDE_BASE_URL || DEFAULT_JDE_BASE_URL,
    authValue: import.meta.env.VITE_JDE_TOKEN ?? '',
    environment: import.meta.env.VITE_JDE_ENVIRONMENT ?? 'DV920',
  },
  // TRESS comparte el token JDE pero vive en un namespace upstream distinto
  // (/v1/erp/tress). El cliente lo consume con `jdeClient` pasando
  // `baseUrl: apiConfig.tress.baseUrl` — no hay clase aparte.
  tress: {
    baseUrl: import.meta.env.VITE_TRESS_BASE_URL || DEFAULT_TRESS_BASE_URL,
    authValue: import.meta.env.VITE_JDE_TOKEN ?? '',
  },
  // CITI / Senda Citi — namespace para el ROL diario (viajes ejecutados).
  // Endpoint productivo: http://srv-desarrollo:92/CITI/RolDiario. En dev el
  // proxy de Vite (vite.config.ts) reescribe `/api/citi/*` hacia upstream
  // para evitar CORS. Comparte el token JDE — son el mismo backend Senda.
  citi: {
    baseUrl: import.meta.env.VITE_CITI_BASE_URL || DEFAULT_CITI_BASE_URL,
    authValue: import.meta.env.VITE_CITI_TOKEN ?? import.meta.env.VITE_JDE_TOKEN ?? '',
  },
  cognos: {
    baseUrl: import.meta.env.VITE_COGNOS_BASE_URL ?? '',
    authValue: import.meta.env.VITE_COGNOS_TOKEN ?? '',
    namespace: import.meta.env.VITE_COGNOS_NAMESPACE ?? 'CognosEx',
  },
  atlas: {
    artifactId: import.meta.env.VITE_ATLAS_ARTIFACT_ID ?? 'midas',
  },
  openai: {
    apiKey: import.meta.env.VITE_OPENAI_API_KEY ?? '',
    model: import.meta.env.VITE_OPENAI_MODEL ?? 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
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
      'producción → la credencial es visible en el bundle público. Migrar a ' +
      'un proxy server-side antes de exponer públicamente.',
  );
}

export function validateApiConfig(): string[] {
  const missing: string[] = [];
  if (!apiConfig.jde.baseUrl) missing.push('VITE_JDE_BASE_URL');
  if (!apiConfig.tress.baseUrl) missing.push('VITE_TRESS_BASE_URL');
  if (import.meta.env.DEV && !apiConfig.jde.authValue) {
    missing.push('VITE_JDE_TOKEN');
  }
  if (!apiConfig.cognos.baseUrl) missing.push('VITE_COGNOS_BASE_URL');
  if (import.meta.env.DEV && !apiConfig.cognos.authValue) {
    missing.push('VITE_COGNOS_TOKEN');
  }
  return missing;
}
