import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests-e2e',
  timeout: 25_000,
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
    command: 'python3 -m http.server 5173',
    cwd: './dist',
    url: 'http://localhost:5173/',
    timeout: 15_000,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
