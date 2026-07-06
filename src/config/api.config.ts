/**
 * Configuración de APIs para el frontend.
 *
 * AVISO DE SEGURIDAD:
 *   Todas las variables `VITE_*` quedan embebidas en el bundle del cliente.
 *   Los tokens reales deben vivir server-side (`JDE_TOKEN`, `COGNOS_TOKEN`,
 *   `OPENAI_API_KEY`) y ser inyectados por el proxy/backend.
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
// Autenticación real (`/api/auth/*`): sesión + login + cambio/reset de
// contraseña. La base es configurable por entorno (`VITE_AUTH_BASE_URL`) porque
// el backend de auth NO necesariamente vive bajo `/api` (puede ser un SSO u
// otro host). Default `/api/auth` para dev con proxy/backend local.
const DEFAULT_AUTH_BASE_URL = '/api/auth';
// Shared server-side store (Omar Dávila's deployment). The browser calls
// `/api/store/*`; the same-origin proxy (api/store/[...path].ts) injects the
// token and forwards to STORE_UPSTREAM. `enabled` is an explicit kill switch:
// OFF by default → Midas behaves exactly as today (pure localStorage + IDB).
// Omar's deployment sets VITE_STORE_ENABLED=true to turn the shared store on.
const DEFAULT_STORE_BASE_URL = '/api/store';

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
  // Upstream QA: https://appqa.gruposenda.com/WS/citi/CITI/RolDiario. En dev el
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
  // Upstream QA: https://appqa.gruposenda.com/WS/sentur/ViajesEspeciales/Servicios.
  viajesEspeciales: {
    baseUrl: import.meta.env.VITE_VIAJES_ESPECIALES_BASE_URL || DEFAULT_VIAJES_ESPECIALES_BASE_URL,
    authValue: '',
  },
  // Autenticación: la base se resuelve desde `VITE_AUTH_BASE_URL` (igual que el
  // resto de servicios). El trailing slash se normaliza en `authApi.ts` para no
  // generar `//` al concatenar los paths (`/login`, `/session`, …).
  auth: {
    baseUrl: import.meta.env.VITE_AUTH_BASE_URL || DEFAULT_AUTH_BASE_URL,
  },
  openai: {
    model: import.meta.env.VITE_OPENAI_MODEL ?? 'gpt-4o-mini',
    baseUrl: import.meta.env.VITE_OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL,
  },
  store: {
    baseUrl: import.meta.env.VITE_STORE_BASE_URL || DEFAULT_STORE_BASE_URL,
    enabled: import.meta.env.VITE_STORE_ENABLED === 'true',
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
