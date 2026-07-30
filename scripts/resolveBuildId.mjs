/**
 * Huella de BUILD del código que entra al bundle: `sha256(src/** + configs)`.
 *
 * Para qué existe: el cache persistente de proyección (IndexedDB) guarda
 * SALIDAS del motor —movimientos ya prorrateados, corridas ya calculadas— bajo
 * una llave que sólo describe los INPUTS. Un fix del motor que cambia el número
 * sin cambiar el dato de origen deja vigente la entrada pre-fix, y el navegador
 * vuelve al número viejo en cuanto la cache resuelve. La llave necesita, por
 * tanto, un componente que cambie CON EL CÓDIGO.
 *
 * Por qué no `resolveVersion.mjs` (la versión del login): esa cuenta merges de
 * git y NO sirve aquí. El deploy real (`omardavila1017/midas`, rama `qa`) se
 * alimenta por `rsync --exclude='.git'` desde este repo, así que el historial
 * de git de este repo NO viaja: allá el conteo de merges es de OTRO repo y
 * queda congelado, y si además el build clona shallow, `resolveVersion` cae al
 * `version` de `package.json` — constante para siempre. Con eso, versionar la
 * cache por versión de app es inerte.
 *
 * Contrato de esta función, en cambio:
 *   1. Cambia SIEMPRE que cambia el código fuente (es un hash del contenido).
 *   2. NO cambia si el código es idéntico (un rebuild no tira la cache).
 *   3. NO depende de git, del CI, ni de que alguien recuerde subir una versión.
 *   4. Si algo falla al leer el árbol, cae a un id por TIEMPO — el fallback
 *      invalida de más, nunca de menos. Un fallback constante es justo el modo
 *      de falla que hay que evitar.
 *
 * Se consume desde `vite.config.ts` (define `__BUILD_ID__`) y es ejecutable:
 *   node scripts/resolveBuildId.mjs   → imprime el build id resuelto.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '..');

/** Raíces que se hornean en el bundle (además de los archivos sueltos). */
const SOURCE_DIRS = ['src'];
/** Archivos sueltos que cambian el output del build. */
const SOURCE_FILES = ['index.html', 'package.json', 'vite.config.ts', 'tailwind.config.js', 'postcss.config.js'];
/** Directorios que nunca entran al bundle. */
const SKIP_DIRS = new Set(['node_modules', '__tests__', '__snapshots__', 'mock-data']);
/** Los tests no viajan al bundle: incluirlos invalidaría la cache sin razón. */
const SKIP_FILE = /(\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?|\.d\.ts)$/;

function collectFiles(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectFiles(full, out);
    } else if (entry.isFile() && !SKIP_FILE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

export function resolveBuildId(root = repoRoot) {
  try {
    const files = [];
    for (const dir of SOURCE_DIRS) {
      const full = join(root, dir);
      if (statSync(full).isDirectory()) collectFiles(full, files);
    }
    for (const file of SOURCE_FILES) {
      try {
        if (statSync(join(root, file)).isFile()) files.push(join(root, file));
      } catch {
        // Un archivo opcional ausente no invalida la huella.
      }
    }
    if (files.length === 0) return timeBasedBuildId();
    const hash = createHash('sha256');
    // Ordenado por ruta relativa POSIX: el hash no depende del orden del FS ni
    // del separador de la plataforma (Windows corre este repo también).
    for (const file of files.sort()) {
      hash.update(relative(root, file).split(sep).join('/'));
      hash.update('\0');
      hash.update(readFileSync(file));
      hash.update('\0');
    }
    return hash.digest('hex').slice(0, 12);
  } catch {
    return timeBasedBuildId();
  }
}

/** Fallback que SIEMPRE cambia. Ver el punto 4 del contrato de arriba. */
function timeBasedBuildId() {
  return `t${Date.now().toString(36)}`;
}

// Ejecución directa desde CLI.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${resolveBuildId()}\n`);
}
