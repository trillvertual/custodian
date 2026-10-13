import pg from "pg";
export type Database = pg.Pool;
export const migration = `
CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS vaults(id uuid PRIMARY KEY, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100), epoch integer NOT NULL DEFAULT 1 CHECK(epoch>0), recovery jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS users(id uuid PRIMARY KEY, username text NOT NULL UNIQUE, display_name text NOT NULL, role text NOT NULL CHECK(role IN ('owner','admin')), status text NOT NULL CHECK(status IN ('pending','active','suspended')), password_hash text, identity jsonb NOT NULL, sealed_key text, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS one_owner ON users(role) WHERE role='owner';
CREATE TABLE IF NOT EXISTS sessions(token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf text NOT NULL, method text NOT NULL, authenticated_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS invites(token_hash text PRIMARY KEY, created_by uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL, used_at timestamptz);
CREATE TABLE IF NOT EXISTS records(id uuid PRIMARY KEY, version integer NOT NULL CHECK(version>0), epoch integer NOT NULL CHECK(epoch>0), box jsonb NOT NULL, updated_by uuid NOT NULL REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz);
CREATE TABLE IF NOT EXISTS record_history(record_id uuid NOT NULL REFERENCES records(id) ON DELETE CASCADE, version integer NOT NULL, epoch integer NOT NULL, box jsonb NOT NULL, updated_by uuid NOT NULL REFERENCES users(id), updated_at timestamptz NOT NULL, PRIMARY KEY(record_id,version));
CREATE TABLE IF NOT EXISTS credentials(id text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, public_key bytea NOT NULL, counter bigint NOT NULL, transports jsonb NOT NULL, device_type text NOT NULL, backed_up boolean NOT NULL, prf_wrap jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS identities(provider text NOT NULL, subject text NOT NULL, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(provider,subject), UNIQUE(provider,user_id));
CREATE TABLE IF NOT EXISTS flows(token_hash text PRIMARY KEY, purpose text NOT NULL, payload jsonb NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id bigserial PRIMARY KEY, user_id uuid REFERENCES users(id), action text NOT NULL, target text, detail jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_login_version smallint NOT NULL DEFAULT 0;
INSERT INTO schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
`;
export async function migrate(db: Database) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(7364291)");
    await client.query(migration);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
export async function transaction<T>(
  db: Database,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
