import { beforeAll, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ready,
  deriveLoginSecret,
  randomKey,
  createRecovery,
  encryptJson,
  recordSchema,
  recordContext,
  erase,
} from "../packages/core/src/index.ts";
const exec = promisify(execFile);
beforeAll(async () => {
  await ready;
});
it("rescue CLI decrypts a real encrypted backup, protects output permissions and refuses overwrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shared-vault-rescue-test-"));
  const key = randomKey(),
    vaultId = crypto.randomUUID(),
    id = crypto.randomUUID(),
    rescue = createRecovery(key, vaultId, 1),
    data = recordSchema.parse({
      title: "Test secret",
      type: "login",
      secret: "only-in-plaintext-export",
    });
  try {
    await writeFile(
      join(dir, "key.txt"),
      `${rescue.code}\n\nVault recovery metadata\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(dir, "backup.json"),
      JSON.stringify({
        format: "shared-vault-backup",
        version: 1,
        createdAt: new Date().toISOString(),
        vault: { id: vaultId, name: "Test", epoch: 1, recovery: rescue.box },
        records: [
          {
            id,
            version: 1,
            epoch: 1,
            box: encryptJson(data, key, recordContext(vaultId, id, 1, 1)),
            updatedAt: new Date().toISOString(),
            updatedBy: "owner",
            deletedAt: null,
          },
        ],
      }),
    );
    const args = [
      "packages/rescue/src/index.ts",
      "decrypt",
      "--backup",
      join(dir, "backup.json"),
      "--key-file",
      join(dir, "key.txt"),
      "--output",
      join(dir, "credentials.json"),
    ];
    const command = join(process.cwd(), "node_modules/.bin/tsx");
    await expect(exec(command, args)).rejects.toThrow();
    await exec(command, [...args, "--allow-plaintext"]);
    const plaintext = JSON.parse(
      await readFile(join(dir, "credentials.json"), "utf8"),
    );
    expect(plaintext.records[0].data.secret).toBe("only-in-plaintext-export");
    expect((await stat(join(dir, "credentials.json"))).mode & 0o777).toBe(
      0o600,
    );
    await expect(
      exec(command, [...args, "--allow-plaintext"]),
    ).rejects.toThrow();
    const wrong = createRecovery(key, vaultId, 1);
    await writeFile(join(dir, "wrong-key.txt"), wrong.code);
    await expect(
      exec(command, [
        "packages/rescue/src/index.ts",
        "decrypt",
        "--backup",
        join(dir, "backup.json"),
        "--key-file",
        join(dir, "wrong-key.txt"),
        "--output",
        join(dir, "wrong.json"),
        "--allow-plaintext",
      ]),
    ).rejects.toThrow();
  } finally {
    erase(key);
    await rm(dir, { recursive: true, force: true });
  }
});

it("owner rescue is atomic, preserves ciphertext, revokes old access and replaces the identity", async () => {
  const { testDatabase } = await import("./database.ts");
  const { migrate } = await import("../apps/server/src/db.ts");
  const { recoverOwner } = await import("../packages/rescue/src/recover.ts");
  const { createIdentity, sealVaultKey, unlockPassword, openVaultKey } =
    await import("../packages/core/src/index.ts");
  const { verifyPassword } = await import("../apps/server/src/security.ts");
  const db = await testDatabase();
  await migrate(db);
  const key = randomKey(),
    vaultId = crypto.randomUUID(),
    userId = crypto.randomUUID(),
    id = crypto.randomUUID(),
    original = createIdentity("Original password 42!", userId),
    rescue = createRecovery(key, vaultId, 1);
  try {
    await db.query("INSERT INTO vaults(id,name,recovery) VALUES($1,$2,$3)", [
      vaultId,
      "Rescue test",
      rescue.box,
    ]);
    await db.query(
      "INSERT INTO users(id,username,display_name,role,status,identity,sealed_key) VALUES($1,'owner','Owner','owner','active',$2,$3)",
      [
        userId,
        original.identity,
        sealVaultKey(key, original.identity.publicKey, vaultId, 1),
      ],
    );
    await db.query(
      "INSERT INTO records(id,version,epoch,box,updated_by) VALUES($1,1,1,$2,$3)",
      [
        id,
        encryptJson(
          recordSchema.parse({
            title: "Preserved secret",
            type: "login",
            secret: "unchanged",
          }),
          key,
          recordContext(vaultId, id, 1, 1),
        ),
        userId,
      ],
    );
    await db.query(
      "INSERT INTO sessions(token_hash,user_id,csrf,method,expires_at) VALUES('old-session',$1,'csrf','password',now()+interval '1 hour')",
      [userId],
    );
    await db.query(
      "INSERT INTO identities(provider,subject,user_id) VALUES('github','123',$1)",
      [userId],
    );
    const before = (await db.query("SELECT box FROM records")).rows[0].box;
    await expect(
      recoverOwner(db, {
        rescueCode: createRecovery(key, vaultId, 1).code,
        password: "New login password 2026!",
      }),
    ).rejects.toThrow();
    expect((await db.query("SELECT * FROM sessions")).rows.length).toBe(1);
    expect(
      await recoverOwner(db, {
        rescueCode: rescue.code,
        password: "New login password 2026!",
      }),
    ).toBe("owner");
    const restored = (await db.query("SELECT * FROM users")).rows[0];
    expect(restored.identity.publicKey).not.toBe(original.identity.publicKey);
    const privateKey = unlockPassword(
      restored.identity,
      "New login password 2026!",
      userId,
    );
    expect(openVaultKey(restored.sealed_key, privateKey, vaultId, 1)).toEqual(
      key,
    );
    expect(
      await verifyPassword(
        deriveLoginSecret("New login password 2026!", "owner", "localhost"),
        restored.password_hash,
      ),
    ).toBe(true);
    expect((await db.query("SELECT * FROM sessions")).rows.length).toBe(0);
    expect((await db.query("SELECT * FROM identities")).rows.length).toBe(0);
    expect((await db.query("SELECT box FROM records")).rows[0].box).toEqual(
      before,
    );
    expect((await db.query("SELECT action FROM audit")).rows[0].action).toBe(
      "owner.rescue",
    );
    erase(privateKey);
  } finally {
    erase(key);
    erase(original.privateKey);
    await db.end();
  }
});
