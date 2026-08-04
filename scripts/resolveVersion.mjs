/**
 * Versión de la app mostrada en el login: `MAJOR.<#PR>` (se pinta como `V1.259`).
 *
 * FUENTE ÚNICA: `version.json` en la raíz (`{ "pr": N }`), un archivo COMMITEADO.
 * NO se deriva de git A PROPÓSITO: el deploy real se alimenta con
 * `rsync --exclude='.git'` (ver `.github/workflows/sync.yml`), así que en el
 * servidor NO existe historial — cualquier cálculo desde git cae ahí a un
 * fallback CONSTANTE y la versión nunca cambia en el navegador del usuario.
 * Ese fue exactamente el defecto vivo (el login clavado en `1.0.0`).
 *
 * Cómo se mantiene actualizado sin intervención humana:
 *   - Deploy: `sync.yml` resuelve el PR del merge que disparó el push y reescribe
 *     `version.json` ANTES del rsync (`scripts/setVersionPr.mjs`).
 *   - Local / manual: `npm run version:pr`.
 *
 * Se consume desde `vite.config.ts` (define `__APP_VERSION__`) y es ejecutable:
 *   node scripts/resolveVersion.mjs   → imprime la versión resuelta.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '..');
export const VERSION_FILE = join(repoRoot, 'version.json');

function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function majorOf(version) {
  const [major = '0'] = version.split('.');
  return major;
}

/** Extrae el número de PR de un texto: `Merge pull request #258 …` o `fix: x (#258)`. */
export function parsePrNumber(text) {
  const match = /#(\d+)/.exec(typeof text === 'string' ? text : '');
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Lee el PR de `version.json`. Es la fuente autoritativa. */
export function readPrFromVersionFile(file = VERSION_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const pr = typeof parsed?.pr === 'number' ? parsed.pr : Number.parseInt(parsed?.pr, 10);
    return Number.isInteger(pr) && pr > 0 ? pr : null;
  } catch {
    return null;
  }
}

/**
 * Fallback SOLO para un clon con historial (dev local con `version.json` stale):
 * el PR del commit más reciente que lo declare en su sujeto. En el servidor
 * regresa null — ahí manda `version.json`.
 */
export function latestPrFromGit(cwd = repoRoot) {
  try {
    const out = execSync('git log -n 200 --pretty=%s', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const subject of out.split('\n')) {
      const pr = parsePrNumber(subject);
      if (pr !== null) return pr;
    }
    return null;
  } catch {
    return null;
  }
}

export function resolveVersion() {
  const packageVersion = readPackageVersion();
  const pr = readPrFromVersionFile() ?? latestPrFromGit();
  // Sin PR resoluble: la versión de package.json tal cual. Se ve distinta a
  // propósito (`V1.0.0`) — nunca se inventa un número que parezca un PR.
  if (pr === null) return packageVersion;
  return `${majorOf(packageVersion)}.${pr}`;
}

// Ejecución directa desde CLI.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${resolveVersion()}\n`);
}
