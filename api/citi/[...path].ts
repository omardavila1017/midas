import { createApiProxy } from '../_lib/apiProxy';

export const config = {
  maxDuration: 300,
};

export default createApiProxy({
  label: 'citi',
  upstreamEnvVar: 'CITI_UPSTREAM',
  defaultUpstream: 'http://srv-desarrollo:92/CITI',
  tokenEnvVar: 'CITI_TOKEN',
  fallbackTokenEnvVar: 'JDE_TOKEN',
});
