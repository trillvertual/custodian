// Isolated demonstration server, never imported by the production application.
export {};
process.env.APP_URL ??= "http://localhost:5173";
process.env.NODE_ENV = "development";
const { testDatabase } = await import("./database.ts");
const { migrate } = await import("../apps/server/src/db.ts");
const { buildApp } = await import("../apps/server/src/app.ts");
const { passwordHash } = await import("../apps/server/src/security.ts");
const {
  ready,
  deriveLoginSecret,
  randomKey,
  createIdentity,
  sealVaultKey,
  createRecovery,
  encryptJson,
  recordContext,
  recordSchema,
} = await import("../packages/core/src/index.ts");
await ready;
const db = await testDatabase();
await migrate(db);
const vaultId = crypto.randomUUID(),
  userId = crypto.randomUUID(),
  key = randomKey(),
  owner = createIdentity("Demo login password 2026!", userId),
  rescue = createRecovery(key, vaultId, 1);
await db.query("INSERT INTO vaults(id,name,recovery) VALUES($1,$2,$3)", [
  vaultId,
  "VPN · Демонстрация",
  rescue.box,
]);
await db.query(
  "INSERT INTO users(id,username,display_name,role,status,password_hash,identity,sealed_key,password_login_version) VALUES($1,$2,$3,'owner','active',$4,$5,$6,1)",
  [
    userId,
    "demo",
    "Алексей · демо",
    await passwordHash(
      deriveLoginSecret(
        "Demo login password 2026!",
        "demo",
        new URL(process.env.APP_URL!).hostname,
      ),
    ),
    owner.identity,
    sealVaultKey(key, owner.identity.publicKey, vaultId, 1),
  ],
);
const fixtures = [
  {
    title: "Cloudflare",
    type: "login",
    url: "https://dash.cloudflare.com",
    username: "infra@example.com",
    folder: "Инфраструктура",
    tags: ["production", "dns"],
    favorite: true,
    note: "Демонстрационная запись. DNS, защита домена и сертификаты. Эти данные не дают доступа к реальным сервисам.",
    totp: {
      secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      digits: 6,
      period: 30,
      algorithm: "SHA1",
    },
  },
  {
    title: "Hetzner Cloud",
    type: "login",
    url: "https://console.hetzner.cloud",
    username: "admin@example.com",
    folder: "Инфраструктура",
    tags: ["production"],
    favorite: true,
  },
  {
    title: "Remnawave · панель",
    type: "login",
    url: "https://panel.example.com",
    username: "admin",
    folder: "VPN-панели",
    tags: ["vpn", "production"],
  },
  {
    title: "GitHub · deploy token",
    type: "token",
    url: "https://github.com",
    username: "deploy-bot",
    folder: "Разработка",
    tags: ["ci/cd"],
  },
  {
    title: "Finland · SSH",
    type: "ssh",
    url: "192.0.2.10",
    username: "root",
    folder: "Инфраструктура",
    tags: ["finland", "node"],
  },
  {
    title: "Telegram · bot token",
    type: "token",
    url: "https://t.me/BotFather",
    username: "@example_bot",
    folder: "VPN-панели",
    tags: ["telegram"],
  },
  {
    title: "PostgreSQL · production",
    type: "login",
    url: "db.example.com:5432",
    username: "vault_service",
    folder: "Инфраструктура",
    tags: ["database"],
  },
  {
    title: "Порядок смены доступов",
    type: "note",
    folder: "Команда",
    tags: ["runbook"],
    note: "Демонстрация. После отключения участника смените пароли в сервисах, отзовите токены и проверьте SSH-ключи.",
  },
  {
    title: "S3 · резервные копии",
    type: "token",
    url: "https://storage.example.com",
    username: "backup-agent",
    folder: "Инфраструктура",
    tags: ["backup"],
  },
];
for (const [index, fixture] of fixtures.entries()) {
  const id = crypto.randomUUID();
  const data = recordSchema.parse({
    secret:
      fixture.type === "ssh"
        ? "DEMO SSH KEY - NOT A REAL PRIVATE KEY"
        : fixture.type === "note"
          ? ""
          : "DEMO-ONLY-secret-2026!",
    ...fixture,
  });
  await db.query(
    "INSERT INTO records(id,version,epoch,box,updated_by,updated_at) VALUES($1,1,1,$2,$3,$4)",
    [
      id,
      encryptJson(data, key, recordContext(vaultId, id, 1, 1)),
      userId,
      new Date(Date.now() - index * 86400000),
    ],
  );
}
const app = await buildApp(db, { logger: false });
const port = Number(process.env.PORT ?? 3001);
await app.listen({ host: "127.0.0.1", port });
console.log(
  `Isolated demo API at http://127.0.0.1:${port}. All credentials are synthetic.`,
);
async function stop() {
  await app.close();
  await db.end();
  process.exit(0);
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
