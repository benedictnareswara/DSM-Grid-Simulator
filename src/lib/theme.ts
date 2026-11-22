/** Colour scheme preference: light, dark, or follow the system. */

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

/** Also read by the inline script in app/layout.tsx — keep the two in step. */
export const THEME_STORAGE_KEY = "dsm-theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Must match `--canvas` for each scheme. */
const THEME_COLOR: Record<ResolvedTheme, string> = {
  light: "#f6f6f7",
  dark: "#0d141b",
};

const listeners = new Set<() => void>();

/*
 * `useSyncExternalStore` compares snapshots by identity and will loop forever if getSnapshot builds
 * a new object each call.
 */
interface ThemeSnapshot {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}

let snapshot: ThemeSnapshot = { preference: "system", resolved: "light" };

/** The prerender has no DOM and no storage; light is what the markup assumes. */
const SERVER_SNAPSHOT: ThemeSnapshot = { preference: "system", resolved: "light" };

function readStoredPreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // Private-mode storage failures fall back to following the OS.
  }
  return "system";
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

function resolve(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

/** Paint the resolved theme: the attribute globals.css selects on, plus chrome. */
function paint(resolved: ResolvedTheme) {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  // Keeps native controls, form widgets and the scrollbar in the right scheme.
  root.style.colorScheme = resolved;

  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = THEME_COLOR[resolved];
}

function commit(next: ThemeSnapshot) {
  if (next.preference === snapshot.preference && next.resolved === snapshot.resolved) {
    return;
  }
  snapshot = next;
  paint(next.resolved);
  listeners.forEach((fn) => fn());
}

let initialised = false;

/** Sync module state to the DOM the inline script already set up, and start following the OS. */
function init() {
  if (initialised || typeof window === "undefined") return;
  initialised = true;

  const preference = readStoredPreference();
  snapshot = { preference, resolved: resolve(preference) };
  paint(snapshot.resolved);

  // One listener for the life of the page.
  window.matchMedia(DARK_QUERY).addEventListener("change", () => {
    if (snapshot.preference !== "system") return;
    commit({ preference: "system", resolved: systemTheme() });
  });
}

/** `useSyncExternalStore` subscribe. Returns the unsubscribe function. */
export function subscribe(onChange: () => void): () => void {
  init();
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** `useSyncExternalStore` client snapshot: the resolved theme right now. */
export function getSnapshot(): ThemeSnapshot {
  init();
  return snapshot;
}

/** `useSyncExternalStore` server snapshot. */
export function getServerSnapshot(): ThemeSnapshot {
  return SERVER_SNAPSHOT;
}

/** Set the preference, persist it, and repaint. */
export function setTheme(preference: ThemePreference) {
  init();
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Not persisting is survivable; the choice still applies for this session.
  }
  commit({ preference, resolved: resolve(preference) });
}
