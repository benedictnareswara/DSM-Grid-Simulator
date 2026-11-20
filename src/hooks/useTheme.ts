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

/** The current colour scheme, as React state. */
export function useTheme(): {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setTheme: (next: ThemePreference) => void;
} {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { preference: snapshot.preference, resolved: snapshot.resolved, setTheme };
}
