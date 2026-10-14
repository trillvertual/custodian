import { useCallback, useEffect, useState } from "react";

const limit = 8;
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export function readRecentRecords(storageKey: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw || raw.length > 2048) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return [
      ...new Set(
        value.filter(
          (id): id is string => typeof id === "string" && uuid.test(id),
        ),
      ),
    ].slice(0, limit);
  } catch {
    return [];
  }
}

export function useRecentRecords(vaultId: string, userId: string) {
  const storageKey = "custodian:recent:v1:" + vaultId + ":" + userId;
  const [history, setHistory] = useState(() => ({
    storageKey,
    ids: readRecentRecords(storageKey),
  }));
  const ids = history.storageKey === storageKey ? history.ids : [];
  useEffect(() => {
    if (history.storageKey !== storageKey) {
      setHistory({ storageKey, ids: readRecentRecords(storageKey) });
      return;
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify(history.ids));
    } catch {
      /* Keep the in-memory history when storage is unavailable. */
    }
  }, [history, storageKey]);
  const remember = useCallback(
    (id: string) => {
      if (!uuid.test(id)) return;
      setHistory((previous) => ({
        storageKey,
        ids: [
          id,
          ...(previous.storageKey === storageKey
            ? previous.ids
            : readRecentRecords(storageKey)
          ).filter((value) => value !== id),
        ].slice(0, limit),
      }));
    },
    [storageKey],
  );
  return { ids, remember };
}
