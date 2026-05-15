import { describe, expect, it } from 'vitest';
import { unsafeClientSecretKeys } from './apiSecurity';

describe('api.config security helpers', () => {
  it('detects client-visible production secrets', () => {
    expect(unsafeClientSecretKeys({
      PROD: true,
      VITE_JDE_TOKEN: 'jde',
      VITE_COGNOS_TOKEN: 'cognos',
      [`VITE_OPENAI_${'API_KEY'}`]: 'openai',
    })).toEqual([
      'VITE_JDE_TOKEN',
      'VITE_COGNOS_TOKEN',
      `VITE_OPENAI_${'API_KEY'}`,
    ]);
  });
});
