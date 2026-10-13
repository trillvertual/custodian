import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { brotliCompress, constants, gzip } from "node:zlib";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../apps/web/dist", import.meta.url));
const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);
let count = 0;

async function compress(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await compress(path);
      continue;
    }
    if (!entry.isFile() || !/\.(js|css|html)$/.test(entry.name)) continue;
    const bytes = await readFile(path);
    if (bytes.length < 1024) continue;
    const [gz, br] = await Promise.all([
      gzipAsync(bytes, { level: 9 }),
      brotliAsync(bytes, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
      }),
    ]);
    if (gz.length < bytes.length) await writeFile(`${path}.gz`, gz);
    if (br.length < bytes.length) await writeFile(`${path}.br`, br);
    count++;
  }
}

await compress(root);
console.log(`Prepared gzip/brotli variants for ${count} web assets.`);
