import { seedAdmin } from "./auth/seed-admin";
import { openDatabase } from "./db/client";
import { env } from "./env";
import { loadDataset, resolveDatasetPath } from "./grid/dataset";
import { Simulator } from "./grid/simulator";
import { Hub } from "./realtime/hub";
import { setRuntime, type Runtime } from "./runtime";

/**
 * Open the database (migrating it), seed the admin, load the dataset and wire up the hub and
 * simulator.
 */
export async function bootRuntime(overrides: { databasePath?: string; dataset?: string } = {}): Promise<Runtime> {
  const settings = env();
  const db = openDatabase(overrides.databasePath ?? settings.DATABASE_PATH);
  await seedAdmin(db);
  const dataset = await loadDataset(resolveDatasetPath(overrides.dataset ?? settings.DATASET));
  const hub = new Hub();
  const runtime: Runtime = {
    db,
    hub,
    simulator: new Simulator(hub, db, dataset),
    authAttempts: new Map(),
  };
  setRuntime(runtime);
  return runtime;
}
