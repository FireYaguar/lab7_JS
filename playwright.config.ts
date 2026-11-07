import { defineConfig } from '@playwright/test'

// Lab 7: e2e — два браузери в одній кімнаті. Сервер піднімає сам Playwright (збірка клієнта + node).
export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://127.0.0.1:3000', trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run build && npm start',
    url: 'http://127.0.0.1:3000/health',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { LOG_LEVEL: 'warn', MAX_PLAYERS_PER_ROOM: '8' },
  },
})
