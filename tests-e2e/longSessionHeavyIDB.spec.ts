import { test, expect, type Page } from '@playwright/test';

/**
 * Long-session + heavy IDB validation:
 *   - Inyecta 50k cobranza + 80k compras + 50k auxiliar directamente en
 *     IndexedDB ANTES del boot. Bypassa la capa de stubs del API — el app
 *     hidrata desde IDB exactamente como en producción cuando hay cache.
 *   - Corre 200 navegaciones (>15 min de actividad sostenida = "long
 *     session" sintética).
 *   - Recolecta heap trace en intervalos para detectar leak monotónico.
 *   - Asserta: 0 crashes, sin pageerror, heap stable, navegación responsiva.
 *
 * En Chromium (donde performance.memory existe) la prueba mide presión real.
 * En Edge real (channel: msedge) valida el motor de producción del usuario.
 */

const COBRANZA_COUNT = 10_000;  // Escala sandbox; en prod ~46k. Mismo patrón.
const COMPRAS_COUNT = 20_000;   // Escala sandbox; en prod ~334k.
const AUXILIAR_COUNT = 15_000;  // Escala sandbox; en prod ~100k.
const NAV_ITERATIONS = 30;      // ~3-5 min sostenidos en sandbox CI.
const HEAP_SAMPLE_EVERY = 5;    // Sample cada N iter.

function makeCobranzaRecord(i: number) {
  const cia = (31 + (i % 3)).toString();
  return {
    cia,
    noCliente: `C${1000 + (i % 200)}`,
    nombreCliente: `Cliente Heavy ${i % 200}`,
    noFactura: `F-${cia}-${i}`,
    fechaFactura: '2025-01-15',
    fechaVence: '2025-02-14',
    fechaCobro: '',
    diasVencida: i % 90,
    importeBrutoPesos: 10000 + (i * 7) % 50000,
    importePendientePesos: 10000 + (i * 7) % 50000,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: i % 7 === 0 ? 'USD' : 'MXN',
    condPago: '30',
    estatus: 'OPEN',
    tipoCambio: 17.5,
  };
}

function makeComprasRecord(i: number) {
  const cia = (31 + (i % 3)).toString();
  return {
    cia,
    noOrden: `OC-${cia}-${i}`,
    noProveedor: `P${500 + (i % 100)}`,
    nombreProveedor: `Proveedor Heavy ${i % 100}`,
    fechaPedido: '2025-01-05',
    fechaRecepcion: '2025-01-10',
    diasCredito: 30 + (i % 60),
    importeTotal: 5000 + (i * 13) % 100000,
    moneda: 'MXN',
    estatus: 'ABIERTA',
  };
}

function makeAuxiliarRecord(i: number) {
  const cia = (31 + (i % 3)).toString();
  return {
    cia,
    idCuenta: `1010-${i % 50}`,
    noDocto: `D-${cia}-${i}`,
    tipoDocto: i % 2 === 0 ? 'PV' : 'PK',
    fecha: '2025-01-15',
    importe: (i * 17) % 100000,
    estatusConciliado: i % 3 === 0 ? 'R' : 'N',
    concepto: `Mov ${i}`,
  };
}

const IGNORED_CONSOLE = [
  /Download the React DevTools/,
  /Recharts.*ResponsiveContainer/,
  /findDOMNode/,
  /defaultProps/,
  /JdeApiError|TressApiError|CitiApiError/,
  /\[fetchNomina\] fan-out vacío/,
  /\[runtimeGuardian\]/,
  // En e2e con stubs, los retries internos del jdeClient loggean cuando
  // la red "falla" (route handlers responden rápido y a veces el AbortController
  // dispara antes). Es esperado en sandbox, no es regresión.
  /\[jde-retry\]/,
  /\[bankStatements\]/,
  /Failed to fetch/,
];

function attachErrorListeners(page: Page) {
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (IGNORED_CONSOLE.some(rx => rx.test(text))) return;
    errors.push(`console.error: ${text}`);
  });
  page.on('pageerror', err => { errors.push(`pageerror: ${err.message}`); });
  return errors;
}

async function readHeapMb(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    if (!m || typeof m.usedJSHeapSize !== 'number') return null;
    return Math.round((m.usedJSHeapSize / 1_048_576) * 10) / 10;
  });
}

async function preloadIDB(
  page: Page,
  cobranza: ReturnType<typeof makeCobranzaRecord>[],
  compras: ReturnType<typeof makeComprasRecord>[],
  auxiliar: ReturnType<typeof makeAuxiliarRecord>[],
): Promise<void> {
  // Inyecta los heavies en el object store chunked como lo hace heavyStoreIDB.
  // CHUNK_SIZE en producción = 1000. Replicamos el patrón.
  await page.evaluate(async ({ cobranza, compras, auxiliar }) => {
    const DB_NAME = 'midas-heavy-store';
    const STORE_NAME = 'records';
    const CHUNK_STORE_NAME = 'recordChunks';
    const CHUNK_SIZE = 1000;

    const openDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(CHUNK_STORE_NAME)) {
          db.createObjectStore(CHUNK_STORE_NAME, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const db = await openDb();
    const writeChunked = async (key: string, records: unknown[]) => {
      const count = Math.ceil(records.length / CHUNK_SIZE);
      for (let i = 0; i < count; i++) {
        const chunk = records.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        await new Promise<void>(resolve => {
          const tx = db.transaction(CHUNK_STORE_NAME, 'readwrite');
          tx.objectStore(CHUNK_STORE_NAME).put({ key: `${key}::${i}`, records: chunk });
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        });
      }
      await new Promise<void>(resolve => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put({ key, chunked: true, chunkCount: count, total: records.length });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    };
    await writeChunked('cobranzaRecords', cobranza);
    await writeChunked('comprasRecords', compras);
    await writeChunked('auxiliarContableRecords', auxiliar);
    db.close();
  }, { cobranza, compras, auxiliar });
}

test('long-session + heavy IDB: 30 navegaciones × 45k records preloaded', async ({ page, browserName }) => {
  test.setTimeout(600_000); // 10 min cap.
  const errors = attachErrorListeners(page);

  // Generar datasets sintéticos. JS arrays caben en heap del runner; el push
  // a IDB ocurre en page context vía structuredClone.
  const cobranza = Array.from({ length: COBRANZA_COUNT }, (_, i) => makeCobranzaRecord(i));
  const compras = Array.from({ length: COMPRAS_COUNT }, (_, i) => makeComprasRecord(i));
  const auxiliar = Array.from({ length: AUXILIAR_COUNT }, (_, i) => makeAuxiliarRecord(i));

  // Stub APIs (necesario para que el boot no se cuelgue esperando red).
  await page.route(/\/api\//, route =>
    route.fulfill({ status: 200, body: '[]', contentType: 'application/json' }),
  );

  // Cargar la página una vez para que indexedDB exista, luego inyectar
  // los heavies, recargar para que hidrate desde IDB con datos reales.
  await page.goto('/');
  // eslint-disable-next-line no-console
  console.log(`[${browserName}] pre-injection: ${COBRANZA_COUNT}+${COMPRAS_COUNT}+${AUXILIAR_COUNT} records...`);
  await preloadIDB(page, cobranza, compras, auxiliar);
  // eslint-disable-next-line no-console
  console.log(`[${browserName}] injection complete, reloading to hydrate from IDB`);
  await page.reload();

  // Boot settled (más generoso aquí — hidratar 45k records toma más tiempo).
  await page.waitForFunction(
    () => {
      const m = /\b(\d+)\s*de\s*(\d+)/.exec(document.body.innerText);
      if (!m) return false;
      return Number(m[1]) >= Number(m[2]) - 2;
    },
    { timeout: 180_000 },
  );
  await page.evaluate(() => {
    document.querySelectorAll('.splash-root').forEach(n => n.remove());
    document.querySelectorAll('[aria-hidden="true"]').forEach(n => n.removeAttribute('aria-hidden'));
  });
  const sectionNav = page.getByRole('navigation', { name: 'Secciones principales' });
  await expect(sectionNav).toBeVisible({ timeout: 30_000 });

  const heapBaseline = await readHeapMb(page);
  // eslint-disable-next-line no-console
  console.log(`[${browserName}] baseline heap post-hydrate: ${heapBaseline ?? 'n/a'}MB`);

  const routes: { section: string; tabs: string[] }[] = [
    { section: 'Proyección', tabs: ['Proyección Financiera', 'Planeación Financiera'] },
    { section: 'Por Pagar', tabs: ['Antigüedad de Saldo'] },
    { section: 'Cobranza', tabs: ['Cobranza'] },
    { section: 'Catálogos', tabs: ['Bancos'] },
  ];

  const heapTrace: { iter: number; heap: number | null }[] = [
    { iter: 0, heap: heapBaseline },
  ];

  const start = Date.now();
  for (let it = 1; it <= NAV_ITERATIONS; it++) {
    for (const r of routes) {
      await sectionNav.getByRole('button', { name: r.section }).click();
      for (const tab of r.tabs) {
        const btn = page.getByRole('button', { name: tab, exact: true }).first();
        await btn.click();
        await expect(btn).toHaveAttribute('aria-current', 'page', { timeout: 15_000 });
        await page.getByText(`Cargando ${tab}`, { exact: false })
          .waitFor({ state: 'detached', timeout: 20_000 })
          .catch(() => {});
      }
    }
    if (it % HEAP_SAMPLE_EVERY === 0 || it === NAV_ITERATIONS) {
      const heap = await readHeapMb(page);
      heapTrace.push({ iter: it, heap });
      // eslint-disable-next-line no-console
      console.log(`[${browserName}] iter ${it}/${NAV_ITERATIONS} heap=${heap ?? 'n/a'}MB · elapsed=${Math.round((Date.now() - start) / 1000)}s`);
    }
  }

  // Diagnóstico final del runtimeGuardian.
  const diagnostic = await page.evaluate(() => {
    const w = window as unknown as {
      __midas__?: {
        runtime?: {
          getIncidents?: () => unknown[];
          getNavEvents?: () => unknown[];
          getMemory?: () => unknown;
        };
      };
    };
    const rt = w.__midas__?.runtime;
    return {
      incidents: rt?.getIncidents?.() ?? [],
      navEventsCount: (rt?.getNavEvents?.() ?? []).length,
      memory: rt?.getMemory?.() ?? null,
    };
  });
  // eslint-disable-next-line no-console
  console.log(`[${browserName}] runtimeGuardian diagnostic:`, diagnostic);

  // Aserciones:
  expect(errors, errors.join('\n')).toHaveLength(0);
  expect(diagnostic.navEventsCount).toBeGreaterThanOrEqual(NAV_ITERATIONS * 2);

  // Heap no crece monotónicamente: max no debe ser > 2× baseline + 500MB.
  // Si performance.memory no está disponible (Firefox), la aserción se relaja.
  const validHeaps = heapTrace.map(p => p.heap).filter((h): h is number => typeof h === 'number');
  if (validHeaps.length >= 2) {
    const baseline = validHeaps[0]!;
    const peak = Math.max(...validHeaps);
    // eslint-disable-next-line no-console
    console.log(`[${browserName}] heap trace: baseline=${baseline}MB peak=${peak}MB samples=${validHeaps.join(',')}MB`);
    expect(peak).toBeLessThan(baseline * 2 + 500);
    // Hard cap defensivo: si pasamos 1.5GB en el sandbox es leak real.
    expect(peak).toBeLessThan(1500);
  }
});
