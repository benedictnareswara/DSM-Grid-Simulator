/**
 * The WebSocket hub: three pools of sockets (admin, consumer, gateway) and what
 * each is allowed to hear.
 *
 * The rule that matters: alerts and responses go through the ESP32 gateway,
 * and it fails closed. Only the gateway receives `relay_alert` /
 * `relay_response`, and only its own `forward_alert` / `forward_response` echo
 * reaches the other side. With no gateway connected, nothing is delivered.
 * There is no direct admin↔consumer path.
 */

import { WebSocket } from "ws";
import type { DSMAlert, GridState, SimulationStatus, Thresholds } from "@/lib/types";

export type Pool = "admin" | "consumer" | "gateway";

export interface Identity {
  user_id: string;
  username: string;
  role: string;
}

export interface ResponsePayload {
  alert_id: string;
  accepted: boolean;
  responded_at: string;
  user_id: string;
  username: string;
}

/** WebSocket close code meaning "your session is bad: stop retrying and sign in again". */
export const WS_UNAUTHORIZED = 4401;

export class Hub {
  readonly pools: Record<Pool, Set<WebSocket>> = {
    admin: new Set(),
    consumer: new Set(),
    gateway: new Set(),
  };
  // Who is behind each dashboard socket. Used to force a suspended or deleted
  // user off a live socket, and to count households rather than open tabs.
  readonly identities = new Map<WebSocket, Identity>();

  /** Whether a gateway is attached: the gate every alert path checks. */
  get gatewayConnected(): boolean {
    return this.pools.gateway.size > 0;
  }

  connect(ws: WebSocket, pool: Pool, identity?: Identity): void {
    this.pools[pool].add(ws);
    if (identity) this.identities.set(ws, identity);
    const who = identity ? ` [${identity.username}]` : "";
    console.log(`[WS] ${pool} client connected${who}. ${this.counts()}`);

    if (pool === "gateway") {
      this.broadcastGatewayStatus();
    } else if (pool === "consumer") {
      this.broadcastClientCount();
      // Lets the phone tell "no alerts because the grid is calm" apart from
      // "no alerts because nothing can reach me".
      this.sendTo(ws, this.gatewayStatusMsg(), "consumer");
    } else {
      // A dashboard opened while the gateway is already up would otherwise show
      // it offline until the next change.
      this.sendTo(ws, this.gatewayStatusMsg(), "admin");
      this.sendTo(ws, this.clientCountMsg(), "admin");
    }
  }

  disconnect(ws: WebSocket, pool: Pool): void {
    const had = this.pools[pool].delete(ws);
    this.identities.delete(ws);
    if (!had) return;
    console.log(`[WS] ${pool} client disconnected. ${this.counts()}`);
    this.announcePoolChange(pool);
  }

  private counts(): string {
    return `Admin: ${this.pools.admin.size}, Consumer: ${this.pools.consumer.size}, Gateway: ${this.pools.gateway.size}`;
  }

  // ── Telemetry ──────────────────────────────────────────────────────────────

  /**
   * Admins get the tick with its alerts. Consumers get the same telemetry with
   * `alerts: []`, rebuilt rather than filtered, so no alert can slip through
   * outside the gateway path.
   */
  broadcastTick(state: GridState, alerts: DSMAlert[]): void {
    this.sendToPool("admin", JSON.stringify({ type: "tick", state, alerts }));
    this.sendToPool("consumer", JSON.stringify({ type: "tick", state, alerts: [] }));
  }

  // ── The gateway-brokered alert path ────────────────────────────────────────

  /** An approved alert goes ONLY to the gateway. Without one, it's dropped. */
  relayAlertToGateway(alert: DSMAlert): void {
    this.sendToPool("gateway", JSON.stringify({ type: "relay_alert", alert }));
  }

  /** Only called when the gateway echoes `forward_alert`. */
  broadcastPushedAlert(alert: unknown): void {
    this.sendToPool("consumer", JSON.stringify({ type: "pushed_alert", alert }));
  }

  /** A household's answer goes ONLY to the gateway. Without one, the admin never hears it. */
  relayResponseToGateway(response: ResponsePayload): void {
    this.sendToPool("gateway", JSON.stringify({ type: "relay_response", ...response }));
  }

  /** Only called when the gateway echoes `forward_response`. */
  notifyAdminResponse(response: ResponsePayload): void {
    this.sendToPool("admin", JSON.stringify({ type: "dsm_response", ...response }));
  }

  /**
   * Reflect a household's own answer to their other open devices. Same
   * gateway-gated handler as notifyAdminResponse, and it carries an alert id,
   * never an alert, so it can't show a phone anything new.
   */
  echoResponseToHousehold(response: ResponsePayload): void {
    if (!response.user_id) return;
    const msg = JSON.stringify({
      type: "my_response",
      alert_id: response.alert_id,
      accepted: Boolean(response.accepted),
      responded_at: response.responded_at,
    });
    for (const [ws, ident] of this.identities) {
      if (this.pools.consumer.has(ws) && ident.user_id === response.user_id) {
        this.sendTo(ws, msg, "consumer");
      }
    }
  }

  // ── Control-plane messages (carry no alert content) ────────────────────────

  private gatewayStatusMsg(): string {
    // `esp32_status` is the historical wire name; the pages switch on it.
    return JSON.stringify({ type: "esp32_status", connected: this.gatewayConnected });
  }

  broadcastGatewayStatus(): void {
    const msg = this.gatewayStatusMsg();
    this.sendToPool("admin", msg);
    this.sendToPool("consumer", msg);
  }

  private clientCountMsg(): string {
    // `consumers` = sockets an alert fans out to; `households` = distinct people behind them.
    const households = new Set<string>();
    for (const [ws, ident] of this.identities) {
      if (this.pools.consumer.has(ws) && ident.user_id) households.add(ident.user_id);
    }
    return JSON.stringify({ type: "client_count", consumers: this.pools.consumer.size, households: households.size });
  }

  broadcastClientCount(): void {
    this.sendToPool("admin", this.clientCountMsg());
  }

  /** A nudge to refetch the account list. Admin pool only; carries no data. */
  broadcastAccountsChanged(): void {
    this.sendToPool("admin", JSON.stringify({ type: "accounts_changed" }));
  }

  /** Tell every dashboard to empty its feed. Can only make a client discard data. */
  broadcastSystemReset(): void {
    const msg = JSON.stringify({ type: "system_reset" });
    this.sendToPool("admin", msg);
    this.sendToPool("consumer", msg);
  }

  broadcastStatus(status: SimulationStatus): void {
    const msg = JSON.stringify({ type: "status", data: status });
    this.sendToPool("admin", msg);
    this.sendToPool("consumer", msg);
  }

  sendStatusTo(ws: WebSocket, status: SimulationStatus): void {
    this.sendTo(ws, JSON.stringify({ type: "status", data: status }), "admin");
  }

  broadcastAutopushStatus(enabled: boolean): void {
    this.sendToPool("admin", JSON.stringify({ type: "autopush_status", enabled }));
  }

  sendAutopushStatusTo(ws: WebSocket, enabled: boolean): void {
    this.sendTo(ws, JSON.stringify({ type: "autopush_status", enabled }), "admin");
  }

  /** Operator settings: admin pool only. */
  broadcastThresholds(thresholds: Thresholds): void {
    this.sendToPool("admin", JSON.stringify({ type: "thresholds", data: thresholds }));
  }

  sendThresholdsTo(ws: WebSocket, thresholds: Thresholds): void {
    this.sendTo(ws, JSON.stringify({ type: "thresholds", data: thresholds }), "admin");
  }

  /**
   * Close every socket belonging to one account (suspend, delete, password
   * reset). An access JWT can't be revoked, so without this a removed user
   * keeps streaming until it expires.
   */
  disconnectUser(userId: string): number {
    const doomed = [...this.identities].filter(([, ident]) => ident.user_id === userId).map(([ws]) => ws);
    for (const ws of doomed) {
      try {
        ws.close(WS_UNAUTHORIZED, "Account access revoked");
      } catch {
        // Already gone.
      }
      this.pools.admin.delete(ws);
      this.pools.consumer.delete(ws);
      this.identities.delete(ws);
    }
    if (doomed.length) {
      console.log(`[WS] Closed ${doomed.length} socket(s) for revoked user ${userId}`);
      this.broadcastClientCount();
    }
    return doomed.length;
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  /**
   * Fire the notification disconnect() would have after a reap. The badge is
   * the operator's first diagnostic, so it must not stay green for a gateway
   * that died.
   */
  private announcePoolChange(pool: Pool): void {
    if (pool === "gateway") this.broadcastGatewayStatus();
    else if (pool === "consumer") this.broadcastClientCount();
  }

  private reap(ws: WebSocket, pool: Pool): void {
    if (this.pools[pool].delete(ws)) {
      this.identities.delete(ws);
      this.announcePoolChange(pool);
    }
  }

  private sendTo(ws: WebSocket, message: string, pool: Pool): void {
    if (ws.readyState !== WebSocket.OPEN) {
      this.reap(ws, pool);
      return;
    }
    ws.send(message, (err) => {
      if (err) this.reap(ws, pool);
    });
  }

  private sendToPool(pool: Pool, message: string): void {
    for (const ws of [...this.pools[pool]]) this.sendTo(ws, message, pool);
  }
}
