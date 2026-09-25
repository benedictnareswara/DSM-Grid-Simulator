import { currentUser, json, route } from "@/server/http";
import { userOut } from "@/server/serialize";

/** The signed-in account, for rehydrating a session on a cold load. */
export const GET = route(async (req, { rt }) => json(userOut(await currentUser(req, rt))));
