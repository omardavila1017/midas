import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOCAL_OVERRIDES_KEY,
  LOCAL_SESSION_KEY,
  clearLocalSession,
  hasLocalPassword,
  hashLocalPassword,
  localChangePassword,
  localLogin,
  readLocalSession,
  setLocalPassword,
  verifyLocalPassword,
} from './localAuth';

// El JSON embebido (authLocalUsers.json) trae a estos usuarios con password
// "12345". Probamos contra esos datos reales (no mocks) para validar el wiring.
const ADMIN = 'agustin.blanco@gruposenda.com';
const COBRANZA = 'blanca.reyes@gruposenda.com';

describe('localAuth', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('hashes "12345" to the value baked into the JSON', async () => {
    // SHA-256("midas.local.auth.v1:12345") — debe coincidir con passwordHash.
    await expect(hashLocalPassword('12345')).resolves.toBe(
      '466f428cfb1d015c1325a3316af870ef34db88fbd2e583486d38c21b651a1bc0',
    );
  });

  it('logs in a known user with the dev password and opens a session', async () => {
    const session = await localLogin(ADMIN, '12345');
    expect(session.email).toBe(ADMIN);
    expect(session.role).toBe('admin');
    expect(Date.parse(session.expiresAt)).toBeGreaterThan(Date.now());
    expect(readLocalSession()?.email).toBe(ADMIN);
    expect(localStorage.getItem(LOCAL_SESSION_KEY)).toBeTruthy();
  });

  it('resolves the role from the JSON per user, collapsing legacy roles to user', async () => {
    // El JSON trae a este usuario con rol granular legacy "cobranza"; el modelo
    // nuevo lo colapsa a "user".
    const session = await localLogin(COBRANZA, '12345');
    expect(session.role).toBe('user');
  });

  it('normalizes the email (case-insensitive) on login', async () => {
    const session = await localLogin(ADMIN.toUpperCase(), '12345');
    expect(session.email).toBe(ADMIN);
  });

  it('rejects a wrong password with invalid_credentials', async () => {
    await expect(localLogin(ADMIN, 'wrong')).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('rejects an unknown user with the same generic error', async () => {
    await expect(localLogin('nadie@ejemplo.com', '12345')).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
  });

  it('clears the session on logout-equivalent', async () => {
    await localLogin(ADMIN, '12345');
    clearLocalSession();
    expect(readLocalSession()).toBeNull();
  });

  it('treats an expired session as no session', async () => {
    localStorage.setItem(
      LOCAL_SESSION_KEY,
      JSON.stringify({ email: ADMIN, role: 'admin', expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    expect(readLocalSession()).toBeNull();
  });

  it('changes the password via the localStorage overlay', async () => {
    await localLogin(ADMIN, '12345');
    await localChangePassword('12345', 'NuevaClave2026!');

    // El overlay queda persistido y la nueva contraseña entra; la vieja no.
    expect(localStorage.getItem(LOCAL_OVERRIDES_KEY)).toBeTruthy();
    clearLocalSession();
    await expect(localLogin(ADMIN, 'NuevaClave2026!')).resolves.toMatchObject({ email: ADMIN });
    await expect(localLogin(ADMIN, '12345')).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('rejects a password change when the current password is wrong', async () => {
    await localLogin(ADMIN, '12345');
    await expect(localChangePassword('wrong', 'NuevaClave2026!')).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
  });

  it('reports a JSON user as having a password, an unknown email as not', () => {
    // Usuario del JSON: trae hash semilla. Correo desconocido: sin contraseña.
    expect(hasLocalPassword(ADMIN)).toBe(true);
    expect(hasLocalPassword('nuevo@gruposenda.com')).toBe(false);
  });

  it('sets a password for an email outside the JSON (admin / first login)', async () => {
    const NEW = 'nuevo@gruposenda.com';
    expect(hasLocalPassword(NEW)).toBe(false);

    await setLocalPassword(NEW, 'PrimeraClave2026!');

    expect(hasLocalPassword(NEW)).toBe(true);
    await expect(verifyLocalPassword(NEW, 'PrimeraClave2026!')).resolves.toBe(true);
    await expect(verifyLocalPassword(NEW, 'otra')).resolves.toBe(false);
  });
});
