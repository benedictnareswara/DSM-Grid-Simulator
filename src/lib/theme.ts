/**
 * DSM — colour scheme preference.
 *
 * Three states, not two: `light`, `dark`, and `system` (follow the OS). The
 * preference is what the operator picked; the *resolved* theme is the one
 * actually painted, and only ever `light` or `dark`.
 *
 * ## Why `data-theme` is always present
 *
 * The obvious CSS shape for an override is a media query plus an attribute
 * selector:
 *
 *     @media (prefers-color-scheme: dark) { :root:not([data-theme=light]) { … } }
 *     :root[data-theme="dark"] { … }
 *
 * That needs the ~70-line dark token block written *twice*, in two places that
 * must never drift — exactly the failure mode the rest of this codebase is
 * organised to avoid. So instead the attribute is never absent: the inline
 * script in `app/layout.tsx` resolves `system` to a concrete value before the
 * first paint, and globals.css carries one light block and one dark block with
 * no media query at all.
 *
 * The cost is that theming requires JavaScript. That is already true of every
 * page here — they are all `"use client"` and driven by a WebSocket — so it
 * buys the single dark block for nothing that was working anyway.
 *
 * ## Why this owns the theme-color meta
 *
 * `viewport.themeColor` in a layout can only express a *media* array, so it
 * cannot answer a manual override — pick dark on a light OS and the browser
 * chrome stays light. Both layouts therefore declare no themeColor and this
 * module writes the single meta tag instead, seeded by the same inline script
 * so there is no window where it disagrees with the page.
 *
 * Keep `THEME_COLOR` in step with `--canvas` in globals.css.
 */

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

/** Also read by the inline script in app/layout.tsx — keep the two in step. */
export const THEME_STORAGE_KEY = "dsm-theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Must match `--canvas` for each scheme. */
const THEME_COLOR: Record<ResolvedTheme, string> = {
  light: "#f7f7fa",
  dark: "#0b0b10",
};

const listeners = new Set<() => void>();

/*
 * `useSyncExternalStore` compares snapshots by identity and will loop forever
 * if getSnapshot builds a new object each call. So the snapshot is cached and
 * only rebuilt when something actually changes.
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

/**
 * Sync module state to the DOM the inline script already set up, and start
 * following the OS. Idempotent, and safe to call from several components.
 */
function init() {
  if (initialised || typeof window === "undefined") return;
  initialised = true;

  const preference = readStoredPreference();
  snapshot = { preference, resolved: resolve(preference) };
  paint(snapshot.resolved);

  // One listener for the life of the page. It fires on every OS change but
  // only moves anything while the preference is `system` — cheaper and less
  // error-prone than attaching and detaching as the preference changes.
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

/**
 * `useSyncExternalStore` server snapshot.
 *
 * A fixed value: the OS scheme is unknowable during SSR, and the blocking
 * script in app/layout.tsx sets `data-theme` before first paint anyway.
 */
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
