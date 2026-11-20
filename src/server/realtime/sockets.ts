/** The three WebSocket endpoints, attached to the same HTTP server as the pages. */

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

// Server-side heartbeat.
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
        // Logged, because a rejected gateway otherwise looks exactly like an unplugged one.
        console.log("[WS] gateway handshake rejected — bad or missing GATEWAY_TOKEN (re-flash the gateway?)");
        // The ESP32 WebSocket library doesn't surface close reasons, so say it in a message first;
        // the firmware prints it.
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

  /** The gateway's socket. */
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
        const alert = msg.alert as { id?: unknown; tick?: unknown };
        markDelivered(rt.db, msg.alert as Record<string, never>);
        rt.hub.broadcastPushedAlert(msg.alert);
        if (alert.id) rt.hub.notifyAdminDelivered(String(alert.id), typeof alert.tick === "number" ? alert.tick : null);
      } else if (msg.type === "forward_response") {
        const payload: ResponsePayload = {
          alert_id: String(msg.alert_id ?? ""),
          accepted: Boolean(msg.accepted),
          responded_at: String(msg.responded_at ?? new Date().toISOString()),
          // Identity makes the round trip through the gateway: the admin sees what the broker
          // actually forwarded.
          user_id: String(msg.user_id ?? ""),
          username: String(msg.username ?? ""),
        };
        recordResponse(rt.db, payload.alert_id, payload.user_id, payload.accepted, payload.responded_at);
        rt.hub.notifyAdminResponse(payload);
        rt.hub.echoResponseToHousehold(payload);
      }
    });
    // However the socket ends, it leaves the pool.
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
