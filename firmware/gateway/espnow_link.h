// ============================================================================
// DSM gateway — ESP-NOW downlink to the Load Control Unit (LCU)
//
// This board is now both the DSM gateway and the central controller. It holds
// the server WebSocket *and* drives the LCU over ESP-NOW, which the standalone
// CC used to do:
//
//   Admin → server → [this board] → server → Consumer        (WebSocket)
//   Consumer → server → [this board] → server → Admin        (WebSocket)
//   ...and on an accept: [this board] --ESP-NOW--> LCU       (this file)
//
// Why a cache and not a field on the response
// -------------------------------------------
// The setpoint rides the alert on `relay_alert`. The acceptance arrives later on
// `relay_response`, which carries an alert *id*, a boolean and an identity, and
// nothing else. `relayResponse()` rebuilds its payload field by field precisely
// so a response cannot carry throttle data (docs/ARCHITECTURE.md), so this module
// remembers what each alert asked for as it passes through and looks it up when
// the household says yes.
//
// Nothing here can originate a command. An alert that never crossed this board
// leaves no cache entry, so an accept for it dispatches nothing — the ESP-NOW
// leg inherits the fail-closed property of the leg above it rather than
// restating it.
//
// The channel problem
// -------------------
// ESP-NOW is layer 2: both radios must sit on the same Wi-Fi channel or frames
// are simply never heard. This board is pinned to its AP's channel by the
// WebSocket it must keep open, so the LCU joins the same Wi-Fi and follows the
// AP too. espnowBegin() still detects a mismatch (an LCU fixed on another
// channel) and falls back to hop-to-send. See config.h.
// ============================================================================

#ifndef ESPNOW_LINK_H
#define ESPNOW_LINK_H

#include <Arduino.h>

// Bring up (or rebuild) the ESP-NOW link and register the LCU as a peer.
//
// Idempotent, and must be called *after* Wi-Fi is associated: ESP-NOW rides the
// STA radio, and the channel comparison that decides hop-to-send is meaningless
// until there is a channel. Called again after every reconnect, because
// `WiFi.disconnect(true)` tears the stack down under us — and because the AP may
// have moved channel while we were off the air.
void espnowBegin();

// Drain the callback flags, retire an expired event window, and poll the serial
// bring-up console. Radio callbacks run on the Wi-Fi task, so they only set
// state; everything observable happens here.
void espnowLoop();

// Record what an alert asked for, as it crosses the broker. Alerts predating the
// throttle model carry neither field and are not cached — see the guard's own
// comment, which is load-bearing now that a missing setpoint would otherwise
// mean full power.
void espnowRememberAlert(const char* alertId, float targetReductionW,
                         int durationMinutes);

// A household accepted `alertId`. Looks up the cached setpoint and commands the
// LCU. Returns false when nothing was sent (unknown alert, no setpoint, already
// commanded) or when the LCU's radio did not ack — the caller logs, it is not an
// error.
bool espnowDispatchAccepted(const char* alertId, const char* username);

#endif
