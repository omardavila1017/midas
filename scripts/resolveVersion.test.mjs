import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { countMergedPrs, resolveVersion } from './resolveVersion.mjs';

describe('resolveVersion', () => {
  it('produces a MAJOR.MINOR.<patch> version string', () => {
    const version = resolveVersion();
    // Con git: `MAJOR.MINOR.<#PRs>`. Sin git: la versión de package.json (semver).
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is deterministic within a run', () => {
    expect(resolveVersion()).toBe(resolveVersion());
  });

  describe('countMergedPrs — clon shallow', () => {
    const root = mkdtempSync(join(tmpdir(), 'resolve-version-'));
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    const git = (cwd, cmd) =>
      execSync(`git ${cmd}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

    it('cuenta merges en un repo completo y regresa null en un clon shallow', () => {
      // Repo con 1 merge real.
      const full = join(root, 'full');
      execSync(`mkdir -p ${JSON.stringify(full)}`);
      git(full, 'init -q -b main');
      git(full, 'config user.email t@t');
      git(full, 'config user.name t');
      writeFileSync(join(full, 'a.txt'), 'a');
      git(full, 'add . && git commit -q -m a');
      git(full, 'checkout -q -b feature');
      writeFileSync(join(full, 'b.txt'), 'b');
      git(full, 'add . && git commit -q -m b');
      git(full, 'checkout -q main');
      writeFileSync(join(full, 'c.txt'), 'c');
      git(full, 'add . && git commit -q -m c');
      git(full, 'merge -q --no-ff -m merge feature');
      expect(countMergedPrs(full)).toBe(1);

      // Clon shallow del mismo repo: `git rev-list` NO falla — regresa un
      // conteo subcontado. Debe detectarse y regresar null (fallback a la
      // versión de package.json), no embarcar el número mentiroso.
      const shallow = join(root, 'shallow');
      execSync(
        `git clone -q --depth 1 file://${full} ${JSON.stringify(shallow)}`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      expect(countMergedPrs(shallow)).toBeNull();
    });
  });
});
