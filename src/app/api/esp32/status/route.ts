import { currentUser, json, route } from "@/server/http";

/** Whether the ESP32 gateway is connected. */
export const GET = route(async (req, { rt }) => {
  await currentUser(req, rt);
  return json({ connected: rt.hub.gatewayConnected });
});
