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
const DEFAULT_OPENAI_BASE_URL = '/api/openai';
const DEFAULT_CITI_BASE_URL = '/api/citi';
// Viajes Especiales: endpoint dev directo srv-desarrollo:95. Comparte la
// arquitectura ROL CITI (rango de fechas → registros de viaje con factura
// + UUID + Dias_Credito + K_Cliente). Endpoint productivo pendiente; cuando
// se publique, ajustar el default o configurarlo vía proxy igual que CITI.
const DEFAULT_VIAJES_ESPECIALES_BASE_URL = '/api/viajes-especiales';

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
  // CITI / Senda Citi — namespace para el ROL diario (viajes ejecutados).
  // Endpoint productivo: http://srv-desarrollo:92/CITI/RolDiario. En dev el
  // proxy de Vite (vite.config.ts) reescribe `/api/citi/*` hacia upstream
  // para evitar CORS. Comparte el token JDE — son el mismo backend Senda.
  citi: {
    baseUrl: import.meta.env.VITE_CITI_BASE_URL || DEFAULT_CITI_BASE_URL,
    authValue: '',
  },
  // Viajes Especiales — viajes ad-hoc con factura propia, fecha de factura
  // exacta y dias de credito por viaje (no por catalogo). El response trae
  // K_Cliente / D_Cliente / Clave_JDE / K_Empresa para auto-poblar el grupo
  // "Viajes Especiales" del catalogo de clientes y Factura_JDE + UUID para
  // cruzar contra cobranza JDE (mismo patron ROL ↔ cobranza).
  // Endpoint dev: http://srv-desarrollo:95/ViajesEspeciales/Servicios.
  viajesEspeciales: {
    baseUrl: import.meta.env.VITE_VIAJES_ESPECIALES_BASE_URL || DEFAULT_VIAJES_ESPECIALES_BASE_URL,
    authValue: '',
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
  if (!apiConfig.citi.baseUrl) missing.push('VITE_CITI_BASE_URL');
  if (!apiConfig.viajesEspeciales.baseUrl) missing.push('VITE_VIAJES_ESPECIALES_BASE_URL');
  return missing;
}
