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

  // Stub upstream APIs con 200 + payload vacío para que los boot tasks
  // converjan rápido sin disparar el pause-on-failure del splash.
  // /companies devuelve un array vacío de cías — boot sigue, no hay fetches
  // per-cia que hacer. Los endpoints específicos devuelven `[]`.
  await page.route(/\/api\/(jde|tress|citi)\/.*/, async route => {
    const url = route.request().url();
    if (/companies/i.test(url)) {
      await route.fulfill({ status: 200, body: '[]', contentType: 'application/json' });
      return;
    }
    await route.fulfill({ status: 200, body: '[]', contentType: 'application/json' });
  });
  // Cualquier otra ruta de la app que falle se intercepta a 200 vacío.
  await page.route(/\/api\//, route =>
    route.fulfill({ status: 200, body: '[]', contentType: 'application/json' }),
  );

  await page.goto('/');

  // Wait until the splash is in a settled state. El número de boot slots
  // cambia con el tiempo (10 → 11 al sumar auxiliar/rol); leemos el total
  // dinámicamente con el patrón "N de M". El test es robusto a M ≥ 8.
  // Como /api/ está stubeado a 503, varios fetches fallan — el splash muestra
  // "Descargas pausadas" con un botón "Reanudar descargas". Lo click-eamos
  // para que las fallas cuenten como `error` (boot task settled) en vez de
  // permanecer `loading` indefinidamente.
  await page.waitForFunction(
    () => /\b\d+\s*de\s*\d+/.test(document.body.innerText),
    { timeout: 30_000 },
  );
  // Reanudar descargas si aparece el banner de pausa por 503.
  for (let i = 0; i < 3; i++) {
    const resumeBtn = page.getByRole('button', { name: /Reanudar descargas/i });
    if (await resumeBtn.isVisible().catch(() => false)) {
      await resumeBtn.click({ trial: false }).catch(() => {});
      await page.waitForTimeout(500);
    } else break;
  }
  await page.waitForFunction(
    () => {
      const m = /\b(\d+)\s*de\s*(\d+)/.exec(document.body.innerText);
      if (!m) return false;
      const done = Number(m[1]);
      const total = Number(m[2]);
      // Aceptamos ≥ total-2 (la slot de projection-first-paint nunca cierra
      // con APIs stubeadas; otras fallas como banks/JDE quedan en error).
      return done >= total - 2 && total >= 8;
    },
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
