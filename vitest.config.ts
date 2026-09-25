import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // The realtime tests boot a real server; give them room.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
