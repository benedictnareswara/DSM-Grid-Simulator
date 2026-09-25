import { z } from "zod";
import { AUTOPUSH_MIN_SEVERITY } from "@/server/grid/constants";
import { json, qBool, readQuery, requireAdmin, route } from "@/server/http";

export const GET = route(async (req, { rt }) => {
  await requireAdmin(req, rt);
  return json({ enabled: rt.simulator.autopushEnabled, min_severity: AUTOPUSH_MIN_SEVERITY });
});

/** Toggle autopush. Qualifying alerts still only arrive once the gateway echoes them. */
export const POST = route(async (req, { rt }) => {
  await requireAdmin(req, rt);
  const { enabled } = readQuery(req, z.object({ enabled: qBool }));
  rt.simulator.setAutopush(enabled);
  rt.hub.broadcastAutopushStatus(enabled);
  return json({ enabled: rt.simulator.autopushEnabled, min_severity: AUTOPUSH_MIN_SEVERITY });
});
