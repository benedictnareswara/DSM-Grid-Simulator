"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DELIVERY_GRACE_MS } from "@/lib/constants";
import {
  apiIgnoreAlert,
  apiPushAlert,
} from "@/hooks/useGridWebSocket";
import type { DSMAlert, PersistedAlert } from "@/lib/types";
import { keyOf, type Outcome } from "./AlertRow";

/** Who decides what happened to an alert, and the actions that change it. */
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

  // Memoised because `outcomeOf` closes over it: rebuilding the Map every render would give every
  // AlertRow a new callback identity on every tick.
  const storedByKey = useMemo(
    () => new Map(stored.map((s) => [s.alert_id + s.tick, s])),
    [stored]
  );

  /** An alert's outcome, local action taking precedence over what autopush already did to it. */
  const outcomeOf = useCallback(
    (alert: DSMAlert): Outcome | null => {
      const key = keyOf(alert);
      const local = outcomes[key];
      const row = storedByKey.get(key);

      // A click's optimistic mark only stands until the database has a settled answer.
      if (local && !(local === "sending" && row?.outcome && row.outcome !== "sending")) return local;
      if (row?.outcome) return row.outcome as Outcome;
      if (row) return null; // known to the database, and genuinely pending

      // Tick payloads only say autopush *handed it over*, not that it arrived.
      if (alert.auto_push_status === "sent") return "sending";
      if (alert.auto_push_status === "esp32_offline") return "failed-gateway";
      return null;
    },
    [outcomes, storedByKey]
  );

  // A push the gateway never confirms sits in "sending" until the grace window ends.
  const awaitingEcho = stored.some((s) => s.outcome === "sending") ||
    Object.values(outcomes).includes("sending");
  useEffect(() => {
    if (!awaitingEcho) return;
    const t = setTimeout(onMutated, DELIVERY_GRACE_MS + 1_000);
    return () => clearTimeout(t);
  }, [awaitingEcho, stored, onMutated]);

  /** Push (or re-push) one alert. */
  const pushAlert = useCallback(
    async (alert: DSMAlert) => {
      const key = keyOf(alert);
      setPushing((prev) => new Set(prev).add(key));

      let outcome: Outcome = "failed-request";
      try {
        const result = await apiPushAlert(alert);
        // A push with no gateway attached returns 200 with esp32_connected false — fail-closed, the
        // alert was dropped, not delivered.
        outcome = result?.esp32_connected ? "sending" : "failed-gateway";
      } catch (err) {
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

  /** Ignore persists. */
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
