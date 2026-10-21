import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  trustedBrowserCreateSchema,
  type TrustedBrowserBox,
} from "../../../packages/core/src/trusted-devices.ts";
import { active, audit, HttpError, type Auth } from "./app.ts";
import { transaction, type Database } from "./db.ts";

const params = z.object({ id: z.uuid() }).strict();
type DeviceRow = {
  id: string;
  user_id: string;
  vault_id: string;
  credential_id: string;
  identity_public_key: string;
  label: string;
  box: TrustedBrowserBox;
  created_at: Date;
  last_used_at: Date | null;
};
const metadata = (row: DeviceRow) => ({
  id: row.id,
  userId: row.user_id,
  vaultId: row.vault_id,
  credentialId: row.credential_id,
  identityPublicKey: row.identity_public_key,
  label: row.label,
  createdAt: row.created_at.toISOString(),
  lastUsedAt: row.last_used_at?.toISOString() ?? null,
});
async function live(c: PoolClient, actor: Auth, maxAge?: number) {
  await c.query("SELECT pg_advisory_xact_lock(7364292)");
  const row = (
    await c.query(
      "SELECT u.identity,u.status,u.sealed_key,s.method,s.credential_id,s.authenticated_at FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=$1 AND s.token_hash=$2 AND s.expires_at>now() FOR UPDATE OF u,s",
      [actor.user.id, actor.sessionHash],
    )
  ).rows[0];
  if (!row) throw new HttpError(401, "Сессия истекла. Войдите заново.");
  if (row.status !== "active" || !row.sealed_key)
    throw new HttpError(403, "Доступ к хранилищу отозван.");
  if (maxAge !== undefined) {
    if (
      row.method !== "passkey" ||
      !row.credential_id ||
      Date.now() - row.authenticated_at.getTime() > maxAge * 1000
    )
      throw new HttpError(403, "Подтвердите вход с Passkey ещё раз.");
    const credential = await c.query(
      "SELECT id FROM credentials WHERE id=$1 AND user_id=$2 FOR KEY SHARE",
      [row.credential_id, actor.user.id],
    );
    if (!credential.rowCount) throw new HttpError(403, "Passkey отключён.");
  }
  return row;
}
export function registerTrustedDevices(app: FastifyInstance, db: Database) {
  app.get("/api/auth/trusted-devices", async (req) => {
    const actor = active(req);
    const rows = (
      await db.query(
        "SELECT id,user_id,vault_id,credential_id,identity_public_key,label,created_at,last_used_at FROM trusted_devices WHERE user_id=$1 ORDER BY created_at DESC",
        [actor.user.id],
      )
    ).rows;
    return rows.map(metadata);
  });
  app.post("/api/auth/trusted-devices", async (req) => {
    const actor = active(req),
      input = trustedBrowserCreateSchema.parse(req.body);
    return transaction(db, async (c) => {
      const current = await live(c, actor, 15 * 60);
      const vault = (await c.query("SELECT id FROM vaults LIMIT 1")).rows[0];
      if (
        input.userId !== actor.user.id ||
        input.vaultId !== vault.id ||
        input.credentialId !== current.credential_id
      )
        throw new HttpError(
          403,
          "Браузер не связан с подтверждённым аккаунтом и Passkey.",
        );
      if (input.identityPublicKey !== current.identity.publicKey)
        throw new HttpError(
          409,
          "Личный ключ изменился. Разблокируйте хранилище заново.",
        );
      const existing = (
        await c.query("SELECT * FROM trusted_devices WHERE id=$1", [input.id])
      ).rows[0];
      if (existing) {
        if (
          existing.user_id === input.userId &&
          existing.credential_id === input.credentialId &&
          existing.identity_public_key === input.identityPublicKey &&
          existing.box.v === input.box.v &&
          existing.box.algorithm === input.box.algorithm &&
          existing.box.iv === input.box.iv &&
          existing.box.ciphertext === input.box.ciphertext &&
          existing.label === input.label
        )
          return { id: input.id };
        throw new HttpError(409, "Идентификатор браузера уже использован.");
      }
      await c.query(
        "DELETE FROM trusted_devices WHERE user_id=$1 AND identity_public_key<>$2",
        [actor.user.id, current.identity.publicKey],
      );
      const count = (
        await c.query(
          "SELECT count(*)::int AS n FROM trusted_devices WHERE user_id=$1",
          [actor.user.id],
        )
      ).rows[0].n;
      if (count >= 10)
        throw new HttpError(
          400,
          "Можно запомнить до 10 браузеров. Сначала отключите ненужный.",
        );
      await c.query(
        "INSERT INTO trusted_devices(id,user_id,vault_id,credential_id,identity_public_key,label,box) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          input.id,
          input.userId,
          input.vaultId,
          input.credentialId,
          input.identityPublicKey,
          input.label,
          input.box,
        ],
      );
      await audit(c, actor.user.id, "auth.browser.trusted", input.id);
      return { id: input.id };
    });
  });
  app.post("/api/auth/trusted-devices/:id/unlock", async (req) => {
    const actor = active(req),
      { id } = params.parse(req.params);
    return transaction(db, async (c) => {
      const current = await live(c, actor, 60);
      const row = (
        await c.query(
          "SELECT * FROM trusted_devices WHERE id=$1 AND user_id=$2 FOR UPDATE",
          [id, actor.user.id],
        )
      ).rows[0];
      if (!row)
        throw new HttpError(404, "Этот браузер больше не является доверенным.");
      if (row.credential_id !== current.credential_id)
        throw new HttpError(
          403,
          "Подтвердите Passkey, с которым запомнили браузер.",
        );
      if (row.identity_public_key !== current.identity.publicKey)
        throw new HttpError(
          409,
          "Личный ключ изменился. Запомните браузер заново.",
        );
      const proof = await c.query(
        "UPDATE sessions SET trusted_unlock_used=true WHERE token_hash=$1 AND trusted_unlock_used=false RETURNING token_hash",
        [actor.sessionHash],
      );
      if (!proof.rowCount)
        throw new HttpError(403, "Подтвердите вход с Passkey ещё раз.");
      await c.query(
        "UPDATE trusted_devices SET last_used_at=now() WHERE id=$1",
        [id],
      );
      await audit(c, actor.user.id, "auth.browser.unlocked", id);
      return { ...metadata(row), box: row.box };
    });
  });
  app.delete("/api/auth/trusted-devices/:id", async (req) => {
    const actor = active(req),
      { id } = params.parse(req.params);
    return transaction(db, async (c) => {
      await live(c, actor);
      const result = await c.query(
        "DELETE FROM trusted_devices WHERE id=$1 AND user_id=$2 RETURNING id",
        [id, actor.user.id],
      );
      if (result.rowCount)
        await audit(c, actor.user.id, "auth.browser.revoked", id);
      return { ok: true };
    });
  });
}
