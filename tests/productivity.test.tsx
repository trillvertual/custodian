import "./dom.ts";
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  recordSchema,
  totp,
  type DecryptedRecord,
} from "../packages/core/src/index.ts";
import {
  recordFromTemplate,
  recordTemplates,
  similarRecord,
} from "../apps/web/src/lib/record-presets.ts";
import {
  readRecentRecords,
  useRecentRecords,
} from "../apps/web/src/lib/recent-records.ts";
import type { VaultStore } from "../apps/web/src/lib/store.tsx";
const mocks = vi.hoisted(() => ({ api: vi.fn(), copyToClipboard: vi.fn() }));
vi.mock("../apps/web/src/lib/api.ts", () => mocks);
import { SearchPalette } from "../apps/web/src/components/search-palette.tsx";
const id = "20000000-0000-4000-8000-000000000003";
function fixture() {
  const store = {
    keys: {
      current: { vaultKey: new Uint8Array(32), privateKey: new Uint8Array(32) },
    },
  } as VaultStore;
  const record = {
    id,
    version: 1,
    deletedAt: null,
    data: recordSchema.parse({
      title: "Synthetic quick action",
      type: "login",
      username: "synthetic-login",
      secret: "SYNTHETIC-only-password",
      totp: {
        secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
        digits: 6,
        period: 30,
        algorithm: "SHA1",
      },
    }),
  } as DecryptedRecord;
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    onSelect: vi.fn(),
    store,
    records: [record],
    recentIds: [],
    onRemember: vi.fn(),
  };
  return { store, record, props };
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.api.mockResolvedValue({});
  mocks.copyToClipboard.mockResolvedValue(undefined);
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("presets are valid, independent and contain no credentials", () => {
  for (const template of recordTemplates) {
    const first = recordFromTemplate(template.id),
      second = recordFromTemplate(template.id);
    expect(
      recordSchema.safeParse({ ...first, title: "Synthetic template" }).success,
    ).toBe(true);
    expect([first.secret, first.username, first.url, first.note]).toEqual([
      "",
      "",
      "",
      "",
    ]);
    expect(first.totp).toBeNull();
    expect(
      first.fields
        .filter((field) => field.secret)
        .every((field) => field.value === ""),
    ).toBe(true);
    first.tags.push("mutated");
    if (first.fields[0]) first.fields[0].value = "mutated";
    expect(second).toEqual(recordFromTemplate(template.id));
  }
});
it("similar records clear every value channel, retain independent structure, and fit the title limit", () => {
  const source = recordSchema.parse({
    title: "x".repeat(200),
    type: "ssh",
    url: "secret-url",
    username: "secret-user",
    secret: "secret",
    note: "secret-note",
    folder: "Nodes",
    tags: ["vpn"],
    favorite: true,
    totp: { secret: "GEZDGNBV", digits: 6, period: 30, algorithm: "SHA1" },
    fields: [
      { name: "Port", value: "secret-unmarked", secret: false },
      { name: "Passphrase", value: "secret-marked", secret: true },
    ],
  });
  const before = structuredClone(source),
    copy = similarRecord(source);
  expect([copy.url, copy.username, copy.secret, copy.note]).toEqual([
    "",
    "",
    "",
    "",
  ]);
  expect(copy.totp).toBeNull();
  expect(copy.favorite).toBe(false);
  expect(copy.fields).toEqual([
    { name: "Port", value: "", secret: false },
    { name: "Passphrase", value: "", secret: true },
  ]);
  expect(copy.title.length).toBeLessThanOrEqual(200);
  expect(recordSchema.safeParse(copy).success).toBe(true);
  copy.tags.push("changed");
  copy.fields[0]!.name = "Changed";
  expect(source).toEqual(before);
});
it("recents persist only bounded UUIDs and isolate users and vaults", () => {
  const hook = renderHook(({ user }) => useRecentRecords("vault", user), {
    initialProps: { user: "one" },
  });
  act(() => {
    for (let n = 0; n < 12; n++)
      hook.result.current.remember(
        `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      );
    hook.result.current.remember("secret-password");
  });
  expect(hook.result.current.ids).toHaveLength(8);
  expect(localStorage.getItem("custodian:recent:v1:vault:one")).not.toContain(
    "secret-password",
  );
  hook.rerender({ user: "two" });
  expect(hook.result.current.ids).toEqual([]);
  act(() => hook.result.current.remember(id));
  expect(hook.result.current.ids).toEqual([id]);
  hook.rerender({ user: "one" });
  expect(hook.result.current.ids).toHaveLength(8);
  expect(hook.result.current.ids).not.toContain(id);
  localStorage.setItem("bad", "{broken");
  expect(readRecentRecords("bad")).toEqual([]);
  vi.spyOn(window.Storage.prototype, "getItem").mockImplementation(() => {
    throw Error("denied");
  });
  expect(readRecentRecords("bad")).toEqual([]);
});
it.each(["closed", "locked", "replaced keys", "changed query"])(
  "cancels delayed secret copy when %s",
  async (state) => {
    let resolve!: () => void;
    mocks.api.mockReturnValue(new Promise<void>((done) => (resolve = done)));
    const { store, props } = fixture();
    const ui = render(<SearchPalette {...props} />);
    const button = await screen.findByRole("button", {
      name: "Копировать Пароль",
    });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mocks.api).toHaveBeenCalledTimes(1);
    if (state === "closed")
      ui.rerender(<SearchPalette {...props} open={false} />);
    else if (state === "locked") store.keys.current = null;
    else if (state === "replaced keys")
      store.keys.current = {
        vaultKey: new Uint8Array(32),
        privateKey: new Uint8Array(32),
      };
    else
      fireEvent.change(screen.getByLabelText("Быстрый поиск"), {
        target: { value: "absent" },
      });
    await act(async () => resolve());
    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
    expect(props.onRemember).not.toHaveBeenCalled();
  },
);
it("copies TOTP at completion of the audit and keeps secrets out of the DOM", async () => {
  let resolve!: () => void;
  mocks.api.mockReturnValue(new Promise<void>((done) => (resolve = done)));
  const { record, props } = fixture();
  render(<SearchPalette {...props} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Копировать 2FA" }),
  );
  const time = 1234567890000;
  vi.spyOn(Date, "now").mockReturnValue(time);
  await act(async () => resolve());
  expect(mocks.copyToClipboard).toHaveBeenCalledWith(
    totp(record.data.totp!, time).code,
  );
  expect(props.onRemember).toHaveBeenCalledWith(id);
  expect(document.body.textContent).not.toContain(record.data.secret);
  expect(document.body.textContent).not.toContain(record.data.totp!.secret);
});
it("copies login without a secret audit; failed secret audits and malformed TOTP cannot copy", async () => {
  const { props, record } = fixture();
  const ui = render(<SearchPalette {...props} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Копировать Логин" }),
  );
  await waitFor(() => expect(props.onRemember).toHaveBeenCalledWith(id));
  expect(mocks.api).not.toHaveBeenCalled();
  expect(mocks.copyToClipboard).toHaveBeenCalledWith(record.data.username);
  mocks.copyToClipboard.mockClear();
  mocks.api.mockRejectedValueOnce(Error("denied"));
  fireEvent.click(screen.getByRole("button", { name: "Копировать Пароль" }));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Копировать Пароль" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(mocks.copyToClipboard).not.toHaveBeenCalled();
  ui.rerender(
    <SearchPalette
      {...props}
      records={[
        {
          ...record,
          version: 2,
          data: {
            ...record.data,
            totp: { ...record.data.totp!, secret: "INVALID!" },
          },
        },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Копировать 2FA" }));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Копировать 2FA" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(mocks.copyToClipboard).not.toHaveBeenCalled();
});
