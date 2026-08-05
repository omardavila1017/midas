/**
 * Setup global de la suite.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 * Node 26 define un `localStorage` / `sessionStorage` GLOBAL propio (Web Storage
 * experimental) que **devuelve `undefined`** cuando no se arrancó con
 * `--localstorage-file`:
 *
 *   ExperimentalWarning: localStorage is not available because
 *   --localstorage-file was not provided.
 *
 * Ese global TAPA el que provee jsdom (medido: `typeof localStorage` →
 * `'undefined'` y `window.localStorage` → `undefined` dentro del entorno jsdom
 * de Vitest). Resultado: **333 tests de 40 archivos** fallaban con
 * `Cannot read properties of undefined (reading 'clear'/'setItem'/'getItem')`
 * — no por el código de Midas, sino por la versión de Node. El baseline verde
 * dejaba de ser reproducible según la máquina.
 *
 * ── Por qué se monta sobre `Storage.prototype` y no como objeto suelto ──────
 * Vitest copia las props de la Window de jsdom al global, así que NO queda un
 * getter de `Window.prototype` del cual recuperar la Storage original. Pero la
 * clase `Storage` de jsdom sí está disponible. Se implementa sobre su
 * `prototype` con estado por instancia (WeakMap) para que la Storage resultante
 * sea `instanceof Storage` y los tests que hacen
 * `vi.spyOn(Storage.prototype, 'setItem')` sigan interceptando — hay al menos
 * uno que depende de eso (`persistence.test.ts`, el de QuotaExceeded).
 *
 * `setupFiles` corre una vez por ARCHIVO de test, así que cada archivo arranca
 * con storage limpio — la misma semántica que da jsdom.
 */

type Store = Map<string, string>;

const STATE = new WeakMap<object, Store>();

function stateOf(instance: object): Store {
  let s = STATE.get(instance);
  if (!s) {
    s = new Map<string, string>();
    STATE.set(instance, s);
  }
  return s;
}

/** ¿La Storage presente responde a la interfaz que usa la app? */
function isUsable(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== 'object') return false;
  const s = candidate as Record<string, unknown>;
  return typeof s.getItem === 'function'
    && typeof s.setItem === 'function'
    && typeof s.removeItem === 'function'
    && typeof s.clear === 'function';
}

/**
 * Instala la implementación en memoria sobre `Storage.prototype`. Idempotente:
 * se marca con un símbolo para no reinstalar si ya corrió en este realm.
 */
// Sin prefijo `midas.` a propósito: `storageRegistry.test.ts` escanea src/ por
// literales `midas.*` y exigiría registrar este símbolo como key de storage.
const INSTALLED = Symbol.for('midasTestStorageInstalled');

function installOnStoragePrototype(StorageCtor: { prototype: object }): void {
  const proto = StorageCtor.prototype as Record<string | symbol, unknown>;
  if (proto[INSTALLED]) return;

  Object.defineProperties(proto, {
    getItem: {
      configurable: true, writable: true,
      value(this: object, key: string) {
        const v = stateOf(this).get(String(key));
        return v === undefined ? null : v;
      },
    },
    setItem: {
      configurable: true, writable: true,
      value(this: object, key: string, value: string) {
        stateOf(this).set(String(key), String(value));
      },
    },
    removeItem: {
      configurable: true, writable: true,
      value(this: object, key: string) {
        stateOf(this).delete(String(key));
      },
    },
    clear: {
      configurable: true, writable: true,
      value(this: object) {
        stateOf(this).clear();
      },
    },
    key: {
      configurable: true, writable: true,
      value(this: object, index: number) {
        return Array.from(stateOf(this).keys())[index] ?? null;
      },
    },
    length: {
      configurable: true,
      get(this: object) {
        return stateOf(this).size;
      },
    },
    [INSTALLED]: { value: true, configurable: true },
  });
}

function ensureStorage(name: 'localStorage' | 'sessionStorage'): void {
  const g = globalThis as unknown as Record<string, unknown>;
  // Leer el global de Node puede emitir el ExperimentalWarning; envolver para
  // que un getter que tire no rompa el setup.
  let current: unknown;
  try {
    current = g[name];
  } catch {
    current = undefined;
  }
  if (isUsable(current)) return;

  const StorageCtor = g.Storage as { prototype?: object } | undefined;
  let storage: object;
  const proto = StorageCtor?.prototype;
  if (proto && typeof proto === 'object') {
    installOnStoragePrototype({ prototype: proto });
    storage = Object.create(proto) as object;
  } else {
    // Sin la clase `Storage` (Node puro, sin jsdom) montamos un objeto suelto:
    // no hay prototipo que espiar, pero la interfaz queda completa.
    const own = {};
    installOnStoragePrototype({ prototype: own });
    storage = Object.create(own) as object;
  }
  // Materializa el estado ya, para que dos lecturas no creen Maps distintos.
  stateOf(storage);

  const define = (obj: Record<string, unknown>) => {
    Object.defineProperty(obj, name, {
      value: storage, configurable: true, writable: true, enumerable: false,
    });
  };
  define(g);
  // En jsdom `window` y `globalThis` suelen ser el mismo objeto, pero no se
  // asume: si son distintos, ambos deben ver la misma Storage.
  const w = (g as { window?: Record<string, unknown> }).window;
  if (w && w !== g) define(w);
}

ensureStorage('localStorage');
ensureStorage('sessionStorage');
