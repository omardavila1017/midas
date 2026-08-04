/**
 * Escribe el número de PR en `version.json` (la fuente única de la versión del
 * login — ver `scripts/resolveVersion.mjs`).
 *
 * Orden de resolución del número:
 *   1. `--pr N` / primer argumento posicional.
 *   2. `PR_NUMBER` del entorno (lo que usa `sync.yml` en el deploy).
 *   3. El sujeto del commit HEAD (`Merge pull request #N …` / `fix: x (#N)`).
 *   4. `gh pr view --json number` (el PR de la rama actual).
 *
 * Uso:  npm run version:pr            → resuelve solo
 *       npm run version:pr -- --pr 259
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

import { VERSION_FILE, parsePrNumber } from './resolveVersion.mjs';

function fromArgs(argv) {
  const flagIndex = argv.indexOf('--pr');
  if (flagIndex !== -1) return parsePrNumber(`#${argv[flagIndex + 1]}`);
  return parsePrNumber(`#${argv.find((arg) => /^\d+$/.test(arg)) ?? ''}`);
}

function fromCommand(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

export function resolvePrNumber(argv = [], env = {}) {
  return (
    fromArgs(argv) ??
    parsePrNumber(`#${env.PR_NUMBER ?? ''}`) ??
    parsePrNumber(fromCommand('git log -1 --pretty=%s')) ??
    parsePrNumber(fromCommand('gh pr view --json number --jq .number').replace(/^/, '#'))
  );
}

/** Reescribe SOLO la llave `pr`, preservando el resto del archivo (el `_comment`). */
export function writeVersionPr(pr, file = VERSION_FILE) {
  let current = {};
  try {
    current = JSON.parse(readFileSync(file, 'utf8')) ?? {};
  } catch {
    current = {};
  }
  const next = { ...current, pr };
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const pr = resolvePrNumber(process.argv.slice(2), process.env);
  if (pr === null) {
    process.stderr.write('No se pudo resolver el número de PR. Usa: npm run version:pr -- --pr 259\n');
    process.exit(1);
  }
  writeVersionPr(pr);
  process.stdout.write(`version.json → pr ${pr}\n`);
}
