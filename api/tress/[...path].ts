import { createApiProxy } from '../_lib/apiProxy';

export default createApiProxy({
  label: 'tress',
  upstreamEnvVar: 'TRESS_UPSTREAM',
  defaultUpstream: 'https://api.gruposenda.com/v1/erp/tress',
  tokenEnvVar: 'JDE_TOKEN',
});
