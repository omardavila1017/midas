import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthApiError,
  changePassword,
  completePasswordReset,
  getAuthSession,
  login,
  requestPasswordReset,
  sendUserPasswordReset,
} from './authApi';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('authApi', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads an authenticated backend session', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      authenticated: true,
      email: 'Admin@Senda.com',
      role: 'admin',
      expiresAt: '2026-06-03T18:00:00.000Z',
    }));

    await expect(getAuthSession()).resolves.toEqual({
      authenticated: true,
      email: 'admin@senda.com',
      role: 'admin',
      expiresAt: '2026-06-03T18:00:00.000Z',
    });
    expect(fetch).toHaveBeenCalledWith('/api/auth/session', expect.objectContaining({
      credentials: 'include',
    }));
  });

  it('maps 401 session to anonymous instead of leaking details', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 401));

    await expect(getAuthSession()).resolves.toEqual({
      authenticated: false,
      email: null,
      role: 'none',
    });
  });

  it('posts login credentials and normalizes role/email', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      email: 'Tesoreria@Senda.com',
      role: 'admin',
    }));

    await expect(login('tesoreria@senda.com', 'Secret123!')).resolves.toEqual({
      email: 'tesoreria@senda.com',
      role: 'admin',
      expiresAt: undefined,
      passwordExpired: false,
    });
    expect(fetch).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ email: 'tesoreria@senda.com', password: 'Secret123!' }),
    }));
  });

  it.each([
    [401, 'invalid_credentials'],
    [403, 'forbidden'],
    [423, 'password_expired'],
    [429, 'rate_limited'],
    [500, 'unknown'],
  ] as const)('maps status %s to %s', async (status, code) => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({}, status));

    await expect(login('a@senda.com', 'x')).rejects.toMatchObject({ code });
  });

  it('maps invalid reset token payload to invalid_token', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ code: 'invalid_token' }, 400));

    await expect(completePasswordReset('bad-token', 'Password123!')).rejects.toMatchObject({
      code: 'invalid_token',
    });
  });

  it('uses the documented password endpoints', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({}));

    await changePassword('Current123!', 'NewPassword123!');
    await requestPasswordReset('ana@senda.com');
    await sendUserPasswordReset('ana@senda.com');

    expect(fetch).toHaveBeenNthCalledWith(1, '/api/auth/password/change', expect.objectContaining({ method: 'POST' }));
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/auth/password/reset/request', expect.objectContaining({ method: 'POST' }));
    expect(fetch).toHaveBeenNthCalledWith(3, '/api/auth/users/ana%40senda.com/password-reset', expect.objectContaining({ method: 'POST' }));
  });

  it('returns a network error without exposing internals', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('socket detail'));

    try {
      await login('a@senda.com', 'x');
      throw new Error('expected login to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthApiError);
      expect(error).toMatchObject({ code: 'network' });
      expect(String((error as Error).message)).not.toContain('socket detail');
    }
  });
});
