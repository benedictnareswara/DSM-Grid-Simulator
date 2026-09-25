/**
 * The three WebSocket endpoints, attached to the same HTTP server as the pages.
 *
 *   /ws/admin     operator dashboards (admin access token)
 *   /ws/consumer  household phones (household access token)
 *   /ws/gateway   the ESP32 gateway (GATEWAY_TOKEN)
 *
 * The token travels as `?token=` because a browser's WebSocket constructor
 * can't set headers. Every endpoint authenticates at the handshake. A rejected
 * socket is accepted first and then closed with 4401, because a browser reports
 * a refused upgrade as 1006 with no reason, which looks like the server being
 * down. 4401 tells the client to stop retrying and sign in again.
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { eq } from "drizzle-orm";
import { WebSocket, WebSocketServer } from "ws";
import { markDelivered, recordResponse } from "../alerts/store";
import { decodeAccessToken, verifyGatewayToken } from "../auth/tokens";
import { STATUS_ACTIVE, users } from "../db/schema";
import type { Runtime } from "../runtime";
import { WS_UNAUTHORIZED, type Identity, type ResponsePayload } from "./hub";

const PATHS = new Set(["/ws/admin", "/ws/consumer", "/ws/gateway"]);

// Server-side heartbeat. A half-open socket (Wi-Fi dropped, phone asleep)
// produces no close event, and a dead gateway left in the pool would keep the
// badge green while alerts vanish.
const HEARTBEAT_MS = 20_000;

type Tracked = WebSocket & { isAlive?: boolean };

async function identify(rt: Runtime, token: string | null): Promise<Identity | null> {
  if (!token) return null;
  const claims = await decodeAccessToken(token);
  if (!claims) return null;
  const user = rt.db.select().from(users).where(eq(users.id, claims.sub)).get();
  if (!user || user.status !== STATUS_ACTIVE) return null;
  return { user_id: user.id, username: user.username, role: user.role };
}

export function createSocketServer(rt: Runtime) {
  const wss = new WebSocketServer({ noServer: true });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients as Set<Tracked>) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  /** Returns true if this upgrade was one of ours. */
  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!PATHS.has(url.pathname)) return false;
    wss.handleUpgrade(req, socket, head, (ws: Tracked) => {
      ws.isAlive = true;
      ws.on("pong", () => (ws.isAlive = true));
      void onConnection(ws, url);
    });
    return true;
  }

  async function onConnection(ws: WebSocket, url: URL): Promise<void> {
    const token = url.searchParams.get("token");

    if (url.pathname === "/ws/gateway") {
      if (!verifyGatewayToken(token)) {
        // Logged, because a rejected gateway otherwise looks exactly like an
        // unplugged one. The fix is different: check GATEWAY_TOKEN, then re-flash.
        console.log("[WS] gateway handshake rejected — bad or missing GATEWAY_TOKEN (re-flash the gateway?)");
        // The ESP32 WebSocket library doesn't surface close reasons, so say it
        // in a message first; the firmware prints it.
        ws.send(JSON.stringify({ type: "error", message: "Invalid gateway token" }), () =>
          ws.close(WS_UNAUTHORIZED, "Invalid gateway token"),
        );
        return;
      }
      attachGateway(ws);
      return;
    }

    const identity = await identify(rt, token);
    if (!identity) {
      ws.close(WS_UNAUTHORIZED, "Authentication required");
      return;
    }

    if (url.pathname === "/ws/admin") {
      if (identity.role !== "admin") {
        ws.close(WS_UNAUTHORIZED, "Operator access required");
        return;
      }
      rt.hub.connect(ws, "admin", identity);
      // Prime this dashboard with the current state, or a tab opened mid-run shows a Start button.
      rt.hub.sendStatusTo(ws, rt.simulator.getStatus());
      rt.hub.sendAutopushStatusTo(ws, rt.simulator.autopushEnabled);
      rt.hub.sendThresholdsTo(ws, { ...rt.simulator.control.thresholds });
      ws.on("close", () => rt.hub.disconnect(ws, "admin"));
      return;
    }

    // An operator on the consumer pool would count as a household.
    if (identity.role !== "consumer") {
      ws.close(WS_UNAUTHORIZED, "Household account required");
      return;
    }
    rt.hub.connect(ws, "consumer", identity);
    // Receive-only: answers go over REST so they cross the gateway.
    ws.on("close", () => rt.hub.disconnect(ws, "consumer"));
  }

  /**
   * The gateway's socket. It's the only place a delivery or a response is
   * recorded, and the only place alerts reach phones or answers reach admins.
   *
   *   → relay_alert, relay_response            (server to gateway)
   *   ← forward_alert    { alert }             delivered to phones as pushed_alert
   *   ← forward_response { alert_id, accepted, responded_at, user_id, username }
   *                                            delivered to admins as dsm_response
   */
  function attachGateway(ws: WebSocket): void {
    rt.hub.connect(ws, "gateway");
    ws.on("message", (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "forward_alert" && msg.alert && typeof msg.alert === "object") {
        // Stamp delivery first, so history and the live fan-out agree.
        markDelivered(rt.db, msg.alert as Record<string, never>);
        rt.hub.broadcastPushedAlert(msg.alert);
      } else if (msg.type === "forward_response") {
        const payload: ResponsePayload = {
          alert_id: String(msg.alert_id ?? ""),
          accepted: Boolean(msg.accepted),
          responded_at: String(msg.responded_at ?? new Date().toISOString()),
          // Identity makes the round trip through the gateway: the admin sees
          // what the broker actually forwarded.
          user_id: String(msg.user_id ?? ""),
          username: String(msg.username ?? ""),
        };
        recordResponse(rt.db, payload.alert_id, payload.user_id, payload.accepted, payload.responded_at);
        rt.hub.notifyAdminResponse(payload);
        rt.hub.echoResponseToHousehold(payload);
      }
    });
    // However the socket ends, it leaves the pool. A leaked gateway socket
    // would turn fail-closed into fail-silent: green badge, vanishing alerts.
    ws.on("close", () => rt.hub.disconnect(ws, "gateway"));
    ws.on("error", () => rt.hub.disconnect(ws, "gateway"));
  }

  function close(): void {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  }

  return { handleUpgrade, close };
}
