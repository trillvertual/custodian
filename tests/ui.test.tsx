import "./dom.ts";
import React from "react";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { Blob as NodeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { testDatabase } from "./database.ts";
import { migrate, type Database } from "../apps/server/src/db.ts";
import { buildApp } from "../apps/server/src/app.ts";
import { ready } from "../packages/core/src/index.ts";
import App from "../apps/web/src/App.tsx";
import type { FastifyInstance } from "fastify";
let db: Database,
  app: FastifyInstance,
  cookie = "";
const downloads: Blob[] = [];
beforeAll(async () => {
  await ready;
  db = await testDatabase();
  await migrate(db);
  app = await buildApp(db, { serveStatic: false, logger: false });
  await app.ready();
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("Blob", NodeBlob);
  URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => {
    downloads.push(blob as Blob);
    return "blob:synthetic-download";
  });
  URL.revokeObjectURL = vi.fn(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal("fetch", async (path: string, options: RequestInit = {}) => {
    const headers = options.headers as Record<string, string> | undefined;
    const response = await app.inject({
      method: (options.method ?? "GET") as "GET" | "POST" | "PUT" | "DELETE",
      url: path,
      headers: {
        ...headers,
        origin: "http://localhost:5173",
        ...(cookie ? { cookie } : {}),
      },
      payload: options.body as string | undefined,
    });
    if (response.headers["set-cookie"])
      cookie = String(response.headers["set-cookie"]).split(";")[0]!;
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      json: async () => response.json(),
    };
  });
});
afterAll(async () => {
  cleanup();
  vi.restoreAllMocks();

  await app?.close();
  await db?.end();
});
it("keeps rescue material before continuing, encrypts an edited record, and clears secrets on lock", async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("heading", { name: "Создать хранилище" });
  await user.type(
    screen.getByLabelText("Код первоначальной настройки"),
    process.env.SETUP_TOKEN!,
  );
  await user.type(screen.getByLabelText("Ваше имя"), "Test Owner");
  await user.type(screen.getByLabelText("Логин"), "owner");
  await user.type(
    screen.getByLabelText("Пароль"),
    "Unforgettable password phrase 42!",
  );
  await user.type(
    screen.getByLabelText("Повторите пароль"),
    "Unforgettable password phrase 42!",
  );
  await user.click(screen.getByRole("button", { name: "Создать хранилище" }));
  await screen.findByRole("heading", { name: "Сохраните rescue-ключ" });
  expect(
    (screen.getByRole("button", { name: "Продолжить" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.queryByRole("button", { name: "Добавить запись" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Скачать rescue-ключ" }));
  expect(downloads.length).toBe(1);
  expect(await downloads[0]!.text()).toMatch(/^SVR1\.[A-Za-z0-9_-]{43}/);
  await user.click(screen.getByLabelText("Я сохранил файл в надёжном месте"));
  await user.click(screen.getByRole("button", { name: "Продолжить" }));
  await screen.findByRole("heading", { name: "Нет записей" });
  await user.click(
    screen.getAllByRole("button", { name: "Добавить запись" })[0]!,
  );
  await screen.findByRole("dialog", { name: "Новая запись" });
  await user.type(screen.getByLabelText("Название"), "Cloudflare - UI test");
  await user.type(screen.getByLabelText("Пароль"), "Never-send-plaintext-42!");
  await user.click(screen.getByRole("button", { name: "Создать запись" }));
  await screen.findByRole("dialog", { name: "Cloudflare - UI test" });
  const rows = (await db.query("SELECT box FROM records")).rows;
  expect(JSON.stringify(rows)).not.toContain("Never-send-plaintext-42!");
  expect(JSON.stringify(rows)).not.toContain("Cloudflare - UI test");
  expect(document.body.textContent).not.toContain("Never-send-plaintext-42!");
  await user.click(screen.getByRole("button", { name: "Показать пароль" }));
  await waitFor(() =>
    expect(document.body.textContent).toContain("Never-send-plaintext-42!"),
  );
  await user.click(screen.getByRole("button", { name: "Заблокировать" }));
  await screen.findByRole("heading", { name: "Хранилище заблокировано" });
  expect(document.body.textContent).not.toContain("Never-send-plaintext-42!");
  expect(document.body.textContent).not.toContain("Cloudflare - UI test");
  // A single login action must authenticate AND decrypt, including after a reload/logout.
  await user.click(screen.getByRole("button", { name: "Выйти из аккаунта" }));
  await screen.findByRole("heading", { name: "Вход в хранилище" });
  await user.type(screen.getByLabelText("Логин"), "owner");
  await user.type(
    screen.getByLabelText("Пароль"),
    "Unforgettable password phrase 42!",
  );
  await user.click(screen.getByRole("button", { name: "Войти" }));
  await screen.findByRole("button", { name: "Открыть Cloudflare - UI test" });
  expect(
    screen.queryByRole("heading", { name: "Хранилище заблокировано" }),
  ).toBeNull();
  expect(document.body.textContent).not.toMatch(
    /мастер.парол|не рекомендуется/i,
  );
  await user.click(screen.getByRole("button", { name: "Настройки" }));
  await screen.findByRole("heading", { name: "Способы входа" });
  expect(
    (screen.getByRole("button", { name: "Отключить" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "Изменить" }));
  await user.type(
    screen.getByLabelText("Новый пароль"),
    "Changed unified password 2026!",
  );
  await user.type(
    screen.getByLabelText("Повторите пароль"),
    "Changed unified password 2026!",
  );
  await user.click(screen.getByRole("button", { name: "Сохранить пароль" }));
  await waitFor(() =>
    expect(screen.queryByLabelText("Новый пароль")).toBeNull(),
  );
  await user.click(screen.getByRole("button", { name: "Выйти из аккаунта" }));
  await screen.findByRole("heading", { name: "Вход в хранилище" });
  await user.type(screen.getByLabelText("Логин"), "owner");
  await user.type(
    screen.getByLabelText("Пароль"),
    "Changed unified password 2026!",
  );
  await user.click(screen.getByRole("button", { name: "Войти" }));
  // After login the vault returns to all records and decrypts with the new password.
  await screen.findByRole("button", { name: "Открыть Cloudflare - UI test" });
});
