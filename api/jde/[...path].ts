import { createApiProxy } from '../_lib/apiProxy';

export const config = {
  maxDuration: 300,
};

export default createApiProxy({
  label: 'jde',
  upstreamEnvVar: 'JDE_UPSTREAM',
  defaultUpstream: 'https://appqa.gruposenda.com/WS/jde/JDEdwards',
  tokenEnvVar: 'JDE_TOKEN',
});
