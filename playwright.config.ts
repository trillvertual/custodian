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
    {
      name: "desktop",
      testIgnore: ["data-tools.spec.ts", "trusted-browser.spec.ts"],
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      testIgnore: ["data-tools.spec.ts", "trusted-browser.spec.ts"],
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        baseURL: "http://127.0.0.1:3011",
      },
    },
    {
      name: "tools-desktop",
      testMatch: "data-tools.spec.ts",
      use: {
        viewport: { width: 1440, height: 900 },
        baseURL: "http://127.0.0.1:3012",
      },
    },
    {
      name: "tools-mobile",
      testMatch: "data-tools.spec.ts",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        baseURL: "http://127.0.0.1:3013",
      },
    },
    {
      name: "passkey-desktop",
      testMatch: "trusted-browser.spec.ts",
      use: {
        viewport: { width: 1440, height: 900 },
        baseURL: "http://localhost:3014",
      },
    },
    {
      name: "passkey-mobile",
      testMatch: "trusted-browser.spec.ts",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        baseURL: "http://localhost:3015",
      },
    },
  ],
  // Separate synthetic APIs keep device runs independent and below the real login limiter.
  webServer: [3010, 3011, 3012, 3013, 3014, 3015].map((port) => ({
    command: `APP_URL=http://${port >= 3014 ? "localhost" : "127.0.0.1"}:${port} PORT=${port} npx tsx tests/dev-server.ts`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 30000,
  })),
});
