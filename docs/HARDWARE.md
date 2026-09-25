# Hardware

Two ESP32 boards complete the loop from "household taps Accept" to "the load actually drops".

| Board | Job | Firmware |
|---|---|---|
| **Gateway** | Holds the WebSocket to the server and relays every alert and answer. On an accept, it commands the LCU over ESP-NOW. | `firmware/gateway` |
| **LCU** (load control unit) | Drives a TRIAC dimmer to run the load at the commanded level for the commanded time. | `firmware/lcu` |

> ⚠️ **Mains voltage can kill.** The LCU switches 220 V AC. Never touch the circuit while
> it's plugged in. The gateway board has no mains wiring and is safe to use on its own.

## Parts

- 2 × **ESP32 DevKit** (ESP32-WROOM-32, the `esp32dev` board in PlatformIO)
- 1 × **AC dimmer module** with a TRIAC output and a zero-cross output (the common
  "AC light dimmer module" boards work)
- A **resistive load** such as a heater or an incandescent lamp. The firmware assumes a 3 kW
  load; set `LCU_CAPACITY_W` in `.env` to your load's rating.
- USB cables for flashing

## Flashing

From the repo root, with `.env` written by `npm run setup`:

```bash
npm run flash:gateway
```
```bash
npm run flash:lcu
```

Watch a board's serial output:

```bash
npm run monitor:gateway
```
```bash
npm run monitor:lcu
```

Each board prints its **MAC address** first. Put them in `.env` as `GATEWAY_MAC` and
`LCU_MAC`, then flash both boards again.

A healthy gateway looks like this:

```
[WiFi] Connected — IP: 192.168.1.42
[ESP-NOW] ready — this board AA:BB:CC:DD:EE:01, LCU AA:BB:CC:DD:EE:02
[ESP-NOW] LCU follows the AP — both on channel 6, direct send
[WS] Server found via mDNS (_dsm._tcp) -> 192.168.1.20:3000
[WS] Connected to ws://192.168.1.20:3000/ws/gateway?token=<redacted>
[ESP-NOW] LCU is alive on channel 6
```

## Testing the radio link without the server

In the **gateway's** serial monitor, type:

| Command | What it does |
|---|---|
| `1000,2` | command the LCU to shed 1000 W for 2 minutes |
| `scan` | try every channel to find the LCU |
| `bcast` | send a broadcast probe (tells a wrong channel apart from a wrong MAC) |

The LCU's monitor prints `NEW COMMAND RECEIVED` and the firing angle it chose.

## Calibrating the LCU

These constants in `firmware/lcu/main.cpp` describe *your* hardware:

| Constant | Default | Meaning |
|---|---|---|
| `SYNC_PIN` / `THYRISTOR_PIN` | 34 / 14 | zero-cross input and TRIAC gate pins |
| `MEASURED_FULL_POWER_W` | 2810 | what the load actually draws at full conduction. The phase-angle curve is calibrated against this, not the nameplate. |
| `AC_FREQUENCY_HZ` | 50 | mains frequency (Indonesia: 50 Hz) |
| `HARDWARE_DELAY_OFFSET_US` | 1140 | the zero-cross detector's own delay. Re-measure it if you change the module. |

## How the two boards find each other

- **Same Wi-Fi, same channel.** ESP-NOW only works when both radios share a channel, and a
  board connected to Wi-Fi is locked to its access point's channel. So both boards join the
  Wi-Fi in `.env` and follow the AP together.
- **The LCU only obeys the gateway** named by `GATEWAY_MAC`. Commands from any other ESP32 in
  range are logged (`REJECTED command from …`) and ignored.
- **The gateway only commands the LCU** named by `LCU_MAC`, and only for alerts that actually
  passed through it.

More background in [ARCHITECTURE.md](ARCHITECTURE.md#the-esp-now-downlink).
