import { defineConfig } from "drizzle-kit";

// Only used at development time (`npm run db:generate`) to turn schema changes
// into SQL migrations. Users never run it: the server applies the committed
// migrations itself on boot.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/db/schema.ts",
  out: "./src/server/db/migrations",
});
