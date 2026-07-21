import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import UsersDashboard from './UsersDashboard';
import { AuthProvider } from '../../../contexts/AuthContext';
import { ToastProvider } from '../../../components/Toast';
import { __setMidasUsersEnabledForTests } from '../../../config/midasUsers';

// Estado mutable del "backend" simulado.
let roster: { usuario: string; contrasena: string; rol: string; permisos: string | null; b_Activo: boolean }[];
const calls: { url: string; method: string; body: unknown }[] = [];

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ status, success: status < 400, message: 'OK', data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installBackend() {
  vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (method === 'GET' && url.startsWith('/api/midas/usuarios')) return Promise.resolve(envelope(roster));
    if (method === 'POST' && url === '/api/midas/usuarios') {
      roster = [...roster, body];
      return Promise.resolve(envelope(body, 201));
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
}

function renderAsAdmin() {
  return render(
    <ToastProvider>
      <AuthProvider email="admin@x.com" role="admin">
        <UsersDashboard />
      </AuthProvider>
    </ToastProvider>,
  );
}

describe('<UsersDashboard /> — modo ONLINE (WS/midas)', () => {
  beforeEach(() => {
    __setMidasUsersEnabledForTests(true);
    calls.length = 0;
    roster = [{ usuario: 'existente@x.com', contrasena: 'h', rol: 'Usuario', permisos: 'cxp', b_Activo: true }];
    vi.stubGlobal('fetch', vi.fn());
    installBackend();
  });
  afterEach(() => {
    __setMidasUsersEnabledForTests(null);
    vi.unstubAllGlobals();
  });

  it('lists users from GET /usuarios', async () => {
    renderAsAdmin();
    expect(await screen.findByText('existente@x.com')).toBeTruthy();
    expect(calls.some((c) => c.method === 'GET' && c.url.startsWith('/api/midas/usuarios'))).toBe(true);
  });

  it('registers a new user via POST /usuarios and refreshes the list', async () => {
    renderAsAdmin();
    await screen.findByText('existente@x.com');
    fireEvent.change(screen.getByPlaceholderText('usuario@gruposenda.com'), {
      target: { value: 'nuevo@gruposenda.com' },
    });
    fireEvent.click(screen.getByText('Agregar'));
    expect(await screen.findByText('nuevo@gruposenda.com')).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('/api/midas/usuarios');
    expect((post?.body as { usuario: string }).usuario).toBe('nuevo@gruposenda.com');
  });
});
