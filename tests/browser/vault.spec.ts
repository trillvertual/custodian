import { test, expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyCustomControls } from "./custom-controls";

const captureDirectory = resolve(".impeccable/review");

async function login(page: Page) {
  await page.goto("/");
  await page.getByRole("heading", { name: "Вход в хранилище" }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await capture(
    page,
    page.viewportSize()!.width < 760 ? "mobile-login" : "desktop-login",
  );
  await page.getByLabel("Логин", { exact: true }).fill("demo");
  await page
    .getByLabel("Пароль", { exact: true })
    .fill("Demo login password 2026!");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page
    .getByRole("button", { name: "Открыть Cloudflare", exact: true })
    .waitFor();
  await page.evaluate(() => document.fonts.ready);
}

async function capture(page: Page, name: string) {
  await mkdir(captureDirectory, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: resolve(captureDirectory, `${name}.png`),
    animations: "disabled",
    fullPage: true,
  });
}

async function navigate(page: Page, name: RegExp | string, mobile: boolean) {
  if (mobile)
    await page.getByRole("button", { name: "Открыть навигацию" }).click();
  await page
    .locator(".sidebar")
    .getByRole("button", { name, exact: true })
    .click();
}

test("responsive shell, protected details, themes, navigation and editor", async ({
  page,
}, info) => {
  const mobile = info.project.name === "mobile";
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    // Network statuses are checked below with the exact request path.
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    )
      errors.push(message.text());
  });
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (
      response.status() >= 400 &&
      !(path === "/api/auth/session" && response.status() === 401)
    )
      errors.push(`${response.status()} ${path}`);
  });
  page.on("requestfailed", (request) => {
    errors.push(
      `${new URL(request.url()).pathname}: ${request.failure()?.errorText}`,
    );
  });
  const measurements: { label: string; width: number; scrollWidth: number }[] =
    [];
  async function measure(label: string) {
    measurements.push(
      await page.evaluate(
        (label) => ({
          label,
          width: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
        }),
        label,
      ),
    );
  }
  await login(page);
  if (!mobile) await capture(page, "desktop");
  if (mobile) {
    const trigger = page.getByRole("button", { name: "Открыть навигацию" });
    await expect(page.locator(".sidebar")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Заблокировать", exact: true }),
    ).toBeVisible();
    await trigger.focus();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog", {
      name: "Навигация хранилища",
      exact: true,
    });
    await expect(drawer).toBeVisible();
    for (let step = 0; step < 20; step++) {
      await page.keyboard.press(step < 10 ? "Tab" : "Shift+Tab");
      expect(
        await drawer.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      ).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
    await capture(page, "mobile");
    await measure("record list");
  }
  await page
    .getByRole("button", { name: "Открыть Cloudflare", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Показать пароль", exact: true }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText(
    "DEMO-ONLY-secret-2026!",
  );
  await capture(page, mobile ? "mobile-detail" : "desktop-detail");
  await measure("masked detail");
  await page
    .getByRole("button", { name: "Показать пароль", exact: true })
    .click();
  await expect(page.locator("body")).toContainText("DEMO-ONLY-secret-2026!");
  await page
    .getByRole("button", { name: "Скрыть пароль", exact: true })
    .click();
  await page.getByRole("button", { name: "Закрыть сведения" }).click();

  if (mobile) {
    await page.getByRole("button", { name: "Открыть навигацию" }).click();
    await capture(page, "mobile-navigation");
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "Настройки", exact: true })
      .click();
  } else {
    await navigate(page, "Настройки", false);
  }
  await expect(
    page.getByRole("heading", { name: "Настройки", exact: true }),
  ).toBeVisible();
  await measure("settings");
  await capture(page, `${info.project.name}-settings`);
  await navigate(page, "Команда", mobile);
  await expect(
    page.getByRole("heading", { name: "Команда", exact: true }),
  ).toBeVisible();
  await measure("members");
  await capture(page, `${info.project.name}-members`);
  await navigate(page, /^Все записи/, mobile);
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", {
    name: "Поиск записей",
    exact: true,
  });
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox").fill("Cloudflare");
  await capture(page, `${info.project.name}-search`);
  await page.keyboard.press("Enter");
  await expect(page.locator(".detail-pane")).toBeVisible();
  await page.getByRole("button", { name: "Закрыть сведения" }).click();
  await page.getByLabel("Поиск записей").fill("nonexistent-synthetic-entry");
  await expect(
    page.getByRole("button", { name: "Открыть Cloudflare", exact: true }),
  ).toBeHidden();
  await measure("empty search");
  await page.getByLabel("Поиск записей").clear();
  await page.getByRole("button", { name: "Светлая тема" }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await capture(page, `${info.project.name}-light`);
  await page.getByRole("button", { name: "Тёмная тема" }).click();
  await page
    .getByRole("button", { name: "Добавить запись", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "Новая запись" });
  await expect(editor).toBeVisible();
  await capture(page, `${info.project.name}-editor`);
  await measure("editor");
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();

  const original = page.viewportSize()!;
  for (const width of mobile ? [320, 360, 430] : [768, 1024, 1280, 1920]) {
    await page.setViewportSize({ width, height: original.height });
    await measure(`record list at ${width}px`);
    await page
      .getByRole("button", { name: "Открыть Cloudflare", exact: true })
      .click();
    await measure(`detail at ${width}px`);
    await page.getByRole("button", { name: "Закрыть сведения" }).click();
  }
  await page.setViewportSize(original);
  await verifyCustomControls(page, info.project.name);
  await writeFile(
    resolve(captureDirectory, `${info.project.name}-measurements.json`),
    JSON.stringify({ measurements, errors }, null, 2),
  );
  for (const measurement of measurements) {
    expect
      .soft(measurement.scrollWidth, measurement.label)
      .toBeLessThanOrEqual(measurement.width);
  }
  expect(errors).toEqual([]);
});

test("record editing, history, trash, clipboard and lock use real encrypted API", async ({
  page,
  context,
}, info) => {
  const mobile = info.project.name === "mobile";
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  const title = `Chromium ${info.project.name} - synthetic check`;
  const secret = "Synthetic browser password 42!";
  await page
    .getByRole("button", { name: "Добавить запись", exact: true })
    .click();
  await page.getByLabel("Название", { exact: true }).fill(title);
  await page.getByLabel("Пароль", { exact: true }).fill(secret);
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/records/batch") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Создать запись", exact: true })
    .click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  expect(await response.text()).not.toContain(secret);
  expect(await response.text()).not.toContain(title);
  await expect(page.locator(".detail-pane h2")).toHaveText(title);
  await expect(page.locator("body")).not.toContainText(secret);
  await page
    .getByRole("button", { name: "Копировать пароль", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(secret);
  await page
    .getByRole("button", { name: "Редактировать", exact: true })
    .click();
  await page
    .getByLabel("Заметка", { exact: true })
    .fill("Synthetic note - browser edit");
  await page
    .getByRole("button", { name: "Сохранить изменения", exact: true })
    .click();
  await expect(page.locator(".detail-pane")).toContainText(
    "Synthetic note - browser edit",
  );
  await page
    .getByRole("button", { name: "История изменений", exact: true })
    .click();
  const history = page.getByRole("dialog", { name: "История записи" });
  await expect(history).toContainText("Версия 1");
  await history.getByRole("button", { name: "Закрыть", exact: true }).click();
  await page.getByRole("button", { name: "Переместить в корзину" }).click();
  await page.getByRole("button", { name: "В корзину", exact: true }).click();
  await expect(page.locator(".detail-pane")).toBeHidden();
  await navigate(page, /^Корзина/, mobile);
  await page
    .getByRole("button", { name: `Открыть ${title}`, exact: true })
    .click();
  await page.getByRole("button", { name: "Восстановить", exact: true }).click();
  await expect(page.locator(".detail-pane")).not.toContainText("В корзине с");
  await page.getByRole("button", { name: "Переместить в корзину" }).click();
  await page.getByRole("button", { name: "В корзину", exact: true }).click();
  await expect(page.locator(".detail-pane")).toBeHidden();
  await navigate(page, /^Все записи/, mobile);
  await page
    .getByRole("button", { name: "Открыть Cloudflare", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Показать пароль", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Заблокировать", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Хранилище заблокировано" }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText(
    "DEMO-ONLY-secret-2026!",
  );
  await expect(page.locator("body")).not.toContainText("Cloudflare");
  expect(errors).toEqual([]);
});
