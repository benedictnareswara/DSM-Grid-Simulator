import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/*
 * Fonts are self-hosted at build time by next/font (no render-blocking
 * @import). They set the two CSS variables src/styles/tokens.css reads. Only
 * the weights the design system uses are requested.
 */
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-jetbrains-mono",
  display: "swap",
  // Not preloaded: mono is only used for ids and timestamps (secondary text),
  // so it shouldn't compete with first paint. It swaps in from ui-monospace.
  preload: false,
});

export const metadata: Metadata = {
  title: "DSM Grid Simulator",
  description:
    "Real-time Demand Side Management dashboard with grid telemetry simulation, 6-parameter monitoring, and consumer DSM incentive notifications.",
};

export const viewport: Viewport = {
  // Deliberately no `themeColor` here. It can only be expressed as a *media*
  // array, which cannot answer a manual override — pick dark on a light OS and
  // the browser chrome stays light. `lib/theme.ts` owns the single
  // `<meta name="theme-color">` instead, seeded by the script below so there is
  // never a frame where it disagrees with the page.
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable}`}
      // The script below overwrites this before paint. It is here so the
      // server markup and the first client render agree on an attribute that
      // is never absent — see the `data-theme` note in lib/theme.ts.
      data-theme="light"
      suppressHydrationWarning
    >
      <head>
        <script
          // Runs before first paint, so the page never flashes the wrong
          // scheme. Deliberately inline and un-deferred: a module import would
          // resolve after the first paint, which is the whole bug.
          //
          // This duplicates a few lines of lib/theme.ts on purpose — that
          // module cannot run here — so keep THEME_STORAGE_KEY, the accepted
          // values and the two canvas colours in step with it.
          dangerouslySetInnerHTML={{
            __html: `(function(){try{
var p=localStorage.getItem("dsm-theme");
if(p!=="light"&&p!=="dark")p="system";
var t=p==="system"?(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p;
var r=document.documentElement;
r.dataset.theme=t;r.style.colorScheme=t;
var m=document.querySelector('meta[name="theme-color"]');
if(!m){m=document.createElement("meta");m.name="theme-color";document.head.appendChild(m);}
m.content=t==="dark"?"#0b0b10":"#f7f7fa";
}catch(e){}})()`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
