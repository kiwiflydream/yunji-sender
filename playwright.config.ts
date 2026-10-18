import { defineConfig } from '@playwright/test'

const baseURL = process.env.E2E_BASE_URL
if (!baseURL || new URL(baseURL).hostname !== '127.0.0.1') {
  throw new Error('Run pnpm test:e2e to start the isolated local test environment.')
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    baseURL,
    browserName: 'chromium',
    httpCredentials: { username: 'admin', password: process.env.E2E_ADMIN_PASSWORD! },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'api', testMatch: 'api.spec.ts' },
    ...(['zh-CN', 'en'] as const).flatMap((locale, i) => [
      { name: `desktop-${locale}`, testMatch: 'admin.spec.ts', use: { locale, extraHTTPHeaders: { 'cf-connecting-ip': `192.0.2.${10+i*2}` }, viewport: { width: 1440, height: 1000 } } },
      { name: `mobile-${locale}`, testMatch: 'admin.spec.ts', use: { locale, extraHTTPHeaders: { 'cf-connecting-ip': `192.0.2.${11+i*2}` }, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    ]),
    { name: 'limits', testMatch: 'limits.spec.ts' },
  ],
})
