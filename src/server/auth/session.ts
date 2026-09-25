import type { AuthTokens } from "@/lib/types";
import type { Conn } from "../db/client";
import type { UserRow } from "../db/schema";
import { userOut } from "../serialize";
import { ACCESS_TOKEN_TTL_MINUTES, createAccessToken, issueRefreshToken } from "./tokens";

/** The access/refresh pair that login and refresh return. */
export async function tokensFor(db: Conn, user: UserRow, refreshToken?: string): Promise<AuthTokens> {
  return {
    access_token: await createAccessToken(user),
    refresh_token: refreshToken ?? issueRefreshToken(db, user),
    token_type: "bearer",
    expires_in: ACCESS_TOKEN_TTL_MINUTES * 60,
    user: userOut(user),
  };
}
