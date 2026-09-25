// ============================================================================
// DSM gateway: tuning constants.
//
// Nothing here is per-deployment. Wi-Fi, the LCU's MAC, the gateway token and
// the load's capacity come from the repo-root .env, injected at build time by
// scripts/load_env.py.
// ============================================================================

#ifndef CONFIG_H
#define CONFIG_H

// WIFI_SSID, WIFI_PASSWORD, GATEWAY_TOKEN, LCU_PEER_MAC, SERVER_HOST,
// SERVER_PORT and LCU_TOTAL_CAPACITY_W, generated from .env at build time.
#include "dsm_settings.h"

// Serial
#define SERIAL_BAUD 115200

// WebSocket reconnect
#define WS_RECONNECT_INTERVAL_MS   3000
#define WS_RECONNECT_MAX_BACKOFF_MS 30000

// Wi-Fi connect timeout
#define WIFI_CONNECT_TIMEOUT_MS 15000

// ── Finding the server ──────────────────────────────────────────────────────
// The server advertises itself as `_dsm._tcp` over mDNS; the gateway looks that
// up, so no IP address is compiled in. SERVER_HOST in .env is the fallback for
// networks that block mDNS.
//
// The board's own mDNS name. It has to run a responder to query, so it may as
// well have a recognisable name.
#define MDNS_DEVICE_NAME  "dsm-gateway"
#define MDNS_SERVICE      "dsm"
#define MDNS_PROTO        "tcp"

// The WebSocket path on the server. The token is appended at runtime.
#define WS_PATH_BASE      "/ws/gateway"

// ── WebSocket heartbeat ─────────────────────────────────────────────────────
// Without this, a half-open TCP socket is invisible to both ends: the board
// goes on believing it is connected and never reconnects, the server's
// send_text() succeeds into a kernel buffer without raising, and every alert
// pushed in that window is silently lost while the admin badge stays green.
// Unplugging the board's Wi-Fi (or roaming APs) does exactly this — a dropped
// link does not produce a TCP FIN.
#define WS_PING_INTERVAL_MS   15000  // send a ping this often
#define WS_PONG_TIMEOUT_MS     5000  // a pong must arrive within this
#define WS_MISSED_PONG_LIMIT      2  // ...this many times in a row -> drop

// How many consecutive failed connections before re-resolving the server
// address. Covers the case that used to require a reflash: the server's DHCP
// lease moved while the board was running, so the address it resolved at boot
// is now someone else's.
#define WS_FAILURES_BEFORE_RERESOLVE 3

// ── ESP-NOW downlink to the Load Control Unit ───────────────────────────────
// This board is both the DSM gateway and the central controller: it holds the
// server WebSocket and drives the LCU directly. The LCU's MAC is LCU_MAC in
// .env, compiled in as LCU_PEER_MAC.
//
// CHANNEL. ESP-NOW is layer 2: both radios must sit on the same Wi-Fi channel or
// the frames are never heard — no error, no callback. The retired Central
// Controller had it easy, because it never joined Wi-Fi at all: an unassociated
// STA parks on channel 1, which is where the LCU is. This board cannot do that,
// being pinned to the AP's channel by the WebSocket it must keep open.
//
// espnowBegin() compares the two at boot and enables hop-to-send if they differ,
// so this needs no configuring. Put the AP on LCU_CHANNEL (or teach the LCU to
// join Wi-Fi, which makes it follow the AP) and the hop stops engaging by
// itself, with no rebuild. Prefer that: hopping costs ~50 ms off-channel per
// command and means the LCU's replies can never reach us.

// Where the LCU listens. 1 is the ESP32 default for a station that never
// associates, which is what the LCU's sketch does today.
//
// 0 means "wherever I am": the LCU joins the same Wi-Fi as this board, so the
// two track the AP together through any channel change and nothing here can go
// stale. That's how the LCU firmware in this repo works. Only set a channel if
// you run an LCU that never joins Wi-Fi.
#define LCU_CHANNEL 0

// How many times to ask the radio to change channel before calling it refused.
// The driver declines transiently while it is busy with the association, so a
// single try under-reports badly — it took four asks to land the first time.
#define ESPNOW_HOP_TRIES 25

// How many times to fire the same command inside one hop window before calling
// it undelivered. Re-hopping per attempt would cost another excursion for
// nothing — the radio is already parked on the LCU's channel.
#define ESPNOW_SEND_ATTEMPTS 3

// How long to wait for the radio-level ack before giving up and returning to the
// STA's channel. Generous for a single frame at close range; the whole point is
// that the excursion is three orders of magnitude below the 15 s WebSocket ping.
#define ESPNOW_ACK_TIMEOUT_MS 50

// The LCU's TOTAL capacity in watts. The server speaks absolute watts to shed
// (`DSMAlert.target_reduction_w`, derived by throttleSetpoint() on the server);
// the LCU reads a percentage of this figure and runs at it. This is a property
// of the hardware, not of the incentive model — do not "improve" it into a
// second opinion about how much an alert should ask for.
//
// Every alert's shed is arithmetic on this one number, so a wrong value is a
// wrong shed on every alert. WATTS, not watt-hours: it's a power rating.
// Set by LCU_CAPACITY_W in .env (LCU_TOTAL_CAPACITY_W); the LCU build reads the
// same value.

// How many in-flight alerts keep their setpoint. Only has to cover the gap
// between a push and a household answering it.
#define ESPNOW_THROTTLE_CACHE_SIZE 8

// One alert fans out to every phone, so several households can accept it — but
// there is one physical load downstream. 1 = the first accept arms it and the
// rest are dropped at this board (the server still tallies them all).
#define ESPNOW_ONE_COMMAND_PER_ALERT 1

// The cache key the serial bring-up console parks its setpoint under. Typing
// `<watts>,<minutes>` at this board's monitor fires one command at the LCU with
// no server, dashboard or household involved — the only way to test the radio
// leg in isolation, since the ordinary path transmits only on a real accept.
#define ESPNOW_TEST_ALERT_ID "serial-test"



#endif
