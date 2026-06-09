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

// El JSON embebido (authLocalUsers.json) ya NO siembra contraseñas: los usuarios
// arrancan SIN contraseña (pre-registrados, correo + rol). Cada uno define la
// suya en el primer ingreso, que vive en el overlay de localStorage. Aquí
// definimos la contraseña antes de ejercitar el login.
const ADMIN = 'agustin.blanco@gruposenda.com';
const COBRANZA = 'blanca.reyes@gruposenda.com';
const PWD = 'PrimeraClave2026!';

describe('localAuth', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('hashes a password deterministically with the configured salt', async () => {
    // SHA-256("midas.local.auth.v1:12345") — el hash es estable por salt + clave.
    await expect(hashLocalPassword('12345')).resolves.toBe(
      '466f428cfb1d015c1325a3316af870ef34db88fbd2e583486d38c21b651a1bc0',
    );
  });

  it('reports a JSON user as passwordless until a password is defined', () => {
    // El JSON ya no trae hash semilla: el usuario está pre-registrado pero sin
    // contraseña hasta que la define (primer ingreso / admin).
    expect(hasLocalPassword(ADMIN)).toBe(false);
    expect(hasLocalPassword('nuevo@gruposenda.com')).toBe(false);
  });

  it('rejects login for a passwordless JSON user', async () => {
    // Sin contraseña definida no se puede iniciar sesión (debe registrarse).
    await expect(localLogin(ADMIN, PWD)).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('logs in a JSON user after a password is defined, opening a session', async () => {
    await setLocalPassword(ADMIN, PWD);
    const session = await localLogin(ADMIN, PWD);
    expect(session.email).toBe(ADMIN);
    expect(session.role).toBe('admin');
    expect(Date.parse(session.expiresAt)).toBeGreaterThan(Date.now());
    expect(readLocalSession()?.email).toBe(ADMIN);
    expect(localStorage.getItem(LOCAL_SESSION_KEY)).toBeTruthy();
  });

  it('resolves the role from the JSON per user, collapsing legacy roles to user', async () => {
    // El JSON trae a este usuario con rol granular legacy "cobranza"; el modelo
    // nuevo lo colapsa a "user".
    await setLocalPassword(COBRANZA, PWD);
    const session = await localLogin(COBRANZA, PWD);
    expect(session.role).toBe('user');
  });

  it('normalizes the email (case-insensitive) on login', async () => {
    await setLocalPassword(ADMIN, PWD);
    const session = await localLogin(ADMIN.toUpperCase(), PWD);
    expect(session.email).toBe(ADMIN);
  });

  it('rejects a wrong password with invalid_credentials', async () => {
    await setLocalPassword(ADMIN, PWD);
    await expect(localLogin(ADMIN, 'wrong')).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('rejects an unknown user with the same generic error', async () => {
    await expect(localLogin('nadie@ejemplo.com', PWD)).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
  });

  it('clears the session on logout-equivalent', async () => {
    await setLocalPassword(ADMIN, PWD);
    await localLogin(ADMIN, PWD);
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
    await setLocalPassword(ADMIN, PWD);
    await localLogin(ADMIN, PWD);
    await localChangePassword(PWD, 'NuevaClave2026!');

    // El overlay queda persistido y la nueva contraseña entra; la vieja no.
    expect(localStorage.getItem(LOCAL_OVERRIDES_KEY)).toBeTruthy();
    clearLocalSession();
    await expect(localLogin(ADMIN, 'NuevaClave2026!')).resolves.toMatchObject({ email: ADMIN });
    await expect(localLogin(ADMIN, PWD)).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('rejects a password change when the current password is wrong', async () => {
    await setLocalPassword(ADMIN, PWD);
    await localLogin(ADMIN, PWD);
    await expect(localChangePassword('wrong', 'NuevaClave2026!')).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
  });

  it('sets a password for an email outside the JSON (admin / first login)', async () => {
    const NEW = 'nuevo@gruposenda.com';
    expect(hasLocalPassword(NEW)).toBe(false);

    await setLocalPassword(NEW, PWD);

    expect(hasLocalPassword(NEW)).toBe(true);
    await expect(verifyLocalPassword(NEW, PWD)).resolves.toBe(true);
    await expect(verifyLocalPassword(NEW, 'otra')).resolves.toBe(false);
  });
});
