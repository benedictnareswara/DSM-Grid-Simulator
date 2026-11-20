"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { DSMAlert } from "@/lib/types";

/** OS-level notifications for DSM alerts that have already arrived. */

export type NotificationSupport =
  | "ready" // secure context, API present
  | "insecure" // needs HTTPS — the usual case on a plain-HTTP LAN address
  | "unsupported"; // browser has no Notification API at all

interface UseAlertNotificationsReturn {
  support: NotificationSupport;
  permission: NotificationPermission;
  /** Must be called from a user gesture — Safari and Chrome both require it. */
  request: () => Promise<void>;
  notify: (alert: DSMAlert) => void;
}

/** Registered service worker, if any. Needed for showNotification(). */
let swRegistration: ServiceWorkerRegistration | null = null;

/*
 * Both values below are facts about the browser, not React state, so they are read through
 * useSyncExternalStore rather than copied into state by an effect.
 */

/** Support never changes for the life of the page — nothing to subscribe to. */
const subscribeNever = () => () => {};

function getSupport(): NotificationSupport {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  // A page served over plain http:// from anything other than localhost is not a secure context,
  // and browsers hide the Notification and service worker APIs there.
  if (!window.isSecureContext) return "insecure";
  return "ready";
}

/** Permission does change — after requestPermission() resolves. */
const permissionListeners = new Set<() => void>();

function subscribePermission(onChange: () => void) {
  permissionListeners.add(onChange);
  return () => {
    permissionListeners.delete(onChange);
  };
}

function getPermission(): NotificationPermission {
  if (typeof window === "undefined" || !("Notification" in window)) return "default";
  return Notification.permission;
}

const getPermissionOnServer = (): NotificationPermission => "default";
const getSupportOnServer = (): NotificationSupport => "unsupported";

/** OS notifications for arriving alerts, plus the service worker registration. */
export function useAlertNotifications(): UseAlertNotificationsReturn {
  const support = useSyncExternalStore(subscribeNever, getSupport, getSupportOnServer);
  const permission = useSyncExternalStore(
    subscribePermission,
    getPermission,
    getPermissionOnServer
  );

  useEffect(() => {
    if (getSupport() !== "ready" || !("serviceWorker" in navigator)) return;

    // Android Chrome refuses `new Notification()` outright and only allows
    // registration.showNotification(), so this is not optional there.
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((reg) => {
        swRegistration = reg;
      })
      .catch((err) => {
        console.warn("[SW] registration failed:", err);
      });
  }, []);

  const request = useCallback(async () => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    try {
      await Notification.requestPermission();
    } catch (err) {
      console.warn("[Notify] permission request failed:", err);
    }
    // Notification.permission is now the new value; nudge subscribers to re-read.
    permissionListeners.forEach((l) => l());
  }, []);

  const notify = useCallback(
    (alert: DSMAlert) => {
      if (support !== "ready" || permission !== "granted") return;

      const title = `${alert.severity.toUpperCase()} · ${alert.title}`;
      const options: NotificationOptions = {
        body: alert.message,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        // Collapse repeats of the same alert instead of stacking them.
        tag: `dsm-${alert.id}`,
        // Grid events are time-critical; keep them on screen until dismissed.
        requireInteraction:
          alert.severity === "emergency" || alert.severity === "critical",
      };

      try {
        if (swRegistration) {
          void swRegistration.showNotification(title, options);
        } else {
          new Notification(title, options);
        }
      } catch (err) {
        // Android Chrome throws TypeError on the bare constructor when no service worker is
        // available.
        console.warn("[Notify] could not show notification:", err);
      }
    },
    [support, permission]
  );

  return { support, permission, request, notify };
}
