import { useCallback, useEffect, useRef, useState } from "react";
import {
  batchSchema,
  batchResultSchema,
  batchLimit,
  batchByteLimit,
  type RecordBatch,
  type BatchResult,
  ready,
  deriveLoginSecret,
  wrapPassword,
  erase,
  unlockPassword,
  openVaultKey,
  decryptJson,
  recordSchema,
  recordContext,
  unlockPasskey,
  encryptJson,
  type DecryptedRecord,
  type SessionUser,
  type StoredRecord,
  type VaultRecord,
} from "../../../../packages/core/src/index.ts";
import { api, setCsrf, ApiError } from "./api.ts";
import { rememberBrowser, openTrustedBrowser } from "./trusted-browser";
export type Session = {
  user: SessionUser;
  csrf: string;
  method: string;
  passwordEnabled: boolean;
  identities: string[];
  credentials: { id: string; prf: boolean }[];
  credentialId?: string | null;
};
export type AuthConfig = {
  initialized: boolean;
  providers: { github: boolean; telegram: boolean };
  rpId: string;
};
export function useVault() {
  const [config, setConfig] = useState<AuthConfig | null>(null),
    [session, setSession] = useState<Session | null>(null),
    [records, setRecords] = useState<DecryptedRecord[]>([]),
    [unlocked, setUnlocked] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [unlockHint, setUnlockHint] = useState("");
  const keys = useRef<{ privateKey: Uint8Array; vaultKey: Uint8Array } | null>(
    null,
  );
  const recordsRequest = useRef(0);
  const sessionRequest = useRef(0);
  const authGeneration = useRef(0);
  const [recovery, setRecovery] = useState<{
    code: string;
    name: string;
    epoch: number;
  } | null>(null);
  const lock = useCallback(() => {
    authGeneration.current += 1;
    sessionRequest.current += 1;
    recordsRequest.current += 1;
    erase(keys.current?.privateKey);
    erase(keys.current?.vaultKey);
    keys.current = null;
    setRecords([]);
    setUnlocked(false);
    setUnlockHint("");
  }, []);
  const refreshSession = useCallback(
    async (publish = true) => {
      const generation = authGeneration.current;
      const request = ++sessionRequest.current;
      try {
        const value = await api<Session>("/auth/session");
        if (generation !== authGeneration.current) return null;
        if (request === sessionRequest.current) {
          setCsrf(value.csrf);
          if (publish) setSession(value);
        }
        return value;
      } catch (e) {
        if (generation !== authGeneration.current) return null;
        if (e instanceof ApiError && e.status === 401) {
          if (request !== sessionRequest.current) return null;
          setSession(null);
          setCsrf("");
          lock();
          return null;
        }
        throw e;
      }
    },
    [lock],
  );
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await ready;
        const value = await api<AuthConfig>("/auth/config");
        if (!mounted) return;
        setConfig(value);
        if (value.initialized) await refreshSession();
        const params = new URLSearchParams(location.search);
        if (params.get("auth") === "error")
          setError(params.get("message") ?? "Не удалось войти.");
        if (params.has("auth"))
          history.replaceState(null, "", location.pathname);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Не удалось подключиться.");
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
      authGeneration.current += 1;
      sessionRequest.current += 1;
      recordsRequest.current += 1;
      erase(keys.current?.privateKey);
      erase(keys.current?.vaultKey);
      keys.current = null;
    };
  }, [refreshSession]);
  const loadRecords = useCallback(
    async (current: Session = session!) => {
      const currentKeys = keys.current;
      if (!currentKeys) return;
      const request = ++recordsRequest.current;
      const stored = await api<StoredRecord[]>("/records");
      if (keys.current !== currentKeys || request !== recordsRequest.current)
        return;
      if (stored.some((r) => r.epoch !== current.user.epoch)) {
        lock();
        throw new Error("Ключ хранилища изменился. Разблокируйте его заново.");
      }
      const result = stored.map((r) => ({
        ...r,
        data: recordSchema.parse(
          decryptJson(
            r.box,
            currentKeys.vaultKey,
            recordContext(current.user.vaultId, r.id, r.version, r.epoch),
          ),
        ),
      }));
      setRecords(result);
    },
    [session, lock],
  );
  const unlockWithPrivate = useCallback(
    async (
      privateKey: Uint8Array,
      current: Session,
      generation = ++authGeneration.current,
    ) => {
      if (generation !== authGeneration.current) {
        erase(privateKey);
        throw new Error("Открытие хранилища отменено.");
      }
      if (!current.user.sealedKey) {
        erase(privateKey);
        throw new Error("Владелец ещё не выдал ключ хранилища.");
      }
      let vaultKey: Uint8Array | undefined;
      let currentKeys: typeof keys.current = null;
      try {
        vaultKey = openVaultKey(
          current.user.sealedKey,
          privateKey,
          current.user.vaultId,
          current.user.epoch,
        );
        currentKeys = { privateKey, vaultKey };
        erase(keys.current?.privateKey);
        erase(keys.current?.vaultKey);
        keys.current = currentKeys;
        await loadRecords(current);
        if (
          generation !== authGeneration.current ||
          keys.current !== currentKeys
        )
          throw new Error("Открытие хранилища отменено.");
        setUnlocked(true);
      } catch (e) {
        erase(privateKey);
        erase(vaultKey);
        if (keys.current === currentKeys) {
          keys.current = null;
          setRecords([]);
          setUnlocked(false);
        }
        throw e;
      }
    },
    [loadRecords],
  );
  function assertGeneration(generation: number) {
    if (generation !== authGeneration.current)
      throw new Error("Открытие хранилища отменено.");
  }
  async function unlock(password: string, remember = false) {
    const generation = ++authGeneration.current;
    const current = await refreshSession();
    assertGeneration(generation);
    if (!current) throw new Error("Сессия истекла. Войдите заново.");
    let privateKey: Uint8Array | null = unlockPassword(
      current.user.identity,
      password,
      current.user.id,
    );
    try {
      if (remember)
        await rememberBrowser(current, {
          assertActive: () => assertGeneration(generation),
          getPrivateKey: () => {
            assertGeneration(generation);
            return privateKey!;
          },
        });
      assertGeneration(generation);
      const owned = privateKey;
      privateKey = null;
      await unlockWithPrivate(owned, current, generation);
      setUnlockHint("");
    } finally {
      erase(privateKey);
    }
  }
  async function passkeyUnlock(id: string, prf: Uint8Array | null) {
    const generation = ++authGeneration.current;
    try {
      const current = await refreshSession(false);
      assertGeneration(generation);
      if (!current) return false;
      let privateKey: Uint8Array | null = null;
      if (prf && current.user.passkeyWraps[id]) {
        privateKey = unlockPasskey(
          current.user.passkeyWraps[id]!,
          prf,
          current.user.id,
          id,
        );
      } else {
        try {
          privateKey = await openTrustedBrowser(current, id, () =>
            assertGeneration(generation),
          );
        } catch (error) {
          assertGeneration(generation);
          if (error instanceof ApiError && error.status === 401) throw error;
          setSession(current);
          setUnlockHint(
            error instanceof ApiError
              ? error.message
              : "Ключ браузера недоступен. Введите пароль и запомните браузер заново.",
          );
          return false;
        }
      }
      try {
        assertGeneration(generation);
        if (!privateKey) {
          setUnlockHint(
            current.passwordEnabled
              ? "Passkey принят. Чтобы открывать записи без пароля в этом браузере, один раз введите пароль и включите доверие браузеру."
              : "Passkey принят, но ключа для открытия записей в этом браузере нет. Используйте Passkey с PRF или восстановление доступа.",
          );
          setSession(current);
          return false;
        }
        const owned = privateKey;
        privateKey = null;
        await unlockWithPrivate(owned, current, generation);
      } finally {
        erase(privateKey);
      }
      setUnlockHint("");
      setSession(current);
      return true;
    } finally {
      erase(prf);
    }
  }
  async function login(username: string, password: string) {
    if (!config) throw new Error("Настройки входа ещё загружаются.");
    const generation = ++authGeneration.current;
    const result = await api<{ csrf: string }>("/auth/password", "POST", {
      username,
      loginSecret: deriveLoginSecret(password, username, config.rpId),
    });
    assertGeneration(generation);
    setCsrf(result.csrf);
    const current = await refreshSession(false);
    assertGeneration(generation);
    if (!current) throw new Error("Не удалось открыть сессию.");
    if (current.user.status === "active") {
      await unlockWithPrivate(
        unlockPassword(current.user.identity, password, current.user.id),
        current,
        generation,
      );
    }
    setSession(current);
  }
  async function changePassword(password: string) {
    const current = await refreshSession();
    if (!current || !keys.current || !config)
      throw new Error("Сначала откройте хранилище.");
    await api("/auth/password/set", "POST", {
      loginSecret: deriveLoginSecret(
        password,
        current.user.username,
        config.rpId,
      ),
      identity: {
        publicKey: current.user.publicKey,
        master: wrapPassword(
          keys.current.privateKey,
          password,
          current.user.id,
        ),
      },
      baseIdentity: current.user.identity,
    });
    await refreshSession();
  }
  async function logout() {
    await api("/auth/logout", "POST");
    lock();
    setSession(null);
    setCsrf("");
  }
  async function save(
    data: VaultRecord,
    record?: DecryptedRecord,
    deleted = false,
  ) {
    if (!session || !keys.current) throw new Error("Хранилище заблокировано.");
    const id = record?.id ?? crypto.randomUUID(),
      version = (record?.version ?? 0) + 1;
    const box = encryptJson(
      recordSchema.parse(data),
      keys.current.vaultKey,
      recordContext(session.user.vaultId, id, version, session.user.epoch),
    );
    await api(`/records/${id}`, "PUT", {
      baseVersion: version - 1,
      epoch: session.user.epoch,
      box,
      deleted,
    });
    await loadRecords();
    return id;
  }
  function prepareBatch(
    changes: {
      data: VaultRecord;
      record?: DecryptedRecord;
      deleted?: boolean;
    }[],
  ) {
    const currentKeys = keys.current;
    if (!session || !currentKeys) throw new Error("Хранилище заблокировано.");
    if (!changes.length || changes.length > batchLimit)
      throw new Error(`Выберите от 1 до ${batchLimit} записей.`);
    let estimatedBytes = 0;
    const body: RecordBatch = batchSchema.parse({
      id: crypto.randomUUID(),
      epoch: session.user.epoch,
      records: changes.map(({ data, record, deleted = false }) => {
        const id = record?.id ?? crypto.randomUUID(),
          baseVersion = record?.version ?? 0;
        const parsed = recordSchema.parse(data);
        estimatedBytes +=
          Math.ceil(
            (new TextEncoder().encode(JSON.stringify(parsed)).length + 16) / 3,
          ) *
            4 +
          200;
        if (estimatedBytes > batchByteLimit)
          throw new Error(
            "Операция превышает 8 МБ. Уменьшите количество записей.",
          );
        return {
          id,
          baseVersion,
          deleted,
          box: encryptJson(
            parsed,
            currentKeys.vaultKey,
            recordContext(
              session.user.vaultId,
              id,
              baseVersion + 1,
              session.user.epoch,
            ),
          ),
        };
      }),
    });
    if (new TextEncoder().encode(JSON.stringify(body)).length > batchByteLimit)
      throw new Error("Операция превышает 8 МБ. Уменьшите количество записей.");
    return { body, keys: currentKeys };
  }
  async function executeBatch(operation: ReturnType<typeof prepareBatch>) {
    if (
      !session ||
      keys.current !== operation.keys ||
      session.user.epoch !== operation.body.epoch
    )
      throw new Error("Хранилище изменилось. Откройте операцию заново.");
    const raw = await api<unknown>("/records/batch", "POST", operation.body);
    const parsed = batchResultSchema.safeParse(raw);
    if (!parsed.success)
      throw new Error(
        "Не удалось проверить результат. Повторите отправку того же запроса.",
      );
    const result = parsed.data;
    if (keys.current !== operation.keys) return null;
    if (
      result.id !== operation.body.id ||
      result.records.length !== operation.body.records.length ||
      result.records.some(
        (record) =>
          !operation.body.records.some(
            (item) =>
              item.id === record.id && item.baseVersion + 1 === record.version,
          ),
      ) ||
      new Set(result.records.map((record) => record.id)).size !==
        result.records.length
    )
      throw new Error(
        "Не удалось проверить результат. Повторите отправку того же запроса.",
      );
    await loadRecords();
    return keys.current === operation.keys ? result : null;
  }
  useEffect(() => {
    // Erase memory on document departure, including entry into the back/forward cache.
    const unload = () => lock();
    window.addEventListener("pagehide", unload);
    return () => window.removeEventListener("pagehide", unload);
  }, [lock]);
  // Poll for membership/key changes; pending users can get approved without signing in again.
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(async () => {
      try {
        const current = await refreshSession();
        if (current && current.user.epoch !== session.user.epoch) lock();
      } catch {}
    }, 30000);
    return () => clearInterval(timer);
  }, [session?.user.id, session?.user.epoch, refreshSession, lock]);
  return {
    config,
    session,
    records,
    unlocked,
    loading,
    error,
    setError,
    unlockHint,
    setConfig,
    refreshSession,
    unlock,
    unlockWithPrivate,
    passkeyUnlock,
    login,
    changePassword,
    logout,
    save,
    prepareBatch,
    executeBatch,
    loadRecords,
    lock,
    keys,
    recovery,
    setRecovery,
  };
}
export type VaultStore = ReturnType<typeof useVault>;
