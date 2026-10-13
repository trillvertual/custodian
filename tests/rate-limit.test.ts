import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../apps/server/src/app.ts";
import { migrate, type Database } from "../apps/server/src/db.ts";
import { testDatabase } from "./database.ts";

let app: FastifyInstance;
let db: Database;

beforeAll(async () => {
  db = await testDatabase();
  await migrate(db);
  app = await buildApp(db, { serveStatic: false, logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.end();
});

function attempt(remoteAddress: string, forwardedFor?: string) {
  return app.inject({
    method: "POST",
    url: "/api/auth/password",
    remoteAddress,
    headers: {
      origin: "http://localhost:5173",
      ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
    },
    // Invalid login payloads must count too, without hashing fixture passwords.
    payload: {},
  });
}

describe("password login rate limits", () => {
  it("shares the eight-attempt limit between IPv4 and mapped IPv6", async () => {
    for (let index = 0; index < 8; index++) {
      const address = index % 2 ? "::ffff:192.0.2.10" : "192.0.2.10";
      expect((await attempt(address)).statusCode).toBe(400);
    }
    const blocked = await attempt("192.0.2.10");
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect((await attempt("192.0.2.11")).statusCode).toBe(400);
  });

  it("cannot reset the limit by rotating IPv6 addresses within a /64", async () => {
    for (let index = 1; index <= 8; index++) {
      const address =
        index % 2
          ? `2001:db8:1234:5678::${index}`
          : `2001:0db8:1234:5678:0000:0000:0000:000${index}`;
      expect((await attempt(address)).statusCode).toBe(400);
    }
    expect((await attempt("2001:db8:1234:5678::abcd")).statusCode).toBe(429);
    expect((await attempt("2001:db8:1234:5679::1")).statusCode).toBe(400);
  });

  it("cannot reset the limit with an untrusted forwarding header", async () => {
    for (let index = 1; index <= 8; index++) {
      expect(
        (await attempt("192.0.2.20", `198.51.100.${index}`)).statusCode,
      ).toBe(400);
    }
    expect((await attempt("192.0.2.20", "198.51.100.99")).statusCode).toBe(429);
  });
});
