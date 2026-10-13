import sodium from "libsodium-wrappers-sumo";
import {
  encryptedSchema,
  passwordWrapSchema,
  type Encrypted,
  type Identity,
  type PasswordWrap,
  identityContext,
  recoveryContext,
} from "./schemas.ts";
export const ready = sodium.ready;
export function encode(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}
export function decode(value: string): Uint8Array {
  return sodium.from_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
}
export function randomKey(): Uint8Array {
  return sodium.randombytes_buf(32);
}
export function erase(bytes: Uint8Array | null | undefined) {
  if (bytes) sodium.memzero(bytes);
}
export function encryptBytes(
  data: Uint8Array,
  key: Uint8Array,
  context: string,
): Encrypted {
  const nonce = sodium.randombytes_buf(24);
  return {
    v: 1,
    nonce: encode(nonce),
    ciphertext: encode(
      sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        data,
        context,
        null,
        nonce,
        key,
      ),
    ),
  };
}
export function decryptBytes(
  box: Encrypted,
  key: Uint8Array,
  context: string,
): Uint8Array {
  encryptedSchema.parse(box);
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      decode(box.ciphertext),
      context,
      decode(box.nonce),
      key,
    );
  } catch {
    throw new Error(
      "Не удалось расшифровать данные. Проверьте ключ или пароль.",
    );
  }
}
export function encryptJson(
  value: unknown,
  key: Uint8Array,
  context: string,
): Encrypted {
  const bytes = sodium.from_string(JSON.stringify(value));
  try {
    return encryptBytes(bytes, key, context);
  } finally {
    erase(bytes);
  }
}
export function decryptJson<T>(
  box: Encrypted,
  key: Uint8Array,
  context: string,
): T {
  const bytes = decryptBytes(box, key, context);
  try {
    return JSON.parse(sodium.to_string(bytes)) as T;
  } finally {
    erase(bytes);
  }
}
function derivePassword(
  password: string,
  wrap: Pick<PasswordWrap, "salt" | "ops" | "mem">,
) {
  return sodium.crypto_pwhash(
    32,
    password,
    decode(wrap.salt),
    wrap.ops,
    wrap.mem,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}
export function wrapPassword(
  secret: Uint8Array,
  password: string,
  id: string,
): PasswordWrap {
  if (password.length < 14 || password.length > 1024)
    throw new Error("Пароль должен содержать от 14 до 1024 символов.");
  const params = {
    salt: encode(sodium.randombytes_buf(16)),
    ops: 3 as const,
    mem: 67108864 as const,
  };
  const key = derivePassword(password, params);
  try {
    return { ...params, box: encryptBytes(secret, key, identityContext(id)) };
  } finally {
    erase(key);
  }
}
export function unlockPassword(
  identity: Identity,
  password: string,
  id: string,
): Uint8Array {
  const params = passwordWrapSchema.parse(identity.master);
  const key = derivePassword(password, params);
  try {
    return decryptBytes(params.box, key, identityContext(id));
  } finally {
    erase(key);
  }
}
// Domain separation ensures a login verifier cannot decrypt an identity envelope.
// This public salt binds a verifier to the installation and normalized username.
export function deriveLoginSecret(
  password: string,
  username: string,
  rpId: string,
): string {
  if (password.length < 1 || password.length > 256)
    throw new Error("Пароль должен содержать не более 256 символов.");
  const salt = sodium.crypto_generichash(
    16,
    sodium.from_string(
      JSON.stringify([
        "custodian:login:v1",
        rpId.toLowerCase(),
        username.trim().toLowerCase(),
      ]),
    ),
    null,
  );
  const key = sodium.crypto_pwhash(
    32,
    password,
    salt,
    3,
    67108864,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  try {
    return encode(key);
  } finally {
    erase(key);
    erase(salt);
  }
}
export function createIdentity(
  password: string,
  id: string,
): { identity: Identity; privateKey: Uint8Array } {
  const pair = sodium.crypto_box_keypair();
  return {
    identity: {
      publicKey: encode(pair.publicKey),
      master: wrapPassword(pair.privateKey, password, id),
    },
    privateKey: pair.privateKey,
  };
}
export function publicKeyFor(privateKey: Uint8Array): string {
  return encode(sodium.crypto_scalarmult_base(privateKey));
}
export function sealVaultKey(
  key: Uint8Array,
  publicKey: string,
  vaultId: string,
  epoch: number,
): string {
  return encode(
    sodium.crypto_box_seal(
      sodium.from_string(
        JSON.stringify({ v: 1, vaultId, epoch, key: encode(key) }),
      ),
      decode(publicKey),
    ),
  );
}
export function openVaultKey(
  sealed: string,
  privateKey: Uint8Array,
  vaultId: string,
  epoch: number,
): Uint8Array {
  let bytes: Uint8Array | undefined;
  try {
    bytes = sodium.crypto_box_seal_open(
      decode(sealed),
      sodium.crypto_scalarmult_base(privateKey),
      privateKey,
    );
    const value = JSON.parse(sodium.to_string(bytes)) as {
      v: number;
      vaultId: string;
      epoch: number;
      key: string;
    };
    if (value.v !== 1 || value.vaultId !== vaultId || value.epoch !== epoch)
      throw new Error("Некорректный ключ хранилища.");
    const key = decode(value.key);
    if (key.length !== 32) throw new Error("Некорректный ключ хранилища.");
    return key;
  } finally {
    erase(bytes);
  }
}
export function fingerprint(publicKey: string): string {
  return sodium
    .to_hex(sodium.crypto_generichash(16, decode(publicKey), null))
    .match(/.{1,4}/g)!
    .join(" ");
}
export function createRecovery(
  key: Uint8Array,
  vaultId: string,
  epoch: number,
): { code: string; box: Encrypted } {
  const rescueKey = randomKey();
  try {
    return {
      code: `SVR1.${encode(rescueKey)}`,
      box: encryptBytes(key, rescueKey, recoveryContext(vaultId, epoch)),
    };
  } finally {
    erase(rescueKey);
  }
}
export function recoverVault(
  box: Encrypted,
  code: string,
  vaultId: string,
  epoch: number,
): Uint8Array {
  if (!/^SVR1\.[A-Za-z0-9_-]{43}$/.test(code.trim()))
    throw new Error("Неверный формат rescue-ключа.");
  const key = decode(code.trim().slice(5));
  try {
    return decryptBytes(box, key, recoveryContext(vaultId, epoch));
  } finally {
    erase(key);
  }
}
export function wrapPasskey(
  privateKey: Uint8Array,
  prf: Uint8Array,
  id: string,
  credentialId: string,
): Encrypted {
  if (prf.length !== 32) throw new Error("Некорректный ответ PRF.");
  return encryptBytes(
    privateKey,
    prf,
    `${identityContext(id)}:passkey:${credentialId}`,
  );
}
export function unlockPasskey(
  box: Encrypted,
  prf: Uint8Array,
  id: string,
  credentialId: string,
): Uint8Array {
  return decryptBytes(
    box,
    prf,
    `${identityContext(id)}:passkey:${credentialId}`,
  );
}
export function generatePassword(length = 28): string {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*-_+=";
  return Array.from(
    { length },
    () => alphabet[sodium.randombytes_uniform(alphabet.length)],
  ).join("");
}
