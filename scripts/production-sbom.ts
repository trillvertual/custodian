import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";

function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected SBOM object",
  );
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), "Expected SBOM array");
  return value;
}
function text(value: unknown): string {
  assert.ok(typeof value === "string", "Expected SBOM string");
  return value;
}
function normalizePath(value: unknown) {
  const path = text(value).replaceAll("\\", "/").replace(/^\.\//, "");
  assert.ok(
    !isAbsolute(path) &&
      !/^[A-Za-z]:/.test(path) &&
      !path.split("/").includes(".."),
    "Unsafe SBOM installation path",
  );
  return path;
}
function locations(component: Record<string, unknown>) {
  const paths = list(component.properties)
    .map(record)
    .filter((p) => p.name === "cdx:npm:package:path")
    .map((p) => normalizePath(p.value));
  assert.ok(paths.length > 0, "SBOM component has no installation path");
  return paths;
}

// The lockfile is an independent inventory, including packages which npm's
// omit=dev SBOM incorrectly drops. Optional platform packages may be absent.
export function verifyProductionSbom(document: unknown, lockfile: unknown) {
  const bom = record(document),
    lock = record(lockfile);
  assert.equal(bom.bomFormat, "CycloneDX", "Expected CycloneDX SBOM");
  assert.equal(lock.lockfileVersion, 3, "Expected npm lockfile v3");
  const packages = record(lock.packages);
  const root = record(record(bom.metadata).component),
    rootRef = text(root["bom-ref"]);
  assert.equal(root.version, lock.version, "SBOM root version mismatch");
  const refs = new Set([rootRef]),
    covered = new Set<string>();
  const components = list(bom.components).map(record);
  assert.ok(components.length > 0, "Production SBOM is empty");
  for (const component of components) {
    const ref = text(component["bom-ref"]);
    assert.ok(
      ref.length > 0 && !refs.has(ref),
      "Duplicate or empty SBOM reference",
    );
    refs.add(ref);
    assert.equal(
      component.scope,
      "required",
      "Unexpected production SBOM scope",
    );
    for (const path of locations(component)) {
      assert.ok(
        path && !covered.has(path),
        "Duplicate or empty SBOM installation path",
      );
      const entry = record(packages[path]);
      assert.ok(!entry.dev && !entry.link, "Non-production package in SBOM");
      assert.equal(
        component.version,
        entry.version,
        `SBOM version mismatch: ${path}`,
      );
      assert.equal(
        decodeURIComponent(text(component.purl)),
        `pkg:npm/${text(entry.name ?? path.split("node_modules/").at(-1))}@${text(entry.version)}`,
        `SBOM package identity mismatch: ${path}`,
      );
      covered.add(path);
    }
  }
  for (const [path, value] of Object.entries(packages)) {
    const entry = record(value);
    if (path && !entry.dev && !entry.link && !entry.optional)
      assert.ok(
        covered.has(path),
        `Missing production SBOM installation: ${path}`,
      );
  }
  const graph = new Map<string, string[]>();
  for (const node of list(bom.dependencies).map(record)) {
    const ref = text(node.ref),
      children = list(node.dependsOn).map(text);
    assert.ok(
      refs.has(ref) && !graph.has(ref),
      "Unknown or duplicate SBOM graph reference",
    );
    assert.ok(
      children.every((child) => refs.has(child)),
      "Dangling SBOM dependency",
    );
    assert.equal(
      new Set(children).size,
      children.length,
      "Duplicate SBOM dependency",
    );
    graph.set(ref, children);
  }
  for (const ref of refs)
    assert.ok(graph.has(ref), "Missing SBOM dependency graph node");
  const reachable = new Set<string>(),
    pending = [rootRef];
  while (pending.length) {
    const ref = pending.pop()!;
    if (reachable.has(ref)) continue;
    reachable.add(ref);
    pending.push(...graph.get(ref)!);
  }
  assert.equal(
    reachable.size,
    refs.size,
    "Unreachable production SBOM component",
  );
  return { components: components.length, installations: covered.size };
}

// npm sbom --omit=dev can drop a shared production package when it is also a
// direct root devDependency. Select by the independent production reachability
// inventory instead, retaining npm's licenses, hashes and dependency metadata.
export function selectProductionSbom(
  document: unknown,
  productionPaths: ReadonlySet<string>,
) {
  const bom = record(document);
  assert.ok(bom.bomFormat === "CycloneDX", "Expected CycloneDX SBOM");
  const root = record(record(bom.metadata).component),
    rootRef = text(root["bom-ref"]);
  const wanted = new Set(
    [...productionPaths].filter((path) => path !== "" && path !== "."),
  );
  const covered = new Set<string>(),
    selected = new Map<string, Record<string, unknown>>();
  for (const component of list(bom.components).map(record)) {
    const [path] = locations(component);
    assert.ok(path !== undefined);
    if (!wanted.has(path)) continue;
    covered.add(path);
    const ref = text(component["bom-ref"]),
      previous = selected.get(ref);
    if (!previous) {
      selected.set(ref, { ...component, scope: "required" });
      continue;
    }
    assert.ok(
      previous.name === component.name &&
        previous.purl === component.purl &&
        previous.version === component.version,
      "Conflicting SBOM identity",
    );
    assert.deepEqual(
      previous.hashes ?? [],
      component.hashes ?? [],
      "Conflicting SBOM package hashes",
    );
    const properties = [
      ...list(previous.properties),
      ...list(component.properties),
    ].map(record);
    const unique = new Map(
      properties.map((p) => [JSON.stringify([p.name, p.value]), p]),
    );
    previous.properties = [...unique.values()];
  }
  for (const path of wanted)
    assert.ok(
      covered.has(path),
      `Missing production SBOM installation: ${path}`,
    );
  assert.ok(selected.size > 0, "Production SBOM is empty");
  const refs = new Set([rootRef, ...selected.keys()]);
  const graph = new Map<string, Set<string>>();
  for (const node of list(bom.dependencies).map(record)) {
    const ref = text(node.ref);
    if (!refs.has(ref)) continue;
    const children = graph.get(ref) ?? new Set<string>();
    for (const child of list(node.dependsOn).map(text))
      if (refs.has(child)) children.add(child);
    graph.set(ref, children);
  }
  assert.ok(graph.has(rootRef), "SBOM has no root dependency graph");
  return {
    ...bom,
    components: [...selected.values()],
    dependencies: [...graph].map(([ref, children]) => ({
      ref,
      dependsOn: [...children],
    })),
  };
}

export async function createProductionSbom() {
  const full: unknown = JSON.parse(
    execFileSync("npm", ["sbom", "--sbom-format=cyclonedx"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
  const root = await realpath(process.cwd());
  const paths = execFileSync(
    "npm",
    ["ls", "--omit=dev", "--all", "--parseable"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  )
    .trim()
    .split("\n");
  const production = new Set(
    await Promise.all(
      paths.map(async (path) => {
        const normalized = relative(root, await realpath(path)).replaceAll(
          "\\",
          "/",
        );
        assert.ok(
          !isAbsolute(normalized) && !normalized.split("/").includes(".."),
          "Production dependency is outside the checkout",
        );
        return normalized;
      }),
    ),
  );
  const result = selectProductionSbom(full, production);
  const lockfile: unknown = JSON.parse(
    await readFile("package-lock.json", "utf8"),
  );
  verifyProductionSbom(result, lockfile);
  return result;
}
