# DSM — Demand-Side Management Grid Simulator

Replays four years of real household power data as a simulated neighbourhood grid
(Indonesian PLN, 220 V / 50 Hz). When the grid is stressed, the operator sends an
alert to households' phones, and when a household accepts, an ESP32 actually turns
down a real electrical load.

- **Operator dashboard:** live grid gauges, alert feed, thresholds you can tune, accounts, audit log
- **Household app:** a phone web app (installable) with alerts, grid status and estimated savings
- **Two ESP32 boards:** a *gateway* that carries every alert and answer, and a *load controller* (LCU) that dims the load

Everything runs on your own computer and Wi-Fi. No cloud account is needed.

---

## What you need

- A computer with **[Node.js](https://nodejs.org) 22 or newer**
- A **2.4 GHz Wi-Fi network** that your computer, phones and boards can all join
  (an iPhone hotspot works: turn on *Maximize Compatibility*)
- *For the hardware (optional):* two **ESP32 DevKit** boards, an AC dimmer module and
  **[PlatformIO](https://platformio.org/install)** (the VS Code extension or `pip install platformio`).
  See [docs/HARDWARE.md](docs/HARDWARE.md).

## Quick start (about 5 minutes, no hardware)

```bash
git clone https://github.com/benedictnareswara/DSM-Grid-Simulator.git
cd DSM-Grid-Simulator
npm install
npm run setup
npm run dev
```

`npm run setup` asks four questions (Wi-Fi name, Wi-Fi password and the two board
MAC addresses). **Press Enter to skip any you don't know yet.** It then prints an admin
password.

Open **http://localhost:3000**, sign in as `admin` with that password, and press **Start**.

To try the household side, open the *Phones on Wi-Fi* address that `npm run dev` prints
(for example `http://192.168.1.20:3000`) on your phone, create an account, then approve
it in the dashboard under **Accounts**.

> **Why don't alerts reach the phone yet?** By design, every alert travels through the
> ESP32 gateway. With no gateway connected the dashboard shows **Gateway: Down** and
> pushes aren't delivered. Add the hardware below to complete the loop.

## Adding the hardware

1. **Flash each board once to get its MAC address.** Plug in the gateway board and run:
   ```bash
   npm run flash:gateway
   ```
   ```bash
   npm run monitor:gateway
   ```
   The first lines print `MAC: AA:BB:CC:DD:EE:FF`. Do the same for the other board
   with `npm run flash:lcu` and `npm run monitor:lcu`.
2. **Put both MACs in `.env`** (`GATEWAY_MAC` and `LCU_MAC`), or run `npm run setup` again.
3. **Flash both boards again** so they pick up the MACs:
   ```bash
   npm run flash:gateway
   ```
   ```bash
   npm run flash:lcu
   ```
4. With `npm run dev` running, the gateway finds your computer by itself and the
   dashboard shows **Gateway: Up**. Push an alert, accept it on a phone, and the LCU
   turns the load down.

## Configuration

Everything lives in one file, **`.env`** in the project folder. `npm run setup` writes
it for you. There are only four values to fill in:

| Setting | What it is |
|---|---|
| `WIFI_SSID` / `WIFI_PASSWORD` | Your 2.4 GHz Wi-Fi. Both boards join it. |
| `GATEWAY_MAC` | MAC of the gateway board (printed when it starts) |
| `LCU_MAC` | MAC of the load-control board (printed when it starts) |

Everything else (login secret, gateway token, admin password) is generated. Optional
settings such as the port or the load's wattage are listed in [`.env.example`](.env.example).
**If you change `.env`, re-flash the boards**, because the firmware reads it when it's built.

## Using the full dataset

The repo includes a 3-week sample so it starts instantly. For the full 4-year replay:

```bash
npm run data:full
```

Then set `DATASET=full` in `.env` and restart `npm run dev`.

## Troubleshooting

| Problem | Fix |
|---|---|
| **Gateway: Down** even though the board is on | The board and computer must be on the **same** Wi-Fi, and it must be 2.4 GHz. Check the board's log with `npm run monitor:gateway`. |
| Gateway log says *Could not find the server* | Your network blocks mDNS. Set `SERVER_HOST` in `.env` to your computer's IP (shown by `npm run dev`), then `npm run flash:gateway`. |
| Gateway log says *Server rejected this gateway* | `.env` changed since the board was flashed. Run `npm run flash:gateway` again. |
| LCU log says *REJECTED command from …* | `GATEWAY_MAC` in `.env` doesn't match the gateway. Fix it, then `npm run flash:lcu`. |
| Phone can't open the page | Use the *Phones on Wi-Fi* address, not `localhost`, and make sure the phone is on the same Wi-Fi. |
| *Your .env is missing or invalid* | Run `npm run setup`. |

More help: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## How it works

```
Phone / laptop ──HTTP + WebSocket──▶  DSM server (npm run dev)  ──▶  SQLite file (data/dsm.db)
                                           ▲
                                           │ WebSocket, found via mDNS
                                    ESP32 gateway
                                           │ ESP-NOW radio
                                    ESP32 LCU ──▶ dimmer ──▶ load
```

Every tick the server replays one minute of the dataset and checks six grid signals
(peak load, frequency, reserve margin, renewables, an emergency score and price). When
one crosses its threshold it raises an alert. The operator pushes it, the **gateway**
forwards it to phones, a household accepts, and the gateway tells the **LCU** how many
watts to shed and for how long. The full story (thresholds, cooldowns, the incentive
model, and why everything goes through the gateway) is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Project layout

```
src/app/          pages (admin dashboard, household app) and the REST API
src/server/       simulator, control logic, incentives, database, WebSockets
server.ts         starts everything on one port
firmware/         both ESP32 boards (PlatformIO); settings come from .env
data/             the sample dataset (and the full one, once downloaded)
tools/pipeline/   optional Python script that built the dataset
tests/            npm test
```

## Development

```bash
npm test             # unit, API and realtime tests (includes parity with the original Python engine)
npm run lint
npm run typecheck
npm run build        # production build; then `npm start`
```

## License

MIT © 2026 Benedict Nareswara. The household data is the UCI
[Individual Household Electric Power Consumption](https://archive.ics.uci.edu/dataset/235)
dataset (CC BY 4.0).
