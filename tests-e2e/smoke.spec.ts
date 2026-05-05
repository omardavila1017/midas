import { test, expect } from '@playwright/test';
test('home loads + Midas login visible', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Midas', { exact: false })).toBeVisible({ timeout: 10000 });
});
