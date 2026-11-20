// ============================================================================ DSM gateway: tuning
// constants.

#ifndef CONFIG_H
#define CONFIG_H

// WIFI_SSID, WIFI_PASSWORD, GATEWAY_TOKEN, LCU_PEER_MAC, SERVER_HOST, SERVER_PORT and
// LCU_TOTAL_CAPACITY_W, generated from .env at build time.
#include "dsm_settings.h"

// Serial
#define SERIAL_BAUD 115200

// WebSocket reconnect
#define WS_RECONNECT_INTERVAL_MS   3000
#define WS_RECONNECT_MAX_BACKOFF_MS 30000

// Wi-Fi connect timeout
#define WIFI_CONNECT_TIMEOUT_MS 15000

// ── Finding the server ──────────────────────────────────────────────────────
// The server advertises itself as `_dsm._tcp` over mDNS; the gateway looks that up, so no IP
// address is compiled in.
#define MDNS_DEVICE_NAME  "dsm-gateway"
#define MDNS_SERVICE      "dsm"
#define MDNS_PROTO        "tcp"

// The WebSocket path on the server. The token is appended at runtime.
#define WS_PATH_BASE      "/ws/gateway"

// ── WebSocket heartbeat ─────────────────────────────────────────────────────
// Without this, a half-open TCP socket is invisible to both ends: the board goes on believing it is
// connected and never reconnects, the server's send_text() succeeds into a kernel buffer without
// raising, and every alert pushed in that window is silently lost while the admin badge stays
// green.
#define WS_PING_INTERVAL_MS   15000  // send a ping this often
#define WS_PONG_TIMEOUT_MS     5000  // a pong must arrive within this
#define WS_MISSED_PONG_LIMIT      2  // ...this many times in a row -> drop

// How many consecutive failed connections before re-resolving the server address.
#define WS_FAILURES_BEFORE_RERESOLVE 3

// ── ESP-NOW downlink to the Load Control Unit ───────────────────────────────
// This board is both the DSM gateway and the central controller: it holds the server WebSocket and
// drives the LCU directly.

// Where the LCU listens.
#define LCU_CHANNEL 0

// How many times to ask the radio to change channel before calling it refused.
#define ESPNOW_HOP_TRIES 25

// How many times to fire the same command inside one hop window before calling it undelivered.
#define ESPNOW_SEND_ATTEMPTS 3

// How long to wait for the radio-level ack before giving up and returning to the STA's channel.
#define ESPNOW_ACK_TIMEOUT_MS 50

// The LCU's TOTAL capacity in watts.

// How many in-flight alerts keep their setpoint.
#define ESPNOW_THROTTLE_CACHE_SIZE 8

// One alert fans out to every phone, so several households can accept it — but there is one
// physical load downstream.
#define ESPNOW_ONE_COMMAND_PER_ALERT 1

// The cache key the serial bring-up console parks its setpoint under.
#define ESPNOW_TEST_ALERT_ID "serial-test"

#endif
