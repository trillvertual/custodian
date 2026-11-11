import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(
  new URL("./node_modules/eslint/bin/eslint.js", import.meta.url),
);
if (!existsSync(cli)) {
  console.error(
    "Install the isolated lint toolchain first: npm ci --prefix tools/lint",
  );
  process.exit(1);
}
const result = spawnSync(
  process.execPath,
  [
    cli,
    "--config",
    "tools/lint/eslint.config.mjs",
    "--max-warnings=0",
    ...(process.argv.length > 2 ? process.argv.slice(2) : ["."]),
  ],
  {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
