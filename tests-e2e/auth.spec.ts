import { test, expect } from '@playwright/test';

test('auth: forgot password sends reset request without mounting app', async ({ page }) => {
  await page.route(/\/api\/auth\/session$/, route =>
    route.fulfill({ status: 401, body: JSON.stringify({}), contentType: 'application/json' }),
  );
  await page.route(/\/api\/auth\/password\/reset\/request$/, route =>
    route.fulfill({ status: 200, body: JSON.stringify({ ok: true }), contentType: 'application/json' }),
  );

  await page.goto('/');
  await expect(page.getByText('Acceso empresarial')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Olvidé mi contraseña' }).click();
  await page.getByPlaceholder('usuario@senda.com').fill('persona@senda.com');
  await page.getByRole('button', { name: 'Enviar liga' }).click();

  await expect(page.getByText(/Si el correo está registrado/)).toBeVisible();
});

test('auth: reset token completes password reset', async ({ page }) => {
  await page.route(/\/api\/auth\/password\/reset\/complete$/, route =>
    route.fulfill({ status: 200, body: JSON.stringify({ ok: true }), contentType: 'application/json' }),
  );

  await page.goto('/?reset_token=e2e-token');
  await expect(page.getByText('Definir nueva contraseña')).toBeVisible({ timeout: 10_000 });
  await page.getByLabel('Nueva contraseña').fill('ValidPassword1!');
  await page.getByLabel('Confirmar contraseña').fill('ValidPassword1!');
  await page.getByRole('button', { name: 'Guardar contraseña' }).click();

  await expect(page.getByText(/Contraseña actualizada/)).toBeVisible();
  await expect(page).not.toHaveURL(/reset_token/);
});
