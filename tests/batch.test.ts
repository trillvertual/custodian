import { beforeAll, afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./database.ts";
import { migrate, type Database } from "../apps/server/src/db.ts";
import { buildApp } from "../apps/server/src/app.ts";
import {
  ready,
  createIdentity,
  randomKey,
  createRecovery,
  sealVaultKey,
  deriveLoginSecret,
  encryptJson,
  recordContext,
  recordSchema,
  type RecordBatch,
} from "../packages/core/src/index.ts";
import type { FastifyInstance } from "fastify";
let db: Database,
  app: FastifyInstance,
  cookie = "",
  csrf = "";
const userId = randomUUID(),
  vaultId = randomUUID();
let key: Uint8Array;
const request = (body: unknown, auth = true) =>
  app.inject({
    method: "POST",
    url: "/api/records/batch",
    headers: {
      origin: "http://localhost:5173",
      "content-type": "application/json",
      ...(auth ? { cookie, "x-csrf-token": csrf } : {}),
    },
    payload: JSON.stringify(body),
  });
function batch(count = 2): RecordBatch {
  return {
    id: randomUUID(),
    epoch: 1,
    records: Array.from({ length: count }, (_, n) => {
      const id = randomUUID();
      return {
        id,
        baseVersion: 0,
        deleted: false,
        box: encryptJson(
          recordSchema.parse({
            type: "login",
            title: `Synthetic batch ${n}`,
            secret: "SYNTHETIC-only-batch-secret",
          }),
          key,
          recordContext(vaultId, id, 1, 1),
        ),
      };
    }),
  };
}
beforeAll(async () => {
  await ready;
  db = await testDatabase();
  await migrate(db);
  app = await buildApp(db, { serveStatic: false, logger: false });
  await app.ready();
  key = randomKey();
  const owner = createIdentity("Synthetic batch login password!", userId),
    recovery = createRecovery(key, vaultId, 1);
  const result = await app.inject({
    method: "POST",
    url: "/api/auth/bootstrap",
    headers: { origin: "http://localhost:5173" },
    payload: {
      setupToken: process.env.SETUP_TOKEN,
      id: userId,
      vaultId,
      vaultName: "Synthetic Batch",
      username: "batchowner",
      displayName: "Synthetic",
      identity: owner.identity,
      sealedKey: sealVaultKey(key, owner.identity.publicKey, vaultId, 1),
      recovery: recovery.box,
      loginSecret: deriveLoginSecret(
        "Synthetic batch login password!",
        "batchowner",
        "localhost",
      ),
    },
  });
  expect(result.statusCode).toBe(200);
  cookie = String(result.headers["set-cookie"]).split(";")[0]!;
  csrf = result.json().csrf;
});
afterAll(async () => {
  await app.close();
  await db.end();
});
it("imports atomically and concurrent retries produce one mutation and one receipt", async () => {
  const body = batch();
  const [first, second] = await Promise.all([request(body), request(body)]);
  expect(first.statusCode).toBe(200);
  expect(second.json()).toEqual(first.json());
  const rows = (await db.query("SELECT * FROM records")).rows;
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.version === 1)).toBe(true);
  expect((await db.query("SELECT * FROM record_batches")).rows).toHaveLength(1);
  expect(
    (await db.query("SELECT * FROM audit WHERE action='record.created'")).rows,
  ).toHaveLength(2);
  expect(first.body).not.toContain("SYNTHETIC");
});
it("a conflict rolls back every record and every history and audit row", async () => {
  const saved = (await db.query("SELECT * FROM records ORDER BY id")).rows;
  const body = batch();
  body.records[1]!.id = saved[0].id;
  const result = await request(body);
  expect(result.statusCode).toBe(409);
  expect((await db.query("SELECT * FROM records ORDER BY id")).rows).toEqual(
    saved,
  );
  expect((await db.query("SELECT * FROM record_history")).rows).toHaveLength(0);
  expect(
    (await db.query("SELECT * FROM record_batches WHERE id=$1", [body.id]))
      .rows,
  ).toHaveLength(0);
});
it("bulk edits preserve history exactly once; changed payload cannot reuse an operation ID", async () => {
  const source = (await db.query("SELECT * FROM records ORDER BY id")).rows;
  const body: RecordBatch = {
    id: randomUUID(),
    epoch: 1,
    records: source.map((record) => ({
      id: record.id,
      baseVersion: record.version,
      deleted: true,
      box: encryptJson(
        recordSchema.parse({ type: "login", title: "Synthetic bulk trash" }),
        key,
        recordContext(vaultId, record.id, record.version + 1, 1),
      ),
    })),
  };
  expect((await request(body)).statusCode).toBe(200);
  expect((await request(body)).statusCode).toBe(200);
  expect((await db.query("SELECT * FROM record_history")).rows).toHaveLength(
    source.length,
  );
  const reused = structuredClone(body);
  reused.records[0]!.deleted = false;
  expect((await request(reused)).statusCode).toBe(409);
});
it("rejects duplicates, missing authentication, invalid versions and epoch changes before writing", async () => {
  const body = batch(1);
  expect((await request(body, false)).statusCode).toBe(401);
  const repeated = { ...body, records: [...body.records, ...body.records] };
  expect((await request(repeated)).statusCode).toBe(400);
  expect((await request({ ...body, epoch: 2 })).statusCode).toBe(409);
  expect(
    (
      await request({
        ...body,
        records: [{ ...body.records[0], baseVersion: -1 }],
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await db.query("SELECT * FROM records WHERE id=$1", [body.records[0]!.id]))
      .rows,
  ).toHaveLength(0);
});
