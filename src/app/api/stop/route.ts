import { requireAdmin, route } from "@/server/http";
import { statusResponse } from "@/server/sim-control";

export const POST = route(async (req, { rt }) => {
  const admin = await requireAdmin(req, rt);
  rt.simulator.stop();
  return statusResponse(rt, "Simulation stopped", { action: "stop", admin, req });
});
