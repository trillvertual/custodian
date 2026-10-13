import { beforeAll, describe, it, expect } from "vitest";
import {
  ready,
  deriveLoginSecret,
  randomKey,
  encryptJson,
  decryptJson,
  createIdentity,
  unlockPassword,
  sealVaultKey,
  openVaultKey,
  createRecovery,
  recoverVault,
  erase,
  recordContext,
  wrapPasskey,
  unlockPasskey,
  totp,
  normalizeTotp,
} from "../packages/core/src/index.ts";
beforeAll(async () => {
  await ready;
});
describe("E2EE and recovery", () => {
  it("rejects wrong keys, record swaps, revision swaps and tampering", () => {
    const key = randomKey(),
      other = randomKey(),
      context = recordContext("vault", "record", 1, 1);
    const box = encryptJson({ secret: "never on server" }, key, context);
    expect(decryptJson(box, key, context)).toEqual({
      secret: "never on server",
    });
    expect(() => decryptJson(box, other, context)).toThrow();
    expect(() =>
      decryptJson(box, key, recordContext("vault", "other", 1, 1)),
    ).toThrow();
    expect(() =>
      decryptJson(box, key, recordContext("vault", "record", 2, 1)),
    ).toThrow();
    expect(() =>
      decryptJson(
        { ...box, ciphertext: box.ciphertext.slice(0, -3) + "AAA" },
        key,
        context,
      ),
    ).toThrow();
    erase(key);
    erase(other);
  });
  it("unlocks private identity only with the correct password", () => {
    const created = createIdentity("Long password 42!", "alice");
    const recovered = unlockPassword(
      created.identity,
      "Long password 42!",
      "alice",
    );
    expect(recovered).toEqual(created.privateKey);
    expect(() =>
      unlockPassword(created.identity, "incorrect password", "alice"),
    ).toThrow();
    expect(() =>
      unlockPassword(created.identity, "Long password 42!", "bob"),
    ).toThrow();
    erase(recovered);
    erase(created.privateKey);
  });
  it("shares a root key only with the chosen recipient and bound vault epoch", () => {
    const alice = createIdentity("Long password 42!", "alice"),
      bob = createIdentity("Other password 42!", "bob"),
      key = randomKey();
    const sealed = sealVaultKey(key, alice.identity.publicKey, "vault", 3);
    expect(openVaultKey(sealed, alice.privateKey, "vault", 3)).toEqual(key);
    expect(() => openVaultKey(sealed, bob.privateKey, "vault", 3)).toThrow();
    expect(() => openVaultKey(sealed, alice.privateKey, "vault", 4)).toThrow();
    expect(() =>
      openVaultKey(sealed, alice.privateKey, "different", 3),
    ).toThrow();
    erase(key);
    erase(alice.privateKey);
    erase(bob.privateKey);
  });
  it("rescues through an independent offline key, without the owner identity", () => {
    const key = randomKey(),
      recovery = createRecovery(key, "vault", 1);
    expect(recoverVault(recovery.box, recovery.code, "vault", 1)).toEqual(key);
    const wrong = createRecovery(key, "vault", 1);
    expect(() => recoverVault(recovery.box, wrong.code, "vault", 1)).toThrow();
    expect(() =>
      recoverVault(recovery.box, recovery.code, "vault", 2),
    ).toThrow();
    erase(key);
  });
  it("does not let a PRF wrap be used for a different user or credential", () => {
    const privateKey = randomKey(),
      prf = randomKey(),
      box = wrapPasskey(privateKey, prf, "alice", "passkey1");
    expect(unlockPasskey(box, prf, "alice", "passkey1")).toEqual(privateKey);
    expect(() => unlockPasskey(box, prf, "alice", "passkey2")).toThrow();
    expect(() => unlockPasskey(box, prf, "bob", "passkey1")).toThrow();
    erase(privateKey);
    erase(prf);
  });
});
function base32(text: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0,
    value = 0,
    result = "";
  for (const byte of new TextEncoder().encode(text)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}
describe("TOTP RFC 6238", () => {
  for (const [time, sha1, sha256, sha512] of [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ] as const) {
    it(`matches all algorithms at ${time}`, () => {
      for (const [algorithm, secret, expected] of [
        ["SHA1", "12345678901234567890", sha1],
        ["SHA256", "12345678901234567890123456789012", sha256],
        [
          "SHA512",
          "1234567890123456789012345678901234567890123456789012345678901234",
          sha512,
        ],
      ] as const) {
        expect(
          totp(
            { algorithm, secret: base32(secret), digits: 8, period: 30 },
            time * 1000,
          ).code,
        ).toBe(expected);
      }
    });
  }
  it("parses otpauth URLs and rejects HOTP and weak or invalid input", () => {
    expect(
      normalizeTotp(
        "otpauth://totp/Test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8&algorithm=SHA256",
      ),
    ).toMatchObject({ digits: 8, algorithm: "SHA256" });
    expect(() =>
      normalizeTotp(
        "otpauth://hotp/Test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      ),
    ).toThrow();
    expect(() => normalizeTotp("abc!")).toThrow();
  });
});

it("separates a normalized installation-bound login verifier from the encryption key", () => {
  const password = "Unified password phrase 2026!",
    id = "alice",
    identity = createIdentity(password, id);
  const verifier = deriveLoginSecret(password, " Alice ", "vault.example");
  expect(verifier).toHaveLength(43);
  expect(deriveLoginSecret(password, "alice", "VAULT.EXAMPLE")).toBe(verifier);
  expect(deriveLoginSecret(password, "bob", "vault.example")).not.toBe(
    verifier,
  );
  expect(deriveLoginSecret(password, "alice", "other.example")).not.toBe(
    verifier,
  );
  expect(() => unlockPassword(identity.identity, verifier, id)).toThrow();
  expect(unlockPassword(identity.identity, password, id)).toEqual(
    identity.privateKey,
  );
});
