import { test, expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const captures = resolve(".impeccable/review/motion");
const password = "Demo login password 2026!";
const secret = "DEMO-ONLY-secret-2026!";

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill("demo");
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page
    .getByRole("button", { name: "Открыть Cloudflare", exact: true })
    .waitFor();
}

async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
}

async function capture(page: Page, name: string) {
  await mkdir(captures, { recursive: true });
  await settle(page);
  await expect(page.locator("body")).not.toContainText(secret);
  await page.screenshot({
    path: resolve(captures, `${name}.png`),
    fullPage: true,
  });
}

async function navigate(page: Page, name: string, mobile: boolean) {
  if (mobile)
    await page.getByRole("button", { name: "Открыть навигацию" }).click();
  await page
    .locator(".sidebar")
    .getByRole("button", {
      name: name === "Все записи" ? /^Все записи/ : name,
      exact: true,
    })
    .click();
  await settle(page);
}

test("idle time and hidden tabs keep the vault open; explicit lock clears it", async ({
  page,
}, info) => {
  await page.clock.install();
  await login(page);
  await page
    .getByRole("button", { name: "Открыть Cloudflare", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Показать пароль", exact: true })
    .click();
  await expect(page.locator("body")).toContainText(secret);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(6 * 60 * 1000);
  await expect(page.locator(".detail-pane")).toBeVisible();
  await expect(page.locator("body")).toContainText(secret);
  await page
    .getByRole("button", { name: "Заблокировать", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Хранилище заблокировано" }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText(secret);
  await expect(page.locator("body")).not.toContainText("Cloudflare");
  await page.clock.resume();
  await capture(page, `${info.project.name}-unlock`);
});

test("record updates preserve the dialog and closing preserves shell geometry and focus", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await login(page);
  const trigger = page.getByRole("button", {
    name: "Открыть Cloudflare",
    exact: true,
  });
  const before = await page.locator(".records-card").boundingBox();
  await trigger.click();
  await settle(page);
  const after = await page.locator(".records-card").boundingBox();
  expect(after!.x).toBeCloseTo(before!.x, 1);
  expect(after!.width).toBeCloseTo(before!.width, 1);
  await page
    .getByRole("button", { name: "Показать пароль", exact: true })
    .click();
  await expect(page.locator("body")).toContainText(secret);
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).originalDetail =
      document.querySelector(".detail-pane");
  });
  const favorite = page.getByRole("button", {
    name: /^(В избранное|Убрать из избранного)$/,
  });
  const originalLabel = await favorite.getAttribute("aria-label");
  await favorite.click();
  await expect(favorite).not.toHaveAttribute("aria-label", originalLabel!);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as Record<string, unknown>).originalDetail ===
        document.querySelector(".detail-pane"),
    ),
  ).toBe(true);
  await expect(page.locator("body")).toContainText(secret);
  await page
    .getByRole("button", { name: "Скрыть пароль", exact: true })
    .click();
  await capture(page, `${info.project.name}-detail`);
  // Trigger a close from within the page to observe the actual exit, before locator waiting.
  const exit = await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Закрыть сведения"]',
    )!;
    button.click();
    return new Promise<{ state: string | undefined; animations: string[] }>(
      (done) =>
        requestAnimationFrame(() => {
          const dialog = document.querySelector<HTMLElement>(".detail-pane");
          done({
            state: dialog?.dataset.state,
            animations:
              dialog
                ?.getAnimations()
                .map(
                  (animation) => (animation as CSSAnimation).animationName,
                ) ?? [],
          });
        }),
    );
  });
  expect(exit.state).toBe("closed");
  expect(exit.animations).toContain("dialog-exit");
  await expect(page.locator(".detail-pane")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await capture(page, `${info.project.name}-vault`);
  await writeFile(
    resolve(captures, `${info.project.name}-continuity.json`),
    JSON.stringify({ before, after, exit }, null, 2),
  );
});

test("loading, empty and error states are explicit; navigation and reduced motion stay usable", async ({
  page,
}, info) => {
  const mobile = info.project.name === "mobile";
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await login(page);
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  await page.route("**/api/members", async (route) => {
    await held;
    await route.continue();
  });
  await navigate(page, "Команда", mobile);
  await expect(page.getByRole("status")).toHaveText("Загрузка данных…");
  await expect(page.locator(".members-card")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await capture(page, `${info.project.name}-members-loading`);
  release();
  await expect(page.locator(".members-card")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await capture(page, `${info.project.name}-members`);
  await page.unroute("**/api/members");
  await page.route("**/api/audit", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ message: "Проверка ошибки загрузки" }),
    }),
  );
  await navigate(page, "Журнал действий", mobile);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Повторить загрузку" }),
  ).toBeVisible();
  await capture(page, `${info.project.name}-activity-error`);
  await page.unroute("**/api/audit");
  await page.getByRole("button", { name: "Повторить загрузку" }).click();
  await expect(page.locator(".activity-card")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await capture(page, `${info.project.name}-activity`);
  await navigate(page, "Настройки", mobile);
  await capture(page, `${info.project.name}-settings-dark`);
  await page.getByRole("button", { name: "Светлая тема", exact: true }).click();
  await capture(page, `${info.project.name}-settings-light`);
  await navigate(page, "Все записи", mobile);
  await page
    .getByLabel("Поиск записей", { exact: true })
    .fill("missing-synthetic-record");
  await capture(page, `${info.project.name}-empty`);
  await page.getByRole("button", { name: "Очистить поиск" }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  if (mobile) {
    await page.getByRole("button", { name: "Открыть навигацию" }).tap();
    await settle(page);
    expect(
      await page
        .locator(".sidebar")
        .evaluate((element) => getComputedStyle(element).transform),
    ).toBe("none");
    await capture(page, "mobile-navigation-reduced");
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Открыть навигацию" }),
    ).toBeFocused();
  }
  await page
    .getByRole("button", { name: "Открыть Cloudflare", exact: true })
    .click();
  const motion = await page.locator(".detail-pane").evaluate((element) => ({
    name: getComputedStyle(element).animationName,
    duration: getComputedStyle(element).animationDuration,
    scale: getComputedStyle(element).scale,
  }));
  expect(motion.name).toBe("surface-fade");
  expect(motion.duration).toBe("0.08s");
  await capture(page, `${info.project.name}-detail-reduced`);
  await writeFile(
    resolve(captures, `${info.project.name}-reduced.json`),
    JSON.stringify(motion, null, 2),
  );
});

test("login keeps its form until decryption finishes without a transient unlock screen", async ({
  page,
}, info) => {
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill("demo");
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.evaluate(() => {
    const states: string[] = [];
    (window as unknown as Record<string, unknown>).loginHeadings = states;
    const longTasks: number[] = [];
    (window as unknown as Record<string, unknown>).loginLongTasks = longTasks;
    new PerformanceObserver((entries) => {
      entries.getEntries().forEach((entry) => longTasks.push(entry.duration));
    }).observe({ type: "longtask" });
    new MutationObserver(() => {
      document
        .querySelectorAll("h1")
        .forEach((heading) => states.push(heading.textContent ?? ""));
    }).observe(document.getElementById("root")!, {
      childList: true,
      subtree: true,
    });
  });
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page
    .getByRole("button", { name: "Открыть Cloudflare", exact: true })
    .waitFor();
  const states = await page.evaluate(
    () => (window as unknown as Record<string, unknown>).loginHeadings,
  );
  expect(states).not.toContain("Хранилище заблокировано");
  const longTasks = await page.evaluate(
    () => (window as unknown as Record<string, unknown>).loginLongTasks,
  );
  await writeFile(
    resolve(captures, `${info.project.name}-login-states.json`),
    JSON.stringify({ states, longTasks }, null, 2),
  );
});
