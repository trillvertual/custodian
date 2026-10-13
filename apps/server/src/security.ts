import { createHash, randomBytes, timingSafeEqual, scrypt } from "node:crypto";
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export function equal(a: string, b: string): boolean {
  const first = Buffer.from(a),
    second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      32,
      { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}
export async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16),
    derived = await derive(password, salt);
  try {
    return `scrypt$65536$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
  } finally {
    derived.fill(0);
  }
}
export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [algorithm, n, r, p, salt, key] = encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    n !== "65536" ||
    r !== "8" ||
    p !== "1" ||
    !salt ||
    !key
  )
    return false;
  const actual = await derive(password, Buffer.from(salt, "base64url"));
  try {
    return equal(actual.toString("base64url"), key);
  } finally {
    actual.fill(0);
  }
}
