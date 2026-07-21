import { describe, expect, it } from 'vitest';
import { resolveVersion } from './resolveVersion.mjs';

describe('resolveVersion', () => {
  it('produces a MAJOR.MINOR.<patch> version string', () => {
    const version = resolveVersion();
    // Con git: `MAJOR.MINOR.<#PRs>`. Sin git: la versión de package.json (semver).
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is deterministic within a run', () => {
    expect(resolveVersion()).toBe(resolveVersion());
  });
});
