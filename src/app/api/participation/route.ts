import { ParticipationQuery, participationRows, participationWhere, toParticipation } from "@/server/history";
import { json, qLimit, qOffset, readQuery, requireAdmin, route } from "@/server/http";

/** Every household answer, newest first, with the answered alert's whole lifecycle. */
export const GET = route(async (req, { rt }) => {
  await requireAdmin(req, rt);
  const q = readQuery(req, ParticipationQuery.extend({ limit: qLimit(100, 500), offset: qOffset }));
  const rows = participationRows(rt.db, participationWhere(q), q.limit, q.offset);
  return json(toParticipation(rt.db, rows));
});
