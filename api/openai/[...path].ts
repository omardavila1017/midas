import { createAtlasProxy } from '../_lib/atlasProxy';

export default createAtlasProxy({
  label: 'openai',
  upstreamEnvVar: 'OPENAI_UPSTREAM',
  defaultUpstream: 'https://api.openai.com/v1',
  tokenEnvVar: 'OPENAI_API_KEY',
});
