import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/*
 * Fonts are self-hosted at build time by next/font (no render-blocking the weights the design
 * system uses are requested.
 * @import). They set the two CSS variables src/styles/tokens.css reads. Only
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
  // Not preloaded: mono is only used for ids and timestamps (secondary text), so it shouldn't
  // compete with first paint.
  preload: false,
});

export const metadata: Metadata = {
  title: "DSM Grid Simulator",
  description:
    "Real-time Demand Side Management dashboard with grid telemetry simulation, 6-parameter monitoring, and consumer DSM incentive notifications.",
};

export const viewport: Viewport = {
  // Deliberately no `themeColor` here.
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
      // The script below overwrites this before paint.
      data-theme="light"
      suppressHydrationWarning
    >
      <head>
        <script
          // Runs before first paint, so the page never flashes the wrong scheme.
          dangerouslySetInnerHTML={{
            __html: `(function(){try{
var p=localStorage.getItem("dsm-theme");
if(p!=="light"&&p!=="dark")p="system";
var t=p==="system"?(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p;
var r=document.documentElement;
r.dataset.theme=t;r.style.colorScheme=t;
var m=document.querySelector('meta[name="theme-color"]');
if(!m){m=document.createElement("meta");m.name="theme-color";document.head.appendChild(m);}
m.content=t==="dark"?"#0e0e0f":"#f6f6f7";
}catch(e){}})()`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
