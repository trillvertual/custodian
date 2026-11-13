import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { verifyProductionSbom } from "./production-sbom.ts";

export interface VerifyReleaseOptions {
  tag: string;
  revision: string;
  output?: string;
  latest?: boolean;
}
const repo = "trillvertual/custodian";
const image = "trillvertual/custodian-app";
const imageName = `ghcr.io/${image}`;
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
function archiveJson(bytes: Buffer, path: string): unknown {
  return JSON.parse(
    execFileSync("tar", ["-xzOf", "-", path], {
      input: bytes,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
}
export function verifyReleaseArchive(
  bytes: Buffer,
  kind: "source" | "runtime",
  version: string,
  revision: string,
) {
  const prefix = `custodian-${version}`;
  const entries = execFileSync("tar", ["-tzf", "-"], {
    input: bytes,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
    stdio: ["pipe", "pipe", "pipe"],
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
    execFileSync("tar", ["-xzOf", "-", `${prefix}/package.json`], {
      input: bytes,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
  assert.ok(
    object(manifest).version === version && object(manifest).private === true,
    "Archive manifest mismatch",
  );
  if (kind === "source") {
    const marker = spawnSync("git", ["get-tar-commit-id"], {
      // git reads only the first two tar records and closes stdin. Sending the
      // whole archive can produce EPIPE for larger releases after a valid result.
      input: gunzipSync(bytes, {
        maxOutputLength: 256 * 1024 * 1024,
      }).subarray(0, 1024),
      encoding: "utf8",
      maxBuffer: 1024,
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    assert.ok(
      marker.status === 0 && marker.stdout.trim() === revision,
      "Source archive Git revision mismatch",
    );
  } else {
    assert.ok(
      entries.includes(`${prefix}/build-info.json`),
      "Runtime archive is missing build-info.json",
    );
    const info: unknown = JSON.parse(
      execFileSync("tar", ["-xzOf", "-", `${prefix}/build-info.json`], {
        input: bytes,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    const build = object(info);
    assert.ok(
      build.schema === 1 &&
        build.version === version &&
        build.revision === revision,
      "Runtime archive revision mismatch",
    );
    for (const entry of [
      "apps/server/dist/index.js",
      "apps/web/dist/index.html",
      "packages/rescue/dist/index.js",
    ])
      assert.ok(
        entries.includes(`${prefix}/${entry}`),
        "Runtime archive is missing a compiled entrypoint",
      );
  }
}

export async function verifyPublicRelease(options: VerifyReleaseOptions) {
  const { tag, revision } = options;
  assert.match(tag, /^v\d+\.\d+\.\d+$/);
  assert.match(revision, /^[a-f0-9]{40}$/);
  const version = tag.slice(1);
  const prefix = `custodian-${version}`;
  const expected = [
    `${prefix}-source.tar.gz`,
    `${prefix}-runtime.tar.gz`,
    `${prefix}-sbom.cdx.json`,
    "release.json",
    "SHA256SUMS",
  ];
  const output = options.output
    ? resolve(options.output)
    : await mkdtemp(join(tmpdir(), `custodian-public-${version}-`));
  await mkdir(output, { recursive: true, mode: 0o700 });
  assert.equal(
    (await readdir(output)).length,
    0,
    "Refusing to overwrite a nonempty verification directory",
  );
  const release = await json(
    `https://api.github.com/repos/${repo}/releases/tags/${tag}`,
  );
  if (options.latest) {
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
  for (const kind of ["source", "runtime"] as const)
    verifyReleaseArchive(
      file(`${prefix}-${kind}.tar.gz`),
      kind,
      version,
      revision,
    );
  const sbom = parse(file(`${prefix}-sbom.cdx.json`));
  const sourceLock = archiveJson(
    file(`${prefix}-source.tar.gz`),
    `${prefix}/package-lock.json`,
  );
  const runtimeLock = archiveJson(
    file(`${prefix}-runtime.tar.gz`),
    `${prefix}/package-lock.json`,
  );
  assert.deepEqual(runtimeLock, sourceLock, "Source/runtime lockfile mismatch");
  const inventory = verifyProductionSbom(sbom, sourceLock);
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
      labels["org.opencontainers.image.source"] ===
        `https://github.com/${repo}`,
    "Image labels do not match the release",
  );
  // These are intentional network-to-file writes to an operator-selected empty
  // directory. Names, hashes, both embedded archive revisions and OCI consistency
  // have been checked. No downloaded code is executed, and writes are exclusive.
  for (const name of expected)
    await writeFile(join(output, name), file(name), {
      mode: 0o600,
      flag: "wx",
    });
  return {
    release: `https://github.com/${repo}/releases/tag/${tag}`,
    version,
    revision,
    assets: files.size,
    verifiedChecksums: checked.size,
    imageDigest,
    platform: "linux/amd64",
    attestation: true,
    archiveRevisions: { source: revision, runtime: revision },
    sbomComponents: inventory.components,
    sbomInstallations: inventory.installations,
    anonymous: true,
    output,
  };
}
