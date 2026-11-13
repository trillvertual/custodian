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
  productionGraph: ReadonlyMap<string, ReadonlySet<string>>,
) {
  const bom = record(document);
  assert.ok(bom.bomFormat === "CycloneDX", "Expected CycloneDX SBOM");
  const root = record(record(bom.metadata).component),
    rootRef = text(root["bom-ref"]);
  const wanted = new Set(
    [...productionGraph.keys()].filter((path) => path !== "" && path !== "."),
  );
  const covered = new Set<string>(),
    selected = new Map<string, Record<string, unknown>>();
  const refsByPath = new Map([["", rootRef]]);
  for (const component of list(bom.components).map(record)) {
    const [path] = locations(component);
    assert.ok(path !== undefined);
    if (!wanted.has(path)) continue;
    covered.add(path);
    const ref = text(component["bom-ref"]),
      previous = selected.get(ref);
    refsByPath.set(path, ref);
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
    const previousLicenses = list(previous.licenses ?? []),
      licenses = list(component.licenses ?? []);
    if (previousLicenses.length && licenses.length)
      assert.deepEqual(
        previousLicenses,
        licenses,
        "Conflicting SBOM package licenses",
      );
    else if (licenses.length) previous.licenses = licenses;
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
  const graph = new Map<string, Set<string>>();
  // Full npm SBOM edges include dev-only relationships between otherwise
  // production packages. Rebuild edges from the independent production tree.
  for (const [path, dependencies] of productionGraph) {
    const ref = refsByPath.get(path);
    assert.ok(ref, `Missing production SBOM graph parent: ${path}`);
    const children = graph.get(ref) ?? new Set<string>();
    for (const dependency of dependencies) {
      const child = refsByPath.get(dependency);
      assert.ok(child, `Missing production SBOM graph child: ${dependency}`);
      children.add(child);
    }
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
  const tree: unknown = JSON.parse(
    execFileSync("npm", ["ls", "--omit=dev", "--all", "--json", "--long"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
  const normalizedPaths = new Map<string, Promise<string>>();
  function normalize(path: string) {
    let pending = normalizedPaths.get(path);
    if (!pending) {
      pending = realpath(path).then((resolved) => {
        const normalized = relative(root, resolved).replaceAll("\\", "/");
        assert.ok(
          !isAbsolute(normalized) && !normalized.split("/").includes(".."),
          "Production dependency is outside the checkout",
        );
        return normalized;
      });
      normalizedPaths.set(path, pending);
    }
    return pending;
  }
  const production = new Map<string, Set<string>>();
  async function visit(value: unknown): Promise<string | undefined> {
    const node = record(value);
    // npm emits {} for uninstalled optional dependencies. Missing required
    // packages make npm ls exit nonzero, before this tree can be consumed.
    if (!Object.keys(node).length) return undefined;
    const path = await normalize(text(node.path));
    const children = production.get(path) ?? new Set<string>();
    production.set(path, children);
    for (const dependency of Object.values(record(node.dependencies ?? {}))) {
      const child = await visit(dependency);
      if (child !== undefined) children.add(child);
    }
    return path;
  }
  assert.equal(await visit(tree), "", "Production inventory root mismatch");
  const result = selectProductionSbom(full, production);
  const lockfile: unknown = JSON.parse(
    await readFile("package-lock.json", "utf8"),
  );
  verifyProductionSbom(result, lockfile);
  return result;
}
