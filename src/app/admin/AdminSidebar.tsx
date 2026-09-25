"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/components/Icon";
import { useAuth } from "@/hooks/useAuth";
import { useTheme } from "@/hooks/useTheme";
import {
  apiGetAlertCount,
  apiGetAuditCount,
  apiGetParticipationCount,
  apiGetUserCounts,
} from "@/hooks/useGridWebSocket";
import { useAdminSocket } from "./GridSocketProvider";
import type { ThemePreference } from "@/lib/theme";

/**
 * The admin shell's navigation rail.
 *
 * ## What this replaced
 *
 * Three separate things said where you were and where you could go: five text
 * chips wedged into the page header under the `<h1>`, five `SummaryTiles` on
 * the dashboard that were navigation wearing a count, and two card-head "View
 * all" links. The tiles were the worst of it — two of the five pointed at the
 * same route, and none of them existed anywhere except the dashboard, so the
 * counts they carried vanished the moment you navigated.
 *
 * All three collapse into this: one row per destination, carrying its own
 * count, present on every admin screen.
 *
 * ## Counts come from the /count endpoints
 *
 * Not from any page's arrays. The dashboard's feed is a 200-row hydrate
 * window — correct for a feed, wrong for a total, which would silently stop
 * climbing at 200. That rule predates this component; it is restated here
 * because the tiles that used to hold it are gone.
 */

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  /** Which count endpoint feeds the badge, if any. */
  count?: keyof Counts;
}

const NAV: NavItem[] = [
  { href: "/admin", label: "Control Room", icon: "dashboard" },
  { href: "/admin/alerts", label: "Alerts", icon: "alerts", count: "alerts" },
  { href: "/admin/participation", label: "Participation", icon: "history", count: "responses" },
  { href: "/admin/accounts", label: "Accounts", icon: "people", count: "accounts" },
  { href: "/admin/audit", label: "Audit log", icon: "audit", count: "audit" },
];

interface Counts {
  alerts: number | null;
  responses: number | null;
  accounts: number | null;
  audit: number | null;
  /** Not a nav badge — drives the "waiting for approval" dot. */
  pendingAccounts: number | null;
}

const EMPTY_COUNTS: Counts = {
  alerts: null,
  responses: null,
  accounts: null,
  audit: null,
  pendingAccounts: null,
};

const THEMES: { id: ThemePreference; icon: IconName; label: string }[] = [
  { id: "light", icon: "sun", label: "Light" },
  { id: "dark", icon: "moon", label: "Dark" },
  { id: "system", icon: "auto", label: "System" },
];

export function AdminSidebar() {
  const pathname = usePathname();
  const { username, logout } = useAuth();
  const { preference, setTheme } = useTheme();
  const {
    connected,
    esp32Connected,
    householdCount,
    consumerCount,
    accountsNonce,
    responsesNonce,
    historyNonce,
  } = useAdminSocket();

  const [counts, setCounts] = useState<Counts>(EMPTY_COUNTS);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Refetch on all three nonces. `responsesNonce` is the one that is easy to
  // forget — a household answering moves the participation total, and without
  // it the badge sits frozen until the operator happens to click something.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiGetAlertCount(),
      apiGetParticipationCount(),
      apiGetUserCounts(),
      apiGetAuditCount(),
    ])
      .then(([alerts, responses, users, audit]) => {
        if (cancelled) return;
        setCounts({
          alerts,
          responses,
          audit,
          accounts: users.total,
          pendingAccounts: users.pending,
        });
      })
      .catch(() => {
        // A missing badge is not a reason to break the nav. The rows still
        // work; they just carry no number.
      });
    return () => {
      cancelled = true;
    };
  }, [accountsNonce, responsesNonce, historyNonce]);

  const isActive = (href: string) =>
    href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);

  return (
    <>
      {/* Narrow-screen bar. The rail is off-canvas below 700px, so this is the
          only thing holding the menu button and the brand at that width. */}
      <div className="ds-topbar">
        <button
          className="ds-btn ds-btn--icon ds-btn--ghost"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
        >
          <Icon name="menu" size={20} />
        </button>
        <span className="ds-topbar__brand">DSM Grid</span>
        <StatusDots connected={connected} esp32Connected={esp32Connected} />
      </div>

      {drawerOpen && (
        <div
          className="ds-scrim"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside className={`ds-sidebar ${drawerOpen ? "ds-sidebar--open" : ""}`}>
        <div className="ds-sidebar__brand">
          <span className="ds-sidebar__mark" aria-hidden="true" />
          <span className="ds-sidebar__wordmark">
            DSM Grid
            <span>Operator console</span>
          </span>
        </div>

        <nav className="ds-sidebar__nav" aria-label="Sections">
          {NAV.map((item) => {
            const active = isActive(item.href);
            const badge = item.count ? counts[item.count] : null;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`ds-navitem ${active ? "ds-navitem--active" : ""}`}
                aria-current={active ? "page" : undefined}
                // Closes the narrow-screen drawer on the click that navigates.
                // Doing it in an effect on `pathname` instead is a cascading
                // render, and the React Compiler rules reject it — correctly,
                // since the click is the actual event.
                onClick={() => setDrawerOpen(false)}
              >
                <Icon name={item.icon} size={18} className="ds-navitem__icon" />
                <span className="ds-navitem__label">{item.label}</span>
                {badge !== null && badge > 0 && (
                  <span className="ds-navitem__count">{badge.toLocaleString()}</span>
                )}
                {item.href === "/admin/accounts" &&
                  (counts.pendingAccounts ?? 0) > 0 && (
                    <span
                      className="ds-navitem__flag"
                      title={`${counts.pendingAccounts} waiting for approval`}
                    />
                  )}
              </Link>
            );
          })}
        </nav>

        {/* Live state, on every admin screen rather than only the dashboard —
            the gateway being down is the single most consequential thing an
            operator can fail to notice, and it used to be invisible from four
            of the five pages. */}
        <div className="ds-sidebar__status">
          <StatusRow
            label="Readings"
            ok={connected}
            okText="Live"
            offText="Offline"
            title="Grid telemetry, streamed from the backend"
          />
          <StatusRow
            label="Gateway"
            ok={esp32Connected}
            okText="Up"
            offText="Down"
            title="Alerts reach households only through the ESP32 gateway. With it down, a push is dropped rather than queued."
          />
          <div className="ds-sidebar__statrow">
            <span className="ds-sidebar__statlabel">Households</span>
            <span className="ds-sidebar__statvalue">
              {householdCount}
              {consumerCount !== householdCount && (
                <span className="ds-sidebar__statsub"> · {consumerCount} apps</span>
              )}
            </span>
          </div>
        </div>

        <div className="ds-sidebar__foot">
          <div
            className="ds-segment ds-segment--icons"
            role="group"
            aria-label="Appearance"
            style={
              {
                "--n": THEMES.length,
                "--i": THEMES.findIndex((t) => t.id === preference),
              } as React.CSSProperties
            }
          >
            {THEMES.map((t) => (
              <button
                key={t.id}
                className="ds-segment__btn"
                aria-pressed={preference === t.id}
                aria-label={t.label}
                title={t.label}
                onClick={() => setTheme(t.id)}
              >
                <Icon name={t.icon} size={15} />
              </button>
            ))}
          </div>

          <div className="ds-sidebar__user">
            <span className="ds-sidebar__username" title={username ?? undefined}>
              {username}
            </span>
            <button
              className="ds-btn ds-btn--icon ds-btn--ghost"
              onClick={logout}
              aria-label="Sign out"
              title="Sign out"
            >
              <Icon name="logout" size={17} />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

function StatusRow({
  label,
  ok,
  okText,
  offText,
  title,
}: {
  label: string;
  ok: boolean;
  okText: string;
  offText: string;
  title: string;
}) {
  return (
    <div className="ds-sidebar__statrow" title={title}>
      <span className="ds-sidebar__statlabel">{label}</span>
      <span className={`ds-badge ${ok ? "ds-badge--live" : "ds-badge--offline"}`}>
        <span className="ds-dot" />
        {ok ? okText : offText}
      </span>
    </div>
  );
}

/** The two dots that ride the narrow-screen bar, where the rail is hidden. */
function StatusDots({
  connected,
  esp32Connected,
}: {
  connected: boolean;
  esp32Connected: boolean;
}) {
  return (
    <span className="ds-topbar__dots">
      <span
        className={`ds-badge ${connected ? "ds-badge--live" : "ds-badge--offline"}`}
        title={connected ? "Readings live" : "Readings offline"}
      >
        <span className="ds-dot" />
      </span>
      <span
        className={`ds-badge ${esp32Connected ? "ds-badge--live" : "ds-badge--offline"}`}
        title={esp32Connected ? "Gateway up" : "Gateway down"}
      >
        <span className="ds-dot" />
      </span>
    </span>
  );
}
