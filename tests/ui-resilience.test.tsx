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
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  createIdentity,
  encryptJson,
  erase,
  randomKey,
  ready,
  recordContext,
  recordSchema,
  sealVaultKey,
  type DecryptedRecord,
  type Member,
  type StoredRecord,
} from "../packages/core/src/index.ts";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  copyToClipboard: vi.fn(),
  recoveryDownload: vi.fn(),
  setCsrf: vi.fn(),
}));
vi.mock("../apps/web/src/lib/api.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../apps/web/src/lib/api.ts")>()),
  ...mocks,
}));

import { RecordDetail } from "../apps/web/src/components/record-detail.tsx";
import { RecordEditor } from "../apps/web/src/components/record-editor.tsx";
import { Members } from "../apps/web/src/components/members.tsx";
import App from "../apps/web/src/App.tsx";
import { ApiError } from "../apps/web/src/lib/api.ts";
import { PageChromeProvider } from "../apps/web/src/layout/pageChrome.tsx";
import {
  useVault,
  type Session,
  type VaultStore,
} from "../apps/web/src/lib/store.tsx";

const vaultId = "20000000-0000-4000-8000-000000000001";
const ownerId = "20000000-0000-4000-8000-000000000002";
const recordId = "20000000-0000-4000-8000-000000000003";
let session: Session;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixtureStore(): VaultStore {
  return {
    session,
    records: [],
    keys: {
      current: { privateKey: randomKey(), vaultKey: randomKey() },
    },
    save: vi.fn().mockResolvedValue(recordId),
    lock: vi.fn(),
    refreshSession: vi.fn().mockResolvedValue(session),
  } as unknown as VaultStore;
}

function fixtureRecord(store: VaultStore, version = 1): DecryptedRecord {
  const data = recordSchema.parse({
    title: "Synthetic lifecycle record",
    type: "login",
    secret: "SYNTHETIC-ONLY-record-secret",
  });
  return {
    id: recordId,
    version,
    epoch: 1,
    box: encryptJson(
      data,
      store.keys.current!.vaultKey,
      recordContext(vaultId, recordId, version, 1),
    ),
    data,
    updatedAt: "2026-10-13T12:00:00.000Z",
    updatedBy: ownerId,
    deletedAt: null,
  };
}

function detailProps(record: DecryptedRecord, store: VaultStore) {
  return {
    record,
    store,
    open: true,
    onClose: vi.fn(),
    onEdit: vi.fn(),
    onExitComplete: vi.fn(),
  };
}

beforeAll(async () => {
  await ready;
  const { identity, privateKey } = createIdentity(
    "Synthetic UI resilience password!",
    ownerId,
  );
  erase(privateKey);
  session = {
    csrf: "synthetic-csrf",
    method: "password",
    passwordEnabled: true,
    identities: [],
    credentials: [],
    user: {
      id: ownerId,
      username: "synthetic-owner",
      displayName: "Synthetic Owner",
      role: "owner",
      status: "active",
      publicKey: identity.publicKey,
      identity,
      sealedKey: null,
      passkeyWraps: {},
      vaultId,
      vaultName: "Synthetic vault",
      epoch: 1,
      createdAt: "2026-10-13T12:00:00.000Z",
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.mockReset().mockResolvedValue({});
  mocks.copyToClipboard.mockReset().mockResolvedValue(undefined);
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("opens the app when browser storage rejects the theme preference", async () => {
  mocks.api.mockResolvedValue({
    initialized: false,
    providers: { github: false, telegram: false },
    rpId: "localhost",
  });
  vi.spyOn(window.Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Synthetic storage denial");
  });
  vi.spyOn(window.Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Synthetic storage denial");
  });
  render(<App />);
  expect(
    await screen.findByRole("heading", { name: "Создать хранилище" }),
  ).toBeTruthy();
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});

it("does not reveal a secret from an audit response after the detail was closed and reopened", async () => {
  const audit = deferred<unknown>();
  mocks.api.mockReturnValue(audit.promise);
  const store = fixtureStore();
  const record = fixtureRecord(store);
  const props = detailProps(record, store);
  const view = render(<RecordDetail {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Показать пароль" }));
  expect(mocks.api).toHaveBeenCalledTimes(1);
  view.rerender(<RecordDetail {...props} open={false} />);
  await act(async () => audit.resolve({}));
  view.rerender(<RecordDetail {...props} />);
  expect(document.body.textContent).not.toContain(record.data.secret);
  expect(screen.getByRole("button", { name: "Показать пароль" })).toBeTruthy();
});

it("does not copy a secret if the vault was locked while its audit request was pending", async () => {
  const audit = deferred<unknown>();
  mocks.api.mockReturnValue(audit.promise);
  const store = fixtureStore();
  const props = detailProps(fixtureRecord(store), store);
  render(<RecordDetail {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Копировать пароль" }));
  store.keys.current = null;
  await act(async () => audit.resolve({}));
  expect(mocks.copyToClipboard).not.toHaveBeenCalled();
});

it("keeps a record usable when its saved TOTP secret cannot generate a code", async () => {
  const store = fixtureStore();
  const record = fixtureRecord(store);
  record.data.totp = {
    secret: "SYNTHETIC-INVALID-BASE32-!",
    digits: 6,
    period: 30,
    algorithm: "SHA1",
  };
  const props = detailProps(record, store);
  render(<RecordDetail {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Показать код" }));
  const error = await screen.findByRole("alert");
  expect(error.textContent).toContain("Проверьте секрет TOTP");
  expect(document.body.textContent).not.toContain(record.data.totp.secret);
  fireEvent.click(screen.getByRole("button", { name: "Редактировать TOTP" }));
  expect(props.onEdit).toHaveBeenCalledOnce();
  expect(screen.getByRole("dialog", { name: record.data.title })).toBeTruthy();
});

it("saves a whitespace-padded otpauth link once and freezes edits while saving", async () => {
  const saved = deferred<{
    id: string;
    records: { id: string; version: number }[];
  }>();
  const store = fixtureStore();
  const operation = {
    body: { id: recordId, epoch: 1, records: [] },
    keys: store.keys.current!,
  };
  store.prepareBatch = vi.fn().mockReturnValue(operation);
  store.executeBatch = vi.fn().mockReturnValue(saved.promise);
  const onSaved = vi.fn();
  render(
    <RecordEditor
      store={store}
      open
      onClose={vi.fn()}
      onExitComplete={vi.fn()}
      onSaved={onSaved}
    />,
  );
  const title = screen.getByLabelText("Название");
  fireEvent.change(title, { target: { value: "Synthetic TOTP record" } });
  fireEvent.change(screen.getByLabelText("Секрет TOTP / ссылка otpauth://"), {
    target: {
      value:
        "  otpauth://totp/Synthetic?secret=JBSWY3DPEHPK3PXP&digits=8&period=60&algorithm=SHA256  ",
    },
  });
  const form = screen.getByRole("dialog").querySelector("form")!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(store.executeBatch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(store.prepareBatch).mock.calls[0]![0][0]!.data.totp).toEqual(
    {
      secret: "JBSWY3DPEHPK3PXP",
      digits: 8,
      period: 60,
      algorithm: "SHA256",
    },
  );
  expect(title.closest("fieldset")!.disabled).toBe(true);
  fireEvent.change(title, { target: { value: "Unsaved later edit" } });
  expect((title as HTMLInputElement).value).toBe("Synthetic TOTP record");
  await act(async () =>
    saved.resolve({ id: recordId, records: [{ id: recordId, version: 1 }] }),
  );
  expect(onSaved).toHaveBeenCalledOnce();
});

it("keeps the newest record response when concurrent refreshes finish in reverse order", async () => {
  const older = deferred<StoredRecord[]>();
  const newer = deferred<StoredRecord[]>();
  mocks.api.mockImplementation((path: string) =>
    path === "/auth/config"
      ? Promise.resolve({ initialized: false })
      : Promise.resolve({}),
  );
  const hook = renderHook(() => useVault());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  const store = fixtureStore();
  hook.result.current.keys.current = store.keys.current;
  const oldRecord = fixtureRecord(store, 1);
  const newRecord = fixtureRecord(store, 2);
  newRecord.data.title = "Newest synthetic record";
  newRecord.box = encryptJson(
    newRecord.data,
    store.keys.current!.vaultKey,
    recordContext(vaultId, recordId, 2, 1),
  );
  mocks.api
    .mockReturnValueOnce(older.promise)
    .mockReturnValueOnce(newer.promise);
  const first = hook.result.current.loadRecords(session);
  const second = hook.result.current.loadRecords(session);
  await act(async () => {
    newer.resolve([newRecord]);
    await second;
  });
  await act(async () => {
    older.resolve([oldRecord]);
    await first;
  });
  expect(hook.result.current.records[0]?.version).toBe(2);
  expect(hook.result.current.records[0]?.data.title).toBe(
    "Newest synthetic record",
  );
});

it("does not let a cancelled unlock clear the keys and records of a newer unlock", async () => {
  const older = deferred<StoredRecord[]>();
  const identity = createIdentity("Synthetic overlap password!", ownerId);
  const vaultKey = randomKey();
  const current: Session = {
    ...session,
    user: {
      ...session.user,
      identity: identity.identity,
      publicKey: identity.identity.publicKey,
      sealedKey: sealVaultKey(
        vaultKey,
        identity.identity.publicKey,
        vaultId,
        1,
      ),
    },
  };
  mocks.api.mockImplementation((path: string) =>
    path === "/auth/config"
      ? Promise.resolve({ initialized: false })
      : Promise.resolve({}),
  );
  const hook = renderHook(() => useVault());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  const store = fixtureStore();
  store.keys.current!.vaultKey = vaultKey;
  const record = fixtureRecord(store, 2);
  mocks.api.mockReturnValueOnce(older.promise).mockResolvedValueOnce([record]);
  const first = hook.result.current
    .unlockWithPrivate(identity.privateKey.slice(), current)
    .catch((error) => error as Error);
  act(() => hook.result.current.lock());
  await act(async () => {
    await hook.result.current.unlockWithPrivate(
      identity.privateKey.slice(),
      current,
    );
  });
  const newerKeys = hook.result.current.keys.current;
  expect(hook.result.current.unlocked).toBe(true);
  await act(async () => {
    older.resolve([record]);
    await first;
  });
  const firstError = await first;
  expect(firstError).toBeInstanceOf(Error);
  if (!(firstError instanceof Error))
    throw new Error("Expected cancelled unlock");
  expect(firstError.message).toContain("отменено");
  expect(hook.result.current.keys.current).toBe(newerKeys);
  expect(hook.result.current.unlocked).toBe(true);
  expect(hook.result.current.records[0]?.version).toBe(2);
  erase(identity.privateKey);
});

it("ignores a late 401 from an older session check after a new unlock succeeds", async () => {
  const olderSession = deferred<Session>();
  const identity = createIdentity(
    "Synthetic session overlap password!",
    ownerId,
  );
  const vaultKey = randomKey();
  const current: Session = {
    ...session,
    user: {
      ...session.user,
      identity: identity.identity,
      publicKey: identity.identity.publicKey,
      sealedKey: sealVaultKey(
        vaultKey,
        identity.identity.publicKey,
        vaultId,
        1,
      ),
    },
  };
  mocks.api.mockResolvedValue({ initialized: false });
  const hook = renderHook(() => useVault());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  mocks.api.mockReturnValueOnce(olderSession.promise).mockResolvedValueOnce([]);
  const check = hook.result.current.refreshSession();
  await act(async () => {
    await hook.result.current.unlockWithPrivate(
      identity.privateKey.slice(),
      current,
    );
  });
  const newerKeys = hook.result.current.keys.current;
  await act(async () => {
    olderSession.reject(new ApiError(401, "Synthetic expired session"));
    await check;
  });
  expect(hook.result.current.keys.current).toBe(newerKeys);
  expect(hook.result.current.unlocked).toBe(true);
  erase(identity.privateKey);
});

it("cancels an unlock before session lookup completes and erases PRF on a failed session request", async () => {
  const pendingSession = deferred<Session>();
  mocks.api.mockResolvedValue({ initialized: false });
  const hook = renderHook(() => useVault());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  mocks.api.mockReturnValueOnce(pendingSession.promise);
  const unlock = hook.result.current
    .unlock("Synthetic password that must never be used")
    .catch((error) => error as Error);
  act(() => hook.result.current.lock());
  await act(async () => {
    pendingSession.resolve(session);
    await unlock;
  });
  const unlockError = await unlock;
  expect(unlockError).toBeInstanceOf(Error);
  if (!(unlockError instanceof Error))
    throw new Error("Expected cancelled unlock");
  expect(unlockError.message).toContain("отменено");
  expect(hook.result.current.keys.current).toBeNull();
  expect(mocks.api.mock.calls.some(([path]) => path === "/records")).toBe(
    false,
  );
  const prf = randomKey();
  mocks.api.mockRejectedValueOnce(new Error("Synthetic unavailable session"));
  await expect(
    hook.result.current.passkeyUnlock("synthetic-passkey", prf),
  ).rejects.toThrow("Synthetic unavailable session");
  expect(prf.every((value) => value === 0)).toBe(true);
});

it("requires a saved rescue key and cancels rotation if its owner screen unmounts during the snapshot request", async () => {
  const snapshot = deferred<unknown>();
  const store = fixtureStore();
  const admin: Member = {
    ...session.user,
    id: "20000000-0000-4000-8000-000000000004",
    username: "synthetic-admin",
    displayName: "Synthetic Admin",
    role: "admin",
  };
  mocks.api.mockImplementation((path: string) =>
    path === "/members"
      ? Promise.resolve([session.user, admin])
      : snapshot.promise,
  );
  const view = render(
    <PageChromeProvider>
      <Members store={store} />
    </PageChromeProvider>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Отключить Synthetic Admin" }),
  );
  const confirmation = screen.getByRole("checkbox", {
    name: "Новый ключ сохранён отдельно от сервера",
  });
  expect((confirmation as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "Скачать новый rescue-ключ" }),
  );
  expect((confirmation as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(confirmation);
  fireEvent.click(
    screen.getByRole("button", { name: "Отключить и сменить ключ" }),
  );
  expect(mocks.api).toHaveBeenCalledWith("/rotation");
  view.unmount();
  await act(async () => {
    snapshot.resolve({
      snapshot: "synthetic-snapshot",
      epoch: 1,
      members: [session.user, admin],
      records: [],
      history: [],
    });
  });
  expect(
    mocks.api.mock.calls.some(
      ([path, method]) => path === "/rotation" && method === "POST",
    ),
  ).toBe(false);
});
