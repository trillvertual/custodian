import type { VaultRecord } from "../../../../packages/core/src/index.ts";

export function blankRecord(): VaultRecord {
  return {
    title: "",
    type: "login",
    url: "",
    username: "",
    secret: "",
    note: "",
    folder: "",
    tags: [],
    favorite: false,
    totp: null,
    fields: [],
  };
}

type RecordTemplate = {
  id: string;
  label: string;
  type: VaultRecord["type"];
  folder: string;
  tags: string[];
  fields?: VaultRecord["fields"];
};

export const recordTemplates: RecordTemplate[] = [
  { id: "blank", label: "Без шаблона", type: "login", folder: "", tags: [] },
  {
    id: "ssh",
    label: "SSH-сервер",
    type: "ssh",
    folder: "Инфраструктура",
    tags: ["ssh"],
    fields: [
      { name: "Порт", value: "22", secret: false },
      { name: "Passphrase", value: "", secret: true },
    ],
  },
  {
    id: "remnawave",
    label: "Remnawave",
    type: "login",
    folder: "VPN-панели",
    tags: ["remnawave", "vpn"],
    fields: [{ name: "API-токен", value: "", secret: true }],
  },
  {
    id: "telegram",
    label: "Telegram-бот",
    type: "token",
    folder: "Боты",
    tags: ["telegram"],
  },
  {
    id: "postgres",
    label: "PostgreSQL",
    type: "login",
    folder: "Базы данных",
    tags: ["postgresql"],
    fields: [
      { name: "Порт", value: "5432", secret: false },
      { name: "База данных", value: "", secret: false },
    ],
  },
  {
    id: "hosting",
    label: "Аккаунт хостера",
    type: "login",
    folder: "Хостинг",
    tags: ["hosting"],
  },
  {
    id: "api",
    label: "API-токен",
    type: "token",
    folder: "API",
    tags: ["api"],
  },
];

export function recordFromTemplate(id: string): VaultRecord {
  const template = recordTemplates.find((item) => item.id === id);
  if (!template) throw new Error("Шаблон не найден.");
  return {
    ...blankRecord(),
    type: template.type,
    folder: template.folder,
    tags: [...template.tags],
    fields: structuredClone(template.fields ?? []),
  };
}

export function similarRecord(source: VaultRecord): VaultRecord {
  const suffix = " (копия)";
  // Copy only structure. Notes, URLs and unmarked fields can also contain secrets.
  return {
    ...blankRecord(),
    title: source.title.slice(0, 200 - suffix.length).trimEnd() + suffix,
    type: source.type,
    folder: source.folder,
    tags: [...source.tags],
    fields: source.fields.map(({ name, secret }) => ({
      name,
      secret,
      value: "",
    })),
  };
}
