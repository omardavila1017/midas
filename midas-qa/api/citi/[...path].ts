import { createAtlasProxy } from '../_lib/atlasProxy';

export const config = {
  maxDuration: 300,
};

export default createAtlasProxy({
  label: 'citi',
  upstreamEnvVar: 'CITI_UPSTREAM',
  defaultUpstream: 'http://srv-desarrollo:92/CITI',
  tokenEnvVar: 'CITI_TOKEN',
  fallbackTokenEnvVar: 'JDE_TOKEN',
});
