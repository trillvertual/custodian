import { z } from "zod";
const env = z
  .object({
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    DATABASE_URL: z
      .string()
      .default("postgresql://vault:vault@127.0.0.1:5432/vault"),
    APP_URL: z.url().default("http://localhost:5173"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    HOST: z.string().default("127.0.0.1"),
    SETUP_TOKEN: z.string().min(32).optional(),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    TELEGRAM_CLIENT_ID: z.string().optional(),
    TELEGRAM_CLIENT_SECRET: z.string().optional(),
  })
  .parse(process.env);
const origin = new URL(env.APP_URL);
if (env.NODE_ENV === "production" && origin.protocol !== "https:")
  throw new Error("APP_URL must use HTTPS in production");
if (origin.pathname !== "/" || origin.search || origin.hash)
  throw new Error("APP_URL must be an origin without a path");
export const config = {
  ...env,
  origin: origin.origin,
  rpId: origin.hostname,
  secure: origin.protocol === "https:",
};
