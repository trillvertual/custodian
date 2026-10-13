import pg from "pg";
import { config } from "./config.ts";
import { migrate } from "./db.ts";
import { buildApp } from "./app.ts";
const db = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
await migrate(db);
const app = await buildApp(db);
const cleanup = setInterval(() => {
  db.query(
    "DELETE FROM sessions WHERE expires_at<now(); DELETE FROM flows WHERE expires_at<now(); DELETE FROM invites WHERE expires_at<now()",
  ).catch((e) => app.log.error(e));
}, 600_000);
cleanup.unref();
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, async () => {
    clearInterval(cleanup);
    await app.close();
    await db.end();
    process.exit(0);
  });
await app.listen({ host: config.HOST, port: config.PORT });
