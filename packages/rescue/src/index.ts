#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import {
  ready,
  recoverVault,
  decryptJson,
  erase,
  backupSchema,
  recordSchema,
  recordContext,
  type Backup,
} from "../../../packages/core/src/index.ts";
import { recoverOwner } from "./recover.ts";
import { transaction } from "../../../apps/server/src/db.ts";
const help = `Custodian rescue CLI

backup --output PATH
  Create an encrypted, consistent backup using DATABASE_URL.

decrypt --backup PATH --key-file PATH --output PATH --allow-plaintext
  Decrypt a backup locally. Output contains passwords and is written with mode 0600.

recover-owner --key-file PATH --password-file PATH
  Restore owner access in DATABASE_URL. Revoke owner sessions, Passkeys and linked identities.
  Replaces encryption identity; does not change records or other members.
  Requires the rescue key for the current vault epoch.

Secrets are accepted only through files, never command-line arguments.
Do not run against a live vault while another operator performs recovery.
`;
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: "string" },
    backup: { type: "string" },
    "key-file": { type: "string" },
    "password-file": { type: "string" },
    "allow-plaintext": { type: "boolean" },
    help: { type: "boolean" },
  },
});
async function file(name: "key-file" | "password-file") {
  const path = values[name];
  if (!path) throw new Error(`Required --${name}`);
  const text = (await readFile(path, "utf8")).trim();
  return name === "key-file" ? text.split(/\r?\n/)[0]!.trim() : text;
}
async function output(data: unknown) {
  if (!values.output) throw new Error("Required --output");
  const path = resolve(values.output);
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  process.stdout.write(`Saved ${path}\n`);
}
try {
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(help);
    process.exit(0);
  }
  await ready;
  if (command === "decrypt") {
    if (!values["allow-plaintext"])
      throw new Error(
        "Plaintext export requires --allow-plaintext. The output will contain all credentials.",
      );
    if (!values.backup) throw new Error("Required --backup");
    const backup = backupSchema.parse(
      JSON.parse(await readFile(values.backup, "utf8")),
    );
    const key = recoverVault(
      backup.vault.recovery,
      await file("key-file"),
      backup.vault.id,
      backup.vault.epoch,
    );
    try {
      const records = backup.records.map((r) => ({
        ...r,
        box: undefined,
        data: recordSchema.parse(
          decryptJson(
            r.box,
            key,
            recordContext(backup.vault.id, r.id, r.version, r.epoch),
          ),
        ),
      }));
      await output({
        format: "shared-vault-plaintext",
        vault: backup.vault.name,
        records,
      });
    } finally {
      erase(key);
    }
  } else if (command === "backup" || command === "recover-owner") {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
    const db = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
    });
    try {
      if (command === "backup") {
        const backup = await transaction(db, async (c) => {
          await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
          const vault = (
            await c.query("SELECT id,name,epoch,recovery FROM vaults")
          ).rows[0];
          if (!vault) throw new Error("Vault is not initialized.");
          const records = (
            await c.query("SELECT * FROM records ORDER BY id")
          ).rows.map((r) => ({
            id: r.id,
            version: r.version,
            epoch: r.epoch,
            box: r.box,
            updatedAt: r.updated_at.toISOString(),
            updatedBy: r.updated_by,
            deletedAt: r.deleted_at?.toISOString() ?? null,
          }));
          return {
            format: "shared-vault-backup",
            version: 1,
            createdAt: new Date().toISOString(),
            vault,
            records,
          } satisfies Backup;
        });
        await output(backup);
      } else {
        const rescueCode = await file("key-file"),
          password = await file("password-file");
        const ownerName = await recoverOwner(db, {
          rescueCode,
          password,
        });
        process.stdout.write(
          `Owner ${ownerName}: access restored. Log in with the supplied password, then configure Passkey.\n`,
        );
      }
    } finally {
      await db.end();
    }
  } else throw new Error(`Unknown command: ${command}\n${help}`);
} catch (error) {
  process.stderr.write(
    `Rescue failed: ${error instanceof Error ? error.message : "Unknown error"}\n`,
  );
  process.exitCode = 1;
}
