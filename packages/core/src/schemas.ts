import { z } from "zod";
export const b64 = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(2_000_000);
export const encryptedSchema = z
  .object({ v: z.literal(1), nonce: b64.length(32), ciphertext: b64.min(22) })
  .strict();
export type Encrypted = z.infer<typeof encryptedSchema>;
export const passwordWrapSchema = z
  .object({
    salt: b64.length(22),
    ops: z.literal(3),
    mem: z.literal(67108864),
    box: encryptedSchema,
  })
  .strict();
export type PasswordWrap = z.infer<typeof passwordWrapSchema>;
export const identitySchema = z
  .object({ publicKey: b64.length(43), master: passwordWrapSchema })
  .strict();
export type Identity = z.infer<typeof identitySchema>;
export const recordSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    type: z.enum(["login", "token", "ssh", "note"]),
    url: z.string().max(2000).default(""),
    username: z.string().max(500).default(""),
    secret: z.string().max(100_000).default(""),
    note: z.string().max(100_000).default(""),
    folder: z.string().max(100).default(""),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    favorite: z.boolean().default(false),
    totp: z
      .object({
        secret: z.string().max(1024),
        digits: z.union([z.literal(6), z.literal(8)]),
        period: z.union([z.literal(30), z.literal(60)]),
        algorithm: z.enum(["SHA1", "SHA256", "SHA512"]),
      })
      .nullable()
      .default(null),
    fields: z
      .array(
        z.object({
          name: z.string().min(1).max(100),
          value: z.string().max(20_000),
          secret: z.boolean(),
        }),
      )
      .max(30)
      .default([]),
  })
  .strict();
export type VaultRecord = z.infer<typeof recordSchema>;
export type StoredRecord = {
  id: string;
  version: number;
  epoch: number;
  box: Encrypted;
  updatedAt: string;
  updatedBy: string;
  deletedAt: string | null;
};
export type DecryptedRecord = StoredRecord & { data: VaultRecord };
export type Member = {
  id: string;
  username: string;
  displayName: string;
  role: "owner" | "admin";
  status: "pending" | "active" | "suspended";
  publicKey: string;
  createdAt: string;
};
export type SessionUser = Member & {
  identity: Identity;
  sealedKey: string | null;
  passkeyWraps: Record<string, Encrypted>;
  vaultId: string;
  epoch: number;
  vaultName: string;
};
export const backupSchema = z.object({
  format: z.literal("shared-vault-backup"),
  version: z.literal(1),
  createdAt: z.string(),
  vault: z.object({
    id: z.uuid(),
    name: z.string(),
    epoch: z.number().int().positive(),
    recovery: encryptedSchema,
  }),
  records: z.array(
    z.object({
      id: z.uuid(),
      version: z.number().int().positive(),
      epoch: z.number().int().positive(),
      box: encryptedSchema,
      updatedAt: z.string(),
      updatedBy: z.string(),
      deletedAt: z.string().nullable(),
    }),
  ),
});
export type Backup = z.infer<typeof backupSchema>;
export const uuid = z.uuid();
export const recordContext = (
  vaultId: string,
  id: string,
  version: number,
  epoch: number,
) => `shared-vault:record:v1:${vaultId}:${id}:${version}:${epoch}`;
export const identityContext = (id: string) => `shared-vault:identity:v1:${id}`;
export const recoveryContext = (vaultId: string, epoch: number) =>
  `shared-vault:recovery:v1:${vaultId}:${epoch}`;
