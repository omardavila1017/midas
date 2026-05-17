import { createAtlasProxy } from '../_lib/atlasProxy';

export default createAtlasProxy({
  label: 'cognos',
  upstreamEnvVar: 'COGNOS_UPSTREAM',
  defaultUpstream: '',
  tokenEnvVar: 'COGNOS_TOKEN',
  extraHeaders: {
    'X-Cognos-Namespace': process.env.COGNOS_NAMESPACE ?? 'CognosEx',
  },
});
