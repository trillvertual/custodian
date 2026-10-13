import { useState, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  Eye,
  EyeOff,
  Copy,
  ExternalLink,
  Star,
  Pencil,
  Trash2,
  X,
  History,
  RotateCcw,
  LockKeyhole,
  KeyRound,
  Check,
} from "lucide-react";
import { toast } from "sonner";
import {
  totp,
  decryptJson,
  recordSchema,
  recordContext,
  type DecryptedRecord,
  type StoredRecord,
} from "../../../../packages/core/src/index.ts";
import { api, copyToClipboard } from "../lib/api";
import type { VaultStore } from "../lib/store";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import {
  Dialog as DialogRoot,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog-primitives";
import { typeLabels } from "./record-editor";
import { useDialogExit } from "../lib/use-dialog-exit";
import { ErrorMessage } from "./forms";
const formatDate = (value: string) =>
  new Intl.DateTimeFormat("ru", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
export function RecordDetail({
  record,
  store,
  onClose,
  onEdit,
  open,
  onExitComplete,
}: {
  record: DecryptedRecord;
  store: VaultStore;
  onClose: () => void;
  onEdit: () => void;
  open: boolean;
  onExitComplete: () => void;
}) {
  const exit = useDialogExit(open, onExitComplete);
  const [show, setShow] = useState<Record<string, boolean>>({}),
    [remove, setRemove] = useState(false),
    [history, setHistory] = useState<DecryptedRecord[] | null>(null),
    [historyOpen, setHistoryOpen] = useState(false),
    [loadingHistory, setLoadingHistory] = useState(false),
    [tick, setTick] = useState(Date.now()),
    [codes, setCodes] = useState(false),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(""),
    [pending, setPending] = useState<string[]>([]);
  const mounted = useRef(true);
  const actions = useRef(new Set<string>());
  const saving = useRef(false);
  const fields = JSON.stringify(record.data.fields);
  const totpConfig = JSON.stringify(record.data.totp);
  const view = useMemo(
    () => ({ open, recordId: record.id, keys: store.keys.current }),
    [open, record.id, record.data.secret, totpConfig, fields],
  );
  const currentView = useRef(view);
  currentView.current = view;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function isCurrent(snapshot: typeof view) {
    return (
      mounted.current &&
      snapshot.open &&
      currentView.current === snapshot &&
      snapshot.keys !== null &&
      store.keys.current === snapshot.keys
    );
  }
  function isActiveRecord(snapshot: typeof view) {
    return (
      mounted.current &&
      currentView.current.open &&
      currentView.current.recordId === snapshot.recordId &&
      snapshot.keys !== null &&
      store.keys.current === snapshot.keys
    );
  }
  function beginAction(name: string) {
    if (actions.current.has(name)) return false;
    actions.current.add(name);
    setPending([...actions.current]);
    return true;
  }
  function endAction(name: string) {
    actions.current.delete(name);
    if (mounted.current) setPending([...actions.current]);
  }
  useLayoutEffect(() => {
    // A version update must not remount the modal. Hide values only when closed
    // or when their contents changed, so a new secret still requires an audit event.
    setShow({});
    setCodes(false);
    setHistory(null);
    setHistoryOpen(false);
    setCopied("");
    if (!open) setRemove(false);
  }, [view]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(""), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    if (!codes) return;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [codes]);
  async function event(action: "revealed" | "copied") {
    await api(`/records/${record.id}/event`, "POST", { action });
  }
  async function copy(value: string, name: string, secret = false) {
    const action = `copy-${name}`;
    if (!beginAction(action)) return;
    const snapshot = currentView.current;
    try {
      if (secret) await event("copied");
      if (!isCurrent(snapshot)) return;
      await copyToClipboard(value);
      if (!isCurrent(snapshot)) return;
      setCopied(name);
      toast.success("Скопировано");
    } catch (e) {
      if (isCurrent(snapshot))
        toast.error((e as Error).message || "Не удалось скопировать.");
    } finally {
      endAction(action);
    }
  }
  async function reveal(name: string) {
    const action = `reveal-${name}`;
    if (!beginAction(action)) return;
    const snapshot = currentView.current;
    const wasShown = show[name];
    try {
      if (!wasShown) await event("revealed");
      if (isCurrent(snapshot)) setShow((s) => ({ ...s, [name]: !wasShown }));
    } catch (e) {
      if (isCurrent(snapshot)) toast.error((e as Error).message);
    } finally {
      endAction(action);
    }
  }
  async function revealCodes() {
    if (!beginAction("reveal-totp")) return;
    const snapshot = currentView.current;
    try {
      await event("revealed");
      if (!isCurrent(snapshot)) return;
      setTick(Date.now());
      setCodes(true);
    } catch (e) {
      if (isCurrent(snapshot)) toast.error((e as Error).message);
    } finally {
      endAction("reveal-totp");
    }
  }
  async function saveRecord(
    data: DecryptedRecord["data"],
    deleted: boolean,
    onSuccess?: () => void,
  ) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    const snapshot = currentView.current;
    try {
      await store.save(data, record, deleted);
      if (isActiveRecord(snapshot)) onSuccess?.();
    } catch (e) {
      if (isActiveRecord(snapshot)) toast.error((e as Error).message);
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function secretField(
    label: string,
    value: string,
    name: string,
    multiline = false,
  ) {
    return (
      <div className="detail-field">
        <label>{label}</label>
        <div className="secret-value">
          <div
            className={multiline && show[name] ? "multiline-secret" : "mono"}
          >
            {show[name] ? value : "••••••••••••••••"}
          </div>
          <div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`${show[name] ? "Скрыть" : "Показать"} ${label.toLowerCase()}`}
              aria-pressed={!!show[name]}
              aria-busy={pending.includes(`reveal-${name}`)}
              disabled={pending.includes(`reveal-${name}`)}
              onClick={() => reveal(name)}
            >
              {show[name] ? <EyeOff size={16} /> : <Eye size={16} />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Копировать ${label.toLowerCase()}`}
              aria-busy={pending.includes(`copy-${name}`)}
              disabled={pending.includes(`copy-${name}`)}
              onClick={() => copy(value, name, true)}
            >
              {copied === name ? <Check size={15} /> : <Copy size={15} />}
            </Button>
          </div>
        </div>
      </div>
    );
  }
  const validUrl = (() => {
    try {
      const url = new URL(record.data.url);
      return ["http:", "https:"].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  })();
  let code: ReturnType<typeof totp> | null = null;
  let codeError = "";
  if (record.data.totp && codes) {
    try {
      code = totp(record.data.totp, tick);
    } catch {
      codeError =
        "Не удалось сгенерировать код 2FA. Проверьте секрет TOTP в редакторе записи.";
    }
  }
  async function loadHistory() {
    if (!beginAction("history")) return;
    const snapshot = currentView.current;
    setLoadingHistory(true);
    try {
      const result = await api<StoredRecord[]>(`/records/${record.id}/history`);
      if (!isCurrent(snapshot)) return;
      setHistory(
        result.map((r) => ({
          ...r,
          data: recordSchema.parse(
            decryptJson(
              r.box,
              snapshot.keys!.vaultKey,
              recordContext(
                store.session!.user.vaultId,
                r.id,
                r.version,
                r.epoch,
              ),
            ),
          ),
        })),
      );
      setHistoryOpen(true);
    } catch (e) {
      if (isCurrent(snapshot)) toast.error((e as Error).message);
    } finally {
      endAction("history");
      if (mounted.current) setLoadingHistory(false);
    }
  }
  return (
    <DialogRoot
      open={open}
      onOpenChange={(open) => {
        if (!open && !saving.current) onClose();
      }}
    >
      <DialogContent
        className="detail-pane"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          exit.ref.current?.focus();
        }}
        {...exit}
      >
        <DialogDescription className="sr-only">
          Сведения о записи
        </DialogDescription>
        <div className="detail-top">
          <div className="detail-heading">
            <DialogTitle>{record.data.title}</DialogTitle>
            <span className="detail-kind">{typeLabels[record.data.type]}</span>
          </div>
          <div className="detail-tools">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={
                record.data.favorite ? "Убрать из избранного" : "В избранное"
              }
              aria-pressed={record.data.favorite}
              disabled={busy}
              aria-busy={busy}
              onClick={() =>
                saveRecord(
                  { ...record.data, favorite: !record.data.favorite },
                  !!record.deletedAt,
                )
              }
            >
              <Star
                size={16}
                className={record.data.favorite ? "favorite-icon" : ""}
              />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Заблокировать"
              onClick={store.lock}
            >
              <LockKeyhole size={16} />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Закрыть сведения"
              disabled={busy}
              onClick={onClose}
            >
              <X size={18} />
            </Button>
          </div>
        </div>
        <div className="detail-body">
          {record.deletedAt ? (
            <div className="notice">
              В корзине с {formatDate(record.deletedAt)}
            </div>
          ) : null}
          {record.data.url && (
            <div className="detail-field">
              <label>Сайт / адрес</label>
              <div className="plain-value">
                {validUrl ? (
                  <a href={validUrl} target="_blank" rel="noreferrer">
                    {record.data.url.replace(/^https?:\/\//, "")}
                    <ExternalLink size={13} />
                  </a>
                ) : (
                  <span>{record.data.url}</span>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Копировать адрес"
                  disabled={pending.includes("copy-url")}
                  onClick={() => copy(record.data.url, "url")}
                >
                  {copied === "url" ? <Check size={15} /> : <Copy size={15} />}
                </Button>
              </div>
            </div>
          )}
          {record.data.username && (
            <div className="detail-field">
              <label>Логин / пользователь</label>
              <div className="plain-value">
                <span>{record.data.username}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Копировать логин"
                  disabled={pending.includes("copy-username")}
                  onClick={() => copy(record.data.username, "username")}
                >
                  {copied === "username" ? (
                    <Check size={15} />
                  ) : (
                    <Copy size={15} />
                  )}
                </Button>
              </div>
            </div>
          )}
          {record.data.secret &&
            secretField(
              record.data.type === "ssh"
                ? "Приватный ключ"
                : record.data.type === "token"
                  ? "API-токен"
                  : "Пароль",
              record.data.secret,
              "secret",
              record.data.type === "ssh",
            )}
          {record.data.totp && (
            <div className="detail-field">
              <label>Одноразовый код · 2FA</label>
              {!codes ? (
                <Button
                  variant="outline"
                  className="full-width"
                  disabled={pending.includes("reveal-totp")}
                  aria-busy={pending.includes("reveal-totp")}
                  onClick={revealCodes}
                >
                  <KeyRound size={16} />
                  Показать код
                </Button>
              ) : codeError ? (
                <>
                  <ErrorMessage error={codeError} />
                  <Button variant="outline" size="sm" onClick={onEdit}>
                    Редактировать TOTP
                  </Button>
                </>
              ) : (
                <div className="totp-value">
                  <span>
                    {code!.code.slice(0, 3)} {code!.code.slice(3)}
                  </span>
                  <div>
                    <small className="totp-remaining">
                      {code!.remaining} с
                    </small>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Копировать код 2FA"
                      disabled={pending.includes("copy-totp")}
                      onClick={() => copy(code!.code, "totp", true)}
                    >
                      {copied === "totp" ? (
                        <Check size={15} />
                      ) : (
                        <Copy size={15} />
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
          {record.data.fields.map((f, i) =>
            f.secret ? (
              <div key={i}>
                {secretField(
                  f.name,
                  f.value,
                  `field-${i}`,
                  f.value.includes("\n"),
                )}
              </div>
            ) : (
              <div className="detail-field" key={i}>
                <label>{f.name}</label>
                <div className="plain-value">
                  <span>{f.value}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Копировать ${f.name}`}
                    disabled={pending.includes(`copy-field-${i}`)}
                    onClick={() => copy(f.value, `field-${i}`)}
                  >
                    {copied === `field-${i}` ? (
                      <Check size={15} />
                    ) : (
                      <Copy size={15} />
                    )}
                  </Button>
                </div>
              </div>
            ),
          )}
          {record.data.note && (
            <div className="detail-field">
              <label>Заметка</label>
              <p className="note-text">{record.data.note}</p>
            </div>
          )}
          <div className="detail-organize">
            {record.data.tags.length > 0 && (
              <div className="detail-field">
                <label>Теги</label>
                <div className="tag-list">
                  {record.data.tags.map((t) => (
                    <span className="tag" key={t}>
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {record.data.folder && (
              <div className="detail-field">
                <label>Папка</label>
                <span>{record.data.folder}</span>
              </div>
            )}
          </div>
          <div className="detail-meta">
            <div>
              <span>Последнее изменение</span>
              <strong>{formatDate(record.updatedAt)}</strong>
            </div>
            <div>
              <span>Версия</span>
              <strong>{record.version}</strong>
            </div>
          </div>
          <Button
            variant="ghost"
            className="history-button"
            disabled={loadingHistory}
            onClick={loadHistory}
          >
            <History size={16} />
            История изменений
          </Button>
        </div>
        <div className="detail-actions">
          {record.deletedAt ? (
            <Button
              className="full-width"
              variant="outline"
              disabled={busy}
              onClick={() =>
                saveRecord(record.data, false, () =>
                  toast.success("Запись восстановлена."),
                )
              }
            >
              <RotateCcw size={16} />
              Восстановить
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                className="detail-delete"
                aria-label="Переместить в корзину"
                disabled={busy}
                onClick={() => setRemove(true)}
              >
                <Trash2 size={17} />
                <span>В корзину</span>
              </Button>
              <Button variant="outline" disabled={busy} onClick={onEdit}>
                <Pencil size={15} />
                Редактировать
              </Button>
            </>
          )}
        </div>
        <Dialog
          open={remove}
          onOpenChange={(next) => {
            if (!saving.current) setRemove(next);
          }}
          title="Переместить запись в корзину?"
          description={`«${record.data.title}» можно будет восстановить.`}
        >
          <div className="dialog-actions">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setRemove(false)}
            >
              Отмена
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                saveRecord(record.data, true, () => {
                  setRemove(false);
                  onClose();
                  toast.success("Запись в корзине.");
                })
              }
            >
              В корзину
            </Button>
          </div>
        </Dialog>
        <Dialog
          open={historyOpen}
          onOpenChange={(open) => {
            if (!open && !saving.current) setHistoryOpen(false);
          }}
          onExitComplete={() => setHistory(null)}
          title="История записи"
          description="Восстановление создаёт новую версию и сохраняет текущую."
        >
          <div className="history-list">
            {history?.length === 0 ? (
              <p className="muted">Предыдущих версий пока нет.</p>
            ) : (
              history?.map((r) => (
                <div className="history-item" key={r.version}>
                  <div>
                    <strong>{r.data.title}</strong>
                    <span>
                      Версия {r.version} · {formatDate(r.updatedAt)}
                    </span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      saveRecord(r.data, false, () => {
                        setHistoryOpen(false);
                        toast.success("Версия восстановлена.");
                      })
                    }
                  >
                    Восстановить
                  </Button>
                </div>
              ))
            )}
          </div>
        </Dialog>
      </DialogContent>
    </DialogRoot>
  );
}
