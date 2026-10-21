import { z } from "zod";
import { b64 } from "./schemas.ts";

export const trustedBrowserContextSchema = z
  .object({
    id: z.uuid(),
    userId: z.uuid(),
    vaultId: z.uuid(),
    credentialId: b64.max(2048),
    identityPublicKey: b64.length(43),
  })
  .strict();
export type TrustedBrowserContext = z.infer<typeof trustedBrowserContextSchema>;
export const trustedBrowserBoxSchema = z
  .object({
    v: z.literal(1),
    algorithm: z.literal("AES-256-GCM"),
    iv: b64.length(16),
    ciphertext: b64.length(64),
  })
  .strict();
export type TrustedBrowserBox = z.infer<typeof trustedBrowserBoxSchema>;
export const trustedBrowserCreateSchema = trustedBrowserContextSchema
  .extend({
    label: z.string().trim().min(1).max(80),
    box: trustedBrowserBoxSchema,
  })
  .strict();
export const trustedBrowserSchema = trustedBrowserContextSchema
  .extend({
    label: z.string(),
    createdAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().nullable(),
  })
  .strict();
export type TrustedBrowser = z.infer<typeof trustedBrowserSchema>;
export function trustedBrowserAad(value: TrustedBrowserContext): Uint8Array {
  const context = trustedBrowserContextSchema.parse(value);
  return new TextEncoder().encode(
    JSON.stringify([
      "custodian:trusted-browser:v1",
      context.vaultId,
      context.userId,
      context.id,
      context.credentialId,
      context.identityPublicKey,
    ]),
  );
}
