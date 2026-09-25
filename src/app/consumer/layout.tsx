import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "DSM Consumer — Grid Energy Assistant",
  description:
    "Receive demand-side management alerts from your grid operator and choose whether to reduce usage.",
  appleWebApp: {
    capable: true,
    title: "DSM",
    // Black-translucent lets the app paint under the iOS status bar, which is
    // what the safe-area padding in .ds-app__top accounts for.
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  // No `themeColor` here either — `lib/theme.ts` owns the single meta tag so
  // that a manual override reaches the installed PWA's chrome too. See the
  // root layout.
  // Required for env(safe-area-inset-*) to report non-zero values on notched
  // devices — without it iOS letterboxes the app instead.
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
  // Zoom is deliberately left enabled. Disabling it is an accessibility
  // failure, and standalone display already suppresses accidental pinch.
};

export default function ConsumerLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
