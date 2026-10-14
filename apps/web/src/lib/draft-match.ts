import {
  normalizeTotp,
  recordSchema,
  type DraftBody,
  type DecryptedRecord,
} from "../../../../packages/core/src/index.ts";
export function draftMatchesRecord(
  body: DraftBody,
  record: DecryptedRecord,
): boolean {
  if (
    body.recordId !== record.id ||
    record.deletedAt ||
    record.version < body.baseVersion
  )
    return false;
  try {
    const input = body.totpInput.trim();
    const normalized = recordSchema.parse({
      ...body.data,
      totp: input
        ? input === body.data.totp?.secret.trim()
          ? body.data.totp
          : normalizeTotp(input)
        : null,
    });
    return JSON.stringify(normalized) === JSON.stringify(record.data);
  } catch {
    return false;
  }
}
