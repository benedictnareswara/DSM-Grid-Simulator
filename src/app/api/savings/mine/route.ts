import { json, requireConsumer, route } from "@/server/http";
import { summarise } from "@/server/savings";

/** This household's own record. Who they are comes from the token, never a query parameter. */
export const GET = route(async (req, { rt }) => {
  const user = await requireConsumer(req, rt);
  return json(summarise(rt.db, user.id));
});
