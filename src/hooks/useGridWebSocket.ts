"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  TickMessage,
  PushedAlertMessage,
  GridState,
  DSMAlert,
  DSMResponse,
  SimulationStatus,
  PersistedAlert,
  ParticipationEntry,
  AuditEntry,
  UserProfile,
  User,
  Thresholds,
  SavingsSummary,
  IncentiveModel,
} from "@/lib/types";
import { wsOrigin } from "@/lib/backend";
import { accessToken, clearSession, fetchWithAuth, refreshSession } from "@/hooks/useAuth";

const MAX_HISTORY = 120;

/**
 * Close code the backend uses for "your credentials are the problem" — a bad or missing handshake
 * token, the wrong role for this pool, or an account an operator just suspended or deleted
 * mid-session.
 */
const WS_UNAUTHORIZED = 4401;

interface UseGridWebSocketOptions {
  clientType: "admin" | "consumer";
  maxAlerts?: number;
}

interface UseGridWebSocketReturn {
  connected: boolean;
  gridState: GridState | null;
  alerts: DSMAlert[];          // Admin: alerts from simulator. Consumer: always empty.
  pushedAlerts: DSMAlert[];    // Consumer: admin-approved alerts via pushed_alert message.
  history: GridState[];
  status: SimulationStatus | null;
  responses: DSMResponse[];
  esp32Connected: boolean;     // Both: whether the ESP32 gateway is online.
  autopushEnabled: boolean;    // Admin: whether high-severity alerts self-push.
  consumerCount: number;       // Admin: how many consumer sockets are attached.
  /** Admin: how many distinct households those sockets belong to. */
  householdCount: number;
  /**
   * The session was rejected and could not be refreshed — suspended, deleted, or signed out
   * elsewhere.
   */
  authFailed: boolean;
  /** Increments on every `system_reset`. */
  resetNonce: number;
  /** Increments on every `accounts_changed`. */
  accountsNonce: number;
  /** Increments after a `dsm_response` lands. */
  responsesNonce: number;
  /** Increments after the gateway confirms an alert (`alert_delivered`). */
  deliveryNonce: number;
  /** The live trip points. */
  thresholds: Thresholds | null;
  /**
   * Consumer: this household's own answers, as the gateway recorded them — including ones given on
   * another device.
   */
  remoteDecisions: Record<string, { accepted: boolean; respondedAt: string }>;
  clearAlerts: () => void;
}

/** How long to wait for a burst of answers to finish before refetching. */
const RESPONSE_SETTLE_MS = 400;

/** Play a short notification beep using the Web Audio API. */
export function playAlertSound(frequency = 660, durationMs = 150) {
  try {
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = frequency;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationMs / 1000);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + durationMs / 1000);
    // Clean up context after sound finishes
    setTimeout(() => ctx.close(), durationMs + 100);
  } catch {
    // Web Audio not available — silent fallback
  }
}

/** The live connection to the backend, and the page's whole view of it. */
export function useGridWebSocket({
  clientType,
  maxAlerts = 50,
}: UseGridWebSocketOptions): UseGridWebSocketReturn {
  const [connected, setConnected] = useState(false);
  const [gridState, setGridState] = useState<GridState | null>(null);
  const [alerts, setAlerts] = useState<DSMAlert[]>([]);
  const [pushedAlerts, setPushedAlerts] = useState<DSMAlert[]>([]);
  const [history, setHistory] = useState<GridState[]>([]);
  const [status, setStatus] = useState<SimulationStatus | null>(null);
  const [responses, setResponses] = useState<DSMResponse[]>([]);
  const [esp32Connected, setEsp32Connected] = useState(false);
  const [autopushEnabled, setAutopushEnabled] = useState(false);
  const [consumerCount, setConsumerCount] = useState(0);
  const [householdCount, setHouseholdCount] = useState(0);
  const [resetNonce, setResetNonce] = useState(0);
  const [accountsNonce, setAccountsNonce] = useState(0);
  const [responsesNonce, setResponsesNonce] = useState(0);
  const [deliveryNonce, setDeliveryNonce] = useState(0);
  const [thresholds, setThresholds] = useState<Thresholds | null>(null);
  const [remoteDecisions, setRemoteDecisions] = useState<
    Record<string, { accepted: boolean; respondedAt: string }>
  >({});
  const [authFailed, setAuthFailed] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const responseSettleRef = useRef<NodeJS.Timeout | null>(null);
  const deliverySettleRef = useRef<NodeJS.Timeout | null>(null);

  const clearAlerts = useCallback(() => {
    setAlerts([]);
    setPushedAlerts([]);
  }, []);

  useEffect(() => {
    let isCleaningUp = false;

    function connect() {
      if (isCleaningUp) return;

      const token = accessToken();
      if (!token) {
        // Nothing to authenticate with.
        reconnectTimeoutRef.current = setTimeout(connect, 300);
        return;
      }

      // The token goes in the query string because the browser's WebSocket constructor cannot set
      // an Authorization header.
      const ws = new WebSocket(
        `${wsOrigin()}/ws/${clientType}?token=${encodeURIComponent(token)}`
      );
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setAuthFailed(false);
      };

      ws.onmessage = (event) => {
        try {
          const msg: TickMessage | PushedAlertMessage = JSON.parse(event.data);

          if (msg.type === "tick" && msg.state) {
            const state = msg.state as GridState;

            // Only update grid state if state has actual data
            if (state.tick !== undefined) {
              setGridState(state);
              setHistory((prev) => {
                const next = [...prev, state];
                return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
              });
              // `status` is only broadcast on control actions, so keep its position in step with
              // the ticks, or the progress bar freezes at whatever tick the last button press
              // happened on.
              setStatus((prev) =>
                prev
                  ? {
                      ...prev,
                      current_tick: state.tick + 1,
                      progress_pct: Math.round(((state.tick + 1) / Math.max(prev.total_ticks, 1)) * 10000) / 100,
                      current_timestamp: state.timestamp,
                    }
                  : prev,
              );
            }

            // Admin: collect alerts from simulator ticks
            if (clientType === "admin" && msg.alerts && msg.alerts.length > 0) {
              const arrived = msg.alerts;
              setAlerts((prev) => {
                const next = [...arrived, ...prev];
                return next.slice(0, maxAlerts);
              });
            }
          } else if (clientType === "consumer" && msg.type === "pushed_alert" && msg.alert) {
            // Consumer: receives admin-approved alerts
            const alert = msg.alert as DSMAlert;
            setPushedAlerts((prev) => [alert, ...prev].slice(0, maxAlerts));
          } else if (msg.type === "status" && msg.data) {
            setStatus(msg.data as SimulationStatus);
          } else if (msg.type === "dsm_response") {
            // Admin receives consumer participation responses
            const response: DSMResponse = {
              alert_id: msg.alert_id || "",
              accepted: msg.accepted || false,
              responded_at: msg.responded_at || new Date().toISOString(),
              // Empty only if the gateway relaying this predates identity — i.e. an ESP32 running
              // firmware from before the protocol change.
              user_id: msg.user_id || "",
              username: msg.username || "",
            };
            setResponses((prev) => [response, ...prev].slice(0, 100));

            // ...and tell the page to refetch its aggregates.
            if (responseSettleRef.current) clearTimeout(responseSettleRef.current);
            responseSettleRef.current = setTimeout(() => {
              responseSettleRef.current = null;
              setResponsesNonce((n) => n + 1);
            }, RESPONSE_SETTLE_MS);
          } else if (clientType === "admin" && msg.type === "alert_delivered") {
            // The gateway's echo landed and `delivered_at` is now stamped: a nudge to refetch,
            // carrying an id only.
            if (deliverySettleRef.current) clearTimeout(deliverySettleRef.current);
            deliverySettleRef.current = setTimeout(() => {
              deliverySettleRef.current = null;
              setDeliveryNonce((n) => n + 1);
            }, RESPONSE_SETTLE_MS);
          } else if (msg.type === "esp32_status") {
            // Live ESP32 gateway connection state, for admin and consumer alike.
            setEsp32Connected(Boolean(msg.connected));
          } else if (msg.type === "autopush_status") {
            // Admin: autopush toggle state — broadcast on change, and sent once on connect so
            // multiple tabs agree.
            setAutopushEnabled(Boolean(msg.enabled));
          } else if (msg.type === "client_count") {
            // Admin: how many consumer phones are attached, and how many distinct households they
            // belong to.
            setConsumerCount(Number(msg.consumers ?? 0));
            setHouseholdCount(Number(msg.households ?? msg.consumers ?? 0));
          } else if (clientType === "consumer" && msg.type === "my_response") {
            // This household's own answer, echoed back through the gateway so their other devices
            // agree.
            setRemoteDecisions((prev) => ({
              ...prev,
              [msg.alert_id || ""]: {
                accepted: Boolean(msg.accepted),
                respondedAt: msg.responded_at || new Date().toISOString(),
              },
            }));
          } else if (msg.type === "thresholds") {
            // Admin: the live trip points.
            setThresholds(msg.data as Thresholds);
          } else if (msg.type === "accounts_changed") {
            // A nudge, not data. The Accounts panel refetches on this.
            setAccountsNonce((n) => n + 1);
          } else if (msg.type === "system_reset") {
            // The operator reset the simulation.
            setAlerts([]);
            setPushedAlerts([]);
            setResponses([]);
            setHistory([]);
            setGridState(null);
            setResetNonce((n) => n + 1);
            setRemoteDecisions({});
            // Drop any answer still waiting to be coalesced.
            if (responseSettleRef.current) {
              clearTimeout(responseSettleRef.current);
              responseSettleRef.current = null;
            }
          }
        } catch (err) {
          console.error("[WS] Parse error:", err);
        }
      };

      ws.onclose = (event) => {
        setConnected(false);
        if (isCleaningUp) return;

        if (event.code === WS_UNAUTHORIZED) {
          // Two very different causes land here and they need different handling.
          refreshSession().then((ok) => {
            if (isCleaningUp) return;
            if (ok) {
              reconnectTimeoutRef.current = setTimeout(connect, 200);
            } else {
              console.warn("[WS] Session is no longer valid — signing out");
              setAuthFailed(true);
              clearSession();
            }
          });
          return;
        }

        reconnectTimeoutRef.current = setTimeout(connect, 2000);
      };

      ws.onerror = (err) => {
        // Closing a socket that is still connecting (React's dev double-mount does this) fires an
        // error that means nothing.
        if (!isCleaningUp) console.error("[WS] Error:", err);
        ws.close();
      };
    }

    connect();

    return () => {
      isCleaningUp = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (responseSettleRef.current) {
        clearTimeout(responseSettleRef.current);
        responseSettleRef.current = null;
      }
      if (deliverySettleRef.current) {
        clearTimeout(deliverySettleRef.current);
        deliverySettleRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [clientType, maxAlerts]);

  return { connected, gridState, alerts, pushedAlerts, history, status, responses, esp32Connected, autopushEnabled, consumerCount, householdCount, authFailed, resetNonce, accountsNonce, responsesNonce, deliveryNonce, thresholds, remoteDecisions, clearAlerts };
}

// ── API Helpers ──

/**
 * What the run-control endpoints return: a human-readable message plus the new run state, which the
 * caller can render without waiting for the `status` broadcast to arrive over the socket.
 */
export interface ControlResult {
  message: string;
  status: SimulationStatus;
}

/** What the two endpoints that cross the ESP32 gateway return. */
export interface RelayResult {
  message: string;
  esp32_connected: boolean;
}

const post = <T>(path: string): Promise<T> =>
  fetchWithAuth(path, { method: "POST" }).then((r) => r.json() as Promise<T>);

/** Start the simulation from its current tick. */
export async function apiStart(): Promise<ControlResult> {
  return post("/api/start");
}

/** Halt the simulation, keeping the tick. There is no Stop; see the note below. */
export async function apiPause(): Promise<ControlResult> {
  return post("/api/pause");
}

/** Resume from the tick Pause stopped on. */
export async function apiResume(): Promise<ControlResult> {
  return post("/api/resume");
}

// No apiStop().

/** Rewind to tick zero and clear every client's feed. */
export async function apiReset(): Promise<ControlResult> {
  return post("/api/reset");
}

/** Set the tick interval in milliseconds. Clamped server-side. */
export async function apiSetSpeed(intervalMs: number): Promise<ControlResult> {
  return post(`/api/speed?interval_ms=${intervalMs}`);
}

/** Turn automatic pushing of qualifying alerts on or off. */
export async function apiSetAutopush(enabled: boolean): Promise<ControlResult> {
  return post(`/api/autopush?enabled=${enabled}`);
}

/** Relay an alert to the gateway for delivery. */
export async function apiPushAlert(alert: Partial<DSMAlert>): Promise<RelayResult> {
  return fetchWithAuth("/api/alert/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(alert),
  }).then((r) => r.json() as Promise<RelayResult>);
}

/** Answer an alert on behalf of the signed-in household. */
export async function apiRespondToAlert(
  alertId: string,
  accepted: boolean
): Promise<RelayResult & { alert_id: string; accepted: boolean }> {
  // No user id in the call: the backend takes it from the access token.
  return post(`/api/alert/${alertId}/respond?accepted=${accepted}`);
}

// ── Persisted history ──

/** Filters for `apiGetAlertHistory`. Every field is optional. */
export interface AlertHistoryQuery {
  limit?: number;
  offset?: number;
  severity?: string;
  parameter?: string;
  /** "pending" | "ignored" | "delivered" | "failed" */
  outcome?: string;
}

/** A page of triggered alerts for the operator. */
export async function apiGetAlertHistory(q: AlertHistoryQuery = {}): Promise<PersistedAlert[]> {
  return fetchWithAuth(`/api/alerts${queryString(q)}`).then((r) => (r.ok ? r.json() : []));
}

/** Total triggered alerts. */
export async function apiGetAlertCount(): Promise<number> {
  return fetchWithAuth("/api/alerts/count").then(async (r) =>
    r.ok ? (await r.json()).total ?? 0 : 0
  );
}

/** Filters for `apiGetParticipation`. Every field is optional. */
export interface ParticipationQuery {
  limit?: number;
  offset?: number;
  user_id?: string;
  /** Answer filter. Left undefined for "either" — `false` is a real value here. */
  accepted?: boolean;
  severity?: string;
  parameter?: string;
}

/**
 * Filters are serialised with the same rule everywhere in this file: skip `undefined` and `""`,
 * send everything else.
 */
function queryString(q: object): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** A page of household responses, newest first, with their earned credit. */
export async function apiGetParticipation(
  q: ParticipationQuery = {}
): Promise<ParticipationEntry[]> {
  return fetchWithAuth(`/api/participation${queryString(q)}`).then((r) =>
    r.ok ? r.json() : []
  );
}

/** Retune the engine. */
export async function apiSetThresholds(next: Thresholds): Promise<boolean> {
  const res = await fetchWithAuth("/api/thresholds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(next),
  });
  return res.ok;
}

/** Compose an alert by hand and push it down the ordinary path. */
export async function apiPushTestAlert(req: {
  parameter: string;
  severity: string;
  duration_minutes: number;
  target_reduction_w?: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetchWithAuth("/api/alert/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (res.ok) return { ok: true };
  const detail = await res
    .json()
    .then((d) => (typeof d?.detail === "string" ? d.detail : null))
    .catch(() => null);
  return { ok: false, error: detail ?? `The backend rejected the alert (${res.status}).` };
}

/** Empty summaries rather than null, so a caller can render zeros without a branch. */
const EMPTY_SAVINGS: SavingsSummary = {
  accepted_count: 0,
  declined_count: 0,
  households: 0,
  total_kwh: 0,
  total_credit_idr: 0,
  offered_kwh: 0,
  offered_alerts: 0,
  current_streak: 0,
  streak_multiplier: 1,
  by_severity: [],
  by_parameter: [],
  series: [],
};

/** Programme-wide modelled savings. Admin only. */
export async function apiGetSavings(): Promise<SavingsSummary> {
  return fetchWithAuth("/api/savings").then((r) => (r.ok ? r.json() : EMPTY_SAVINGS));
}

/** This household's own modelled savings. */
export async function apiGetMySavings(): Promise<SavingsSummary> {
  return fetchWithAuth("/api/savings/mine").then((r) =>
    r.ok ? r.json() : EMPTY_SAVINGS
  );
}

/** The incentive model, so a client can explain a figure without restating it. */
export async function apiGetIncentiveModel(): Promise<IncentiveModel | null> {
  return fetchWithAuth("/api/incentives").then((r) => (r.ok ? r.json() : null));
}

/**
 * Total matching rows, so the log can say how many there are, not just how many fit on the page.
 */
export async function apiGetParticipationCount(
  q: Omit<ParticipationQuery, "limit" | "offset"> = {}
): Promise<number> {
  return fetchWithAuth(`/api/participation/count${queryString(q)}`).then(async (r) =>
    r.ok ? (await r.json()).total ?? 0 : 0
  );
}

/** Mark an alert ignored, or undo it. */
export async function apiIgnoreAlert(
  alertId: string,
  tick: number,
  ignored = true
): Promise<{ alert_id: string; ignored: boolean }> {
  return post(`/api/alert/${alertId}/ignore?tick=${tick}&ignored=${ignored}`);
}

// ── Audit ──

/** A page of the audit trail. Cleared entries are already excluded server-side. */
export async function apiGetAudit(
  q: { limit?: number; offset?: number; action?: string; target_id?: string } = {}
): Promise<AuditEntry[]> {
  return fetchWithAuth(`/api/audit${queryString(q)}`).then((r) => (r.ok ? r.json() : []));
}

/** Total uncleared audit entries, for the pager. */
export async function apiGetAuditCount(): Promise<number> {
  return fetchWithAuth("/api/audit/count").then(async (r) =>
    r.ok ? (await r.json()).total ?? 0 : 0
  );
}

/** Empty the operator's view of the audit log. */
export async function apiClearAudit(): Promise<MutationResult> {
  return mutate("/api/audit/clear");
}

/** One account plus its activity summary, for the account detail page. */
export async function apiGetUserProfile(id: string): Promise<UserProfile | null> {
  return fetchWithAuth(`/api/audit/user/${id}`).then((r) => (r.ok ? r.json() : null));
}

/** This household's delivered alerts, for rehydrating the feed after a reload. */
export async function apiGetMyAlertHistory(): Promise<PersistedAlert[]> {
  return fetchWithAuth("/api/alerts/mine").then((r) => (r.ok ? r.json() : []));
}

// ── Account management (admin) ──

/** Every account, for the Accounts panel. Returns [] rather than throwing. */
export async function apiListUsers(): Promise<User[]> {
  return fetchWithAuth("/api/admin/users").then((r) => (r.ok ? r.json() : []));
}

/** Account totals for the dashboard tile. */
export async function apiGetUserCounts(): Promise<{ total: number; pending: number }> {
  return fetchWithAuth("/api/admin/users/count").then(async (r) =>
    r.ok ? await r.json() : { total: 0, pending: 0 }
  );
}

/** The shape every account mutation returns. */
export interface MutationResult {
  ok: boolean;
  status: number;
  message?: string;
}

async function mutate(path: string, method = "POST"): Promise<MutationResult> {
  try {
    const res = await fetchWithAuth(path, { method });
    const body = await res.json().catch(() => ({}));
    return {
      ok: res.ok,
      status: res.status,
      message: body?.detail?.message ?? body?.message,
    };
  } catch {
    return { ok: false, status: 0, message: "Could not reach the backend." };
  }
}

/** Approve a pending household so it can sign in. */
export async function apiApproveUser(id: string) {
  return mutate(`/api/admin/users/${id}/approve`);
}

/** Suspend an account, revoking its tokens and dropping its sockets. */
export async function apiSuspendUser(id: string) {
  return mutate(`/api/admin/users/${id}/suspend`);
}

/** Return a suspended account to active. */
export async function apiReinstateUser(id: string) {
  return mutate(`/api/admin/users/${id}/reinstate`);
}

/** Delete an account. The audit entries naming it survive by design. */
export async function apiDeleteUser(id: string) {
  return mutate(`/api/admin/users/${id}`, "DELETE");
}

/** Set a household's password. */
export async function apiSetUserPassword(id: string, password: string) {
  const res = await fetchWithAuth(`/api/admin/users/${id}/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}
