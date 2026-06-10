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

  it('treats every user as having the hardcoded password by default', async () => {
    // Todos los correos tienen la contraseña hardcodeada `Senda123` mientras no
    // exista un overlay propio, así que `hasLocalPassword` es siempre true.
    expect(hasLocalPassword(ADMIN)).toBe(true);
    expect(hasLocalPassword('nuevo@gruposenda.com')).toBe(true);
    await expect(verifyLocalPassword(ADMIN, 'Senda123')).resolves.toBe(true);
  });

  it('logs in any JSON user with the hardcoded password', async () => {
    const session = await localLogin(ADMIN, 'Senda123');
    expect(session.email).toBe(ADMIN);
    expect(session.role).toBe('admin');
  });

  it('rejects login for a JSON user with a non-hardcoded password', async () => {
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

  it('resolves the role from the JSON per user (admin vs user)', async () => {
    // El roster del JSON está hardcodeado con roles admin/user; este correo es `user`.
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

  it('sets a password overlay for an email outside the JSON (admin / first login)', async () => {
    const NEW = 'nuevo@gruposenda.com';
    // Arranca con la contraseña hardcodeada (sin overlay propio).
    expect(hasLocalPassword(NEW)).toBe(true);
    await expect(verifyLocalPassword(NEW, 'Senda123')).resolves.toBe(true);

    await setLocalPassword(NEW, PWD);

    expect(hasLocalPassword(NEW)).toBe(true);
    await expect(verifyLocalPassword(NEW, PWD)).resolves.toBe(true);
    // 'otra' no es ni el overlay ni la hardcodeada → inválida.
    await expect(verifyLocalPassword(NEW, 'otra')).resolves.toBe(false);
  });
});
