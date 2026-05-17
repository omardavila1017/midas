import { createAtlasProxy } from '../_lib/atlasProxy';

export default createAtlasProxy({
  label: 'tress',
  upstreamEnvVar: 'TRESS_UPSTREAM',
  defaultUpstream: 'https://api.gruposenda.com/v1/erp/tress',
  tokenEnvVar: 'JDE_TOKEN',
});
