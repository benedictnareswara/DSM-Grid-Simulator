/**
 * The REST API end to end, with the route handlers called directly: accounts, sessions, simulation
 * control and the gateway gate.
 */

import { beforeAll, describe, expect, it } from "vitest";
import * as approve from "@/app/api/admin/users/[id]/approve/route";
import * as suspend from "@/app/api/admin/users/[id]/suspend/route";
import * as userById from "@/app/api/admin/users/[id]/route";
import * as users from "@/app/api/admin/users/route";
import * as alertTest from "@/app/api/alert/test/route";
import * as alerts from "@/app/api/alerts/route";
import * as audit from "@/app/api/audit/route";
import * as login from "@/app/api/auth/login/route";
import * as logout from "@/app/api/auth/logout/route";
import * as me from "@/app/api/auth/me/route";
import * as refresh from "@/app/api/auth/refresh/route";
import * as register from "@/app/api/auth/register/route";
import * as incentives from "@/app/api/incentives/route";
import * as reset from "@/app/api/reset/route";
import * as start from "@/app/api/start/route";
import * as status from "@/app/api/status/route";
import * as stop from "@/app/api/stop/route";
import * as thresholds from "@/app/api/thresholds/route";
import type { Runtime } from "@/server/runtime";
import { ADMIN, bootTestRuntime, call } from "../helpers";

let rt: Runtime;
let adminToken: string;

beforeAll(async () => {
  rt = await bootTestRuntime();
  const res = await call(login.POST, { body: ADMIN });
  adminToken = res.body.access_token;
});

describe("accounts and sessions", () => {
  it("seeds the admin from .env on first boot", async () => {
    const res = await call(me.GET, { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ username: "admin", role: "admin", status: "active" });
    expect(res.body).not.toHaveProperty("password_hash");
  });

  it("rejects bad credentials with one message for both halves", async () => {
    const wrongPass = await call(login.POST, { body: { username: "admin", password: "nope-nope-nope" } });
    const wrongUser = await call(login.POST, { body: { username: "ghost", password: "nope-nope-nope" } });
    expect(wrongPass.status).toBe(401);
    expect(wrongUser.body).toEqual(wrongPass.body);
  });

  it("walks a household from registration to approval to sign-in", async () => {
    const reg = await call(register.POST, {
      body: { username: "Budi", email: "budi@example.com", password: "household-pass-1" },
    });
    expect(reg.status).toBe(201);
    expect(reg.body.user).toMatchObject({ username: "budi", status: "pending", role: "consumer" });

    const early = await call(login.POST, { body: { username: "budi", password: "household-pass-1" } });
    expect(early.status).toBe(403);
    expect(early.body.detail.code).toBe("account_pending");

    const list = await call(users.GET, { token: adminToken });
    expect(list.body[0].username).toBe("budi"); // pending first

    const ok = await call(approve.POST, { token: adminToken, params: { id: reg.body.user.id } });
    expect(ok.body).toMatchObject({ status: "active", approved_by_username: "admin" });

    const signIn = await call(login.POST, { body: { username: "budi", password: "household-pass-1" } });
    expect(signIn.status).toBe(200);
    expect(signIn.body.user.role).toBe("consumer");
  });

  it("rejects duplicate usernames and emails", async () => {
    const dup = await call(register.POST, {
      body: { username: "budi", email: "other@example.com", password: "household-pass-1" },
    });
    expect(dup.status).toBe(409);
  });

  it("rotates refresh tokens and treats reuse as theft", async () => {
    const first = await call(login.POST, { body: ADMIN });
    const rotated = await call(refresh.POST, { body: { refresh_token: first.body.refresh_token } });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh_token).not.toBe(first.body.refresh_token);

    // Replaying the spent token revokes the whole family, including the new one.
    const replay = await call(refresh.POST, { body: { refresh_token: first.body.refresh_token } });
    expect(replay.status).toBe(401);
    const after = await call(refresh.POST, { body: { refresh_token: rotated.body.refresh_token } });
    expect(after.status).toBe(401);
  });

  it("logout revokes the refresh token", async () => {
    const s = await call(login.POST, { body: ADMIN });
    await call(logout.POST, { body: { refresh_token: s.body.refresh_token } });
    const r = await call(refresh.POST, { body: { refresh_token: s.body.refresh_token } });
    expect(r.status).toBe(401);
  });

  it("suspension takes effect on the very next request", async () => {
    const reg = await call(register.POST, {
      body: { username: "sari", email: "sari@example.com", password: "household-pass-2" },
    });
    await call(approve.POST, { token: adminToken, params: { id: reg.body.user.id } });
    const s = await call(login.POST, { body: { username: "sari", password: "household-pass-2" } });
    expect((await call(me.GET, { token: s.body.access_token })).status).toBe(200);

    await call(suspend.POST, { token: adminToken, params: { id: reg.body.user.id } });
    const denied = await call(me.GET, { token: s.body.access_token });
    expect(denied.status).toBe(403);
    expect(denied.body.detail.code).toBe("account_suspended");
  });

  it("won't let the admin delete or suspend themselves", async () => {
    const self = await call(me.GET, { token: adminToken });
    const del = await call(userById.DELETE, { method: "DELETE", token: adminToken, params: { id: self.body.id } });
    expect(del.status).toBe(400);
    expect(del.body.detail.code).toBe("cannot_act_on_self");
  });

  it("keeps consumers out of operator endpoints", async () => {
    const s = await call(login.POST, { body: { username: "budi", password: "household-pass-1" } });
    const res = await call(start.POST, { method: "POST", token: s.body.access_token });
    expect(res.status).toBe(403);
    expect(res.body.detail.code).toBe("admin_only");
  });

  it("requires a token", async () => {
    const res = await call(status.GET);
    expect(res.status).toBe(401);
    expect(res.body.detail.code).toBe("missing_token");
  });
});

describe("simulation control", () => {
  it("starts, reports status and stops", async () => {
    const started = await call(start.POST, { method: "POST", token: adminToken });
    expect(started.body.message).toBe("Simulation started");
    expect(started.body.status.phase).toBe("running");
    const s = await call(status.GET, { token: adminToken });
    expect(s.body.total_ticks).toBe(rt.simulator.totalTicks);
    await call(stop.POST, { method: "POST", token: adminToken });
    expect(rt.simulator.phase).toBe("idle");
  });

  it("retunes thresholds live and audits the change as a diff", async () => {
    const res = await call(thresholds.POST, { token: adminToken, body: { peak_load_ratio: 2.5 } });
    expect(res.body.thresholds.peak_load_ratio).toBe(2.5);
    expect(rt.simulator.control.thresholds.peak_load_ratio).toBe(2.5);
    const log = await call(audit.GET, { token: adminToken, path: "/api/audit?action=simulation.thresholds" });
    expect(log.body[0].detail).toEqual({ from: { peak_load_ratio: 1.5 }, to: { peak_load_ratio: 2.5 } });
    await call(thresholds.POST, { token: adminToken, body: { peak_load_ratio: 1.5 } });
  });

  it("records triggered alerts as the simulator steps", async () => {
    for (let i = 0; i < 400; i++) rt.simulator.step();
    const res = await call(alerts.GET, { token: adminToken, path: "/api/alerts" });
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0].outcome).toBeNull(); // triggered, nobody has acted
  });

  it("fails closed: a composed alert with no gateway is recorded as not delivered", async () => {
    const res = await call(alertTest.POST, { token: adminToken, body: { parameter: "peak_load", severity: "critical" } });
    expect(res.body.esp32_connected).toBe(false);
    expect(res.body.alert).toMatchObject({ parameter: "peak_load", severity: "critical", duration_minutes: 90 });
    const hist = await call(alerts.GET, { token: adminToken, path: "/api/alerts?outcome=failed" });
    expect(hist.body.map((a: { alert_id: string }) => a.alert_id)).toContain(res.body.alert.id);
  });

  it("reset hides history instead of deleting it", async () => {
    await call(reset.POST, { method: "POST", token: adminToken });
    const res = await call(alerts.GET, { token: adminToken, path: "/api/alerts" });
    expect(res.body).toEqual([]);
    expect(rt.simulator.currentTick).toBe(0);
  });

  it("serves the incentive model", async () => {
    const res = await call(incentives.GET, { token: adminToken });
    expect(res.body.shed_kwh_by_parameter.emergency).toBe(2.0);
    expect(res.body.response_bonus_tiers[0]).toEqual({ max_seconds: 120, multiplier: 1.25, label: "within 2 minutes" });
  });
});
