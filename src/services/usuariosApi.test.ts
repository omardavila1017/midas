import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from './authError';
import {
  createUsuario,
  deleteUsuario,
  getUsuario,
  listUsuarios,
  roleFromApi,
  roleToApi,
  updateUsuario,
  validateUsuario,
  type UsuarioApi,
} from './usuariosApi';

/** Sobre común de respuesta del backend WS/midas. */
function envelope(data: unknown, status = 200, message = 'OK'): Response {
  return new Response(JSON.stringify({ status, success: status < 400, message, date: '2026-07-14T00:00:00Z', data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function lastCall() {
  const allCalls = vi.mocked(fetch).mock.calls;
  const call = allCalls[allCalls.length - 1];
  return { url: String(call[0]), init: (call[1] ?? {}) as RequestInit };
}

describe('usuariosApi', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  describe('role mapping', () => {
    it('maps internal ↔ API roles', () => {
      expect(roleToApi('admin')).toBe('Administrador');
      expect(roleToApi('user')).toBe('Usuario');
      expect(roleFromApi('Administrador')).toBe('admin');
      expect(roleFromApi('Usuario')).toBe('user');
      expect(roleFromApi('desconocido')).toBe('none');
    });
  });

  describe('GET /usuarios (#5)', () => {
    it('lists users from the envelope data array', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        envelope([
          { usuario: 'A@X.com', contrasena: 'h', rol: 'Administrador', permisos: null, b_Activo: true },
          { usuario: 'b@x.com', contrasena: 'h', rol: 'Usuario', permisos: 'cxp,bancos', b_Activo: true },
        ]),
      );
      const users = await listUsuarios();
      expect(lastCall().url).toBe('/api/midas/usuarios');
      expect(users).toHaveLength(2);
      expect(users[0].usuario).toBe('a@x.com'); // normalizado
    });

    it('filters by email via ?usuario=', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        envelope([{ usuario: 'b@x.com', contrasena: 'h', rol: 'Usuario', permisos: 'cxp', b_Activo: true }]),
      );
      const found = await getUsuario('B@X.com');
      expect(lastCall().url).toBe('/api/midas/usuarios?usuario=b%40x.com');
      expect(found?.usuario).toBe('b@x.com');
    });

    it('maps a 500 to unknown', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(envelope(null, 500, 'boom'));
      await expect(listUsuarios()).rejects.toMatchObject({ code: 'unknown', status: 500 });
    });

    it('getUsuario NO cae a list[0] cuando el filtro regresa otro usuario', async () => {
      // Backend con filtro laxo/ignorado: la lista viene poblada pero SIN el
      // correo pedido. Regresar list[0] haría que los writes GET→PUT mutaran
      // la cuenta equivocada — debe ser null (no existe).
      vi.mocked(fetch).mockResolvedValueOnce(
        envelope([{ usuario: 'otro@x.com', contrasena: 'h', rol: 'Usuario', permisos: 'cxp', b_Activo: true }]),
      );
      await expect(getUsuario('buscado@x.com')).resolves.toBeNull();
    });

    it('trata HTTP 2xx con success:false como error, no como éxito', async () => {
      // Sobre .NET: fallo lógico reportado con HTTP 200. Leerlo como éxito
      // haría pasar por aplicado un PUT rechazado.
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: 404, success: false, message: 'El usuario no existe.', date: 'x', data: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      await expect(listUsuarios()).rejects.toMatchObject({ code: 'not_found', status: 404 });
    });
  });

  describe('POST /usuarios (#6) — alta', () => {
    it('sends the hashed password + CSV permissions for a user', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(envelope({ usuario: 'b@x.com', contrasena: 'HASH', rol: 'Usuario', permisos: 'cxp,bancos', b_Activo: true }, 201));
      await createUsuario({ usuario: 'B@X.com', contrasena: 'HASH', role: 'user', permissions: ['cxp', 'bancos'] });
      const { url, init } = lastCall();
      expect(url).toBe('/api/midas/usuarios');
      expect(init.method).toBe('POST');
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({ usuario: 'b@x.com', contrasena: 'HASH', rol: 'Usuario', permisos: 'cxp,bancos', b_Activo: true });
    });

    it('sends null permissions for an admin', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(envelope({ usuario: 'a@x.com', contrasena: 'H', rol: 'Administrador', permisos: null, b_Activo: true }, 201));
      await createUsuario({ usuario: 'a@x.com', contrasena: 'H', role: 'admin' });
      expect(JSON.parse(String(lastCall().init.body)).permisos).toBeNull();
    });

    it('maps a 406 to duplicate', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(envelope(null, 406, "El usuario 'x' ya existe."));
      await expect(
        createUsuario({ usuario: 'x@x.com', contrasena: 'H', role: 'user' }),
      ).rejects.toMatchObject({ code: 'duplicate', status: 406 });
    });
  });

  describe('PUT /usuarios (#8) — modifica', () => {
    it('sends the complete record (echoing the stored hash preserves it)', async () => {
      const record: UsuarioApi = { usuario: 'b@x.com', contrasena: 'STORED_HASH', rol: 'Usuario', permisos: 'cxp', b_Activo: true };
      vi.mocked(fetch).mockResolvedValueOnce(envelope(record));
      await updateUsuario({ ...record, permisos: 'cxp,taxes' });
      const { url, init } = lastCall();
      expect(url).toBe('/api/midas/usuarios');
      expect(init.method).toBe('PUT');
      const body = JSON.parse(String(init.body));
      expect(body.contrasena).toBe('STORED_HASH');
      expect(body.permisos).toBe('cxp,taxes');
    });

    it('maps a 404 to not_found', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(envelope(null, 404, 'no existe'));
      await expect(
        updateUsuario({ usuario: 'x@x.com', contrasena: 'H', rol: 'Usuario', permisos: null, b_Activo: true }),
      ).rejects.toMatchObject({ code: 'not_found', status: 404 });
    });
  });

  describe('DELETE /usuarios/{usuario} (#7) — baja', () => {
    it('encodes the email in the path', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(envelope(null));
      await deleteUsuario('Carlos.Ortiz@gruposenda.com');
      const { url, init } = lastCall();
      expect(url).toBe('/api/midas/usuarios/carlos.ortiz%40gruposenda.com');
      expect(init.method).toBe('DELETE');
    });

    it('maps a 404 to not_found', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(envelope(null, 404));
      await expect(deleteUsuario('x@x.com')).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  describe('POST /usuarios/validate (#4) — login', () => {
    it('returns the mapped identity + permissions on success', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        envelope({ usuario: 'b@x.com', rol: 'Usuario', permisos: 'cxp,bancos', b_Activo: true }),
      );
      const validated = await validateUsuario('B@X.com', 'HASHED');
      const { url, init } = lastCall();
      expect(url).toBe('/api/midas/usuarios/validate');
      expect(JSON.parse(String(init.body))).toEqual({ usuario: 'b@x.com', contrasena: 'HASHED' });
      expect(validated).toEqual({ usuario: 'b@x.com', role: 'user', permissions: ['cxp', 'bancos'], activo: true });
    });

    it('admin validate returns empty permissions', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(envelope({ usuario: 'a@x.com', rol: 'Administrador', permisos: null, b_Activo: true }));
      const validated = await validateUsuario('a@x.com', 'H');
      expect(validated.role).toBe('admin');
      expect(validated.permissions).toEqual([]);
    });

    it('maps 401 (bad credentials / inactive) to invalid_credentials', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(envelope(null, 401));
      await expect(validateUsuario('a@x.com', 'H')).rejects.toMatchObject({ code: 'invalid_credentials', status: 401 });
    });

    it('maps 400 / 422 to validation', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(envelope(null, 400, 'datos malos'));
      await expect(validateUsuario('a@x.com', 'H')).rejects.toMatchObject({ code: 'validation', status: 400 });
      vi.mocked(fetch).mockResolvedValueOnce(envelope(null, 422));
      await expect(validateUsuario('a@x.com', 'H')).rejects.toMatchObject({ code: 'validation', status: 422 });
    });
  });

  it('maps a network failure (fetch throws) to network', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('socket'));
    await expect(listUsuarios()).rejects.toMatchObject({ code: 'network', status: 0 });
    await expect(listUsuarios()).rejects.toBeInstanceOf(AuthApiError);
  });
});
