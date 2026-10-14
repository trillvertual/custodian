import Papa from "papaparse";
import {
  batchLimit,
  normalizeTotp,
  recordSchema,
  type VaultRecord,
  type DecryptedRecord,
} from "../../../../packages/core/src/index.ts";
import { blankRecord } from "./record-presets";
export const importFileLimit = 5 * 1024 * 1024;
export type MappingTarget =
  | "ignore"
  | "title"
  | "type"
  | "url"
  | "username"
  | "secret"
  | "note"
  | "folder"
  | "tags"
  | "favorite"
  | "totp"
  | "field";
export const mappingLabels: Record<MappingTarget, string> = {
  ignore: "Не переносить",
  title: "Название",
  type: "Тип",
  url: "Сайт / адрес",
  username: "Логин",
  secret: "Пароль / ключ / токен",
  note: "Заметка",
  folder: "Папка",
  tags: "Теги",
  favorite: "Избранное",
  totp: "Секрет / ссылка TOTP",
  field: "Дополнительное секретное поле",
};
export type ImportItem = {
  row: number;
  record?: VaultRecord;
  issues: string[];
  warnings: string[];
};
export type ImportSource =
  | { format: "csv"; headers: string[]; rows: string[][] }
  | { format: "bitwarden" | "keepass"; items: ImportItem[] };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Неверная структура файла.");
  return value as Record<string, unknown>;
};
const text = (value: unknown) => {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string")
    throw new Error("Поле должно содержать текст.");
  return value;
};
const norm = (value: string) =>
  value
    .trim()
    .toLocaleLowerCase("ru")
    .replace(/[\s_-]/g, "");
export function suggestMapping(headers: string[]): MappingTarget[] {
  const aliases: Partial<Record<MappingTarget, string[]>> = {
    title: ["title", "name", "название", "account"],
    type: ["type", "тип"],
    url: ["url", "website", "web site", "site", "сайт", "адрес", "login_uri"],
    username: [
      "username",
      "user name",
      "user",
      "login",
      "логин",
      "login_username",
    ],
    secret: [
      "password",
      "пароль",
      "secret",
      "token",
      "api key",
      "login_password",
    ],
    note: ["notes", "note", "comment", "заметка", "comments"],
    folder: ["folder", "group", "группа", "папка"],
    tags: ["tags", "теги"],
    favorite: ["favorite", "избранное"],
    totp: ["totp", "otp", "2fa", "login_totp"],
  };
  const assigned = new Set<MappingTarget>();
  return headers.map((header) => {
    if (["reprompt"].includes(norm(header))) return "ignore";
    const match = Object.entries(aliases).find(([, names]) =>
      names.some((name) => norm(name) === norm(header)),
    )?.[0] as MappingTarget | undefined;
    if (match && !assigned.has(match)) {
      assigned.add(match);
      return match;
    }
    return "field";
  });
}
export function decodeImportFile(
  bytes: Uint8Array,
  encoding = "utf-8",
): string {
  if (bytes.byteLength > importFileLimit)
    throw new Error("Файл больше 5 МБ. Разделите экспорт на несколько файлов.");
  if (
    bytes[0] === 3 &&
    bytes[1] === 217 &&
    bytes[2] === 162 &&
    bytes[3] === 154
  )
    throw new Error("Для KeePass используйте XML или CSV-экспорт.");
  const format =
    bytes[0] === 255 && bytes[1] === 254
      ? "utf-16le"
      : bytes[0] === 254 && bytes[1] === 255
        ? "utf-16be"
        : encoding;
  try {
    return new TextDecoder(format, { fatal: true })
      .decode(bytes)
      .replace(/^\uFEFF/, "");
  } catch {
    throw new Error(
      "Не удалось прочитать кодировку. Выберите UTF-8 или Windows-1251.",
    );
  }
}
function item(
  row: number,
  data: unknown,
  totpInput = "",
  warnings: string[] = [],
): ImportItem {
  try {
    const value = object(data);
    if (totpInput.trim()) value.totp = normalizeTotp(totpInput.trim());
    const result = recordSchema.safeParse(value);
    if (!result.success) {
      const labels = [
        ...new Set(
          result.error.issues.map(
            (issue) =>
              mappingLabels[issue.path[0] as MappingTarget] ??
              "Дополнительные поля",
          ),
        ),
      ];
      return {
        row,
        issues: [`Проверьте поля и их длину: ${labels.join(", ")}.`],
        warnings,
      };
    }
    return { row, record: result.data, issues: [], warnings };
  } catch {
    return {
      row,
      issues: ["Неверные значения или неподдерживаемые параметры TOTP."],
      warnings,
    };
  }
}
export function mapCsv(
  source: Extract<ImportSource, { format: "csv" }>,
  mapping: MappingTarget[],
): ImportItem[] {
  if (mapping.length !== source.headers.length)
    throw new Error("Неверное сопоставление столбцов.");
  const targets = mapping.filter(
    (target) => target !== "field" && target !== "ignore",
  );
  if (!targets.includes("title"))
    throw new Error("Выберите столбец с названием записи.");
  if (new Set(targets).size !== targets.length)
    throw new Error(
      "Каждое основное поле можно связать только с одним столбцом.",
    );
  return source.rows.map((cells, index) => {
    if (cells.length !== source.headers.length)
      return {
        row: index + 2,
        issues: ["Количество значений отличается от числа столбцов."],
        warnings: [],
      };
    const data = blankRecord();
    let totpInput = "";
    try {
      for (const [column, target] of mapping.entries()) {
        const value = cells[column] ?? "";
        if (target === "ignore") continue;
        if (target === "field") {
          if (value)
            data.fields.push({
              name: source.headers[column] || `Поле ${column + 1}`,
              value,
              secret: true,
            });
        } else if (target === "totp") totpInput = value;
        else if (target === "tags")
          data.tags = [
            ...new Set(
              value
                .split(/[,;]/)
                .map((tag) => tag.trim())
                .filter(Boolean),
            ),
          ];
        else if (target === "favorite") {
          if (value && !/^(true|false|0|1|yes|no|да|нет)$/i.test(value.trim()))
            throw Error();
          data.favorite = /^(true|1|yes|да)$/i.test(value.trim());
        } else if (target === "type") {
          const types: Record<string, VaultRecord["type"]> = {
            login: "login",
            логин: "login",
            token: "token",
            apitoken: "token",
            ssh: "ssh",
            sshkey: "ssh",
            note: "note",
            securenote: "note",
            заметка: "note",
          };
          if (value.trim() && !types[norm(value)]) throw Error();
          data.type = types[norm(value)] ?? "login";
        } else data[target] = value;
      }
      return item(index + 2, data, totpInput);
    } catch {
      return {
        row: index + 2,
        issues: ["Неподдерживаемый тип записи или значение избранного."],
        warnings: [],
      };
    }
  });
}
function bitwarden(input: unknown): ImportSource {
  const json = object(input);
  if (json.encrypted === true)
    throw new Error(
      "Нужен незашифрованный JSON-экспорт Bitwarden. Файл обрабатывается только в браузере.",
    );
  if (!Array.isArray(json.items) || json.items.length > batchLimit)
    throw new Error(`Нужен экспорт Bitwarden, не более ${batchLimit} записей.`);
  const folders = new Map<string, string>();
  if (Array.isArray(json.folders))
    for (const raw of json.folders) {
      const folder = object(raw);
      folders.set(text(folder.id), text(folder.name));
    }
  const items = json.items.map((raw, index): ImportItem => {
    try {
      const entry = object(raw),
        data = blankRecord(),
        warnings: string[] = [];
      data.title = text(entry.name);
      data.note = text(entry.notes);
      data.favorite = entry.favorite === true;
      data.folder = folders.get(text(entry.folderId)) ?? "";
      if (entry.folderId && !folders.has(text(entry.folderId)))
        warnings.push("Исходная папка отсутствует в экспорте.");
      if (entry.type === 1) {
        const login = object(entry.login);
        data.username = text(login.username);
        data.secret = text(login.password);
        if (Array.isArray(login.uris))
          for (const [n, rawUri] of login.uris.entries()) {
            const uri = text(object(rawUri).uri);
            if (n === 0) data.url = uri;
            else if (uri)
              data.fields.push({
                name: `Адрес ${n + 1}`,
                value: uri,
                secret: false,
              });
          }
        if (
          Array.isArray(login.fido2Credentials) &&
          login.fido2Credentials.length
        )
          warnings.push("Passkey из записи не переносятся.");
        if (login.totp) data.totp = normalizeTotp(text(login.totp).trim());
      } else if (entry.type === 5) {
        const ssh = object(entry.sshKey);
        data.type = "ssh";
        data.secret = text(ssh.privateKey);
        if (ssh.publicKey)
          data.fields.push({
            name: "Публичный ключ",
            value: text(ssh.publicKey),
            secret: false,
          });
        if (ssh.keyFingerprint)
          data.fields.push({
            name: "Отпечаток ключа",
            value: text(ssh.keyFingerprint),
            secret: false,
          });
      } else if (entry.type === 2) data.type = "note";
      else if (entry.type === 3 || entry.type === 4) {
        data.type = "note";
        const values = object(entry.type === 3 ? entry.card : entry.identity);
        for (const [name, value] of Object.entries(values)) {
          if (value !== null && value !== undefined && value !== "")
            data.fields.push({ name, value: text(value), secret: true });
        }
        warnings.push(
          "Карточка или личные данные будут сохранены как заметка с секретными полями.",
        );
      } else throw Error();
      if (entry.fields != null && !Array.isArray(entry.fields)) throw Error();
      if (Array.isArray(entry.fields))
        for (const rawField of entry.fields) {
          const field = object(rawField);
          if (field.type === 3) {
            warnings.push("Связанное поле Bitwarden не перенесено.");
            continue;
          }
          data.fields.push({
            name: text(field.name),
            value: text(field.value),
            secret: true,
          });
        }
      if (Array.isArray(entry.attachments) && entry.attachments.length)
        warnings.push("Вложения не переносятся.");
      if (Array.isArray(entry.passwordHistory) && entry.passwordHistory.length)
        warnings.push("История старых паролей не переносится.");
      return item(index + 1, data, "", warnings);
    } catch {
      return {
        row: index + 1,
        issues: [
          "Неподдерживаемая структура записи Bitwarden или параметры TOTP.",
        ],
        warnings: [],
      };
    }
  });
  return { format: "bitwarden", items };
}
function keepass(xml: string): ImportSource {
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(xml))
    throw new Error("XML с DTD или внешними сущностями не поддерживается.");
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (
    document.querySelector("parsererror") ||
    document.documentElement.tagName !== "KeePassFile"
  )
    throw new Error("Нужен XML-экспорт KeePass.");
  const items: ImportItem[] = [];
  const child = (node: Element, name: string) =>
    Array.from(node.children).find((element) => element.tagName === name);
  const value = (node: Element, name: string) =>
    child(node, name)?.textContent ?? "";
  const recycle = document.querySelector("Meta > RecycleBinUUID")?.textContent;
  function visit(group: Element, path: string[], depth: number) {
    if (depth > 32) throw new Error("Слишком большая вложенность папок.");
    if (recycle && value(group, "UUID") === recycle) return;
    const folder = [...path, value(group, "Name")].filter(Boolean);
    for (const entry of Array.from(group.children).filter(
      (element) => element.tagName === "Entry",
    )) {
      if (items.length >= batchLimit)
        throw new Error(
          `В одном импорте допускается до ${batchLimit} записей.`,
        );
      const data = blankRecord();
      data.folder = folder.join(" / ");
      data.tags = value(entry, "Tags")
        .split(/[;,]/)
        .map((tag) => tag.trim())
        .filter(Boolean);
      let totpInput = "",
        protectedValue = false;
      const otpParameters: Record<string, string> = {};
      const warnings: string[] = [];
      for (const pair of Array.from(entry.children).filter(
        (element) => element.tagName === "String",
      )) {
        const name = value(pair, "Key"),
          node = child(pair, "Value"),
          raw = node?.textContent ?? "";
        if (node?.getAttribute("Protected")?.toLowerCase() === "true")
          protectedValue = true;
        const key = norm(name);
        if (key === "title") data.title = raw;
        else if (key === "url") data.url = raw;
        else if (key === "username") data.username = raw;
        else if (key === "password") data.secret = raw;
        else if (key === "notes") data.note = raw;
        else if (["otp", "totp", "timeotpsecretbase32"].includes(key))
          totpInput = raw;
        else if (
          ["timeotplength", "timeotpperiod", "timeotpalgorithm"].includes(key)
        )
          otpParameters[key] = raw;
        else data.fields.push({ name, value: raw, secret: true });
      }
      if (
        totpInput &&
        !totpInput.startsWith("otpauth://") &&
        Object.keys(otpParameters).length
      ) {
        const params = new URLSearchParams({
          secret: totpInput,
          digits: otpParameters.timeotplength || "6",
          period: otpParameters.timeotpperiod || "30",
          algorithm: (otpParameters.timeotpalgorithm || "HMAC-SHA-1")
            .replace(/^HMAC-/i, "")
            .replaceAll("-", ""),
        });
        totpInput = "otpauth://totp/Imported?" + params.toString();
      }
      if (!totpInput && Object.keys(otpParameters).length) {
        for (const [key, value] of Object.entries(otpParameters))
          data.fields.push({
            name: (
              {
                timeotplength: "TimeOtp-Length",
                timeotpperiod: "TimeOtp-Period",
                timeotpalgorithm: "TimeOtp-Algorithm",
              } as Record<string, string>
            )[key]!,
            value,
            secret: true,
          });
        warnings.push(
          "Настройки OTP сохранены как секретные поля. Генератор не настроен.",
        );
      }
      if (child(entry, "Binary")) warnings.push("Вложения не переносятся.");
      if (child(entry, "History"))
        warnings.push("История старых версий не переносится.");
      if (!data.secret && !data.username && !data.url) data.type = "note";
      items.push(
        protectedValue
          ? {
              row: items.length + 1,
              issues: [
                "XML содержит зашифрованные значения. Нужен обычный XML-экспорт KeePass.",
              ],
              warnings,
            }
          : item(items.length + 1, data, totpInput, warnings),
      );
    }
    for (const nested of Array.from(group.children).filter(
      (element) => element.tagName === "Group",
    ))
      visit(nested, folder, depth + 1);
  }
  const root = document.querySelector("KeePassFile > Root");
  if (!root) throw new Error("Неверная структура KeePass XML.");
  for (const group of Array.from(root.children).filter(
    (element) => element.tagName === "Group",
  ))
    visit(group, [], 0);
  return { format: "keepass", items };
}
export function parseImport(text: string, delimiter = ""): ImportSource {
  if (new TextEncoder().encode(text).length > importFileLimit)
    throw new Error("Файл больше 5 МБ.");
  const input = text.trimStart();
  if (input.startsWith("{")) {
    try {
      return bitwarden(JSON.parse(input));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("Повреждён JSON-файл.");
      throw error;
    }
  }
  if (input.startsWith("<")) return keepass(text);
  const result = Papa.parse<string[]>(text, {
    delimiter,
    skipEmptyLines: "greedy",
    preview: batchLimit + 2,
  });
  if (result.errors.some((error) => error.code !== "UndetectableDelimiter"))
    throw new Error(
      "CSV содержит ошибку кавычек или разделителей. Проверьте исходный экспорт.",
    );
  const [headers, ...rows] = result.data;
  if (!headers?.length || headers.length > 40)
    throw new Error("CSV должен содержать заголовок и не более 40 столбцов.");
  if (rows.length > batchLimit || result.meta.truncated)
    throw new Error(`В одном импорте допускается до ${batchLimit} записей.`);
  if (!rows.length) throw new Error("В файле нет записей.");
  return {
    format: "csv",
    headers: headers.map((header) => header.trim()),
    rows,
  };
}
export type PlannedImport = ImportItem & {
  duplicate: "exact" | "similar" | null;
};
export function planImport(
  items: ImportItem[],
  records: DecryptedRecord[],
): PlannedImport[] {
  const identity = (data: VaultRecord) =>
    JSON.stringify([
      data.type,
      data.title.trim().toLocaleLowerCase("ru"),
      data.url.trim(),
      data.username.trim(),
    ]);
  const exact = (data: VaultRecord) =>
    JSON.stringify({ ...data, tags: [...data.tags].sort() });
  const known = new Map<string, Set<string>>();
  for (const { data, deletedAt } of records) {
    if (deletedAt) continue;
    const key = identity(data),
      values = known.get(key) ?? new Set();
    values.add(exact(data));
    known.set(key, values);
  }
  return items.map((entry) => {
    if (!entry.record) return { ...entry, duplicate: null };
    const key = identity(entry.record),
      signature = exact(entry.record),
      values = known.get(key),
      duplicate = values ? (values.has(signature) ? "exact" : "similar") : null;
    const next = values ?? new Set<string>();
    next.add(signature);
    known.set(key, next);
    return { ...entry, duplicate };
  });
}
