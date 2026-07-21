import { describe, expect, it } from 'vitest';
import { hashPassword, sha256Hex } from './passwordHash';

describe('passwordHash', () => {
  it('produces the SHA-256 hex of the migration password (contract vector)', async () => {
    // SHA-256("Senda123") documentado en el contrato del backend (ef7b600a…c655ec68).
    await expect(sha256Hex('Senda123')).resolves.toBe(
      'ef7b600a043b3ec3df79cdc20597df1763529d7b38a33368d9fe0bb3c655ec68',
    );
  });

  it('returns 64 lowercase hex chars', async () => {
    const hash = await hashPassword('un-Password-cualquiera!42');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic and distinct per input', async () => {
    const a = await sha256Hex('abc');
    const b = await sha256Hex('abc');
    const c = await sha256Hex('abd');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
