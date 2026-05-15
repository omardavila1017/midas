/**
 * Configuración de APIs para el frontend.
 *
 * AVISO DE SEGURIDAD:
 *   Todas las variables `VITE_*` quedan embebidas en el bundle del cliente.
 *   Los tokens reales deben vivir server-side (`JDE_TOKEN`, `COGNOS_TOKEN`,
 *   `OPENAI_API_KEY`) y ser inyectados por el proxy Atlas/backend.
 *
 * Default `baseUrl = /api/jde`: el proxy de Vite (vite.config.ts) reescribe
 * `/api/jde/*` hacia el upstream JDE para evitar CORS en dev.
 */
const DEFAULT_JDE_BASE_URL = '/api/jde';
const DEFAULT_TRESS_BASE_URL = '/api/tress';
const DEFAULT_COGNOS_BASE_URL = '/api/cognos';
const DEFAULT_OPENAI_BASE_URL = '/api/openai';

export const apiConfig = {
  jde: {
    baseUrl: import.meta.env.VITE_JDE_BASE_URL || DEFAULT_JDE_BASE_URL,
    authValue: '',
    environment: import.meta.env.VITE_JDE_ENVIRONMENT ?? 'DV920',
  },
  // TRESS comparte el token JDE pero vive en un namespace upstream distinto
  // (/v1/erp/tress). El cliente lo consume con `jdeClient` pasando
  // `baseUrl: apiConfig.tress.baseUrl` — no hay clase aparte.
  tress: {
    baseUrl: import.meta.env.VITE_TRESS_BASE_URL || DEFAULT_TRESS_BASE_URL,
    authValue: '',
  },
  cognos: {
    baseUrl: import.meta.env.VITE_COGNOS_BASE_URL || DEFAULT_COGNOS_BASE_URL,
    authValue: '',
    namespace: import.meta.env.VITE_COGNOS_NAMESPACE ?? 'CognosEx',
  },
  atlas: {
    artifactId: import.meta.env.VITE_ATLAS_ARTIFACT_ID ?? 'midas',
  },
  openai: {
    model: import.meta.env.VITE_OPENAI_MODEL ?? 'gpt-4o-mini',
    baseUrl: import.meta.env.VITE_OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL,
  },
} as const;

export function validateApiConfig(): string[] {
  const missing: string[] = [];
  if (!apiConfig.jde.baseUrl) missing.push('VITE_JDE_BASE_URL');
  if (!apiConfig.tress.baseUrl) missing.push('VITE_TRESS_BASE_URL');
  if (!apiConfig.cognos.baseUrl) missing.push('VITE_COGNOS_BASE_URL');
  return missing;
}
