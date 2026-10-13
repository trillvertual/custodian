import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect, type Browser, type Page } from "@playwright/test";

// Isolated in-memory demonstration data. Never connect this capture to a live vault.
const port = Number(process.env.CUSTODIAN_SCREENSHOT_PORT ?? 3110);
const origin = `http://127.0.0.1:${port}`;
const output = resolve("docs/screenshots");
const server = spawn(
  process.execPath,
  ["--import", "tsx", "tests/dev-server.ts"],
  {
    env: { ...process.env, APP_URL: origin, PORT: String(port) },
    stdio: ["ignore", "inherit", "inherit"],
  },
);
let browser: Browser | undefined;

async function capture(page: Page, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
  });
  await expect(page.locator(".brand:visible")).toHaveText("Custodian");
  await expect(page.locator("body")).not.toContainText(
    "DEMO-ONLY-secret-2026!",
  );
  const path = resolve(output, `${name}.png`);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
  });
  await page.mouse.move(1598, 898);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.screenshot({ path, animations: "disabled", fullPage: false });
  const png = await readFile(path);
  if (png.readUInt32BE(16) !== 2560 || png.readUInt32BE(20) !== 1440)
    throw new Error(`Unexpected screenshot dimensions: ${name}`);
  console.log(`Captured ${name}.png (2560×1440)`);
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null)
      throw new Error(`Demo server exited with code ${server.exitCode}`);
    try {
      ready = (await fetch(`${origin}/api/health`)).ok;
    } catch {
      // The demo server is still starting.
    }
    if (ready) break;
    await delay(250);
  }
  if (!ready) throw new Error("Demo server did not become ready");
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({
    ...(process.env.CUSTODIAN_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.CUSTODIAN_CHROMIUM_EXECUTABLE }
      : {}),
  });
  // High-density desktop capture produces 2560×1440 PNGs without resizing.
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1.6,
    locale: "ru-RU",
    timezoneId: "UTC",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  await expect(page).toHaveTitle("Custodian");
  await page.getByLabel("Логин", { exact: true }).fill("demo");
  await page
    .getByLabel("Пароль", { exact: true })
    .fill("Demo login password 2026!");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page
    .getByRole("button", { name: "Открыть Cloudflare", exact: true })
    .waitFor();
  await capture(page, "vault-dark");
  await page.getByRole("button", { name: "Светлая тема", exact: true }).click();
  await capture(page, "vault-light");
  await page
    .getByRole("button", { name: "Открыть Cloudflare", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Показать пароль", exact: true }),
  ).toBeVisible();
  await capture(page, "record-light");
  await page
    .getByRole("button", { name: "Закрыть сведения", exact: true })
    .click();
  await page.getByRole("button", { name: "Тёмная тема", exact: true }).click();
  await page.keyboard.press("Control+k");
  await expect(
    page.getByRole("dialog", { name: "Поиск записей", exact: true }),
  ).toBeVisible();
  await capture(page, "search-dark");
  if (errors.length) throw new Error(errors.join("\n"));
} finally {
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, "exit");
    server.kill("SIGTERM");
    const timeout = globalThis.setTimeout(() => server.kill("SIGKILL"), 5000);
    try {
      await stopped;
    } finally {
      clearTimeout(timeout);
    }
  }
}
