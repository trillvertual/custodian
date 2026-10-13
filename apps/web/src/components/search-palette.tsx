// Search flow adapted from infra-billing's CommandPalette.tsx.
import { useState, useEffect } from "react";
import type { DecryptedRecord } from "../../../../packages/core/src/index.ts";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "./ui/command";
export function SearchPalette({
  open,
  onOpenChange,
  records,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  records: DecryptedRecord[];
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  const rows = records.filter((record) =>
    [
      record.data.title,
      record.data.username,
      record.data.url,
      record.data.folder,
      ...record.data.tags,
    ].some((value) =>
      value.toLocaleLowerCase("ru").includes(query.toLocaleLowerCase("ru")),
    ),
  );
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Поиск записей"
      description="Поиск по названию, логину, адресу и тегам. Секреты не отображаются."
      className="search-palette top-[18%] translate-y-0 rounded-2xl bg-popover shadow-lg sm:max-w-xl"
      showCloseButton={false}
    >
      <CommandInput
        aria-label="Быстрый поиск"
        placeholder="Название, логин, адрес или тег…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList className="max-h-[min(420px,60vh)]">
        <CommandEmpty>Ничего не найдено</CommandEmpty>
        <CommandGroup heading="Записи">
          {rows.map((record) => (
            <CommandItem
              key={record.id}
              value={`${record.id} ${record.data.title} ${record.data.username} ${record.data.url} ${record.data.folder} ${record.data.tags.join(" ")}`}
              onSelect={() => {
                onOpenChange(false);
                onSelect(record.id);
              }}
            >
              <span className="truncate">{record.data.title}</span>
              <span className="ml-auto truncate pl-3 text-xs text-ink-2">
                {record.data.folder}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
