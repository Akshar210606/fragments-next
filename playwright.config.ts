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
   * reuseExistingServer is true in both CI and local runs on purpose. CI
   * already starts the server for the vitest suite, so this attaches to that
   * one rather than racing a second process onto port 3000. Locally it means
   * `npm run dev` in one terminal and `npm run test:e2e` in another just works.
   */
  webServer: {
    command: 'npm run start',
    url: 'http://localhost:3000/api/health',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
