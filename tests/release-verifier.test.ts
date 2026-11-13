import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyPublicRelease } from "../scripts/release-verifier.ts";

const tag = "v0.5.3",
  version = "0.5.3",
  prefix = "custodian-0.5.3";
const lockfile = {
  lockfileVersion: 3,
  version,
  packages: {
    "": { version },
    "node_modules/synthetic-package": { version: "1.0.0" },
    "node_modules/shared-runtime": { version: "2.0.0" },
  },
};
const repo = "trillvertual/custodian",
  image = "trillvertual/custodian-app";
const sourceName = `${prefix}-source.tar.gz`,
  runtimeName = `${prefix}-runtime.tar.gz`;
const token = "anonymous-registry-fixture";
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const digest = (bytes: Buffer) => `sha256:${hash(bytes)}`;
let root: string,
  revision: string,
  oldRevision: string,
  source: Buffer,
  oldSource: Buffer;
let sequence = 0;
function git(cwd: string, ...args: string[]) {
  return execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Release Fixture",
      "-c",
      "user.email=fixture@example.test",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "custodian-release-tests-"));
  const repoDir = join(root, "source-repo");
  await mkdir(repoDir);
  git(repoDir, "init", "--object-format=sha1", "--initial-branch=main");
  await writeFile(
    join(repoDir, "package.json"),
    JSON.stringify({ version, private: true }),
  );
  await writeFile(join(repoDir, "LICENSE"), "MIT fixture\n");
  await writeFile(join(repoDir, "package-lock.json"), JSON.stringify(lockfile));
  await writeFile(join(repoDir, "README.md"), "Earlier same-version build\n");
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-m", "Earlier fixture");
  oldRevision = git(repoDir, "rev-parse", "HEAD");
  oldSource = execFileSync(
    "git",
    ["archive", "--format=tar.gz", `--prefix=${prefix}/`, oldRevision],
    { cwd: repoDir },
  );
  await writeFile(
    join(repoDir, "README.md"),
    "Intended same-version build\n" + "x".repeat(256 * 1024),
  );
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-m", "Intended fixture");
  revision = git(repoDir, "rev-parse", "HEAD");
  source = execFileSync(
    "git",
    ["archive", "--format=tar.gz", `--prefix=${prefix}/`, revision],
    { cwd: repoDir },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

interface Scenario {
  source?: Buffer;
  runtimeRevision?: string;
  omitBuildInfo?: boolean;
  metadataRevision?: string;
  wrongChecksum?: boolean;
  duplicateChecksum?: boolean;
  wrongImageDigest?: boolean;
  corruptPlatformManifest?: boolean;
  corruptImageConfig?: boolean;
  wrongLabels?: boolean;
  omitAttestation?: boolean;
  unsafeAssetUrl?: boolean;
  oversizedAsset?: boolean;
  releaseStatus?: number;
  incompleteSbom?: boolean;
  mismatchedRuntimeLock?: boolean;
}
async function setup(options: Scenario = {}) {
  const stage = join(root, `case-${++sequence}`),
    runtime = join(stage, prefix);
  await mkdir(runtime, { recursive: true });
  await writeFile(
    join(runtime, "package.json"),
    JSON.stringify({ version, private: true }),
  );
  await writeFile(join(runtime, "LICENSE"), "MIT fixture\n");
  await writeFile(
    join(runtime, "package-lock.json"),
    JSON.stringify(
      options.mismatchedRuntimeLock
        ? { ...lockfile, version: "0.0.0" }
        : lockfile,
    ),
  );
  if (!options.omitBuildInfo)
    await writeFile(
      join(runtime, "build-info.json"),
      JSON.stringify({
        schema: 1,
        version,
        revision: options.runtimeRevision ?? revision,
      }),
    );
  for (const path of [
    "apps/server/dist/index.js",
    "apps/web/dist/index.html",
    "packages/rescue/dist/index.js",
  ]) {
    await mkdir(join(runtime, path, ".."), { recursive: true });
    await writeFile(join(runtime, path), "synthetic entrypoint\n");
  }
  const runtimeBytes = execFileSync("tar", ["-czf", "-", "-C", stage, prefix]);
  const config = encode({
    os: "linux",
    architecture: "amd64",
    config: {
      Labels: {
        "org.opencontainers.image.revision": options.wrongLabels
          ? oldRevision
          : revision,
        "org.opencontainers.image.version": tag,
        "org.opencontainers.image.source": `https://github.com/${repo}`,
      },
    },
  });
  const configDigest = digest(config);
  const manifest = encode({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { digest: configDigest, size: config.length },
    layers: [],
  });
  const manifestDigest = digest(manifest);
  const platform = {
    digest: manifestDigest,
    size: manifest.length,
    platform: { os: "linux", architecture: "amd64" },
  };
  const attest = {
    digest: `sha256:${"0".repeat(64)}`,
    size: 0,
    platform: { os: "unknown", architecture: "unknown" },
    annotations: { "vnd.docker.reference.type": "attestation-manifest" },
  };
  const index = encode({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: options.omitAttestation ? [platform] : [platform, attest],
  });
  const imageDigest = digest(index);
  const files = new Map<string, Buffer>([
    [sourceName, options.source ?? source],
    [runtimeName, runtimeBytes],
    [
      `${prefix}-sbom.cdx.json`,
      encode({
        bomFormat: "CycloneDX",
        metadata: { component: { "bom-ref": "root", version } },
        components: Object.entries(lockfile.packages)
          .filter(
            ([path]) =>
              path &&
              !(options.incompleteSbom && path.includes("shared-runtime")),
          )
          .map(([path, entry]) => {
            const name = path.slice("node_modules/".length);
            return {
              "bom-ref": name,
              name,
              version: entry.version,
              purl: `pkg:npm/${name}@${entry.version}`,
              scope: "required",
              properties: [{ name: "cdx:npm:package:path", value: path }],
            };
          }),
        dependencies: [
          { ref: "root", dependsOn: ["synthetic-package", "shared-runtime"] },
          { ref: "synthetic-package", dependsOn: [] },
          { ref: "shared-runtime", dependsOn: [] },
        ],
      }),
    ],
    [
      "release.json",
      encode({
        version,
        revision: options.metadataRevision ?? revision,
        image: `ghcr.io/${image}`,
        imageDigest: options.wrongImageDigest
          ? `sha256:${"1".repeat(64)}`
          : imageDigest,
      }),
    ],
  ]);
  const sums = [...files].map(
    ([name, bytes]) =>
      `${options.wrongChecksum && name === sourceName ? "0".repeat(64) : hash(bytes)}  ${name}`,
  );
  if (options.duplicateChecksum) sums[1] = sums[0]!;
  files.set("SHA256SUMS", Buffer.from(sums.join("\n") + "\n"));
  const assets = [...files].map(([name, bytes]) => ({
    name,
    size:
      options.oversizedAsset && name === sourceName
        ? 129 * 1024 * 1024
        : bytes.length,
    browser_download_url:
      options.unsafeAssetUrl && name === sourceName
        ? "https://example.invalid/other.tar.gz"
        : `https://github.com/${repo}/releases/download/${tag}/${name}`,
  }));
  const release = { tag_name: tag, draft: false, prerelease: false, assets };
  const fetcher = vi.fn(async (input: unknown, init?: RequestInit) => {
    expect(typeof input).toBe("string");
    const url = String(input),
      headers = new Headers(init?.headers);
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (
      url.startsWith("https://api.github.com/") ||
      url.startsWith("https://github.com/")
    ) {
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("cookie")).toBe(false);
      if (url === `https://api.github.com/repos/${repo}/releases/tags/${tag}`)
        return json(release, options.releaseStatus ?? 200);
      if (url === `https://api.github.com/repos/${repo}/releases/latest`)
        return json(release);
      for (const [name, bytes] of files)
        if (
          url === `https://github.com/${repo}/releases/download/${tag}/${name}`
        )
          return new Response(new Uint8Array(bytes));
    }
    if (
      url ===
      `https://ghcr.io/token?service=ghcr.io&scope=repository:${image}:pull`
    ) {
      expect(headers.has("authorization")).toBe(false);
      return json({ token });
    }
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    if (url === `https://ghcr.io/v2/${image}/manifests/${tag}`)
      return new Response(new Uint8Array(index), {
        headers: { "docker-content-digest": imageDigest },
      });
    if (url === `https://ghcr.io/v2/${image}/manifests/${manifestDigest}`)
      return new Response(
        new Uint8Array(
          options.corruptPlatformManifest
            ? Buffer.concat([manifest, Buffer.from(" ")])
            : manifest,
        ),
      );
    if (url === `https://ghcr.io/v2/${image}/blobs/${configDigest}`)
      return new Response(
        new Uint8Array(
          options.corruptImageConfig
            ? Buffer.concat([config, Buffer.from(" ")])
            : config,
        ),
      );
    throw new Error("Unexpected mocked network request");
  });
  vi.stubGlobal("fetch", fetcher);
  const output = join(stage, "downloads");
  return {
    output,
    files,
    fetcher,
    verify: () => verifyPublicRelease({ tag, revision, output, latest: true }),
  };
}

describe("public release verifier", () => {
  it("accepts a complete release with source/runtime revisions and never sends account credentials", async () => {
    vi.stubEnv("GH_TOKEN", "synthetic-account-credential");
    vi.stubEnv("SNYK_TOKEN", "synthetic-scan-credential");
    const test = await setup();
    const report = await test.verify();
    expect(report).toMatchObject({
      version,
      revision,
      assets: 5,
      verifiedChecksums: 4,
      platform: "linux/amd64",
      anonymous: true,
      archiveRevisions: { source: revision, runtime: revision },
      sbomComponents: 2,
      sbomInstallations: 2,
    });
    expect(JSON.stringify(report)).not.toContain(token);
    expect((await readdir(test.output)).sort()).toEqual(
      [...test.files.keys()].sort(),
    );
    for (const [name, bytes] of test.files)
      expect(await readFile(join(test.output, name))).toEqual(bytes);
  });

  it.each([
    ["wrong checksum", { wrongChecksum: true }, /checksum mismatch/],
    ["duplicated checksum", { duplicateChecksum: true }, /duplicated checksum/],
    [
      "wrong release revision",
      { metadataRevision: "0".repeat(40) },
      /Release version or revision mismatch/,
    ],
    [
      "earlier same-version source",
      "old-source",
      /Source archive Git revision mismatch/,
    ],
    [
      "source without Git marker",
      "no-git-marker",
      /Source archive Git revision mismatch/,
    ],
    [
      "earlier same-version runtime",
      "old-runtime",
      /Runtime archive revision mismatch/,
    ],
    [
      "runtime without revision evidence",
      { omitBuildInfo: true },
      /missing build-info/,
    ],
    [
      "wrong image digest",
      { wrongImageDigest: true },
      /Published image digest mismatch/,
    ],
    [
      "wrong platform manifest bytes",
      { corruptPlatformManifest: true },
      /Platform manifest digest mismatch/,
    ],
    [
      "wrong image configuration bytes",
      { corruptImageConfig: true },
      /Image configuration digest mismatch/,
    ],
    [
      "wrong image revision label",
      { wrongLabels: true },
      /Image labels do not match/,
    ],
    [
      "missing attestation",
      { omitAttestation: true },
      /Missing image attestation/,
    ],
    [
      "unexpected asset URL",
      { unsafeAssetUrl: true },
      /Unexpected release download/,
    ],
    [
      "oversized asset metadata",
      { oversizedAsset: true },
      /unexpectedly large/,
    ],
    ["unavailable release", { releaseStatus: 404 }, /HTTP 404/],
    [
      "incomplete production SBOM",
      { incompleteSbom: true },
      /Missing production SBOM installation/,
    ],
    [
      "mismatched archive lockfiles",
      { mismatchedRuntimeLock: true },
      /Source\/runtime lockfile mismatch/,
    ],
  ] as const)(
    "rejects %s without persisting any downloaded file",
    async (_name, scenario, error) => {
      let options: Scenario;
      if (scenario === "old-source") options = { source: oldSource };
      else if (scenario === "old-runtime")
        options = { runtimeRevision: oldRevision };
      else if (scenario === "no-git-marker") {
        // A normal tar with matching manifest/version is not a Git source archive.
        const dir = join(root, `plain-source-${++sequence}`, prefix);
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, "package.json"),
          JSON.stringify({ version, private: true }),
        );
        await writeFile(join(dir, "LICENSE"), "MIT fixture\n");
        options = {
          source: execFileSync("tar", [
            "-czf",
            "-",
            "-C",
            join(dir, ".."),
            prefix,
          ]),
        };
      } else options = scenario;
      const test = await setup(options);
      await expect(test.verify()).rejects.toThrow(error);
      expect(await readdir(test.output)).toEqual([]);
    },
  );

  it("refuses a nonempty output directory before accessing the network", async () => {
    const test = await setup();
    await mkdir(test.output);
    await writeFile(join(test.output, "keep.txt"), "existing content");
    await expect(test.verify()).rejects.toThrow(
      /nonempty verification directory/,
    );
    expect(test.fetcher).not.toHaveBeenCalled();
    expect(await readFile(join(test.output, "keep.txt"), "utf8")).toBe(
      "existing content",
    );
  });
});
