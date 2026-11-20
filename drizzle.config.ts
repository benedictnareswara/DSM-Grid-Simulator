import { defineConfig } from "drizzle-kit";

// Only used at development time (`npm run db:generate`) to turn schema changes into SQL migrations.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/db/schema.ts",
  out: "./src/server/db/migrations",
});
