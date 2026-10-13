import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      SETUP_TOKEN: "shared-vault-test-setup-token-00000001",
      APP_URL: "http://localhost:5173",
      GITHUB_CLIENT_ID: "test-github-id",
      GITHUB_CLIENT_SECRET: "test-github-secret",
      TELEGRAM_CLIENT_ID: "123456",
      TELEGRAM_CLIENT_SECRET: "test-telegram-secret",
    },
  },
});
