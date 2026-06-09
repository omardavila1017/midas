import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adminSetPassword,
  completeFirstLogin,
  login,
  requiresPasswordSetup,
} from './authApi';
import { __setLocalAuthEnabledForTests } from './localAuth';
import { __resetAccessRegistryForTests, upsertUser } from '../modules/users/services/accessControlStore';

// Estas pruebas ejercitan el modo AUTH LOCAL (JSON + registro de usuarios),
// el camino que usa el deploy actual. Forzamos el flag para no depender del
// JSON y reseteamos el registro entre casos.
const JSON_ADMIN = 'agustin.blanco@gruposenda.com';
const REGISTERED = 'nuevo@gruposenda.com';

describe('authApi (modo local)', () => {
  beforeEach(() => {
    __setLocalAuthEnabledForTests(true);
    localStorage.clear();
    __resetAccessRegistryForTests();
  });

  afterEach(() => {
    __setLocalAuthEnabledForTests(null);
    localStorage.clear();
    __resetAccessRegistryForTests();
  });

  it('routes a passwordless JSON user through first login, then accepts the password', async () => {
    // El JSON ya no siembra contraseñas: el usuario está pre-registrado pero sin
    // contraseña, así que primero la define (igual que un alta de admin).
    expect(requiresPasswordSetup(JSON_ADMIN)).toBe(true);
    await completeFirstLogin(JSON_ADMIN, 'PrimeraClave2026!');
    await expect(login(JSON_ADMIN, 'PrimeraClave2026!')).resolves.toMatchObject({
      email: JSON_ADMIN,
      role: 'admin',
      passwordExpired: false,
    });
  });

  it('flags a registered-but-passwordless user as needing setup', () => {
    upsertUser(REGISTERED, 'user');
    expect(requiresPasswordSetup(REGISTERED)).toBe(true);
    // Un usuario del JSON ahora también arranca sin contraseña → necesita setup.
    expect(requiresPasswordSetup(JSON_ADMIN)).toBe(true);
    // Un correo desconocido no es "registrado": tampoco entra al primer ingreso.
    expect(requiresPasswordSetup('desconocido@gruposenda.com')).toBe(false);
  });

  it('signals password_setup_required when a registered user logs in without a password', async () => {
    upsertUser(REGISTERED, 'user');
    await expect(login(REGISTERED, 'loquesea')).rejects.toMatchObject({
      code: 'password_setup_required',
    });
  });

  it('completes a first login (register), then accepts the new password', async () => {
    upsertUser(REGISTERED, 'user');

    const session = await completeFirstLogin(REGISTERED, 'PrimeraClave2026!');
    expect(session).toMatchObject({ email: REGISTERED, role: 'user' });

    // Ya no necesita setup y la contraseña recién creada entra.
    expect(requiresPasswordSetup(REGISTERED)).toBe(false);
    await expect(login(REGISTERED, 'PrimeraClave2026!')).resolves.toMatchObject({ email: REGISTERED });
  });

  it('refuses a first login for an unregistered email', async () => {
    await expect(completeFirstLogin('intruso@gruposenda.com', 'PrimeraClave2026!')).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
  });

  it('lets an admin set a user password directly, which then logs in', async () => {
    upsertUser(REGISTERED, 'user');

    await adminSetPassword(REGISTERED, 'FijadaPorAdmin2026!');

    await expect(login(REGISTERED, 'FijadaPorAdmin2026!')).resolves.toMatchObject({ email: REGISTERED });
    await expect(login(REGISTERED, 'otra')).rejects.toMatchObject({ code: 'invalid_credentials' });
  });
});
