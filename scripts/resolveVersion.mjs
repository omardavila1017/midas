/**
 * Versión automática de la app para el login: `MAJOR.MINOR.<#PRs>`.
 *
 *   - `MAJOR.MINOR` = línea de release, leída de `package.json` (solo cambia con
 *     un salto deliberado).
 *   - `<#PRs>` (patch) = número de PRs mergeados = `git rev-list --count --merges HEAD`.
 *     Cada PR incrementa el patch automáticamente, sin mantenimiento manual.
 *
 * Requisito de despliegue: el pipeline necesita el HISTORIAL GIT COMPLETO
 * (`fetch-depth: 0`) para contar bien los PRs. Un clon shallow subcontaría; sin
 * `.git` disponible, cae a la versión completa de `package.json`.
 *
 * Se consume desde `vite.config.ts` (define `__APP_VERSION__`) y es ejecutable:
 *   node scripts/resolveVersion.mjs   → imprime la versión resuelta.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(scriptDir, '..', 'package.json');

function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    return typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function majorMinor(version) {
  const [major = '0', minor = '0'] = version.split('.');
  return `${major}.${minor}`;
}

function countMergedPrs() {
  try {
    const out = execSync('git rev-list --count --merges HEAD', {
      cwd: join(scriptDir, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const parsed = Number.parseInt(out, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function resolveVersion() {
  const packageVersion = readPackageVersion();
  const prs = countMergedPrs();
  // Sin git (shallow / sin `.git`): fallback a la versión de package.json.
  if (prs === null) return packageVersion;
  return `${majorMinor(packageVersion)}.${prs}`;
}

// Ejecución directa desde CLI.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${resolveVersion()}\n`);
}
