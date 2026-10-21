import "./dom.ts";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import type { FastifyInstance } from "fastify";
import { testDatabase } from "./database.ts";
import { migrate, type Database } from "../apps/server/src/db.ts";
import { buildApp } from "../apps/server/src/app.ts";
import { hash } from "../apps/server/src/security.ts";
import {
  ready,
  createIdentity,
  randomKey,
  createRecovery,
  sealVaultKey,
  deriveLoginSecret,
  encode,
  type TrustedBrowserContext,
} from "../packages/core/src/index.ts";
import {
  localBrowserKeys,
  rememberBrowser,
  openTrustedBrowser,
  decryptBrowserIdentity,
} from "../apps/web/src/lib/trusted-browser.ts";
import { setCsrf } from "../apps/web/src/lib/api.ts";
import type { Session } from "../apps/web/src/lib/store.tsx";

let db: Database,
  app: FastifyInstance,
  cookie = "",
  csrf = "",
  deviceId = "",
  session: Session;
const userId = crypto.randomUUID(),
  vaultId = crypto.randomUUID();
let owner: ReturnType<typeof createIdentity>, vaultKey: Uint8Array;
async function request(
  path: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: unknown,
) {
  return app.inject({
    method,
    url: `/api${path}`,
    headers: {
      origin: "http://localhost:5173",
      cookie,
      "x-csrf-token": csrf,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}
function credentials(id: string) {
  return {
    id: randomBytes(32).toString("base64url"),
    userId: id,
    pair: generateKeyPairSync("ec", { namedCurve: "prime256v1" }),
    counter: 0,
  };
}
let ownerKey: ReturnType<typeof credentials>;
async function addCredential(key: ReturnType<typeof credentials>) {
  const jwk = key.pair.publicKey.export({ format: "jwk" });
  const cose = Buffer.concat([
    Buffer.from("a5010203262001215820", "hex"),
    Buffer.from(jwk.x!, "base64url"),
    Buffer.from("225820", "hex"),
    Buffer.from(jwk.y!, "base64url"),
  ]);
  await db.query(
    "INSERT INTO credentials(id,user_id,public_key,counter,transports,device_type,backed_up) VALUES($1,$2,$3,0,'[]','singleDevice',false)",
    [key.id, key.userId, cose],
  );
}
async function signIn(key = ownerKey) {
  const options = (await request("/auth/passkey/options", "POST", {})).json();
  const client = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: options.options.challenge,
      origin: "http://localhost:5173",
      crossOrigin: false,
    }),
  );
  const authenticator = Buffer.alloc(37);
  createHash("sha256").update("localhost").digest().copy(authenticator);
  authenticator[32] = 0x05;
  authenticator.writeUInt32BE(++key.counter, 33);
  const signature = sign(
    "sha256",
    Buffer.concat([
      authenticator,
      createHash("sha256").update(client).digest(),
    ]),
    key.pair.privateKey,
  );
  const result = await request("/auth/passkey/verify", "POST", {
    flow: options.flow,
    response: {
      id: key.id,
      rawId: key.id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: client.toString("base64url"),
        authenticatorData: authenticator.toString("base64url"),
        signature: signature.toString("base64url"),
        userHandle: Buffer.from(key.userId).toString("base64url"),
      },
    },
  });
  expect(result.statusCode).toBe(200);
  cookie = String(result.headers["set-cookie"]).split(";")[0]!;
  csrf = result.json().csrf;
  setCsrf(csrf);
  session = (await request("/auth/session")).json();
  expect(session.credentialId).toBe(key.id);
}
beforeAll(async () => {
  await ready;
  db = await testDatabase();
  await migrate(db);
  app = await buildApp(db, { serveStatic: false, logger: false });
  await app.ready();
  owner = createIdentity("SYNTHETIC trusted browser password!", userId);
  vaultKey = randomKey();
  const result = await request("/auth/bootstrap", "POST", {
    setupToken: process.env.SETUP_TOKEN,
    id: userId,
    vaultId,
    vaultName: "Synthetic browser trust",
    username: "trusted-owner",
    displayName: "Synthetic Owner",
    identity: owner.identity,
    sealedKey: sealVaultKey(vaultKey, owner.identity.publicKey, vaultId, 1),
    recovery: createRecovery(vaultKey, vaultId, 1).box,
    loginSecret: deriveLoginSecret(
      "SYNTHETIC trusted browser password!",
      "trusted-owner",
      "localhost",
    ),
  });
  expect(result.statusCode).toBe(200);
  cookie = String(result.headers["set-cookie"]).split(";")[0]!;
  csrf = result.json().csrf;
  ownerKey = credentials(userId);
  await addCredential(ownerKey);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const response = await request(
        path.replace(/^\/api/, ""),
        (init?.method ?? "GET") as "GET" | "POST" | "DELETE",
        init?.body ? JSON.parse(init.body as string) : undefined,
      );
      return {
        ok: response.statusCode < 400,
        status: response.statusCode,
        json: async () => response.json(),
      };
    }),
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
  await db.end();
});

it("a genuine non-PRF assertion remembers a browser; storage holds only a nonextractable key and server metadata excludes ciphertext", async () => {
  await signIn();
  deviceId = await rememberBrowser(
    session,
    { assertActive() {}, getPrivateKey: () => owner.privateKey },
    "Synthetic browser",
  );
  const local = await localBrowserKeys(userId, vaultId);
  expect(local).toHaveLength(1);
  expect(local[0]!.key.extractable).toBe(false);
  await expect(crypto.subtle.exportKey("raw", local[0]!.key)).rejects.toThrow();
  expect(JSON.stringify(local)).not.toContain(encode(owner.privateKey));
  expect(JSON.stringify(local)).not.toContain("ciphertext");
  const list = await request("/auth/trusted-devices");
  expect(list.statusCode).toBe(200);
  expect(list.json()).toHaveLength(1);
  expect(list.body).not.toContain("ciphertext");
  expect(list.body).not.toContain('"box"');
  const opened = await openTrustedBrowser(session, ownerKey.id, () => {});
  expect(opened).toEqual(owner.privateKey);
  opened?.fill(0);
  expect(
    (await request(`/auth/trusted-devices/${deviceId}/unlock`, "POST", {}))
      .statusCode,
  ).toBe(403);
});
it("AES-GCM authenticates all scope fields and rejects a different key and tampered ciphertext", async () => {
  await signIn();
  const local = (await localBrowserKeys(userId, vaultId))[0]!;
  const box = (
    await request(`/auth/trusted-devices/${deviceId}/unlock`, "POST", {})
  ).json().box;
  const other = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  await expect(
    decryptBrowserIdentity(local.context, other, box),
  ).rejects.toThrow();
  for (const change of [
    { id: crypto.randomUUID() },
    { userId: crypto.randomUUID() },
    { vaultId: crypto.randomUUID() },
    { credentialId: encode(randomKey()) },
    { identityPublicKey: encode(randomKey()) },
  ] as Partial<TrustedBrowserContext>[])
    await expect(
      decryptBrowserIdentity({ ...local.context, ...change }, local.key, box),
    ).rejects.toThrow();
  await expect(
    decryptBrowserIdentity(local.context, local.key, {
      ...box,
      ciphertext:
        (box.ciphertext[0] === "A" ? "B" : "A") + box.ciphertext.slice(1),
    }),
  ).rejects.toThrow();
});
it("erases a decrypted identity when the view is cancelled during asynchronous decryption", async () => {
  await signIn();
  let buffer: ArrayBuffer | undefined;
  const original = crypto.subtle.decrypt.bind(crypto.subtle);
  const decrypt = vi
    .spyOn(crypto.subtle, "decrypt")
    .mockImplementation(async (algorithm, key, data) => {
      buffer = await original(algorithm, key, data);
      return buffer;
    });
  let checks = 0;
  try {
    await expect(
      openTrustedBrowser(session, ownerKey.id, () => {
        if (++checks === 4) throw new Error("Synthetic cancellation");
      }),
    ).rejects.toThrow("Synthetic cancellation");
    expect(buffer).toBeDefined();
    expect([...new Uint8Array(buffer!)]).toEqual(Array(32).fill(0));
  } finally {
    decrypt.mockRestore();
  }
});
it("does not release the identity box to password, stale, wrong-credential or unverified sessions", async () => {
  const raw = cookie.split("=")[1]!;
  await db.query("UPDATE sessions SET method='password' WHERE token_hash=$1", [
    hash(raw),
  ]);
  expect(
    (await request(`/auth/trusted-devices/${deviceId}/unlock`, "POST", {}))
      .statusCode,
  ).toBe(403);
  await db.query(
    "UPDATE sessions SET method='passkey',authenticated_at=now()-interval '61 seconds' WHERE token_hash=$1",
    [hash(raw)],
  );
  expect(
    (await request(`/auth/trusted-devices/${deviceId}/unlock`, "POST", {}))
      .statusCode,
  ).toBe(403);
  await signIn();
  const second = credentials(userId);
  await addCredential(second);
  await signIn(second);
  expect(
    (await request(`/auth/trusted-devices/${deviceId}/unlock`, "POST", {}))
      .statusCode,
  ).toBe(403);
  const withoutOrigin = await app.inject({
    method: "POST",
    url: `/api/auth/trusted-devices/${deviceId}/unlock`,
    headers: { cookie, "x-csrf-token": csrf },
    payload: {},
  });
  expect(withoutOrigin.statusCode).toBe(403);
  await signIn();
});
it("another active administrator cannot list, open or overwrite a personal browser", async () => {
  const id = crypto.randomUUID(),
    identity = createIdentity("SYNTHETIC other browser password!", id),
    key = credentials(id);
  await db.query(
    "INSERT INTO users(id,username,display_name,role,status,identity,sealed_key) VALUES($1,'trusted-admin','Synthetic Admin','admin','active',$2,$3)",
    [
      id,
      identity.identity,
      sealVaultKey(vaultKey, identity.identity.publicKey, vaultId, 1),
    ],
  );
  await addCredential(key);
  await signIn(key);
  expect((await request("/auth/trusted-devices")).json()).toEqual([]);
  expect(
    (await request(`/auth/trusted-devices/${deviceId}/unlock`, "POST", {}))
      .statusCode,
  ).toBe(404);
  const local = (await localBrowserKeys(userId, vaultId))[0]!;
  expect(
    (
      await request("/auth/trusted-devices", "POST", {
        ...local.context,
        label: "Attack",
        box: {
          v: 1,
          algorithm: "AES-256-GCM",
          iv: "A".repeat(16),
          ciphertext: "A".repeat(64),
        },
      })
    ).statusCode,
  ).toBe(403);
  await signIn();
});
it("revocation, identity change, suspension and passkey deletion prevent future unlocks", async () => {
  const changed = createIdentity(
    "SYNTHETIC changed identity password!",
    userId,
  );
  await db.query("UPDATE users SET identity=$1 WHERE id=$2", [
    changed.identity,
    userId,
  ]);
  expect(
    (await request(`/auth/trusted-devices/${deviceId}/unlock`, "POST", {}))
      .statusCode,
  ).toBe(409);
  await db.query(
    "UPDATE users SET identity=$1,status='suspended' WHERE id=$2",
    [owner.identity, userId],
  );
  expect(
    (await request(`/auth/trusted-devices/${deviceId}/unlock`, "POST", {}))
      .statusCode,
  ).toBe(401);
  await db.query("UPDATE users SET status='active' WHERE id=$1", [userId]);
  expect(
    (await request(`/auth/trusted-devices/${deviceId}`, "DELETE")).statusCode,
  ).toBe(200);
  expect(
    (await request(`/auth/trusted-devices/${deviceId}/unlock`, "POST", {}))
      .statusCode,
  ).toBe(404);
  deviceId = await rememberBrowser(session, {
    assertActive() {},
    getPrivateKey: () => owner.privateKey,
  });
  await db.query("DELETE FROM credentials WHERE id=$1", [ownerKey.id]);
  expect(
    (await db.query("SELECT id FROM trusted_devices WHERE id=$1", [deviceId]))
      .rowCount,
  ).toBe(0);
  expect(
    (await request(`/auth/trusted-devices/${deviceId}/unlock`, "POST", {}))
      .statusCode,
  ).toBe(403);
});
