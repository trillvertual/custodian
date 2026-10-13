import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const root = await json("package.json");
assert.match(root.version, /^\d+\.\d+\.\d+$/);
for (const dir of [
  "apps/web",
  "apps/server",
  "packages/core",
  "packages/rescue",
]) {
  const manifest = await json(`${dir}/package.json`);
  assert.equal(manifest.version, root.version, `${dir} version mismatch`);
  assert.equal(manifest.private, true, `${dir} must remain private`);
}
const lock = await json("package-lock.json");
assert.equal(lock.version, root.version);
assert.equal(lock.packages[""].version, root.version);
for (const dir of [
  "apps/web",
  "apps/server",
  "packages/core",
  "packages/rescue",
])
  assert.equal(
    lock.packages[dir].version,
    root.version,
    `${dir} lock mismatch`,
  );
assert.equal(root.private, true);
if (process.env.RELEASE_TAG)
  assert.equal(
    process.env.RELEASE_TAG,
    `v${root.version}`,
    "Tag/version mismatch",
  );
assert.ok(
  (await readFile("CHANGELOG.md", "utf8")).includes(`## [${root.version}]`),
);
assert.ok((await readFile(`docs/releases/v${root.version}.md`, "utf8")).trim());
console.log(`Release contract: v${root.version} OK`);
