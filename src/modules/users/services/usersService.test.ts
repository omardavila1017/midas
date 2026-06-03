import { describe, expect, it } from 'vitest';
import { canManagePasswordReset } from './usersService';
import type { Role } from '../../../config/roles';

describe('usersService password reset permissions', () => {
  it('allows admin and mesa_ayuda to send reset links', () => {
    expect(canManagePasswordReset('admin')).toBe(true);
    expect(canManagePasswordReset('mesa_ayuda')).toBe(true);
  });

  it('blocks financial roles from sending reset links', () => {
    for (const role of ['abastos', 'contaduria', 'fiscal', 'cobranza', 'none'] as Role[]) {
      expect(canManagePasswordReset(role)).toBe(false);
    }
  });
});
