import { z } from "zod";
import { MAX_TICK_INTERVAL_MS, MIN_TICK_INTERVAL_MS } from "@/server/grid/constants";
import { readQuery, requireAdmin, route } from "@/server/http";
import { statusResponse } from "@/server/sim-control";

const Query = z.object({
  interval_ms: z.coerce.number().int().min(MIN_TICK_INTERVAL_MS).max(MAX_TICK_INTERVAL_MS),
});

/** Simulation speed: milliseconds per tick. */
export const POST = route(async (req, { rt }) => {
  await requireAdmin(req, rt);
  const { interval_ms } = readQuery(req, Query);
  rt.simulator.setSpeed(interval_ms);
  return statusResponse(rt, `Speed set to ${interval_ms}ms`);
});
