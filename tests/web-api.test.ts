import "./dom.ts";
import { beforeEach, expect, it, vi } from "vitest";
import { api, ApiError, copyToClipboard } from "../apps/web/src/lib/api.ts";

beforeEach(() => {
  vi.restoreAllMocks();
});

it("keeps 401 and 403 error semantics when a proxy returns an HTML error page", async () => {
  for (const status of [401, 403]) {
    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status,
      json: async () => {
        throw new SyntaxError("Synthetic HTML response");
      },
    }));
    const error = await api("/synthetic").catch((value) => value);
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw error;
    expect(error.status).toBe(status);
    expect(error.message).toContain(
      status === 401 ? "Сессия истекла" : "Недостаточно прав",
    );
  }
});

it("shows an actionable connection error without exposing browser implementation messages", async () => {
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("Failed to fetch");
  });
  await expect(api("/synthetic")).rejects.toThrow(
    "Не удалось связаться с сервером. Проверьте соединение и повторите запрос.",
  );
});

it("reports missing Clipboard API and denied permissions with Russian recovery instructions", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  await expect(copyToClipboard("SYNTHETIC-ONLY-value")).rejects.toThrow(
    "Откройте Custodian по HTTPS",
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn().mockRejectedValue(new Error("Synthetic denial")),
    },
  });
  await expect(copyToClipboard("SYNTHETIC-ONLY-value")).rejects.toThrow(
    "Проверьте разрешения браузера",
  );
});
