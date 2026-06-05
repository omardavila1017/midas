import { describe, expect, it } from 'vitest';
import { canManagePasswordReset } from './usersService';
import type { Role } from '../../../config/roles';

describe('usersService password reset permissions', () => {
  it('allows only admin to send reset links', () => {
    expect(canManagePasswordReset('admin')).toBe(true);
  });

  it('blocks user and none from sending reset links', () => {
    for (const role of ['user', 'none'] as Role[]) {
      expect(canManagePasswordReset(role)).toBe(false);
    }
  });
});
