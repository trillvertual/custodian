import { z } from "zod";
import { encryptedSchema } from "./schemas.ts";
export const batchLimit = 500;
export const batchByteLimit = 8 * 1024 * 1024;
export const batchSchema = z
  .object({
    id: z.uuid(),
    epoch: z.number().int().positive(),
    records: z
      .array(
        z
          .object({
            id: z.uuid(),
            baseVersion: z.number().int().min(0),
            box: encryptedSchema,
            deleted: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(batchLimit),
  })
  .strict()
  .superRefine((batch, ctx) => {
    if (
      new Set(batch.records.map((record) => record.id)).size !==
      batch.records.length
    )
      ctx.addIssue({ code: "custom", message: "Повторяющиеся ID записей." });
  });
export type RecordBatch = z.infer<typeof batchSchema>;
export const batchResultSchema = z
  .object({
    id: z.uuid(),
    records: z
      .array(
        z
          .object({ id: z.uuid(), version: z.number().int().positive() })
          .strict(),
      )
      .min(1)
      .max(batchLimit),
  })
  .strict();
export type BatchResult = z.infer<typeof batchResultSchema>;
