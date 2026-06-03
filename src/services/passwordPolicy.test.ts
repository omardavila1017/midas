import { describe, expect, it } from 'vitest';
import { getPasswordPolicyChecks, passwordMeetsPolicy } from './passwordPolicy';

describe('passwordPolicy', () => {
  it('requires enterprise baseline criteria', () => {
    expect(passwordMeetsPolicy('short')).toBe(false);
    expect(passwordMeetsPolicy('longbutmissingnumber!')).toBe(false);
    expect(passwordMeetsPolicy('ValidPassword1!')).toBe(true);
  });

  it('reports each failed criterion independently', () => {
    const checks = getPasswordPolicyChecks('abc');
    expect(checks.filter((check) => check.passed).map((check) => check.id)).toEqual(['lowercase']);
    expect(checks.filter((check) => !check.passed).map((check) => check.id)).toEqual([
      'length',
      'uppercase',
      'number',
      'symbol',
    ]);
  });
});
