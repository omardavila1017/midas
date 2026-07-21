import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MIDAS_SESSION_KEY,
  clearMidasSession,
  readMidasSession,
  writeMidasSession,
} from './midasSession';

describe('midasSession', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('writes and reads back an identity-only marker', () => {
    const marker = writeMidasSession('Carlos@X.com', 'user', ['cxp', 'bancos']);
    expect(marker.email).toBe('carlos@x.com'); // normalizado
    expect(readMidasSession()).toEqual(marker);
  });

  it('never stores a token or password — only identity fields', () => {
    writeMidasSession('a@x.com', 'admin', []);
    const raw = localStorage.getItem(MIDAS_SESSION_KEY) ?? '';
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed).sort()).toEqual(['email', 'expiresAt', 'permissions', 'role']);
  });

  it('sanitizes permissions against the module vocabulary', () => {
    const marker = writeMidasSession('a@x.com', 'user', ['cxp', 'basura', 'users'] as never);
    expect(marker.permissions).toEqual(['cxp']);
  });

  it('drops an expired marker and returns null', () => {
    writeMidasSession('a@x.com', 'user', ['cxp']);
    // Fuerza expiración en el pasado.
    const raw = JSON.parse(localStorage.getItem(MIDAS_SESSION_KEY)!);
    raw.expiresAt = new Date(Date.now() - 1000).toISOString();
    localStorage.setItem(MIDAS_SESSION_KEY, JSON.stringify(raw));
    expect(readMidasSession()).toBeNull();
    expect(localStorage.getItem(MIDAS_SESSION_KEY)).toBeNull();
  });

  it('returns null for a missing / corrupt marker', () => {
    expect(readMidasSession()).toBeNull();
    localStorage.setItem(MIDAS_SESSION_KEY, 'not-json');
    expect(readMidasSession()).toBeNull();
  });

  it('clears the marker', () => {
    writeMidasSession('a@x.com', 'admin', []);
    clearMidasSession();
    expect(readMidasSession()).toBeNull();
  });
});
