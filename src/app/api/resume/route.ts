import { requireAdmin, route } from "@/server/http";
import { statusResponse } from "@/server/sim-control";

/** Reports what actually happened ("Nothing running to resume" and so on), not what was asked. */
export const POST = route(async (req, { rt }) => {
  const admin = await requireAdmin(req, rt);
  return statusResponse(rt, rt.simulator.resume(), { action: "resume", admin, req });
});
