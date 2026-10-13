import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  timeout: 60000,
  expect: { timeout: 10000 },
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3010",
    browserName: "chromium",
    locale: "ru-RU",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    deviceScaleFactor: 1,
    screenshot: "only-on-failure",
    launchOptions: process.env.CUSTODIAN_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.CUSTODIAN_CHROMIUM_EXECUTABLE }
      : {},
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    {
      name: "mobile",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        baseURL: "http://127.0.0.1:3011",
      },
    },
  ],
  // Separate synthetic APIs keep device runs independent and below the real login limiter.
  webServer: [3010, 3011].map((port) => ({
    command: `APP_URL=http://127.0.0.1:${port} PORT=${port} npx tsx tests/dev-server.ts`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 30000,
  })),
});
