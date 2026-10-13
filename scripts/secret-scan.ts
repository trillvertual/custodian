import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Official v8.30.1 Linux x64 release archive, verified against its checksum file.
const version = "8.30.1";
const archiveHash =
  "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(root, ".gitleaks.toml");
const scratch = mkdtempSync(join(tmpdir(), "custodian-secret-scan-"));
const { values } = parseArgs({
  options: {
    path: { type: "string", multiple: true },
    "artifacts-only": { type: "boolean", default: false },
  },
});
type Finding = {
  RuleID: string;
  File: string;
  StartLine: number;
  Commit?: string;
};
type Summary = {
  scope: string;
  files?: number;
  commits?: number;
  findings: {
    rule: string;
    file: string;
    line: number;
    commit?: string;
  }[];
};

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

// Inspect names before copying or reading. Local ignored .env is never opened.
function forbiddenPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    normalized
      .split("/")
      .some(
        (part) =>
          (part === ".env" || part.startsWith(".env.")) &&
          part !== ".env.example",
      ) ||
    /(^|\/)(?:id_rsa|id_ed25519|credentials\.json|service[-_]account\.json|[^/]+\.(?:pem|p12|pfx|key))$/i.test(
      normalized,
    )
  );
}

async function binary(): Promise<string> {
  const supplied = process.env.GITLEAKS_BINARY;
  if (supplied) return supplied;
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error(
      `Set GITLEAKS_BINARY to an installed Gitleaks ${version} executable on this platform.`,
    );
  const response = await fetch(
    `https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_linux_x64.tar.gz`,
    { signal: AbortSignal.timeout(60000) },
  );
  if (!response.ok)
    throw new Error(`Gitleaks download failed with HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== archiveHash)
    throw new Error(
      "Gitleaks archive SHA-256 does not match the pinned release.",
    );
  const archive = join(scratch, "gitleaks.tar.gz");
  writeFileSync(archive, bytes, { mode: 0o600 });
  execFileSync("tar", ["-xzf", archive, "-C", scratch, "gitleaks"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return join(scratch, "gitleaks");
}

function scan(executable: string, scope: string, args: string[]): Summary {
  const report = join(
    scratch,
    `report-${scope.replaceAll(/[^a-z0-9]/gi, "-")}.json`,
  );
  const result = spawnSync(
    executable,
    [
      ...args,
      `--config=${configPath}`,
      `--gitleaks-ignore-path=${scratch}`,
      "--ignore-gitleaks-allow",
      "--redact=100",
      "--no-banner",
      "--no-color",
      "--log-level=error",
      "--max-archive-depth=3",
      "--max-decode-depth=5",
      "--timeout=300",
      "--report-format=json",
      `--report-path=${report}`,
    ],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  // Never forward scanner stdout/stderr, a matched value, or a source line.
  if (![0, 1].includes(result.status ?? -1) || !existsSync(report))
    throw new Error(
      `Secret scanner failed in ${scope}; no source output was printed.`,
    );
  const findings = JSON.parse(readFileSync(report, "utf8")) as Finding[];
  if ((result.status === 0) !== (findings.length === 0))
    throw new Error(
      `Secret scanner returned an inconsistent result in ${scope}.`,
    );
  return {
    scope,
    findings: findings.map((f) => ({
      rule: f.RuleID,
      file: f.File.replace(`${scratch}/working/`, ""),
      line: f.StartLine,
      ...(f.Commit ? { commit: f.Commit } : {}),
    })),
  };
}

function inspectDirectory(path: string): number {
  let files = 0;
  for (const item of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, item.name);
    if (forbiddenPath(child))
      throw new Error(`Forbidden publication file: ${child}`);
    if (item.isSymbolicLink())
      throw new Error(`Publication scan rejects symlinks: ${child}`);
    if (item.isDirectory()) files += inspectDirectory(child);
    else if (item.isFile()) {
      inspectArchive(child);
      files++;
    }
  }
  return files;
}

function inspectArchive(path: string): void {
  if (!path.endsWith(".tar.gz")) return;
  // Listing reads the archive only; extraction never touches the host filesystem.
  const entries = execFileSync("tar", ["-tzf", path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);
  for (const entry of entries) {
    const parts = entry.split("/");
    if (
      entry.startsWith("/") ||
      parts.includes("..") ||
      parts.includes(".git") ||
      parts.includes("node_modules") ||
      forbiddenPath(entry)
    )
      throw new Error(`Forbidden release archive entry: ${entry}`);
  }
}

try {
  if (values["artifacts-only"] && !values.path?.length)
    throw new Error("--artifacts-only requires at least one --path.");
  const executable = await binary();
  const actual = execFileSync(executable, ["version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (actual !== version)
    throw new Error(
      `Gitleaks ${version} is required; received a different version.`,
    );
  const summaries: Summary[] = [];
  if (!values["artifacts-only"]) {
    const files = [
      ...new Set(
        git("ls-files", "--cached", "--others", "--exclude-standard", "-z")
          .split("\0")
          .filter(Boolean),
      ),
    ];
    for (const file of files) {
      if (forbiddenPath(file))
        throw new Error(`Forbidden publication file: ${file}`);
      const source = join(root, file);
      if (!lstatSync(source).isFile())
        throw new Error(`Publication scan rejects non-regular files: ${file}`);
      const target = join(scratch, "working", file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
    const working = scan(executable, "working-tree", [
      "dir",
      join(scratch, "working"),
    ]);
    working.files = files.length;
    summaries.push(working);
    const historyPaths = git("rev-list", "--objects", "--all")
      .split("\n")
      .map((line) => line.slice(line.indexOf(" ") + 1));
    for (const file of historyPaths)
      if (forbiddenPath(file))
        throw new Error(`Forbidden publication file in Git history: ${file}`);
    const history = scan(executable, "all-git-refs", [
      "git",
      "--log-opts=--all --full-history -m",
      root,
    ]);
    history.commits = Number(git("rev-list", "--count", "--all").trim());
    summaries.push(history);
  }
  for (const [index, supplied] of (values.path ?? []).entries()) {
    const path = resolve(supplied);
    if (forbiddenPath(path))
      throw new Error(`Forbidden publication file: ${path}`);
    const info = lstatSync(path);
    if (info.isSymbolicLink())
      throw new Error(`Publication scan rejects symlinks: ${path}`);
    const files = info.isDirectory() ? inspectDirectory(path) : 1;
    if (info.isFile()) inspectArchive(path);
    const summary = scan(executable, `artifact-${index + 1}`, ["dir", path]);
    summary.files = files;
    summaries.push(summary);
  }
  const findings = summaries.reduce(
    (count, summary) => count + summary.findings.length,
    0,
  );
  process.stdout.write(
    JSON.stringify(
      { scanner: `gitleaks ${version}`, findings, scopes: summaries },
      null,
      2,
    ) + "\n",
  );
  if (findings) process.exitCode = 1;
} catch (error) {
  // Command failures may include captured secret-bearing output; expose no details.
  const safe =
    error instanceof Error && !("stdout" in error) && !("stderr" in error)
      ? error.message
      : "Secret scanner failed; no captured source output was printed.";
  process.stderr.write(`Publication check failed: ${safe}\n`);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
