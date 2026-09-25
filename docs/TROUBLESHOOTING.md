# Troubleshooting

Most problems are one of three things: the boards and computer are on different Wi-Fi
networks, `.env` changed without re-flashing, or a MAC address is wrong. The serial monitors
(`npm run monitor:gateway` / `npm run monitor:lcu`) usually say which.

## The app

**`Your .env is missing or invalid`** when running `npm run dev`
Run `npm run setup`. It writes `.env` and generates the secrets.

**I lost the admin password**
It's in `.env` as `ADMIN_PASSWORD`, but only if you haven't changed it in the app since.
If you have, stop the server, delete `data/dsm.db` (this erases all accounts and history), and
start again: the admin is re-created from `.env`.

**A phone can't open the page**
Use the *Phones on Wi-Fi* address printed by `npm run dev`, not `localhost`. The phone must be on
the same Wi-Fi. Some routers isolate clients ("AP isolation" / "guest network"); turn that off.

**No notifications on the phone**
Browsers only allow notifications over HTTPS. Alerts still arrive in the open app, with a sound.
See [HTTPS on the LAN](ARCHITECTURE.md#https-on-the-lan).

**`Error: listen EADDRINUSE`**
Something else is using port 3000. Set `PORT=3001` in `.env`, then re-flash the gateway if you
set `SERVER_HOST`.

## The gateway

| Serial log says | Meaning and fix |
|---|---|
| `No AP with that SSID is on the air` | Wrong `WIFI_SSID`, or the network is 5 GHz only. ESP32 is 2.4 GHz only (iPhone hotspot: turn on *Maximize Compatibility*). |
| `The AP answered and refused us` | Wrong `WIFI_PASSWORD`. Fix `.env`, then `npm run flash:gateway`. |
| `Could not find the server` | `npm run dev` isn't running, it's on another network, or mDNS is blocked. Set `SERVER_HOST` in `.env` to the computer's IP and re-flash. |
| `Server rejected this gateway: Invalid gateway token` | `.env` was regenerated after flashing. Run `npm run flash:gateway` again. |
| `LCU_MAC is not set in .env` | Flash the LCU, copy the MAC it prints into `.env`, re-flash the gateway. |
| `add_peer FAILED` | `LCU_MAC` is malformed. It should look like `AA:BB:CC:DD:EE:FF`. |
| `LCU did NOT ack` | The LCU is off, on another Wi-Fi, or `LCU_MAC` is wrong. Try `scan` and `bcast` in the gateway's monitor. |
| `heard AA:BB:… on channel N` | A board is reachable on the channel but isn't the configured LCU. If that's your LCU, fix `LCU_MAC`. |

**The dashboard says Gateway: Down, but the board says Connected**
They're connected to different servers or networks. Compare the board's `Connected to ws://…`
address with the one `npm run dev` printed.

## The LCU

| Serial log says | Meaning and fix |
|---|---|
| `COULD NOT JOIN — falling back to channel 1` | Wrong Wi-Fi settings. The gateway can't reach it until it joins the same network. |
| `REJECTED command from …` | `GATEWAY_MAC` in `.env` doesn't match the gateway. The logged MAC is the one that tried. |
| `GATEWAY_MAC not set … accepting commands from ANY ESP32` | Fine for a first test; set `GATEWAY_MAC` and re-flash before leaving it running. |
| Load doesn't change | Check that `SYNC_PIN` and `THYRISTOR_PIN` match your hardware, and see [HARDWARE.md](HARDWARE.md#calibrating-the-lcu). |

## Building the firmware

**`PlatformIO isn't installed`**
Install the PlatformIO IDE extension for VS Code, or run `pip install platformio`.

**`WIFI_SSID is empty in .env`**
Run `npm run setup` and enter your Wi-Fi name.

**Upload fails / no serial port**
Use a data-capable USB cable. On some boards, hold **BOOT** while the upload starts.
