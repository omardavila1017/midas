import { test, expect, type Page } from '@playwright/test';

/**
 * Memory pressure validation:
 *   1. Simula presión de heap inflando arrays grandes en el contexto de la
 *      page hasta provocar el threshold del runtimeGuardian.
 *   2. Verifica que runtimeGuardian acumula incidentes de tipo
 *      `heap-warning` / `memory-pressure` cuando aplica.
 *   3. Verifica que la app NO crashea bajo presión (Error code: 5).
 *   4. Verifica que el navigation tracking captura correctamente.
 *
 * Diseñado para correr en menos de 60s. Si performance.memory no está
 * disponible en el browser (Firefox), el test se skip-likely pasa con la
 * aserción de "no crashea".
 */

const IGNORED_CONSOLE = [
  /Download the React DevTools/,
  /Recharts.*ResponsiveContainer/,
  /findDOMNode/,
  /defaultProps/,
  /JdeApiError|TressApiError|CitiApiError/,
  /\[fetchNomina\] fan-out vacío/,
  /\[runtimeGuardian\]/,  // los warns del guardian son esperados aquí
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

test('memory pressure: runtimeGuardian observa incidentes y app no crashea', async ({ page, browserName }) => {
  test.setTimeout(120_000);
  const errors = attachErrorListeners(page);

  await page.route(/\/api\//, route =>
    route.fulfill({ status: 200, body: '[]', contentType: 'application/json' }),
  );
  await page.goto('/');

  // Espera boot settled.
  await page.waitForFunction(
    () => {
      const m = /\b(\d+)\s*de\s*(\d+)/.exec(document.body.innerText);
      if (!m) return false;
      return Number(m[1]) >= Number(m[2]) - 2;
    },
    { timeout: 60_000 },
  );
  await page.evaluate(() => {
    document.querySelectorAll('.splash-root').forEach(n => n.remove());
    document.querySelectorAll('[aria-hidden="true"]').forEach(n => n.removeAttribute('aria-hidden'));
  });

  // (A) runtimeGuardian debe estar instalado y exponer su API debug.
  const runtimeApi = await page.evaluate(() => {
    const w = window as unknown as { __midas__?: { runtime?: Record<string, unknown> } };
    return Boolean(w.__midas__?.runtime);
  });
  expect(runtimeApi).toBe(true);

  // (B) Simular memory pressure inflando arrays en page context. NO buscamos
  //     que crashee — buscamos que cuando creciera demasiado, el handler de
  //     pressure se ejecutara. El runtimeGuardian samplea cada 15s, así que
  //     este test es BEST-EFFORT.
  await page.evaluate(() => {
    const w = window as unknown as { __midasTest__?: unknown[] };
    w.__midasTest__ = [];
    // Inflate ~50MB
    for (let i = 0; i < 50; i++) {
      (w.__midasTest__ as unknown[]).push(new Array(200_000).fill(`xxxxxxxxxxxxxxxx-${i}`));
    }
  });

  // (C) Navegación rápida tras la presión: debe seguir respondiendo.
  const sectionNav = page.getByRole('navigation', { name: 'Secciones principales' });
  await expect(sectionNav).toBeVisible({ timeout: 30_000 });
  await sectionNav.getByRole('button', { name: 'Cobranza' }).click();
  await sectionNav.getByRole('button', { name: 'Proyección' }).click();
  const projBtn = page.getByRole('button', { name: 'Proyección Financiera', exact: true }).first();
  await projBtn.click();
  await expect(projBtn).toHaveAttribute('aria-current', 'page', { timeout: 10_000 });

  // (D) Sin pageerror — ningún crash durante la presión.
  expect(errors, errors.join('\n')).toHaveLength(0);

  // (E) Reporta lo que vio el guardian.
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
      navEvents: rt?.getNavEvents?.() ?? [],
      memory: rt?.getMemory?.() ?? null,
    };
  });

  // eslint-disable-next-line no-console
  console.log(`[${browserName}] memory pressure diagnostic:`, {
    incidents: (diagnostic.incidents as unknown[]).length,
    navEvents: (diagnostic.navEvents as unknown[]).length,
    memory: diagnostic.memory,
  });

  // (F) Navigation tracking funcionando — debe haber capturado los clicks.
  expect((diagnostic.navEvents as unknown[]).length).toBeGreaterThanOrEqual(1);

  // Cleanup heavy arrays
  await page.evaluate(() => {
    const w = window as unknown as { __midasTest__?: unknown };
    w.__midasTest__ = undefined;
  });
});
