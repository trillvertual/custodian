import { useId, useRef, useState } from "react";
import { Check, ChevronDown, Plus, Search, X } from "lucide-react";
import { Button } from "./button";
import { Input } from "./input";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

type ChoicePickerProps = {
  label: string;
  options: string[];
  value: string[];
  onChange: (value: string[]) => void;
  multiple?: boolean;
  maxLength: number;
  maxItems?: number;
  disabled?: boolean;
};

/** Searchable, creatable choices. Values stay in the encrypted record form. */
export function ChoicePicker({
  label,
  options,
  value,
  onChange,
  multiple = false,
  maxLength,
  maxItems = 20,
  disabled: unavailable = false,
}: ChoicePickerProps) {
  const id = useId(),
    listId = `${id}-list`;
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [active, setActive] = useState(0);
  const normalize = (text: string) => text.trim().toLocaleLowerCase("ru");
  const all = [...new Set([...value, ...options])]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "ru"));
  const trimmed = query.trim();
  const choices = [
    ...(!multiple && !trimmed
      ? [{ value: "", label: "Без папки", create: false }]
      : []),
    ...all
      .filter((item) => normalize(item).includes(normalize(query)))
      .map((item) => ({ value: item, label: item, create: false })),
    ...(trimmed && !all.some((item) => normalize(item) === normalize(trimmed))
      ? [{ value: trimmed, label: `Создать «${trimmed}»`, create: true }]
      : []),
  ];
  const index = Math.min(active, Math.max(choices.length - 1, 0));
  const atLimit = multiple && value.length >= maxItems;
  const disabled = (item: (typeof choices)[number]) =>
    atLimit && !value.includes(item.value);
  function choose(item: (typeof choices)[number]) {
    if (unavailable || disabled(item)) return;
    if (multiple) {
      onChange(
        value.includes(item.value)
          ? value.filter((v) => v !== item.value)
          : [...value, item.value],
      );
      if (item.create) {
        setQuery("");
        setActive(0);
      }
      input.current?.focus();
    } else {
      onChange(item.value ? [item.value] : []);
      setOpen(false);
    }
  }
  return (
    <div className="field choice-field">
      <label htmlFor={id}>{label}</label>
      <Popover
        open={open && !unavailable}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) {
            setQuery("");
            setActive(0);
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="ghost"
            className="choice-trigger"
            aria-label={label}
            disabled={unavailable}
          >
            <span className={value.length ? "" : "muted"}>
              {multiple
                ? value.length
                  ? `Выбрано: ${value.length}`
                  : "Выбрать теги"
                : value[0] || "Без папки"}
            </span>
            <ChevronDown size={16} />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="choice-popover"
          align="start"
          sideOffset={6}
          aria-label={multiple ? "Выбор тегов" : "Выбор папки"}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            input.current?.focus();
          }}
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          <div className="choice-search">
            <Search size={16} aria-hidden />
            <Input
              ref={input}
              aria-label={multiple ? "Поиск тегов" : "Поиск папок"}
              placeholder={
                multiple ? "Поиск или новый тег" : "Поиск или новая папка"
              }
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={listId}
              aria-activedescendant={
                choices.length ? `${listId}-${index}` : undefined
              }
              value={query}
              maxLength={maxLength}
              autoComplete="off"
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const next =
                    (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      choices.length) %
                    Math.max(choices.length, 1);
                  setActive(next);
                  document
                    .getElementById(`${listId}-${next}`)
                    ?.scrollIntoView({ block: "nearest" });
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  if (choices[index]) choose(choices[index]);
                } else if (
                  event.key === "Backspace" &&
                  !query &&
                  multiple &&
                  value.length
                ) {
                  onChange(value.slice(0, -1));
                }
              }}
            />
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label={label}
            aria-multiselectable={multiple || undefined}
            className="choice-list"
          >
            {choices.map((item, i) => {
              const selected = item.value
                ? value.includes(item.value)
                : !value.length;
              return (
                <div
                  key={item.value}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={disabled(item) || undefined}
                  data-active={i === index}
                  className="choice-option"
                  onPointerMove={() => setActive(i)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(item)}
                >
                  {item.create ? (
                    <Plus size={15} />
                  ) : (
                    <Check size={15} className={selected ? "" : "invisible"} />
                  )}
                  <span>{item.label}</span>
                </div>
              );
            })}
            {!choices.length && (
              <p className="choice-empty">Нет подходящих вариантов</p>
            )}
          </div>
          <p className="choice-hint">
            {atLimit
              ? `Выбрано ${maxItems} тегов. Удалите один, чтобы добавить другой.`
              : multiple
                ? "Выберите несколько тегов или создайте новый."
                : "Выберите папку или введите новое название."}
          </p>
        </PopoverContent>
      </Popover>
      {multiple && value.length > 0 && (
        <div className="selected-tags">
          {value.map((tag) => (
            <span className="selected-tag" key={tag}>
              <span>{tag}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Удалить тег ${tag}`}
                disabled={unavailable}
                onClick={() => onChange(value.filter((item) => item !== tag))}
              >
                <X size={12} />
              </Button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
