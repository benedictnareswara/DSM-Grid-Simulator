/**
 * The SQLite database: one file (data/dsm.db by default), created and migrated
 * automatically on first boot. There's nothing to install or configure.
 *
 * better-sqlite3 is synchronous, and that's fine here: queries against a local
 * file take microseconds, well inside the 50 ms between the fastest simulator ticks.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { resolveFromRoot } from "../env";
import * as schema from "./schema";

export type DB = BetterSQLite3Database<typeof schema> & { $client: Database.Database };
/** A transaction handle. Everything that writes accepts either, so it can join a caller's transaction. */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export type Conn = DB | Tx;

export function openDatabase(file: string): DB {
  const target = file === ":memory:" ? file : resolveFromRoot(file);
  if (target !== ":memory:") mkdirSync(path.dirname(target), { recursive: true });

  const sqlite = new Database(target);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolveFromRoot("src/server/db/migrations") });
  return db;
}
