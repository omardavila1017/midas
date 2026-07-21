import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createManagedUser,
  fetchManagedUsers,
  setManagedUserPermission,
  updateManagedUserRole,
} from './userManagement';
import { sha256Hex } from '../../../services/passwordHash';

const calls: { url: string; method: string; body: unknown }[] = [];

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ status, success: status < 400, message: 'OK', data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installRouter(handlers: Record<string, (body: unknown) => Response>) {
  vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const handler = handlers[`${method} ${url.split('?')[0]}`];
    if (!handler) throw new Error(`no handler for ${method} ${url}`);
    return Promise.resolve(handler(calls[calls.length - 1].body));
  });
}

describe('userManagement (adaptador ONLINE)', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('maps GET /usuarios to ManagedUser[] (admin has empty permissions)', async () => {
    installRouter({
      'GET /api/midas/usuarios': () =>
        envelope([
          { usuario: 'z@x.com', contrasena: 'h', rol: 'Usuario', permisos: 'cxp,bancos', b_Activo: true },
          { usuario: 'a@x.com', contrasena: 'h', rol: 'Administrador', permisos: null, b_Activo: true },
        ]),
    });
    const users = await fetchManagedUsers();
    expect(users.map((u) => u.email)).toEqual(['a@x.com', 'z@x.com']); // ordenado
    expect(users[0]).toEqual({ email: 'a@x.com', role: 'admin', permissions: [] });
    expect(users[1]).toEqual({ email: 'z@x.com', role: 'user', permissions: ['cxp', 'bancos'] });
  });

  it('alta: POSTs with the hashed initial password Senda123', async () => {
    installRouter({ 'POST /api/midas/usuarios': () => envelope(null, 201) });
    await createManagedUser('nuevo@x.com', 'user');
    const body = calls[0].body as { contrasena: string; rol: string; permisos: string | null };
    expect(body.contrasena).toBe(await sha256Hex('Senda123'));
    expect(body.rol).toBe('Usuario');
    expect(body.permisos).toBe('');
  });

  it('cambio de rol a admin limpia permisos (GET then PUT)', async () => {
    installRouter({
      'GET /api/midas/usuarios': () => envelope([{ usuario: 'u@x.com', contrasena: 'h', rol: 'Usuario', permisos: 'cxp', b_Activo: true }]),
      'PUT /api/midas/usuarios': () => envelope(null),
    });
    await updateManagedUserRole('u@x.com', 'admin');
    const put = calls.find((c) => c.method === 'PUT')!.body as { rol: string; permisos: string | null };
    expect(put.rol).toBe('Administrador');
    expect(put.permisos).toBeNull();
  });

  it('toggle de permiso: agrega y PUTea el CSV nuevo', async () => {
    installRouter({
      'GET /api/midas/usuarios': () => envelope([{ usuario: 'u@x.com', contrasena: 'h', rol: 'Usuario', permisos: 'cxp', b_Activo: true }]),
      'PUT /api/midas/usuarios': () => envelope(null),
    });
    await setManagedUserPermission('u@x.com', 'bancos', true);
    const put = calls.find((c) => c.method === 'PUT')!.body as { permisos: string };
    expect(put.permisos).toBe('cxp,bancos');
  });
});
