/**
 * The whole app in one process on one port: the Next.js pages and API, the
 * WebSocket endpoints, the simulator loop and the mDNS advertisement the ESP32
 * gateway uses to find this machine.
 *
 *   npm run dev     development (hot reload for pages)
 *   npm start       production (run `npm run build` first)
 */

import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";

const production = process.argv.includes("--production");
if (existsSync(".env")) process.loadEnvFile(".env");
// Set before Next and React load: both pick their dev or production build from it.
(process.env as Record<string, string>).NODE_ENV = production ? "production" : "development";

// Imported after .env is loaded, so the settings are validated against it.
const { default: next } = await import("next");
const { env } = await import("./src/server/env");
const { bootRuntime } = await import("./src/server/bootstrap");
const { createSocketServer } = await import("./src/server/realtime/sockets");
const { Discovery } = await import("./src/server/discovery");

let settings;
try {
  settings = env();
} catch (err) {
  console.error(`\n${(err as Error).message}\n`);
  process.exit(1);
}

const rt = await bootRuntime();
const app = next({ dev: !production, port: settings.PORT });
await app.prepare();
const handle = app.getRequestHandler();
const nextUpgrade = app.getUpgradeHandler();
const sockets = createSocketServer(rt);

const server = createServer((req, res) => {
  // The route handlers read the caller's address from this header (for the
  // audit log and login throttle). Anything a client sent under that name is dropped.
  req.headers["x-dsm-client-ip"] = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  void handle(req, res);
});

server.on("upgrade", (req, socket, head) => {
  // Ours: /ws/admin, /ws/consumer, /ws/gateway. Everything else (Next's
  // hot-reload socket in development) goes to Next.
  if (!sockets.handleUpgrade(req, socket, head)) void nextUpgrade(req, socket, head);
});

const discovery = new Discovery();

server.listen(settings.PORT, "0.0.0.0", () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .map((a) => `http://${a!.address}:${settings.PORT}`);
  console.log(`\n  DSM is running${production ? "" : " (development)"}`);
  console.log(`  ➜ This computer:  http://localhost:${settings.PORT}`);
  for (const url of lan) console.log(`  ➜ Phones on Wi-Fi: ${url}`);
  console.log("");
  // Advertised last, so the gateway never finds a server that is still loading.
  if (settings.MDNS !== "0") discovery.start(settings.PORT);
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log("\n[Server] Shutting down…");
  rt.simulator.stop();
  sockets.close();
  await discovery.stop();
  server.close();
  rt.db.$client.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
