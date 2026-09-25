import { currentUser, json, route } from "@/server/http";

export const GET = route(async (req, { rt }) => {
  await currentUser(req, rt);
  return json(rt.simulator.getStatus());
});
