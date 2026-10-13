import { expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export async function verifyCustomControls(page: Page, device: string) {
  const dir = resolve(".impeccable/review");
  await mkdir(dir, { recursive: true });
  const capture = async (name: string) => {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: resolve(dir, `controls-${device}-${name}.png`),
      // A mobile full-page capture resizes the viewport and dismisses Radix Select.
      // Dialogs and their popups are fixed surfaces, so capture the actual viewport.
      fullPage: false,
      animations: "disabled",
    });
  };
  await page
    .getByRole("button", { name: "Открыть Cloudflare", exact: true })
    .click();
  const detail = page.locator(".detail-pane");
  const reveal = detail.getByRole("button", {
    name: "Показать пароль",
    exact: true,
  });
  await reveal.focus();
  await expect(page.getByRole("tooltip")).toHaveText("Показать пароль");
  await capture("detail-tooltip-dark");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toBeHidden();
  await expect(detail).toBeVisible();
  await page.getByRole("button", { name: "Закрыть сведения" }).click();

  await page
    .getByRole("button", { name: "Добавить запись", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "Новая запись",
    exact: true,
  });
  await editor
    .getByRole("button", { name: "Создать запись", exact: true })
    .click();
  await expect(editor.getByRole("alert")).toHaveText(
    "Заполните поле «Название».",
  );
  await expect(editor.getByLabel("Название", { exact: true })).toBeFocused();
  await expect(editor.getByLabel("Название", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  const title = `Custom controls ${device}`;
  await editor.getByLabel("Название", { exact: true }).fill(title);
  await expect(editor.getByRole("alert")).toHaveCount(0);
  const type = editor.getByRole("combobox", { name: "Тип записи" });
  await type.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("listbox")).toBeVisible();
  await capture("type-dark");
  await expect(page.getByRole("listbox")).toBeVisible();
  const tokenOption = page.getByRole("option", {
    name: "API-токен",
    exact: true,
  });
  if (device === "mobile") await tokenOption.tap();
  else await tokenOption.click();
  await expect(type).toHaveText("API-токен");
  await expect(type).toBeFocused();
  await editor
    .getByLabel("API-токен", { exact: true })
    .fill("SYNTHETIC-TOKEN-controls-check");

  await editor.getByRole("button", { name: "Папка", exact: true }).click();
  const folders = page.getByRole("combobox", { name: "Поиск папок" });
  await folders.fill("Инфраструктура");
  await page.keyboard.press("Enter");
  await expect(
    editor.getByRole("button", { name: "Папка", exact: true }),
  ).toHaveText("Инфраструктура");
  await editor.getByRole("button", { name: "Папка", exact: true }).click();
  await folders.fill(`Controls ${device}`);
  await page.keyboard.press("Enter");
  await expect(
    editor.getByRole("button", { name: "Папка", exact: true }),
  ).toHaveText(`Controls ${device}`);

  const tags = editor.getByRole("button", { name: "Теги", exact: true });
  await tags.click();
  const tagSearch = page.getByRole("combobox", { name: "Поиск тегов" });
  await tagSearch.fill("production");
  if (device === "mobile")
    await page.getByRole("option", { name: "production", exact: true }).tap();
  else await page.keyboard.press("Enter");
  await expect(
    page.getByRole("option", { name: "production", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await tagSearch.fill("custom-controls");
  await page.keyboard.press("Enter");
  await expect(
    editor.getByRole("button", { name: "Удалить тег custom-controls" }),
  ).toBeAttached();
  await capture("tags-dark");
  await page.keyboard.press("Escape");
  await expect(tagSearch).toBeHidden();
  await expect(editor).toBeVisible();
  await expect(tags).toBeFocused();
  await editor
    .getByRole("button", { name: "Удалить тег production", exact: true })
    .click();
  await expect(
    editor.getByRole("button", { name: "Удалить тег production", exact: true }),
  ).toHaveCount(0);

  await editor.getByRole("button", { name: "Добавить", exact: true }).click();
  await editor.getByLabel("Название поля 1").fill("node port");
  await editor.getByLabel("Значение поля 1").fill("2222");
  const checkbox = editor.getByRole("checkbox", {
    name: "Секрет",
    exact: true,
  });
  expect(await checkbox.evaluate((element) => element.tagName)).toBe("BUTTON");
  await checkbox.focus();
  await page.keyboard.press("Space");
  await expect(checkbox).not.toBeChecked();
  await expect(
    page.locator('datalist, [title], select:not([aria-hidden="true"])'),
  ).toHaveCount(0);
  await capture("editor-dark");
  await editor
    .getByRole("button", { name: "Создать запись", exact: true })
    .click();
  await expect(editor).toBeHidden();
  const saved = page.getByRole("dialog", { name: title, exact: true });
  await expect(saved).toBeVisible();
  await expect(saved).toContainText(`Controls ${device}`);
  await expect(saved.locator(".tag-list")).toHaveText("custom-controls");
  await expect(saved).toContainText("2222");
  await expect(
    page.locator('[data-sonner-toast][data-visible="true"]'),
  ).toHaveCount(0);
  await capture("token-dark");
  await saved.getByRole("button", { name: "Закрыть сведения" }).click();
  await page.getByRole("button", { name: "Светлая тема" }).click();
  await page
    .getByRole("button", { name: `Открыть ${title}`, exact: true })
    .click();
  await capture("token-light");
  await page
    .getByRole("button", { name: "Редактировать", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Редактировать запись", exact: true }),
  ).toBeVisible();
  await capture("editor-light");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Закрыть сведения" }).click();
  await page.getByRole("button", { name: "Тёмная тема" }).click();
}
