import { createApiProxy } from '../_lib/apiProxy';

// Proxy same-origin de Viajes Especiales para el build DESPLEGADO (espejo de
// api/citi). Antes esta función no existía: `/api/viajes-especiales` sólo
// resolvía por el proxy de Vite en dev, así que en producción cada ventana
// diaria 404eaba y el fetch fallaba silencioso (falla suave) — Viajes
// Especiales simplemente no cargaba en prod. Mismos env vars que el proxy de
// dev en vite.config.ts.
export const config = {
  maxDuration: 300,
};

export default createApiProxy({
  label: 'viajes-especiales',
  upstreamEnvVar: 'VIAJES_ESPECIALES_UPSTREAM',
  defaultUpstream: 'https://appqa.gruposenda.com/WS/sentur/ViajesEspeciales',
  tokenEnvVar: 'VIAJES_ESPECIALES_TOKEN',
  fallbackTokenEnvVar: 'JDE_TOKEN',
});
