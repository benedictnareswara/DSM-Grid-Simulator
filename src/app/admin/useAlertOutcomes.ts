"use client";

import { useCallback, useMemo, useState } from "react";
import {
  apiIgnoreAlert,
  apiPushAlert,
} from "@/hooks/useGridWebSocket";
import type { DSMAlert, PersistedAlert } from "@/lib/types";
import { keyOf, type Outcome } from "./AlertRow";

/**
 * Who decides what happened to an alert, and the actions that change it.
 *
 * Pulled out of the dashboard because it is one coherent piece of state with
 * three sources that have to be ranked against each other, and it was the
 * hardest thing to find in an 1,100-line page.
 *
 * The ranking, highest first:
 *
 * 1. **This tab's own click** (`outcomes`) — optimistic, so a button shows its
 *    effect before the round trip finishes. Not a second source of truth: it is
 *    overtaken as soon as the database catches up.
 * 2. **The stored row** (`storedByKey`) — the authority, and what survives a
 *    reload, a logout or a backend restart.
 * 3. **The tick payload** — only for an arrival whose trigger write is still in
 *    flight, where autopush has already reported what it did.
 */
export function useAlertOutcomes({
  stored,
  onMutated,
}: {
  stored: PersistedAlert[];
  /** Called after any action, so the caller can refetch the stored rows. */
  onMutated: () => void;
}) {
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [pushing, setPushing] = useState<Set<string>>(new Set());

  // Memoised because `outcomeOf` closes over it: rebuilding the Map every
  // render would give every AlertRow a new callback identity on every tick.
  const storedByKey = useMemo(
    () => new Map(stored.map((s) => [s.alert_id + s.tick, s])),
    [stored]
  );

  /**
   * An alert's outcome, local action taking precedence over what autopush
   * already did to it. An autopush that hit an offline gateway is reported as
   * `failed`, not as handled — it is exactly as undelivered as a manual push
   * that failed, and until now it was the one case with no way back.
   */
  const outcomeOf = useCallback(
    (alert: DSMAlert): Outcome | null => {
      const key = keyOf(alert);
      const local = outcomes[key];
      if (local) return local;

      const row = storedByKey.get(key);
      if (row?.outcome) return row.outcome as Outcome;
      if (row) return null; // known to the database, and genuinely pending

      if (alert.auto_push_status === "sent") return "auto-pushed";
      if (alert.auto_push_status === "esp32_offline") return "failed-gateway";
      return null;
    },
    [outcomes, storedByKey]
  );

  /**
   * Push (or re-push) one alert. Resend is deliberately this same call: it
   * goes through POST /api/alert/push -> relay_alert_to_esp32() like any other
   * push, so a retry is still gated on the gateway being up. Nothing is
   * buffered and nothing re-sends itself.
   */
  const pushAlert = useCallback(
    async (alert: DSMAlert) => {
      const key = keyOf(alert);
      setPushing((prev) => new Set(prev).add(key));

      let outcome: Outcome = "failed-request";
      try {
        const result = await apiPushAlert(alert);
        // A push with no gateway attached returns 200 with esp32_connected
        // false — fail-closed, the alert was dropped, not delivered.
        outcome = result?.esp32_connected ? "pushed" : "failed-gateway";
      } catch (err) {
        // A network throw is just as undelivered as a rejected push, and used
        // to vanish into the console leaving the row stuck on "Pushing…".
        console.error("Push alert failed:", err);
      }

      setOutcomes((prev) => ({ ...prev, [key]: outcome }));
      setPushing((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      onMutated();
    },
    [onMutated]
  );

  /**
   * Ignore persists. It used to be local-only, so the mark vanished with the
   * tab and the alert came back as pending on the next load — which is a
   * decision quietly un-made.
   *
   * Note this never touches the gateway: ignoring is a decision *not* to
   * deliver, so there is nothing to relay.
   */
  const ignoreAlert = useCallback(
    async (alert: DSMAlert) => {
      setOutcomes((prev) => ({ ...prev, [keyOf(alert)]: "ignored" }));
      try {
        await apiIgnoreAlert(alert.id, alert.tick, true);
      } catch (err) {
        console.error("Ignore failed:", err);
      }
      onMutated();
    },
    [onMutated]
  );

  const undoIgnore = useCallback(
    async (alert: DSMAlert) => {
      setOutcomes((prev) => {
        const next = { ...prev };
        delete next[keyOf(alert)];
        return next;
      });
      try {
        await apiIgnoreAlert(alert.id, alert.tick, false);
      } catch (err) {
        console.error("Undo ignore failed:", err);
      }
      onMutated();
    },
    [onMutated]
  );

  /** A reset purges every feed, so these outcomes describe alerts that are gone. */
  const clear = useCallback(() => {
    setOutcomes({});
    setPushing(new Set());
  }, []);

  return { outcomeOf, pushAlert, ignoreAlert, undoIgnore, pushing, clear };
}
