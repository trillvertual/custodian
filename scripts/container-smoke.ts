import assert from "node:assert/strict";

const base = "http://127.0.0.1:8080";
const health = await fetch(`${base}/api/health`);
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { ok: true });
const config = await fetch(`${base}/api/auth/config`);
assert.equal(config.status, 200);
assert.equal((await config.json()).initialized, false);
const page = await fetch(base);
assert.equal(page.status, 200);
assert.ok(page.headers.get("content-security-policy"));
const html = await page.text();
assert.ok(html.includes('id="root"'));
const script = html.match(/src="([^"\s]*\/assets\/[^"\s]+\.js)"/);
assert.ok(script, "Built frontend entry is missing");
const entry = await fetch(new URL(script[1]!, base), {
  headers: { "Accept-Encoding": "br" },
});
assert.equal(entry.status, 200);
assert.equal(entry.headers.get("content-encoding"), "br");
assert.match(entry.headers.get("vary") ?? "", /Accept-Encoding/i);
console.log(
  "Container: PostgreSQL health, closed bootstrap, CSP and built frontend OK",
);
