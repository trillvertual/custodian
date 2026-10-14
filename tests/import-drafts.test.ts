import "./dom.ts";
import { indexedDB } from "fake-indexeddb";
import { beforeAll, expect, it, vi } from "vitest";
import {
  ready,
  randomKey,
  sealDraft,
  openDraft,
  draftScope,
  type DraftBody,
} from "../packages/core/src/index.ts";
import { blankRecord } from "../apps/web/src/lib/record-presets.ts";
import {
  listDrafts,
  writeDraft,
  removeDraft,
  openDraftDatabase,
} from "../apps/web/src/lib/draft-storage.ts";
import {
  parseImport,
  mapCsv,
  suggestMapping,
  planImport,
  decodeImportFile,
} from "../apps/web/src/lib/import-records.ts";
const vaultId = "20000000-0000-4000-8000-000000000001",
  userId = "20000000-0000-4000-8000-000000000002";
beforeAll(async () => {
  await ready;
  vi.stubGlobal("indexedDB", indexedDB);
  vi.stubGlobal("DOMParser", window.DOMParser);
});
it("CSV mapping handles quoted multiline secrets and duplicate headers without prototype pollution", () => {
  const source = parseImport(
    'name,password,__proto__,password\n"Synthetic, title","line 1\nline 2",metadata,second-secret',
  );
  if (source.format !== "csv") throw Error();
  const items = mapCsv(source, suggestMapping(source.headers));
  expect(items[0]!.record!.secret).toBe("line 1\nline 2");
  expect(items[0]!.record!.fields).toEqual([
    { name: "__proto__", value: "metadata", secret: true },
    { name: "password", value: "second-secret", secret: true },
  ]);
  expect(() =>
    mapCsv(source, ["title", "secret", "secret", "ignore"]),
  ).toThrow();
});
it("invalid rows remain visible; broken CSV, encrypted Bitwarden and XML entities are rejected", () => {
  const source = parseImport("name,login_totp\nSynthetic,not-valid!");
  if (source.format !== "csv") throw Error();
  expect(mapCsv(source, suggestMapping(source.headers))[0]!.issues).not.toEqual(
    [],
  );
  expect(() => parseImport('name,password\nSynthetic,"broken')).toThrow();
  expect(() => parseImport('{"encrypted":true,"items":[]}')).toThrow();
  expect(() =>
    parseImport(
      '<!DOCTYPE x [<!ENTITY s SYSTEM "https://evil.example">]><KeePassFile/>',
    ),
  ).toThrow();
});
it("Bitwarden carries folders, extra addresses and hidden fields and reports omitted attachments", () => {
  const result = parseImport(
    JSON.stringify({
      folders: [{ id: "folder", name: "VPN" }],
      items: [
        {
          name: "Synthetic",
          type: 1,
          folderId: "folder",
          login: {
            username: "owner",
            password: "Synthetic",
            uris: [
              { uri: "https://one.example" },
              { uri: "https://two.example" },
            ],
          },
          fields: [{ name: "API", value: "Synthetic", type: 0 }],
          attachments: [{}],
        },
      ],
    }),
  );
  if (result.format !== "bitwarden") throw Error();
  expect(result.items[0]!.record!.folder).toBe("VPN");
  expect(result.items[0]!.record!.fields).toHaveLength(2);
  expect(result.items[0]!.warnings).toContain("Вложения не переносятся.");
});
it("KeePass excludes history and recycle bin and preserves custom secrets", () => {
  const xml =
    '<KeePassFile><Meta><RecycleBinUUID>trash</RecycleBinUUID></Meta><Root><Group><Name>VPN</Name><Entry><String><Key>Title</Key><Value>Synthetic</Value></String><String><Key>Password</Key><Value ProtectInMemory="True">Synthetic</Value></String><String><Key>API</Key><Value>token</Value></String><History><Entry><String><Key>Title</Key><Value>Old</Value></String></Entry></History></Entry></Group><Group><UUID>trash</UUID><Entry/></Group></Root></KeePassFile>';
  const source = parseImport(xml);
  if (source.format !== "keepass") throw Error();
  expect(source.items).toHaveLength(1);
  expect(source.items[0]!.record!.fields[0]!.secret).toBe(true);
  expect(source.items[0]!.warnings).toContain(
    "История старых версий не переносится.",
  );
});
it("duplicates distinguish identical contents from matching identities with different secrets", () => {
  const data = { ...blankRecord(), title: "Synthetic", secret: "one" };
  const plan = planImport(
    [
      { row: 1, record: data, issues: [], warnings: [] },
      { row: 2, record: { ...data, secret: "two" }, issues: [], warnings: [] },
      { row: 3, record: data, issues: [], warnings: [] },
    ],
    [],
  );
  expect(plan.map((item) => item.duplicate)).toEqual([
    null,
    "similar",
    "exact",
  ]);
});
it("strict encoding and import bounds reject corruption and oversized files", () => {
  expect(() => decodeImportFile(new Uint8Array([255]))).toThrow();
  expect(() =>
    parseImport(
      JSON.stringify({ items: Array.from({ length: 501 }, () => ({})) }),
    ),
  ).toThrow();
});
it("drafts encrypt incomplete records for one identity and bind the scope and ID", () => {
  const key = randomKey(),
    body: DraftBody = {
      v: 1,
      data: {
        ...blankRecord(),
        secret: "SYNTHETIC-private-draft",
        fields: [{ name: "", value: "SYNTHETIC-custom", secret: true }],
      },
      totpInput: "SYNTHETIC-unfinished",
      recordId: null,
      baseVersion: 0,
      epoch: 1,
    };
  const envelope = sealDraft(body, key, vaultId, userId);
  expect(JSON.stringify(envelope)).not.toContain("SYNTHETIC");
  expect(openDraft(envelope, key, vaultId, userId)).toEqual(body);
  expect(() => openDraft(envelope, randomKey(), vaultId, userId)).toThrow();
  expect(() => openDraft(envelope, key, vaultId, "other")).toThrow();
  expect(() =>
    openDraft({ ...envelope, id: crypto.randomUUID() }, key, vaultId, userId),
  ).toThrow();
});
it("IndexedDB stores ciphertext only, separates scopes, and orders writes and deletion", async () => {
  const key = randomKey(),
    body: DraftBody = {
      v: 1,
      data: { ...blankRecord(), secret: "SYNTHETIC-private-draft" },
      totpInput: "",
      recordId: null,
      baseVersion: 0,
      epoch: 1,
    },
    envelope = sealDraft(body, key, vaultId, userId),
    db = await openDraftDatabase();
  await writeDraft(db, envelope);
  expect(await listDrafts("other")).toEqual([]);
  expect(
    JSON.stringify(await listDrafts(draftScope(vaultId, userId))),
  ).not.toContain(body.data.secret);
  const updated = sealDraft(
    { ...body, data: { ...body.data, secret: "changed" } },
    key,
    vaultId,
    userId,
    envelope.id,
    2,
  );
  await Promise.all([
    writeDraft(db, updated),
    removeDraft(envelope.scope, envelope.id),
  ]);
  expect(await listDrafts(envelope.scope)).toEqual([]);
});

it("older draft writes and clock changes cannot overwrite a newer revision", async () => {
  const key = randomKey(),
    body: DraftBody = {
      v: 1,
      data: { ...blankRecord(), title: "Synthetic revision", secret: "new" },
      totpInput: "",
      recordId: null,
      baseVersion: 0,
      epoch: 1,
    };
  const newest = sealDraft(body, key, vaultId, userId),
    older = sealDraft(
      { ...body, data: { ...body.data, secret: "old" } },
      key,
      vaultId,
      userId,
      newest.id,
      1,
    );
  const current = {
    ...sealDraft(body, key, vaultId, userId, newest.id, 3),
    updatedAt: "2020-01-01T00:00:00.000Z",
  };
  const db = await openDraftDatabase();
  await writeDraft(db, current);
  await writeDraft(db, older);
  expect(
    openDraft(
      (await listDrafts(current.scope)).find((row) => row.id === current.id)!,
      key,
      vaultId,
      userId,
    ).data.secret,
  ).toBe("new");
  await removeDraft(current.scope, current.id);
});
it("forking a stale draft cannot delete a newer version from another tab", async () => {
  const key = randomKey(),
    body: DraftBody = {
      v: 1,
      data: { ...blankRecord(), title: "Synthetic tabs" },
      totpInput: "",
      recordId: null,
      baseVersion: 0,
      epoch: 1,
    },
    old = sealDraft(body, key, vaultId, userId),
    newer = sealDraft(
      { ...body, data: { ...body.data, note: "newer" } },
      key,
      vaultId,
      userId,
      old.id,
      2,
    ),
    fork = sealDraft(body, key, vaultId, userId),
    db = await openDraftDatabase();
  await writeDraft(db, old);
  await writeDraft(db, newer);
  await expect(writeDraft(db, fork, old.id, old)).rejects.toThrow(
    "другой вкладке",
  );
  expect(
    (await listDrafts(old.scope)).some(
      (row) => row.id === old.id && row.revision === 2,
    ),
  ).toBe(true);
  expect((await listDrafts(old.scope)).some((row) => row.id === fork.id)).toBe(
    false,
  );
  await removeDraft(old.scope, old.id);
});
it("revision metadata is authenticated", () => {
  const key = randomKey(),
    envelope = sealDraft(
      {
        v: 1,
        data: blankRecord(),
        totpInput: "",
        recordId: null,
        baseVersion: 0,
        epoch: 1,
      },
      key,
      vaultId,
      userId,
    );
  expect(() =>
    openDraft({ ...envelope, revision: 2 }, key, vaultId, userId),
  ).toThrow();
});
