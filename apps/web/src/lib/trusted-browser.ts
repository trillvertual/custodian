import {
  ready,
  encode,
  decode,
  erase,
  trustedBrowserContextSchema,
  trustedBrowserAad,
  trustedBrowserBoxSchema,
  trustedBrowserSchema,
  type TrustedBrowserContext,
  type TrustedBrowserBox,
} from "../../../../packages/core/src/index.ts";
import { z } from "zod";
import { api, ApiError } from "./api";
import type { Session } from "./store";
import type { PasskeyEnrollmentOperation } from "./passkey";

type LocalBrowser = {
  id: string;
  scope: string;
  context: TrustedBrowserContext;
  key: CryptoKey;
  createdAt: string;
};
const scope = (userId: string, vaultId: string) => `${vaultId}:${userId}`;
let database: Promise<IDBDatabase> | null = null;
export function openBrowserDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  database = new Promise<IDBDatabase>((resolve, reject) => {
    let failed = false;
    const fail = () => {
      failed = true;
      reject(
        new Error(
          "Не удалось открыть хранилище ключа браузера. Проверьте разрешения и свободное место.",
        ),
      );
    };
    if (!globalThis.indexedDB || !crypto.subtle) {
      fail();
      return;
    }
    const request = indexedDB.open("custodian-device-keys", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("keys", { keyPath: "id" });
      store.createIndex("scope", "scope");
    };
    request.onerror = request.onblocked = fail;
    request.onsuccess = () => {
      const db = request.result;
      if (failed) {
        db.close();
        return;
      }
      db.onversionchange = () => {
        db.close();
        database = null;
      };
      resolve(db);
    };
  }).catch((error) => {
    database = null;
    throw error;
  });
  return database;
}
export async function localBrowserKeys(
  userId: string,
  vaultId: string,
): Promise<LocalBrowser[]> {
  const db = await openBrowserDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("keys", "readonly");
    const request = tx
      .objectStore("keys")
      .index("scope")
      .getAll(scope(userId, vaultId));
    request.onsuccess = () => {
      const rows: LocalBrowser[] = [];
      for (const raw of request.result) {
        const parsed = trustedBrowserContextSchema.safeParse(raw.context);
        if (
          !parsed.success ||
          raw.id !== parsed.data.id ||
          raw.scope !== scope(userId, vaultId) ||
          parsed.data.userId !== userId ||
          parsed.data.vaultId !== vaultId
        )
          continue;
        if (
          !(raw.key instanceof CryptoKey) ||
          raw.key.extractable ||
          raw.key.type !== "secret" ||
          raw.key.algorithm.name !== "AES-GCM" ||
          (raw.key.algorithm as AesKeyAlgorithm).length !== 256
        )
          continue;
        rows.push({ ...raw, context: parsed.data });
      }
      resolve(rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    };
    request.onerror = tx.onabort = () =>
      reject(new Error("Не удалось прочитать ключ браузера."));
  });
}
export async function removeBrowserKey(id: string) {
  const db = await openBrowserDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("keys", "readwrite", { durability: "strict" });
    tx.objectStore("keys").delete(id);
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () =>
      reject(new Error("Не удалось удалить ключ браузера."));
  });
}
async function saveBrowserKey(row: LocalBrowser) {
  const db = await openBrowserDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("keys", "readwrite", { durability: "strict" });
    tx.objectStore("keys").put(row);
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () =>
      reject(new Error("Браузер не разрешил сохранить локальный ключ."));
  });
}
export async function encryptBrowserIdentity(
  context: TrustedBrowserContext,
  key: CryptoKey,
  privateKey: Uint8Array,
): Promise<TrustedBrowserBox> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  if (privateKey.length !== 32) throw new Error("Некорректный личный ключ.");
  // WebCrypto copies BufferSource arguments on invocation, before its async work.
  const plaintext = privateKey.slice();
  let operation: Promise<ArrayBuffer>;
  try {
    operation = crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: trustedBrowserAad(context).slice().buffer,
      },
      key,
      plaintext,
    );
  } finally {
    erase(plaintext);
  }
  const ciphertext = new Uint8Array(await operation);
  return trustedBrowserBoxSchema.parse({
    v: 1,
    algorithm: "AES-256-GCM",
    iv: encode(iv),
    ciphertext: encode(ciphertext),
  });
}
export async function decryptBrowserIdentity(
  context: TrustedBrowserContext,
  key: CryptoKey,
  input: TrustedBrowserBox,
): Promise<Uint8Array> {
  const box = trustedBrowserBoxSchema.parse(input);
  const buffer = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decode(box.iv).slice().buffer,
      additionalData: trustedBrowserAad(context).slice().buffer,
    },
    key,
    decode(box.ciphertext).slice().buffer,
  );
  const privateKey = new Uint8Array(buffer);
  if (privateKey.length !== 32) {
    erase(privateKey);
    throw new Error("Некорректный личный ключ.");
  }
  return privateKey;
}
export async function rememberBrowser(
  session: Session,
  operation: PasskeyEnrollmentOperation,
  label = "Мой браузер",
) {
  await ready;
  operation.assertActive();
  if (!crypto.subtle || !globalThis.indexedDB)
    throw new Error(
      "Этот браузер не поддерживает сохранение ключа. Используйте HTTPS и разрешите хранение данных сайта.",
    );
  const credentialId = session.credentialId;
  if (session.method !== "passkey" || !credentialId)
    throw new Error("Сначала подтвердите вход с Passkey.");
  const context = trustedBrowserContextSchema.parse({
    id: crypto.randomUUID(),
    userId: session.user.id,
    vaultId: session.user.vaultId,
    credentialId,
    identityPublicKey: session.user.identity.publicKey,
  });
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  operation.assertActive();
  const previous = await localBrowserKeys(context.userId, context.vaultId);
  operation.assertActive();
  const box = await encryptBrowserIdentity(
    context,
    key,
    operation.getPrivateKey(),
  );
  operation.assertActive();
  await saveBrowserKey({
    id: context.id,
    scope: scope(context.userId, context.vaultId),
    context,
    key,
    createdAt: new Date().toISOString(),
  });
  operation.assertActive();
  // Keep the local key on a lost response: the POST may already have committed.
  const result = z
    .object({ id: z.uuid() })
    .strict()
    .parse(
      await api("/auth/trusted-devices", "POST", { ...context, label, box }),
    );
  operation.assertActive();
  if (result.id !== context.id)
    throw new Error("Сервер вернул другой идентификатор браузера.");
  for (const old of previous.filter(
    (row) => row.context.credentialId === credentialId,
  )) {
    operation.assertActive();
    await api(`/auth/trusted-devices/${old.id}`, "DELETE");
    operation.assertActive();
    await removeBrowserKey(old.id);
  }
  return context.id;
}
export async function openTrustedBrowser(
  session: Session,
  credentialId: string,
  assertActive: () => void,
): Promise<Uint8Array | null> {
  await ready;
  assertActive();
  if (session.method !== "passkey" || session.credentialId !== credentialId)
    return null;
  let rows: LocalBrowser[];
  try {
    rows = await localBrowserKeys(session.user.id, session.user.vaultId);
  } catch {
    assertActive();
    return null;
  }
  for (const row of rows.filter(
    (row) => row.context.credentialId === credentialId,
  )) {
    assertActive();
    if (row.context.identityPublicKey !== session.user.identity.publicKey) {
      await removeBrowserKey(row.id);
      continue;
    }
    let privateKey: Uint8Array | null = null;
    try {
      const response = trustedBrowserSchema
        .extend({ box: trustedBrowserBoxSchema })
        .strict()
        .parse(await api(`/auth/trusted-devices/${row.id}/unlock`, "POST", {}));
      assertActive();
      if (
        response.id !== row.context.id ||
        response.userId !== row.context.userId ||
        response.vaultId !== row.context.vaultId ||
        response.credentialId !== row.context.credentialId ||
        response.identityPublicKey !== row.context.identityPublicKey
      )
        throw new Error("Контекст доверенного браузера изменился.");
      privateKey = await decryptBrowserIdentity(
        row.context,
        row.key,
        response.box,
      );
      assertActive();
      const result = privateKey;
      privateKey = null;
      return result;
    } catch (error) {
      assertActive();
      if (error instanceof ApiError && [404, 409].includes(error.status)) {
        await removeBrowserKey(row.id);
        continue;
      }
      throw error;
    } finally {
      erase(privateKey);
    }
  }
  return null;
}
