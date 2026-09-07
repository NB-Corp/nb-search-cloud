import { defineConfig } from '@playwright/test';
import fs from 'node:fs';

const port = Number(process.env.BROWSER_PORT || 41735);
const baseURL = process.env.BROWSER_BASE_URL || `http://127.0.0.1:${port}`;
const useDevServer = process.env.BROWSER_SERVER === 'dev';
const localChrome = process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : '/usr/bin/google-chrome';
const executablePath = process.env.BROWSER_EXECUTABLE_PATH || (fs.existsSync(localChrome) ? localChrome : undefined);

export default defineConfig({
  testDir: 'test/browser',
  timeout: 45_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  outputDir: 'test/browser/.artifacts',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'test/browser/.report', open: 'never' }],
  ],
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    launchOptions: executablePath ? { executablePath } : undefined,
  },
  webServer: process.env.BROWSER_BASE_URL
    ? undefined
    : {
        command: useDevServer
          ? `pnpm exec vite --host 127.0.0.1 --port ${port}`
          : `pnpm exec vite preview --host 127.0.0.1 --port ${port}`,
        url: baseURL,
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
