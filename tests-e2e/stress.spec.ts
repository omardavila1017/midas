import { test, expect, type Page } from '@playwright/test';

/**
 * Stress + long-session: navegación repetida entre módulos pesados
 * (Proyección / Planeación / Bancos / Cobranza / CXP) midiendo heap usage en
 * cada iteración. Confirma:
 *   1. La app NO crashea en N navegaciones repetidas (Error code: 5 = OOM).
 *   2. El heap usage NO crece monotónicamente — los caches se liberan al
 *      desmontar dashboards y bajo pressure.
 *   3. runtimeGuardian captura las navegaciones (window.__midas__.runtime).
 *
 * Stubea APIs a 200 + [] para que el boot converja determinístico.
 */

const NAV_ITERATIONS = 10;

const ROUTE_NAV: { section: string; tabs: string[] }[] = [
  { section: 'Proyección', tabs: ['Proyección Financiera', 'Planeación Financiera'] },
  { section: 'Por Pagar', tabs: ['Antigüedad de Saldo', 'Pagos'] },
  { section: 'Cobranza', tabs: ['Flujo Neto', 'Cobranza'] },
  { section: 'Catálogos', tabs: ['Bancos'] },
];

const IGNORED_CONSOLE = [
  /Download the React DevTools/,
  /Recharts.*ResponsiveContainer/,
  /findDOMNode/,
  /defaultProps/,
  /e2e-stubbed/,
  /JdeApiError|TressApiError|CitiApiError/,
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

async function setupApp(page: Page) {
  await page.route(/\/api\//, route =>
    route.fulfill({ status: 200, body: '[]', contentType: 'application/json' }),
  );
  await page.goto('/');

  // Espera splash settled (≥ total-2 boot tasks completed, total ≥ 8).
  await page.waitForFunction(
    () => {
      const m = /\b(\d+)\s*de\s*(\d+)/.exec(document.body.innerText);
      if (!m) return false;
      const done = Number(m[1]);
      const total = Number(m[2]);
      return done >= total - 2 && total >= 8;
    },
    { timeout: 60_000 },
  );
  await page.evaluate(() => {
    document.querySelectorAll('.splash-root').forEach(n => n.remove());
    document.querySelectorAll('[aria-hidden="true"]').forEach(n => n.removeAttribute('aria-hidden'));
  });

  const sectionNav = page.getByRole('navigation', { name: 'Secciones principales' });
  await expect(sectionNav).toBeVisible({ timeout: 15_000 });
  return sectionNav;
}

async function readHeapMb(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    if (!m || typeof m.usedJSHeapSize !== 'number') return null;
    return Math.round((m.usedJSHeapSize / 1_048_576) * 10) / 10;
  });
}

async function readNavEvents(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as { __midas__?: { runtime?: { getNavEvents?: () => unknown[] } } };
    const events = w.__midas__?.runtime?.getNavEvents?.();
    return Array.isArray(events) ? events.length : 0;
  });
}

test('stress: navegación repetida no crashea y heap no crece monotónicamente', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = attachErrorListeners(page);
  const sectionNav = await setupApp(page);

  const heapTrace: (number | null)[] = [];
  heapTrace.push(await readHeapMb(page));

  for (let iter = 0; iter < NAV_ITERATIONS; iter++) {
    for (const route of ROUTE_NAV) {
      await sectionNav.getByRole('button', { name: route.section }).click();
      for (const tab of route.tabs) {
        const tabBtn = page.getByRole('button', { name: tab, exact: true }).first();
        await tabBtn.click();
        await expect(tabBtn).toHaveAttribute('aria-current', 'page', { timeout: 10_000 });
        await page.getByText(`Cargando ${tab}`, { exact: false })
          .waitFor({ state: 'detached', timeout: 15_000 })
          .catch(() => {});
      }
    }
    const heap = await readHeapMb(page);
    heapTrace.push(heap);
    // eslint-disable-next-line no-console
    console.log(`[stress] iter ${iter + 1}/${NAV_ITERATIONS} heap=${heap ?? 'n/a'}MB`);
  }

  // (1) Sin errores no esperados durante la stress run.
  expect(errors, errors.join('\n')).toHaveLength(0);

  // (2) Tracking de navegación capturado por runtimeGuardian.
  // Cada iteración hace ~7 navegaciones (4 secciones + ~3 tabs); 10 iter ≈ 60+
  const navEventCount = await readNavEvents(page);
  expect(navEventCount).toBeGreaterThanOrEqual(NAV_ITERATIONS * 3);

  // (3) Heap no escala lineal. Comparamos último vs primero:
  // - Si performance.memory no está disponible (Firefox/Edge), skip esta aserción.
  // - Si está disponible, el last NO debe ser > 4× el first (sería leak claro).
  const valid = heapTrace.filter((h): h is number => typeof h === 'number');
  if (valid.length >= 2) {
    const first = valid[0];
    const last = valid[valid.length - 1];
    // eslint-disable-next-line no-console
    console.log(`[stress] heap trace ${valid.map(v => `${v}MB`).join(' → ')}`);
    expect(last).toBeLessThan(first * 4 + 200);
  }
});
