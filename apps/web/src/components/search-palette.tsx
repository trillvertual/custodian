// Search flow adapted from infra-billing's CommandPalette.tsx.
import { useState, useEffect, useMemo, useRef } from "react";
import { Check } from "lucide-react";
import { toast } from "sonner";
import {
  totp,
  type DecryptedRecord,
} from "../../../../packages/core/src/index.ts";
import { api, copyToClipboard } from "../lib/api";
import type { VaultStore } from "../lib/store";
import { Button } from "./ui/button";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "./ui/command";

type CopyField = "username" | "secret" | "totp";
export function SearchPalette({
  open,
  onOpenChange,
  records,
  onSelect,
  store,
  recentIds,
  onRemember,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  records: DecryptedRecord[];
  onSelect: (id: string) => void;
  store: VaultStore;
  recentIds: string[];
  onRemember: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState<CopyField | null>(null);
  const mounted = useRef(false);
  const operation = useRef<object | null>(null);
  const rows = records.filter(
    (record) =>
      !record.deletedAt &&
      [
        record.data.title,
        record.data.username,
        record.data.url,
        record.data.folder,
        ...record.data.tags,
      ].some((value) =>
        value
          .toLocaleLowerCase("ru")
          .includes(query.trim().toLocaleLowerCase("ru")),
      ),
  );
  const recent = query.trim()
    ? []
    : recentIds.flatMap((id) => rows.find((r) => r.id === id) ?? []);
  const others = rows.filter((r) => !recent.some((item) => item.id === r.id));
  const ordered = [...recent, ...others];
  const selected = ordered.find((r) => r.id === selectedId);
  const view = useMemo(
    () => ({ open, query, selected, keys: store.keys.current }),
    [open, query, selected?.id, selected?.version, store.keys.current],
  );
  const currentView = useRef(view);
  currentView.current = view;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open) {
      setQuery("");
      setSelectedId("");
      operation.current = null;
      setPending(false);
    }
  }, [open]);
  const firstId = ordered[0]?.id ?? "";
  useEffect(() => {
    if (!selected) setSelectedId(firstId);
  }, [selected, firstId]);
  useEffect(() => {
    setCopied(null);
  }, [view]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  function isCurrent(snapshot: typeof view) {
    return (
      mounted.current &&
      snapshot.open &&
      currentView.current === snapshot &&
      snapshot.keys !== null &&
      store.keys.current === snapshot.keys
    );
  }
  function openRecord(id: string) {
    if (!store.keys.current) return;
    onRemember(id);
    onOpenChange(false);
    onSelect(id);
  }
  async function copy(field: CopyField) {
    const snapshot = view;
    const record = snapshot.selected;
    if (!record || !isCurrent(snapshot) || operation.current) return;
    if (field === "totp" ? !record.data.totp : !record.data[field]) return;
    const token = {};
    operation.current = token;
    setPending(true);
    try {
      if (field !== "username")
        await api(`/records/${record.id}/event`, "POST", { action: "copied" });
      if (!isCurrent(snapshot)) return;
      const value =
        field === "totp"
          ? totp(record.data.totp!, Date.now()).code
          : record.data[field];
      await copyToClipboard(value);
      if (!isCurrent(snapshot)) return;
      onRemember(record.id);
      setCopied(field);
      toast.success("Скопировано.", { id: "search-copy" });
    } catch {
      if (isCurrent(snapshot))
        toast.error(
          "Не удалось скопировать. Проверьте доступ и попробуйте снова.",
          { id: "search-copy" },
        );
    } finally {
      if (operation.current === token) {
        operation.current = null;
        if (mounted.current) setPending(false);
      }
    }
  }
  const groups = recent.length
    ? [
        { title: "Недавние", items: recent },
        { title: "Остальные записи", items: others },
      ]
    : [{ title: "Записи", items: rows }];
  const secretLabel =
    selected?.data.type === "token"
      ? "API-токен"
      : selected?.data.type === "ssh"
        ? "SSH-ключ"
        : "Пароль";
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Поиск записей"
      description="Поиск по названию, логину, адресу и тегам. Выберите запись для быстрых действий."
      className="search-palette top-[18%] translate-y-0 rounded-2xl bg-popover shadow-lg sm:max-w-xl"
      showCloseButton={false}
      commandProps={{
        value: selectedId,
        onValueChange: setSelectedId,
        shouldFilter: false,
        loop: true,
        onKeyDownCapture: (event) => {
          if (
            event.key !== "Enter" ||
            !(event.ctrlKey || event.metaKey || event.altKey)
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          void copy(
            event.altKey ? "username" : event.shiftKey ? "totp" : "secret",
          );
        },
      }}
    >
      <CommandInput
        aria-label="Быстрый поиск"
        placeholder="Название, логин, адрес или тег…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList className="max-h-[min(360px,45vh)]">
        <CommandEmpty>Ничего не найдено</CommandEmpty>
        {groups
          .filter((group) => group.items.length)
          .map((group) => (
            <CommandGroup key={group.title} heading={group.title}>
              {group.items.map((record) => (
                <CommandItem
                  key={record.id}
                  value={record.id}
                  onSelect={() => openRecord(record.id)}
                >
                  <span className="truncate">{record.data.title}</span>
                  <span className="ml-auto truncate pl-3 text-xs text-ink-2">
                    {record.data.folder}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
      </CommandList>
      {selected && (
        <div
          className="search-actions"
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ")
              event.stopPropagation();
          }}
        >
          <p className="search-selected-name">{selected.data.title}</p>
          <div className="search-action-buttons">
            {[
              ...(selected.data.username ? ["username" as const] : []),
              ...(selected.data.secret ? ["secret" as const] : []),
              ...(selected.data.totp ? ["totp" as const] : []),
            ].map((field) => {
              const label =
                field === "username"
                  ? "Логин"
                  : field === "totp"
                    ? "2FA"
                    : secretLabel;
              return (
                <Button
                  key={field}
                  size="sm"
                  variant="outline"
                  data-search-action={field}
                  disabled={pending}
                  aria-label={`Копировать ${label}`}
                  onClick={() => void copy(field)}
                >
                  {label}
                  {copied === field && <Check aria-hidden="true" size={14} />}
                </Button>
              );
            })}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => openRecord(selected.id)}
            >
              Открыть
            </Button>
          </div>
          <p className="search-keyboard-hint">
            Enter – открыть · Ctrl/⌘+Enter – секрет · Alt+Enter – логин ·
            Ctrl/⌘+Shift+Enter – 2FA
          </p>
        </div>
      )}
    </CommandDialog>
  );
}
