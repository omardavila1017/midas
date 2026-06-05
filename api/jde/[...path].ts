import { createApiProxy } from '../_lib/apiProxy';

export const config = {
  maxDuration: 300,
};

export default createApiProxy({
  label: 'jde',
  upstreamEnvVar: 'JDE_UPSTREAM',
  defaultUpstream: 'https://api.gruposenda.com/JDEdwards',
  tokenEnvVar: 'JDE_TOKEN',
});
