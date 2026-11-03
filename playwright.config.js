import { defineConfig, devices } from '@playwright/test';

/**
 * Nexus Hub Playwright Configuration
 *
 * Test strategy:
 *  - API tests (rbac.spec.js, sms-relay.spec.js): Hit the LIVE production API directly.
 *    → No dev server needed for these. They run fast (~5-10s).
 *
 *  - E2E browser tests (smoke.spec.js, dashboard.spec.js): Open the local Vite dev server.
 *    → The frontend connects to whatever VITE_API_URL it was built with; CI
 *      points it at http://localhost:3000/api (see ci.yml, Playwright E2E Tests).
 *    → So browser tests also validate against the LIVE production DB.
 *
 * Run all tests:  npm run test:smoke
 * Run API-only:   npx playwright test rbac sms-relay  (no dev server needed)
 * Run E2E-only:   npx playwright test smoke dashboard (now hits live site directly)
 */

/*
 * tests/android/** ovládá skutečné zařízení přes ADB (`_android.devices()`).
 * V prohlížečových projektech se nemá co spouštět — bez připojeného telefonu
 * spolehlivě spadne na timeoutu, čtyřikrát za běh, a dělá z výsledku šum,
 * ve kterém není poznat skutečná regrese.
 *
 * Pouští se buď samostatně (`npx playwright test tests/android`), nebo
 * v CI jobu, který má zařízení k dispozici.
 */
const BROWSER_TEST_IGNORE = [/tests\/android\//];

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,    // Parallelize tests for speed
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: '50%', // Increased to 50% of CPU cores to speed up test execution
  timeout: 180_000,        // Increase timeout for long video recording
  reporter: [['list'], ['json', { outputFile: 'test-results/playwright-results.json' }]],

  use: {
    baseURL: process.env.FRONTEND_URL || 'https://nexus-sync-8d50b.web.app',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on',
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  },

  projects: [
    {
      name: 'chromium',
      testIgnore: BROWSER_TEST_IGNORE,
      use: { 
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        }
      },
    },
    {
      name: 'mobile',
      testIgnore: BROWSER_TEST_IGNORE,
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'firefox',
      testIgnore: BROWSER_TEST_IGNORE,
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      testIgnore: BROWSER_TEST_IGNORE,
      use: { ...devices['Desktop Safari'] },
    },
  ],

  /*
   * webServer is disabled because of local binding restrictions (EPERM).
   * We test against the live production frontend but use setupApiMocks() 
   * to intercept all backend traffic.
   */
  // webServer: [ ... ],
});
