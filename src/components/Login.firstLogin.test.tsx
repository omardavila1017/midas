import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AuthGate from './Login';
import { clearAuthSession } from '../contexts/authSession';
import { __setLocalAuthEnabledForTests } from '../services/localAuth';
import { __resetAccessRegistryForTests, upsertUser } from '../modules/users/services/accessControlStore';

// Primer ingreso "tipo register" en modo AUTH LOCAL: un usuario que un admin
// registró pero que aún no tiene contraseña debe definirla al entrar.
const REGISTERED = 'nuevo@gruposenda.com';

describe('<AuthGate /> primer ingreso (modo local)', () => {
  beforeEach(() => {
    __setLocalAuthEnabledForTests(true);
    localStorage.clear();
    sessionStorage.clear();
    clearAuthSession();
    __resetAccessRegistryForTests();
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    __setLocalAuthEnabledForTests(null);
    cleanup();
    localStorage.clear();
    sessionStorage.clear();
    clearAuthSession();
    __resetAccessRegistryForTests();
  });

  it('starts with an empty email field (no prefill)', async () => {
    render(<AuthGate><div>App montada</div></AuthGate>);
    const input = (await screen.findByPlaceholderText('usuario@senda.com')) as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('logs in a registered user with the hardcoded password (no set-password step)', async () => {
    const user = userEvent.setup();
    upsertUser(REGISTERED, 'user');

    render(<AuthGate><div>App montada</div></AuthGate>);

    await screen.findByText('Acceso empresarial');
    await user.type(screen.getByPlaceholderText('usuario@senda.com'), REGISTERED);
    await user.type(screen.getByLabelText('Contraseña'), 'Senda123');
    await user.click(screen.getByRole('button', { name: /Entrar/i }));

    // Con la contraseña hardcodeada `Senda123` entra directo, sin primer ingreso.
    expect(await screen.findByText('App montada')).toBeTruthy();
  });
});
