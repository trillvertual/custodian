import { Form } from "./ui/form";
import { useRef, useState, useMemo, type FormEvent } from "react";
import { Plus, Trash2, RefreshCw, QrCode } from "lucide-react";
import {
  type DraftBody,
  recordSchema,
  generatePassword,
  normalizeTotp,
  type VaultRecord,
  type DecryptedRecord,
} from "../../../../packages/core/src/index.ts";
import type { VaultStore } from "../lib/store";
import { ApiError } from "../lib/api";
import { useDraft } from "../lib/use-draft";
import { TotpQr } from "./qr-totp";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { ChoicePicker } from "./ui/choice-picker";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./ui/select";
import { Field, PasswordField, Submit, ErrorMessage } from "./forms";
import {
  blankRecord,
  recordFromTemplate,
  recordTemplates,
} from "../lib/record-presets";
export const typeLabels = {
  login: "Логин и пароль",
  token: "API-токен",
  ssh: "SSH-ключ",
  note: "Заметка",
};
export function RecordEditor({
  store,
  record,
  onClose,
  onSaved,
  open,
  onExitComplete,
  initialData,
  draftData,
  draftId: restoredDraftId,
}: {
  store: VaultStore;
  record?: DecryptedRecord;
  onClose: () => void;
  onSaved: (id: string) => void;
  open: boolean;
  onExitComplete: () => void;
  initialData?: VaultRecord;
  draftData?: DraftBody;
  draftId?: string;
}) {
  const [baseRecord] = useState(() => record);
  const [data, setData] = useState<VaultRecord>(
      draftData
        ? structuredClone(draftData.data)
        : record
          ? structuredClone(record.data)
          : initialData
            ? structuredClone(initialData)
            : blankRecord(),
    ),
    [totpInput, setTotpInput] = useState(
      draftData?.totpInput ?? record?.data.totp?.secret ?? "",
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [discard, setDiscard] = useState(false),
    [dirty, setDirty] = useState(false);
  const [templateId, setTemplateId] = useState("blank"),
    [pendingTemplate, setPendingTemplate] = useState<string | null>(null);
  const saving = useRef(false);
  const operation = useRef<ReturnType<VaultStore["prepareBatch"]> | null>(null);
  const [pendingSave, setPendingSave] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [draftId] = useState(() => restoredDraftId ?? crypto.randomUUID());
  const draftBody = useMemo<DraftBody>(
    () => ({
      v: 1,
      data,
      totpInput,
      recordId:
        baseRecord?.id ?? operation.current?.body.records[0]?.id ?? null,
      baseVersion: baseRecord?.version ?? 0,
      epoch: baseRecord?.epoch ?? store.session!.user.epoch,
    }),
    [data, totpInput, baseRecord, pendingSave, store.session!.user.epoch],
  );
  const draft = useDraft(store, draftId, draftBody, dirty || !!draftData);
  async function closeWithDraft(keep: boolean) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    const keys = store.keys.current;
    try {
      if (keep) await draft.flush();
      else await draft.forget();
      if (keys !== null && store.keys.current === keys) {
        setDiscard(false);
        onClose();
      }
    } catch {
      setError(
        keep
          ? "Не удалось сохранить черновик. Оставьте форму открытой или закройте без сохранения."
          : "Не удалось удалить локальный черновик. Попробуйте снова.",
      );
      setDiscard(false);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  function change<K extends keyof VaultRecord>(name: K, value: VaultRecord[K]) {
    if (saving.current || operation.current) return;
    setData((d) => ({ ...d, [name]: value }));
    setDirty(true);
  }
  const close = () => (dirty ? setDiscard(true) : onClose());
  function applyTemplate(id: string) {
    if (saving.current || operation.current) return;
    setData(recordFromTemplate(id));
    setTotpInput("");
    setTemplateId(id);
    setPendingTemplate(null);
    setDirty(false);
    setError("");
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const normalizedInput = totpInput.trim();
      const parsed = recordSchema.safeParse({
        ...data,
        totp: normalizedInput
          ? normalizedInput === data.totp?.secret.trim()
            ? data.totp
            : normalizeTotp(normalizedInput)
          : null,
      });
      if (!parsed.success) {
        const field = parsed.error.issues[0]?.path[0];
        throw new Error(
          field === "title"
            ? "Укажите название записи."
            : field === "totp"
              ? "Проверьте секрет и параметры TOTP."
              : field === "tags"
                ? "Допускается до 20 тегов, не более 40 символов в каждом."
                : "Проверьте значения и длину полей записи.",
        );
      }
      const currentKeys = store.keys.current;
      const request =
        operation.current ??
        store.prepareBatch([{ data: parsed.data, record: baseRecord }]);
      operation.current = request;
      setPendingSave(true);
      const result = await store.executeBatch(request);
      if (result && store.keys.current === currentKeys) {
        void draft
          .forget()
          .catch(() =>
            toast.error(
              "Запись сохранена. Локальный черновик нужно удалить вручную.",
            ),
          );
        onSaved(result.records[0]!.id);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        operation.current = null;
        setPendingSave(false);
      }
      setError(e instanceof Error ? e.message : "Не удалось сохранить запись.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <Dialog
        open={open}
        onExitComplete={onExitComplete}
        onOpenChange={(open) => {
          if (!open && !saving.current) close();
        }}
        title={record ? "Редактировать запись" : "Новая запись"}
        description="Все поля шифруются на вашем устройстве."
        wide
      >
        <Form onSubmit={submit} className="form-stack record-form">
          <div className="record-form-fields">
            <fieldset
              disabled={busy || pendingSave}
              className="record-form-fieldset form-stack"
            >
              {!record && !initialData && !draftData && (
                <div className="field">
                  <label htmlFor="record-template">Шаблон</label>
                  <Select
                    value={templateId}
                    disabled={busy}
                    onValueChange={(id) => {
                      if (id === templateId || saving.current) return;
                      if (dirty) setPendingTemplate(id);
                      else applyTemplate(id);
                    }}
                  >
                    <SelectTrigger id="record-template" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent
                      position="popper"
                      align="start"
                      sideOffset={4}
                    >
                      {recordTemplates.map((template) => (
                        <SelectItem key={template.id} value={template.id}>
                          {template.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {initialData && !record && !draftData && (
                <p className="similar-record-hint">
                  Тип, папка, теги и названия полей перенесены. Значения,
                  заметка и 2FA очищены.
                </p>
              )}
              <div className="form-grid">
                <Field
                  label="Название"
                  autoFocus
                  value={data.title}
                  maxLength={200}
                  onChange={(e) => change("title", e.target.value)}
                  placeholder="Например, Cloudflare"
                  required
                />
                <div className="field">
                  <label htmlFor="record-type">Тип записи</label>
                  <Select
                    disabled={busy}
                    value={data.type}
                    onValueChange={(value) =>
                      change("type", value as VaultRecord["type"])
                    }
                  >
                    <SelectTrigger id="record-type" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent
                      position="popper"
                      align="start"
                      sideOffset={4}
                    >
                      {Object.entries(typeLabels).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Field
                label={data.type === "ssh" ? "Адрес сервера" : "Сайт / адрес"}
                value={data.url}
                maxLength={2000}
                onChange={(e) => change("url", e.target.value)}
                placeholder={
                  data.type === "ssh" ? "192.0.2.10" : "https://example.com"
                }
              />
              {data.type !== "note" && (
                <Field
                  label={data.type === "ssh" ? "Пользователь" : "Логин"}
                  value={data.username}
                  maxLength={500}
                  onChange={(e) => change("username", e.target.value)}
                  autoComplete="off"
                />
              )}
              {data.type === "login" || data.type === "token" ? (
                <div>
                  <PasswordField
                    label={data.type === "token" ? "API-токен" : "Пароль"}
                    value={data.secret}
                    onChange={(e) => change("secret", e.target.value)}
                    autoComplete="off"
                    maxLength={100000}
                  />
                  {data.type === "login" && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="generate-button"
                      onClick={() => change("secret", generatePassword())}
                    >
                      <RefreshCw size={14} />
                      Сгенерировать пароль
                    </Button>
                  )}
                </div>
              ) : data.type === "ssh" ? (
                <div className="field">
                  <label htmlFor="ssh-secret">Приватный SSH-ключ</label>
                  <textarea
                    id="ssh-secret"
                    className="mono-input"
                    rows={5}
                    value={data.secret}
                    onChange={(e) => change("secret", e.target.value)}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={100000}
                  />
                </div>
              ) : null}
              <div className="form-grid">
                <ChoicePicker
                  disabled={busy}
                  label="Папка"
                  value={data.folder ? [data.folder] : []}
                  options={store.records.map((r) => r.data.folder)}
                  onChange={(value) => change("folder", value[0] ?? "")}
                  maxLength={100}
                />
                <ChoicePicker
                  disabled={busy}
                  label="Теги"
                  multiple
                  value={data.tags}
                  options={store.records.flatMap((r) => r.data.tags)}
                  onChange={(value) => change("tags", value)}
                  maxLength={40}
                />
              </div>
              <div className="field">
                <label htmlFor="record-note">Заметка</label>
                <textarea
                  id="record-note"
                  rows={3}
                  value={data.note}
                  onChange={(e) => change("note", e.target.value)}
                  placeholder="Что стоит знать команде"
                  maxLength={100000}
                />
              </div>
              <PasswordField
                label="Секрет TOTP / ссылка otpauth://"
                value={totpInput}
                onChange={(e) => {
                  if (saving.current) return;
                  setTotpInput(e.target.value);
                  setDirty(true);
                }}
                autoComplete="off"
                maxLength={4096}
                hint="Для генерации кодов 2FA. Поле необязательное."
              />
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setQrOpen(true)}
              >
                <QrCode size={16} />
                Сканировать QR для 2FA
              </Button>
              <div className="custom-fields-heading">
                <h3>Дополнительные поля</h3>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={data.fields.length >= 30}
                  onClick={() =>
                    change("fields", [
                      ...data.fields,
                      { name: "", value: "", secret: true },
                    ])
                  }
                >
                  <Plus size={14} />
                  Добавить
                </Button>
              </div>
              {data.fields.map((field, index) => (
                <div className="custom-field" key={index}>
                  <Input
                    aria-label={`Название поля ${index + 1}`}
                    placeholder="Название"
                    value={field.name}
                    maxLength={100}
                    required
                    onChange={(e) =>
                      change(
                        "fields",
                        data.fields.map((f, i) =>
                          i === index ? { ...f, name: e.target.value } : f,
                        ),
                      )
                    }
                  />
                  <Input
                    aria-label={`Значение поля ${index + 1}`}
                    placeholder="Значение"
                    type={field.secret ? "password" : "text"}
                    value={field.value}
                    maxLength={20000}
                    onChange={(e) =>
                      change(
                        "fields",
                        data.fields.map((f, i) =>
                          i === index ? { ...f, value: e.target.value } : f,
                        ),
                      )
                    }
                  />
                  <label className="check-label">
                    <Checkbox
                      checked={field.secret}
                      onCheckedChange={(checked) =>
                        change(
                          "fields",
                          data.fields.map((f, i) =>
                            i === index
                              ? { ...f, secret: checked === true }
                              : f,
                          ),
                        )
                      }
                    />
                    Секрет
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Удалить поле"
                    onClick={() =>
                      change(
                        "fields",
                        data.fields.filter((_, i) => i !== index),
                      )
                    }
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
              ))}
              <ErrorMessage error={error} />
            </fieldset>
          </div>
          {pendingSave && (
            <p className="draft-status">
              Повторное сохранение проверит результат того же запроса.
            </p>
          )}
          {draft.status !== "idle" && (
            <div
              className="draft-status"
              role={draft.status === "error" ? "alert" : undefined}
            >
              {draft.status === "error"
                ? draft.error
                : draft.status === "saved"
                  ? "Черновик сохранён на этом устройстве."
                  : "Сохранение зашифрованного черновика…"}
            </div>
          )}
          <div className="dialog-actions">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={close}
            >
              Отмена
            </Button>
            <Submit busy={busy}>
              {pendingSave
                ? "Повторить сохранение"
                : record
                  ? "Сохранить изменения"
                  : "Создать запись"}
            </Submit>
          </div>
        </Form>
      </Dialog>
      <TotpQr
        open={qrOpen}
        store={store}
        onClose={() => setQrOpen(false)}
        onUse={(uri, issuer) => {
          if (saving.current || operation.current) return;
          setTotpInput(uri);
          setDirty(true);
          if (!data.title && issuer) change("title", issuer);
        }}
      />
      <Dialog
        open={pendingTemplate !== null}
        onOpenChange={(next) => {
          if (!next) setPendingTemplate(null);
        }}
        title="Применить другой шаблон?"
        description="Введённые поля будут заменены полями выбранного шаблона."
      >
        <div className="dialog-actions">
          <Button variant="outline" onClick={() => setPendingTemplate(null)}>
            Оставить поля
          </Button>
          <Button
            onClick={() => {
              if (pendingTemplate) applyTemplate(pendingTemplate);
            }}
          >
            Применить шаблон
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={discard}
        onOpenChange={setDiscard}
        title="Закрыть без сохранения?"
        description="Можно сохранить зашифрованный черновик на этом устройстве или удалить его."
      >
        <div className="dialog-actions">
          <Button variant="outline" onClick={() => setDiscard(false)}>
            Продолжить редактирование
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => void closeWithDraft(false)}
          >
            Не сохранять
          </Button>
          <Button disabled={busy} onClick={() => void closeWithDraft(true)}>
            Сохранить черновик и закрыть
          </Button>
        </div>
      </Dialog>
    </>
  );
}
