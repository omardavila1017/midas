import { createApiProxy } from '../_lib/apiProxy';

// Shared server-side store (Omar Dávila's deployment owns the data backend).
// Same codebase, his env: he configures STORE_UPSTREAM (+ STORE_TOKEN, or it
// falls back to the shared Senda JDE_TOKEN) and the browser reaches it via the
// same-origin /api/store/* route. When STORE_UPSTREAM is unset the proxy
// returns 500 "store proxy not configured" — that is the intended OFF state;
// the client (remoteStore.ts) is best-effort and falls back to localStorage/IDB.
export const config = {
  maxDuration: 300,
};

export default createApiProxy({
  label: 'store',
  upstreamEnvVar: 'STORE_UPSTREAM',
  defaultUpstream: '',
  tokenEnvVar: 'STORE_TOKEN',
  fallbackTokenEnvVar: 'JDE_TOKEN',
});
