import { z } from "zod";
import type { Thresholds } from "@/lib/types";
import { recordAudit } from "@/server/audit";
import { AUDIT } from "@/server/db/schema";
import { clientIp, json, readBody, requireAdmin, route } from "@/server/http";

const Body = z.object({
  peak_load_ratio: z.number().nullish(),
  freq_deviation_hz: z.number().nullish(),
  reserve_margin_critical_pct: z.number().nullish(),
  low_renewable_fraction: z.number().nullish(),
  emergency_score: z.number().nullish(),
  price_spike_ratio: z.number().nullish(),
});

export const GET = route(async (req, { rt }) => {
  await requireAdmin(req, rt);
  return json(rt.simulator.control.thresholds);
});

/**
 * Retune what the engine alerts on. Takes effect on the next tick. It's audited
 * with the previous values, so the log entry is a diff, and broadcast so every
 * open dashboard's gauges move their trip points.
 */
export const POST = route(async (req, { rt }) => {
  const admin = await requireAdmin(req, rt);
  const body = await readBody(req, Body);
  const updates = Object.fromEntries(Object.entries(body).filter(([, v]) => v != null)) as Partial<Thresholds>;
  const control = rt.simulator.control;
  const previous = Object.fromEntries(Object.keys(updates).map((k) => [k, control.thresholds[k as keyof Thresholds]]));
  control.updateThresholds(updates);
  const current = { ...control.thresholds };

  recordAudit(rt.db, AUDIT.SIM_THRESHOLDS, {
    actor: admin,
    targetType: "simulation",
    targetLabel: "thresholds",
    detail: { from: previous, to: updates },
    ip: clientIp(req),
  });
  rt.hub.broadcastThresholds(current);
  return json({ message: "Thresholds updated", thresholds: current });
});
