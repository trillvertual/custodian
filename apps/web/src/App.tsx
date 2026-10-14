import { Checkbox } from "./components/ui/checkbox";
import { useEffect, useRef, useState, lazy, Suspense } from "react";
import {
  IconDatabase,
  IconStar,
  IconWorld,
  IconKey,
  IconTerminal2,
  IconFileText,
  IconUsers,
  IconHistory,
  IconSettings,
  IconTrash,
  IconFolder,
  IconPlus,
  IconRefresh,
  IconArrowsSort,
} from "@tabler/icons-react";
import { AppLayout, NavGroup, NavItem } from "./layout/AppLayout";
import { PageHeader } from "./components/page-header";
import { Card } from "./components/ui/card";
import { CardHeadRow } from "./components/card-head-row";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "./components/ui/table";
import {
  KeyRound,
  RefreshCw,
  Download,
  Check,
  Upload,
  FilePenLine,
  X,
} from "lucide-react";
import { Toaster, toast } from "sonner";
import { useVault, type VaultStore } from "./lib/store";
import { AuthScreen } from "./components/auth";
import { Brand } from "./components/brand";
import { RecordEditor } from "./components/record-editor";
import { RecordDetail } from "./components/record-detail";
import { Members } from "./components/members";
import { Settings as SettingsPage, Activity } from "./components/settings";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { RwpPromo } from "./components/rwp-promo";
import { similarRecord } from "./lib/record-presets";
import { useRecentRecords } from "./lib/recent-records";
import { SearchPalette } from "./components/search-palette";
import { recoveryDownload } from "./lib/api";
import type {
  DraftBody,
  VaultRecord,
} from "../../../packages/core/src/index.ts";
const RecordImport = lazy(() =>
  import("./components/record-import").then((module) => ({
    default: module.RecordImport,
  })),
);
const RecordBulk = lazy(() =>
  import("./components/record-bulk").then((module) => ({
    default: module.RecordBulk,
  })),
);
const Drafts = lazy(() =>
  import("./components/drafts").then((module) => ({ default: module.Drafts })),
);
const icons = {
  login: IconWorld,
  token: IconKey,
  ssh: IconTerminal2,
  note: IconFileText,
};
const labels = {
  all: "Все записи",
  favorite: "Избранное",
  login: "Логины и пароли",
  token: "API-токены",
  ssh: "SSH-ключи",
  note: "Заметки",
  trash: "Корзина",
};
type Filter = keyof typeof labels;
export default function App() {
  const store = useVault();
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("vault-theme") === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem("vault-theme", theme);
    } catch {
      // The selected theme still works when browser storage is unavailable.
    }
  }, [theme]);
  return (
    <>
      <Toaster
        theme={theme === "dark" ? "dark" : "light"}
        position="bottom-right"
        richColors
        closeButton
      />
      {store.loading ? (
        <div className="loading-screen" role="status">
          <Brand />
          <RefreshCw className="spin" />
          <span>Подключаем хранилище…</span>
        </div>
      ) : store.recovery ? (
        <RecoveryGate store={store} />
      ) : store.unlocked && store.session ? (
        <VaultShell store={store} theme={theme} setTheme={setTheme} />
      ) : store.error && !store.config ? (
        <main className="auth-page">
          <div className="auth-container">
            <Brand />
            <div className="auth-card">
              <h1>Не удалось подключиться</h1>
              <p role="alert">{store.error}</p>
              <Button onClick={() => location.reload()}>Повторить</Button>
            </div>
          </div>
        </main>
      ) : (
        <AuthScreen store={store} />
      )}
    </>
  );
}
function RecoveryGate({ store }: { store: VaultStore }) {
  const [saved, setSaved] = useState(false),
    [downloaded, setDownloaded] = useState(false);
  const recovery = store.recovery!;
  return (
    <main className="auth-page">
      <div className="auth-container">
        <Brand />
        <div className="auth-card">
          <div className="auth-symbol">
            <KeyRound size={24} />
          </div>
          <h1>Сохраните rescue-ключ</h1>
          <p>
            Он понадобится, если команда потеряет доступ к хранилищу. Храните
            файл отдельно от сервера.
          </p>
          <Button
            className="full-width"
            onClick={() => {
              recoveryDownload(recovery.code, recovery.name, recovery.epoch);
              setDownloaded(true);
            }}
          >
            <Download size={17} />
            Скачать rescue-ключ
          </Button>
          <label className="check-label">
            <Checkbox
              checked={saved}
              disabled={!downloaded}
              onCheckedChange={(checked) => setSaved(checked === true)}
            />
            Я сохранил файл в надёжном месте
          </label>
          <Button
            variant="outline"
            className="full-width"
            disabled={!saved || !downloaded}
            onClick={() => store.setRecovery(null)}
          >
            <Check size={17} />
            Продолжить
          </Button>
        </div>
        <div className="mt-5">
          <RwpPromo side="top" />
        </div>
      </div>
    </main>
  );
}
function VaultShell({
  store,
  theme,
  setTheme,
}: {
  store: VaultStore;
  theme: string;
  setTheme: (value: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all"),
    [folder, setFolder] = useState(""),
    [page, setPage] = useState("vault"),
    [search, setSearch] = useState(""),
    [searchOpen, setSearchOpen] = useState(false),
    [selected, setSelected] = useState<string | null>(null),
    [editing, setEditing] = useState<{
      key: string;
      recordId?: string;
      initialData?: VaultRecord;
      draftData?: DraftBody;
      draftId?: string;
    } | null>(null),
    [detailOpen, setDetailOpen] = useState(false),
    [editorOpen, setEditorOpen] = useState(false),
    [sort, setSort] = useState<"updated" | "title">("updated"),
    [refreshing, setRefreshing] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [importMounted, setImportMounted] = useState(false),
    [importOpen, setImportOpen] = useState(false);
  const [draftMounted, setDraftMounted] = useState(false),
    [draftOpen, setDraftOpen] = useState(false);
  const [bulkIds, setBulkIds] = useState<string[] | null>(null),
    [bulkOpen, setBulkOpen] = useState(false);
  useEffect(() => {
    setSelection(new Set());
  }, [filter, folder, page, search]);
  const searchRef = useRef<HTMLInputElement>(null);
  const user = store.session!.user;
  const recent = useRecentRecords(user.vaultId, user.id);
  function openRecord(id: string) {
    if (!store.keys.current) return;
    recent.remember(id);
    setSelected(id);
    setDetailOpen(true);
  }
  function createRecord(initialData?: VaultRecord) {
    setDetailOpen(false);
    setEditing({ key: crypto.randomUUID(), initialData });
    setEditorOpen(true);
  }
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (editing || importMounted || draftMounted || bulkIds) return;
        setDetailOpen(false);
        setSearchOpen((open) => !open);
      }
      if (
        e.key === "Escape" &&
        !e.defaultPrevented &&
        !(e.target instanceof Element && e.target.closest('[role="dialog"]'))
      ) {
        if (!editing) setDetailOpen(false);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [editing, importMounted, draftMounted, bulkIds]);
  const live = store.records.filter((r) => !r.deletedAt),
    folders = Array.from(
      new Set(live.map((r) => r.data.folder).filter(Boolean)),
    ).sort();
  const counts: Record<Filter, number> = {
    all: live.length,
    favorite: live.filter((r) => r.data.favorite).length,
    login: live.filter((r) => r.data.type === "login").length,
    token: live.filter((r) => r.data.type === "token").length,
    ssh: live.filter((r) => r.data.type === "ssh").length,
    note: live.filter((r) => r.data.type === "note").length,
    trash: store.records.filter((r) => r.deletedAt).length,
  };
  const rows = store.records
    .filter(
      (r) =>
        (filter === "trash" ? !!r.deletedAt : !r.deletedAt) &&
        (filter === "all" ||
          filter === "trash" ||
          (filter === "favorite" && r.data.favorite) ||
          r.data.type === filter) &&
        (!folder || r.data.folder === folder),
    )
    .filter(
      (r) =>
        !search ||
        [
          r.data.title,
          r.data.url,
          r.data.username,
          r.data.folder,
          ...r.data.tags,
        ].some((v) => v.toLowerCase().includes(search.toLowerCase())),
    )
    .sort((a, b) =>
      sort === "title"
        ? a.data.title.localeCompare(b.data.title, "ru")
        : b.updatedAt.localeCompare(a.updatedAt),
    );
  const record = store.records.find((r) => r.id === selected),
    editRecord = editing?.recordId
      ? store.records.find((r) => r.id === editing?.recordId)
      : undefined;
  const noMethods =
    !store.session!.credentials.length &&
    !store.session!.identities.length &&
    !store.session!.passwordEnabled;
  function selectFilter(value: Filter) {
    setPage("vault");
    setFilter(value);
    setFolder("");
    setDetailOpen(false);
    setSearch("");
  }
  const pageTitle =
    page === "vault"
      ? folder || labels[filter]
      : page === "members"
        ? "Команда"
        : page === "activity"
          ? "Журнал действий"
          : "Настройки";
  return (
    <AppLayout
      vaultName={user.vaultName}
      displayName={user.displayName}
      role={user.role}
      theme={theme}
      onTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
      onLock={store.lock}
      onLogout={() => store.logout().catch((e) => toast.error(e.message))}
      logoutDisabled={noMethods}
      onOpenSearch={() => {
        setDetailOpen(false);
        setSearchOpen(true);
      }}
      navigation={(close) => (
        <>
          <NavGroup title="Хранилище">
            {(["all", "favorite"] as Filter[]).map((f) => (
              <NavItem
                key={f}
                active={page === "vault" && filter === f && !folder}
                icon={
                  f === "all" ? (
                    <IconDatabase stroke={1.5} />
                  ) : (
                    <IconStar stroke={1.5} />
                  )
                }
                label={labels[f]}
                count={counts[f]}
                onClick={() => {
                  selectFilter(f);
                  close();
                }}
              />
            ))}
          </NavGroup>
          <NavGroup title="Записи">
            {(["login", "token", "ssh", "note"] as const).map((f) => {
              const Icon = icons[f];
              return (
                <NavItem
                  key={f}
                  active={page === "vault" && filter === f && !folder}
                  icon={<Icon stroke={1.5} />}
                  label={labels[f]}
                  count={counts[f]}
                  onClick={() => {
                    selectFilter(f);
                    close();
                  }}
                />
              );
            })}
          </NavGroup>
          {folders.length > 0 && (
            <NavGroup title="Папки">
              {folders.map((value) => (
                <NavItem
                  key={value}
                  active={page === "vault" && folder === value}
                  icon={<IconFolder stroke={1.5} />}
                  label={value}
                  ariaLabel={`Папка ${value}`}
                  onClick={() => {
                    setPage("vault");
                    setFilter("all");
                    setFolder(value);
                    setDetailOpen(false);
                    setSearch("");
                    close();
                  }}
                />
              ))}
            </NavGroup>
          )}
          <NavGroup title="Управление">
            {(
              [
                { value: "members", label: "Команда", icon: IconUsers },
                {
                  value: "activity",
                  label: "Журнал действий",
                  icon: IconHistory,
                },
                { value: "settings", label: "Настройки", icon: IconSettings },
              ] as const
            ).map((item) => (
              <NavItem
                key={item.value}
                active={page === item.value}
                icon={<item.icon stroke={1.5} />}
                label={item.label}
                onClick={() => {
                  setPage(item.value);
                  setDetailOpen(false);
                  close();
                }}
              />
            ))}
            <NavItem
              active={page === "vault" && filter === "trash"}
              icon={<IconTrash stroke={1.5} />}
              label="Корзина"
              count={counts.trash}
              onClick={() => {
                selectFilter("trash");
                close();
              }}
            />
          </NavGroup>
        </>
      )}
    >
      {noMethods && (
        <div className="setup-notice">
          <span>
            Подключите способ входа, чтобы вернуться в аккаунт после выхода.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPage("settings")}
          >
            Настроить вход
          </Button>
        </div>
      )}
      <div className="page-view" key={page}>
        {page === "members" ? (
          <Members store={store} />
        ) : page === "activity" ? (
          <Activity />
        ) : page === "settings" ? (
          <SettingsPage store={store} />
        ) : (
          <>
            <PageHeader
              title={pageTitle}
              actions={
                <>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="desktop-action"
                    aria-label="Обновить записи"
                    disabled={refreshing}
                    onClick={async () => {
                      setRefreshing(true);
                      try {
                        await store.loadRecords();
                      } catch (e) {
                        toast.error((e as Error).message);
                      } finally {
                        setRefreshing(false);
                      }
                    }}
                  >
                    <IconRefresh
                      stroke={1.5}
                      className={refreshing ? "spin" : ""}
                    />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="desktop-action"
                    aria-label={
                      sort === "updated"
                        ? "Сортировать по названию"
                        : "Сортировать по изменению"
                    }
                    title={
                      sort === "updated"
                        ? "Сортировать по названию"
                        : "Сортировать по изменению"
                    }
                    onClick={() =>
                      setSort(sort === "updated" ? "title" : "updated")
                    }
                  >
                    <IconArrowsSort stroke={1.5} />
                  </Button>
                  {filter !== "trash" && (
                    <Button
                      size="sm"
                      aria-label="Добавить запись"
                      onClick={() => {
                        createRecord();
                      }}
                    >
                      <IconPlus stroke={1.5} />
                      <span className="add-label">Добавить</span>
                    </Button>
                  )}
                </>
              }
            />
            {filter !== "trash" && (
              <div className="vault-tools">
                <div className="vault-tools-group">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      !!editing || importMounted || draftMounted || !!bulkIds
                    }
                    onClick={() => {
                      setDetailOpen(false);
                      setImportMounted(true);
                      setImportOpen(true);
                    }}
                  >
                    <Upload size={15} />
                    Импорт
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      !!editing || importMounted || draftMounted || !!bulkIds
                    }
                    onClick={() => {
                      setDetailOpen(false);
                      setDraftMounted(true);
                      setDraftOpen(true);
                    }}
                  >
                    <FilePenLine size={15} />
                    Черновики
                  </Button>
                </div>
                <div className="vault-tools-group">
                  <span className="muted">
                    Выбрано:{" "}
                    {rows.filter((record) => selection.has(record.id)).length}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!rows.some((record) => selection.has(record.id))}
                    onClick={() => {
                      setDetailOpen(false);
                      setBulkIds(
                        rows
                          .filter((record) => selection.has(record.id))
                          .map((record) => record.id),
                      );
                      setBulkOpen(true);
                    }}
                  >
                    Изменить выбранные
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Снять выбор записей"
                    disabled={!selection.size}
                    onClick={() => setSelection(new Set())}
                  >
                    <X size={16} />
                  </Button>
                </div>
              </div>
            )}
            <Card className="records-card gap-0 overflow-hidden py-0">
              <CardHeadRow title={pageTitle} count={rows.length}>
                <Input
                  ref={searchRef}
                  className="record-search h-8 w-52 text-[13px]"
                  aria-label="Поиск записей"
                  placeholder="Фильтр записей…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </CardHeadRow>
              <Table className="records-table">
                <TableHeader>
                  <TableRow>
                    {filter !== "trash" && (
                      <TableHead className="selection-column">
                        <Checkbox
                          aria-label="Выбрать все показанные записи"
                          disabled={!rows.length}
                          checked={
                            rows.length > 0 &&
                            rows.every((record) => selection.has(record.id))
                              ? true
                              : rows.some((record) => selection.has(record.id))
                                ? "indeterminate"
                                : false
                          }
                          onCheckedChange={(checked) =>
                            setSelection(
                              checked === true
                                ? new Set(rows.map((record) => record.id))
                                : new Set(),
                            )
                          }
                        />
                      </TableHead>
                    )}
                    <TableHead
                      className="pl-6"
                      aria-sort={sort === "title" ? "ascending" : "none"}
                    >
                      <button
                        className="flex items-center gap-2"
                        onClick={() => setSort("title")}
                      >
                        Название
                        <IconArrowsSort aria-hidden size={13} stroke={1.5} />
                      </button>
                    </TableHead>
                    <TableHead className="type-column">Тип</TableHead>
                    <TableHead className="login-column">
                      Логин / адрес
                    </TableHead>
                    <TableHead className="tags-column">Теги</TableHead>
                    <TableHead
                      className="updated-column pr-6 text-right"
                      aria-sort={sort === "updated" ? "descending" : "none"}
                    >
                      Изменено
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow
                      key={r.id}
                      className="cursor-pointer"
                      onClick={() => {
                        openRecord(r.id);
                      }}
                    >
                      {filter !== "trash" && (
                        <TableCell
                          className="selection-column"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <Checkbox
                            aria-label={`Выбрать ${r.data.title}`}
                            checked={selection.has(r.id)}
                            onCheckedChange={(checked) =>
                              setSelection((previous) => {
                                const next = new Set(previous);
                                if (checked === true) next.add(r.id);
                                else next.delete(r.id);
                                return next;
                              })
                            }
                          />
                        </TableCell>
                      )}
                      <TableCell className="pl-6">
                        <div className="record-name">
                          <button
                            className="record-title"
                            aria-label={`Открыть ${r.data.title}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              openRecord(r.id);
                            }}
                          >
                            {r.data.title}
                          </button>
                          {r.data.favorite && (
                            <IconStar
                              aria-label="Избранное"
                              stroke={1.5}
                              size={13}
                              className="text-ink-2"
                            />
                          )}
                        </div>
                        {r.data.folder && (
                          <span className="record-folder text-[13px] text-ink-2">
                            {r.data.folder}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="type-column text-[13px] text-ink-2">
                        {
                          (
                            {
                              login: "Логин и пароль",
                              token: "API-токен",
                              ssh: "SSH-ключ",
                              note: "Заметка",
                            } as Record<VaultRecord["type"], string>
                          )[r.data.type]
                        }
                      </TableCell>
                      <TableCell className="login-column">
                        <span className="cell-login">
                          {r.data.username ||
                            r.data.url.replace(/^https?:\/\//, "") ||
                            "-"}
                        </span>
                      </TableCell>
                      <TableCell className="tags-column">
                        <div className="tag-list">
                          {r.data.tags.slice(0, 2).map((t) => (
                            <span className="tag" key={t}>
                              {t}
                            </span>
                          ))}
                          {r.data.totp && <span className="tag">2FA</span>}
                        </div>
                      </TableCell>
                      <TableCell className="updated-column pr-6 text-right text-[13px] text-ink-2">
                        {new Intl.DateTimeFormat("ru", {
                          day: "numeric",
                          month: "short",
                        }).format(new Date(r.updatedAt))}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {rows.length === 0 && (
                <div className="empty-state">
                  <h2>
                    {search
                      ? "Ничего не найдено"
                      : filter === "trash"
                        ? "Корзина пуста"
                        : filter === "favorite"
                          ? "Нет избранных записей"
                          : "Нет записей"}
                  </h2>
                  <p>
                    {search
                      ? "Попробуйте другой запрос."
                      : filter === "favorite"
                        ? "Отметьте нужные записи звёздочкой."
                        : filter === "trash"
                          ? "Удалённые записи появятся здесь."
                          : "Добавьте логин, API-токен, SSH-ключ или заметку."}
                  </p>
                  {search && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSearch("")}
                    >
                      Очистить поиск
                    </Button>
                  )}
                </div>
              )}
            </Card>
            <div className="records-footer text-[13px] text-ink-2">
              {rows.length} из {filter === "trash" ? counts.trash : live.length}{" "}
              записей
            </div>
            {record && (
              <RecordDetail
                key={record.id}
                open={detailOpen}
                onExitComplete={() =>
                  setSelected((current) =>
                    current === record.id ? null : current,
                  )
                }
                record={record}
                store={store}
                onClose={() => setDetailOpen(false)}
                onSimilar={() => createRecord(similarRecord(record.data))}
                onEdit={() => {
                  setEditing({ key: crypto.randomUUID(), recordId: record.id });
                  setEditorOpen(true);
                }}
              />
            )}
          </>
        )}
      </div>
      <SearchPalette
        open={searchOpen}
        onOpenChange={setSearchOpen}
        records={live}
        store={store}
        recentIds={recent.ids}
        onRemember={recent.remember}
        onSelect={(id) => {
          setPage("vault");
          setFilter("all");
          setFolder("");
          setSearch("");
          openRecord(id);
        }}
      />
      <Suspense
        fallback={
          <p role="status" className="muted">
            Загрузка инструмента…
          </p>
        }
      >
        {importMounted && (
          <RecordImport
            store={store}
            open={importOpen}
            onClose={() => setImportOpen(false)}
            onExitComplete={() => setImportMounted(false)}
          />
        )}
        {bulkIds && (
          <RecordBulk
            key={bulkIds.join(":")}
            store={store}
            ids={bulkIds}
            open={bulkOpen}
            onClose={() => setBulkOpen(false)}
            onDone={() => {
              setBulkOpen(false);
              setSelection(new Set());
            }}
            onExitComplete={() => setBulkIds(null)}
          />
        )}
        {draftMounted && (
          <Drafts
            store={store}
            open={draftOpen}
            onClose={() => setDraftOpen(false)}
            onExitComplete={() => setDraftMounted(false)}
            onOpenRecord={(id) => {
              setDraftOpen(false);
              setPage("vault");
              setFilter("all");
              setFolder("");
              setSearch("");
              openRecord(id);
            }}
            onRestore={(body, id) => {
              setDraftOpen(false);
              setEditing({
                key: crypto.randomUUID(),
                recordId: body.recordId ?? undefined,
                draftData: body,
                draftId: id,
              });
              setEditorOpen(true);
            }}
          />
        )}
      </Suspense>
      {editing && (
        <RecordEditor
          key={editing.key}
          store={store}
          record={editRecord}
          initialData={editing.initialData}
          draftData={editing.draftData}
          draftId={editing.draftId}
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
          onExitComplete={() =>
            setEditing((current) => (current === editing ? null : current))
          }
          onSaved={(id) => {
            setEditorOpen(false);
            openRecord(id);
            toast.success("Запись сохранена.");
          }}
        />
      )}
    </AppLayout>
  );
}
