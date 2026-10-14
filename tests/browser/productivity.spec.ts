import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill("demo");
  await page
    .getByLabel("Пароль", { exact: true })
    .fill("Demo login password 2026!");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page
    .getByRole("button", { name: "Открыть Cloudflare", exact: true })
    .waitFor();
}
async function settled(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    );
  });
}
async function inspect(page: Page, name: string) {
  await settled(page);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "best-practice"])
    .analyze();
  expect(
    result.violations.map((v) => ({
      id: v.id,
      targets: v.nodes.map((n) => n.target),
    })),
    name,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    name,
  ).toBe(true);
  await mkdir(".impeccable/review", { recursive: true });
  await page.screenshot({
    path: `.impeccable/review/${name}.png`,
    animations: "disabled",
  });
}
async function closeEditor(page: Page) {
  await page.getByRole("button", { name: "Отмена", exact: true }).click();
  const discard = page.getByRole("dialog", { name: "Закрыть без сохранения?" });
  if (await discard.isVisible())
    await discard
      .getByRole("button", { name: "Не сохранять", exact: true })
      .click();
  await expect(
    page.getByRole("dialog", { name: "Новая запись", includeHidden: true }),
  ).toHaveCount(0);
}

test("quick actions, recents, infrastructure presets and similar records", async ({
  page,
  context,
}, info) => {
  test.setTimeout(120000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Поиск записей" });
  const search = palette.getByRole("combobox");
  await search.fill("Cloudflare");
  await palette.getByRole("button", { name: "Копировать Логин" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("infra@example.com");
  await expect(palette).toBeVisible();
  await expect(page.locator("body")).not.toContainText(
    "DEMO-ONLY-secret-2026!",
  );
  await search.focus();
  await page.keyboard.press("Control+Enter");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("DEMO-ONLY-secret-2026!");
  await search.focus();
  await page.keyboard.press("Control+Shift+Enter");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toMatch(/^\d{6}$/);
  for (const [query, label, value] of [
    ["GitHub · deploy token", "API-токен", "DEMO-ONLY-secret-2026!"],
    ["Finland · SSH", "SSH-ключ", "DEMO SSH KEY - NOT A REAL PRIVATE KEY"],
  ]) {
    await search.fill(query!);
    await palette.getByRole("button", { name: `Копировать ${label}` }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(value);
  }
  await search.fill("");
  await expect(palette).toContainText("Недавние");
  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      (theme) =>
        document.documentElement.classList.toggle("dark", theme === "dark"),
      theme,
    );
    await inspect(page, `${info.project.name}-${theme}-quick-actions`);
  }
  const stored = await page.evaluate(() =>
    Object.entries(localStorage).filter(([key]) =>
      key.startsWith("custodian:recent:"),
    ),
  );
  expect(stored).toHaveLength(1);
  expect(JSON.parse(stored[0]![1])).toHaveLength(3);
  expect(stored[0]![1]).not.toMatch(/Cloudflare|DEMO|infra@example/);
  await page.keyboard.press("Escape");
  await page.reload();
  await page
    .getByRole("heading", { name: "Хранилище заблокировано", exact: true })
    .waitFor();
  await page
    .getByLabel("Пароль", { exact: true })
    .fill("Demo login password 2026!");
  await page
    .getByRole("button", { name: "Разблокировать", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Открыть Cloudflare", exact: true })
    .waitFor();
  await page.keyboard.press("Control+k");
  await expect(
    page.getByRole("dialog", { name: "Поиск записей" }),
  ).toContainText("Недавние");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Добавить запись", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "Новая запись" });
  await editor.locator("#record-template").click();
  await page.getByRole("option", { name: "SSH-сервер", exact: true }).click();
  await expect(editor.locator("#record-type")).toContainText("SSH-ключ");
  await expect(editor.getByLabel("Папка", { exact: true })).toContainText(
    "Инфраструктура",
  );
  await editor
    .getByLabel("Название", { exact: true })
    .fill("Synthetic template draft");
  await editor.locator("#record-template").click();
  await page.getByRole("option", { name: "PostgreSQL", exact: true }).click();
  const confirm = page.getByRole("dialog", {
    name: "Применить другой шаблон?",
  });
  await expect(confirm).toBeVisible();
  await inspect(page, `${info.project.name}-replace-template`);
  await confirm.getByRole("button", { name: "Оставить поля" }).click();
  await expect(editor.getByLabel("Название", { exact: true })).toHaveValue(
    "Synthetic template draft",
  );
  await editor.locator("#record-template").click();
  await page.getByRole("option", { name: "PostgreSQL", exact: true }).click();
  await page
    .getByRole("button", { name: "Применить шаблон", exact: true })
    .click();
  await expect(editor.getByLabel("Название", { exact: true })).toHaveValue("");
  await expect(editor.getByLabel("Папка", { exact: true })).toContainText(
    "Базы данных",
  );
  await inspect(page, `${info.project.name}-postgres-template`);
  await closeEditor(page);
  await page
    .getByRole("button", { name: "Открыть Cloudflare", exact: true })
    .click();
  const source = await page.request.get("/api/records");
  const before = await source.json();
  await page
    .getByRole("button", { name: "Создать похожую", exact: true })
    .click();
  await expect(editor.getByLabel("Название", { exact: true })).toHaveValue(
    "Cloudflare (копия)",
  );
  for (const label of ["Сайт / адрес", "Логин", "Пароль", "Заметка"]) {
    await expect(editor.getByLabel(label, { exact: true })).toHaveValue("");
  }
  await expect(editor.getByLabel("Папка", { exact: true })).toContainText(
    "Инфраструктура",
  );
  await inspect(page, `${info.project.name}-similar-record`);
  const saved = page.waitForResponse(
    (response) =>
      response.url().includes("/api/records/") &&
      response.request().method() === "PUT",
  );
  await editor
    .getByRole("button", { name: "Создать запись", exact: true })
    .click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  expect(await response.text()).not.toContain("Cloudflare");
  await expect(page.locator(".detail-pane h2")).toHaveText(
    "Cloudflare (копия)",
  );
  const after = await (await page.request.get("/api/records")).json();
  expect(after).toHaveLength(before.length + 1);
  for (const original of before)
    expect(after.find((r: { id: string }) => r.id === original.id)).toEqual(
      original,
    );
  await page.getByRole("button", { name: "Закрыть сведения" }).click();
  await page
    .getByRole("button", { name: "Открыть Cloudflare", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Копировать пароль", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("DEMO-ONLY-secret-2026!");
  expect(errors).toEqual([]);
});
