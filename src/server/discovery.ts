/**
 * Advertises this server on the LAN as `_dsm._tcp` over mDNS, so the ESP32 gateway can find it
 * without an IP address compiled into its firmware.
 */

import { Bonjour, type Service } from "bonjour-service";

export class Discovery {
  private bonjour: Bonjour | null = null;
  private service: Service | null = null;

  start(port: number): void {
    try {
      this.bonjour = new Bonjour();
      this.service = this.bonjour.publish({
        name: "DSM Grid Simulator",
        type: "dsm",
        protocol: "tcp",
        port,
        txt: { path: "/ws/gateway" },
      });
      this.service.on("error", (err: unknown) => console.warn("[mDNS] advertisement failed:", err));
      console.log(`[mDNS] Advertising _dsm._tcp on port ${port}`);
    } catch (err) {
      // Not fatal: SERVER_HOST in .env is the gateway's fallback.
      console.warn("[mDNS] could not start; set SERVER_HOST in .env for the gateway instead.", err);
    }
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.bonjour) return resolve();
      this.bonjour.unpublishAll(() => {
        this.bonjour?.destroy();
        resolve();
      });
    });
    this.bonjour = null;
    this.service = null;
  }
}
