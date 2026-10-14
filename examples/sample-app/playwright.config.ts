import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  outputDir: 'test-results',
  fullyParallel: true,
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['playwright-ctrf-json-reporter', { outputDir: 'prove', outputFile: 'ctrf.json' }],
  ],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on',
    video: 'on',
    screenshot: 'on',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'node server.mjs',
    url: 'http://localhost:4173/healthz',
    reuseExistingServer: false,
  },
});
