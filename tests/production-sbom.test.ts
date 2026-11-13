import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  createProductionSbom,
  selectProductionSbom,
  verifyProductionSbom,
} from "../scripts/production-sbom.ts";

function fixture() {
  const component = (
    name: string,
    version: string,
    path: string,
    scope = "required",
  ) => ({
    "bom-ref": `${name}@${version}`,
    name,
    version,
    scope,
    purl: `pkg:npm/${name}@${version}`,
    properties: [{ name: "cdx:npm:package:path", value: path }],
    hashes: [{ alg: "SHA-512", content: "synthetic-hash" }],
    licenses: [{ license: { id: "MIT" } }],
  });
  const paths = [
    "apps/server",
    "node_modules/shared",
    "node_modules/parent/node_modules/shared",
    "node_modules/shared-old",
  ];
  const components = [
    component("@vault/server", "1.0.0", paths[0]!),
    component("shared", "2.0.0", paths[1]!, "optional"),
    component("shared", "2.0.0", paths[2]!),
    component("shared-old", "1.0.0", paths[3]!),
    component("dev-tool", "1.0.0", "node_modules/dev-tool"),
  ];
  const full = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: { component: { "bom-ref": "root", version: "1.0.0" } },
    components,
    dependencies: [
      {
        ref: "root",
        dependsOn: ["@vault/server@1.0.0", "dev-tool@1.0.0", "shared@2.0.0"],
      },
      {
        ref: "@vault/server@1.0.0",
        dependsOn: ["shared@2.0.0", "shared-old@1.0.0"],
      },
      { ref: "shared@2.0.0", dependsOn: ["shared-old@1.0.0"] },
      { ref: "shared@2.0.0", dependsOn: ["shared-old@1.0.0"] },
      { ref: "shared-old@1.0.0", dependsOn: [] },
      { ref: "dev-tool@1.0.0", dependsOn: [] },
    ],
  };
  const lock = {
    lockfileVersion: 3,
    version: "1.0.0",
    packages: {
      "": { version: "1.0.0", devDependencies: { shared: "2.0.0" } },
      "apps/server": { name: "@vault/server", version: "1.0.0" },
      "node_modules/@vault/server": { link: true, resolved: "apps/server" },
      "node_modules/shared": { version: "2.0.0" },
      "node_modules/parent/node_modules/shared": { version: "2.0.0" },
      "node_modules/shared-old": { version: "1.0.0" },
      "node_modules/dev-tool": { version: "1.0.0", dev: true },
      "node_modules/platform-optional": { version: "1.0.0", optional: true },
    },
  };
  const production = new Map([
    ["", new Set([paths[0]!])],
    [paths[0]!, new Set([paths[1]!, paths[2]!, paths[3]!])],
    [paths[1]!, new Set([paths[3]!])],
    [paths[2]!, new Set([paths[3]!])],
    [paths[3]!, new Set<string>()],
  ]);
  return { full, lock, production };
}

describe("production SBOM", () => {
  it("retains shared runtime packages, merges duplicate refs and paths, and preserves audit metadata", () => {
    const { full, lock, production } = fixture();
    const before = structuredClone(full);
    const bom = selectProductionSbom(full, production);
    expect(verifyProductionSbom(bom, lock)).toEqual({
      components: 3,
      installations: 4,
    });
    expect(bom.components.map((c) => c.name)).toEqual([
      "@vault/server",
      "shared",
      "shared-old",
    ]);
    expect(bom.components[1]).toMatchObject({
      scope: "required",
      hashes: full.components[1]!.hashes,
      licenses: full.components[1]!.licenses,
    });
    expect(bom.components[1]!.properties).toHaveLength(2);
    expect(
      bom.dependencies.find((node) => node.ref === "root")!.dependsOn,
    ).toEqual(["@vault/server@1.0.0"]);
    expect(
      bom.dependencies.find((node) => node.ref === "@vault/server@1.0.0")!
        .dependsOn,
    ).toContain("shared@2.0.0");
    expect(full).toEqual(before);
  });

  it("fails closed when npm's full inventory omits an installed production package", () => {
    const { full, production } = fixture();
    full.components.splice(1, 1);
    expect(() => selectProductionSbom(full, production)).toThrow(
      /Missing production SBOM installation/,
    );
  });

  it("rejects conflicting hashes on duplicate package identities", () => {
    const { full, production } = fixture();
    full.components[2]!.hashes[0]!.content = "different-hash";
    expect(() => selectProductionSbom(full, production)).toThrow(
      /Conflicting SBOM package hashes/,
    );
  });

  it("preserves licenses supplied only by a later duplicate component", () => {
    const { full, production } = fixture();
    Reflect.deleteProperty(full.components[1]!, "licenses");
    const bom = selectProductionSbom(full, production);
    expect(bom.components[1]!.licenses).toEqual(full.components[2]!.licenses);
    expect(full.components[1]).not.toHaveProperty("licenses");
  });

  it("fails closed on conflicting licenses instead of dropping audit metadata", () => {
    const { full, production } = fixture();
    full.components[2]!.licenses[0]!.license.id = "ISC";
    expect(() => selectProductionSbom(full, production)).toThrow(
      /Conflicting SBOM package licenses/,
    );
  });

  it.each([
    [
      "omitted shared runtime dependency",
      (bom: ReturnType<typeof selectProductionSbom>) => {
        bom.components.splice(1, 1);
      },
      /Missing production SBOM installation/,
    ],
    [
      "wrong package version",
      (bom: ReturnType<typeof selectProductionSbom>) => {
        bom.components[1]!.version = "3.0.0";
      },
      /SBOM version mismatch/,
    ],
    [
      "wrong package identity",
      (bom: ReturnType<typeof selectProductionSbom>) => {
        bom.components[1]!.purl = "pkg:npm/unrelated@2.0.0";
      },
      /SBOM package identity mismatch/,
    ],
    [
      "duplicate component reference",
      (bom: ReturnType<typeof selectProductionSbom>) => {
        bom.components.push(bom.components[1]!);
      },
      /Duplicate or empty SBOM reference/,
    ],
    [
      "missing graph node",
      (bom: ReturnType<typeof selectProductionSbom>) => {
        bom.dependencies.pop();
      },
      /Missing SBOM dependency graph node/,
    ],
    [
      "dangling dependency",
      (bom: ReturnType<typeof selectProductionSbom>) => {
        bom.dependencies[0]!.dependsOn.push("absent");
      },
      /Dangling SBOM dependency/,
    ],
    [
      "unreachable runtime component",
      (bom: ReturnType<typeof selectProductionSbom>) => {
        bom.dependencies[0]!.dependsOn = [];
      },
      /Unreachable production SBOM component/,
    ],
    [
      "unsafe installation path",
      (bom: ReturnType<typeof selectProductionSbom>) => {
        bom.components[1]!.properties = [
          { name: "cdx:npm:package:path", value: "../outside" },
        ];
      },
      /Unsafe SBOM installation path/,
    ],
  ] as const)("rejects %s", (_label, mutate, error) => {
    const { full, production, lock } = fixture();
    const bom = selectProductionSbom(full, production);
    mutate(bom);
    expect(() => verifyProductionSbom(bom, lock)).toThrow(error);
  });

  it("rejects development-only components even if the dependency graph includes them", () => {
    const { full, lock, production } = fixture();
    production.set("node_modules/dev-tool", new Set());
    expect(() =>
      verifyProductionSbom(selectProductionSbom(full, production), lock),
    ).toThrow(/Non-production package in SBOM/);
  });

  it("covers the real installed production tree and excludes development tools", async () => {
    const bom = await createProductionSbom();
    const lock: unknown = JSON.parse(
      await readFile("package-lock.json", "utf8"),
    );
    expect(verifyProductionSbom(bom, lock).installations).toBeGreaterThan(0);
    const names = bom.components.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "fastify",
        "react",
        "react-dom",
        "@noble/hashes",
      ]),
    );
    for (const name of ["vitest", "@playwright/test", "typescript"])
      expect(names).not.toContain(name);
    const root = bom.dependencies.find(
      (node) => !bom.components.some((c) => c["bom-ref"] === node.ref),
    )!;
    expect(root.dependsOn.every((ref) => ref.startsWith("@vault/"))).toBe(true);
    const fastify = bom.components.find((c) => c.name === "fastify")![
      "bom-ref"
    ];
    const react = bom.components.find((c) => c.name === "react")!["bom-ref"];
    expect(root.dependsOn).not.toContain(fastify);
    expect(root.dependsOn).not.toContain(react);
    expect(
      bom.dependencies.find((node) => node.ref.startsWith("@vault/server@"))!
        .dependsOn,
    ).toContain(fastify);
    expect(
      bom.dependencies.find((node) => node.ref.startsWith("@vault/web@"))!
        .dependsOn,
    ).toContain(react);
  });
});
