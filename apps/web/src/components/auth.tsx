import { Form } from "./ui/form";
import { Checkbox } from "./ui/checkbox";
import { TrustedBrowsers } from "./trusted-browsers";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ShieldCheck,
  Fingerprint,
  ArrowRight,
  LogOut,
  KeyRound,
  Copy,
} from "lucide-react";
import { toast } from "sonner";
import {
  createIdentity,
  randomKey,
  createRecovery,
  sealVaultKey,
  erase,
  fingerprint,
  deriveLoginSecret,
} from "../../../../packages/core/src/index.ts";
import type { VaultStore } from "../lib/store";
import { api, copyToClipboard, setCsrf } from "../lib/api";
import {
  authenticatePasskey,
  registerPasskey,
  enablePrfWrap,
  cancelPasskeyCeremony,
  type PasskeyEnrollmentOperation,
} from "../lib/passkey";
import { RwpPromo } from "./rwp-promo";
import { Brand } from "./brand";
import { Button } from "./ui/button";
import { Field, PasswordField, Submit, ErrorMessage } from "./forms";
export { Brand } from "./brand";
export async function providerLogin(
  provider: "github" | "telegram",
  link = false,
) {
  const result = await api<{ url: string }>("/auth/oauth/start", "POST", {
    provider,
    link,
  });
  location.assign(result.url);
}
export function AuthScreen({ store }: { store: VaultStore }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState("");
  const params = new URLSearchParams(location.search),
    invite = params.get("invite");
  if (!store.config?.initialized || invite)
    return <SetupScreen store={store} invite={invite} />;
  if (store.session) return <UnlockScreen store={store} />;
  async function passwordSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await store.login(username, password);
      setPassword("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function passkey() {
    setBusy(true);
    setError("");
    try {
      const result = await authenticatePasskey();
      await store.passkeyUnlock(result.id, result.prf);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <div className="auth-container">
        <Brand />
        <div className="auth-card">
          <h1>Вход в хранилище</h1>
          <p>Войдите в аккаунт команды.</p>
          <Button className="full-width" disabled={busy} onClick={passkey}>
            <Fingerprint size={18} />
            Войти с Passkey
          </Button>
          <div className="auth-divider">
            <span>или по паролю</span>
          </div>
          <Form
            id="custodian-login"
            onSubmit={passwordSubmit}
            className="form-stack"
            autoComplete="on"
          >
            <Field
              label="Логин"
              id="custodian-login-username"
              name="username"
              passwordManager="allow"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
            />
            <PasswordField
              label="Пароль"
              id="custodian-login-password"
              name="password"
              passwordManager="allow"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
            <Submit busy={busy}>
              Войти
              <ArrowRight size={16} />
            </Submit>
          </Form>
          <ErrorMessage error={error || store.error} />
        </div>
        <p className="auth-foot">
          <ShieldCheck size={14} />
          Регистрация только по приглашению владельца
        </p>
        <div className="mt-5">
          <RwpPromo side="top" />
        </div>
      </div>
    </main>
  );
}
function SetupScreen({
  store,
  invite,
}: {
  store: VaultStore;
  invite: string | null;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [vaultName, setVaultName] = useState("Хранилище команды"),
    [displayName, setDisplayName] = useState(""),
    [username, setUsername] = useState(""),
    [setupToken, setSetupToken] = useState(""),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [inviteState, setInviteState] = useState<"loading" | "ready" | "invalid">(
      invite ? "loading" : "ready",
    );
  useEffect(() => {
    if (!invite) return;
    let active = true;
    setInviteState("loading");
    api<{ vaultName: string }>("/invites/inspect", "POST", { invite })
      .then((r) => {
        if (!active) return;
        setVaultName(r.vaultName);
        setInviteState("ready");
      })
      .catch((e) => {
        if (!active) return;
        setError(e.message);
        setInviteState("invalid");
      });
    return () => {
      active = false;
    };
  }, [invite]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inviteState !== "ready") return;
    setError("");
    if (password !== confirm) {
      setError("Пароли не совпадают.");
      return;
    }
    setBusy(true);
    let privateKey: Uint8Array | undefined, key: Uint8Array | undefined;
    try {
      const id = crypto.randomUUID(),
        vaultId = crypto.randomUUID();
      const created = createIdentity(password, id);
      privateKey = created.privateKey;
      const loginSecret = deriveLoginSecret(
        password,
        username,
        store.config!.rpId,
      );
      let result: { csrf: string };
      if (invite) {
        result = await api("/invites/accept", "POST", {
          invite,
          id,
          username,
          displayName,
          identity: created.identity,
          loginSecret,
        });
      } else {
        key = randomKey();
        const rescue = createRecovery(key, vaultId, 1);
        result = await api("/auth/bootstrap", "POST", {
          setupToken,
          id,
          vaultId,
          vaultName,
          username,
          displayName,
          identity: created.identity,
          sealedKey: sealVaultKey(key, created.identity.publicKey, vaultId, 1),
          recovery: rescue.box,
          loginSecret,
        });
        store.setRecovery({ code: rescue.code, name: vaultName, epoch: 1 });
      }
      setCsrf(result.csrf);
      store.setConfig({ ...store.config!, initialized: true });
      const session = await store.refreshSession();
      setPassword("");
      setConfirm("");
      setSetupToken("");
      if (invite) {
        history.replaceState(null, "", location.pathname);
        toast.success("Аккаунт создан. Дождитесь подтверждения владельца.");
      } else if (session && privateKey) {
        await store.unlockWithPrivate(privateKey, session);
        privateKey = undefined;
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      erase(privateKey);
      erase(key);
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <div className="auth-container setup-container">
        <Brand />
        <div className="auth-card">
          <h1>{invite ? "Присоединиться к команде" : "Создать хранилище"}</h1>
          <p>
            {invite
              ? inviteState === "loading"
                ? "Проверяем приглашение…"
                : inviteState === "invalid"
                  ? "Приглашение недоступно. Запросите новую ссылку у владельца."
                  : `Вас пригласили в ${vaultName}.`
              : "Создайте аккаунт владельца и хранилище команды."}
          </p>
          {inviteState === "invalid" ? (
            <>
              <ErrorMessage error={error} />
              <Button
                variant="outline"
                className="full-width mt-4"
                onClick={() => location.assign(location.pathname)}
              >
                Вернуться ко входу
              </Button>
            </>
          ) : (
            <Form
              id="custodian-registration"
              onSubmit={submit}
              className="form-stack"
              autoComplete="on"
            >
              {!invite && (
                <>
                  <Field
                    label="Код первоначальной настройки"
                    id="custodian-setup-token"
                    name="setup-token"
                    hint="Из SETUP_TOKEN в конфигурации сервера."
                    value={setupToken}
                    onChange={(e) => setSetupToken(e.target.value)}
                    type="password"
                    autoComplete="off"
                    required
                  />
                  <Field
                    label="Название хранилища"
                    id="custodian-vault-name"
                    name="vault-name"
                    value={vaultName}
                    onChange={(e) => setVaultName(e.target.value)}
                    maxLength={100}
                    required
                  />
                </>
              )}
              <div className="form-grid">
                <Field
                  label="Ваше имя"
                  id="custodian-display-name"
                  name="display-name"
                  passwordManager="allow"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={100}
                  autoComplete="name"
                  disabled={inviteState !== "ready"}
                  required
                />
                <Field
                  label="Логин"
                  id="custodian-registration-username"
                  name="username"
                  passwordManager="allow"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  pattern="[a-z0-9_.\-]{3,64}"
                  hint="3-64 символа: строчные латинские буквы, цифры, точка, дефис и _."
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  minLength={3}
                  maxLength={64}
                  disabled={inviteState !== "ready"}
                  required
                />
              </div>
              <PasswordField
                label="Пароль"
                id="custodian-registration-password"
                name="new-password"
                passwordManager="allow"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={14}
                maxLength={256}
                autoComplete="new-password"
                hint="От 14 до 256 символов. Для входа и открытия записей."
                disabled={inviteState !== "ready"}
                required
              />
              <PasswordField
                label="Повторите пароль"
                id="custodian-registration-confirm"
                name="confirm-password"
                passwordManager="allow"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                minLength={14}
                maxLength={256}
                autoComplete="new-password"
                disabled={inviteState !== "ready"}
                required
              />
              <ErrorMessage error={error} />
              <Submit busy={busy} disabled={inviteState !== "ready"}>
                {invite ? "Создать аккаунт" : "Создать хранилище"}
                <ArrowRight size={16} />
              </Submit>
            </Form>
          )}
        </div>
        <p className="auth-foot">
          <ShieldCheck size={14} />
          Записи шифруются в браузере до отправки на сервер
        </p>
        <div className="mt-5">
          <RwpPromo side="top" />
        </div>
      </div>
    </main>
  );
}
export function UnlockScreen({ store }: { store: VaultStore }) {
  const [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [reset, setReset] = useState(false),
    [savedFingerprint, setSavedFingerprint] = useState(""),
    [remember, setRemember] = useState(false);
  const user = store.session!.user;
  async function unlock(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await store.unlock(password, remember);
      setPassword("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function passkey() {
    setBusy(true);
    setError("");
    try {
      const result = await authenticatePasskey();
      await store.passkeyUnlock(result.id, result.prf);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function recover(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const created = createIdentity(password, user.id);
      try {
        await api("/identity/reset", "POST", {
          identity: created.identity,
          loginSecret: deriveLoginSecret(
            password,
            user.username,
            store.config!.rpId,
          ),
        });
        setSavedFingerprint(fingerprint(created.identity.publicKey));
        await store.refreshSession();
        setPassword("");
        setReset(false);
      } finally {
        erase(created.privateKey);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <div className="auth-container">
        <Brand />
        <div className="auth-card">
          <h1>
            {reset
              ? "Восстановить доступ"
              : user.status === "pending"
                ? "Нужно подтверждение владельца"
                : "Хранилище заблокировано"}
          </h1>
          <p>
            {reset
              ? "Создайте новый пароль. Владелец должен проверить ваш отпечаток и заново выдать ключ."
              : user.status === "pending"
                ? "Передайте владельцу отпечаток своего ключа."
                : `${user.vaultName} · ${user.displayName}`}
          </p>
          {reset ? (
            <Form
              id="custodian-recovery"
              onSubmit={recover}
              className="form-stack"
              autoComplete="on"
            >
              <Field
                label="Логин"
                id="custodian-recovery-username"
                name="username"
                value={user.username}
                readOnly
                autoComplete="username"
                passwordManager="allow"
              />
              <PasswordField
                label="Новый пароль"
                id="custodian-recovery-password"
                name="new-password"
                passwordManager="allow"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={14}
                maxLength={256}
                autoComplete="new-password"
                required
              />
              <Submit busy={busy}>Запросить новый ключ</Submit>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setReset(false)}
              >
                Отмена
              </Button>
            </Form>
          ) : user.status === "pending" ? (
            <>
              <div className="fingerprint-box">
                <span>Отпечаток вашего ключа</span>
                <code>{savedFingerprint || fingerprint(user.publicKey)}</code>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={async () => {
                    try {
                      await copyToClipboard(
                        savedFingerprint || fingerprint(user.publicKey),
                      );
                      toast.success("Отпечаток скопирован.");
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  <Copy size={14} />
                  Скопировать отпечаток
                </Button>
              </div>
              <Button
                variant="outline"
                className="full-width"
                disabled={busy}
                aria-busy={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await store.refreshSession();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Проверить доступ
              </Button>
            </>
          ) : (
            <>
              {store.unlockHint && <p role="status">{store.unlockHint}</p>}
              {store.session!.passwordEnabled && (
                <Form
                  id="custodian-unlock"
                  onSubmit={unlock}
                  className="form-stack"
                  autoComplete="on"
                >
                  <Field
                    label="Логин"
                    id="custodian-unlock-username"
                    name="username"
                    value={user.username}
                    readOnly
                    autoComplete="username"
                    passwordManager="allow"
                  />
                  <PasswordField
                    label="Пароль"
                    id="custodian-unlock-password"
                    name="password"
                    passwordManager="allow"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    autoFocus
                    required
                  />
                  {store.session!.method === "passkey" &&
                    store.session!.credentialId && (
                      <div className="field">
                        <label className="check-label">
                          <Checkbox
                            checked={remember}
                            disabled={busy}
                            onCheckedChange={(value) =>
                              setRemember(value === true)
                            }
                          />
                          Доверять этому браузеру
                        </label>
                        <small>
                          После настройки для открытия записей хватит Passkey.
                          Ключ останется в этом профиле браузера. На общем
                          компьютере не включайте эту опцию.
                        </small>
                      </div>
                    )}
                  <Submit busy={busy}>
                    Разблокировать
                    <ArrowRight size={16} />
                  </Submit>
                </Form>
              )}
              {store.session!.credentials.length > 0 && (
                <Button
                  variant="outline"
                  className="full-width unlock-passkey"
                  disabled={busy}
                  onClick={passkey}
                >
                  <Fingerprint size={17} />
                  Разблокировать с Passkey
                </Button>
              )}
              {user.role === "owner" ? (
                <p className="text-button password-fallback">
                  Не помните пароль? Восстановите доступ с rescue-ключом через
                  CLI.
                </p>
              ) : (
                <button
                  type="button"
                  className="text-button password-fallback"
                  onClick={() => setReset(true)}
                >
                  Не помню пароль
                </button>
              )}
            </>
          )}
          <ErrorMessage error={error} />
          <Button
            variant="ghost"
            className="full-width logout-button"
            disabled={busy}
            onClick={() => store.logout().catch((e) => setError(e.message))}
          >
            <LogOut size={16} />
            Выйти из аккаунта
          </Button>
        </div>
        <p className="auth-foot">
          <ShieldCheck size={14} />
          Ключи хранятся только в памяти открытой страницы
        </p>
        <div className="mt-5">
          <RwpPromo side="top" />
        </div>
      </div>
    </main>
  );
}
export function Enrollment({ store }: { store: VaultStore }) {
  const [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [busy, setBusy] = useState(false),
    [showPassword, setShowPassword] = useState(false),
    [error, setError] = useState("");
  const session = store.session!;
  const decryptingKeys = session.credentials.filter((c) => c.prf);
  const mounted = useRef(true);
  const currentStore = useRef(store);
  currentStore.current = store;
  const enrollment = useRef<PasskeyEnrollmentOperation | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (enrollment.current) {
        enrollment.current = null;
        cancelPasskeyCeremony();
      }
    };
  }, []);
  function beginEnrollment() {
    if (enrollment.current) return null;
    const keys = store.keys.current;
    const { id, vaultId, epoch } = session.user;
    const operation: PasskeyEnrollmentOperation = {
      assertActive: () => {
        const current = currentStore.current;
        if (
          !mounted.current ||
          enrollment.current !== operation ||
          !keys ||
          current.keys.current !== keys ||
          !current.unlocked ||
          current.session?.user.id !== id ||
          current.session.user.vaultId !== vaultId ||
          current.session.user.epoch !== epoch ||
          current.session.user.status !== "active"
        )
          throw new Error("Настройка Passkey отменена.");
      },
      getPrivateKey: () => {
        operation.assertActive();
        return currentStore.current.keys.current!.privateKey;
      },
    };
    enrollment.current = operation;
    setBusy(true);
    setError("");
    return operation;
  }
  function finishEnrollment(operation: PasskeyEnrollmentOperation) {
    if (enrollment.current !== operation) return;
    enrollment.current = null;
    if (mounted.current) setBusy(false);
  }
  async function add() {
    const operation = beginEnrollment();
    if (!operation) return;
    try {
      const result = await registerPasskey(operation, session.user.id);
      operation.assertActive();
      await store.refreshSession();
      operation.assertActive();
      toast.success(
        result.prf
          ? "Passkey подключён для входа и открытия записей."
          : "Passkey подключён для входа. На этом устройстве для открытия записей нужен пароль.",
      );
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      finishEnrollment(operation);
    }
  }
  async function setupUnlock(id: string) {
    const operation = beginEnrollment();
    if (!operation) return;
    let prf: Uint8Array | null = null;
    try {
      operation.assertActive();
      const authenticated = await authenticatePasskey(
        id,
        operation.assertActive,
      );
      prf = authenticated.prf;
      operation.assertActive();
      if (!prf)
        throw new Error(
          "Этот Passkey не поддерживает открытие записей. Используйте пароль или другой Passkey.",
        );
      await enablePrfWrap(operation, session.user.id, authenticated.id, prf);
      operation.assertActive();
      await store.refreshSession();
      operation.assertActive();
      toast.success("Passkey настроен для входа и разблокировки хранилища.");
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      erase(prf);
      finishEnrollment(operation);
    }
  }
  async function remove(id: string) {
    setBusy(true);
    setError("");
    try {
      await api("/auth/passkey/" + id, "DELETE");
      await store.refreshSession();
      toast.success("Passkey отключён.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="enrollment">
      <h2>Способы входа</h2>
      <div className="enrollment-row">
        <span>
          <KeyRound size={17} />
          Пароль
        </span>
        <div className="auth-method-actions">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !store.unlocked}
            onClick={() => {
              setError("");
              setShowPassword(!showPassword);
            }}
          >
            {session.passwordEnabled ? "Изменить" : "Включить"}
          </Button>
          {session.passwordEnabled && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !decryptingKeys.length}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await api("/auth/password", "DELETE");
                  await store.refreshSession();
                  toast.success("Вход по паролю отключён.");
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Отключить
            </Button>
          )}
        </div>
      </div>
      {showPassword && (
        <Form
          id="custodian-change-password"
          autoComplete="on"
          className="form-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            if (password !== confirm) {
              setError("Пароли не совпадают.");
              return;
            }
            setBusy(true);
            try {
              await store.changePassword(password);
              setPassword("");
              setConfirm("");
              setShowPassword(false);
              toast.success("Пароль сохранён.");
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field
            label="Логин"
            id="custodian-change-username"
            name="username"
            value={session.user.username}
            readOnly
            autoComplete="username"
            passwordManager="allow"
          />
          <PasswordField
            label="Новый пароль"
            id="custodian-change-password-value"
            name="new-password"
            passwordManager="allow"
            hint="От 14 до 256 символов. Для входа и открытия записей."
            minLength={14}
            maxLength={256}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <PasswordField
            label="Повторите пароль"
            id="custodian-change-password-confirm"
            name="confirm-password"
            passwordManager="allow"
            minLength={14}
            maxLength={256}
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
          <Submit busy={busy}>Сохранить пароль</Submit>
        </Form>
      )}
      <div className="enrollment-row">
        <span>
          <Fingerprint size={18} />
          Passkey
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !store.unlocked}
          onClick={add}
        >
          {session.credentials.length ? "Добавить" : "Подключить"}
        </Button>
      </div>
      {session.credentials.map((credential, index) => (
        <div className="enrollment-row" key={credential.id}>
          <span>
            Passkey {index + 1}
            <small>
              {credential.prf
                ? "Вход и открытие записей"
                : "Вход; записи открываются доверенным браузером или паролем"}
            </small>
          </span>
          <div className="auth-method-actions">
            {!credential.prf && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !store.unlocked}
                onClick={() => setupUnlock(credential.id)}
              >
                Настроить разблокировку
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={
                busy ||
                (!session.passwordEnabled &&
                  credential.prf &&
                  decryptingKeys.length === 1)
              }
              onClick={() => remove(credential.id)}
            >
              Отключить
            </Button>
          </div>
        </div>
      ))}
      {!decryptingKeys.length && (
        <p>
          Для входа без повторного пароля можно запомнить этот браузер. Чтобы
          полностью отключить парольный вход, нужен Passkey с PRF.
        </p>
      )}
      <TrustedBrowsers store={store} />
      <ErrorMessage error={error} />
    </div>
  );
}
