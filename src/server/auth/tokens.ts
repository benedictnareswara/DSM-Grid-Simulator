/** Short-lived access JWTs and rotating refresh tokens. */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import type { Conn, DB } from "../db/client";
import { refreshTokens, STATUS_ACTIVE, users, type UserRow } from "../db/schema";
import { env } from "../env";

// Short, because an access token can't be revoked.
export const ACCESS_TOKEN_TTL_MINUTES = 15;
export const REFRESH_TOKEN_TTL_DAYS = 30;

const secretKey = () => new TextEncoder().encode(env().JWT_SECRET);

export interface AccessClaims {
  sub: string;
  role: string;
  username: string;
}

export async function createAccessToken(user: UserRow): Promise<string> {
  return new SignJWT({ role: user.role, username: user.username })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_MINUTES}m`)
    .sign(secretKey());
}

/** Null for anything invalid. Expired, forged and malformed tokens all look the same to the caller. */
export async function decodeAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string") return null;
    return { sub: payload.sub, role: String(payload.role), username: String(payload.username) };
  } catch {
    return null;
  }
}

const hashRefresh = (token: string) => createHash("sha256").update(token).digest("hex");

/** Mint an opaque refresh token and store only its hash. */
export function issueRefreshToken(db: Conn, user: UserRow): string {
  const raw = randomBytes(32).toString("base64url");
  db.insert(refreshTokens)
    .values({
      userId: user.id,
      tokenHash: hashRefresh(raw),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    })
    .run();
  return raw;
}

/** Exchange a refresh token for a fresh one. */
export function rotateRefreshToken(db: DB, raw: string): { user: UserRow; token: string } | null {
  return db.transaction((tx) => {
    const row = tx.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hashRefresh(raw))).get();
    if (!row) return null;

    if (row.revokedAt) {
      revokeAllForUser(tx, row.userId);
      console.log(`[AUTH] Refresh token reuse detected for user ${row.userId} — all sessions revoked`);
      return null;
    }
    if (row.expiresAt.getTime() <= Date.now()) return null;

    const user = tx.select().from(users).where(eq(users.id, row.userId)).get();
    if (!user || user.status !== STATUS_ACTIVE) return null;

    tx.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id)).run();
    return { user, token: issueRefreshToken(tx, user) };
  });
}

export function revokeRefreshToken(db: DB, raw: string): void {
  db.update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.tokenHash, hashRefresh(raw)), isNull(refreshTokens.revokedAt)))
    .run();
}

export function revokeAllForUser(db: Conn, userId: string): void {
  db.update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
    .run();
}

export function verifyGatewayToken(token: string | null | undefined): boolean {
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(env().GATEWAY_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}
