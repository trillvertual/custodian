import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    tag: { type: "string" },
    revision: { type: "string" },
    output: { type: "string" },
    latest: { type: "boolean", default: false },
  },
});
const tag = values.tag ?? "";
const revision = values.revision ?? "";
assert.match(tag, /^v\d+\.\d+\.\d+$/);
assert.match(revision, /^[a-f0-9]{40}$/);
const version = tag.slice(1);
const repo = "trillvertual/custodian";
const image = "trillvertual/custodian-app";
const imageName = `ghcr.io/${image}`;
const prefix = `custodian-${version}`;
const expected = [
  `${prefix}-source.tar.gz`,
  `${prefix}-runtime.tar.gz`,
  `${prefix}-sbom.cdx.json`,
  "release.json",
  "SHA256SUMS",
];
const maxAssetSize = 128 * 1024 * 1024;
function object(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected a JSON object",
  );
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), "Expected a JSON array");
  return value;
}
function string(value: unknown): string {
  assert.ok(typeof value === "string", "Expected a JSON string");
  return value;
}
function number(value: unknown): number {
  assert.ok(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    "Expected a nonnegative integer",
  );
  return value;
}
function sha(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
async function get(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    headers: { "User-Agent": "custodian-release-verifier", ...headers },
    signal: AbortSignal.timeout(60_000),
  });
  assert.ok(
    response.ok,
    `Anonymous request failed: HTTP ${response.status} at ${new URL(url).origin}${new URL(url).pathname}`,
  );
  return response;
}
async function json(
  url: string,
  headers?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await get(url, headers);
  const value: unknown = await response.json();
  return object(value);
}
function parse(bytes: Uint8Array): Record<string, unknown> {
  const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  return object(value);
}
function digest(value: unknown): string {
  const result = string(value);
  assert.match(result, /^sha256:[a-f0-9]{64}$/);
  return result;
}
const release = await json(
  `https://api.github.com/repos/${repo}/releases/tags/${tag}`,
);
if (values.latest) {
  const latest = await json(
    `https://api.github.com/repos/${repo}/releases/latest`,
  );
  assert.ok(latest.tag_name === tag, "Release is not marked latest");
}
assert.ok(
  release.tag_name === tag &&
    release.draft === false &&
    release.prerelease === false,
  "Release must be public and stable",
);
const assets = array(release.assets).map(object);
assert.deepEqual(
  assets.map((asset) => string(asset.name)).sort(),
  [...expected].sort(),
);
const output = values.output
  ? resolve(values.output)
  : await mkdtemp(join(tmpdir(), `custodian-public-${version}-`));
await mkdir(output, { recursive: true, mode: 0o700 });
assert.equal(
  (await readdir(output)).length,
  0,
  "Refusing to overwrite a nonempty verification directory",
);
const files = new Map<string, Buffer>();
for (const name of expected) {
  const asset = assets.find((candidate) => candidate.name === name);
  assert.ok(asset, "Missing release asset metadata");
  const size = number(asset.size);
  assert.ok(size <= maxAssetSize, "Release asset is unexpectedly large");
  const url = `https://github.com/${repo}/releases/download/${tag}/${name}`;
  assert.ok(
    asset.browser_download_url === url,
    "Unexpected release download origin or path",
  );
  const bytes = Buffer.from(await (await get(url)).arrayBuffer());
  assert.equal(bytes.length, size, "Release asset size mismatch");
  files.set(name, bytes);
}
function file(name: string): Buffer {
  const bytes = files.get(name);
  assert.ok(bytes, "Missing release asset");
  return bytes;
}
const sums = file("SHA256SUMS").toString("utf8").trim().split("\n");
assert.equal(sums.length, 4);
const checked = new Set<string>();
for (const line of sums) {
  const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9.-]+)$/.exec(line);
  assert.ok(match, "Invalid checksum line");
  const hash = string(match[1]),
    name = string(match[2]);
  assert.ok(
    name !== "SHA256SUMS" && !checked.has(name),
    "Invalid or duplicated checksum filename",
  );
  assert.ok(sha(file(name)) === hash, "Release checksum mismatch");
  checked.add(name);
}
assert.deepEqual(
  [...checked].sort(),
  expected.filter((name) => name !== "SHA256SUMS").sort(),
);
const metadata = parse(file("release.json"));
assert.ok(
  metadata.version === version && metadata.revision === revision,
  "Release version or revision mismatch",
);
assert.ok(metadata.image === imageName, "Unexpected image repository");
const imageDigest = digest(metadata.imageDigest);
// Persist only the expected names after integrity and revision checks. A failed
// verification never leaves an unverified archive in the destination directory.
for (const name of expected)
  await writeFile(join(output, name), file(name), { mode: 0o600, flag: "wx" });
for (const kind of ["source", "runtime"]) {
  const path = join(output, `${prefix}-${kind}.tar.gz`);
  const entries = execFileSync("tar", ["-tzf", path], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .trim()
    .split("\n");
  assert.ok(
    entries.includes(`${prefix}/LICENSE`),
    "Archive is missing LICENSE",
  );
  for (const entry of entries) {
    assert.ok(
      entry.startsWith(`${prefix}/`) &&
        !entry
          .split("/")
          .some((part) => ["..", ".git", "node_modules"].includes(part)),
      "Unsafe archive path",
    );
  }
  const manifest: unknown = JSON.parse(
    execFileSync("tar", ["-xOf", path, `${prefix}/package.json`], {
      encoding: "utf8",
    }),
  );
  assert.ok(
    object(manifest).version === version && object(manifest).private === true,
    "Archive manifest mismatch",
  );
}
const sbom = parse(file(`${prefix}-sbom.cdx.json`));
assert.ok(sbom.bomFormat === "CycloneDX", "Expected a CycloneDX SBOM");
const sbomComponents = array(sbom.components).length;
assert.ok(sbomComponents > 0, "Empty SBOM");
// This short-lived registry token grants anonymous access only to the public
// package. It is held in memory and never written to the verification report.
const token = string(
  (
    await json(
      `https://ghcr.io/token?service=ghcr.io&scope=repository:${image}:pull`,
    )
  ).token,
);
const auth = {
  Authorization: `Bearer ${token}`,
  Accept:
    "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
};
const indexResponse = await get(
  `https://ghcr.io/v2/${image}/manifests/${tag}`,
  auth,
);
const indexBytes = Buffer.from(await indexResponse.arrayBuffer());
assert.ok(
  `sha256:${sha(indexBytes)}` === imageDigest &&
    indexResponse.headers.get("docker-content-digest") === imageDigest,
  "Published image digest mismatch",
);
const index = parse(indexBytes);
const manifests = array(index.manifests).map(object);
const platform = manifests.filter((manifest) => {
  const p = object(manifest.platform);
  return p.os === "linux" && p.architecture === "amd64";
});
assert.equal(platform.length, 1, "Expected one linux/amd64 image");
assert.ok(
  manifests.some(
    (manifest) =>
      object(manifest.annotations ?? {})["vnd.docker.reference.type"] ===
      "attestation-manifest",
  ),
  "Missing image attestation",
);
const manifestDigest = digest(platform[0]!.digest);
const manifestBytes = Buffer.from(
  await (
    await get(`https://ghcr.io/v2/${image}/manifests/${manifestDigest}`, auth)
  ).arrayBuffer(),
);
assert.ok(
  `sha256:${sha(manifestBytes)}` === manifestDigest,
  "Platform manifest digest mismatch",
);
const manifest = parse(manifestBytes),
  configDigest = digest(object(manifest.config).digest);
const configBytes = Buffer.from(
  await (
    await get(`https://ghcr.io/v2/${image}/blobs/${configDigest}`, auth)
  ).arrayBuffer(),
);
assert.ok(
  `sha256:${sha(configBytes)}` === configDigest,
  "Image configuration digest mismatch",
);
const config = parse(configBytes),
  labels = object(object(config.config).Labels);
assert.ok(
  config.os === "linux" && config.architecture === "amd64",
  "Unexpected image platform",
);
assert.ok(
  labels["org.opencontainers.image.revision"] === revision &&
    labels["org.opencontainers.image.version"] === tag &&
    labels["org.opencontainers.image.source"] === `https://github.com/${repo}`,
  "Image labels do not match the release",
);
console.log(
  JSON.stringify(
    {
      release: `https://github.com/${repo}/releases/tag/${tag}`,
      version,
      revision,
      assets: files.size,
      verifiedChecksums: checked.size,
      imageDigest,
      platform: "linux/amd64",
      attestation: true,
      sbomComponents,
      anonymous: true,
      output,
    },
    null,
    2,
  ),
);
