import { useEffect, useRef, useState } from "react";
import {
  draftScope,
  openDraft,
  sealDraft,
  type DraftBody,
  type DraftEnvelope,
} from "../../../../packages/core/src/index.ts";
import { draftMatchesRecord } from "../lib/draft-match";
import type { VaultStore } from "../lib/store";
import {
  listDrafts,
  openDraftDatabase,
  removeDraft,
  writeDraft,
} from "../lib/draft-storage";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { ErrorMessage } from "./forms";
type Row = { envelope: DraftEnvelope; body: DraftBody | null };
export function Drafts({
  open,
  store,
  onClose,
  onExitComplete,
  onRestore,
  onOpenRecord,
}: {
  open: boolean;
  store: VaultStore;
  onClose: () => void;
  onExitComplete: () => void;
  onRestore: (body: DraftBody, id: string, asNew: boolean) => void;
  onOpenRecord: (id: string) => void;
}) {
  const [rows, setRows] = useState<Row[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [stale, setStale] = useState<Row | null>(null),
    [deleting, setDeleting] = useState<Row | null>(null);
  const mounted = useRef(false),
    sending = useRef(false),
    keys = useRef(store.keys.current),
    user = store.session!.user,
    scope = draftScope(user.vaultId, user.id);
  const showing = useRef(open);
  showing.current = open;
  const current = () =>
    showing.current &&
    mounted.current &&
    keys.current !== null &&
    store.keys.current === keys.current;
  async function load() {
    setBusy(true);
    setError("");
    try {
      const envelopes = await listDrafts(scope);
      if (!current()) return;
      setRows(
        envelopes.map((envelope) => {
          try {
            return {
              envelope,
              body: openDraft(
                envelope,
                keys.current!.privateKey,
                user.vaultId,
                user.id,
              ),
            };
          } catch {
            return { envelope, body: null };
          }
        }),
      );
    } catch {
      if (current())
        setError("Не удалось прочитать черновики на этом устройстве.");
    } finally {
      if (current()) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, []);
  function isStale(body: DraftBody) {
    return (
      !!body.recordId &&
      !store.records.some(
        (record) =>
          record.id === body.recordId &&
          !record.deletedAt &&
          record.version === body.baseVersion &&
          record.epoch === body.epoch,
      )
    );
  }
  async function restore(row: Row, asNew = false) {
    if (sending.current || !row.body || !current()) return;
    if (!asNew && isStale(row.body)) {
      setStale(row);
      return;
    }
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      const latest = (await listDrafts(scope)).find(
        (value) => value.id === row.envelope.id,
      );
      if (!current()) return;
      if (
        !latest ||
        latest.revision !== row.envelope.revision ||
        latest.box.nonce !== row.envelope.box.nonce
      )
        throw new Error("Черновик изменён в другой вкладке. Обновите список.");
      const body: DraftBody = {
        ...row.body,
        ...(asNew ? { recordId: null, baseVersion: 0 } : {}),
        epoch: user.epoch,
      };
      const envelope = sealDraft(
        body,
        keys.current!.privateKey,
        user.vaultId,
        user.id,
      );
      await writeDraft(
        await openDraftDatabase(),
        envelope,
        row.envelope.id,
        latest,
      );
      if (current()) {
        setStale(null);
        onRestore(body, envelope.id, asNew);
      }
    } catch (error) {
      if (current())
        setError(
          error instanceof Error
            ? error.message
            : "Не удалось восстановить черновик.",
        );
    } finally {
      sending.current = false;
      if (current()) setBusy(false);
    }
  }
  async function remove(row: Row) {
    if (sending.current || !current()) return;
    sending.current = true;
    setBusy(true);
    try {
      await removeDraft(scope, row.envelope.id);
      if (current()) {
        setRows((previous) =>
          previous.filter((value) => value.envelope.id !== row.envelope.id),
        );
        setDeleting(null);
      }
    } catch {
      if (current()) setError("Не удалось удалить черновик.");
    } finally {
      sending.current = false;
      if (current()) setBusy(false);
    }
  }
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !sending.current) onClose();
        }}
        onExitComplete={onExitComplete}
        title="Личные черновики"
        focusContent
        description="Сохранены зашифрованными только в этом браузере. Другие участники их не видят."
      >
        {busy && !rows.length ? (
          <p role="status">Загрузка черновиков…</p>
        ) : !rows.length ? (
          <p className="muted">
            Черновиков нет. При заполнении записи изменения сохраняются
            автоматически.
          </p>
        ) : (
          <div className="draft-list">
            {rows.map((row) => (
              <div className="draft-row" key={row.envelope.id}>
                <div>
                  <strong>
                    {row.body?.data.title ||
                      (row.body
                        ? "Запись без названия"
                        : "Не удалось открыть черновик")}
                  </strong>
                  <p className="muted">
                    {new Intl.DateTimeFormat("ru", {
                      dateStyle: "short",
                      timeStyle: "short",
                    }).format(new Date(row.envelope.updatedAt))}
                    {row.body?.recordId
                      ? " · Редактирование"
                      : " · Новая запись"}
                  </p>
                </div>
                <div className="draft-row-actions">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !row.body}
                    onClick={() => void restore(row)}
                  >
                    Восстановить
                  </Button>
                  {row.body &&
                    store.records.some((record) =>
                      draftMatchesRecord(row.body!, record),
                    ) && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          if (row.body?.recordId)
                            onOpenRecord(row.body.recordId);
                        }}
                      >
                        Открыть сохранённую запись
                      </Button>
                    )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setDeleting(row)}
                  >
                    Удалить
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
        {rows.some((row) => !row.body) && (
          <p className="muted">
            После восстановления личного ключа прежние черновики могут быть
            недоступны. Их можно удалить.
          </p>
        )}
        <ErrorMessage error={error} />
        <div className="dialog-actions">
          <Button variant="outline" disabled={busy} onClick={() => void load()}>
            Обновить
          </Button>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Закрыть
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={!!stale}
        onOpenChange={(next) => {
          if (!next && !sending.current) setStale(null);
        }}
        title="Исходная запись изменилась"
        description="Черновик основан на другой версии или на записи из корзины. Можно открыть его как новую запись и проверить поля."
      >
        <div className="dialog-actions">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setStale(null)}
          >
            Отмена
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              if (stale) void restore(stale, true);
            }}
          >
            Восстановить как новую
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={!!deleting}
        onOpenChange={(next) => {
          if (!next && !sending.current) setDeleting(null);
        }}
        title="Удалить черновик?"
        description="Несохранённые поля этого черновика будут удалены с устройства. Записи хранилища не изменятся."
      >
        <div className="dialog-actions">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setDeleting(null)}
          >
            Отмена
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => {
              if (deleting) void remove(deleting);
            }}
          >
            Удалить черновик
          </Button>
        </div>
      </Dialog>
    </>
  );
}
