import path from "node:path";
import { z } from "zod";

/**
 * Server settings, read once from process.env (server.ts loads `.env` into it before anything else
 * runs).
 */

const URL_SAFE = /^[A-Za-z0-9_-]+$/;

const schema = z.object({
  JWT_SECRET: z.string().min(32, "must be at least 32 characters"),
  // Checked in constant time against `?token=` on /ws/gateway.
  GATEWAY_TOKEN: z.string().min(16).regex(URL_SAFE, "must be URL-safe (A-Z a-z 0-9 _ -)"),

  // Used only on the first boot that finds no admin account (see seed-admin.ts).
  ADMIN_USERNAME: z.string().default("admin"),
  ADMIN_PASSWORD: z.string().default(""),
  // Not a `.local` address: registration's email check rejects special-use domains.
  ADMIN_EMAIL: z.string().default("admin@example.com"),

  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // "sample" (committed), "full" (after `npm run data:full`), or a path.
  DATASET: z.string().default("sample"),
  DATABASE_PATH: z.string().default("data/dsm.db"),
  // Set to "0" to skip the mDNS advertisement, e.g. on a network that blocks it.
  MDNS: z.string().default("1"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => {
        const key = i.path.join(".");
        return `  - ${key}: ${process.env[key] === undefined ? "missing" : i.message}`;
      })
      .join("\n");
    throw new Error(
      `Your .env is missing or invalid:\n${problems}\n\nRun \`npm run setup\` to create it.`,
    );
  }
  cached = parsed.data;
  return cached;
}

/** Test hook: forget the cached settings so the next env() call re-reads process.env. */
export function resetEnvCache(): void {
  cached = null;
}

export const REPO_ROOT = process.cwd();

export function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
}
