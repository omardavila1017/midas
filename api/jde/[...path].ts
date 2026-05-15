import { createAtlasProxy } from '../_lib/atlasProxy';

export default createAtlasProxy({
  label: 'jde',
  upstreamEnvVar: 'JDE_UPSTREAM',
  defaultUpstream: 'https://api.gruposenda.com/JDEdwards',
  tokenEnvVar: 'JDE_TOKEN',
});
