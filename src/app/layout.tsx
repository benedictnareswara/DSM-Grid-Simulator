import type { Metadata, Viewport } from "next";
import { Barlow_Semi_Condensed, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

/*
 * Self-hosted by next/font; they set the CSS variables src/styles/tokens.css reads.
 * Plus Jakarta Sans carries the interface; Barlow Semi Condensed, drawn from road and
 * infrastructure signage, carries readings and headings like an instrument face.
 */
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-jakarta",
  display: "swap",
});

const barlow = Barlow_Semi_Condensed({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-barlow",
  display: "swap",
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
      className={`${jakarta.variable} ${barlow.variable}`}
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
m.content=t==="dark"?"#0d141b":"#f6f6f7";
}catch(e){}})()`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
