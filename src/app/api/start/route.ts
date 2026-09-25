import { requireAdmin, route } from "@/server/http";
import { statusResponse } from "@/server/sim-control";

export const POST = route(async (req, { rt }) => {
  const admin = await requireAdmin(req, rt);
  const audit = { action: "start", admin, req };
  const sim = rt.simulator;
  // Parked at the end of the dataset: a start would do nothing, so say so.
  if (sim.phase === "finished") return statusResponse(rt, "Dataset exhausted — reset before starting again", audit);
  if (sim.running) return statusResponse(rt, "Simulation already running", audit);
  sim.start();
  return statusResponse(rt, "Simulation started", audit);
});
