import { describe, expect, it } from 'vitest';
import { MIDAS_STORAGE_REGISTRY, MIDAS_INDEXED_DB_NAMES } from './storageRegistry';

// ─────────────────────────────────────────────────────────────────────────
// Guardrail data-driven (patrón providerCategoryGeneralization.test.ts):
// recorre TODO el código fuente y verifica que cada key `midas.*` usada como
// literal esté registrada en MIDAS_STORAGE_REGISTRY. La regla del registro
// ("si agregas una key nueva, regístrala en el mismo PR") deja de depender de
// disciplina manual — una key nueva sin registrar rompe este test.
//
// El escaneo usa `import.meta.glob` (?raw) en vez de `node:fs` para no meter
// `@types/node` al tsconfig (sus globals chocan con los del DOM).
// ─────────────────────────────────────────────────────────────────────────

const SOURCE_FILES = import.meta.glob<string>(
  ['../**/*.ts', '../**/*.tsx', '!../**/*.test.ts', '!../**/*.test.tsx'],
  { query: '?raw', import: 'default', eager: true },
);

/**
 * Extrae literales de string con forma de key del namespace dotted `midas.`
 * (ahí es donde se acuñan keys nuevas de localStorage). Los stores legacy
 * `midas-v*`/`flowsense*` no usan punto y tienen su ciclo de vida cerrado en
 * persistence.ts, así que no se escanean.
 */
function extractMidasKeys(source: string): string[] {
  const out: string[] = [];
  const re = /['"`](midas\.[A-Za-z0-9._-]+)['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  return out;
}

/**
 * Literales que PARECEN keys del namespace pero no son persistencia:
 *   - midas.local.auth.v1 — es el SALT del hash de contraseñas del modo auth
 *     local (vive en el JSON de config, citado en comentarios de localAuth.ts).
 */
const NOT_STORAGE_KEYS = new Set(['midas.local.auth.v1']);

const registeredExact = new Set(
  MIDAS_STORAGE_REGISTRY.filter((e) => !e.key.endsWith('.*')).map((e) => e.key),
);
const registeredPrefixes = MIDAS_STORAGE_REGISTRY
  .filter((e) => e.key.endsWith('.*'))
  .map((e) => e.key.slice(0, -2));

function isRegistered(key: string): boolean {
  if (NOT_STORAGE_KEYS.has(key)) return true;
  if (registeredExact.has(key)) return true;
  return registeredPrefixes.some(
    (prefix) => key === prefix || key.startsWith(`${prefix}.`),
  );
}

describe('storageRegistry — inventario de persistencia', () => {
  it('toda key midas.* usada en src/ está registrada en MIDAS_STORAGE_REGISTRY', () => {
    expect(Object.keys(SOURCE_FILES).length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(SOURCE_FILES)) {
      for (const key of extractMidasKeys(source)) {
        if (!isRegistered(key)) {
          offenders.push(`${key} (${file})`);
        }
      }
    }
    expect(
      offenders,
      'Keys midas.* sin registrar en src/domain/storageRegistry.ts — '
      + 'agrégalas al registro en este mismo PR (regla del inventario):\n'
      + offenders.join('\n'),
    ).toEqual([]);
  });

  it('el registro no tiene keys duplicadas', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const entry of MIDAS_STORAGE_REGISTRY) {
      if (seen.has(entry.key)) dupes.push(entry.key);
      seen.add(entry.key);
    }
    expect(dupes).toEqual([]);
  });

  it('toda entrada tiene dueño y descripción no vacíos', () => {
    for (const entry of MIDAS_STORAGE_REGISTRY) {
      expect(entry.owner.trim(), `owner vacío en ${entry.key}`).not.toBe('');
      expect(entry.description.trim(), `description vacía en ${entry.key}`).not.toBe('');
    }
  });

  it('MIDAS_INDEXED_DB_NAMES refleja exactamente las entradas indexedDB del registro', () => {
    const fromRegistry = MIDAS_STORAGE_REGISTRY
      .filter((e) => e.scope === 'indexedDB')
      .map((e) => e.key);
    expect(MIDAS_INDEXED_DB_NAMES).toEqual(fromRegistry);
  });
});
