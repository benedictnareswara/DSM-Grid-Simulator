import type { MetadataRoute } from "next";

/**
 * Web app manifest for the consumer phone app.
 *
 * `start_url` points at /consumer rather than / so an installed icon opens
 * straight into the app. The root route only redirects by role anyway.
 *
 * Installability also requires a secure context: browsers offer "Add to Home
 * Screen" over HTTPS or on localhost, never on a plain-HTTP LAN address. See
 * "HTTPS on the LAN" in docs/ARCHITECTURE.md.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "DSM Consumer — Grid Energy Assistant",
    short_name: "DSM",
    description:
      "Receive demand-side management alerts from your grid operator and choose whether to reduce usage.",
    start_url: "/consumer",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    // The manifest takes one colour per field — it has no media-query form, so
    // unlike the two `viewport.themeColor` declarations these stay single
    // values. Light is the right choice: this is the splash screen an install
    // paints before any CSS runs, and a light splash flashing to a dark app is
    // less jarring than the reverse.
    background_color: "#f5f5f7",
    theme_color: "#0071e3",
    categories: ["utilities", "productivity"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        // Android crops "any" icons into its own shape; a maskable variant with
        // padding keeps the bolt from being clipped.
        purpose: "maskable",
      },
    ],
  };
}
