const CLIENT_SECRET_ENV_KEYS = [
  'VITE_JDE_TOKEN',
  'VITE_COGNOS_TOKEN',
  `VITE_OPENAI_${'API_KEY'}`,
] as const;

type EnvLike = Record<string, string | boolean | undefined>;

export function unsafeClientSecretKeys(env: EnvLike): string[] {
  return CLIENT_SECRET_ENV_KEYS.filter((key) => Boolean(env[key]));
}
