import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTH_LAST_EMAIL_KEY,
  LEGACY_AUTH_SESSION_KEY,
  clearAuthSession,
  getCurrentAuthSession,
  getPrefillEmail,
  rememberLastEmail,
  setCurrentAuthSession,
} from './authSession';

describe('authSession', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    clearAuthSession();
  });
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    clearAuthSession();
  });

  it('solo persiste el último correo para prellenar el login', () => {
    rememberLastEmail('Ana@Senda.com');

    expect(localStorage.getItem(AUTH_LAST_EMAIL_KEY)).toBe('ana@senda.com');
    expect(sessionStorage.length).toBe(0);
    expect(getPrefillEmail()).toBe('ana@senda.com');
  });

  it('mantiene la sesión real solo en memoria', () => {
    setCurrentAuthSession({
      email: 'Admin@Senda.com',
      role: 'admin',
      expiresAt: '2026-06-03T18:00:00.000Z',
    });

    expect(getCurrentAuthSession()).toEqual({
      email: 'admin@senda.com',
      role: 'admin',
      expiresAt: '2026-06-03T18:00:00.000Z',
    });
    expect(localStorage.getItem(AUTH_LAST_EMAIL_KEY)).toBe('admin@senda.com');
    expect(sessionStorage.length).toBe(0);
  });

  it('clearAuthSession limpia la sesión en memoria y una key legacy si existía', () => {
    localStorage.setItem(LEGACY_AUTH_SESSION_KEY, JSON.stringify({ email: 'legacy@senda.com' }));
    setCurrentAuthSession({ email: 'ana@senda.com', role: 'admin' });

    clearAuthSession();

    expect(getCurrentAuthSession()).toBeNull();
    expect(localStorage.getItem(LEGACY_AUTH_SESSION_KEY)).toBeNull();
    expect(localStorage.getItem(AUTH_LAST_EMAIL_KEY)).toBe('ana@senda.com');
  });
});
