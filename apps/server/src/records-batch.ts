import type { FastifyInstance } from "fastify";
import { batchSchema } from "../../../packages/core/src/batch.ts";
import { active, audit, HttpError } from "./app.ts";
import { transaction, type Database } from "./db.ts";
import { hash } from "./security.ts";
export function registerRecordBatch(app: FastifyInstance, db: Database) {
  app.post("/api/records/batch", async (req) => {
    const actor = active(req);
    const input = batchSchema.parse(req.body),
      digest = hash(JSON.stringify(input));
    return transaction(db, async (c) => {
      // The same vault lock orders batches against edits and key rotation.
      await c.query("SELECT pg_advisory_xact_lock(7364292)");
      const user = (
        await c.query("SELECT status,sealed_key FROM users WHERE id=$1", [
          actor.user.id,
        ])
      ).rows[0];
      const authenticated = (
        await c.query(
          "SELECT 1 FROM sessions WHERE token_hash=$1 AND expires_at>now()",
          [actor.sessionHash],
        )
      ).rowCount;
      if (!authenticated)
        throw new HttpError(401, "Сессия истекла. Войдите заново.");
      if (user?.status !== "active" || !user.sealed_key)
        throw new HttpError(403, "Доступ к хранилищу отозван.");
      const vault = (await c.query("SELECT epoch FROM vaults")).rows[0];
      if (vault.epoch !== input.epoch)
        throw new HttpError(
          409,
          "Ключ хранилища изменился. Разблокируйте его заново.",
        );
      const receipt = (
        await c.query(
          "SELECT actor_id,payload_hash,result FROM record_batches WHERE id=$1",
          [input.id],
        )
      ).rows[0];
      if (receipt) {
        if (
          receipt.actor_id !== actor.user.id ||
          receipt.payload_hash !== digest
        )
          throw new HttpError(
            409,
            "Этот запрос уже использован для другой операции.",
          );
        return receipt.result;
      }
      const current = (
        await c.query(
          "SELECT * FROM records WHERE id=ANY($1::uuid[]) FOR UPDATE",
          [input.records.map((record) => record.id)],
        )
      ).rows;
      const versions = new Map(current.map((record) => [record.id, record]));
      for (const item of input.records) {
        const previous = versions.get(item.id);
        if ((previous?.version ?? 0) !== item.baseVersion)
          throw new HttpError(
            409,
            "Одна из записей изменена. Ничего не применено. Обновите список и проверьте выбор.",
          );
        if (!previous && item.deleted)
          throw new HttpError(
            400,
            "Новую запись нельзя сразу отправить в корзину.",
          );
      }
      const result = {
        id: input.id,
        records: [] as { id: string; version: number }[],
      };
      for (const item of input.records) {
        const previous = versions.get(item.id);
        if (previous)
          await c.query(
            "INSERT INTO record_history(record_id,version,epoch,box,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,$6)",
            [
              item.id,
              previous.version,
              previous.epoch,
              previous.box,
              previous.updated_by,
              previous.updated_at,
            ],
          );
        const version = item.baseVersion + 1;
        await c.query(
          "INSERT INTO records(id,version,epoch,box,updated_by,deleted_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $6 THEN now() ELSE NULL END) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,epoch=EXCLUDED.epoch,box=EXCLUDED.box,updated_by=EXCLUDED.updated_by,updated_at=now(),deleted_at=EXCLUDED.deleted_at",
          [
            item.id,
            version,
            input.epoch,
            item.box,
            actor.user.id,
            item.deleted,
          ],
        );
        await audit(
          c,
          actor.user.id,
          previous
            ? item.deleted
              ? "record.trashed"
              : previous.deleted_at
                ? "record.restored"
                : "record.updated"
            : "record.created",
          item.id,
          { batch: input.id },
        );
        result.records.push({ id: item.id, version });
      }
      await c.query(
        "INSERT INTO record_batches(id,actor_id,epoch,payload_hash,result) VALUES($1,$2,$3,$4,$5)",
        [input.id, actor.user.id, input.epoch, digest, result],
      );
      await c.query(
        "DELETE FROM record_batches WHERE created_at<now()-interval '30 days'",
      );
      return result;
    });
  });
}
