import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
const { values } = parseArgs({
  options: {
    url: { type: "string" },
    output: { type: "string", default: ".env" },
  },
});
if (!values.url)
  throw new Error(
    "Usage: npm run configure -- --url https://vault.example.com",
  );
const url = new URL(values.url);
if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash)
  throw new Error("URL must be a HTTPS origin.");
const password = randomBytes(24).toString("hex"),
  setup = randomBytes(32).toString("base64url");
await writeFile(
  values.output!,
  `APP_URL=${url.origin}\nPOSTGRES_PASSWORD=${password}\nDATABASE_URL=postgresql://vault:${password}@db:5432/vault\nSETUP_TOKEN=${setup}\nGITHUB_CLIENT_ID=\nGITHUB_CLIENT_SECRET=\nTELEGRAM_CLIENT_ID=\nTELEGRAM_CLIENT_SECRET=\n`,
  { mode: 0o600, flag: "wx" },
);
console.log(
  `Created ${values.output} with random database credentials and setup token. Keep it private. Existing files are never overwritten.`,
);
