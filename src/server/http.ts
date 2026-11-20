/** Shared plumbing for the route handlers: errors, auth guards, body parsing. */

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { STATUS_ACTIVE, STATUS_PENDING, users, type UserRow } from "./db/schema";
import { decodeAccessToken } from "./auth/tokens";
import { getRuntime, type Runtime } from "./runtime";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status });

type Handler<C> = (req: Request, ctx: C & { rt: Runtime }) => Promise<Response> | Response;

/** Wrap a route handler: gives it the runtime and turns ApiError into the JSON error shape. */
export function route<C = object>(handler: Handler<C>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    try {
      return await handler(req, { ...ctx, rt: getRuntime() });
    } catch (err) {
      if (err instanceof ApiError) {
        return json({ detail: { code: err.code, message: err.message } }, err.status);
      }
      console.error("[API] Unhandled error:", err);
      return json({ detail: { code: "server_error", message: "Something went wrong." } }, 500);
    }
  };
}

/** The caller's address. */
export function clientIp(req: Request): string | null {
  return req.headers.get("x-dsm-client-ip");
}

/** Parse and validate a JSON body, returning 422 with a readable message on failure. */
export async function readBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(422, "invalid_request", "Request body must be JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue.path.join(".");
    throw new ApiError(422, "invalid_request", field ? `${field}: ${issue.message}` : issue.message);
  }
  return parsed.data;
}

/** Read and validate query parameters. */
export function readQuery<T extends z.ZodType>(req: Request, schema: T): z.infer<T> {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError(422, "invalid_request", `${issue.path.join(".")}: ${issue.message}`);
  }
  return parsed.data;
}

// ── Auth guards ──────────────────────────────────────────────────────────────

/** The signed-in account. */
export async function currentUser(req: Request, rt: Runtime): Promise<UserRow> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new ApiError(401, "missing_token", "Sign in to continue.");

  const claims = await decodeAccessToken(token);
  if (!claims) throw new ApiError(401, "invalid_token", "Session expired. Sign in again.");

  const user = rt.db.select().from(users).where(eq(users.id, claims.sub)).get();
  if (!user) throw new ApiError(401, "no_such_user", "This account no longer exists.");

  if (user.status !== STATUS_ACTIVE) {
    throw new ApiError(
      403,
      `account_${user.status}`,
      user.status === STATUS_PENDING
        ? "Your account is waiting for operator approval."
        : "Your account has been suspended.",
    );
  }
  return user;
}

export async function requireAdmin(req: Request, rt: Runtime): Promise<UserRow> {
  const user = await currentUser(req, rt);
  if (user.role !== "admin") throw new ApiError(403, "admin_only", "Operator access required.");
  return user;
}

export async function requireConsumer(req: Request, rt: Runtime): Promise<UserRow> {
  const user = await currentUser(req, rt);
  if (user.role !== "consumer") {
    throw new ApiError(403, "consumer_only", "This action belongs to a household account.");
  }
  return user;
}

// ── Login/register throttle ──────────────────────────────────────────────────
// Enough to stop a script hammering a weak password.

export const AUTH_ATTEMPT_LIMIT = 5;
export const AUTH_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

const attemptKey = (req: Request, identifier: string) => `${clientIp(req) ?? "unknown"}:${identifier.toLowerCase()}`;

export function throttleCheck(rt: Runtime, req: Request, identifier: string): void {
  const now = Date.now();
  const cutoff = now - AUTH_ATTEMPT_WINDOW_MS;
  for (const [k, v] of rt.authAttempts) {
    if (!v.length || v[v.length - 1] < cutoff) rt.authAttempts.delete(k);
  }
  const key = attemptKey(req, identifier);
  const hits = (rt.authAttempts.get(key) ?? []).filter((t) => t > cutoff);
  if (hits.length >= AUTH_ATTEMPT_LIMIT) {
    throw new ApiError(429, "too_many_attempts", "Too many attempts. Wait a few minutes and try again.");
  }
  rt.authAttempts.set(key, hits);
}

/** Only failures count against the limit. */
export function throttleRecord(rt: Runtime, req: Request, identifier: string): void {
  const key = attemptKey(req, identifier);
  rt.authAttempts.set(key, [...(rt.authAttempts.get(key) ?? []), Date.now()]);
}

export function throttleClear(rt: Runtime, req: Request, identifier: string): void {
  rt.authAttempts.delete(attemptKey(req, identifier));
}

// ── Query-string helpers ─────────────────────────────────────────────────────

/** "true"/"false"/"1"/"0". */
export const qBool = z
  .enum(["true", "false", "1", "0", "True", "False"])
  .transform((v) => v === "true" || v === "1" || v === "True");

export const qLimit = (dflt: number, max: number) => z.coerce.number().int().min(1).max(max).default(dflt);
export const qOffset = z.coerce.number().int().min(0).default(0);
