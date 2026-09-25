/**
 * The process-wide singletons: database, hub, simulator and login throttle.
 *
 * server.ts creates them once and parks them on `globalThis`. Route handlers are
 * bundled by Next separately from server.ts, so importing a module-level
 * singleton there would get a second, empty copy. They call getRuntime() instead.
 */

import type { DB } from "./db/client";
import type { Simulator } from "./grid/simulator";
import type { Hub } from "./realtime/hub";

export interface Runtime {
  db: DB;
  hub: Hub;
  simulator: Simulator;
  /** Failed login/register attempts, keyed by "ip:username". Process-local on purpose. */
  authAttempts: Map<string, number[]>;
}

const KEY = "__dsm_runtime__";
type WithRuntime = typeof globalThis & { [KEY]?: Runtime };

export function setRuntime(runtime: Runtime): void {
  (globalThis as WithRuntime)[KEY] = runtime;
}

export function getRuntime(): Runtime {
  const rt = (globalThis as WithRuntime)[KEY];
  if (!rt) {
    throw new Error("DSM runtime not initialised. Start the app with `npm run dev`, not `next dev`.");
  }
  return rt;
}
