import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __setMidasUsersEnabledForTests,
  isMidasUsersEnabled,
  midasSessionTtlHours,
} from './midasUsers';

describe('midasUsers', () => {
  afterEach(() => {
    __setMidasUsersEnabledForTests(null);
    vi.unstubAllEnvs();
  });

  it('defaults to ON when the flag is not "false"', () => {
    vi.stubEnv('VITE_MIDAS_USERS_ENABLED', '');
    expect(isMidasUsersEnabled()).toBe(true);
    vi.stubEnv('VITE_MIDAS_USERS_ENABLED', 'true');
    expect(isMidasUsersEnabled()).toBe(true);
  });

  it('kill-switch: "false" reverts to local mode', () => {
    vi.stubEnv('VITE_MIDAS_USERS_ENABLED', 'false');
    expect(isMidasUsersEnabled()).toBe(false);
  });

  it('test override wins over the env flag', () => {
    vi.stubEnv('VITE_MIDAS_USERS_ENABLED', 'false');
    __setMidasUsersEnabledForTests(true);
    expect(isMidasUsersEnabled()).toBe(true);
    __setMidasUsersEnabledForTests(false);
    expect(isMidasUsersEnabled()).toBe(false);
  });

  it('session TTL defaults to 12h and honors a valid override', () => {
    vi.stubEnv('VITE_MIDAS_SESSION_TTL_HOURS', '');
    expect(midasSessionTtlHours()).toBe(12);
    vi.stubEnv('VITE_MIDAS_SESSION_TTL_HOURS', '8');
    expect(midasSessionTtlHours()).toBe(8);
    vi.stubEnv('VITE_MIDAS_SESSION_TTL_HOURS', 'abc');
    expect(midasSessionTtlHours()).toBe(12);
    vi.stubEnv('VITE_MIDAS_SESSION_TTL_HOURS', '-3');
    expect(midasSessionTtlHours()).toBe(12);
  });
});
