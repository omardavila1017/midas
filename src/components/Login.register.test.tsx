import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AuthGate from './Login';
import { clearAuthSession } from '../contexts/authSession';
import { __setLocalAuthEnabledForTests } from '../services/localAuth';
import { __resetAccessRegistryForTests, upsertUser } from '../modules/users/services/accessControlStore';

// Auto-registro explícito "tipo Atlas" (modo AUTH LOCAL): un usuario pre-registrado
// por un admin entra por "Crear cuenta", define su contraseña y queda activo.
const PREREGISTERED = 'nuevo@gruposenda.com';
const STRANGER = 'desconocido@gruposenda.com';

async function openRegister(user: ReturnType<typeof userEvent.setup>) {
  render(<AuthGate><div>App montada</div></AuthGate>);
  await screen.findByText('Acceso empresarial');
  await user.click(screen.getByRole('button', { name: /Crea tu cuenta/i }));
  return screen.findByRole('heading', { name: 'Crear cuenta' });
}

describe('<AuthGate /> crear cuenta (modo local)', () => {
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

  it('shows the "Crea tu cuenta" entry on the login screen in local mode', async () => {
    render(<AuthGate><div>App montada</div></AuthGate>);
    await screen.findByText('Acceso empresarial');
    expect(screen.getByRole('button', { name: /Crea tu cuenta/i })).toBeTruthy();
  });

  it('tells a pre-registered user they already have an account (hardcoded password)', async () => {
    // Con la contraseña hardcodeada `Senda123`, todo correo conocido ya tiene
    // cuenta activa: el registro lo manda a iniciar sesión en vez de definir clave.
    const user = userEvent.setup();
    upsertUser(PREREGISTERED, 'user');

    await openRegister(user);

    await user.type(screen.getByPlaceholderText('usuario@senda.com'), PREREGISTERED);
    await user.type(screen.getByLabelText('Crea tu contraseña'), 'PrimeraClave2026!');
    await user.type(screen.getByLabelText('Confirmar contraseña'), 'PrimeraClave2026!');
    await user.click(screen.getByRole('button', { name: /Crear cuenta/i }));

    expect(await screen.findByText(/Ya tienes una cuenta activa/i)).toBeTruthy();
    expect(screen.queryByText('App montada')).toBeNull();
  });

  it('rejects an email that an admin has not pre-registered', async () => {
    const user = userEvent.setup();

    await openRegister(user);

    await user.type(screen.getByPlaceholderText('usuario@senda.com'), STRANGER);
    await user.type(screen.getByLabelText('Crea tu contraseña'), 'PrimeraClave2026!');
    await user.type(screen.getByLabelText('Confirmar contraseña'), 'PrimeraClave2026!');
    await user.click(screen.getByRole('button', { name: /Crear cuenta/i }));

    expect(await screen.findByText(/no está pre-registrado/i)).toBeTruthy();
    // Sigue en la pantalla de registro, sin montar la app.
    expect(screen.queryByText('App montada')).toBeNull();
  });
});
