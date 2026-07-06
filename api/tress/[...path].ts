import { createApiProxy } from '../_lib/apiProxy';

// Mismo maxDuration que jde/citi/store: /Nomina es el endpoint lento/pesado
// documentado (fan-out por empresa + reintentos); sin esto la función muere
// en el default de la plataforma (~10-15s) y los meses pesados 504ean.
export const config = {
  maxDuration: 300,
};

export default createApiProxy({
  label: 'tress',
  upstreamEnvVar: 'TRESS_UPSTREAM',
  defaultUpstream: 'https://appqa.gruposenda.com/WS/tress/TRESS',
  tokenEnvVar: 'JDE_TOKEN',
});
