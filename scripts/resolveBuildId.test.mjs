import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveBuildId } from './resolveBuildId.mjs';

describe('resolveBuildId', () => {
  const root = mkdtempSync(join(tmpdir(), 'resolve-build-id-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function seed(name) {
    const dir = join(root, name);
    mkdirSync(join(dir, 'src', 'domain'), { recursive: true });
    writeFileSync(join(dir, 'src', 'domain', 'engine.ts'), 'export const rate = 1;\n');
    writeFileSync(join(dir, 'package.json'), '{"name":"midas","version":"1.0.0"}\n');
    writeFileSync(join(dir, 'index.html'), '<div id="root"></div>\n');
    return dir;
  }

  it('es estable para el mismo código', () => {
    const dir = seed('stable');
    expect(resolveBuildId(dir)).toBe(resolveBuildId(dir));
  });

  it('cambia cuando cambia el código fuente — el contrato que hace inválida la cache pre-fix', () => {
    const dir = seed('changed');
    const before = resolveBuildId(dir);
    writeFileSync(join(dir, 'src', 'domain', 'engine.ts'), 'export const rate = 2;\n');
    expect(resolveBuildId(dir)).not.toBe(before);
  });

  it('NO cambia por editar un test (no viaja al bundle)', () => {
    const dir = seed('tests');
    const before = resolveBuildId(dir);
    writeFileSync(join(dir, 'src', 'domain', 'engine.test.ts'), 'it("x", () => {});\n');
    expect(resolveBuildId(dir)).toBe(before);
  });

  it('distingue dos árboles con el mismo contenido en rutas distintas', () => {
    const a = seed('path-a');
    const b = seed('path-b');
    mkdirSync(join(b, 'src', 'services'), { recursive: true });
    writeFileSync(join(b, 'src', 'services', 'engine.ts'), 'export const rate = 1;\n');
    expect(resolveBuildId(a)).not.toBe(resolveBuildId(b));
  });

  it('sin árbol legible cae a un id por tiempo — invalida de más, nunca de menos', () => {
    const missing = join(root, 'no-existe');
    const first = resolveBuildId(missing);
    expect(first).toMatch(/^t[0-9a-z]+$/);
  });
});
