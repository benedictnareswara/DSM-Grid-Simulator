# Architecture

How DSM works, and why it's built the way it is. For setup, see the [README](../README.md).

- [Components](#components)
- [One tick](#one-tick)
- [The six grid signals (P1–P6)](#the-six-grid-signals-p1p6)
- [From signal to alert](#from-signal-to-alert)
- [The incentive model](#the-incentive-model)
- [The gateway gate](#the-gateway-gate)
- [The ESP-NOW downlink](#the-esp-now-downlink)
- [Accounts](#accounts)
- [Configuration flow](#configuration-flow)
- [HTTPS on the LAN](#https-on-the-lan)
- [Code map](#code-map)

---

## Components

```
                 ┌──────────────────────── DSM server (one Node process, port 3000) ───────────────────────┐
 Operator  ──────┤ Next.js pages + REST API (src/app)                                                      │
 browser         │ WebSockets /ws/admin, /ws/consumer, /ws/gateway (src/server/realtime)                  │
                 │ Simulator + control logic + incentives (src/server/grid)          SQLite (data/dsm.db)│
 Household ──────┤ mDNS advertisement _dsm._tcp (src/server/discovery.ts)                                 │
 phones          └───────────────────────────────────────────▲─────────────────────────────────────────────┘
                                                             │ WebSocket (token auth)
                                                   ESP32 gateway (firmware/gateway)
                                                             │ ESP-NOW (same Wi-Fi channel)
                                                   ESP32 LCU (firmware/lcu) ──▶ TRIAC dimmer ──▶ load
```

`server.ts` starts everything on one port: the Next.js handler, the three WebSocket endpoints,
the simulator loop and the mDNS advertisement. Route handlers are bundled by Next separately
from `server.ts`, so the shared state (database, hub, simulator) lives on `globalThis` and is
reached through `getRuntime()` in `src/server/runtime.ts`.

## One tick

The replay dataset has one row per minute. Each tick (1 s by default, 50 ms at the fastest)
the simulator:

1. reads the next row and builds the grid state;
2. evaluates the six gates against the **live** thresholds and stamps the `*_triggered` flags
   (so gauges, alerts and the household verdict can't disagree);
3. asks the control logic for at most one alert;
4. writes any alert to the database as *triggered*, before anyone has acted on it;
5. autopushes it, if autopush is on and the severity qualifies;
6. broadcasts the tick: admins get it with the alerts, households get it with `alerts: []`.

## The six grid signals (P1–P6)

The data is one real European household (UCI, 2006–2010), scaled ×150 to stand in for a
small Indonesian neighbourhood and rescaled from 230 V to PLN's 220 V. Five of the six
signals are synthetic but physically motivated. The offline pipeline
(`tools/pipeline/transform.py`) derives them once, with fixed random seeds, so the same input
always gives the same replay.

| | Signal | How it's derived | Default gate |
|---|---|---|---|
| P1 | **Peak load** | load ÷ its 60-minute EMA | ratio > 1.5 |
| P2 | **Frequency** | 50 Hz − K·(dP/dt ÷ mean load) + noise, clipped 49–51 Hz | \|Δf\| > 0.2 Hz |
| P3 | **Reserve margin** | headroom below peak × 1.05 at neighbourhood scale | < 10 % |
| P4 | **Renewables** | solar half-sine 06:00–18:00 + Ornstein-Uhlenbeck wind | share < 15 % |
| P5 | **Emergency score** | 0.35·voltage + 0.30·ramp z-score + 0.35·overload | > 0.6 |
| P6 | **Price** | PLN-style time-of-use base, raised by grid strain | retail > 2× normal for this hour |

Thresholds are tagged in the pipeline config as *standards-adjacent* (e.g. ±5 % voltage, 3σ
ramp, a 50 Hz grid-code band) or *tuned for this demo*. The operator can move all six at
runtime (`POST /api/thresholds`), and that genuinely retunes the engine. The dataset's own
baked-in `*_triggered` columns are ignored.

## From signal to alert

**Severity.** Each gate has a base severity and an escalation point (`SEVERITY_ESCALATION`):

| Parameter | Severity |
|---|---|
| peak load | warning, critical above 2.0× |
| frequency | critical, emergency beyond ±0.5 Hz |
| reserve margin | critical, emergency below 5 % |
| renewables | info at low demand, warning when demand is above forecast |
| emergency | critical, emergency above 0.8 |
| price | always warning (a tariff signal, not a physical state) |

**One alert per tick.** When several gates fire at once, the highest severity wins; ties go
to the more urgent parameter: emergency > frequency > reserve > peak load > renewables > price.
Losing a tie isn't suppression; the loser simply fires on a later tick.

**Cooldowns.** After a parameter fires it stays quiet for a number of simulated minutes set
by severity: emergency 60, critical 120, warning 300, info 600. Info is the longest because its
only source, low renewables at low demand, lasts all night.

**Operator-composed alerts.** `POST /api/alert/test` builds a real alert for any parameter and
severity from the live grid. It uses the same wording and the same maths, it's paid like any
other alert, and it never touches a cooldown.

## The incentive model

`src/server/grid/incentives.ts` owns every figure. Nothing is metered: the replay can't be
moved by a household's answer, so kWh is what the alert *asked for* and rupiah is an
*estimate*. Both apps say so.

- **Shed (kWh):** a base per parameter (emergency 2.0, frequency 1.8, reserve 1.5, peak 1.2,
  price 0.8, renewables 0.6) × severity (emergency 1.5, critical 1.25, otherwise 1.0).
- **Setpoint:** the same ask as power the LCU can enforce, shed ÷ window, where the window is
  60/90/120/180 minutes for emergency/critical/warning/info. A 3 kWh emergency ask is
  3000 W for 60 minutes.
- **Rate (Rp/kWh):** emergency 2000, frequency 1500, reserve 1200, peak 500, renewables 300.
  Price pays how far the price sits above normal for the hour.
- **Speed bonus:** ×1.25 within 2 minutes of delivery, ×1.10 within 5. Measured from the
  gateway's delivery, so an operator's delay never counts against a household.
- **Streak bonus:** +5 % per consecutive accept, capped at ×1.25. Stored per response as a
  snapshot, because answers can be changed later.
- **Reliability (operator only):** 0–100 from accept rate (70 %) and median reply speed (30 %).

`credit = rate × shed × speed × streak`, derived on read, never stored.

## The gateway gate

**Every alert and every answer passes through the ESP32 gateway, and it fails closed.**

```
Operator push → server ─relay_alert──▶ gateway ─forward_alert──▶ server → phones   (pushed_alert)
Household tap → server ─relay_response▶ gateway ─forward_response▶ server → operator (dsm_response)
```

The server only delivers what the gateway echoes back. With no gateway connected, a push is
recorded as *not delivered* and nothing reaches a phone. The rules that keep this true:

- The only code that sends `pushed_alert` or `dsm_response` is the `/ws/gateway` message handler.
- A delivery (`delivered_at`) and a household response are recorded only when the gateway echoes them.
- Anything a household can read (`/api/alerts/mine`, `/api/savings/mine`) filters on
  `delivered_at IS NOT NULL`, so history can't become a second delivery path.
- Consumer ticks are rebuilt with `alerts: []` rather than filtered.

**Two planes.** Telemetry (the tick) goes straight to every dashboard and is never gated.
Only alerts and answers cross the gateway. Control messages (`system_reset`,
`accounts_changed`, `esp32_status`) carry no alert content.

**Keeping the badge honest.** The server pings every socket every 20 s and drops those that
don't answer. The gateway also pings the server every 15 s and reconnects after two missed
pongs. A half-open socket would otherwise leave the badge green while alerts vanish.

**Alert lifecycle** (one row per triggered alert; a Resend increments `push_attempts`):

| State | Columns |
|---|---|
| pending | row exists, `pushed_at` null |
| failed-gateway | `pushed_at` set, `delivered_at` null |
| pushed / auto-pushed | `delivered_at` set |
| ignored | `ignored_at` set |

A simulation reset hides history (`cleared_at`) instead of deleting it.

## The ESP-NOW downlink

When a household accepts, the gateway commands the LCU (`firmware/gateway/espnow_link.cpp`).

- **A cache, not a field.** The setpoint rides `relay_alert`; the acceptance arrives later on
  `relay_response` carrying only an id. The gateway remembers the last 8 setpoints by alert id.
  An accept for an alert that never crossed the gateway commands nothing.
- **Watts become a run level.** The LCU's `powerPercent` is the level to *run at*, so the
  gateway sends `100 − shed/capacity × 100`. A missing setpoint is refused rather than
  defaulted, because "0 W to shed" would mean full power.
- **One command per alert.** Many households can accept one alert, but there's one load. The
  first acked accept arms it; the rest are tallied by the server and not re-sent.
- **The channel.** ESP-NOW only works when both radios share a channel, and an ESP32 connected
  to Wi-Fi can't leave its AP's channel. So **both boards join the same Wi-Fi** and follow the
  AP together (`LCU_CHANNEL 0`). If an LCU is fixed on another channel, the gateway detects it
  and hops briefly for each send.
- **Who may command the LCU.** The LCU only obeys `GATEWAY_MAC`. Commands from any other ESP32
  are logged and ignored. With `GATEWAY_MAC` unset, it accepts any sender.
- **Bring-up console.** Type `1000,2` in the gateway's serial monitor to command 1000 W for
  2 minutes without the server. `scan` sweeps channels for the LCU; `bcast` sends a broadcast
  probe to tell a wrong channel apart from a wrong MAC.

Wire contract (`firmware/shared/dsm_protocol.h`): `PowerCommand {float powerPercent; uint32_t
duration_ms}` is 8 bytes; `StatusMessage {char message[20]}` is 20 bytes. The two are told apart
by size only.

## Accounts

- One admin is seeded on first start from `ADMIN_USERNAME`/`ADMIN_PASSWORD`. It is never
  overwritten afterwards.
- Households register and wait in *pending* until the operator approves them. There's no email
  on a LAN demo, so the operator is the gate.
- 15-minute access JWTs plus 30-day refresh tokens, stored hashed and rotated on every use.
  Reusing a spent refresh token revokes every session for that user.
- The account row and its status are re-read on every request. Suspending or deleting someone
  also closes their live sockets (close code 4401), so it takes effect immediately.
- Login and registration allow 5 failures per IP and username per 15 minutes.
- The gateway authenticates with the static `GATEWAY_TOKEN`: it has no clock to run a refresh
  cycle, and the token is compiled into its firmware from `.env`.
- The **audit log** is append-only. Labels are snapshots, so a deleted account is still named,
  and "Clear log" only hides rows.

## Configuration flow

```
            npm run setup
                 │ writes
                 ▼
               .env ──────────────▶ server.ts (process.loadEnvFile, validated by src/server/env.ts)
                 │
                 └── firmware/scripts/load_env.py (PlatformIO pre-build)
                         └─▶ .pio/build/<board>/generated/dsm_settings.h ─▶ gateway / LCU firmware
```

The server and both boards read the same file, so the gateway token can't drift. The firmware
settings are compiled in, so **re-flash after changing `.env`**. The gateway doesn't need an
IP address: it looks up `_dsm._tcp` over mDNS and falls back to `SERVER_HOST` only if mDNS is blocked.

## HTTPS on the LAN

Over plain `http://<laptop-ip>:3000` everything works on a phone except system notifications
and "Add to Home Screen": browsers only allow those in a secure context (HTTPS or `localhost`).
The app says so instead of failing silently. To enable them:

1. Make a certificate for your LAN IP: `mkcert -install && mkcert 192.168.1.20 localhost`.
2. Put a TLS proxy on a second port, and leave port 3000 plain for the gateway. For example,
   with [Caddy](https://caddyserver.com): `caddy reverse-proxy --from https://192.168.1.20:3443 --to localhost:3000`
   (point Caddy at the mkcert files).
3. Install the mkcert root CA on each phone (`mkcert -CAROOT`), then open `https://192.168.1.20:3443`.

The pages build their WebSocket URL from the page's own origin, so `wss://` just works behind
the proxy.

## Code map

| Path | What |
|---|---|
| `server.ts` | starts Next, the WebSockets, the simulator and mDNS on one port |
| `src/server/grid/` | `dataset` (CSV loader), `simulator`, `control-logic`, `incentives`, `constants` |
| `src/server/realtime/` | `hub` (pools and fan-out), `sockets` (the three endpoints) |
| `src/server/db/` | Drizzle schema and migrations (applied automatically on start) |
| `src/server/alerts/store.ts` | the alert lifecycle writes |
| `src/app/api/` | REST endpoints |
| `src/app/admin`, `src/app/consumer` | the operator dashboard and the household app |
| `src/styles/` | design tokens and `ds-*` component styles (Tailwind v4) |
| `firmware/` | PlatformIO project for both boards |
| `tests/parity/` | replays the sample through the engine and checks it against the original Python output |
