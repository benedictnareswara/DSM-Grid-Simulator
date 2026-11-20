// ============================================================================ The ESP-NOW wire
// contract between the gateway and the LCU.

#ifndef DSM_PROTOCOL_H
#define DSM_PROTOCOL_H

#include <stdint.h>

// Gateway → LCU.
typedef struct {
  float    powerPercent;
  uint32_t duration_ms;
} PowerCommand;
static_assert(sizeof(PowerCommand) == 8, "PowerCommand layout is shared by both boards");

// LCU → gateway: "GOT", "DONE", or the "LCU-ALIVE" heartbeat.
typedef struct {
  char message[20];
} StatusMessage;
static_assert(sizeof(StatusMessage) == 20, "StatusMessage layout is shared by both boards");

#endif
