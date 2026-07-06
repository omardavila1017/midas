import { createApiProxy } from '../_lib/apiProxy';

export const config = {
  maxDuration: 300,
};

export default createApiProxy({
  label: 'citi',
  upstreamEnvVar: 'CITI_UPSTREAM',
  defaultUpstream: 'https://appqa.gruposenda.com/WS/citi/CITI',
  tokenEnvVar: 'CITI_TOKEN',
  fallbackTokenEnvVar: 'JDE_TOKEN',
});
