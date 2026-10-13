import { afterEach, beforeAll, beforeEach, it, expect, vi } from "vitest";
import {
  ready,
  createIdentity,
  randomKey,
  encode,
  unlockPasskey,
  erase,
} from "../packages/core/src/index.ts";
const webauthn = vi.hoisted(() => ({
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
  WebAuthnAbortService: { cancelCeremony: vi.fn() },
}));
vi.mock("@simplewebauthn/browser", () => webauthn);
import {
  authenticatePasskey,
  registerPasskey,
  type PasskeyEnrollmentOperation,
} from "../apps/web/src/lib/passkey.ts";
import { api, setCsrf } from "../apps/web/src/lib/api.ts";
let calls: {
  path: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}[];
function enrollment(privateKey: Uint8Array): PasskeyEnrollmentOperation {
  return { assertActive: () => {}, getPrivateKey: () => privateKey };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeAll(async () => {
  await ready;
});
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  calls = [];
  vi.resetAllMocks();
  setCsrf("initial");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(init.body as string) : {};
      calls.push({
        path,
        body,
        headers: init.headers as Record<string, string>,
      });
      const result = path.endsWith("/options")
        ? { options: { challenge: "fixture" }, flow: "fixture" }
        : path.endsWith("/auth/passkey/verify")
          ? { csrf: "renewed" }
          : { ok: true };
      return { ok: true, status: 200, json: async () => result };
    }),
  );
});
it("obtains PRF on a second assertion, renews CSRF, and sends only an encrypted wrap", async () => {
  const identity = createIdentity("Password for passkey tests!", "alice"),
    prf = randomKey();
  webauthn.startRegistration.mockResolvedValue({
    id: "fixture",
    clientExtensionResults: { prf: { enabled: true } },
  });
  webauthn.startAuthentication.mockResolvedValue({
    id: "fixture",
    clientExtensionResults: { prf: { results: { first: encode(prf) } } },
  });
  const result = await registerPasskey(
    enrollment(identity.privateKey),
    "alice",
  );
  expect(result.prf).toBe(true);
  const wrapCall = calls.find((x) => x.path.endsWith("/wrap"))!;
  expect(wrapCall.headers["X-CSRF-Token"]).toBe("renewed");
  expect(
    unlockPasskey(wrapCall.body.wrap as never, prf, "alice", "fixture"),
  ).toEqual(identity.privateKey);
  expect(JSON.stringify(calls)).not.toContain(encode(prf));
  expect(JSON.stringify(calls)).not.toContain(encode(identity.privateKey));
  expect(
    webauthn.startAuthentication.mock.calls[0]![0].optionsJSON.allowCredentials,
  ).toEqual([{ id: "fixture", type: "public-key" }]);
  erase(prf);
  erase(identity.privateKey);
});
it("keeps password required if the authenticator never returns PRF", async () => {
  const identity = createIdentity("Password for passkey tests!", "alice");
  webauthn.startRegistration.mockResolvedValue({
    id: "fixture",
    clientExtensionResults: {},
  });
  webauthn.startAuthentication.mockResolvedValue({
    id: "fixture",
    clientExtensionResults: {},
  });
  expect(
    (await registerPasskey(enrollment(identity.privateKey), "alice")).prf,
  ).toBe(false);
  expect(calls.some((x) => x.path.endsWith("/wrap"))).toBe(false);
  erase(identity.privateKey);
});
it("does not claim a decrypting passkey when envelope persistence fails", async () => {
  const identity = createIdentity("Password for passkey tests!", "alice"),
    prf = randomKey();
  webauthn.startRegistration.mockResolvedValue({
    id: "fixture",
    clientExtensionResults: { prf: { enabled: true } },
  });
  webauthn.startAuthentication.mockResolvedValue({
    id: "fixture",
    clientExtensionResults: { prf: { results: { first: encode(prf) } } },
  });
  const normal = fetch;
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) =>
    path.endsWith("/wrap")
      ? {
          ok: false,
          status: 403,
          json: async () => ({ error: "Fixture failure" }),
        }
      : normal(path, init),
  );
  expect(
    (await registerPasskey(enrollment(identity.privateKey), "alice")).prf,
  ).toBe(false);
  erase(prf);
  erase(identity.privateKey);
});
it("does not retain or read a private key while registration options are pending", async () => {
  const options = deferred<unknown>();
  let active = true;
  const operation: PasskeyEnrollmentOperation = {
    assertActive: () => {
      if (!active) throw new Error("Synthetic enrollment cancelled");
    },
    getPrivateKey: vi.fn(),
  };
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(options.promise));
  const registration = registerPasskey(operation, "alice");
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(operation.getPrivateKey).not.toHaveBeenCalled();
  active = false;
  options.resolve({
    ok: true,
    status: 200,
    json: async () => ({ options: { challenge: "fixture" }, flow: "fixture" }),
  });
  await expect(registration).rejects.toThrow("Synthetic enrollment cancelled");
  expect(webauthn.startRegistration).not.toHaveBeenCalled();
  expect(operation.getPrivateKey).not.toHaveBeenCalled();
});

it("erases late PRF output and skips verification when the registration prompt outlives its operation", async () => {
  const ceremony = deferred<unknown>();
  const prf = randomKey();
  let active = true;
  const operation: PasskeyEnrollmentOperation = {
    assertActive: () => {
      if (!active) throw new Error("Synthetic enrollment cancelled");
    },
    getPrivateKey: vi.fn(),
  };
  webauthn.startRegistration.mockReturnValue(ceremony.promise);
  const registration = registerPasskey(operation, "alice");
  await vi.waitFor(() =>
    expect(webauthn.startRegistration).toHaveBeenCalledOnce(),
  );
  active = false;
  ceremony.resolve({
    id: "fixture",
    clientExtensionResults: { prf: { results: { first: prf.buffer } } },
  });
  await expect(registration).rejects.toThrow("Synthetic enrollment cancelled");
  expect(prf.every((value) => value === 0)).toBe(true);
  expect(operation.getPrivateKey).not.toHaveBeenCalled();
  expect(calls.some((call) => call.path.endsWith("/verify"))).toBe(false);
});

it("erases its temporary key copy before awaiting envelope persistence and preserves the live key", async () => {
  const identity = createIdentity(
    "Synthetic guarded passkey password!",
    "alice",
  );
  const originalKey = encode(identity.privateKey);
  const copies: Uint8Array[] = [];
  const slice = identity.privateKey.slice.bind(identity.privateKey);
  vi.spyOn(identity.privateKey, "slice").mockImplementation((start, end) => {
    const copy = slice(start, end);
    copies.push(copy);
    return copy;
  });
  const prf = randomKey();
  const response = deferred<unknown>();
  let active = true;
  const operation: PasskeyEnrollmentOperation = {
    assertActive: () => {
      if (!active) throw new Error("Synthetic enrollment cancelled");
    },
    getPrivateKey: () => identity.privateKey,
  };
  webauthn.startRegistration.mockResolvedValue({
    id: "fixture",
    clientExtensionResults: { prf: { results: { first: prf.buffer } } },
  });
  const normal = fetch;
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    const result = await normal(path, init);
    return path.endsWith("/register/verify") ? response.promise : result;
  });
  const registration = registerPasskey(operation, "alice");
  await vi.waitFor(() =>
    expect(calls.some((call) => call.path.endsWith("/register/verify"))).toBe(
      true,
    ),
  );
  expect(copies).toHaveLength(1);
  expect(copies[0]!.every((value) => value === 0)).toBe(true);
  expect(encode(identity.privateKey)).toBe(originalKey);
  active = false;
  response.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
  await expect(registration).rejects.toThrow("Synthetic enrollment cancelled");
  expect(prf.every((value) => value === 0)).toBe(true);
  expect(encode(identity.privateKey)).toBe(originalKey);
  erase(identity.privateKey);
});

it("stops the second PRF assertion on cancellation without sending a wrap", async () => {
  const assertion = deferred<unknown>();
  const prf = randomKey();
  let active = true;
  const operation: PasskeyEnrollmentOperation = {
    assertActive: () => {
      if (!active) throw new Error("Synthetic enrollment cancelled");
    },
    getPrivateKey: vi.fn(),
  };
  webauthn.startRegistration.mockResolvedValue({
    id: "fixture",
    clientExtensionResults: { prf: { enabled: true } },
  });
  webauthn.startAuthentication.mockReturnValue(assertion.promise);
  const registration = registerPasskey(operation, "alice");
  await vi.waitFor(() =>
    expect(webauthn.startAuthentication).toHaveBeenCalledOnce(),
  );
  active = false;
  assertion.resolve({
    id: "fixture",
    clientExtensionResults: { prf: { results: { first: prf.buffer } } },
  });
  await expect(registration).rejects.toThrow("Synthetic enrollment cancelled");
  expect(prf.every((value) => value === 0)).toBe(true);
  expect(operation.getPrivateKey).not.toHaveBeenCalled();
  expect(calls.some((call) => call.path.endsWith("/wrap"))).toBe(false);
});

it("does not publish late authentication CSRF and erases PRF after guarded verification is cancelled", async () => {
  const verification = deferred<unknown>();
  const prf = randomKey();
  let active = true;
  const guard = () => {
    if (!active) throw new Error("Synthetic enrollment cancelled");
  };
  webauthn.startAuthentication.mockResolvedValue({
    id: "fixture",
    clientExtensionResults: { prf: { results: { first: prf.buffer } } },
  });
  const normal = fetch;
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    const result = await normal(path, init);
    return path.endsWith("/auth/passkey/verify")
      ? verification.promise
      : result;
  });
  const authentication = authenticatePasskey("fixture", guard);
  await vi.waitFor(() =>
    expect(
      calls.some((call) => call.path.endsWith("/auth/passkey/verify")),
    ).toBe(true),
  );
  active = false;
  verification.resolve({
    ok: true,
    status: 200,
    json: async () => ({ csrf: "late-csrf" }),
  });
  await expect(authentication).rejects.toThrow(
    "Synthetic enrollment cancelled",
  );
  expect(prf.every((value) => value === 0)).toBe(true);
  // The next authorized request must retain the current session's CSRF token.
  await api("/synthetic", "POST");
  expect(calls.at(-1)!.headers["X-CSRF-Token"]).toBe("initial");
});
