import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: process.env.CC_URL || 'http://127.0.0.1:3001', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // Phone-sized run of the Workflow Studio journeys only.
    { name: 'mobile', testMatch: /workflow-studio/, use: { ...devices['Pixel 7'] } },
  ],
});
