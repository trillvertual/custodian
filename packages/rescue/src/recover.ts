import {
  createIdentity,
  deriveLoginSecret,
  sealVaultKey,
  recoverVault,
  erase,
} from "../../core/src/index.ts";
import { config } from "../../../apps/server/src/config.ts";
import { passwordHash } from "../../../apps/server/src/security.ts";
import { transaction, type Database } from "../../../apps/server/src/db.ts";
export async function recoverOwner(
  db: Database,
  { rescueCode, password }: { rescueCode: string; password: string },
): Promise<string> {
  if (password.length < 14 || password.length > 256)
    throw new Error("Login password must contain 14 to 256 characters.");
  return transaction(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(7364292)");
    const vault = (await c.query("SELECT * FROM vaults FOR UPDATE")).rows[0],
      owner = (
        await c.query("SELECT * FROM users WHERE role='owner' FOR UPDATE")
      ).rows[0];
    if (!vault || !owner) throw new Error("Vault is not initialized.");
    const key = recoverVault(vault.recovery, rescueCode, vault.id, vault.epoch);
    let privateKey: Uint8Array | undefined;
    try {
      const created = createIdentity(password, owner.id);
      privateKey = created.privateKey;
      const sealed = sealVaultKey(
        key,
        created.identity.publicKey,
        vault.id,
        vault.epoch,
      );
      const loginHash = await passwordHash(
        deriveLoginSecret(password, owner.username, config.rpId),
      );
      await c.query(
        "UPDATE users SET identity=$1,sealed_key=$2,password_hash=$3,password_login_version=1,status='active' WHERE id=$4",
        [created.identity, sealed, loginHash, owner.id],
      );
      await c.query("DELETE FROM sessions WHERE user_id=$1", [owner.id]);
      await c.query("DELETE FROM credentials WHERE user_id=$1", [owner.id]);
      await c.query("DELETE FROM identities WHERE user_id=$1", [owner.id]);
      await c.query("DELETE FROM flows");
      await c.query(
        "INSERT INTO audit(user_id,action,detail) VALUES($1,'owner.rescue',$2)",
        [owner.id, { epoch: vault.epoch }],
      );
      return owner.username as string;
    } finally {
      erase(key);
      erase(privateKey);
    }
  });
}
