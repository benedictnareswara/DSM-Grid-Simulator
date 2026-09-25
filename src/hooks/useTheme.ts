"use client";

import { useSyncExternalStore } from "react";
import {
  getServerSnapshot,
  getSnapshot,
  setTheme,
  subscribe,
  type ResolvedTheme,
  type ThemePreference,
} from "@/lib/theme";

/**
 * The current colour scheme, as React state.
 *
 * `useSyncExternalStore` rather than an effect that calls setState: the theme
 * *is* an external store (it lives on `document.documentElement` and in
 * localStorage), and copying it into state on mount is the cascading-render
 * pattern the Next 16 React Compiler rules reject. Same reasoning as
 * `hooks/useAlertNotifications.ts`.
 *
 * `preference` is what the operator picked (including `system`); `resolved` is
 * what is actually painted. A control renders the former and anything that
 * needs a real colour reads the latter.
 *
 * Most of the app never calls this — components recolour through CSS custom
 * properties. It exists for the two places that cannot: the theme switcher
 * itself, and `app/admin/GridCharts.tsx`, because Recharts takes colours as
 * props rather than reading the cascade.
 */
export function useTheme(): {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setTheme: (next: ThemePreference) => void;
} {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { preference: snapshot.preference, resolved: snapshot.resolved, setTheme };
}
