import { createAtlasProxy } from '../_lib/atlasProxy';

export const config = {
  maxDuration: 300,
};

export default createAtlasProxy({
  label: 'jde',
  upstreamEnvVar: 'JDE_UPSTREAM',
  defaultUpstream: 'https://api.gruposenda.com/JDEdwards',
  tokenEnvVar: 'JDE_TOKEN',
});
