import { hmac } from "@noble/hashes/hmac.js";
import { sha1 } from "@noble/hashes/legacy.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import type { VaultRecord } from "./schemas.ts";
export function decodeBase32(input: string): Uint8Array {
  const text = input.toUpperCase().replace(/[\s=-]/g, "");
  if (!text || !/^[A-Z2-7]+$/.test(text))
    throw new Error("Некорректный Base32-секрет TOTP.");
  let bits = 0,
    value = 0;
  const bytes: number[] = [];
  for (const c of text) {
    value = (value << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  if (bytes.length < 10) throw new Error("Секрет TOTP слишком короткий.");
  return new Uint8Array(bytes);
}
export function normalizeTotp(input: string): NonNullable<VaultRecord["totp"]> {
  const defaults = {
    secret: input.trim(),
    digits: 6 as const,
    period: 30 as const,
    algorithm: "SHA1" as const,
  };
  if (!input.startsWith("otpauth://")) {
    decodeBase32(input);
    return defaults;
  }
  const url = new URL(input);
  if (url.hostname !== "totp") throw new Error("Поддерживается только TOTP.");
  const secret = url.searchParams.get("secret") ?? "";
  decodeBase32(secret);
  const digits = Number(url.searchParams.get("digits") ?? 6);
  const period = Number(url.searchParams.get("period") ?? 30);
  const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
  if (
    (digits !== 6 && digits !== 8) ||
    (period !== 30 && period !== 60) ||
    !["SHA1", "SHA256", "SHA512"].includes(algorithm)
  )
    throw new Error("Неподдерживаемые параметры TOTP.");
  return { secret, digits, period, algorithm } as NonNullable<
    VaultRecord["totp"]
  >;
}
export function totp(
  config: NonNullable<VaultRecord["totp"]>,
  time = Date.now(),
): { code: string; remaining: number } {
  const seconds = Math.floor(time / 1000);
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(
    0,
    BigInt(Math.floor(seconds / config.period)),
  );
  const key = decodeBase32(config.secret);
  try {
    const hash = hmac(
      config.algorithm === "SHA512"
        ? sha512
        : config.algorithm === "SHA256"
          ? sha256
          : sha1,
      key,
      message,
    );
    const offset = hash[hash.length - 1]! & 15;
    const number =
      ((hash[offset]! & 127) << 24) |
      (hash[offset + 1]! << 16) |
      (hash[offset + 2]! << 8) |
      hash[offset + 3]!;
    return {
      code: String(number % 10 ** config.digits).padStart(config.digits, "0"),
      remaining: config.period - (seconds % config.period),
    };
  } finally {
    key.fill(0);
  }
}
