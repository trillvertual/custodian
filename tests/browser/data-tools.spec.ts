import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import QRCode from "qrcode";
import { mkdir } from "node:fs/promises";

test("password manager boundaries preserve account autofill and keep invitation output outside inputs", async ({
  page,
  context,
}, info) => {
  test.setTimeout(120000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  async function accountFields(
    form: ReturnType<Page["locator"]>,
    kind: "current-password" | "new-password",
    username?: string,
  ) {
    const login = form.locator('input[name="username"]');
    await expect(login).toHaveAttribute("autocomplete", "username");
    await expect(login).not.toHaveAttribute("data-bwignore");
    if (username) await expect(login).toHaveValue(username);
    const passwords = form.locator(
      'input[name="password"], input[name="new-password"], input[name="confirm-password"]',
    );
    expect(await passwords.count()).toBeGreaterThan(0);
    for (const password of await passwords.all()) {
      await expect(password).toHaveAttribute("autocomplete", kind);
      await expect(password).not.toHaveAttribute("data-bwignore");
    }
  }
  async function navigate(title: string) {
    if (info.project.name === "tools-mobile")
      await page
        .getByRole("button", { name: "Открыть навигацию", exact: true })
        .click();
    await page
      .locator(".sidebar")
      .getByRole("button", { name: title, exact: true })
      .click();
    await page.getByRole("heading", { name: title, exact: true }).waitFor();
  }
  await page.goto("/");
  await accountFields(page.locator("#custodian-login"), "current-password");
  await page.route("**/api/auth/config", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), initialized: false },
    });
  });
  await page.reload();
  await accountFields(page.locator("#custodian-registration"), "new-password");
  await expect(page.getByLabel("Код первоначальной настройки")).toHaveAttribute(
    "data-bwignore",
    "true",
  );
  await page.unroute("**/api/auth/config");
  await login(page);
  await page.reload();
  await page
    .getByRole("heading", { name: "Хранилище заблокировано", exact: true })
    .waitFor();
  await accountFields(
    page.locator("#custodian-unlock"),
    "current-password",
    "demo",
  );
  await unlock(page);
  await page
    .getByRole("button", { name: "Добавить запись", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "Новая запись",
    exact: true,
  });
  for (const input of await editor.locator("input,textarea").all()) {
    await expect(input).toHaveAttribute("data-bwignore", "true");
    await expect(input).toHaveAttribute("autocomplete", "off");
  }
  await editor
    .getByRole("button", { name: "Показать пароль", exact: true })
    .click();
  await expect(editor.getByLabel("Пароль", { exact: true })).toHaveAttribute(
    "type",
    "text",
  );
  await expect(editor.getByLabel("Пароль", { exact: true })).toHaveAttribute(
    "data-bwignore",
    "true",
  );
  await editor.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Новая запись", includeHidden: true }),
  ).toHaveCount(0);
  await navigate("Настройки");
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  await accountFields(
    page.locator("#custodian-change-password"),
    "new-password",
    "demo",
  );
  await navigate("Команда");
  await page.getByRole("button", { name: "Пригласить", exact: true }).click();
  const invite = page.getByRole("dialog", {
    name: "Приглашение в команду",
    exact: true,
  });
  const value = invite.getByRole("textbox", {
    name: "Ссылка приглашения",
    exact: true,
  });
  await expect(value).toHaveAttribute("aria-readonly", "true");
  await expect(
    invite.locator("input,textarea,[contenteditable=true]"),
  ).toHaveCount(0);
  const url = (await value.textContent())!;
  expect(new URL(url).searchParams.get("invite")).toBeTruthy();
  await value.focus();
  await page.keyboard.press("Control+a");
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
    url,
  );
  await page.keyboard.press("Control+c");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(url);
  await invite
    .getByRole("button", { name: "Копировать приглашение", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(url);
  await value.focus();
  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      (theme) =>
        document.documentElement.classList.toggle("dark", theme === "dark"),
      theme,
    );
    await audit(page, `${info.project.name}-${theme}-invitation-output`);
  }
  await invite.getByRole("button", { name: "Закрыть", exact: true }).click();
  if (info.project.name === "tools-mobile")
    await page
      .getByRole("button", { name: "Открыть навигацию", exact: true })
      .click();
  await page
    .getByRole("button", { name: "Выйти из аккаунта", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Вход в хранилище", exact: true })
    .waitFor();
  await page.goto(url);
  await page
    .getByRole("heading", { name: "Присоединиться к команде", exact: true })
    .waitFor();
  const signup = page.locator("#custodian-registration");
  await accountFields(signup, "new-password");
  await signup
    .getByLabel("Ваше имя", { exact: true })
    .fill("Synthetic Bitwarden Admin");
  await signup
    .getByLabel("Логин", { exact: true })
    .fill(`bw-${info.project.name}`);
  await signup
    .getByLabel("Пароль", { exact: true })
    .fill("SYNTHETIC-bw-registration-password!");
  await signup
    .getByLabel("Повторите пароль", { exact: true })
    .fill("SYNTHETIC-bw-registration-password!");
  await signup
    .getByRole("button", { name: "Создать аккаунт", exact: true })
    .click();
  await page
    .getByRole("heading", {
      name: "Нужно подтверждение владельца",
      exact: true,
    })
    .waitFor();
});

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
async function unlock(page: Page) {
  await page
    .getByRole("heading", { name: "Хранилище заблокировано" })
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
}
async function audit(page: Page, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
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
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "best-practice"])
    .analyze();
  expect(
    result.violations.map((value) => ({
      id: value.id,
      target: value.nodes.map((node) => node.target),
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

test("dialog actions and long labels stay inside their clipping containers at every width", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  await login(page);
  const widths = [320, 390, 512, 760, 761, 900, 1440, 1920];
  async function fits(dialog: ReturnType<Page["getByRole"]>) {
    await expect(dialog).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    for (const viewport of [
      ...widths.map((width) => ({ width, height: 900 })),
      { width: 900, height: 320 },
      { width: 320, height: 480 },
    ]) {
      await page.setViewportSize(viewport);
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      const clipped = await dialog.evaluate((element) => {
        const failures: string[] = [];
        for (const button of element.querySelectorAll<HTMLElement>(
          '[data-slot="button"]',
        )) {
          if (!button.getClientRects().length) continue;
          const box = button.getBoundingClientRect();
          let left = 0,
            right = innerWidth;
          for (
            let parent = button.parentElement;
            parent;
            parent = parent.parentElement
          ) {
            if (
              /auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowX)
            ) {
              const clip = parent.getBoundingClientRect();
              left = Math.max(left, clip.left + parent.clientLeft);
              right = Math.min(
                right,
                clip.left + parent.clientLeft + parent.clientWidth,
              );
            }
          }
          if (
            box.left < left - 1 ||
            box.right > right + 1 ||
            button.scrollWidth > button.clientWidth + 1 ||
            button.scrollHeight > button.clientHeight + 1
          )
            failures.push(
              button.textContent?.trim() ||
                button.getAttribute("aria-label") ||
                "button",
            );
        }
        return failures;
      });
      expect(
        clipped,
        `${viewport.width}×${viewport.height}: action is clipped`,
      ).toEqual([]);
    }
  }
  await page
    .getByRole("button", { name: "Добавить запись", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "Новая запись",
    exact: true,
  });
  await editor
    .getByLabel("Название", { exact: true })
    .fill("Synthetic layout draft");
  await editor.getByRole("button", { name: "Сканировать QR для 2FA" }).click();
  const qr = page.getByRole("dialog", { name: "Добавить 2FA через QR" });
  await fits(qr);
  await qr.getByRole("button", { name: "Закрыть", exact: true }).click();
  await editor.getByRole("button", { name: "Отмена", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Закрыть без сохранения?" });
  await expect(confirm.locator(".dialog-actions button")).toHaveCount(3);
  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      (theme) =>
        document.documentElement.classList.toggle("dark", theme === "dark"),
      theme,
    );
    await fits(confirm);
    await page.setViewportSize({
      width: info.project.name === "tools-mobile" ? 390 : 1440,
      height: 900,
    });
    await audit(page, `${info.project.name}-${theme}-discard-actions`);
  }
  await confirm
    .getByRole("button", { name: "Продолжить редактирование", exact: true })
    .click();
  await expect(confirm).toBeHidden();
  await expect(editor.getByLabel("Название", { exact: true })).toHaveValue(
    "Synthetic layout draft",
  );
  await editor.getByRole("button", { name: "Отмена", exact: true }).click();
  await confirm
    .getByRole("button", { name: "Сохранить черновик и закрыть", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Новая запись", includeHidden: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Черновики", exact: true }).click();
  const drafts = page.getByRole("dialog", { name: "Личные черновики" });
  await expect(drafts).toContainText("Synthetic layout draft");
  await fits(drafts);
  await drafts.getByRole("button", { name: "Удалить", exact: true }).click();
  const remove = page.getByRole("dialog", {
    name: "Удалить черновик?",
    exact: true,
  });
  await fits(remove);
  await remove
    .getByRole("button", { name: "Удалить черновик", exact: true })
    .click();
  await expect(drafts).toContainText("Черновиков нет");
  await drafts
    .locator(".dialog-actions")
    .getByRole("button", { name: "Закрыть", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Открыть Cloudflare", exact: true })
    .click();
  const record = page.getByRole("dialog", { name: "Cloudflare", exact: true });
  await fits(record);
  await record
    .getByRole("button", { name: "Переместить в корзину", exact: true })
    .click();
  await fits(
    page.getByRole("dialog", {
      name: "Переместить запись в корзину?",
      exact: true,
    }),
  );
  await page
    .getByRole("dialog", { name: "Переместить запись в корзину?", exact: true })
    .getByRole("button", { name: "Отмена", exact: true })
    .click();
  await record
    .getByRole("button", { name: "Закрыть сведения", exact: true })
    .click();
  await page.getByRole("button", { name: "Импорт", exact: true }).click();
  await fits(page.getByRole("dialog", { name: "Импорт записей", exact: true }));
});

test("CSV import previews duplicates and uses encrypted atomic batches; selection changes folder and tags", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await login(page);
  const one = `Synthetic import ${info.project.name} one`,
    two = `Synthetic import ${info.project.name} two`,
    secret = "SYNTHETIC-only-import-password";
  await page.getByRole("button", { name: "Импорт", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Импорт записей" });
  await dialog.getByLabel("Файл для импорта").setInputFiles({
    name: "synthetic.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      `name,username,password,folder\n${one},synthetic,${secret},VPN\n${two},synthetic,${secret},VPN\n${one},synthetic,${secret},VPN`,
    ),
  });
  await expect(dialog).toContainText("Выбрано 2 из 3");
  await expect(dialog).toContainText("Уже есть");
  await expect(dialog).not.toContainText(secret);
  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      (theme) =>
        document.documentElement.classList.toggle("dark", theme === "dark"),
      theme,
    );
    await audit(page, `${info.project.name}-${theme}-import-preview`);
  }
  const save = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/records/batch") &&
      response.request().method() === "POST",
  );
  await dialog
    .getByRole("button", { name: "Импортировать (2)", exact: true })
    .click();
  const result = await save;
  expect(result.ok()).toBe(true);
  expect(result.request().postData()).not.toContain(secret);
  expect(result.request().postData()).not.toContain(one);
  expect(result.request().postData()).not.toContain("synthetic");
  expect((await result.json()).records).toHaveLength(2);
  await expect(dialog).toBeHidden();
  await page
    .getByLabel("Поиск записей", { exact: true })
    .fill(`Synthetic import ${info.project.name}`);
  await page
    .getByRole("checkbox", {
      name: "Выбрать все показанные записи",
      exact: true,
    })
    .check();
  await expect(page.getByText("Выбрано: 2", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Изменить выбранные", exact: true })
    .click();
  const bulk = page.getByRole("dialog", { name: "Изменить выбранные записи" });
  await bulk.getByRole("button", { name: "Папка", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Поиск папок" })
    .fill(`Bulk ${info.project.name}`);
  await page.keyboard.press("Enter");
  await audit(page, `${info.project.name}-bulk-folder`);
  await bulk
    .getByRole("button", { name: "Применить (2)", exact: true })
    .click();
  await expect(bulk).toBeHidden();
  await expect(page.getByText("Выбрано: 0", { exact: true })).toBeVisible();
  await page
    .getByRole("checkbox", {
      name: "Выбрать все показанные записи",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Изменить выбранные", exact: true })
    .click();
  await bulk.getByLabel("Действие", { exact: true }).click();
  await page
    .getByRole("option", { name: "Добавить теги", exact: true })
    .click();
  await bulk
    .getByRole("button", { name: "Добавить теги", exact: true })
    .click();
  await page.getByRole("combobox", { name: "Поиск тегов" }).fill("batch-tag");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await bulk
    .getByRole("button", { name: "Применить (2)", exact: true })
    .click();
  await expect(bulk).toBeHidden();
  await page
    .getByRole("button", { name: `Открыть ${one}`, exact: true })
    .click();
  await expect(page.locator(".detail-pane")).toContainText(
    `Bulk ${info.project.name}`,
  );
  await expect(page.locator(".detail-pane")).toContainText("batch-tag");
  await page.getByRole("button", { name: "Закрыть сведения" }).click();
  await page.getByLabel("Поиск записей", { exact: true }).fill("");
  await page
    .getByRole("checkbox", { name: `Выбрать ${one}`, exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: `Выбрать ${two}`, exact: true })
    .check();
  await page
    .getByRole("button", { name: "Изменить выбранные", exact: true })
    .click();
  await bulk.getByLabel("Действие", { exact: true }).click();
  await page
    .getByRole("option", { name: "Переместить в корзину", exact: true })
    .click();
  await bulk.getByRole("button", { name: "В корзину", exact: true }).click();
  await expect(
    page.getByRole("button", { name: `Открыть ${one}`, exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: `Открыть ${two}`, exact: true }),
  ).toHaveCount(0);
});

test("encrypted drafts survive an immediate reload and restore after unlock; explicit discard deletes them", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  await login(page);
  await page
    .getByRole("button", { name: "Добавить запись", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "Новая запись" });
  const title = `Synthetic draft ${info.project.name}`,
    secret = "SYNTHETIC-only-draft-password";
  await editor.getByLabel("Название", { exact: true }).fill(title);
  await editor.getByLabel("Пароль", { exact: true }).fill(secret);
  await page.reload();
  await unlock(page);
  await expect(
    page.getByRole("button", { name: `Открыть ${title}`, exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Черновики", exact: true }).click();
  const drafts = page.getByRole("dialog", { name: "Личные черновики" });
  await expect(drafts).toContainText(title);
  await expect(drafts).not.toContainText(secret);
  await audit(page, `${info.project.name}-encrypted-drafts`);
  const persisted = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("custodian-personal", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(Error());
    });
    return await new Promise<unknown[]>((resolve, reject) => {
      const request = db
        .transaction("drafts", "readonly")
        .objectStore("drafts")
        .getAll();
      request.onsuccess = () => {
        db.close();
        resolve(request.result);
      };
      request.onerror = () => reject(Error());
    });
  });
  expect(JSON.stringify(persisted)).not.toContain(secret);
  expect(JSON.stringify(persisted)).not.toContain(title);
  await drafts
    .getByRole("button", { name: "Восстановить", exact: true })
    .click();
  await expect(editor.getByLabel("Название", { exact: true })).toHaveValue(
    title,
  );
  await expect(editor.getByLabel("Пароль", { exact: true })).toHaveValue(
    secret,
  );
  await editor
    .getByLabel("Заметка", { exact: true })
    .fill("Synthetic restored note");
  await editor.getByRole("button", { name: "Отмена", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Закрыть без сохранения?" });
  await confirm
    .getByRole("button", { name: "Не сохранять", exact: true })
    .click();
  await expect(editor).toBeHidden();
  await expect(
    page.getByRole("dialog", { name: "Новая запись", includeHidden: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Черновики", exact: true }).click();
  await expect(drafts).toContainText("Черновиков нет");
});

test("TOTP QR is decoded locally from an image and preserves digits, algorithm and period", async ({
  page,
  context,
}, info) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page);
  await page
    .getByRole("button", { name: "Добавить запись", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "Новая запись" });
  await editor
    .getByRole("button", { name: "Сканировать QR для 2FA", exact: true })
    .click();
  const qr = page.getByRole("dialog", { name: "Добавить 2FA через QR" });
  const uri =
    "otpauth://totp/Synthetic:demo?secret=AAAAAAAAAAAAAAAA&issuer=Synthetic&algorithm=SHA256&digits=8&period=60";
  const image = await QRCode.toBuffer(uri, { width: 512, margin: 4 });
  const leaks: string[] = [];
  page.on("request", (request) => {
    if (request.postData()?.includes("AAAAAAAAAAAAAAAA"))
      leaks.push(request.url());
  });
  await qr.getByLabel("Изображение с QR-кодом").setInputFiles({
    name: "synthetic-qr.png",
    mimeType: "image/png",
    buffer: image,
  });
  await expect(qr).toContainText("8 цифр · 60 секунд · SHA256");
  await audit(page, `${info.project.name}-qr-confirm`);
  await qr
    .getByRole("button", { name: "Использовать 2FA", exact: true })
    .click();
  await expect(
    editor.getByLabel("Секрет TOTP / ссылка otpauth://", { exact: true }),
  ).toHaveValue(uri);
  await editor
    .getByLabel("Название", { exact: true })
    .fill(`Synthetic QR ${info.project.name}`);
  await editor
    .getByRole("button", { name: "Создать запись", exact: true })
    .click();
  await expect(page.locator(".detail-pane h2")).toHaveText(
    `Synthetic QR ${info.project.name}`,
  );
  await page.getByRole("button", { name: "Показать код", exact: true }).click();
  await page
    .getByRole("button", { name: "Копировать код 2FA", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toMatch(/^\d{8}$/);
  expect(leaks).toEqual([]);
});

test("paste and camera stay local; late camera permissions are stopped after closing", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  await login(page);
  await page
    .getByRole("button", { name: "Добавить запись", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "Новая запись" });
  await editor
    .getByRole("button", { name: "Сканировать QR для 2FA", exact: true })
    .click();
  const qr = page.getByRole("dialog", { name: "Добавить 2FA через QR" });
  const uri =
      "otpauth://totp/Synthetic:camera?secret=AAAAAAAAAAAAAAAA&issuer=Synthetic&digits=8&period=60&algorithm=SHA256",
    buffer = await QRCode.toBuffer(uri, { width: 512, margin: 4 });
  await page.evaluate(async (base64) => {
    const blob = new Blob(
        [Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))],
        { type: "image/png" },
      ),
      transfer = new DataTransfer();
    transfer.items.add(
      new File([blob], "synthetic-paste.png", { type: "image/png" }),
    );
    window.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer }),
    );
  }, buffer.toString("base64"));
  await expect(qr).toContainText("8 цифр · 60 секунд · SHA256");
  await qr.getByRole("button", { name: "Другой QR", exact: true }).click();
  await page.evaluate(() => {
    const state = window as Window & {
      resolveMedia?: (stream: MediaStream) => void;
    };
    navigator.mediaDevices.getUserMedia = () =>
      new Promise((resolve) => {
        state.resolveMedia = resolve;
      });
  });
  await qr
    .getByRole("button", { name: "Использовать камеру", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          typeof (window as Window & { resolveMedia?: unknown }).resolveMedia,
      ),
    )
    .toBe("function");
  await page.keyboard.press("Escape");
  await expect(qr).toBeHidden();
  await page.evaluate(() => {
    const state = window as Window & {
      resolveMedia?: (stream: MediaStream) => void;
      testStream?: MediaStream;
    };
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 240;
    state.testStream = canvas.captureStream(5);
    state.resolveMedia!(state.testStream);
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as Window & { testStream?: MediaStream })
          .testStream!.getTracks()
          .every((track) => track.readyState === "ended"),
      ),
    )
    .toBe(true);
  await editor
    .getByRole("button", { name: "Сканировать QR для 2FA", exact: true })
    .click();
  await page.evaluate(async (base64) => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    canvas.getContext("2d")!.drawImage(image, 0, 0);
    const state = window as Window & { liveStream?: MediaStream };
    state.liveStream = canvas.captureStream(5);
    navigator.mediaDevices.getUserMedia = async () => state.liveStream!;
  }, buffer.toString("base64"));
  await qr
    .getByRole("button", { name: "Использовать камеру", exact: true })
    .click();
  await expect(qr).toContainText("8 цифр · 60 секунд · SHA256");
  expect(
    await page.evaluate(() =>
      (window as Window & { liveStream?: MediaStream })
        .liveStream!.getTracks()
        .every((track) => track.readyState === "ended"),
    ),
  ).toBe(true);
  await audit(page, `${info.project.name}-camera-confirm`);
});

test("an uncertain save retries the same ciphertext and does not create a second record", async ({
  page,
}, info) => {
  await login(page);
  const title = `Synthetic retry ${info.project.name}`;
  await page
    .getByRole("button", { name: "Добавить запись", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "Новая запись" });
  await editor.getByLabel("Название", { exact: true }).fill(title);
  await editor
    .getByLabel("Пароль", { exact: true })
    .fill("SYNTHETIC-only-retry");
  let firstPayload = "",
    secondPayload = "",
    requests = 0;
  await page.route("**/api/records/batch", async (route) => {
    requests++;
    if (requests === 1) {
      firstPayload = route.request().postData()!;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort("failed");
    } else {
      secondPayload = route.request().postData()!;
      await route.continue();
    }
  });
  await editor
    .getByRole("button", { name: "Создать запись", exact: true })
    .click();
  await expect(
    editor.getByRole("button", { name: "Повторить сохранение", exact: true }),
  ).toBeVisible();
  await expect(editor.getByLabel("Название", { exact: true })).toBeDisabled();
  await editor
    .getByRole("button", { name: "Повторить сохранение", exact: true })
    .click();
  await expect(page.locator(".detail-pane h2")).toHaveText(title);
  expect(secondPayload).toBe(firstPayload);
  expect(requests).toBe(2);
  await page.getByRole("button", { name: "Закрыть сведения" }).click();
  await expect(
    page.getByRole("button", { name: `Открыть ${title}`, exact: true }),
  ).toHaveCount(1);
});
