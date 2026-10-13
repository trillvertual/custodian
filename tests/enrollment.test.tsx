import "./dom.ts";
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  createIdentity,
  erase,
  randomKey,
  ready,
} from "../packages/core/src/index.ts";
import type { Session, VaultStore } from "../apps/web/src/lib/store.tsx";

const webauthn = vi.hoisted(() => ({
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
  WebAuthnAbortService: { cancelCeremony: vi.fn() },
}));
vi.mock("@simplewebauthn/browser", () => webauthn);

import { Enrollment } from "../apps/web/src/components/auth.tsx";
import * as passkeys from "../apps/web/src/lib/passkey.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixtureStore(): VaultStore {
  const id = "30000000-0000-4000-8000-000000000001";
  const { identity, privateKey } = createIdentity(
    "Synthetic enrollment password!",
    id,
  );
  const session: Session = {
    csrf: "synthetic-csrf",
    method: "password",
    passwordEnabled: true,
    identities: [],
    credentials: [{ id: "synthetic-passkey", prf: false }],
    user: {
      id,
      username: "synthetic-owner",
      displayName: "Synthetic Owner",
      role: "owner",
      status: "active",
      publicKey: identity.publicKey,
      identity,
      sealedKey: null,
      passkeyWraps: {},
      vaultId: "30000000-0000-4000-8000-000000000002",
      vaultName: "Synthetic vault",
      epoch: 1,
      createdAt: "2026-10-13T12:00:00.000Z",
    },
  };
  return {
    session,
    unlocked: true,
    keys: { current: { privateKey, vaultKey: randomKey() } },
    refreshSession: vi.fn().mockResolvedValue(session),
  } as unknown as VaultStore;
}

beforeAll(async () => {
  await ready;
});
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("cancels enrollment after lock and unmount without copying a key during delayed registration options", async () => {
  const options = deferred<unknown>();
  const store = fixtureStore();
  const privateKey = store.keys.current!.privateKey;
  const copy = vi.spyOn(privateKey, "slice");
  const registration = vi.spyOn(passkeys, "registerPasskey");
  const fetchMock = vi.fn().mockReturnValue(options.promise);
  vi.stubGlobal("fetch", fetchMock);
  const view = render(<Enrollment store={store} />);
  fireEvent.click(screen.getByRole("button", { name: "Добавить" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(copy).not.toHaveBeenCalled();
  erase(store.keys.current!.privateKey);
  erase(store.keys.current!.vaultKey);
  store.keys.current = null;
  view.unmount();
  expect(webauthn.WebAuthnAbortService.cancelCeremony).toHaveBeenCalledOnce();
  const result = registration.mock.results[0]!.value as Promise<unknown>;
  await act(async () => {
    options.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        options: { challenge: "synthetic" },
        flow: "synthetic",
      }),
    });
    await expect(result).rejects.toThrow("Настройка Passkey отменена.");
  });
  expect(copy).not.toHaveBeenCalled();
  expect(webauthn.startRegistration).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledOnce();
});

it("rejects a late PRF ceremony after keys were replaced and keeps the replacement key untouched", async () => {
  const ceremony = deferred<unknown>();
  const store = fixtureStore();
  const privateKey = store.keys.current!.privateKey;
  const copy = vi.spyOn(privateKey, "slice");
  const authentication = vi.spyOn(passkeys, "authenticatePasskey");
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      options: { challenge: "synthetic" },
      flow: "synthetic",
    }),
  });
  vi.stubGlobal("fetch", fetchMock);
  webauthn.startAuthentication.mockReturnValue(ceremony.promise);
  const view = render(<Enrollment store={store} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Настроить разблокировку" }),
  );
  await waitFor(() =>
    expect(webauthn.startAuthentication).toHaveBeenCalledOnce(),
  );
  expect(copy).not.toHaveBeenCalled();
  const replacement = { privateKey: randomKey(), vaultKey: randomKey() };
  const expectedReplacement = Array.from(replacement.privateKey);
  erase(store.keys.current!.privateKey);
  erase(store.keys.current!.vaultKey);
  store.keys.current = replacement;
  view.rerender(<Enrollment store={store} />);
  const prf = randomKey();
  const result = authentication.mock.results[0]!.value as Promise<unknown>;
  await act(async () => {
    ceremony.resolve({
      id: "synthetic-passkey",
      clientExtensionResults: { prf: { results: { first: prf.buffer } } },
    });
    await expect(result).rejects.toThrow("Настройка Passkey отменена.");
  });
  expect(prf.every((value) => value === 0)).toBe(true);
  expect(copy).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(Array.from(replacement.privateKey)).toEqual(expectedReplacement);
  expect(screen.getByRole("alert").textContent).toBe(
    "Настройка Passkey отменена.",
  );
  erase(replacement.privateKey);
  erase(replacement.vaultKey);
});
