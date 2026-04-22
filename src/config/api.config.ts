export const apiConfig = {
  jde: {
    baseUrl: import.meta.env.VITE_JDE_BASE_URL ?? '',
    authValue: import.meta.env.VITE_JDE_TOKEN ?? '',
    environment: import.meta.env.VITE_JDE_ENVIRONMENT ?? 'DV920',
  },
  cognos: {
    baseUrl: import.meta.env.VITE_COGNOS_BASE_URL ?? '',
    authValue: import.meta.env.VITE_COGNOS_TOKEN ?? '',
    namespace: import.meta.env.VITE_COGNOS_NAMESPACE ?? 'CognosEx',
  },
  atlas: {
    artifactId: import.meta.env.VITE_ATLAS_ARTIFACT_ID ?? 'midas',
  },
} as const;

export function validateApiConfig(): string[] {
  const missing: string[] = [];
  if (!apiConfig.jde.baseUrl) missing.push('VITE_JDE_BASE_URL');
  if (!apiConfig.jde.authValue) missing.push('VITE_JDE_TOKEN');
  if (!apiConfig.cognos.baseUrl) missing.push('VITE_COGNOS_BASE_URL');
  if (!apiConfig.cognos.authValue) missing.push('VITE_COGNOS_TOKEN');
  return missing;
}
