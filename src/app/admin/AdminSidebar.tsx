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
import { BrinEmblem } from "@/components/Brand";
import type { ThemePreference } from "@/lib/theme";

/** The admin shell's navigation rail. */

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

  // Refetch on all three nonces.
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
        // A missing badge is not a reason to break the nav.
      });
    return () => {
      cancelled = true;
    };
  }, [accountsNonce, responsesNonce, historyNonce]);

  const isActive = (href: string) =>
    href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);

  return (
    <>
      {/* Narrow-screen bar. */}
      <div className="ds-topbar">
        <button
          className="ds-btn ds-btn--icon ds-btn--ghost"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
        >
          <Icon name="menu" size={20} />
        </button>
        <span className="ds-topbar__brand">
          <BrinEmblem size={24} />
          DSM Grid
        </span>
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
          <BrinEmblem size={30} />
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
                <span className="ds-sidebar__statsub"> on {consumerCount} devices</span>
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
