import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "./config.ts";
import { type Database, transaction } from "./db.ts";
import {
  HttpError,
  newFlow,
  takeFlow,
  makeSession,
  recent,
  audit,
} from "./app.ts";
import { hash, token, equal } from "./security.ts";
const providerSchema = z.enum(["github", "telegram"]);
type Provider = z.infer<typeof providerSchema>;
type OAuthFlow = {
  provider: Provider;
  userId: string | null;
  verifier: string;
  nonce: string;
  bindingHash: string;
};
const jwks = createRemoteJWKSet(
  new URL("https://oauth.telegram.org/.well-known/jwks.json"),
  { timeoutDuration: 10000 },
);
const browserCookie = "vault-oauth";
async function requestJson(
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new HttpError(502, "Провайдер входа недоступен. Повторите попытку.");
  return (await response.json()) as Record<string, unknown>;
}
function credentials(provider: Provider) {
  const id =
    provider === "github" ? config.GITHUB_CLIENT_ID : config.TELEGRAM_CLIENT_ID;
  const secret =
    provider === "github"
      ? config.GITHUB_CLIENT_SECRET
      : config.TELEGRAM_CLIENT_SECRET;
  if (!id || !secret)
    throw new HttpError(400, "Этот способ входа не настроен владельцем.");
  return { id, secret };
}
export function registerOAuth(app: FastifyInstance, db: Database) {
  app.post("/api/auth/oauth/start", async (req, reply) => {
    const { provider, link } = z
      .object({ provider: providerSchema, link: z.boolean().default(false) })
      .strict()
      .parse(req.body);
    if (link) recent(req);
    const { id } = credentials(provider);
    const verifier = token(),
      nonce = token(),
      binding = token();
    const state = await newFlow(
      db,
      "oauth",
      {
        provider,
        userId: link ? req.auth!.user.id : null,
        verifier,
        nonce,
        bindingHash: hash(binding),
      } satisfies OAuthFlow,
      10,
    );
    reply.setCookie(browserCookie, binding, {
      path: "/api/auth/oauth/",
      httpOnly: true,
      secure: config.secure,
      sameSite: "lax",
      maxAge: 600,
    });
    const redirect = `${config.origin}/api/auth/oauth/${provider}/callback`;
    const url = new URL(
      provider === "github"
        ? "https://github.com/login/oauth/authorize"
        : "https://oauth.telegram.org/auth",
    );
    url.search = new URLSearchParams({
      client_id: id,
      redirect_uri: redirect,
      response_type: "code",
      state,
      code_challenge: Buffer.from(hash(verifier), "hex").toString("base64url"),
      code_challenge_method: "S256",
      ...(provider === "telegram"
        ? { scope: "openid profile", nonce }
        : { scope: "read:user", allow_signup: "false" }),
    }).toString();
    return { url: url.toString() };
  });
  app.get("/api/auth/oauth/:provider/callback", async (req, reply) => {
    try {
      const { provider } = z
        .object({ provider: providerSchema })
        .parse(req.params);
      const query = z
        .object({
          state: z.string(),
          code: z.string().optional(),
          error: z.string().optional(),
        })
        .parse(req.query);
      const flow = await takeFlow<OAuthFlow>(db, query.state, "oauth");
      const binding = req.cookies[browserCookie];
      reply.clearCookie(browserCookie, { path: "/api/auth/oauth/" });
      if (
        flow.provider !== provider ||
        !binding ||
        !equal(flow.bindingHash, hash(binding))
      )
        throw new HttpError(403, "Не удалось проверить запрос входа.");
      if (query.error || !query.code) throw new HttpError(400, "Вход отменён.");
      if (flow.userId && (!req.auth || req.auth.user.id !== flow.userId))
        throw new HttpError(403, "Сессия подключения аккаунта истекла.");
      if (flow.userId) recent(req);
      const { id, secret } = credentials(provider);
      const redirect = `${config.origin}/api/auth/oauth/${provider}/callback`;
      const params = new URLSearchParams({
        client_id: id,
        client_secret: secret,
        code: query.code,
        redirect_uri: redirect,
        grant_type: "authorization_code",
        code_verifier: flow.verifier,
      });
      if (provider === "telegram") params.delete("client_secret");
      const result = await requestJson(
        provider === "github"
          ? "https://github.com/login/oauth/access_token"
          : "https://oauth.telegram.org/token",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            ...(provider === "telegram"
              ? {
                  Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
                }
              : {}),
          },
          body: params.toString(),
        },
      );
      let subject: string;
      if (provider === "telegram") {
        if (typeof result.id_token !== "string")
          throw new HttpError(
            401,
            "Провайдер не вернул подтверждение личности.",
          );
        const { payload } = await jwtVerify(result.id_token, jwks, {
          issuer: "https://oauth.telegram.org",
          audience: id,
          algorithms: ["RS256"],
          requiredClaims: ["sub", "iat", "exp"],
          maxTokenAge: "10m",
          clockTolerance: 10,
        });
        // The nonce requested during authorization is mandatory in the ID token.
        if (payload.nonce !== flow.nonce)
          throw new HttpError(401, "Неверное подтверждение входа.");
        if (!payload.sub)
          throw new HttpError(401, "Нет идентификатора Telegram.");
        subject = payload.sub;
      } else {
        if (typeof result.access_token !== "string")
          throw new HttpError(401, "GitHub не подтвердил вход.");
        const profile = await requestJson("https://api.github.com/user", {
          headers: {
            Authorization: `Bearer ${result.access_token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        });
        if (typeof profile.id !== "number" || !Number.isSafeInteger(profile.id))
          throw new HttpError(401, "GitHub вернул некорректный идентификатор.");
        subject = String(profile.id);
      }
      // Never create users or link identities by mutable usernames/email addresses.
      if (flow.userId) {
        await transaction(db, async (c) => {
          const found = (
            await c.query(
              "SELECT user_id FROM identities WHERE provider=$1 AND subject=$2",
              [provider, subject],
            )
          ).rows[0];
          if (found && found.user_id !== flow.userId)
            throw new HttpError(
              409,
              "Этот аккаунт уже связан с другим участником.",
            );
          const existing = (
            await c.query(
              "SELECT subject FROM identities WHERE provider=$1 AND user_id=$2",
              [provider, flow.userId],
            )
          ).rows[0];
          if (existing && existing.subject !== subject)
            throw new HttpError(
              409,
              "Для этого провайдера уже подключён другой аккаунт.",
            );
          await c.query(
            "INSERT INTO identities(provider,subject,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            [provider, subject, flow.userId],
          );
          await audit(c, flow.userId, "auth.provider.linked", null, {
            provider,
          });
        });
      } else {
        const found = (
          await db.query(
            "SELECT u.id FROM identities i JOIN users u ON u.id=i.user_id WHERE i.provider=$1 AND i.subject=$2 AND u.status<>'suspended'",
            [provider, subject],
          )
        ).rows[0];
        if (!found)
          throw new HttpError(
            403,
            "Аккаунт не подключён. Сначала присоединитесь по приглашению.",
          );
        await makeSession(db, reply, found.id, provider);
        await audit(db, found.id, "auth.login", null, { method: provider });
      }
      return reply.redirect("/?auth=success");
    } catch (error) {
      req.log.warn(
        {
          message:
            error instanceof HttpError
              ? error.message
              : "Provider validation failed",
        },
        "OAuth rejected",
      );
      return reply.redirect(
        `/?auth=error&message=${encodeURIComponent(error instanceof HttpError ? error.message : "Не удалось проверить вход. Повторите попытку.")}`,
      );
    }
  });
}
