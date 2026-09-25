/**
 * Test harness: a fresh runtime on a throwaway SQLite file, route handlers
 * called directly (no Next build needed), and a real WebSocket server for the
 * realtime tests.
 */

import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { resetEnvCache } from "@/server/env";
import { bootRuntime } from "@/server/bootstrap";
import { createSocketServer } from "@/server/realtime/sockets";
import type { Runtime } from "@/server/runtime";

export const ADMIN = { username: "admin", password: "admin-password-123" };
export const GATEWAY_TOKEN = "test-gateway-token-0123456789";

export async function bootTestRuntime(): Promise<Runtime> {
  Object.assign(process.env, {
    JWT_SECRET: "test-secret-that-is-long-enough-for-hs256-signing",
    GATEWAY_TOKEN,
    ADMIN_USERNAME: ADMIN.username,
    ADMIN_PASSWORD: ADMIN.password,
    MDNS: "0",
  });
  resetEnvCache();
  const dir = mkdtempSync(path.join(tmpdir(), "dsm-test-"));
  return bootRuntime({ databasePath: path.join(dir, "test.db"), dataset: "sample" });
}

type Handler = (req: Request, ctx: never) => Promise<Response>;

/** Call a route handler the way Next would. */
export async function call(
  handler: Handler,
  opts: { method?: string; path?: string; token?: string; body?: unknown; params?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const headers: Record<string, string> = { "x-dsm-client-ip": "127.0.0.1" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(`http://localhost${opts.path ?? "/"}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) } as never);
  return { status: res.status, body: await res.json() };
}

/** A real HTTP server with only the WebSocket endpoints attached. */
export async function startSocketServer(rt: Runtime): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = createSocketServer(rt);
  const server: Server = createServer((_, res) => res.end());
  server.on("upgrade", (req, socket, head) => {
    if (!sockets.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        sockets.close();
        server.close(() => r());
      }),
  };
}

/** A WebSocket client that records every message, with a helper to wait for one. */
export class TestSocket {
  readonly messages: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  closeCode: number | null = null;
  private waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any

  constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => (w.pred(msg) ? (w.resolve(msg), false) : true));
    });
    ws.on("close", (code) => (this.closeCode = code));
  }

  static open(url: string): Promise<TestSocket> {
    const ws = new WebSocket(url);
    const t = new TestSocket(ws);
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(t));
      ws.once("error", reject);
    });
  }

  next(type: string, pred: (m: any) => boolean = () => true, timeoutMs = 5000): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const found = this.messages.find((m) => m.type === type && pred(m));
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        pred: (m) => m.type === type && pred(m),
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  closed(): Promise<number> {
    if (this.closeCode !== null) return Promise.resolve(this.closeCode);
    return new Promise((r) => this.ws.once("close", (code) => r(code)));
  }
}
