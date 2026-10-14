import { z } from "zod";
import { recordSchema, encryptedSchema } from "./schemas.ts";
import {
  encryptJson,
  decryptJson,
  erase,
  deriveLocalDraftKey,
} from "./crypto.ts";
export const draftBodySchema = z
  .object({
    v: z.literal(1),
    data: recordSchema.extend({
      title: z.string().max(200),
      fields: z
        .array(
          z
            .object({
              name: z.string().max(100),
              value: z.string().max(20_000),
              secret: z.boolean(),
            })
            .strict(),
        )
        .max(30),
    }),
    totpInput: z.string().max(4096),
    recordId: z.uuid().nullable(),
    baseVersion: z.number().int().min(0),
    epoch: z.number().int().positive(),
  })
  .strict();
export type DraftBody = z.infer<typeof draftBodySchema>;
export const draftEnvelopeSchema = z
  .object({
    key: z.string().max(200),
    scope: z.string().max(100),
    id: z.uuid(),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    updatedAt: z.iso.datetime(),
    box: encryptedSchema,
  })
  .strict();
export type DraftEnvelope = z.infer<typeof draftEnvelopeSchema>;
export const draftScope = (vaultId: string, userId: string) =>
  `${vaultId}:${userId}`;
const context = (scope: string, id: string, revision: number) =>
  `custodian:personal-draft:v1:${scope}:${id}:${revision}`;
export function sealDraft(
  body: DraftBody,
  privateKey: Uint8Array,
  vaultId: string,
  userId: string,
  id: string = crypto.randomUUID(),
  revision = 1,
): DraftEnvelope {
  const scope = draftScope(vaultId, userId),
    key = deriveLocalDraftKey(privateKey, scope);
  try {
    return draftEnvelopeSchema.parse({
      key: `${scope}:${id}`,
      scope,
      id,
      revision,
      updatedAt: new Date().toISOString(),
      box: encryptJson(
        draftBodySchema.parse(body),
        key,
        context(scope, id, revision),
      ),
    });
  } finally {
    erase(key);
  }
}
export function openDraft(
  envelope: DraftEnvelope,
  privateKey: Uint8Array,
  vaultId: string,
  userId: string,
): DraftBody {
  const value = draftEnvelopeSchema.parse(envelope),
    scope = draftScope(vaultId, userId);
  if (value.scope !== scope || value.key !== `${scope}:${value.id}`)
    throw new Error("Черновик другого участника или хранилища.");
  const key = deriveLocalDraftKey(privateKey, scope);
  try {
    return draftBodySchema.parse(
      decryptJson(value.box, key, context(scope, value.id, value.revision)),
    );
  } finally {
    erase(key);
  }
}
