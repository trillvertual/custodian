import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";

test("a non-PRF passkey opens a trusted browser without another password; revocation requires setup again", async ({
  page,
  context,
}, info) => {
  test.setTimeout(120000);
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        ctap2Version: "ctap2_1",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
        hasPrf: false,
      },
    },
  );
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill("demo");
  await page
    .getByLabel("Пароль", { exact: true })
    .fill("Demo login password 2026!");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page
    .getByRole("button", { name: "Открыть Cloudflare", exact: true })
    .waitFor();
  async function navigate(title: string) {
    if (info.project.name === "passkey-mobile")
      await page
        .getByRole("button", { name: "Открыть навигацию", exact: true })
        .click();
    await page
      .locator(".sidebar")
      .getByRole("button", { name: title, exact: true })
      .click();
    await page.getByRole("heading", { name: title, exact: true }).waitFor();
  }
  async function logout() {
    if (info.project.name === "passkey-mobile")
      await page
        .getByRole("button", { name: "Открыть навигацию", exact: true })
        .click();
    await page
      .getByRole("button", { name: "Выйти из аккаунта", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Вход в хранилище", exact: true })
      .waitFor();
  }
  await navigate("Настройки");
  const passkeyRow = page
    .locator(".enrollment-row")
    .filter({ has: page.locator("span", { hasText: /^Passkey$/ }) });
  await passkeyRow
    .getByRole("button", { name: "Подключить", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Настроить разблокировку", exact: true }),
  ).toBeVisible();
  const registered = await (await page.request.get("/api/auth/session")).json();
  expect(registered.credentials).toHaveLength(1);
  expect(registered.credentials[0].prf).toBe(false);
  await logout();
  await page
    .getByRole("button", { name: "Войти с Passkey", exact: true })
    .click();
  const unlock = page.locator("#custodian-unlock");
  await expect(unlock).toBeVisible();
  await expect(unlock.getByLabel("Логин", { exact: true })).toHaveValue("demo");
  await unlock
    .getByLabel("Пароль", { exact: true })
    .fill("Demo login password 2026!");
  await unlock
    .getByRole("checkbox", { name: "Доверять этому браузеру", exact: true })
    .check();
  await unlock
    .getByRole("button", { name: "Разблокировать", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Открыть Cloudflare", exact: true })
    .waitFor();
  const data = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("custodian-device-keys", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(Error());
    });
    return new Promise<{
      rows: string;
      key: { extractable: boolean; algorithm: string };
    }>((resolve, reject) => {
      const request = db
        .transaction("keys", "readonly")
        .objectStore("keys")
        .getAll();
      request.onsuccess = () => {
        db.close();
        resolve({
          rows: JSON.stringify(request.result),
          key: {
            extractable: request.result[0].key.extractable,
            algorithm: request.result[0].key.algorithm.name,
          },
        });
      };
      request.onerror = () => reject(Error());
    });
  });
  expect(data.key).toEqual({ extractable: false, algorithm: "AES-GCM" });
  expect(data.rows).not.toContain("ciphertext");
  await logout();
  let passwordRequests = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/auth/password"
    )
      passwordRequests++;
  });
  await page
    .getByRole("button", { name: "Войти с Passkey", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Открыть Cloudflare", exact: true })
    .waitFor();
  await expect(unlock).toHaveCount(0);
  expect(passwordRequests).toBe(0);
  // Reload retains only the local device key. A fresh passkey is still required.
  await page.reload();
  await page
    .getByRole("heading", { name: "Хранилище заблокировано", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Разблокировать с Passkey", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Открыть Cloudflare", exact: true })
    .waitFor();
  expect(passwordRequests).toBe(0);
  await navigate("Настройки");
  await page.getByRole("button", { name: "Настроить", exact: true }).click();
  const devices = page.getByRole("dialog", {
    name: "Доверенные браузеры",
    exact: true,
  });
  await expect(devices).toContainText("Мой браузер · этот браузер");
  for (const theme of ["dark", "light"]) {
    await page.evaluate(async (theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
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
    }, theme);
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "best-practice"])
      .analyze();
    expect(
      result.violations.map((violation) => ({
        id: violation.id,
        targets: violation.nodes.map((node) => node.target),
      })),
    ).toEqual([]);
    await mkdir(".impeccable/review", { recursive: true });
    await page.screenshot({
      path: `.impeccable/review/${info.project.name}-${theme}-trusted-browser.png`,
    });
  }
  await devices.getByRole("button", { name: "Забыть", exact: true }).click();
  await expect(devices).toContainText("Доверенных браузеров нет.");
  await devices.getByRole("button", { name: "Закрыть", exact: true }).click();
  await logout();
  await page
    .getByRole("button", { name: "Войти с Passkey", exact: true })
    .click();
  await expect(unlock).toBeVisible();
  await expect(
    unlock.getByRole("checkbox", {
      name: "Доверять этому браузеру",
      exact: true,
    }),
  ).not.toBeChecked();
  await unlock
    .getByLabel("Пароль", { exact: true })
    .fill("Demo login password 2026!");
  await unlock
    .getByRole("button", { name: "Разблокировать", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Открыть Cloudflare", exact: true })
    .waitFor();
  await navigate("Настройки");
  await page.getByRole("button", { name: "Настроить", exact: true }).click();
  await devices
    .getByLabel("Название браузера", { exact: true })
    .fill("Synthetic remembered from settings");
  await devices
    .getByRole("button", { name: "Запомнить этот браузер", exact: true })
    .click();
  await expect(devices).toContainText(
    "Synthetic remembered from settings · этот браузер",
  );
  await devices.getByRole("button", { name: "Закрыть", exact: true }).click();
  await logout();
  await page
    .getByRole("button", { name: "Войти с Passkey", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Открыть Cloudflare", exact: true })
    .waitFor();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("custodian-device-keys", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(Error());
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("keys", "readwrite");
      tx.objectStore("keys").clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => reject(Error());
    });
  });
  await logout();
  await page
    .getByRole("button", { name: "Войти с Passkey", exact: true })
    .click();
  await expect(unlock).toBeVisible();
  expect(passwordRequests).toBe(0);
  expect(failures).toEqual([]);
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
});
