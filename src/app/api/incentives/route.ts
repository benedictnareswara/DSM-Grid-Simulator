import type { IncentiveModel } from "@/lib/types";
import { THROTTLE_WINDOW_MINUTES_BY_SEVERITY } from "@/server/grid/constants";
import * as incentives from "@/server/grid/incentives";
import { currentUser, json, route } from "@/server/http";

/**
 * The model itself, served rather than copied into each client. The pages use
 * it to preview what accepting an alert is worth before there's a response.
 */
export const GET = route(async (req, { rt }) => {
  await currentUser(req, rt);
  const model: IncentiveModel = {
    shed_kwh_by_parameter: incentives.SHED_KWH_BY_PARAMETER,
    shed_multiplier_by_severity: incentives.SHED_MULTIPLIER_BY_SEVERITY,
    throttle_window_minutes_by_severity: THROTTLE_WINDOW_MINUTES_BY_SEVERITY,
    response_bonus_tiers: incentives.RESPONSE_BONUS_TIERS.map(([max_seconds, multiplier, label]) => ({
      max_seconds,
      multiplier,
      label,
    })),
    streak_step: incentives.STREAK_STEP,
    streak_max_steps: incentives.STREAK_MAX_STEPS,
  };
  return json(model);
});
