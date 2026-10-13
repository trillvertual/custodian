import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import "./release-check.ts";

const { version } = JSON.parse(await readFile("package.json", "utf8"));
const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();
if (git("status", "--porcelain", "--untracked-files=no"))
  throw new Error("Commit tracked changes before packaging a release.");
const revision = git("rev-parse", "HEAD");
if (
  process.env.RELEASE_TAG &&
  git("rev-list", "-n", "1", process.env.RELEASE_TAG) !== revision
)
  throw new Error("Release tag does not point to HEAD.");
const out = resolve("dist/release");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const prefix = `custodian-${version}`;
const staging = await mkdtemp(join(tmpdir(), "custodian-release-"));
try {
  execFileSync("git", [
    "archive",
    "--format=tar.gz",
    `--prefix=${prefix}/`,
    "-o",
    join(out, `${prefix}-source.tar.gz`),
    revision,
  ]);
  const runtime = join(staging, prefix);
  await mkdir(runtime);
  for (const path of [
    "package.json",
    "package-lock.json",
    ".env.example",
    "compose.yaml",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "SECURITY.md",
    "THIRD_PARTY_NOTICES.md",
    "docs",
    "apps/server/package.json",
    "apps/web/package.json",
    "packages/core/package.json",
    "packages/rescue/package.json",
    "packages/core/src",
    "apps/server/dist",
    "apps/web/dist",
    "packages/rescue/dist",
  ]) {
    await mkdir(resolve(runtime, path, ".."), { recursive: true });
    await cp(path, join(runtime, path), { recursive: true });
  }
  execFileSync("tar", [
    "-czf",
    join(out, `${prefix}-runtime.tar.gz`),
    "-C",
    staging,
    prefix,
  ]);
  const sbom = execFileSync(
    "npm",
    ["sbom", "--omit=dev", "--sbom-format=cyclonedx"],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  JSON.parse(sbom.toString());
  await writeFile(join(out, `${prefix}-sbom.cdx.json`), sbom);
  await writeFile(
    join(out, "release.json"),
    JSON.stringify(
      {
        version,
        revision,
        node: process.version,
        runtime: "Node.js >=22.12.0",
        image: process.env.RELEASE_IMAGE ?? null,
        imageDigest: process.env.RELEASE_IMAGE_DIGEST ?? null,
      },
      null,
      2,
    ) + "\n",
  );
  const files = (await readdir(out)).sort();
  const hashes = await Promise.all(
    files.map(
      async (file) =>
        `${createHash("sha256")
          .update(await readFile(join(out, file)))
          .digest("hex")}  ${file}`,
    ),
  );
  await writeFile(join(out, "SHA256SUMS"), hashes.join("\n") + "\n");
  console.log(`Packaged ${prefix}: ${files.length} assets + SHA256SUMS`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
