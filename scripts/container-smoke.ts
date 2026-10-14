import assert from "node:assert/strict";

const base = "http://127.0.0.1:8080";
const health = await fetch(`${base}/api/health`);
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { ok: true });
const config = await fetch(`${base}/api/auth/config`);
assert.equal(config.status, 200);
assert.equal((await config.json()).initialized, false);
const page = await fetch(base);
assert.equal(page.status, 200);
assert.ok(page.headers.get("content-security-policy"));
const html = await page.text();
assert.ok(html.includes('id="root"'));
const script = html.match(/src="([^"\s]*\/assets\/[^"\s]+\.js)"/);
assert.ok(script, "Built frontend entry is missing");
const entry = await fetch(new URL(script[1]!, base), {
  headers: { "Accept-Encoding": "br" },
});
assert.equal(entry.status, 200);
assert.equal(entry.headers.get("content-encoding"), "br");
assert.match(entry.headers.get("vary") ?? "", /Accept-Encoding/i);
console.log(
  "Container: PostgreSQL health, closed bootstrap, CSP and built frontend OK",
);

// Only the two CI-created Compose projects are accepted. Never target a live installation.
const project = process.env.CUSTODIAN_SMOKE_PROJECT ?? "custodian-ci";
assert.ok(["custodian-ci", "custodian-release-check"].includes(project));
const { execFileSync } = await import("node:child_process");
const setupToken = execFileSync(
  "docker",
  ["compose", "-p", project, "exec", "-T", "app", "printenv", "SETUP_TOKEN"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
).trim();
assert.ok(setupToken);
const {
  ready,
  randomKey,
  createIdentity,
  createRecovery,
  sealVaultKey,
  deriveLoginSecret,
  encryptJson,
  decryptJson,
  recordContext,
  recordSchema,
} = await import("../packages/core/src/index.ts");
await ready;
const userId = crypto.randomUUID(),
  vaultId = crypto.randomUUID(),
  key = randomKey(),
  password = "SYNTHETIC-only-container-password!",
  identity = createIdentity(password, userId),
  recovery = createRecovery(key, vaultId, 1),
  origin = "https://vault.test";
const bootstrap = await fetch(`${base}/api/auth/bootstrap`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin },
  body: JSON.stringify({
    setupToken,
    id: userId,
    vaultId,
    vaultName: "Synthetic container",
    username: "container-smoke",
    displayName: "Synthetic smoke",
    identity: identity.identity,
    sealedKey: sealVaultKey(key, identity.identity.publicKey, vaultId, 1),
    recovery: recovery.box,
    loginSecret: deriveLoginSecret(password, "container-smoke", "vault.test"),
  }),
});
assert.equal(bootstrap.status, 200);
const session = await bootstrap.json(),
  cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
const headers = {
  "Content-Type": "application/json",
  Origin: origin,
  Cookie: cookie,
  "X-CSRF-Token": session.csrf,
};
async function getRecords() {
  const response = await fetch(`${base}/api/records`, { headers });
  assert.equal(response.status, 200);
  return await response.json();
}
function encrypted(id: string, version: number) {
  return encryptJson(
    recordSchema.parse({
      type: "login",
      title: "Synthetic container record",
      secret: "SYNTHETIC-only-container-secret",
    }),
    key,
    recordContext(vaultId, id, version, 1),
  );
}
const operation = {
  id: crypto.randomUUID(),
  epoch: 1,
  records: Array.from({ length: 2 }, () => {
    const id = crypto.randomUUID();
    return { id, baseVersion: 0, deleted: false, box: encrypted(id, 1) };
  }),
};
const post = (body: unknown) =>
  fetch(`${base}/api/records/batch`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
const [first, repeated] = await Promise.all([post(operation), post(operation)]);
assert.equal(first.status, 200);
assert.equal(repeated.status, 200);
assert.deepEqual(await first.json(), await repeated.json());
const records = await getRecords();
assert.equal(records.length, 2);
for (const record of records) {
  assert.equal(record.version, 1);
  const data = decryptJson<{ secret: string }>(
    record.box,
    key,
    recordContext(vaultId, record.id, 1, 1),
  );
  assert.equal(data.secret, "SYNTHETIC-only-container-secret");
}
const extraId = crypto.randomUUID(),
  conflict = {
    id: crypto.randomUUID(),
    epoch: 1,
    records: [
      {
        id: extraId,
        baseVersion: 0,
        deleted: false,
        box: encrypted(extraId, 1),
      },
      operation.records[0]!,
    ],
  };
assert.equal((await post(conflict)).status, 409);
assert.deepEqual(await getRecords(), records);
const trash = {
  id: crypto.randomUUID(),
  epoch: 1,
  records: records.map((record: { id: string; version: number }) => ({
    id: record.id,
    baseVersion: record.version,
    deleted: true,
    box: encrypted(record.id, record.version + 1),
  })),
};
assert.equal((await post(trash)).status, 200);
assert.equal((await post(trash)).status, 200);
for (const record of await getRecords()) {
  assert.equal(record.version, 2);
  assert.ok(record.deletedAt);
  const response = await fetch(`${base}/api/records/${record.id}/history`, {
    headers,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).length, 1);
}
console.log(
  "Container: actual PostgreSQL atomic batches, concurrent idempotent retries, rollback and history OK",
);
