// ============================================================================
// The ESP-NOW wire contract between the gateway and the LCU.
//
// One definition, included by both boards, so the two can't drift. There's no
// schema, version or length prefix: the *sizes* are what tell the messages
// apart, and the receiver copies whatever arrives. The static_asserts are the
// only thing that will catch the layout moving. Both boards are little-endian
// ESP32s, so no byte-order work is needed.
// ============================================================================

#ifndef DSM_PROTOCOL_H
#define DSM_PROTOCOL_H

#include <stdint.h>

// Gateway → LCU. `powerPercent` is the level to RUN AT (0..100), not the amount
// to shed, so shedding nothing means 100. The gateway's wattsToRunLevelPercent()
// does that conversion.
typedef struct {
  float    powerPercent;
  uint32_t duration_ms;
} PowerCommand;
static_assert(sizeof(PowerCommand) == 8, "PowerCommand layout is shared by both boards");

// LCU → gateway: "GOT", "DONE", or the "LCU-ALIVE" heartbeat. NOT guaranteed
// NUL-terminated.
typedef struct {
  char message[20];
} StatusMessage;
static_assert(sizeof(StatusMessage) == 20, "StatusMessage layout is shared by both boards");

#endif
