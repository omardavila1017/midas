import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadClientsCatalog } from './loadClientsCatalog';

/**
 * B3.9 — el fetch del catálogo de clientes ya no se traga los fallos.
 * Un fallo real (red / 404 en todos los paths / JSON inválido) LANZA para que
 * el boot lo pueda distinguir de un catálogo legítimamente vacío; un catálogo
 * válido pero sin clientes regresa []. Además prueba paths candidatos en orden
 * (base configurado → root) para sobrevivir a un base mal configurado.
 */

const VALID_CATALOG = JSON.stringify({
  clientes: [
    { name: 'Cliente A', payDay: 'Viernes', cycle: 'Semanal', sales: 1000, creditDays: 30, active: true },
    { name: 'Cliente Inactivo', payDay: '15', cycle: 'Mensual', sales: 500, creditDays: 30, active: false },
  ],
});

function res(ok: boolean, text: string, status = ok ? 200 : 404): Response {
  return { ok, status, text: async () => text } as unknown as Response;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadClientsCatalog', () => {
  it('parses active clients from a valid catalog and skips inactive ones', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(true, VALID_CATALOG)));
    const clients = await loadClientsCatalog();
    expect(clients).toHaveLength(1);
    expect(clients[0].name).toBe('Cliente A');
  });

  it('throws when every candidate path fails with a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await expect(loadClientsCatalog()).rejects.toThrow();
  });

  it('throws when every candidate path returns a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(false, '<!doctype html>', 404)));
    await expect(loadClientsCatalog()).rejects.toThrow(/404/);
  });

  it('falls back to the next candidate path when the first one 404s', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith('/clientes-db.json') ? res(false, '', 404) : res(true, VALID_CATALOG),
    );
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const clients = await loadClientsCatalog();
    expect(clients).toHaveLength(1);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1); // probó más de un path
  });

  it('throws on invalid JSON (not a silent empty catalog)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(true, 'not json {')));
    await expect(loadClientsCatalog()).rejects.toThrow(/JSON inválido/);
  });

  it('throws when the payload lacks the "clientes" array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(true, JSON.stringify({ foo: 1 }))));
    await expect(loadClientsCatalog()).rejects.toThrow(/clientes/);
  });

  it('returns [] for a valid catalog with no active clients (empty is not an error)', async () => {
    const emptyish = JSON.stringify({
      clientes: [{ name: 'X', payDay: '', cycle: 'Mensual', sales: 0, creditDays: 0, active: false }],
    });
    vi.stubGlobal('fetch', vi.fn(async () => res(true, emptyish)));
    await expect(loadClientsCatalog()).resolves.toEqual([]);
  });
});
