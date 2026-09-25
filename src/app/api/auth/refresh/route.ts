import { z } from "zod";
import { tokensFor } from "@/server/auth/session";
import { rotateRefreshToken } from "@/server/auth/tokens";
import { ApiError, json, readBody, route } from "@/server/http";

const Body = z.object({ refresh_token: z.string() });

/** Trade a refresh token for a new pair. Reusing a spent token revokes every session for that user. */
export const POST = route(async (req, { rt }) => {
  const body = await readBody(req, Body);
  const rotated = rotateRefreshToken(rt.db, body.refresh_token);
  if (!rotated) throw new ApiError(401, "invalid_refresh", "Session expired. Sign in again.");
  return json(await tokensFor(rt.db, rotated.user, rotated.token));
});
