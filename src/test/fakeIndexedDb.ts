/**
 * IndexedDB fake mínimo en memoria para jsdom (sin dependencia nueva).
 * Cubre exactamente el subconjunto que usan heavyStoreIDB/dailyApiCache:
 * open (onupgradeneeded/onsuccess), objectStoreNames.contains,
 * createObjectStore(keyPath), transaction → objectStore → get/put/delete/
 * clear/getAll, requests con onsuccess/onerror y tx.oncomplete async.
 * Los callbacks se disparan en microtask (queueMicrotask) para simular la
 * asincronía real de IDB sin timers.
 */

type StoreData = Map<string, unknown>;

class FakeRequest<T = unknown> {
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
  onblocked: (() => void) | null = null;
  result!: T;
  error: unknown = null;
}

class FakeObjectStore {
  constructor(private data: StoreData, private keyPath: string, private tx: FakeTransaction) {}

  get(key: string): FakeRequest {
    const req = new FakeRequest();
    this.tx.enqueue(() => {
      req.result = this.data.get(key);
      req.onsuccess?.();
    });
    return req;
  }

  getAll(): FakeRequest<unknown[]> {
    const req = new FakeRequest<unknown[]>();
    this.tx.enqueue(() => {
      req.result = Array.from(this.data.values());
      req.onsuccess?.();
    });
    return req;
  }

  getAllKeys(): FakeRequest<string[]> {
    const req = new FakeRequest<string[]>();
    this.tx.enqueue(() => {
      req.result = Array.from(this.data.keys());
      req.onsuccess?.();
    });
    return req;
  }

  put(value: Record<string, unknown>): FakeRequest {
    const req = new FakeRequest();
    this.tx.enqueue(() => {
      this.data.set(String(value[this.keyPath]), value);
      req.onsuccess?.();
    });
    return req;
  }

  delete(key: string): FakeRequest {
    const req = new FakeRequest();
    this.tx.enqueue(() => {
      this.data.delete(key);
      req.onsuccess?.();
    });
    return req;
  }

  clear(): FakeRequest {
    const req = new FakeRequest();
    this.tx.enqueue(() => {
      this.data.clear();
      req.onsuccess?.();
    });
    return req;
  }
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private pending = 0;
  private settled = false;

  constructor(private db: FakeIDBDatabase) {
    // Sin operaciones encoladas, la tx igual completa (como IDB real).
    queueMicrotask(() => this.maybeComplete());
  }

  objectStore(name: string): FakeObjectStore {
    const data = this.db.stores.get(name);
    if (!data) throw new DOMException(`No store ${name}`, 'NotFoundError');
    return new FakeObjectStore(data, this.db.keyPaths.get(name) ?? 'key', this);
  }

  enqueue(op: () => void): void {
    this.pending++;
    queueMicrotask(() => {
      op();
      this.pending--;
      queueMicrotask(() => this.maybeComplete());
    });
  }

  private maybeComplete(): void {
    if (this.settled || this.pending > 0) return;
    this.settled = true;
    this.oncomplete?.();
  }
}

export class FakeIDBDatabase {
  stores = new Map<string, StoreData>();
  keyPaths = new Map<string, string>();

  objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };

  createObjectStore(name: string, opts?: { keyPath?: string }): void {
    this.stores.set(name, new Map());
    this.keyPaths.set(name, opts?.keyPath ?? 'key');
  }

  transaction(_names: string | string[], _mode?: string): FakeTransaction {
    return new FakeTransaction(this);
  }

  close(): void {
    /* noop */
  }
}

export class FakeIndexedDB {
  /** Bases por nombre — sobreviven entre open() para simular persistencia. */
  databases = new Map<string, FakeIDBDatabase>();
  /** Si true, open() dispara onerror (para probar el fallback). */
  failOpen = false;

  open(name: string, _version?: number): FakeRequest<FakeIDBDatabase> {
    const req = new FakeRequest<FakeIDBDatabase>();
    queueMicrotask(() => {
      if (this.failOpen) {
        req.error = new DOMException('denied', 'UnknownError');
        req.onerror?.();
        return;
      }
      let db = this.databases.get(name);
      const isNew = !db;
      if (!db) {
        db = new FakeIDBDatabase();
        this.databases.set(name, db);
      }
      req.result = db;
      if (isNew) req.onupgradeneeded?.();
      req.onsuccess?.();
    });
    return req;
  }

  deleteDatabase(name: string): FakeRequest {
    const req = new FakeRequest();
    queueMicrotask(() => {
      this.databases.delete(name);
      req.onsuccess?.();
    });
    return req;
  }
}

/** Instala un IndexedDB fake limpio en globalThis y lo regresa para inspección. */
export function installFakeIndexedDb(): FakeIndexedDB {
  const fake = new FakeIndexedDB();
  (globalThis as Record<string, unknown>).indexedDB = fake;
  return fake;
}

export function uninstallFakeIndexedDb(): void {
  delete (globalThis as Record<string, unknown>).indexedDB;
}
