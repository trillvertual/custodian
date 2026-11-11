import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import ts from "typescript";
import semver from "semver";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

// AJV 6 uses only parse/serialize/resolve from uri-js. Exercise its actual
// resolver through relative schema references after replacing the vulnerable
// parser with fast-uri; do not merely check the dependency's declared version.
const require = createRequire(import.meta.url);
const Ajv = require("ajv");
const ajvRequire = createRequire(require.resolve("ajv/package.json"));
assert.equal(ajvRequire("uri-js/package.json").name, "fast-uri");
const ajv = new Ajv({ schemaId: "auto" });
ajv.addSchema({
  $id: "https://example.test/schema/value.json",
  type: "string",
  pattern: "^[a-z]+$",
});
const validate = ajv.compile({
  $id: "https://example.test/schema/root.json",
  type: "object",
  properties: { value: { $ref: "value.json" } },
  required: ["value"],
  additionalProperties: false,
});
assert.equal(validate({ value: "safe" }), true);
assert.equal(validate({ value: 42 }), false);
assert.equal(validate({ value: "NOT-LOWER" }), false);
const probe = spawnSync(
  process.execPath,
  [
    "-e",
    `const uri = require(${JSON.stringify(ajvRequire.resolve("uri-js"))}); try { uri.resolve("https://example.test/a", "\\u2028/./x", { iri: true }); } catch {}`,
  ],
  { timeout: 2000, stdio: "ignore" },
);
assert.equal(
  probe.status,
  0,
  "URI resolution must finish on Unicode separators",
);

const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = await mkdtemp(join(root, "tests", "lint-fixture-"));
try {
  const localTs = fileURLToPath(
    new URL("./node_modules/typescript/package.json", import.meta.url),
  );
  const appTs = join(root, "node_modules", "typescript", "package.json");
  assert.notEqual(await realpath(localTs), await realpath(appTs));
  const parser = require("typescript-eslint/package.json");
  assert.ok(
    semver.satisfies(ts.version, parser.peerDependencies.typescript),
    "The isolated compiler must be supported by typescript-eslint",
  );
  const app = JSON.parse(await readFile(appTs, "utf8"));
  assert.match(app.version, /^7\./);
  const unsafe = join(directory, "unsafe.tsx"),
    safe = join(directory, "safe.ts");
  await writeFile(
    unsafe,
    `import { useState } from "react";
async function task() { return 42; }
task();
setTimeout(async () => { await task(); }, 0);
export async function wrongAwait() { await 42; }
export function Broken() { if (Math.random() > 0.5) useState(0); return null; }
`,
  );
  await writeFile(
    safe,
    `async function task() { return 42; }
void task().catch(() => {});
export async function checked() { return await task(); }
`,
  );
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: join(root, "tools/lint/eslint.config.mjs"),
  });
  const results = await eslint.lintFiles([unsafe, safe]);
  const bad = results.find((result) => result.filePath === unsafe);
  const good = results.find((result) => result.filePath === safe);
  assert.ok(bad && good);
  assert.equal(bad.fatalErrorCount, 0, JSON.stringify(bad.messages));
  const rules = new Set(bad.messages.map((message) => message.ruleId));
  for (const rule of [
    "@typescript-eslint/no-floating-promises",
    "@typescript-eslint/no-misused-promises",
    "@typescript-eslint/await-thenable",
    "react-hooks/rules-of-hooks",
  ]) {
    assert.ok(rules.has(rule), `Expected ${rule} to reject the fixture`);
  }
  assert.equal(good.errorCount, 0);
  assert.equal(good.warningCount, 0);
  console.log(
    "Lint smoke: async and Hook violations rejected; handled Promises accepted; app TypeScript unchanged.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
