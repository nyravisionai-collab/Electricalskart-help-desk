import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
    permissions: ['microphone'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  webServer: {
    command: 'node scripts/start-e2e-server.mjs',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      PORT: '4173',
      DB_FILE: './data/e2e.sqlite',
      JWT_SECRET: 'e2e-only-jwt-secret-that-is-longer-than-thirty-two-characters',
      OWNER_NAME: 'E2E Owner',
      OWNER_EMAIL: 'owner@e2e.test',
      OWNER_PASSWORD: 'E2EOwnerPassword!123',
      CALL_RING_TIMEOUT_MS: '10000',
      CALL_QUEUE_TTL_MS: '60000',
    },
  },
});
