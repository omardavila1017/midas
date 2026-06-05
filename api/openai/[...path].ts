import { createApiProxy } from '../_lib/apiProxy';

export default createApiProxy({
  label: 'openai',
  upstreamEnvVar: 'OPENAI_UPSTREAM',
  defaultUpstream: 'https://api.openai.com/v1',
  tokenEnvVar: 'OPENAI_API_KEY',
});
