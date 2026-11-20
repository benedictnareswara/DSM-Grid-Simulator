import type { MetadataRoute } from "next";

/** Web app manifest for the consumer phone app. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "DSM Grid · BRIN — Grid Energy Assistant",
    short_name: "DSM Grid",
    description:
      "Receive demand-side management alerts from your grid operator and choose whether to reduce usage.",
    start_url: "/consumer",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    // The manifest takes one colour per field — it has no media-query form, so unlike the two
    // `viewport.themeColor` declarations these stay single values.
    background_color: "#f6f6f7",
    // BRIN red, the deep variant that carries white text (--accent-fill).
    theme_color: "#d60c00",
    categories: ["utilities", "productivity"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        // Android crops "any" icons into its own shape; the padded variant keeps the emblem whole.
        purpose: "maskable",
      },
    ],
  };
}
