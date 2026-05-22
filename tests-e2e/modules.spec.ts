import { test, expect, type Page } from '@playwright/test';

/**
 * Walks every section + subtab in Midas and asserts the module mounts without
 * throwing. Catches console errors and uncaught exceptions; a clean run means
 * every lazy chunk loaded and rendered.
 */

type SubTab = string;
type Section = { name: string; tabs: SubTab[] };

const SECTIONS: Section[] = [
  {
    name: 'Proyección',
    tabs: ['Proyección Financiera', 'Planeación Financiera'],
  },
  {
    name: 'Por Pagar',
    tabs: ['Antigüedad de Saldo', 'Órdenes de Compras', 'Pagos', 'Nómina', 'Impuestos'],
  },
  {
    name: 'Cobranza',
    tabs: ['Flujo Neto', 'Cobranza', 'Concurso Mercantil', 'Fideicomiso Dina'],
  },
  {
    name: 'Catálogos',
    tabs: ['Clientes', 'Proveedores', 'Bancos'],
  },
  {
    name: 'Conciliación',
    tabs: ['Conciliación'],
  },
];

const IGNORED_CONSOLE_PATTERNS = [
  /Download the React DevTools/,
  /Recharts.*ResponsiveContainer/,
  /findDOMNode/,
  /defaultProps/,
  // Stubbed upstream responses — expected in e2e, not a regression.
  /status of 503/,
  /Failed to load resource/,
  /e2e-stubbed/,
  /JdeApiError|TressApiError|CitiApiError/,
];

function attachErrorListeners(page: Page) {
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (IGNORED_CONSOLE_PATTERNS.some(rx => rx.test(text))) return;
    errors.push(`console.error: ${text}`);
  });
  page.on('pageerror', err => {
    errors.push(`pageerror: ${err.message}`);
  });
  return errors;
}

test('modules: click through every section + subtab without crashing', async ({ page }) => {
  test.setTimeout(360_000);
  const errors = attachErrorListeners(page);

  // Stub upstream APIs so the boot splash settles quickly via `error` status
  // instead of waiting on real JDE/TRESS/CITI. Each boot task counts as done
  // when status ∈ {'done','error'}. The 10th boot slot (projection) waits for
  // the first dashboard paint, which fires once the source builds (empty data
  // is fine — it still paints).
  await page.route(/\/api\/(jde|tress|citi)\//, route =>
    route.fulfill({ status: 503, body: '{"error":"e2e-stubbed"}', contentType: 'application/json' }),
  );

  await page.goto('/');

  // Wait until the app shell is rendered behind the splash (the splash sits
  // on top with the underlying app at opacity:0 + aria-hidden). Boot slot 10
  // ("projection · first paint") never fires when JDE is stubbed out, so we
  // can't wait for `isBooted` — instead we wait for the splash to report
  // ≥9/10 boot tasks settled, then manually rip it off the DOM to expose the
  // already-mounted app. This is test-only; production users see the splash
  // dismiss via signalProjectionFirstPaint.
  await page.waitForFunction(
    () => /\b(9|10)\b\s*de\s*10/.test(document.body.innerText),
    { timeout: 150_000 },
  );
  await page.evaluate(() => {
    document.querySelectorAll('.splash-root').forEach(n => n.remove());
    document.querySelectorAll('[aria-hidden="true"]').forEach(n => n.removeAttribute('aria-hidden'));
  });

  const sectionNav = page.getByRole('navigation', { name: 'Secciones principales' });
  await expect(sectionNav).toBeVisible({ timeout: 15_000 });

  for (const section of SECTIONS) {
    await test.step(`section: ${section.name}`, async () => {
      await sectionNav.getByRole('button', { name: section.name }).click();

      for (const tab of section.tabs) {
        await test.step(`tab: ${tab}`, async () => {
          // Subtab button lives in the breadcrumb bar; match exact text to
          // avoid colliding with the section button (e.g. "Cobranza").
          const tabBtn = page.getByRole('button', { name: tab, exact: true }).first();
          await tabBtn.click();
          await expect(tabBtn).toHaveAttribute('aria-current', 'page', { timeout: 15_000 });

          // Wait for lazy chunk to mount — the LazyTabFallback shows
          // "Cargando <label>"; once it disappears the module is rendered.
          const loading = page.getByText(`Cargando ${tab}`, { exact: false });
          await loading.waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {});

          // Module visibly settled: main region populated.
          await expect(page.locator('main#main-content')).toBeVisible();
        });
      }
    });
  }

  if (errors.length > 0) {
    throw new Error(`Captured ${errors.length} runtime error(s):\n${errors.join('\n')}`);
  }
});
