/** The gateway-brokered alert path over real WebSockets. */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as approve from "@/app/api/admin/users/[id]/approve/route";
import * as respond from "@/app/api/alert/[id]/respond/route";
import * as alertTest from "@/app/api/alert/test/route";
import * as alertsList from "@/app/api/alerts/route";
import * as mine from "@/app/api/alerts/mine/route";
import { DELIVERY_GRACE_MS } from "@/lib/constants";
import type { AlertRow } from "@/server/db/schema";
import { alertOutcome } from "@/server/serialize";
import * as login from "@/app/api/auth/login/route";
import * as register from "@/app/api/auth/register/route";
import * as participation from "@/app/api/participation/route";
import * as savingsMine from "@/app/api/savings/mine/route";
import type { Runtime } from "@/server/runtime";
import { ADMIN, bootTestRuntime, call, GATEWAY_TOKEN, startSocketServer, TestSocket } from "../helpers";

let rt: Runtime;
let server: Awaited<ReturnType<typeof startSocketServer>>;
let adminToken: string;
let householdToken: string;

/** Behaves like the firmware's relay loop. */
async function fakeGateway(): Promise<TestSocket> {
  const gw = await TestSocket.open(`${server.url}/ws/gateway?token=${GATEWAY_TOKEN}`);
  gw.ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "relay_alert") gw.send({ type: "forward_alert", alert: msg.alert });
    if (msg.type === "relay_response") gw.send({ ...msg, type: "forward_response" });
  });
  return gw;
}

beforeAll(async () => {
  rt = await bootTestRuntime();
  server = await startSocketServer(rt);
  adminToken = (await call(login.POST, { body: ADMIN })).body.access_token;
  const reg = await call(register.POST, {
    body: { username: "wati", email: "wati@example.com", password: "household-pass-3" },
  });
  await call(approve.POST, { token: adminToken, params: { id: reg.body.user.id } });
  householdToken = (await call(login.POST, { body: { username: "wati", password: "household-pass-3" } })).body.access_token;
});

afterAll(async () => {
  rt.simulator.stop();
  await server.close();
});

describe("WebSocket authentication", () => {
  it("closes a gateway with the wrong token with 4401", async () => {
    const bad = await TestSocket.open(`${server.url}/ws/gateway?token=wrong`);
    expect(await bad.closed()).toBe(4401);
    // Said in a message too, because the ESP32 library drops close reasons.
    expect(bad.messages).toEqual([{ type: "error", message: "Invalid gateway token" }]);
  });

  it("closes a dashboard with no token with 4401", async () => {
    const anon = await TestSocket.open(`${server.url}/ws/admin`);
    expect(await anon.closed()).toBe(4401);
  });

  it("keeps a household off the admin socket", async () => {
    const wrong = await TestSocket.open(`${server.url}/ws/admin?token=${householdToken}`);
    expect(await wrong.closed()).toBe(4401);
  });

  it("primes a new admin dashboard with status, autopush and thresholds", async () => {
    const admin = await TestSocket.open(`${server.url}/ws/admin?token=${adminToken}`);
    await admin.next("status");
    await admin.next("autopush_status");
    const t = await admin.next("thresholds");
    expect(t.data.peak_load_ratio).toBe(1.5);
    admin.ws.close();
  });
});

describe("the gateway-brokered alert path", () => {
  it("delivers an alert only via the gateway, then carries the answer back", async () => {
    const admin = await TestSocket.open(`${server.url}/ws/admin?token=${adminToken}`);
    const phone = await TestSocket.open(`${server.url}/ws/consumer?token=${householdToken}`);
    expect((await phone.next("esp32_status")).connected).toBe(false);

    const gw = await fakeGateway();
    await admin.next("esp32_status", (m) => m.connected === true);
    await phone.next("esp32_status", (m) => m.connected === true);

    // Push: server → gateway (relay_alert) → server (forward_alert) → phone (pushed_alert).
    const pushed = await call(alertTest.POST, {
      token: adminToken,
      body: { parameter: "emergency", severity: "emergency" },
    });
    expect(pushed.body.esp32_connected).toBe(true);
    const relay = await gw.next("relay_alert");
    expect(relay.alert.target_reduction_w).toBe(3000); // 3 kWh over 60 min
    const onPhone = await phone.next("pushed_alert");
    expect(onPhone.alert.id).toBe(pushed.body.alert.id);

    // Delivery is now recorded, so it appears in the household's history.
    await new Promise((r) => setTimeout(r, 50));
    const history = await call(mine.GET, { token: householdToken, path: "/api/alerts/mine" });
    expect(history.body.map((a: { alert_id: string }) => a.alert_id)).toContain(pushed.body.alert.id);

    // Answer: phone → server (REST) → gateway (relay_response) → server (forward_response) → admin.
    const answer = await call(respond.POST, {
      method: "POST",
      token: householdToken,
      path: `/api/alert/${pushed.body.alert.id}/respond?accepted=true`,
      params: { id: pushed.body.alert.id },
    });
    expect(answer.body.esp32_connected).toBe(true);
    const relayed = await gw.next("relay_response");
    expect(relayed).toMatchObject({ alert_id: pushed.body.alert.id, accepted: true, username: "wati" });
    const seen = await admin.next("dsm_response");
    expect(seen).toMatchObject({ alert_id: pushed.body.alert.id, accepted: true, username: "wati" });
    const echo = await phone.next("my_response");
    expect(echo).toMatchObject({ alert_id: pushed.body.alert.id, accepted: true });

    // The answer is persisted and credited (2,000 Rp/kWh × 3 kWh × 1.25 fast-answer bonus).
    await new Promise((r) => setTimeout(r, 50));
    const log = await call(participation.GET, { token: adminToken, path: "/api/participation" });
    expect(log.body[0]).toMatchObject({ username: "wati", accepted: true, streak_at_response: 1, credit_idr: 7500 });
    const savings = await call(savingsMine.GET, { token: householdToken });
    expect(savings.body).toMatchObject({ accepted_count: 1, total_kwh: 3, total_credit_idr: 7500, offered_alerts: 1 });

    // Pull the plug: the badge must go red for everyone.
    gw.ws.close();
    await admin.next("esp32_status", (m) => m.connected === false && admin.messages.indexOf(m) > 2);
    expect(rt.hub.gatewayConnected).toBe(false);
    admin.ws.close();
    phone.ws.close();
  });

  it("reports a push as sending until the gateway confirms it, then tells dashboards", async () => {
    // A gateway that holds its echo, like the real one's ~1 s round trip.
    const gw = await TestSocket.open(`${server.url}/ws/gateway?token=${GATEWAY_TOKEN}`);
    const admin = await TestSocket.open(`${server.url}/ws/admin?token=${adminToken}`);
    await admin.next("esp32_status", (m) => m.connected === true);

    const pushed = await call(alertTest.POST, {
      token: adminToken,
      body: { parameter: "peak_load", severity: "warning" },
    });
    const id = pushed.body.alert.id;
    const relay = await gw.next("relay_alert");

    const outcomeNow = async () =>
      (await call(alertsList.GET, { token: adminToken, path: "/api/alerts" })).body.find(
        (a: { alert_id: string }) => a.alert_id === id,
      )?.outcome;
    expect(await outcomeNow()).toBe("sending");

    gw.send({ type: "forward_alert", alert: relay.alert });
    const delivered = await admin.next("alert_delivered");
    // A nudge with an id, never the alert itself: dashboards refetch for content.
    expect(delivered).toEqual({ type: "alert_delivered", alert_id: id, tick: relay.alert.tick });
    expect(await outcomeNow()).toBe("pushed");

    gw.ws.close();
    await admin.next("esp32_status", (m) => m.connected === false);
    admin.ws.close();
  });

  it("calls an unconfirmed push a failure only after the grace window", () => {
    const pushedAt = new Date("2026-01-01T00:00:00Z");
    const row = { ignoredAt: null, deliveredAt: null, autoPushed: false, pushedAt, pushRelayed: true } as unknown as AlertRow;
    expect(alertOutcome(row, pushedAt.getTime() + 1_000)).toBe("sending");
    // Pushed with no gateway attached: it never left the server, so no grace.
    expect(alertOutcome({ ...row, pushRelayed: false } as AlertRow, pushedAt.getTime() + 1_000)).toBe("failed-gateway");
    expect(alertOutcome(row, pushedAt.getTime() + DELIVERY_GRACE_MS + 1)).toBe("failed-gateway");
    expect(alertOutcome({ ...row, deliveredAt: new Date() } as AlertRow, pushedAt.getTime() + 60_000)).toBe("pushed");
    expect(alertOutcome({ ...row, pushedAt: null } as AlertRow)).toBeNull();
  });

  it("tells the household its answer was not delivered when the gateway is down", async () => {
    expect(rt.hub.gatewayConnected).toBe(false);
    const answer = await call(respond.POST, {
      method: "POST",
      token: householdToken,
      path: "/api/alert/nope/respond?accepted=true",
      params: { id: "nope" },
    });
    // The phone keys its "Not sent, answer again" state off exactly this.
    expect(answer.body.esp32_connected).toBe(false);
  });

  it("never sends alerts to phones on a tick", async () => {
    const phone = await TestSocket.open(`${server.url}/ws/consumer?token=${householdToken}`);
    const admin = await TestSocket.open(`${server.url}/ws/admin?token=${adminToken}`);
    // Both sockets are registered once they've been primed.
    await phone.next("esp32_status");
    await admin.next("status");
    // Step until the engine fires an alert.
    let fired = 0;
    for (let i = 0; i < 2000 && !fired; i++) fired = rt.simulator.step().length;
    expect(fired).toBeGreaterThan(0);
    const adminTick = await admin.next("tick", (m) => m.alerts.length > 0);
    const phoneTick = await phone.next("tick", (m) => m.state.tick === adminTick.state.tick);
    expect(phoneTick.alerts).toEqual([]);
    phone.ws.close();
    admin.ws.close();
  });
});
