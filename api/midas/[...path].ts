import { createApiProxy } from '../_lib/apiProxy';

// Proxy same-origin para el backend de Usuarios/Seguridad (WS/midas). El browser
// llama `/api/midas/usuarios...` SIN token; aquí se inyecta el Bearer server-side
// (`MIDAS_TOKEN`, con fallback al `JDE_TOKEN` compartido de Senda) y se reenvía a
// `MIDAS_UPSTREAM/usuarios...`. Ni el token ni la contraseña quedan en el bundle
// del cliente. Mismo patrón que `api/jde` / `api/citi` / `api/tress`.
//
// Upstream QA por defecto: https://appqa.gruposenda.com/WS/midas. Producción
// pendiente de publicar → definir `MIDAS_UPSTREAM`.
export const config = {
  maxDuration: 60,
};

export default createApiProxy({
  label: 'midas',
  upstreamEnvVar: 'MIDAS_UPSTREAM',
  defaultUpstream: 'https://appqa.gruposenda.com/WS/midas',
  tokenEnvVar: 'MIDAS_TOKEN',
  fallbackTokenEnvVar: 'JDE_TOKEN',
});
