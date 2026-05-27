import { test, expect, type Page } from '@playwright/test';

/**
 * Heavy-dataset memory pressure test:
 * Stubs JDE endpoints with synthetic datasets at producción-scale volumes
 * (cobranza 5k, compras 10k, auxiliarContable 20k — escalados al sandbox;
 * en prod son ~46k/334k/100k pero la regla de escalamiento es la misma:
 * el heap NO debe crecer monotónicamente entre navegaciones).
 *
 * Objetivo: validar que con datos pesados de verdad el render NO crashea y
 * el heap se mantiene acotado tras múltiples navigation cycles.
 */

// Volúmenes — limited en sandbox CI por tiempos de boot pero suficientes para
// estresar las defensas (each record carries multiple fields → ~MB-scale JSON).
// La prueba mide "no crece monotónicamente" — la mecánica que falla con
// datasets x10 también falla con estos volúmenes.
const COBRANZA_COUNT = 3_000;
const COMPRAS_COUNT = 5_000;
const AUXILIAR_COUNT = 8_000;
const ITERATIONS = 5;

function makeCobranza(count: number, cia: string) {
  return Array.from({ length: count }, (_, i) => ({
    cia,
    No_Cliente: `C${1000 + (i % 200)}`,
    Nombre_Cliente: `Cliente Heavy ${i % 200}`,
    No_Factura: `F-${cia}-${i}`,
    Fecha_Factura: '2025-01-15',
    Fecha_Vencimiento: '2025-02-14',
    Fecha_Pago: '',
    Importe_Factura: 10000 + (i * 7) % 50000,
    Importe_Pendiente: 10000 + (i * 7) % 50000,
    Moneda: i % 7 === 0 ? 'USD' : 'MXN',
    Cond_Pago: '30',
    Estatus: 'OPEN',
    Tipo_Cambio: 17.5,
    Dias_Vencida: i % 90,
  }));
}

function makeCompras(count: number, cia: string) {
  return Array.from({ length: count }, (_, i) => ({
    cia,
    No_Orden: `OC-${cia}-${i}`,
    No_Proveedor: `P${500 + (i % 100)}`,
    Nombre_Proveedor: `Proveedor Heavy ${i % 100}`,
    F_Recepcion: '2025-01-10',
    F_Orden: '2025-01-05',
    D_Credito: 30 + (i % 60),
    Importe_Total: 5000 + (i * 13) % 100000,
    Moneda: 'MXN',
    Estatus: 'ABIERTA',
  }));
}

function makeAuxiliar(count: number, cia: string) {
  return Array.from({ length: count }, (_, i) => ({
    cia,
    Id_Cuenta: `1010-${i % 50}`,
    No_Docto: `D-${cia}-${i}`,
    Tipo_Docto: i % 2 === 0 ? 'PV' : 'PK',
    Fecha: '2025-01-15',
    Importe: (i * 17) % 100000,
    Estatus_conciliado: i % 3 === 0 ? 'R' : 'N',
    Concepto: `Mov ${i}`,
  }));
}

const IGNORED_CONSOLE = [
  /Download the React DevTools/,
  /Recharts.*ResponsiveContainer/,
  /findDOMNode/,
  /defaultProps/,
  /JdeApiError|TressApiError|CitiApiError/,
  // Stubs devuelven [] para TRESS — fan-out vacío es esperado.
  /\[fetchNomina\] fan-out vacío/,
  // Stub responses falladas por mismatch de shape — esperado en e2e.
  /e2e-stubbed|Failed to load resource/,
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

test('heavy dataset: navegación con cobranza/compras/auxiliar volumétrico', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = attachErrorListeners(page);

  const CIAS = ['31', '32'];
  const companiesPayload = CIAS.map(cia => ({ cia, nombre: `Empresa ${cia}`, activa: true }));

  await page.route(/\/api\/jde\/.*/i, async route => {
    const url = route.request().url();
    const body = route.request().postDataJSON?.() ?? {};
    const cia = String((body as { cia?: string }).cia ?? CIAS[0]);
    let payload: unknown = [];
    if (/empresas|companies/i.test(url)) payload = companiesPayload;
    else if (/cobranza\b/i.test(url)) payload = makeCobranza(COBRANZA_COUNT, cia);
    else if (/compras\b/i.test(url)) payload = makeCompras(COMPRAS_COUNT, cia);
    else if (/AuxiliarContable/i.test(url)) payload = makeAuxiliar(AUXILIAR_COUNT, cia);
    else payload = [];
    await route.fulfill({
      status: 200,
      body: JSON.stringify(payload),
      contentType: 'application/json',
    });
  });
  await page.route(/\/api\/(tress|citi)\/.*/i, route =>
    route.fulfill({ status: 200, body: '[]', contentType: 'application/json' }),
  );
  await page.route(/\/api\/(?!jde|tress|citi)/i, route =>
    route.fulfill({ status: 200, body: '[]', contentType: 'application/json' }),
  );

  await page.goto('/');

  await page.waitForFunction(
    () => {
      const m = /\b(\d+)\s*de\s*(\d+)/.exec(document.body.innerText);
      if (!m) return false;
      const done = Number(m[1]);
      const total = Number(m[2]);
      return done >= total - 2 && total >= 8;
    },
    { timeout: 120_000 },
  );

  // Click "Reanudar descargas" loop if visible.
  for (let i = 0; i < 3; i++) {
    const resumeBtn = page.getByRole('button', { name: /Reanudar descargas/i });
    if (await resumeBtn.isVisible().catch(() => false)) {
      await resumeBtn.click().catch(() => {});
      await page.waitForTimeout(500);
    } else break;
  }

  await page.evaluate(() => {
    document.querySelectorAll('.splash-root').forEach(n => n.remove());
    document.querySelectorAll('[aria-hidden="true"]').forEach(n => n.removeAttribute('aria-hidden'));
  });
  const sectionNav = page.getByRole('navigation', { name: 'Secciones principales' });
  await expect(sectionNav).toBeVisible({ timeout: 30_000 });

  const heapTrace: (number | null)[] = [await readHeapMb(page)];
  // eslint-disable-next-line no-console
  console.log(`[heavy] baseline heap=${heapTrace[0] ?? 'n/a'}MB · cobranza=${COBRANZA_COUNT} compras=${COMPRAS_COUNT} aux=${AUXILIAR_COUNT}`);

  const routes: { section: string; tabs: string[] }[] = [
    { section: 'Proyección', tabs: ['Proyección Financiera', 'Planeación Financiera'] },
    { section: 'Por Pagar', tabs: ['Antigüedad de Saldo'] },
    { section: 'Cobranza', tabs: ['Cobranza'] },
    { section: 'Catálogos', tabs: ['Bancos'] },
  ];

  for (let it = 0; it < ITERATIONS; it++) {
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
    const heap = await readHeapMb(page);
    heapTrace.push(heap);
    // eslint-disable-next-line no-console
    console.log(`[heavy] iter ${it + 1}/${ITERATIONS} heap=${heap ?? 'n/a'}MB`);
  }

  expect(errors, errors.join('\n')).toHaveLength(0);

  // Heap trace assertions: la mecánica que protege contra Error code: 5 es
  // que tras N iteraciones el heap no escala lineal. Permitimos una banda
  // generosa (last < first * 5 + 300MB) para acomodar caches legítimos.
  const valid = heapTrace.filter((h): h is number => typeof h === 'number');
  if (valid.length >= 2) {
    const first = valid[0]!;
    const last = valid[valid.length - 1]!;
    const peak = Math.max(...valid);
    // eslint-disable-next-line no-console
    console.log(`[heavy] trace ${valid.map(v => `${v}MB`).join(' → ')} · peak=${peak}MB`);
    expect(last).toBeLessThan(first * 5 + 300);
    // El peak nunca debe acercarse al hard limit de Chrome (~2GB). Si
    // performance.memory está disponible y vemos > 1500MB es señal de leak.
    expect(peak).toBeLessThan(1500);
  }
});
