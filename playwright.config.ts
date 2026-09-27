import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://localhost:5173',
    channel: process.env.PLAYWRIGHT_UI_ONLY === 'true' ? 'chrome' : undefined,
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      process.env.PLAYWRIGHT_UI_ONLY === 'true' ? 'npm run dev -w @switchboard/web' : 'npm run dev',
    url: 'http://localhost:5173',
    timeout: 120_000,
    reuseExistingServer: true,
  },
});
