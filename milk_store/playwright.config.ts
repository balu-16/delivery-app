import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: {
    baseURL: process.env.STORE_E2E_BASE_URL ?? 'http://localhost:5174',
    channel: 'chrome',
  },
})
