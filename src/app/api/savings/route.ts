import { json, requireAdmin, route } from "@/server/http";
import { summarise } from "@/server/savings";

/** Every household's contribution, for the operator. */
export const GET = route(async (req, { rt }) => {
  await requireAdmin(req, rt);
  return json(summarise(rt.db, null));
});
