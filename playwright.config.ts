import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests-e2e',
  timeout: 360_000,
  expect: { timeout: 6_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'tests-e2e/.report.json' }]],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'off',
    screenshot: 'only-on-failure',
    headless: true,
    video: 'off',
    launchOptions: { args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] },
  },
  webServer: {
    command: 'npx vite preview --host 127.0.0.1 --port 5173',
    url: 'http://127.0.0.1:5173/midas/',
    timeout: 15_000,
    reuseExistingServer: true,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // Firefox cubre el motor Gecko (no Chromium). Si Firefox no está
    // instalado el runner falla rápido; instalar con
    // `npx playwright install firefox`.
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    // Microsoft Edge real (no solo motor Chromium genérico). Usa el binario
    // msedge-stable del sistema vía `channel: 'msedge'`. Instalar con
    // `npx playwright install msedge`. Es el browser que el usuario reportó
    // como crasheando — validar aquí es el target principal.
    { name: 'msedge', use: { ...devices['Desktop Edge'], channel: 'msedge' } },
  ],
});
