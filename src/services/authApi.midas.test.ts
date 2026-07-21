import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adminSetPassword,
  changePassword,
  getAuthSession,
  login,
  logout,
} from './authApi';
import { __setMidasUsersEnabledForTests } from '../config/midasUsers';
import { readMidasSession, writeMidasSession } from './midasSession';
import { sha256Hex } from './passwordHash';

type FetchArgs = { url: string; method: string; body: unknown };
const calls: FetchArgs[] = [];

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ status, success: status < 400, message: 'OK', data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Router de fetch por (método, ruta) para simular WS/midas. */
function installRouter(handlers: Record<string, (body: unknown) => Response>) {
  vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const key = `${method} ${url.split('?')[0]}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`no handler for ${key}`);
    return Promise.resolve(handler(body));
  });
}

describe('authApi — modo ONLINE (WS/midas)', () => {
  beforeEach(() => {
    __setMidasUsersEnabledForTests(true);
    localStorage.clear();
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    __setMidasUsersEnabledForTests(null);
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('login hashes the password (never plaintext) and opens a session marker', async () => {
    installRouter({
      'POST /api/midas/usuarios/validate': () =>
        envelope({ usuario: 'carlos.ortiz@gruposenda.com', rol: 'Usuario', permisos: 'cxp,bancos', b_Activo: true }),
    });

    const res = await login('Carlos.Ortiz@gruposenda.com', 'Senda123');
    expect(res.role).toBe('user');
    expect(res.permissions).toEqual(['cxp', 'bancos']);

    // La contraseña viajó como hash SHA-256, nunca en claro.
    const sent = calls[0].body as { usuario: string; contrasena: string };
    expect(sent.usuario).toBe('carlos.ortiz@gruposenda.com');
    expect(sent.contrasena).toBe(await sha256Hex('Senda123'));
    expect(sent.contrasena).not.toBe('Senda123');

    // Se abrió el marcador de sesión con identidad + permisos.
    const marker = readMidasSession();
    expect(marker?.email).toBe('carlos.ortiz@gruposenda.com');
    expect(marker?.permissions).toEqual(['cxp', 'bancos']);
  });

  it('login maps invalid credentials (401) to invalid_credentials', async () => {
    installRouter({ 'POST /api/midas/usuarios/validate': () => envelope(null, 401) });
    await expect(login('a@x.com', 'bad')).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(readMidasSession()).toBeNull();
  });

  it('getAuthSession reads the local marker (no session endpoint)', async () => {
    writeMidasSession('a@x.com', 'admin', []);
    await expect(getAuthSession()).resolves.toMatchObject({
      authenticated: true,
      email: 'a@x.com',
      role: 'admin',
    });
    expect(calls).toHaveLength(0); // no hubo red
  });

  it('getAuthSession is anonymous without a marker', async () => {
    await expect(getAuthSession()).resolves.toEqual({ authenticated: false, email: null, role: 'none' });
  });

  it('logout clears the session marker', async () => {
    writeMidasSession('a@x.com', 'user', ['cxp']);
    await logout();
    expect(readMidasSession()).toBeNull();
  });

  it('changePassword verifies the current password then PUTs the new hash', async () => {
    writeMidasSession('b@x.com', 'user', ['cxp']);
    installRouter({
      'POST /api/midas/usuarios/validate': () => envelope({ usuario: 'b@x.com', rol: 'Usuario', permisos: 'cxp', b_Activo: true }),
      'GET /api/midas/usuarios': () => envelope([{ usuario: 'b@x.com', contrasena: 'OLD', rol: 'Usuario', permisos: 'cxp', b_Activo: true }]),
      'PUT /api/midas/usuarios': () => envelope(null),
    });

    await changePassword('Senda123', 'NuevaClave!2026');

    const put = calls.find((c) => c.method === 'PUT')!;
    expect((put.body as { contrasena: string }).contrasena).toBe(await sha256Hex('NuevaClave!2026'));
    // También verificó la actual por /validate con el hash de la vieja.
    const validate = calls.find((c) => c.url.endsWith('/validate'))!;
    expect((validate.body as { contrasena: string }).contrasena).toBe(await sha256Hex('Senda123'));
  });

  it('changePassword rejects a wrong current password', async () => {
    writeMidasSession('b@x.com', 'user', ['cxp']);
    installRouter({ 'POST /api/midas/usuarios/validate': () => envelope(null, 401) });
    await expect(changePassword('wrong', 'NuevaClave!2026')).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('adminSetPassword PUTs the target user with the new hash', async () => {
    installRouter({
      'GET /api/midas/usuarios': () => envelope([{ usuario: 'target@x.com', contrasena: 'OLD', rol: 'Usuario', permisos: 'cxp', b_Activo: true }]),
      'PUT /api/midas/usuarios': () => envelope(null),
    });
    await adminSetPassword('target@x.com', 'Reset!2026abc');
    const put = calls.find((c) => c.method === 'PUT')!;
    expect((put.body as { usuario: string; contrasena: string }).usuario).toBe('target@x.com');
    expect((put.body as { contrasena: string }).contrasena).toBe(await sha256Hex('Reset!2026abc'));
  });
});
