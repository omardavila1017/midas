import { createApiProxy } from '../_lib/apiProxy';

export default createApiProxy({
  label: 'cognos',
  upstreamEnvVar: 'COGNOS_UPSTREAM',
  defaultUpstream: '',
  tokenEnvVar: 'COGNOS_TOKEN',
  extraHeaders: {
    'X-Cognos-Namespace': process.env.COGNOS_NAMESPACE ?? 'CognosEx',
  },
});
