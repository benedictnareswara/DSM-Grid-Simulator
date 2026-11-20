import { networkInterfaces } from "node:os";
import type { NextConfig } from "next";

/** This machine's private IPv4 addresses. */
function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .map((a) => a!.address);
}

const nextConfig: NextConfig = {
  // Loaded by the custom server (server.ts), not bundled.
  serverExternalPackages: ["better-sqlite3", "bonjour-service", "drizzle-orm", "ws"],
  allowedDevOrigins: lanAddresses(),
  async headers() {
    return [
      {
        // Icons have no content hash in their names: cache for a week, but keep an update path open
        // with stale-while-revalidate.
        source: "/:icon(icon-192\\.png|icon-512\\.png|icon-maskable-512\\.png)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=604800, stale-while-revalidate=86400" },
        ],
      },
      {
        // The service worker is its own update mechanism; a cached copy pins the app to an old
        // shell.
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "no-cache, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
