import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import Fastify from "fastify";
import staticPlugin from "@fastify/static";
import { expect, it } from "vitest";

// wildcard:false exercises the directory walk affected by the scoped glob override.
// wildcard:true covers the same nested/compressed resources in production mode.
it.each([true, false])(
  "serves nested static assets and Brotli variants with wildcard=%s",
  async (wildcard) => {
    const root = await mkdtemp(join(tmpdir(), "custodian-static-"));
    const app = Fastify({ logger: false });
    const source = "console.log('synthetic static fixture');";
    try {
      await mkdir(join(root, "assets", "nested"), { recursive: true });
      await writeFile(join(root, "index.html"), "<main>Static fixture</main>");
      const asset = join(root, "assets", "nested", "entry.js");
      await writeFile(asset, source);
      await writeFile(`${asset}.br`, brotliCompressSync(source));
      await app.register(staticPlugin, { root, preCompressed: true, wildcard });

      const entry = await app.inject("/assets/nested/entry.js");
      expect(entry.statusCode).toBe(200);
      expect(entry.body).toBe(source);
      expect((await app.inject("/")).body).toContain("Static fixture");

      const compressed = await app.inject({
        url: "/assets/nested/entry.js",
        headers: { "accept-encoding": "br" },
      });
      expect(compressed.statusCode).toBe(200);
      expect(compressed.headers["content-encoding"]).toBe("br");
      expect(brotliDecompressSync(compressed.rawPayload).toString()).toBe(
        source,
      );

      const head = await app.inject({
        method: "HEAD",
        url: "/assets/nested/entry.js",
      });
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe("");
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
