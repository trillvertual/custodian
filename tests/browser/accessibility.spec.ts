import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function audit(page: Page, surface: string) {
  // Measure settled colors and layout, excluding continuous indicators.
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
    await Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  expect(
    result.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      elements: nodes.map(({ target, any }) => ({
        target,
        contrast: any
          .filter((check) => check.id === "color-contrast")
          .map(({ data }) => ({
            foreground: data?.fgColor,
            background: data?.bgColor,
            ratio: data?.contrastRatio,
            required: data?.expectedContrastRatio,
          })),
      })),
    })),
    surface,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    `${surface}: document overflow`,
  ).toBe(true);
}

async function navigate(page: Page, title: string, mobile: boolean) {
  if (mobile)
    await page.getByRole("button", { name: "Открыть навигацию" }).click();
  await page
    .locator(".sidebar")
    .getByRole("button", {
      name: title === "Все записи" ? /^Все записи(?:\s|$)/ : title,
      exact: true,
    })
    .click();
}

test("login and first-run forms have accessible names, errors and branding", async ({
  page,
}) => {
  await page.goto("/");
  const entry = await page.locator('script[type="module"]').getAttribute("src");
  expect(entry).toBeTruthy();
  const asset = await page.request.get(entry!, {
    headers: { "Accept-Encoding": "br" },
  });
  expect(asset.headers()["content-encoding"]).toBe("br");
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    "type",
    "image/svg+xml",
  );
  await page.getByRole("heading", { name: "Вход в хранилище" }).waitFor();
  await audit(page, "login");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await audit(page, "login validation");
  await page.route("**/api/auth/config", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), initialized: false },
    });
  });
  await page.reload();
  await page.getByLabel("Код первоначальной настройки").waitFor();
  await audit(page, "setup");
});

test("vault flows meet automated WCAG checks in both themes and motion settings", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const mobile = info.project.name === "mobile";
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill("demo");
  await page
    .getByLabel("Пароль", { exact: true })
    .fill("Demo login password 2026!");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.getByRole("button", { name: "Открыть Cloudflare" }).waitFor();

  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
    }, theme);
    await audit(page, `${theme} vault`);
    await page.getByRole("button", { name: "Открыть Cloudflare" }).click();
    await audit(page, `${theme} record`);
    await page
      .getByRole("button", { name: "Редактировать", exact: true })
      .click();
    await page.getByLabel("Название", { exact: true }).waitFor();
    await audit(page, `${theme} editor`);
    await page.getByRole("button", { name: "Отмена", exact: true }).click();
    await expect(
      page.getByRole("dialog", {
        name: "Редактировать запись",
        includeHidden: true,
      }),
    ).toHaveCount(0);
    await page.evaluate(
      () => new Promise<void>((done) => requestAnimationFrame(() => done())),
    );
    await page.keyboard.press("Control+k");
    await expect(
      page.getByRole("dialog", { name: "Поиск записей" }),
    ).toBeVisible();
    await audit(page, `${theme} search`);
    await page.keyboard.press("Escape");
    for (const title of ["Настройки", "Команда", "Журнал действий"]) {
      await navigate(page, title, mobile);
      await page.getByRole("heading", { name: title, exact: true }).waitFor();
      await audit(page, `${theme} ${title}`);
    }
    await navigate(page, "Все записи", mobile);
  }

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.getByRole("button", { name: "Открыть Cloudflare" }).click();
  const dialog = page.getByRole("dialog", { name: "Cloudflare", exact: true });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Показать пароль" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Открыть Cloudflare" }).click();
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate((element) =>
      Math.max(
        ...getComputedStyle(element)
          .animationDuration.split(",")
          .map(
            (value) => parseFloat(value) * (value.includes("ms") ? 1 : 1000),
          ),
      ),
    ),
  ).toBeLessThanOrEqual(100);
  expect(errors).toEqual([]);
});
