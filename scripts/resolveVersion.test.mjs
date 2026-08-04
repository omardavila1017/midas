import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  latestPrFromGit,
  parsePrNumber,
  readPrFromVersionFile,
  resolveVersion,
} from './resolveVersion.mjs';
import { resolvePrNumber, writeVersionPr } from './setVersionPr.mjs';

const root = mkdtempSync(join(tmpdir(), 'resolve-version-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('resolveVersion', () => {
  it('produces MAJOR.<#PR> — el número visible es el del PR, no un conteo', () => {
    // El login pinta `V${resolveVersion()}` → `V1.259`.
    expect(resolveVersion()).toMatch(/^\d+\.\d+$/);
  });

  it('is deterministic within a run', () => {
    expect(resolveVersion()).toBe(resolveVersion());
  });
});

describe('parsePrNumber', () => {
  it('lee el PR de un merge commit y de un squash', () => {
    expect(parsePrNumber('Merge pull request #258 from santiagomlr/rama')).toBe(258);
    expect(parsePrNumber('fix(citi): el desglose por factura (#257)')).toBe(257);
  });

  it('regresa null cuando no hay número (nunca inventa una versión)', () => {
    for (const input of ['Sync desde flujo-senda main', '', undefined, '#0', '#abc']) {
      expect(parsePrNumber(input)).toBeNull();
    }
  });
});

describe('readPrFromVersionFile — la fuente autoritativa', () => {
  it('lee `pr` y rechaza un archivo inválido, ausente o con pr no positivo', () => {
    const ok = join(root, 'version.ok.json');
    writeFileSync(ok, JSON.stringify({ pr: 259, _comment: 'x' }));
    expect(readPrFromVersionFile(ok)).toBe(259);

    const bad = join(root, 'version.bad.json');
    writeFileSync(bad, 'no soy json');
    expect(readPrFromVersionFile(bad)).toBeNull();

    const zero = join(root, 'version.zero.json');
    writeFileSync(zero, JSON.stringify({ pr: 0 }));
    expect(readPrFromVersionFile(zero)).toBeNull();

    expect(readPrFromVersionFile(join(root, 'no-existe.json'))).toBeNull();
  });
});

describe('latestPrFromGit — fallback SOLO con historial', () => {
  it('regresa null donde no hay repo git (el caso del deploy por rsync)', () => {
    // Es justo el escenario del servidor: sin `.git` la versión DEBE salir de
    // version.json, no de un cálculo que se congelaría.
    expect(latestPrFromGit(root)).toBeNull();
  });
});

describe('setVersionPr', () => {
  it('prioriza --pr sobre el entorno y preserva el resto del archivo', () => {
    expect(resolvePrNumber(['--pr', '300'], { PR_NUMBER: '111' })).toBe(300);
    expect(resolvePrNumber([], { PR_NUMBER: '111' })).toBe(111);

    const file = join(root, 'version.write.json');
    writeFileSync(file, JSON.stringify({ pr: 1, _comment: 'no me borres' }));
    expect(writeVersionPr(259, file)).toEqual({ pr: 259, _comment: 'no me borres' });
    expect(readPrFromVersionFile(file)).toBe(259);
  });
});
