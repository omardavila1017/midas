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

  it('logs in any JSON user with the hardcoded password, no setup needed', async () => {
    // Con la contraseña hardcodeada `Senda123`, nadie pasa por el primer ingreso.
    expect(requiresPasswordSetup(JSON_ADMIN)).toBe(false);
    await expect(login(JSON_ADMIN, 'Senda123')).resolves.toMatchObject({
      email: JSON_ADMIN,
      role: 'admin',
      passwordExpired: false,
    });
  });

  it('never flags a known user as needing setup (hardcoded password)', () => {
    upsertUser(REGISTERED, 'user');
    expect(requiresPasswordSetup(REGISTERED)).toBe(false);
    expect(requiresPasswordSetup(JSON_ADMIN)).toBe(false);
    // Un correo desconocido tampoco entra al primer ingreso.
    expect(requiresPasswordSetup('desconocido@gruposenda.com')).toBe(false);
  });

  it('logs in a registered user with the hardcoded password', async () => {
    upsertUser(REGISTERED, 'user');
    await expect(login(REGISTERED, 'Senda123')).resolves.toMatchObject({ email: REGISTERED, role: 'user' });
    await expect(login(REGISTERED, 'loquesea')).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('rejects completeFirstLogin because every account already has the hardcoded password', async () => {
    upsertUser(REGISTERED, 'user');

    await expect(completeFirstLogin(REGISTERED, 'PrimeraClave2026!')).rejects.toMatchObject({
      code: 'validation',
    });
    // El usuario simplemente inicia sesión con la contraseña hardcodeada.
    await expect(login(REGISTERED, 'Senda123')).resolves.toMatchObject({ email: REGISTERED });
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
