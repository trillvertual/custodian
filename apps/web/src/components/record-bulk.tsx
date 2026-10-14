import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { recordSchema } from "../../../../packages/core/src/index.ts";
import type { VaultStore } from "../lib/store";
import { ApiError } from "../lib/api";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { ChoicePicker } from "./ui/choice-picker";
import { LabeledSelect } from "./ui/labeled-select";
import { ErrorMessage } from "./forms";
export function RecordBulk({
  store,
  ids,
  open,
  onClose,
  onExitComplete,
  onDone,
}: {
  store: VaultStore;
  ids: string[];
  open: boolean;
  onClose: () => void;
  onExitComplete: () => void;
  onDone: () => void;
}) {
  const [records] = useState(() =>
      store.records
        .filter((record) => ids.includes(record.id) && !record.deletedAt)
        .map((record) => structuredClone(record)),
    ),
    [action, setAction] = useState("folder"),
    [folder, setFolder] = useState<string[]>(() => {
      const first = records[0]?.data.folder;
      return first && records.every((record) => record.data.folder === first)
        ? [first]
        : [];
    }),
    [folderChosen, setFolderChosen] = useState(false),
    [tags, setTags] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [operation, setOperation] = useState<ReturnType<
      VaultStore["prepareBatch"]
    > | null>(null);
  const sending = useRef(false),
    mounted = useRef(false),
    keys = useRef(store.keys.current);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const stale = records.some((record) => {
    const current = store.records.find((item) => item.id === record.id);
    return (
      !current ||
      current.version !== record.version ||
      current.epoch !== record.epoch ||
      !!current.deletedAt
    );
  });
  const folders = [
      ...new Set(
        store.records
          .filter((record) => !record.deletedAt)
          .map((record) => record.data.folder)
          .filter(Boolean),
      ),
    ],
    allTags = [
      ...new Set(
        store.records
          .filter((record) => !record.deletedAt)
          .flatMap((record) => record.data.tags),
      ),
    ];
  const exceeding =
    action === "tags"
      ? records.filter(
          (record) => new Set([...record.data.tags, ...tags]).size > 20,
        ).length
      : 0;
  const changing = records.filter((record) =>
    action === "trash" || action === "folder"
      ? action === "trash" || record.data.folder !== (folder[0] ?? "")
      : tags.some((tag) => !record.data.tags.includes(tag)),
  );
  async function submit() {
    if (
      sending.current ||
      keys.current === null ||
      store.keys.current !== keys.current ||
      (!operation &&
        (stale ||
          exceeding ||
          !changing.length ||
          (action === "folder" && !folderChosen) ||
          (action === "tags" && !tags.length)))
    )
      return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      const request =
        operation ??
        store.prepareBatch(
          changing.map((record) => ({
            record,
            data: recordSchema.parse({
              ...record.data,
              ...(action === "folder"
                ? { folder: folder[0] ?? "" }
                : action === "tags"
                  ? { tags: [...new Set([...record.data.tags, ...tags])] }
                  : {}),
            }),
            deleted: action === "trash",
          })),
        );
      setOperation(request);
      const result = await store.executeBatch(request);
      if (mounted.current && store.keys.current === keys.current && result) {
        toast.success(`Обновлено записей: ${result.records.length}.`);
        onDone();
      }
    } catch (error) {
      if (mounted.current && store.keys.current === keys.current) {
        setError(
          error instanceof Error
            ? error.message
            : "Не удалось подтвердить результат. Повторите отправку того же запроса.",
        );
        if (error instanceof ApiError && error.status === 409)
          setOperation(null);
      }
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !sending.current) onClose();
      }}
      onExitComplete={onExitComplete}
      title="Изменить выбранные записи"
      description={`Выбрано ${records.length}. Все изменения сохраняются одной операцией.`}
    >
      <LabeledSelect
        label="Действие"
        value={action}
        disabled={busy || !!operation}
        onChange={setAction}
        options={[
          { value: "folder", label: "Перенести в папку" },
          { value: "tags", label: "Добавить теги" },
          { value: "trash", label: "Переместить в корзину" },
        ]}
      />
      {action === "folder" && (
        <ChoicePicker
          label="Папка"
          options={folders}
          value={folder}
          onChange={(value) => {
            setFolder(value);
            setFolderChosen(true);
          }}
          maxLength={100}
          disabled={busy || !!operation}
        />
      )}
      {action === "tags" && (
        <ChoicePicker
          label="Добавить теги"
          options={allTags}
          value={tags}
          onChange={setTags}
          maxLength={40}
          maxItems={20}
          multiple
          disabled={busy || !!operation}
        />
      )}
      {action === "trash" && (
        <p>Записи будут доступны в корзине. Их можно восстановить.</p>
      )}
      <div className="bulk-preview">
        <strong>Изменяемые записи</strong>
        <ul>
          {records.slice(0, 8).map((record) => (
            <li key={record.id}>{record.data.title}</li>
          ))}
        </ul>
        {records.length > 8 && (
          <p className="muted">И ещё {records.length - 8}.</p>
        )}
      </div>
      <ErrorMessage
        error={
          error ||
          (stale && !operation
            ? "Список изменился. Закройте окно, обновите записи и проверьте выбор."
            : exceeding
              ? `Лимит 20 тегов будет превышен у ${exceeding} записей. Уменьшите набор тегов.`
              : "")
        }
      />
      {operation && (
        <p className="muted">
          Повторная отправка проверит результат того же запроса.
        </p>
      )}
      <div className="dialog-actions">
        <Button variant="outline" disabled={busy} onClick={onClose}>
          Отмена
        </Button>
        <Button
          variant={action === "trash" ? "destructive" : "default"}
          disabled={
            busy ||
            (!operation &&
              (stale ||
                !!exceeding ||
                !records.length ||
                (action === "tags" && !tags.length)))
          }
          onClick={() => void submit()}
        >
          {busy
            ? "Сохранение…"
            : operation
              ? "Повторить отправку"
              : action === "trash"
                ? "В корзину"
                : `Применить (${changing.length})`}
        </Button>
      </div>
    </Dialog>
  );
}
