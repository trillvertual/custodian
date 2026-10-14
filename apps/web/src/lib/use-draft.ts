import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  draftScope,
  sealDraft,
  type DraftBody,
  type DraftEnvelope,
} from "../../../../packages/core/src/index.ts";
import type { VaultStore } from "./store";
import {
  openDraftDatabase,
  removeDraft,
  writeDraft,
  journalDraft,
} from "./draft-storage";
export function useDraft(
  store: VaultStore,
  id: string,
  body: DraftBody,
  enabled: boolean,
) {
  const user = store.session!.user,
    scope = draftScope(user.vaultId, user.id);
  const db = useRef<IDBDatabase | null>(null),
    latest = useRef<DraftEnvelope | null>(null),
    discarded = useRef(false),
    mounted = useRef(false),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    pending = useRef<Promise<void>>(Promise.resolve());
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
      "idle",
    ),
    [error, setError] = useState("");
  function flush() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const value = latest.current;
    if (discarded.current || !value) return Promise.resolve();
    const save = db.current
      ? writeDraft(db.current, value)
      : openDraftDatabase().then((database) => {
          db.current = database;
          if (discarded.current) return;
          return writeDraft(database, value);
        });
    pending.current = save;
    save
      .then(() => {
        if (mounted.current && !discarded.current && latest.current === value) {
          setStatus("saved");
          setError("");
        }
      })
      .catch((failure) => {
        if (mounted.current && !discarded.current && latest.current === value) {
          setStatus("error");
          setError(
            failure instanceof Error
              ? failure.message
              : "Черновик не сохранён. Проверьте доступ к локальному хранилищу и свободное место.",
          );
        }
      });
    return save;
  }
  useEffect(() => {
    mounted.current = true;
    void openDraftDatabase()
      .then((database) => {
        db.current = database;
      })
      .catch(() => {});
    const departure = () => {
      if (!discarded.current && latest.current) {
        try {
          journalDraft(latest.current);
        } catch {
          /* Storage may be unavailable. */
        }
      }
      void flush().catch(() => {});
    };
    window.addEventListener("pagehide", departure);
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", departure);
      void flush().catch(() => {});
    };
  }, []);
  const started = useRef(false);
  const revision = useRef(1);
  useLayoutEffect(() => {
    if (enabled) started.current = true;
    if (!started.current || discarded.current || !store.keys.current) return;
    try {
      latest.current = sealDraft(
        body,
        store.keys.current.privateKey,
        user.vaultId,
        user.id,
        id,
        ++revision.current,
      );
      setStatus("saving");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void flush().catch(() => {});
      }, 250);
    } catch {
      setStatus("error");
      setError("Не удалось сохранить черновик. Проверьте длину полей.");
    }
  }, [body, enabled, id, scope]);
  async function forget() {
    discarded.current = true;
    latest.current = null;
    if (timer.current) clearTimeout(timer.current);
    try {
      await pending.current.catch(() => {});
      if (db.current) await removeDraft(scope, id);
    } catch (error) {
      discarded.current = false;
      throw error;
    }
  }
  return { status, error, flush, forget };
}
