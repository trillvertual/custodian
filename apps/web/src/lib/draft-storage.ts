import {
  draftEnvelopeSchema,
  type DraftEnvelope,
} from "../../../../packages/core/src/index.ts";
const journalPrefix = "custodian:pending-draft:v1:";
export function journalDraft(envelope: DraftEnvelope) {
  localStorage.setItem(
    journalPrefix + envelope.key,
    JSON.stringify(draftEnvelopeSchema.parse(envelope)),
  );
}
function clearJournal(envelope: DraftEnvelope) {
  try {
    const key = journalPrefix + envelope.key;
    const raw = localStorage.getItem(key);
    if (raw) {
      const old = draftEnvelopeSchema.safeParse(JSON.parse(raw));
      if (
        raw === JSON.stringify(envelope) ||
        (old.success && old.data.revision < envelope.revision)
      )
        localStorage.removeItem(key);
    }
  } catch {
    /* A retained encrypted copy remains recoverable. */
  }
}
function readJournal(scope: string): DraftEnvelope[] {
  const rows: DraftEnvelope[] = [];
  try {
    for (let n = 0; n < localStorage.length; n++) {
      const key = localStorage.key(n);
      if (!key?.startsWith(journalPrefix + scope + ":")) continue;
      const raw = localStorage.getItem(key);
      if (!raw || raw.length > 2_300_000) continue;
      try {
        const parsed = draftEnvelopeSchema.safeParse(JSON.parse(raw));
        if (
          parsed.success &&
          parsed.data.scope === scope &&
          key === journalPrefix + parsed.data.key
        )
          rows.push(parsed.data);
      } catch {}
    }
  } catch {}
  return rows;
}
let database: Promise<IDBDatabase> | null = null;
export function openDraftDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  database = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("Локальное хранилище недоступно."));
      return;
    }
    const request = indexedDB.open("custodian-personal", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("drafts", {
        keyPath: "key",
      });
      store.createIndex("scope", "scope");
    };
    request.onerror = () =>
      reject(new Error("Не удалось открыть локальные черновики."));
    request.onblocked = () =>
      reject(
        new Error("Закройте старые вкладки Custodian и попробуйте снова."),
      );
    request.onsuccess = () => {
      const db = request.result;
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
export async function listDrafts(scope: string): Promise<DraftEnvelope[]> {
  const db = await openDraftDatabase();
  const pending = readJournal(scope);
  return new Promise((resolve, reject) => {
    const tx = db.transaction("drafts", "readonly"),
      request = tx.objectStore("drafts").index("scope").getAll(scope);
    request.onsuccess = async () => {
      const rows: DraftEnvelope[] = [];
      for (const raw of request.result) {
        const value = draftEnvelopeSchema.safeParse(raw);
        if (value.success && value.data.scope === scope) rows.push(value.data);
      }
      const merged = new Map(rows.map((row) => [row.id, row]));
      for (const row of pending)
        if (!merged.has(row.id) || row.revision >= merged.get(row.id)!.revision)
          merged.set(row.id, row);
      for (const row of pending) {
        const value = merged.get(row.id)!;
        try {
          await writeDraft(db, value);
        } catch {
          /* Keep the encrypted journal until a durable write succeeds. */
        }
      }
      resolve(
        [...merged.values()].sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt),
        ),
      );
    };
    request.onerror = () =>
      reject(new Error("Не удалось прочитать локальные черновики."));
  });
}
// Begin immediately so pagehide can flush the latest ciphertext before departure.
export function writeDraft(
  db: IDBDatabase,
  envelope: DraftEnvelope,
  replaceId?: string,
  expectedReplacement?: DraftEnvelope,
): Promise<void> {
  const value = draftEnvelopeSchema.parse(envelope);
  return new Promise((resolve, reject) => {
    const tx = db.transaction("drafts", "readwrite", { durability: "strict" }),
      store = tx.objectStore("drafts");
    let limitExceeded = false;
    let conflicted = false;
    const exists = store.get(value.key);
    const replacement = replaceId
      ? store.get(`${value.scope}:${replaceId}`)
      : null;
    exists.onsuccess = () => {
      const count = store.index("scope").count(value.scope);
      count.onsuccess = () => {
        if (
          expectedReplacement &&
          (!replacement?.result ||
            replacement.result.revision !== expectedReplacement.revision ||
            replacement.result.box?.nonce !== expectedReplacement.box.nonce)
        ) {
          conflicted = true;
          tx.abort();
          return;
        }
        if (exists.result?.revision > value.revision) return;
        if (
          exists.result?.revision === value.revision &&
          exists.result.box?.nonce !== value.box.nonce
        ) {
          conflicted = true;
          tx.abort();
          return;
        }
        if (!exists.result && count.result >= 20 && !replacement?.result) {
          limitExceeded = true;
          tx.abort();
          return;
        }
        store.put(value);
        if (replaceId && replaceId !== value.id)
          store.delete(`${value.scope}:${replaceId}`);
      };
    };
    tx.oncomplete = () => {
      clearJournal(value);
      resolve();
    };
    tx.onabort = tx.onerror = () =>
      reject(
        new Error(
          conflicted
            ? "Черновик изменён в другой вкладке. Обновите список."
            : limitExceeded
              ? "Достигнут лимит 20 черновиков. Удалите ненужные."
              : "Не удалось сохранить черновик. Проверьте свободное место и доступ к браузерному хранилищу.",
        ),
      );
  });
}
export async function removeDraft(scope: string, id: string): Promise<void> {
  const db = await openDraftDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("drafts", "readwrite", { durability: "strict" });
    tx.objectStore("drafts").delete(`${scope}:${id}`);
    tx.oncomplete = () => {
      try {
        localStorage.removeItem(journalPrefix + `${scope}:${id}`);
      } catch {}
      resolve();
    };
    tx.onabort = tx.onerror = () =>
      reject(new Error("Не удалось удалить локальный черновик."));
  });
}
