import { z } from "zod";
import { revokeRefreshToken } from "@/server/auth/tokens";
import { json, readBody, route } from "@/server/http";

const Body = z.object({ refresh_token: z.string() });

/**
 * Revoke one refresh token. Needs no access token, so a client whose session
 * has already expired can still sign out: holding the refresh token is the proof.
 */
export const POST = route(async (req, { rt }) => {
  const body = await readBody(req, Body);
  revokeRefreshToken(rt.db, body.refresh_token);
  return json({ message: "Signed out." });
});
