import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import {
  erase,
  trustedBrowserSchema,
  type TrustedBrowser,
} from "../../../../packages/core/src/index.ts";
import type { VaultStore } from "../lib/store";
import { api } from "../lib/api";
import { authenticatePasskey, cancelPasskeyCeremony } from "../lib/passkey";
import {
  localBrowserKeys,
  rememberBrowser,
  removeBrowserKey,
} from "../lib/trusted-browser";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { Form } from "./ui/form";
import { LabeledSelect } from "./ui/labeled-select";
import { Field, Submit, ErrorMessage } from "./forms";

export function TrustedBrowsers({ store }: { store: VaultStore }) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [rows, setRows] = useState<TrustedBrowser[]>([]),
    [localIds, setLocalIds] = useState<string[]>([]),
    [label, setLabel] = useState("Мой браузер"),
    [credentialId, setCredentialId] = useState(
      store.session!.credentialId ?? store.session!.credentials[0]?.id ?? "",
    );
  const mounted = useRef(true),
    showing = useRef(open),
    generation = useRef(0),
    request = useRef(0),
    currentStore = useRef(store);
  showing.current = open;
  currentStore.current = store;
  const saving = useRef(false);
  useEffect(() => {
    if (
      !store.session!.credentials.some(
        (credential) => credential.id === credentialId,
      )
    )
      setCredentialId(
        store.session!.credentialId ?? store.session!.credentials[0]?.id ?? "",
      );
  }, [credentialId, store.session!.credentials, store.session!.credentialId]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      request.current++;
    };
  }, []);
  async function load() {
    const count = ++request.current,
      keys = store.keys.current,
      user = store.session!.user;
    setLoading(true);
    try {
      const [data, local] = await Promise.all([
        api("/auth/trusted-devices"),
        localBrowserKeys(user.id, user.vaultId).catch(() => []),
      ]);
      if (
        !mounted.current ||
        !showing.current ||
        request.current !== count ||
        currentStore.current.keys.current !== keys
      )
        return;
      setRows(z.array(trustedBrowserSchema).parse(data));
      setLocalIds(local.map((row) => row.id));
    } catch (e) {
      if (mounted.current && showing.current && request.current === count)
        setError(
          e instanceof Error ? e.message : "Не удалось загрузить браузеры.",
        );
    } finally {
      if (mounted.current && showing.current && request.current === count)
        setLoading(false);
    }
  }
  useEffect(() => {
    if (open) {
      setError("");
      void load();
    }
  }, [open]);
  function operation() {
    const count = ++generation.current,
      keys = store.keys.current,
      user = store.session!.user;
    const assertActive = () => {
      const current = currentStore.current;
      if (
        !mounted.current ||
        !showing.current ||
        count !== generation.current ||
        !keys ||
        current.keys.current !== keys ||
        current.session?.user.id !== user.id ||
        current.session.user.identity.publicKey !== user.identity.publicKey
      )
        throw new Error("Настройка доверенного браузера отменена.");
    };
    return {
      assertActive,
      getPrivateKey: () => {
        assertActive();
        return currentStore.current.keys.current!.privateKey;
      },
    };
  }
  async function remember() {
    if (saving.current) return;
    saving.current = true;
    const op = operation();
    setBusy(true);
    setError("");
    let prf: Uint8Array | null = null;
    try {
      op.assertActive();
      const result = await authenticatePasskey(credentialId, op.assertActive);
      prf = result.prf;
      const session = await currentStore.current.refreshSession(false);
      op.assertActive();
      if (
        !session ||
        session.user.id !== store.session!.user.id ||
        session.user.identity.publicKey !==
          store.session!.user.identity.publicKey ||
        session.credentialId !== credentialId
      )
        throw new Error("Подтвердите Passkey текущего аккаунта.");
      await rememberBrowser(session, op, label);
      op.assertActive();
      await currentStore.current.refreshSession();
      op.assertActive();
      await load();
      op.assertActive();
      toast.success(
        "Браузер запомнен. Следующий вход с этим Passkey откроет записи без пароля.",
      );
    } catch (e) {
      if (mounted.current && showing.current)
        setError(
          e instanceof Error ? e.message : "Не удалось запомнить браузер.",
        );
    } finally {
      erase(prf);
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function forget(id: string) {
    if (saving.current) return;
    saving.current = true;
    const op = operation();
    setBusy(true);
    setError("");
    try {
      await api(`/auth/trusted-devices/${id}`, "DELETE");
      await removeBrowserKey(id).catch(() => {});
      op.assertActive();
      await load();
      op.assertActive();
      toast.success(
        "Доверие браузеру отозвано. Открытые записи остаются доступны до блокировки.",
      );
    } catch (e) {
      if (mounted.current && showing.current)
        setError(
          e instanceof Error ? e.message : "Не удалось отключить браузер.",
        );
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <>
      <div className="enrollment-row">
        <span>Доверенные браузеры</span>
        <Button
          variant="outline"
          size="sm"
          disabled={!store.unlocked}
          onClick={() => setOpen(true)}
        >
          Настроить
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (busy) return;
          if (!next) {
            generation.current++;
            request.current++;
            cancelPasskeyCeremony();
          }
          setOpen(next);
        }}
        title="Доверенные браузеры"
        description="Для открытия записей в запомненном браузере хватит Passkey, даже если он хранится в Bitwarden без PRF."
      >
        <p className="muted">
          Ключ сохраняется в этом профиле браузера. Используйте только личное
          устройство. После очистки данных сайта или в другом браузере снова
          понадобится пароль.
        </p>
        <Form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) void remember();
          }}
        >
          <Field
            label="Название браузера"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={80}
            required
            disabled={busy}
          />
          <LabeledSelect
            label="Passkey для открытия"
            value={credentialId}
            onChange={setCredentialId}
            disabled={busy}
            options={store.session!.credentials.map((credential, n) => ({
              value: credential.id,
              label: `Passkey ${n + 1}${credential.prf ? " · PRF" : ""}`,
            }))}
          />
          {!store.session!.credentials.length && (
            <p className="muted">
              Сначала подключите Passkey в способах входа.
            </p>
          )}
          <div className="dialog-actions">
            <Submit busy={busy} disabled={!credentialId || !label.trim()}>
              Запомнить этот браузер
            </Submit>
          </div>
        </Form>
        <h3>Запомненные браузеры</h3>
        {loading ? (
          <p role="status">Загрузка…</p>
        ) : rows.length ? (
          rows.map((row) => (
            <div className="enrollment-row trusted-browser-row" key={row.id}>
              <div>
                <strong>
                  {row.label}
                  {localIds.includes(row.id) ? " · этот браузер" : ""}
                </strong>
                <p className="muted">
                  {new Intl.DateTimeFormat("ru", {
                    dateStyle: "short",
                    timeStyle: "short",
                  }).format(new Date(row.lastUsedAt ?? row.createdAt))}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void forget(row.id)}
              >
                Забыть
              </Button>
            </div>
          ))
        ) : (
          <p className="muted">Доверенных браузеров нет.</p>
        )}
        <ErrorMessage error={error} />
      </Dialog>
    </>
  );
}
