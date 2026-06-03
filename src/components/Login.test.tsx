import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AuthGate from './Login';
import { clearAuthSession } from '../contexts/authSession';
import { __setLocalAuthEnabledForTests } from '../services/localAuth';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('<AuthGate />', () => {
  beforeEach(() => {
    // Estos tests ejercitan el path de BACKEND del Login; desactivamos el modo
    // auth local (activo por JSON) para que no intercepte las llamadas.
    __setLocalAuthEnabledForTests(false);
    localStorage.clear();
    sessionStorage.clear();
    clearAuthSession();
    window.history.replaceState({}, '', '/');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    __setLocalAuthEnabledForTests(null);
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
    clearAuthSession();
    window.history.replaceState({}, '', '/');
  });

  it('does not mount the app until backend session is authenticated', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      authenticated: true,
      email: 'admin@senda.com',
      role: 'admin',
    }));

    render(<AuthGate><div>App montada</div></AuthGate>);

    expect(screen.getByText('Validando sesión')).toBeTruthy();
    expect(await screen.findByText('App montada')).toBeTruthy();
  });

  it('logs in through /api/auth/login', async () => {
    const user = userEvent.setup();
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ email: 'admin@senda.com', role: 'admin' }));

    render(<AuthGate><div>App montada</div></AuthGate>);

    await screen.findByText('Acceso empresarial');
    await user.type(screen.getByPlaceholderText('usuario@senda.com'), 'admin@senda.com');
    await user.type(screen.getByLabelText('Contraseña'), 'ValidPassword1!');
    await user.click(screen.getByRole('button', { name: /Entrar/i }));

    expect(await screen.findByText('App montada')).toBeTruthy();
    expect(fetch).toHaveBeenLastCalledWith('/api/auth/login', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
    }));
  });

  it('requests a reset link without revealing whether the email exists', async () => {
    const user = userEvent.setup();
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    render(<AuthGate><div>App montada</div></AuthGate>);

    await screen.findByText('Acceso empresarial');
    await user.click(screen.getByRole('button', { name: 'Olvidé mi contraseña' }));
    await user.type(screen.getByPlaceholderText('usuario@senda.com'), 'persona@senda.com');
    await user.click(screen.getByRole('button', { name: 'Enviar liga' }));

    expect(await screen.findByText(/Si el correo está registrado/)).toBeTruthy();
    expect(fetch).toHaveBeenLastCalledWith('/api/auth/password/reset/request', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ email: 'persona@senda.com' }),
    }));
  });

  it('completes a password reset from reset_token URL', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/?reset_token=abc123');
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ ok: true }));

    render(<AuthGate><div>App montada</div></AuthGate>);

    await screen.findByText('Definir nueva contraseña');
    await user.type(screen.getByLabelText('Nueva contraseña'), 'ValidPassword1!');
    await user.type(screen.getByLabelText('Confirmar contraseña'), 'ValidPassword1!');
    await user.click(screen.getByRole('button', { name: 'Guardar contraseña' }));

    await waitFor(() => expect(window.location.search).not.toContain('reset_token'));
    expect(await screen.findByText(/Contraseña actualizada/)).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith('/api/auth/password/reset/complete', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ token: 'abc123', newPassword: 'ValidPassword1!' }),
    }));
  });
});
