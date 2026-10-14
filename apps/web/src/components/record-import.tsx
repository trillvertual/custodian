import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Upload } from "lucide-react";
import type { VaultStore } from "../lib/store";
import { ApiError } from "../lib/api";
import {
  decodeImportFile,
  importFileLimit,
  mapCsv,
  mappingLabels,
  parseImport,
  planImport,
  suggestMapping,
  type ImportSource,
  type MappingTarget,
} from "../lib/import-records";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { LabeledSelect } from "./ui/labeled-select";
import { ErrorMessage } from "./forms";
import { typeLabels } from "./record-editor";
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from "./ui/table";
export function RecordImport({
  store,
  open,
  onClose,
  onExitComplete,
}: {
  store: VaultStore;
  open: boolean;
  onClose: () => void;
  onExitComplete: () => void;
}) {
  const [source, setSource] = useState<ImportSource | null>(null),
    [mapping, setMapping] = useState<MappingTarget[]>([]),
    [encoding, setEncoding] = useState("utf-8"),
    [delimiter, setDelimiter] = useState("auto"),
    [chosen, setChosen] = useState<Set<number> | null>(null),
    [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [page, setPage] = useState(0),
    [prepared, setPrepared] = useState<ReturnType<
      VaultStore["prepareBatch"]
    > | null>(null);
  const input = useRef<HTMLInputElement>(null),
    bytes = useRef<Uint8Array | null>(null),
    generation = useRef(0),
    mounted = useRef(false),
    sending = useRef(false),
    readKeys = useRef(store.keys.current);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      bytes.current?.fill(0);
      bytes.current = null;
    };
  }, []);
  const showing = useRef(open);
  showing.current = open;
  useEffect(() => {
    if (!open) generation.current++;
  }, [open]);
  function current(attempt: number, keys: typeof store.keys.current) {
    return (
      mounted.current &&
      showing.current &&
      generation.current === attempt &&
      keys !== null &&
      store.keys.current === keys
    );
  }
  function decode(
    data: Uint8Array,
    nextEncoding = encoding,
    nextDelimiter = delimiter,
  ) {
    const parsed = parseImport(
      decodeImportFile(data, nextEncoding),
      nextDelimiter === "auto" ? "" : nextDelimiter,
    );
    setSource(parsed);
    setMapping(parsed.format === "csv" ? suggestMapping(parsed.headers) : []);
    setChosen(null);
    setAck(false);
    setPage(0);
    setError("");
  }
  async function read(file: File) {
    if (sending.current || prepared) return;
    const attempt = ++generation.current,
      keys = store.keys.current;
    readKeys.current = keys;
    setBusy(true);
    setError("");
    setSource(null);
    try {
      if (file.size > importFileLimit)
        throw new Error(
          "Файл больше 5 МБ. Разделите экспорт на несколько файлов.",
        );
      const data = new Uint8Array(await file.arrayBuffer());
      if (!current(attempt, keys)) {
        data.fill(0);
        return;
      }
      bytes.current?.fill(0);
      bytes.current = data;
      decode(data);
    } catch (error) {
      if (current(attempt, keys))
        setError(
          error instanceof Error ? error.message : "Не удалось прочитать файл.",
        );
    } finally {
      if (current(attempt, keys)) setBusy(false);
    }
  }
  const preview = useMemo(() => {
    try {
      return {
        items: planImport(
          source
            ? source.format === "csv"
              ? mapCsv(source, mapping)
              : source.items
            : [],
          store.records,
        ),
        error: "",
      };
    } catch (error) {
      return {
        items: [],
        error:
          error instanceof Error
            ? error.message
            : "Не удалось сопоставить поля.",
      };
    }
  }, [source, mapping, store.records]);
  const selected = preview.items.filter(
    (item) => item.record && (chosen ? chosen.has(item.row) : !item.duplicate),
  );
  const warnings = selected.some((item) => item.warnings.length),
    frozen = busy || !!prepared;
  const invalid = preview.items.filter((item) => item.issues.length).length,
    duplicates = preview.items.filter((item) => item.duplicate).length;
  function choose(row: number, checked: boolean) {
    const next = new Set(selected.map((item) => item.row));
    if (checked) next.add(row);
    else next.delete(row);
    setChosen(next);
    setAck(false);
  }
  async function submit() {
    if (
      sending.current ||
      (!prepared && (!selected.length || (warnings && !ack))) ||
      store.keys.current !== readKeys.current
    )
      return;
    sending.current = true;
    setBusy(true);
    setError("");
    const keys = store.keys.current;
    try {
      const operation =
        prepared ??
        store.prepareBatch(selected.map((item) => ({ data: item.record! })));
      setPrepared(operation);
      const result = await store.executeBatch(operation);
      if (
        mounted.current &&
        keys !== null &&
        store.keys.current === keys &&
        result
      ) {
        toast.success(`Импортировано записей: ${result.records.length}.`);
        onClose();
      }
    } catch (error) {
      if (mounted.current && store.keys.current === keys) {
        setError(
          error instanceof Error
            ? error.message
            : "Не удалось подтвердить результат. Повторите отправку того же запроса.",
        );
        if (error instanceof ApiError && error.status === 409)
          setPrepared(null);
      }
    } finally {
      sending.current = false;
      if (mounted.current) {
        setBusy(false);
      }
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !sending.current) onClose();
      }}
      onExitComplete={onExitComplete}
      title="Импорт записей"
      description="CSV, Bitwarden JSON/CSV или KeePass XML/CSV. Файл читается и шифруется в браузере."
      wide
    >
      <div className="import-flow">
        <input
          ref={input}
          type="file"
          className="sr-only"
          tabIndex={-1}
          accept=".csv,.json,.xml,.txt"
          aria-label="Файл для импорта"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void read(file);
          }}
        />
        <div className="import-scroll">
          <Button
            variant="outline"
            disabled={frozen}
            onClick={() => input.current?.click()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const file = event.dataTransfer.files[0];
              if (file) void read(file);
            }}
          >
            <Upload size={16} />
            {source ? "Выбрать другой файл" : "Выбрать или перетащить файл"}
          </Button>
          <p className="muted">
            До 5 МБ и 500 записей за операцию. Существующие записи не
            заменяются. Дубликаты по умолчанию пропускаются.
          </p>
          <div className="form-grid">
            <LabeledSelect
              label="Кодировка"
              value={encoding}
              disabled={frozen}
              options={[
                { value: "utf-8", label: "UTF-8" },
                { value: "windows-1251", label: "Windows-1251" },
              ]}
              onChange={(value) => {
                setEncoding(value);
                if (bytes.current)
                  try {
                    decode(bytes.current, value);
                  } catch (error) {
                    setSource(null);
                    setError((error as Error).message);
                  }
              }}
            />
            <LabeledSelect
              label="Разделитель CSV"
              value={delimiter}
              disabled={frozen}
              options={[
                { value: "auto", label: "Определить автоматически" },
                { value: ",", label: "Запятая" },
                { value: ";", label: "Точка с запятой" },
                { value: "\t", label: "Табуляция" },
              ]}
              onChange={(value) => {
                setDelimiter(value);
                if (bytes.current)
                  try {
                    decode(bytes.current, encoding, value);
                  } catch (error) {
                    setSource(null);
                    setError((error as Error).message);
                  }
              }}
            />
          </div>
          {source?.format === "csv" && (
            <div className="import-mapping">
              <h3>Сопоставление столбцов</h3>
              {source.headers.map((header, column) => (
                <LabeledSelect
                  key={column}
                  label={`Столбец ${column + 1}: ${header.slice(0, 100) || "без названия"}`}
                  value={mapping[column] ?? "ignore"}
                  disabled={frozen}
                  options={Object.entries(mappingLabels).map(
                    ([value, label]) => ({ value, label }),
                  )}
                  onChange={(value) => {
                    setMapping((previous) =>
                      previous.map((target, n) =>
                        n === column ? (value as MappingTarget) : target,
                      ),
                    );
                    setChosen(null);
                    setAck(false);
                  }}
                />
              ))}
            </div>
          )}
          {preview.items.length > 0 && (
            <>
              <h3>Предпросмотр</h3>
              <p className="muted">
                Выбрано {selected.length} из {preview.items.length}. Дубликатов:{" "}
                {duplicates}. Строк с ошибками: {invalid}.
              </p>
              <div className="import-choice-actions">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={frozen}
                  onClick={() => {
                    setChosen(null);
                    setAck(false);
                  }}
                >
                  Только новые
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={frozen}
                  onClick={() => {
                    setChosen(
                      new Set(
                        preview.items
                          .filter((item) => item.record)
                          .map((item) => item.row),
                      ),
                    );
                    setAck(false);
                  }}
                >
                  Выбрать все допустимые
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={frozen}
                  onClick={() => setChosen(new Set())}
                >
                  Снять выбор
                </Button>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Выбор</TableHead>
                    <TableHead>Название / папка</TableHead>
                    <TableHead>Проверка</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.items
                    .slice(page * 25, (page + 1) * 25)
                    .map((item) => (
                      <TableRow key={item.row}>
                        <TableCell>
                          <Checkbox
                            aria-label={`Импортировать строку ${item.row}`}
                            disabled={frozen || !item.record}
                            checked={selected.some(
                              (value) => value.row === item.row,
                            )}
                            onCheckedChange={(value) =>
                              choose(item.row, value === true)
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <strong>
                            {item.record?.title || `Строка ${item.row}`}
                          </strong>
                          {item.record && (
                            <>
                              <div className="muted">
                                {typeLabels[item.record.type]}
                                {item.record.folder
                                  ? ` · ${item.record.folder}`
                                  : ""}
                              </div>
                              <div className="muted">
                                {item.record.username}
                                {item.record.username && item.record.url
                                  ? " · "
                                  : ""}
                                {item.record.url}
                              </div>
                            </>
                          )}
                        </TableCell>
                        <TableCell>
                          <span>
                            {item.duplicate === "exact"
                              ? "Уже есть"
                              : item.duplicate === "similar"
                                ? "Похожая запись"
                                : item.record
                                  ? "Новая запись"
                                  : "Не импортируется"}
                          </span>
                          {[...item.issues, ...item.warnings].map((message) => (
                            <p className="import-row-note" key={message}>
                              {message}
                            </p>
                          ))}
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
              {preview.items.length > 25 && (
                <div className="import-choice-actions">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page === 0}
                    onClick={() => setPage(page - 1)}
                  >
                    Назад
                  </Button>
                  <span>
                    Страница {page + 1} из{" "}
                    {Math.ceil(preview.items.length / 25)}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={(page + 1) * 25 >= preview.items.length}
                    onClick={() => setPage(page + 1)}
                  >
                    Далее
                  </Button>
                </div>
              )}
            </>
          )}
          {warnings && (
            <label className="check-line">
              <Checkbox
                checked={ack}
                disabled={frozen}
                onCheckedChange={(value) => setAck(value === true)}
              />
              Я проверил предупреждения о преобразовании и непереносимых данных.
            </label>
          )}
          <ErrorMessage error={error || preview.error} />
          {prepared && (
            <p className="muted">
              Повторная отправка использует тот же запрос и проверит его
              результат. Она не создаст вторую копию операции.
            </p>
          )}
        </div>
        <div className="dialog-actions">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Закрыть
          </Button>
          <Button
            disabled={
              busy ||
              (!prepared &&
                (!selected.length || !!preview.error || (warnings && !ack)))
            }
            onClick={() => void submit()}
          >
            {busy
              ? "Сохранение…"
              : prepared
                ? "Повторить отправку"
                : `Импортировать (${selected.length})`}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
