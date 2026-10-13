import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import {
  randomUUID,
  randomBytes,
  generateKeyPairSync,
  createHash,
  sign,
} from "node:crypto";
import { testDatabase } from "./database.ts";
import { migrate, type Database } from "../apps/server/src/db.ts";
import { buildApp } from "../apps/server/src/app.ts";
import {
  ready,
  deriveLoginSecret,
  wrapPassword,
  unlockPassword,
  openVaultKey,
  randomKey as prfRandomKey,
  wrapPasskey,
  createIdentity,
  randomKey,
  createRecovery,
  sealVaultKey,
  encryptJson,
  recordContext,
  type StoredRecord,
} from "../packages/core/src/index.ts";
import type { FastifyInstance } from "fastify";
let db: Database, app: FastifyInstance;
const ownerId = randomUUID(),
  vaultId = randomUUID(),
  adminId = randomUUID(),
  recordId = randomUUID();
let ownerCookie = "",
  ownerCsrf = "",
  adminCookie = "",
  adminCsrf = "",
  invite = "",
  rotationSnapshot = "",
  rescueCode = "";
const root = { key: null as Uint8Array | null };
let ownerIdentity: ReturnType<typeof createIdentity>,
  adminIdentity: ReturnType<typeof createIdentity>;
async function send(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: unknown,
  who: "owner" | "admin" | "none" = "owner",
) {
  const response = await app.inject({
    method,
    url: `/api${path}`,
    headers: {
      origin: "http://localhost:5173",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(who === "none"
        ? {}
        : {
            cookie: who === "owner" ? ownerCookie : adminCookie,
            "x-csrf-token": who === "owner" ? ownerCsrf : adminCsrf,
          }),
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  return response;
}
beforeAll(async () => {
  await ready;
  db = await testDatabase();
  await migrate(db);
  app = await buildApp(db, { serveStatic: false, logger: false });
  await app.ready();
  root.key = randomKey();
  ownerIdentity = createIdentity("Owner login password 2026!", ownerId);
  adminIdentity = createIdentity("Admin login password 2026!", adminId);
});
afterAll(async () => {
  await app.close();
  await db.end();
});
describe("closed authentication and shared vault", () => {
  it("does not expose the vault before authentication", async () => {
    expect((await send("/records", "GET", undefined, "none")).statusCode).toBe(
      401,
    );
    expect(
      (await send("/auth/config", "GET", undefined, "none")).json().initialized,
    ).toBe(false);
  });
  it("bootstraps exactly one owner with a setup code", async () => {
    const recovery = createRecovery(root.key!, vaultId, 1);
    rescueCode = recovery.code;
    const input = {
      setupToken: "wrong",
      id: ownerId,
      vaultId,
      vaultName: "Test VPN",
      username: "owner",
      displayName: "Owner",
      identity: ownerIdentity.identity,
      sealedKey: sealVaultKey(
        root.key!,
        ownerIdentity.identity.publicKey,
        vaultId,
        1,
      ),
      recovery: recovery.box,
      loginSecret: deriveLoginSecret(
        "Owner login password 2026!",
        "owner",
        "localhost",
      ),
    };
    expect(
      (await send("/auth/bootstrap", "POST", input, "none")).statusCode,
    ).toBe(403);
    input.setupToken = process.env.SETUP_TOKEN!;
    const result = await send("/auth/bootstrap", "POST", input, "none");
    expect(result.statusCode).toBe(200);
    ownerCookie = String(result.headers["set-cookie"]).split(";")[0]!;
    ownerCsrf = result.json().csrf;
    expect((await send("/auth/bootstrap", "POST", input)).statusCode).toBe(409);
    expect((await send("/auth/config")).json().initialized).toBe(true);
  });
  it("enforces Origin and CSRF on session mutations", async () => {
    const withoutCsrf = await app.inject({
      method: "POST",
      url: "/api/invites",
      headers: { origin: "http://localhost:5173", cookie: ownerCookie },
    });
    expect(withoutCsrf.statusCode).toBe(403);
    const wrongOrigin = await app.inject({
      method: "POST",
      url: "/api/invites",
      headers: {
        origin: "https://evil.example",
        cookie: ownerCookie,
        "x-csrf-token": ownerCsrf,
      },
    });
    expect(wrongOrigin.statusCode).toBe(403);
    expect((await send("/records")).headers["cache-control"]).toBe("no-store");
  });
  it("creates encrypted records and rejects stale edits and plaintext fields", async () => {
    const box = encryptJson(
      { title: "Cloudflare", secret: "secret-value" },
      root.key!,
      recordContext(vaultId, recordId, 1, 1),
    );
    const result = await send(`/records/${recordId}`, "PUT", {
      baseVersion: 0,
      epoch: 1,
      box,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().box).toEqual(box);
    const serialized = (await send("/records")).body;
    expect(serialized).not.toContain("Cloudflare");
    expect(serialized).not.toContain("secret-value");
    expect(
      (
        await send(`/records/${recordId}`, "PUT", {
          baseVersion: 0,
          epoch: 1,
          box,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await send(`/records/${recordId}`, "PUT", {
          baseVersion: 1,
          epoch: 1,
          box,
          secret: "not allowed",
        })
      ).statusCode,
    ).toBe(400);
    const next = encryptJson(
      { title: "Cloudflare", secret: "next-value" },
      root.key!,
      recordContext(vaultId, recordId, 2, 1),
    );
    expect(
      (
        await send(`/records/${recordId}`, "PUT", {
          baseVersion: 1,
          epoch: 1,
          box: next,
        })
      ).statusCode,
    ).toBe(200);
    expect((await send(`/records/${recordId}/history`)).json()[0].version).toBe(
      1,
    );
  });
  it("makes single-use invitations and keeps new members pending without vault access", async () => {
    const result = await send("/invites", "POST");
    expect(result.statusCode).toBe(200);
    invite = new URL(result.json().url).searchParams.get("invite")!;
    expect(
      (await send("/invites/inspect", "POST", { invite }, "none")).statusCode,
    ).toBe(200);
    const input = {
      invite,
      id: adminId,
      username: "admin",
      displayName: "Admin",
      identity: adminIdentity.identity,
      loginSecret: deriveLoginSecret(
        "Admin login password 2026!",
        "admin",
        "localhost",
      ),
    };
    const accepted = await send("/invites/accept", "POST", input, "none");
    expect(accepted.statusCode).toBe(200);
    adminCookie = String(accepted.headers["set-cookie"]).split(";")[0]!;
    adminCsrf = accepted.json().csrf;
    expect((await send("/records", "GET", undefined, "admin")).statusCode).toBe(
      403,
    );
    expect(
      (await send("/invites/accept", "POST", input, "none")).statusCode,
    ).toBe(404);
  });
  it("requires matching public key when approving a member", async () => {
    const body = {
      publicKey: ownerIdentity.identity.publicKey,
      sealedKey: sealVaultKey(
        root.key!,
        adminIdentity.identity.publicKey,
        vaultId,
        1,
      ),
      epoch: 1,
    };
    expect(
      (await send(`/members/${adminId}/grant`, "POST", body)).statusCode,
    ).toBe(409);
    body.publicKey = adminIdentity.identity.publicKey;
    expect(
      (await send(`/members/${adminId}/grant`, "POST", body)).statusCode,
    ).toBe(200);
    expect((await send("/records", "GET", undefined, "admin")).statusCode).toBe(
      200,
    );
    expect(
      (await send("/invites", "POST", undefined, "admin")).statusCode,
    ).toBe(403);
    expect((await send("/backup", "GET", undefined, "admin")).statusCode).toBe(
      403,
    );
    expect((await send("/audit", "GET", undefined, "admin")).statusCode).toBe(
      403,
    );
  });
  it("backs up ciphertext with a recovery envelope and never plaintext", async () => {
    const response = await send("/backup");
    expect(response.statusCode).toBe(200);
    expect(response.json().vault.recovery.v).toBe(1);
    expect(response.json().records.length).toBe(1);
    expect(response.body).not.toContain("next-value");
  });
  it("validates password login and does not accept unknown accounts", async () => {
    expect(
      (
        await send(
          "/auth/password",
          "POST",
          {
            username: "unknown",
            loginSecret: deriveLoginSecret("anything", "unknown", "localhost"),
          },
          "none",
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await send(
          "/auth/password",
          "POST",
          {
            username: "owner",
            loginSecret: deriveLoginSecret("wrong", "owner", "localhost"),
          },
          "none",
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await send(
          "/auth/password",
          "POST",
          {
            username: "owner",
            loginSecret: deriveLoginSecret(
              "Owner login password 2026!",
              "owner",
              "localhost",
            ),
          },
          "none",
        )
      ).statusCode,
    ).toBe(200);
  });
  it("rejects invalid passkeys, consumes challenges and refuses replay", async () => {
    const options = (
      await send("/auth/passkey/options", "POST", undefined, "none")
    ).json();
    const input = {
      flow: options.flow,
      response: {
        id: "unknown",
        rawId: "unknown",
        type: "public-key",
        response: {},
        clientExtensionResults: {},
      },
    };
    expect(
      (await send("/auth/passkey/verify", "POST", input, "none")).statusCode,
    ).toBe(401);
    expect(
      (await send("/auth/passkey/verify", "POST", input, "none")).statusCode,
    ).toBe(400);
  });
  it("verifies a signed Passkey assertion and rejects missing user verification", async () => {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = pair.publicKey.export({ format: "jwk" });
    const credentialId = randomBytes(32).toString("base64url");
    // COSE EC2 / ES256 / P-256 key with x and y coordinates.
    const cose = Buffer.concat([
      Buffer.from("a5010203262001215820", "hex"),
      Buffer.from(jwk.x!, "base64url"),
      Buffer.from("225820", "hex"),
      Buffer.from(jwk.y!, "base64url"),
    ]);
    await db.query(
      "INSERT INTO credentials(id,user_id,public_key,counter,transports,device_type,backed_up) VALUES($1,$2,$3,0,'[]','singleDevice',false)",
      [credentialId, ownerId, cose],
    );
    async function assertion(flags: number, counter: number) {
      const options = (
        await send("/auth/passkey/options", "POST", undefined, "none")
      ).json();
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
      authenticator[32] = flags;
      authenticator.writeUInt32BE(counter, 33);
      const signature = sign(
        "sha256",
        Buffer.concat([
          authenticator,
          createHash("sha256").update(client).digest(),
        ]),
        pair.privateKey,
      );
      return send(
        "/auth/passkey/verify",
        "POST",
        {
          flow: options.flow,
          response: {
            id: credentialId,
            rawId: credentialId,
            type: "public-key",
            clientExtensionResults: {},
            response: {
              clientDataJSON: client.toString("base64url"),
              authenticatorData: authenticator.toString("base64url"),
              signature: signature.toString("base64url"),
              userHandle: Buffer.from(ownerId).toString("base64url"),
            },
          },
        },
        "none",
      );
    }
    expect((await assertion(0x05, 1)).statusCode).toBe(200);
    expect(
      (
        await db.query("SELECT counter FROM credentials WHERE id=$1", [
          credentialId,
        ])
      ).rows[0].counter,
    ).toBe(1);
    expect((await assertion(0x01, 2)).statusCode).toBe(401);
    expect((await send("/auth/password", "DELETE")).statusCode).toBe(400);
  });
  it("binds GitHub account linking to browser state and uses PKCE", async () => {
    const start = await send("/auth/oauth/start", "POST", {
      provider: "github",
      link: true,
    });
    expect(start.statusCode).toBe(200);
    const url = new URL(start.json().url);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("read:user");
    const state = url.searchParams.get("state")!;
    const bad = await app.inject({
      method: "GET",
      url: `/api/auth/oauth/github/callback?state=${state}&code=code`,
      headers: { cookie: ownerCookie },
    });
    expect(bad.headers.location).toContain("auth=error");
    expect((await db.query("SELECT * FROM identities")).rows.length).toBe(0);
    const goodStart = await send("/auth/oauth/start", "POST", {
      provider: "github",
      link: true,
    });
    const goodState = new URL(goodStart.json().url).searchParams.get("state")!;
    const binding = String(goodStart.headers["set-cookie"]).split(";")[0]!;
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("access_token")) {
        const params = new URLSearchParams(init.body as string);
        expect(params.get("code_verifier")).toHaveLength(43);
        return Response.json({ access_token: "test-not-real" });
      }
      return Response.json({ id: 12345, login: "mutable-username" });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const callback = await app.inject({
        method: "GET",
        url: `/api/auth/oauth/github/callback?state=${goodState}&code=code`,
        headers: { cookie: `${ownerCookie}; ${binding}` },
      });
      expect(callback.headers.location).toBe("/?auth=success");
      expect(
        (await db.query("SELECT subject,user_id FROM identities")).rows[0],
      ).toEqual({ subject: "12345", user_id: ownerId });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("changes login and decryption atomically, rejects stale edits, and preserves vault data", async () => {
    const before = (
      await db.query("SELECT box FROM records WHERE id=$1", [recordId])
    ).rows[0].box;
    const base = (await send("/auth/session")).json().user.identity;
    const nextPassword = "Updated single password 2026!";
    const identity = {
      publicKey: base.publicKey,
      master: wrapPassword(ownerIdentity.privateKey, nextPassword, ownerId),
    };
    const payload = {
      loginSecret: deriveLoginSecret(nextPassword, "owner", "localhost"),
      identity,
      baseIdentity: base,
    };
    // The API never accepts an encryption-only password edit or plaintext password.
    expect(
      (await send("/auth/password/set", "POST", { password: nextPassword }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await send("/auth/password/set", "POST", {
          ...payload,
          identity: adminIdentity.identity,
        })
      ).statusCode,
    ).toBe(400);
    expect((await send("/auth/password/set", "POST", payload)).statusCode).toBe(
      200,
    );
    expect((await send("/auth/password/set", "POST", payload)).statusCode).toBe(
      409,
    );
    const current = (await send("/auth/session")).json().user;
    const privateKey = unlockPassword(current.identity, nextPassword, ownerId);
    expect(openVaultKey(current.sealedKey, privateKey, vaultId, 1)).toEqual(
      root.key,
    );
    expect(() =>
      unlockPassword(current.identity, payload.loginSecret, ownerId),
    ).toThrow();
    expect(
      (await db.query("SELECT box FROM records WHERE id=$1", [recordId]))
        .rows[0].box,
    ).toEqual(before);
    expect(
      (
        await send(
          "/auth/password",
          "POST",
          {
            username: "owner",
            loginSecret: deriveLoginSecret(
              "Owner login password 2026!",
              "owner",
              "localhost",
            ),
          },
          "none",
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await send(
          "/auth/password",
          "POST",
          { username: "owner", loginSecret: payload.loginSecret },
          "none",
        )
      ).statusCode,
    ).toBe(200);
  });
  it("requires a decrypting passkey before disabling password and protects the last working method", async () => {
    const current = (await send("/auth/session")).json();
    // Earlier signed assertion fixture is authentication-only: it cannot replace a password.
    expect(current.credentials.some((c: { prf: boolean }) => !c.prf)).toBe(
      true,
    );
    expect((await send("/auth/password", "DELETE")).statusCode).toBe(400);
    const id = Buffer.from("decrypting-key-fixture").toString("base64url"),
      prf = prfRandomKey();
    const wrap = wrapPasskey(ownerIdentity.privateKey, prf, ownerId, id);
    await db.query(
      "INSERT INTO credentials(id,user_id,public_key,counter,transports,device_type,backed_up,prf_wrap) VALUES($1,$2,$3,0,'[]','singleDevice',false,$4)",
      [id, ownerId, Buffer.alloc(1), wrap],
    );
    expect((await send("/auth/password", "DELETE")).statusCode).toBe(200);
    expect((await send("/auth/session")).json().passwordEnabled).toBe(false);
    expect(
      (
        await send(
          "/auth/password",
          "POST",
          {
            username: "owner",
            loginSecret: deriveLoginSecret(
              "Updated single password 2026!",
              "owner",
              "localhost",
            ),
          },
          "none",
        )
      ).statusCode,
    ).toBe(401);
    expect((await send("/auth/passkey/" + id, "DELETE")).statusCode).toBe(400);
    const base = (await send("/auth/session")).json().user.identity;
    expect(
      (
        await send("/auth/password/set", "POST", {
          baseIdentity: base,
          identity: base,
          loginSecret: deriveLoginSecret(
            "Updated single password 2026!",
            "owner",
            "localhost",
          ),
        })
      ).statusCode,
    ).toBe(200);
    expect((await send("/auth/passkey/" + id, "DELETE")).statusCode).toBe(200);
  });
  it("requires complete, current ciphertext when revoking and rotates history too", async () => {
    const snapshot = (await send("/rotation")).json();
    rotationSnapshot = snapshot.snapshot;
    const next = randomKey(),
      recovery = createRecovery(next, vaultId, 2);
    const rotation = {
      snapshot: snapshot.snapshot,
      revokeId: adminId,
      epoch: 2,
      recovery: recovery.box,
      keys: [
        {
          id: ownerId,
          publicKey: ownerIdentity.identity.publicKey,
          sealedKey: sealVaultKey(
            next,
            ownerIdentity.identity.publicKey,
            vaultId,
            2,
          ),
        },
      ],
      records: snapshot.records.map((r: StoredRecord) => ({
        id: r.id,
        version: r.version,
        box: encryptJson(
          { title: "Rotated", secret: "new-key-only" },
          next,
          recordContext(vaultId, r.id, r.version, 2),
        ),
      })),
      history: [] as { id: string; version: number; box: unknown }[],
    };
    expect((await send("/rotation", "POST", rotation)).statusCode).toBe(400);
    rotation.history = snapshot.history.map((r: StoredRecord) => ({
      id: r.id,
      version: r.version,
      box: encryptJson(
        { title: "Historical" },
        next,
        recordContext(vaultId, r.id, r.version, 2),
      ),
    }));
    expect((await send("/rotation", "POST", rotation)).statusCode).toBe(200);
    expect((await send("/records", "GET", undefined, "admin")).statusCode).toBe(
      401,
    );
    expect((await send("/records")).json()[0].epoch).toBe(2);
    expect((await send(`/records/${recordId}/history`)).json()[0].epoch).toBe(
      2,
    );
    expect((await send("/rotation", "POST", rotation)).statusCode).toBe(409);
  });
});
