// ============================================================================ DSM gateway —
// ESP-NOW downlink to the Load Control Unit (LCU)
// -------------------------------------------
// The setpoint rides the alert on `relay_alert`.
// -------------------
// ESP-NOW is layer 2: both radios must sit on the same Wi-Fi channel or frames are simply never
// heard.

#ifndef ESPNOW_LINK_H
#define ESPNOW_LINK_H

#include <Arduino.h>

// Bring up (or rebuild) the ESP-NOW link and register the LCU as a peer.
void espnowBegin();

// Drain the callback flags, retire an expired event window, and poll the serial bring-up console.
void espnowLoop();

// Record what an alert asked for, as it crosses the broker.
void espnowRememberAlert(const char* alertId, float targetReductionW,
                         int durationMinutes);

// A household accepted `alertId`.
bool espnowDispatchAccepted(const char* alertId, const char* username);

#endif
