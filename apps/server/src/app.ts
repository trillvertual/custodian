import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import { z, ZodError } from "zod";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
} from "@simplewebauthn/server";
import {
  encryptedSchema,
  identitySchema,
  b64,
  uuid,
  type Member,
  type SessionUser,
  type StoredRecord,
} from "../../../packages/core/src/schemas.ts";
import { config } from "./config.ts";
import { type Database, transaction } from "./db.ts";
import {
  hash,
  token,
  equal,
  passwordHash,
  verifyPassword,
} from "./security.ts";
import { registerRecordBatch } from "./records-batch.ts";
import { registerTrustedDevices } from "./trusted-devices.ts";
import { registerOAuth } from "./oauth.ts";
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export type UserRow = {
  id: string;
  username: string;
  display_name: string;
  role: "owner" | "admin";
  status: "pending" | "active" | "suspended";
  password_hash: string | null;
  password_login_version: number;
  identity: z.infer<typeof identitySchema>;
  sealed_key: string | null;
  created_at: Date;
};
export type Auth = {
  user: UserRow;
  sessionHash: string;
  csrf: string;
  method: string;
  authenticatedAt: Date;
  credentialId: string | null;
};
declare module "fastify" {
  interface FastifyRequest {
    auth: Auth | null;
  }
}
export const member = (row: UserRow): Member => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  role: row.role,
  status: row.status,
  publicKey: row.identity.publicKey,
  createdAt: row.created_at.toISOString(),
});
export const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_.-]{3,64}$/);
export const loginSecret = b64.length(43);
const displayName = z.string().trim().min(1).max(100);
export async function audit(
  db: Database | import("pg").PoolClient,
  userId: string | null,
  action: string,
  target: string | null = null,
  detail: unknown = {},
) {
  await db.query(
    "INSERT INTO audit(user_id,action,target,detail) VALUES($1,$2,$3,$4)",
    [userId, action, target, JSON.stringify(detail)],
  );
}
export async function makeSession(
  db: Database,
  reply: FastifyReply,
  userId: string,
  method: string,
  credentialId: string | null = null,
) {
  const raw = token(),
    csrf = token();
  await db.query(
    "INSERT INTO sessions(token_hash,user_id,csrf,method,credential_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '12 hours')",
    [hash(raw), userId, csrf, method, credentialId],
  );
  reply.setCookie(
    config.secure ? "__Host-vault-session" : "vault-session",
    raw,
    {
      path: "/",
      httpOnly: true,
      secure: config.secure,
      sameSite: "lax",
      maxAge: 43200,
    },
  );
  return { csrf };
}
export function requireAuth(req: FastifyRequest): Auth {
  if (!req.auth) throw new HttpError(401, "Войдите в аккаунт.");
  return req.auth;
}
export function active(req: FastifyRequest): Auth {
  const a = requireAuth(req);
  if (a.user.status !== "active" || !a.user.sealed_key)
    throw new HttpError(403, "Доступ к хранилищу ещё не выдан.");
  return a;
}
export function owner(req: FastifyRequest): Auth {
  const a = active(req);
  if (a.user.role !== "owner")
    throw new HttpError(403, "Действие доступно только владельцу.");
  return a;
}
export function recent(req: FastifyRequest): Auth {
  const a = requireAuth(req);
  if (Date.now() - a.authenticatedAt.getTime() > 15 * 60 * 1000)
    throw new HttpError(403, "Для этого действия войдите заново.");
  return a;
}
export async function newFlow(
  db: Database,
  purpose: string,
  payload: unknown,
  minutes = 5,
) {
  const raw = token();
  await db.query(
    "INSERT INTO flows(token_hash,purpose,payload,expires_at) VALUES($1,$2,$3,now()+$4*interval '1 minute')",
    [hash(raw), purpose, JSON.stringify(payload), minutes],
  );
  return raw;
}
export async function takeFlow<T>(
  db: Database,
  raw: string,
  purpose: string,
): Promise<T> {
  const { rows } = await db.query(
    "DELETE FROM flows WHERE token_hash=$1 AND purpose=$2 AND expires_at>now() RETURNING payload",
    [hash(raw), purpose],
  );
  if (!rows[0])
    throw new HttpError(
      400,
      "Запрос истёк или уже использован. Повторите действие.",
    );
  return rows[0].payload as T;
}
const mapRecord = (r: Record<string, unknown>): StoredRecord => ({
  id: r.id as string,
  version: r.version as number,
  epoch: r.epoch as number,
  box: r.box as StoredRecord["box"],
  updatedAt: (r.updated_at as Date).toISOString(),
  updatedBy: r.updated_by as string,
  deletedAt: r.deleted_at ? (r.deleted_at as Date).toISOString() : null,
});
export async function buildApp(
  db: Database,
  {
    serveStatic = true,
    logger = true,
  }: { serveStatic?: boolean; logger?: boolean } = {},
) {
  const app = Fastify({
    logger: logger
      ? {
          redact: [
            "req.headers.cookie",
            "req.headers.authorization",
            "res.headers.set-cookie",
          ],
          serializers: {
            req: (r) => ({
              method: r.method,
              url: String(r.url).split("?")[0],
              hostname: r.hostname,
            }),
          },
        }
      : false,
    bodyLimit: 8 * 1024 * 1024,
    trustProxy: false,
  });
  app.decorateRequest("auth", null);
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: config.secure ? [] : null,
      },
    },
    referrerPolicy: { policy: "no-referrer" },
  });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  app.addHook("onRequest", async (req, reply) => {
    reply.header(
      "Permissions-Policy",
      "camera=(self), microphone=(), geolocation=()",
    );
    if (!req.url.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");

    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== config.origin
    )
      throw new HttpError(403, "Недопустимый источник запроса.");
    const raw =
      req.cookies[config.secure ? "__Host-vault-session" : "vault-session"];
    if (raw) {
      const { rows } = await db.query(
        "SELECT u.*,s.csrf,s.method,s.authenticated_at,s.credential_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.status<>'suspended'",
        [hash(raw)],
      );
      if (rows[0])
        req.auth = {
          user: rows[0],
          csrf: rows[0].csrf,
          method: rows[0].method,
          authenticatedAt: rows[0].authenticated_at,
          sessionHash: hash(raw),
          credentialId: rows[0].credential_id,
        };
    }
    if (
      req.auth &&
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers["x-csrf-token"] !== req.auth.csrf
    )
      throw new HttpError(403, "Сессия изменилась. Обновите страницу.");
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: "Некорректные данные запроса.",
        issues: error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      });
    const status = Number((error as { statusCode?: number }).statusCode ?? 500);
    if (status === 429)
      return reply.code(429).send({
        error: "Слишком много попыток. Подождите минуту и попробуйте снова.",
      });
    if (status >= 500) {
      req.log.error({ err: error }, "Request failed");
      return reply
        .code(500)
        .send({ error: "Не удалось выполнить действие. Повторите запрос." });
    }
    return reply.code(status).send({
      error: error instanceof Error ? error.message : "Некорректный запрос.",
    });
  });
  app.get("/api/health", async () => {
    await db.query("SELECT 1");
    return { ok: true };
  });
  app.get("/api/auth/config", async () => ({
    initialized:
      (await db.query("SELECT 1 FROM vaults LIMIT 1")).rowCount !== 0,
    providers: {
      github: !!(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET),
      telegram: !!(config.TELEGRAM_CLIENT_ID && config.TELEGRAM_CLIENT_SECRET),
    },
    rpId: config.rpId,
  }));
  app.post(
    "/api/auth/bootstrap",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const input = z
        .object({
          setupToken: z.string().max(256),
          id: uuid,
          vaultId: uuid,
          vaultName: z.string().trim().min(1).max(100),
          username,
          displayName,
          identity: identitySchema,
          sealedKey: b64,
          recovery: encryptedSchema,
          loginSecret,
        })
        .strict()
        .parse(req.body);
      if (!config.SETUP_TOKEN || !equal(input.setupToken, config.SETUP_TOKEN))
        throw new HttpError(403, "Неверный код первоначальной настройки.");
      const pw = await passwordHash(input.loginSecret);
      await transaction(db, async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(7364292)");
        if ((await c.query("SELECT 1 FROM vaults")).rowCount)
          throw new HttpError(409, "Владелец уже создан.");
        await c.query("INSERT INTO vaults(id,name,recovery) VALUES($1,$2,$3)", [
          input.vaultId,
          input.vaultName,
          input.recovery,
        ]);
        await c.query(
          "INSERT INTO users(id,username,display_name,role,status,password_hash,identity,sealed_key,password_login_version) VALUES($1,$2,$3,'owner','active',$4,$5,$6,1)",
          [
            input.id,
            input.username,
            input.displayName,
            pw,
            input.identity,
            input.sealedKey,
          ],
        );
        await audit(c, input.id, "vault.created", input.vaultId);
      });
      return makeSession(db, reply, input.id, "setup");
    },
  );
  app.post(
    "/api/auth/password",
    { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const input = z
        .object({ username, loginSecret })
        .strict()
        .parse(req.body);
      const user = (
        await db.query(
          "SELECT * FROM users WHERE username=$1 AND status<>'suspended'",
          [input.username],
        )
      ).rows[0] as UserRow | undefined;
      // Run the same KDF for unknown users to avoid a fast username oracle.
      const dummy =
        "scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const valid = await verifyPassword(
        input.loginSecret,
        user?.password_hash ?? dummy,
      );
      if (!user?.password_hash || user.password_login_version !== 1 || !valid) {
        await audit(db, null, "auth.failed");
        throw new HttpError(401, "Неверный логин или пароль.");
      }
      await audit(db, user.id, "auth.login", null, { method: "password" });
      return makeSession(db, reply, user.id, "password");
    },
  );
  app.get("/api/auth/session", async (req) => {
    const a = requireAuth(req);
    const vault = (await db.query("SELECT * FROM vaults LIMIT 1")).rows[0];
    const credentials = (
      await db.query("SELECT id,prf_wrap FROM credentials WHERE user_id=$1", [
        a.user.id,
      ])
    ).rows;
    const user: SessionUser = {
      ...member(a.user),
      identity: a.user.identity,
      sealedKey: a.user.sealed_key,
      passkeyWraps: Object.fromEntries(
        credentials.filter((c) => c.prf_wrap).map((c) => [c.id, c.prf_wrap]),
      ),
      vaultId: vault.id,
      epoch: vault.epoch,
      vaultName: vault.name,
    };
    return {
      user,
      csrf: a.csrf,
      method: a.method,
      credentialId: a.credentialId,
      passwordEnabled:
        !!a.user.password_hash && a.user.password_login_version === 1,
      identities: (
        await db.query("SELECT provider FROM identities WHERE user_id=$1", [
          a.user.id,
        ])
      ).rows.map((i) => i.provider),
      credentials: credentials.map((c) => ({ id: c.id, prf: !!c.prf_wrap })),
    };
  });
  app.post("/api/auth/logout", async (req, reply) => {
    const a = requireAuth(req);
    await db.query("DELETE FROM sessions WHERE token_hash=$1", [a.sessionHash]);
    reply.clearCookie(
      config.secure ? "__Host-vault-session" : "vault-session",
      { path: "/" },
    );
    return { ok: true };
  });
  app.post("/api/auth/password/set", async (req) => {
    const a = recent(req);
    const input = z
      .object({
        loginSecret,
        identity: identitySchema,
        baseIdentity: identitySchema,
      })
      .strict()
      .parse(req.body);
    const pw = await passwordHash(input.loginSecret);
    await transaction(db, async (c) => {
      const current = (
        await c.query("SELECT identity FROM users WHERE id=$1 FOR UPDATE", [
          a.user.id,
        ])
      ).rows[0];
      if (input.identity.publicKey !== current.identity.publicKey)
        throw new HttpError(400, "Смена пароля не должна менять личный ключ.");
      if (
        JSON.stringify(identitySchema.parse(current.identity)) !==
        JSON.stringify(input.baseIdentity)
      )
        throw new HttpError(409, "Пароль уже изменён. Обновите страницу.");
      await c.query(
        "UPDATE users SET password_hash=$1,identity=$2,password_login_version=1 WHERE id=$3",
        [pw, input.identity, a.user.id],
      );
      await c.query(
        "DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2",
        [a.user.id, a.sessionHash],
      );
      await audit(c, a.user.id, "auth.password.changed");
    });
    return { ok: true };
  });
  app.delete("/api/auth/password", async (req) => {
    const a = recent(req);
    await transaction(db, async (c) => {
      await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [a.user.id]);
      const alternatives = (
        await c.query(
          "SELECT 1 FROM credentials WHERE user_id=$1 AND prf_wrap IS NOT NULL",
          [a.user.id],
        )
      ).rowCount;
      if (!alternatives)
        throw new HttpError(
          400,
          "Сначала подключите Passkey с поддержкой открытия хранилища.",
        );
      await c.query("UPDATE users SET password_hash=NULL WHERE id=$1", [
        a.user.id,
      ]);
      await c.query(
        "DELETE FROM sessions WHERE user_id=$1 AND method='password' AND token_hash<>$2",
        [a.user.id, a.sessionHash],
      );
      await audit(c, a.user.id, "auth.password.disabled");
    });
    return { ok: true };
  });
  app.post("/api/auth/passkey/register/options", async (req) => {
    const a = recent(req);
    const existing = (
      await db.query("SELECT id FROM credentials WHERE user_id=$1", [a.user.id])
    ).rows;
    const options = await generateRegistrationOptions({
      rpName: "Custodian",
      rpID: config.rpId,
      userName: a.user.username,
      userID: Buffer.from(a.user.id),
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      excludeCredentials: existing.map((c) => ({ id: c.id })),
    });
    // PRF is added by the client and its output never sent to the server.
    return {
      options,
      flow: await newFlow(db, "passkey.register", {
        userId: a.user.id,
        challenge: options.challenge,
      }),
    };
  });
  app.post("/api/auth/passkey/register/verify", async (req) => {
    const a = recent(req);
    const input = z
      .object({
        flow: b64,
        response: z.custom<RegistrationResponseJSON>(
          (v) => !!v && typeof v === "object",
        ),
        wrap: encryptedSchema.optional(),
      })
      .strict()
      .parse(req.body);
    const flow = await takeFlow<{ userId: string; challenge: string }>(
      db,
      input.flow,
      "passkey.register",
    );
    if (flow.userId !== a.user.id)
      throw new HttpError(403, "Запрос принадлежит другой сессии.");
    const result = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: flow.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpId,
      requireUserVerification: true,
    }).catch(() => {
      throw new HttpError(400, "Не удалось проверить Passkey.");
    });
    if (!result.verified || !result.registrationInfo)
      throw new HttpError(400, "Не удалось проверить Passkey.");
    const info = result.registrationInfo;
    await db.query(
      "INSERT INTO credentials(id,user_id,public_key,counter,transports,device_type,backed_up,prf_wrap) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        info.credential.id,
        a.user.id,
        Buffer.from(info.credential.publicKey),
        info.credential.counter,
        JSON.stringify(info.credential.transports ?? []),
        info.credentialDeviceType,
        info.credentialBackedUp,
        input.wrap ?? null,
      ],
    );
    await audit(db, a.user.id, "auth.passkey.added");
    return { ok: true };
  });
  app.post(
    "/api/auth/passkey/options",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async () => {
      const options = await generateAuthenticationOptions({
        rpID: config.rpId,
        userVerification: "required",
      });
      return {
        options,
        flow: await newFlow(db, "passkey.login", {
          challenge: options.challenge,
        }),
      };
    },
  );
  app.post(
    "/api/auth/passkey/verify",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const input = z
        .object({
          flow: b64,
          response: z.custom<AuthenticationResponseJSON>(
            (v) => !!v && typeof v === "object",
          ),
        })
        .strict()
        .parse(req.body);
      const flow = await takeFlow<{ challenge: string }>(
        db,
        input.flow,
        "passkey.login",
      );
      const row = (
        await db.query(
          "SELECT c.*,u.status FROM credentials c JOIN users u ON u.id=c.user_id WHERE c.id=$1 AND u.status<>'suspended'",
          [input.response.id],
        )
      ).rows[0];
      if (!row) throw new HttpError(401, "Passkey не зарегистрирован.");
      const result = await verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: flow.challenge,
        expectedOrigin: config.origin,
        expectedRPID: config.rpId,
        requireUserVerification: true,
        credential: {
          id: row.id,
          publicKey: new Uint8Array(row.public_key),
          counter: Number(row.counter),
          transports: row.transports as AuthenticatorTransport[],
        },
      }).catch(() => {
        throw new HttpError(401, "Не удалось проверить Passkey.");
      });
      if (!result.verified)
        throw new HttpError(401, "Не удалось проверить Passkey.");
      const updated = await db.query(
        "UPDATE credentials SET counter=$1 WHERE id=$2 AND counter=$3",
        [result.authenticationInfo.newCounter, row.id, row.counter],
      );
      if (!updated.rowCount)
        throw new HttpError(401, "Passkey изменился. Повторите вход.");
      await audit(db, row.user_id, "auth.login", null, { method: "passkey" });
      return makeSession(db, reply, row.user_id, "passkey", row.id);
    },
  );
  app.post("/api/auth/passkey/wrap", async (req) => {
    const a = recent(req);
    const input = z
      .object({ id: b64, wrap: encryptedSchema })
      .strict()
      .parse(req.body);
    const result = await db.query(
      "UPDATE credentials SET prf_wrap=$1 WHERE id=$2 AND user_id=$3",
      [input.wrap, input.id, a.user.id],
    );
    if (!result.rowCount) throw new HttpError(404, "Passkey не найден.");
    return { ok: true };
  });
  app.delete("/api/auth/passkey/:id", async (req) => {
    const a = recent(req);
    const id = z.object({ id: b64 }).parse(req.params).id;
    await transaction(db, async (c) => {
      const current = (
        await c.query(
          "SELECT password_hash,password_login_version FROM users WHERE id=$1 FOR UPDATE",
          [a.user.id],
        )
      ).rows[0];
      const count = (
        await c.query(
          "SELECT count(*)::int AS n FROM credentials WHERE user_id=$1 AND id<>$2 AND prf_wrap IS NOT NULL",
          [a.user.id, id],
        )
      ).rows[0].n;
      if (
        !count &&
        !(current.password_hash && current.password_login_version === 1)
      )
        throw new HttpError(
          400,
          "Нельзя удалить последний способ входа и открытия хранилища.",
        );
      await c.query("DELETE FROM credentials WHERE user_id=$1 AND id=$2", [
        a.user.id,
        id,
      ]);
      await audit(c, a.user.id, "auth.passkey.removed");
    });
    return { ok: true };
  });
  registerOAuth(app, db);
  app.get("/api/members", async (req) => {
    active(req);
    return (await db.query("SELECT * FROM users ORDER BY created_at")).rows.map(
      member,
    );
  });
  app.post("/api/invites", async (req) => {
    const a = owner(req);
    recent(req);
    const raw = token();
    await db.query(
      "INSERT INTO invites(token_hash,created_by,expires_at) VALUES($1,$2,now()+interval '24 hours')",
      [hash(raw), a.user.id],
    );
    await audit(db, a.user.id, "member.invited");
    return {
      url: `${config.origin}/?invite=${raw}`,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
  });
  app.post(
    "/api/invites/inspect",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const { invite } = z.object({ invite: b64 }).strict().parse(req.body);
      const row = (
        await db.query(
          "SELECT 1 FROM invites WHERE token_hash=$1 AND expires_at>now() AND used_at IS NULL",
          [hash(invite)],
        )
      ).rows[0];
      if (!row)
        throw new HttpError(404, "Приглашение недействительно или истекло.");
      return {
        valid: true,
        vaultName: (await db.query("SELECT name FROM vaults LIMIT 1")).rows[0]
          .name,
      };
    },
  );
  app.post(
    "/api/invites/accept",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const input = z
        .object({
          invite: b64,
          id: uuid,
          username,
          displayName,
          identity: identitySchema,
          loginSecret,
        })
        .strict()
        .parse(req.body);
      const pw = await passwordHash(input.loginSecret);
      await transaction(db, async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(7364292)");
        const result = await c.query(
          "UPDATE invites SET used_at=now() WHERE token_hash=$1 AND expires_at>now() AND used_at IS NULL RETURNING token_hash",
          [hash(input.invite)],
        );
        if (!result.rowCount)
          throw new HttpError(404, "Приглашение недействительно или истекло.");
        await c.query(
          "INSERT INTO users(id,username,display_name,role,status,password_hash,identity,password_login_version) VALUES($1,$2,$3,'admin','pending',$4,$5,1)",
          [input.id, input.username, input.displayName, pw, input.identity],
        );
        await audit(c, input.id, "member.joined");
      });
      return makeSession(db, reply, input.id, "invite");
    },
  );
  app.post("/api/members/:id/grant", async (req) => {
    const a = owner(req);
    recent(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const input = z
      .object({
        publicKey: b64.length(43),
        sealedKey: b64,
        epoch: z.number().int().positive(),
      })
      .strict()
      .parse(req.body);
    await transaction(db, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(7364292)");
      const vault = (await c.query("SELECT epoch FROM vaults")).rows[0];
      if (vault.epoch !== input.epoch)
        throw new HttpError(
          409,
          "Ключ хранилища изменился. Обновите страницу.",
        );
      const result = await c.query(
        "UPDATE users SET status='active',sealed_key=$1 WHERE id=$2 AND status='pending' AND identity->>'publicKey'=$3",
        [input.sealedKey, id, input.publicKey],
      );
      if (!result.rowCount)
        throw new HttpError(
          409,
          "Ключ участника изменился или доступ уже выдан.",
        );
      await audit(c, a.user.id, "member.approved", id);
    });
    return { ok: true };
  });
  app.post("/api/identity/reset", async (req) => {
    const a = requireAuth(req);
    recent(req);
    if (a.user.role === "owner")
      throw new HttpError(
        400,
        "Для восстановления владельца используйте rescue CLI.",
      );
    const input = z
      .object({ identity: identitySchema, loginSecret })
      .strict()
      .parse(req.body);
    const pw = await passwordHash(input.loginSecret);
    await transaction(db, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(7364292)");
      await c.query(
        "UPDATE users SET identity=$1,password_hash=$3,password_login_version=1,sealed_key=NULL,status='pending' WHERE id=$2",
        [input.identity, a.user.id, pw],
      );
      await c.query("UPDATE credentials SET prf_wrap=NULL WHERE user_id=$1", [
        a.user.id,
      ]);
      await c.query("DELETE FROM trusted_devices WHERE user_id=$1", [
        a.user.id,
      ]);
      await c.query(
        "DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2",
        [a.user.id, a.sessionHash],
      );
      await audit(c, a.user.id, "member.recovery.requested");
    });
    return { ok: true };
  });
  registerRecordBatch(app, db);
  registerTrustedDevices(app, db);
  app.get("/api/records", async (req) => {
    active(req);
    return (
      await db.query("SELECT * FROM records ORDER BY updated_at DESC,id")
    ).rows.map(mapRecord);
  });
  app.put("/api/records/:id", async (req) => {
    const a = active(req);
    const id = z.object({ id: uuid }).parse(req.params).id;
    const input = z
      .object({
        baseVersion: z.number().int().min(0),
        epoch: z.number().int().positive(),
        box: encryptedSchema,
        deleted: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    return transaction(db, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(7364292)");
      const vault = (await c.query("SELECT epoch FROM vaults")).rows[0];
      if (vault.epoch !== input.epoch)
        throw new HttpError(
          409,
          "Ключ хранилища изменился. Разблокируйте его заново.",
        );
      const current = (
        await c.query("SELECT * FROM records WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if ((current?.version ?? 0) !== input.baseVersion)
        throw new HttpError(
          409,
          "Запись изменил другой админ. Обновите её перед сохранением.",
        );
      if (current)
        await c.query(
          "INSERT INTO record_history(record_id,version,epoch,box,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,$6)",
          [
            id,
            current.version,
            current.epoch,
            current.box,
            current.updated_by,
            current.updated_at,
          ],
        );
      const { rows } = await c.query(
        "INSERT INTO records(id,version,epoch,box,updated_by,deleted_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $6 THEN now() ELSE NULL END) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,epoch=EXCLUDED.epoch,box=EXCLUDED.box,updated_by=EXCLUDED.updated_by,updated_at=now(),deleted_at=EXCLUDED.deleted_at RETURNING *",
        [
          id,
          input.baseVersion + 1,
          input.epoch,
          input.box,
          a.user.id,
          input.deleted,
        ],
      );
      await audit(
        c,
        a.user.id,
        current
          ? input.deleted
            ? "record.trashed"
            : current.deleted_at
              ? "record.restored"
              : "record.updated"
          : "record.created",
        id,
      );
      return mapRecord(rows[0]);
    });
  });
  app.get("/api/records/:id/history", async (req) => {
    active(req);
    const id = z.object({ id: uuid }).parse(req.params).id;
    return (
      await db.query(
        "SELECT record_id AS id,version,epoch,box,updated_by,updated_at,NULL AS deleted_at FROM record_history WHERE record_id=$1 ORDER BY version DESC",
        [id],
      )
    ).rows.map(mapRecord);
  });
  app.post("/api/records/:id/event", async (req) => {
    const a = active(req);
    const id = z.object({ id: uuid }).parse(req.params).id;
    const input = z
      .object({ action: z.enum(["revealed", "copied"]) })
      .strict()
      .parse(req.body);
    if (!(await db.query("SELECT 1 FROM records WHERE id=$1", [id])).rowCount)
      throw new HttpError(404, "Запись не найдена.");
    await audit(db, a.user.id, `record.${input.action}`, id);
    return { ok: true };
  });
  app.get("/api/audit", async (req) => {
    owner(req);
    return (
      await db.query(
        "SELECT a.*,u.display_name FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 200",
      )
    ).rows.map((r) => ({
      id: String(r.id),
      action: r.action,
      target: r.target,
      displayName: r.display_name ?? "Система",
      createdAt: r.created_at.toISOString(),
      detail: r.detail,
    }));
  });
  app.get("/api/backup", async (req) => {
    const a = owner(req);
    recent(req);
    const result = await transaction(db, async (c) => {
      await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      return {
        format: "shared-vault-backup",
        version: 1,
        createdAt: new Date().toISOString(),
        vault: (await c.query("SELECT id,name,epoch,recovery FROM vaults"))
          .rows[0],
        records: (await c.query("SELECT * FROM records ORDER BY id")).rows.map(
          mapRecord,
        ),
      };
    });
    await audit(db, a.user.id, "vault.backup");
    return result;
  });
  // Revocation rotates the vault key, including trash and all historical versions.
  async function snapshot(c: Database | import("pg").PoolClient) {
    const vault = (await c.query("SELECT * FROM vaults")).rows[0];
    const users = (await c.query("SELECT * FROM users ORDER BY id"))
      .rows as UserRow[];
    const records = (await c.query("SELECT * FROM records ORDER BY id")).rows;
    const history = (
      await c.query(
        "SELECT record_id AS id,* FROM record_history ORDER BY record_id,version",
      )
    ).rows;
    return { vault, users, records, history };
  }
  const snapshotHash = (s: Awaited<ReturnType<typeof snapshot>>) =>
    hash(
      JSON.stringify({
        epoch: s.vault.epoch,
        users: s.users.map((u) => [u.id, u.status, u.identity.publicKey]),
        records: s.records.map((r) => [r.id, r.version]),
        history: s.history.map((r) => [r.id, r.version]),
      }),
    );
  app.get("/api/rotation", async (req) => {
    owner(req);
    recent(req);
    return transaction(db, async (c) => {
      await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const s = await snapshot(c);
      return {
        snapshot: snapshotHash(s),
        epoch: s.vault.epoch,
        members: s.users.map(member),
        records: s.records.map(mapRecord),
        history: s.history.map((r) => mapRecord({ ...r, deleted_at: null })),
      };
    });
  });
  app.post("/api/rotation", async (req) => {
    const a = owner(req);
    recent(req);
    const rotated = z.object({
      id: uuid,
      version: z.number().int().positive(),
      box: encryptedSchema,
    });
    const input = z
      .object({
        snapshot: z.string().length(64),
        revokeId: uuid,
        epoch: z.number().int().positive(),
        recovery: encryptedSchema,
        keys: z
          .array(
            z.object({ id: uuid, publicKey: b64.length(43), sealedKey: b64 }),
          )
          .max(500),
        records: z.array(rotated).max(10000),
        history: z.array(rotated).max(50000),
      })
      .strict()
      .parse(req.body);
    await transaction(db, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(7364292)");
      const s = await snapshot(c);
      if (
        snapshotHash(s) !== input.snapshot ||
        input.epoch !== s.vault.epoch + 1
      )
        throw new HttpError(
          409,
          "Хранилище изменилось. Повторите отключение участника.",
        );
      const revoked = s.users.find((u) => u.id === input.revokeId);
      if (
        !revoked ||
        revoked.role === "owner" ||
        revoked.status === "suspended"
      )
        throw new HttpError(400, "Нельзя отключить этого участника.");
      const members = s.users.filter(
        (u) => u.status === "active" && u.id !== input.revokeId,
      );
      if (
        input.keys.length !== members.length ||
        new Set(input.keys.map((k) => k.id)).size !== members.length ||
        members.some(
          (u) =>
            !input.keys.find(
              (k) => k.id === u.id && k.publicKey === u.identity.publicKey,
            ),
        )
      )
        throw new HttpError(400, "Не всем участникам выданы новые ключи.");
      for (const [existing, incoming] of [
        [s.records, input.records],
        [s.history, input.history],
      ] as const) {
        if (
          existing.length !== incoming.length ||
          new Set(incoming.map((r) => `${r.id}:${r.version}`)).size !==
            existing.length ||
          existing.some(
            (r) =>
              !incoming.find((v) => v.id === r.id && v.version === r.version),
          )
        )
          throw new HttpError(400, "Неполный набор зашифрованных записей.");
      }
      for (const r of input.records)
        await c.query(
          "UPDATE records SET box=$1,epoch=$2 WHERE id=$3 AND version=$4",
          [r.box, input.epoch, r.id, r.version],
        );
      for (const r of input.history)
        await c.query(
          "UPDATE record_history SET box=$1,epoch=$2 WHERE record_id=$3 AND version=$4",
          [r.box, input.epoch, r.id, r.version],
        );
      for (const key of input.keys)
        await c.query("UPDATE users SET sealed_key=$1 WHERE id=$2", [
          key.sealedKey,
          key.id,
        ]);
      await c.query(
        "UPDATE users SET status='suspended',sealed_key=NULL WHERE id=$1",
        [input.revokeId],
      );
      await c.query("DELETE FROM sessions WHERE user_id=$1", [input.revokeId]);
      await c.query("UPDATE vaults SET epoch=$1,recovery=$2", [
        input.epoch,
        input.recovery,
      ]);
      await audit(c, a.user.id, "member.revoked", input.revokeId, {
        epoch: input.epoch,
      });
    });
    return { ok: true };
  });
  const root = resolve(
    process.cwd(),
    process.cwd().endsWith("/apps/server") ? "../web/dist" : "apps/web/dist",
  );
  if (serveStatic && existsSync(root)) {
    await app.register(staticPlugin, {
      root,
      index: "index.html",
      preCompressed: true,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/"))
        return reply.code(404).send({ error: "Маршрут не найден." });
      return reply.sendFile("index.html");
    });
  }
  return app;
}
