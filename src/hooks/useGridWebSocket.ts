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
 * Close code the backend uses for "your credentials are the problem" — a bad or
 * missing handshake token, the wrong role for this pool, or an account an
 * operator just suspended or deleted mid-session.
 *
 * It exists because a browser reports a *rejected* handshake as 1006 with no
 * reason, indistinguishable from the server being down. Reconnecting forever
 * against 4401 would spin uselessly and never tell the user to sign in again,
 * so this is the one close code that stops the retry loop.
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
  /**
   * Admin: how many distinct households those sockets belong to. Differs from
   * `consumerCount` when one person has the app open twice — which used to be
   * indistinguishable from two participants.
   */
  householdCount: number;
  /**
   * The session was rejected and could not be refreshed — suspended, deleted,
   * or signed out elsewhere. Pages should send the user back to /login; the
   * hook has already cleared the stored session and stopped reconnecting.
   */
  authFailed: boolean;
  /**
   * Increments on every `system_reset`. Pages hold local per-alert state the
   * hook can't see (the admin's pushed/ignored/failed Sets, the consumer's
   * decisions map); using this as a React `key` on the subtree that owns them
   * discards it wholesale. That's the documented "reset state with a key"
   * pattern — no effect, nothing to keep in step by hand.
   */
  resetNonce: number;
  /**
   * Increments on every `accounts_changed`. Fired when anyone registers,
   * or when an operator approves/suspends/reinstates/deletes an account.
   *
   * The message carries no payload on purpose — the panel refetches through the
   * authenticated REST endpoint, so the broadcast itself cannot leak an account.
   * Before this, `AccountsPanel` fetched once on mount and never again, so a
   * household that signed up while the dashboard was open sat invisible in the
   * pending queue, unable to log in and with nobody aware they were waiting.
   */
  accountsNonce: number;
  /**
   * Increments after a `dsm_response` lands. Admin only.
   *
   * The same nudge-not-data shape as `accountsNonce`, and it exists for exactly
   * the same reason. A household answering used to update only the `responses`
   * array above — which is what an alert row's own tally reads — while every
   * *aggregate* on the dashboard sat still. The summary tiles and the savings
   * object are refetched on `historyNonce`, and only an **operator** action
   * bumps that. So an answer moved the row and left "Consumer participation",
   * "Energy saved" and the savings chart showing the figures from the last time
   * the operator happened to push something.
   *
   * Coalesced by RESPONSE_SETTLE_MS: one alert fans out to every connected
   * phone, so answers arrive in bursts, and a nonce per message would mean a
   * refetch per household.
   */
  responsesNonce: number;
  /**
   * The live trip points. Admin only.
   *
   * Sent once on connect and re-broadcast whenever an operator retunes, so a
   * second tab cannot go on labelling the gauges with a line the engine has
   * stopped honouring. `null` until the first message lands — callers fall back
   * to `DEFAULT_THRESHOLDS`, the same defaults the server starts with.
   */
  thresholds: Thresholds | null;
  /**
   * Consumer: this household's own answers, as the gateway recorded them —
   * including ones given on another device.
   *
   * Keyed by `alert_id` because that is all the echo carries; the page merges
   * it under its own `id + tick` key. The same household with the web app open
   * on a laptop and a phone used to see the two disagree
   * about what had been answered, and about the savings total, until one of
   * them was reloaded.
   */
  remoteDecisions: Record<string, { accepted: boolean; respondedAt: string }>;
  clearAlerts: () => void;
}

/**
 * How long to wait for a burst of answers to finish before refetching.
 *
 * An alert goes to every household at once, so their replies arrive together.
 * Long enough to collapse a fan-out into one refetch, short enough that the
 * operator reads it as live.
 */
const RESPONSE_SETTLE_MS = 400;

/**
 * Play a short notification beep using the Web Audio API.
 * No external files needed — generates a sine wave programmatically.
 */
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

/**
 * The live connection to the backend, and the page's whole view of it.
 *
 * One socket per call — this hook is per-instance, not a singleton. Under
 * `app/admin` call `useAdminSocket()` from GridSocketProvider instead:
 * calling this directly there gives the tab two sockets, two copies of the
 * feed and two `system_reset` handlers, which looks entirely normal in the UI
 * and is only visible in Network -> WS.
 *
 * Reconnects on its own with a fixed backoff, and refreshes the access token
 * once on a 4401 close before giving up.
 */
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
  const [thresholds, setThresholds] = useState<Thresholds | null>(null);
  const [remoteDecisions, setRemoteDecisions] = useState<
    Record<string, { accepted: boolean; respondedAt: string }>
  >({});
  const [authFailed, setAuthFailed] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const responseSettleRef = useRef<NodeJS.Timeout | null>(null);

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
        // Nothing to authenticate with. Retry rather than give up: on a cold
        // load this effect can run a tick before useAuth has hydrated the
        // session out of sessionStorage.
        reconnectTimeoutRef.current = setTimeout(connect, 300);
        return;
      }

      // The token goes in the query string because the browser's WebSocket
      // constructor cannot set an Authorization header. Not a preference — the
      // API offers no other option. See the note above the WS endpoints in
      // src/server/realtime/sockets.ts for the trade-off.
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
              // `status` is only broadcast on control actions, so keep its
              // position in step with the ticks, or the progress bar freezes
              // at whatever tick the last button press happened on.
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
              // Empty only if the gateway relaying this predates identity —
              // i.e. an ESP32 running firmware from before the protocol change.
              user_id: msg.user_id || "",
              username: msg.username || "",
            };
            setResponses((prev) => [response, ...prev].slice(0, 100));

            // ...and tell the page to refetch its aggregates. The line above
            // only updates this socket's own list, which is capped at 100 and
            // is not what the summary tiles or the savings totals read.
            if (responseSettleRef.current) clearTimeout(responseSettleRef.current);
            responseSettleRef.current = setTimeout(() => {
              responseSettleRef.current = null;
              setResponsesNonce((n) => n + 1);
            }, RESPONSE_SETTLE_MS);
          } else if (msg.type === "esp32_status") {
            // Live ESP32 gateway connection state, for admin and consumer
            // alike. Also sent once on connect, so a dashboard opened while the
            // gateway is already up renders the correct badge instead of
            // waiting for a transition.
            setEsp32Connected(Boolean(msg.connected));
          } else if (msg.type === "autopush_status") {
            // Admin: autopush toggle state — broadcast on change, and sent once
            // on connect so multiple tabs agree.
            setAutopushEnabled(Boolean(msg.enabled));
          } else if (msg.type === "client_count") {
            // Admin: how many consumer phones are attached, and how many
            // distinct households they belong to. Broadcast on consumer
            // connect/disconnect and sent once on connect.
            setConsumerCount(Number(msg.consumers ?? 0));
            setHouseholdCount(Number(msg.households ?? msg.consumers ?? 0));
          } else if (clientType === "consumer" && msg.type === "my_response") {
            // This household's own answer, echoed back through the gateway so
            // their other devices agree. Carries no alert content — see
            // `echoResponseToHousehold` in src/server/realtime/hub.ts.
            setRemoteDecisions((prev) => ({
              ...prev,
              [msg.alert_id || ""]: {
                accepted: Boolean(msg.accepted),
                respondedAt: msg.responded_at || new Date().toISOString(),
              },
            }));
          } else if (msg.type === "thresholds") {
            // Admin: the live trip points. Sent once on connect and again on
            // every retune, so the gauge labels follow the engine rather than
            // whatever was true when this tab mounted.
            setThresholds(msg.data as Thresholds);
          } else if (msg.type === "accounts_changed") {
            // A nudge, not data. The Accounts panel refetches on this.
            setAccountsNonce((n) => n + 1);
          } else if (msg.type === "system_reset") {
            // The operator reset the simulation. Every feed here is
            // client-side, so a reset that isn't announced leaves three
            // dashboards showing a run that no longer exists. Clear everything
            // this hook owns and bump the nonce so pages can drop theirs.
            setAlerts([]);
            setPushedAlerts([]);
            setResponses([]);
            setHistory([]);
            setGridState(null);
            setResetNonce((n) => n + 1);
            setRemoteDecisions({});
            // Drop any answer still waiting to be coalesced. `resetNonce` is
            // already a refetch trigger everywhere `responsesNonce` is, so
            // letting it fire would be a second request for the same rows.
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
          // Two very different causes land here and they need different
          // handling. An expired access token is routine — the socket outlives
          // the 15-minute JWT, so refresh once and reconnect silently. But if
          // the refresh fails, the account itself is gone (suspended, deleted,
          // or signed out elsewhere), and retrying would spin forever against a
          // door that will never open.
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
        // Closing a socket that is still connecting (React's dev double-mount
        // does this) fires an error that means nothing.
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
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [clientType, maxAlerts]);

  return { connected, gridState, alerts, pushedAlerts, history, status, responses, esp32Connected, autopushEnabled, consumerCount, householdCount, authFailed, resetNonce, accountsNonce, responsesNonce, thresholds, remoteDecisions, clearAlerts };
}

// ── API Helpers ──
//
// Every one of these goes through fetchWithAuth, which attaches the bearer
// token and retries once through a refresh on 401. Without that retry a
// dashboard left open would start failing fifteen minutes in, when the access
// token expires.

/**
 * What the run-control endpoints return: a human-readable message plus the
 * new run state, which the caller can render without waiting for the
 * `status` broadcast to arrive over the socket.
 */
export interface ControlResult {
  message: string;
  status: SimulationStatus;
}

/**
 * What the two endpoints that cross the ESP32 gateway return.
 *
 * `esp32_connected` is the fail-closed signal and the reason these have their
 * own shape: a push with no gateway attached still returns 200, and this flag
 * is the only thing distinguishing "delivered" from "dropped".
 */
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

// No apiStop(). The endpoint is still there, but the dashboard has no Stop
// control — halting is Pause, rewinding is Reset. See the toolbar comment in
// app/admin/page.tsx.

/**
 * Rewind to tick zero and clear every client's feed.
 *
 * System-wide: the backend keeps no alert history, so this broadcasts
 * `system_reset` and each client empties itself.
 */
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

/**
 * Relay an alert to the gateway for delivery.
 *
 * Check `esp32_connected` on the result: with no gateway attached the alert
 * is dropped rather than queued, and the call still resolves 200.
 */
export async function apiPushAlert(alert: Partial<DSMAlert>): Promise<RelayResult> {
  return fetchWithAuth("/api/alert/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(alert),
  }).then((r) => r.json() as Promise<RelayResult>);
}

/**
 * Answer an alert on behalf of the signed-in household.
 *
 * Routes through the gateway like the push did, so the admin hears about it
 * only if the ESP32 forwards it.
 */
export async function apiRespondToAlert(
  alertId: string,
  accepted: boolean
): Promise<RelayResult & { alert_id: string; accepted: boolean }> {
  // No user id in the call: the backend takes it from the access token. A
  // client-supplied one would let any household answer for any other.
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

/**
 * A page of triggered alerts for the operator.
 *
 * Deliberately unfiltered by delivery: seeing a push that never landed is the
 * operator's reason for looking. The consumer's own history is gated instead —
 * see `apiGetMyAlertHistory`.
 */
export async function apiGetAlertHistory(q: AlertHistoryQuery = {}): Promise<PersistedAlert[]> {
  return fetchWithAuth(`/api/alerts${queryString(q)}`).then((r) => (r.ok ? r.json() : []));
}

/**
 * Total triggered alerts.
 *
 * Read from the endpoint rather than counted from `feed`, which is only the
 * hydrate window merged with this socket's arrivals and would silently stop
 * climbing at 200.
 */
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
 * Filters are serialised with the same rule everywhere in this file: skip
 * `undefined` and `""`, send everything else. `accepted: false` therefore has
 * to survive, which is why the guard tests those two cases rather than
 * falsiness — a `!v` check would silently turn "declined only" into "any".
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

/**
 * Retune the engine.
 *
 * Every field is optional on the wire — the backend drops nulls and merges the
 * rest — but the panel always sends all six, because a partial post is how two
 * operators tuning at once end up with a set neither of them chose.
 *
 * No local state to set: the backend broadcasts `thresholds` to every admin
 * socket, including this one, which is what re-labels the gauges.
 */
export async function apiSetThresholds(next: Thresholds): Promise<boolean> {
  const res = await fetchWithAuth("/api/thresholds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(next),
  });
  return res.ok;
}

/**
 * Compose an alert by hand and push it down the ordinary path.
 *
 * The backend builds the whole alert from the live grid — this sends only what
 * kind, how hard, and optionally how much. It deliberately does *not* mint an
 * id, a tick or any prose: the result is meant to be indistinguishable from a
 * triggered alert, and text written in a browser would not be.
 *
 * `target_reduction_w` is omitted unless the operator typed over the
 * pre-filled default, so an untouched form produces an alert arithmetically
 * identical to a real one. See `POST /api/alert/test`.
 *
 * Returns the error text rather than a boolean, because the two failures worth
 * distinguishing here — a rejected parameter and a backend with no dataset —
 * read very differently to whoever is holding the phone.
 */
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

/**
 * This household's own modelled savings.
 *
 * The household comes from the access token — there is no id parameter, and
 * there must not be one.
 */
export async function apiGetMySavings(): Promise<SavingsSummary> {
  return fetchWithAuth("/api/savings/mine").then((r) =>
    r.ok ? r.json() : EMPTY_SAVINGS
  );
}

/**
 * The incentive model, so a client can explain a figure without restating it.
 *
 * Static for the life of the backend, so callers fetch it once on mount.
 */
export async function apiGetIncentiveModel(): Promise<IncentiveModel | null> {
  return fetchWithAuth("/api/incentives").then((r) => (r.ok ? r.json() : null));
}

/** Total matching rows, so the log can say how many there are, not just how
 *  many fit on the page. Takes the same filters as the list above — a count
 *  that filtered differently would be a pager that lies. */
export async function apiGetParticipationCount(
  q: Omit<ParticipationQuery, "limit" | "offset"> = {}
): Promise<number> {
  return fetchWithAuth(`/api/participation/count${queryString(q)}`).then(async (r) =>
    r.ok ? (await r.json()).total ?? 0 : 0
  );
}

/**
 * Mark an alert ignored, or undo it.
 *
 * Note this never touches the gateway: ignoring is a decision *not* to deliver,
 * so there is nothing to relay. It was browser-only state until now, which is
 * why the mark vanished whenever the tab closed.
 */
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

/**
 * Empty the operator's view of the audit log.
 *
 * Nothing is deleted — the backend stamps `cleared_at` and the read endpoints
 * filter on it, the same soft clear a simulation reset performs on alerts. The
 * clear is itself written into the log, after the sweep, so it survives as the
 * first visible row. See the docstring on `POST /api/audit/clear`.
 */
export async function apiClearAudit(): Promise<MutationResult> {
  return mutate("/api/audit/clear");
}

/** One account plus its activity summary, for the account detail page. */
export async function apiGetUserProfile(id: string): Promise<UserProfile | null> {
  return fetchWithAuth(`/api/audit/user/${id}`).then((r) => (r.ok ? r.json() : null));
}

/**
 * This household's delivered alerts, for rehydrating the feed after a reload.
 * The backend only returns alerts the ESP32 actually forwarded — see the
 * header of src/server/history.ts.
 */
export async function apiGetMyAlertHistory(): Promise<PersistedAlert[]> {
  return fetchWithAuth("/api/alerts/mine").then((r) => (r.ok ? r.json() : []));
}

// ── Account management (admin) ──

/** Every account, for the Accounts panel. Returns [] rather than throwing. */
export async function apiListUsers(): Promise<User[]> {
  return fetchWithAuth("/api/admin/users").then((r) => (r.ok ? r.json() : []));
}

/**
 * Account totals for the dashboard tile.
 *
 * Separate from `apiListUsers` because the tile renders two numbers and was
 * fetching every account's full record to derive them.
 */
export async function apiGetUserCounts(): Promise<{ total: number; pending: number }> {
  return fetchWithAuth("/api/admin/users/count").then(async (r) =>
    r.ok ? await r.json() : { total: 0, pending: 0 }
  );
}

/**
 * The shape every account mutation returns.
 *
 * `ok` is the HTTP status, not the presence of an error field. The panel used
 * to infer success from `detail.message` being absent, so a 500 with an
 * unexpected body — or a network failure returning nothing — read as a
 * completed delete. Silent failure on a destructive action is the one outcome
 * worth engineering against.
 */
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

/**
 * Set a household's password.
 *
 * The useful form of "manage credentials": bcrypt is one-way, so there is
 * nothing to display and nothing to recover — replacement is the only real
 * capability. Every session for that account is signed out server-side.
 */
export async function apiSetUserPassword(id: string, password: string) {
  const res = await fetchWithAuth(`/api/admin/users/${id}/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}
