import { PGlite } from "@electric-sql/pglite";
import type { Database } from "../apps/server/src/db.ts";
// The embedded PostgreSQL engine runs production SQL. Serialize clients because
// PGlite is a single connection; advisory locks are provided by this mutex.
export async function testDatabase() {
  const engine = new PGlite();
  await engine.waitReady;
  let queue = Promise.resolve();
  async function acquire() {
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const before = queue;
    queue = before.then(() => next);
    await before;
    return release;
  }
  async function query(sql: string, params?: unknown[]) {
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
    if (sql.includes("CREATE TABLE") && sql.includes(";")) {
      await engine.exec(sql);
      return { rows: [], rowCount: 0 };
    }
    const result = await engine.query(sql, params);
    return {
      rows: result.rows,
      rowCount: /^\s*(SELECT|WITH)/i.test(sql)
        ? result.rows.length
        : result.affectedRows,
    };
  }
  const adapter = {
    query: async (sql: string, params?: unknown[]) => {
      const release = await acquire();
      try {
        return await query(sql, params);
      } finally {
        release();
      }
    },
    connect: async () => {
      const release = await acquire();
      return { query, release };
    },
    end: () => engine.close(),
  };
  return adapter as unknown as Database;
}
