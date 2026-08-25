import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * The vitest suite in tests/ already proves the API behaves correctly when you
 * call it directly. This suite proves the same guarantees survive the trip
 * through a real browser: that what a user actually sees on the page matches
 * what the API promised. They are different failures. An endpoint can be
 * correct while the page renders someone else's data, or renders nothing.
 */
export default defineConfig({
  testDir: './e2e',

  // Compiles every route once before the suite starts. Without it, `next dev`
  // charges the first test that touches a route for compiling it, which reads
  // as a timeout on tests 1 and 2 while everything after them passes fast.
  globalSetup: './e2e/global-setup.ts',

  /**
   * Deliberately generous, and only for the dev server's sake.
   *
   * Against a production build these tests finish in one to three seconds
   * each. On a cold `next dev` the very first interaction can still stall
   * behind the compiler even with the warm-up above. A tight timeout here
   * does not catch bugs, it just fails honest runs on slower machines.
   */
  timeout: 60_000,
  expect: { timeout: 15_000 },

  // A failing e2e test should fail the build, not be quietly retried into
  // passing. Retries only in CI, and only to absorb genuine flake.
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: process.env.TEST_BASE_URL ?? 'http://localhost:3000',
    // Artefacts only for failures, so a green run leaves nothing behind.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  /**
   * These tests run against a DEVELOPMENT server, deliberately.
   *
   * Signing in here goes through /api/auth/dev-token, which returns 404 when
   * NODE_ENV is production - on purpose, because an endpoint that mints a token
   * for any username you name is a complete authentication bypass and must not
   * exist in a deployed environment. Pointing this suite at `npm start` means
   * every authenticated test fails with a 404 that has nothing to do with the
   * code under test.
   *
   * Testing sign-in against a production build would require a real identity
   * provider. v1 had one in Cognito; v2 deliberately does not, so that the
   * interesting parts stay PostgreSQL and Next.js. The dev server is the
   * honest target for these tests, and the vitest suite already exercises the
   * API against the production build.
   *
   * reuseExistingServer is true so `npm run dev` in one terminal and
   * `npm run test:e2e` in another just works, and so CI can start the server
   * itself without racing a second process onto port 3000.
   */
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000/api/health',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
