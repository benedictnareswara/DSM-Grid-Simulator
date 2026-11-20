// ============================================================================ DSM gateway —
// ESP-NOW downlink to the Load Control Unit See espnow_link.h for why this is a cache, and why the
// channel is the hard part of doing this on a board that also holds a Wi-Fi connection.

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <string.h>
#include <stdlib.h>

#include "espnow_link.h"
#include "config.h"
#include "dsm_protocol.h"   // PowerCommand / StatusMessage, shared with the LCU

// ── Peer and radio ──────────────────────────────────────────────────────────
static uint8_t lcuMac[6] = {LCU_PEER_MAC};
static bool    linkUp    = false;

// Where the STA is parked, recorded at begin().
static uint8_t staChannel = 0;

// True when the LCU is not on our channel and every command needs a brief excursion.
static bool hopToSend = false;

// ── The alert_id → setpoint cache ───────────────────────────────────────────
// A ring, not a map: it only has to survive the gap between an alert being pushed and a household
// answering it.
struct CachedThrottle {
  char     alertId[24];
  float    watts;
  uint16_t minutes;
  bool     dispatched;
};

static CachedThrottle cache[ESPNOW_THROTTLE_CACHE_SIZE];
static uint8_t        cacheNext = 0;

static CachedThrottle* findCached(const char* alertId) {
  if (!alertId || !alertId[0]) return nullptr;
  for (uint8_t i = 0; i < ESPNOW_THROTTLE_CACHE_SIZE; i++) {
    if (cache[i].alertId[0] && strcmp(cache[i].alertId, alertId) == 0) {
      return &cache[i];
    }
  }
  return nullptr;
}

// ── The active event window ─────────────────────────────────────────────────
// The CC tracked this as `waitingForFinish`, set on send and cleared *only* when the LCU replied
// "DONE".
static bool          eventActive    = false;
static unsigned long eventEndsAtMs  = 0;
static char          eventAlertId[24] = {0};

// Overflow-safe: millis() wraps at ~49 days and a plain `>=` compares wrong across the wrap.
static bool eventExpired() {
  return eventActive && (long)(millis() - eventEndsAtMs) >= 0;
}

// ── Callback state ──────────────────────────────────────────────────────────
// Both ESP-NOW callbacks run on the Wi-Fi task.
static volatile bool sendResultPending = false;
static volatile bool sendResultOk      = false;
static volatile bool statusPending     = false;
static char          statusText[sizeof(StatusMessage) + 1];

// Set only while the `bcast` probe is listening, so an unexpected sender's MAC is captured instead
// of dropped.
static bool          lcuSeen       = false;
static unsigned long lcuLastSeenMs = 0;

static volatile bool    heardPending = false;
static volatile uint8_t heardMac[6]  = {0};
static volatile char    heardText[sizeof(StatusMessage) + 1] = {0};

static void onEspNowSent(const uint8_t* mac, esp_now_send_status_t status) {
  sendResultOk      = (status == ESP_NOW_SEND_SUCCESS);
  sendResultPending = true;
}

// Arduino-ESP32 3.x changed this signature; keep both so a core bump does not silently stop
// compiling the callback in.
#if ESP_ARDUINO_VERSION_MAJOR >= 3
static void onEspNowRecv(const esp_now_recv_info_t* info, const uint8_t* data, int len) {
  const uint8_t* mac = info->src_addr;
#else
static void onEspNowRecv(const uint8_t* mac, const uint8_t* data, int len) {
#endif
  // Length-checked, unlike the CC sketch's callback.
  if (len <= 0 || (size_t)len > sizeof(StatusMessage)) return;

  if (memcmp(mac, lcuMac, 6) != 0) {
    // Not the MAC we are configured for.
    if (!heardPending) {
      memcpy((void*)heardMac, mac, 6);
      memset((void*)heardText, 0, sizeof(heardText));
      memcpy((void*)heardText, data, len);
      heardPending = true;
    }
    return;
  }

  memset(statusText, 0, sizeof(statusText));
  memcpy(statusText, data, len);
  statusText[len] = '\0';
  statusPending = true;
}

// ── Radio channel ───────────────────────────────────────────────────────────
// The promiscuous toggle is what makes set_channel take on an associated STA; it is the same dance
// the CC-side sketches use.
static uint8_t currentChannel() {
  uint8_t ch; wifi_second_chan_t second;
  esp_wifi_get_channel(&ch, &second);
  return ch;
}

// There is more than one incantation for this and which one works depends on the IDF build, so try
// them rather than picking one and hoping.
static uint8_t tryHop(int method, uint8_t channel) {
  switch (method) {
    case 1:  // promiscuous bracket — the usual recipe, and what the CC used
      esp_wifi_set_promiscuous(true);
      esp_wifi_set_channel(channel, WIFI_SECOND_CHAN_NONE);
      esp_wifi_set_promiscuous(false);
      break;
    case 2:  // bare call — sometimes sticks where the bracket snaps back
      esp_wifi_set_channel(channel, WIFI_SECOND_CHAN_NONE);
      break;
    case 3:  // hold promiscuous across the send; the driver leaves us alone
      esp_wifi_set_promiscuous(true);
      esp_wifi_set_channel(channel, WIFI_SECOND_CHAN_NONE);
      break;
  }
  return currentChannel();
}

// Which method last moved the radio: -1 unknown, 0 none of them work here, 1..3 that one.
static int hopMethod = -1;

// Move the radio, by whatever means actually works.
static uint8_t setRadioChannel(uint8_t channel) {
  // Already there: do nothing and announce nothing.
  if (currentChannel() == channel) return channel;

  if (hopMethod == 3) esp_wifi_set_promiscuous(false);

  if (hopMethod > 0) {
    uint8_t landed = tryHop(hopMethod, channel);
    if (landed == channel) return landed;
    hopMethod = -1;   // it stopped working; fall through and re-probe, quietly
  }

  static int announced = 0;
  for (int m = 1; m <= 3; m++) {
    uint8_t landed = tryHop(m, channel);
    if (landed == channel) {
      if (m != announced) {
        Serial.printf("[ESP-NOW] channel hop works via method %d\n", m);
        announced = m;
      }
      hopMethod = m;
      return landed;
    }
    if (m == 3) esp_wifi_set_promiscuous(false);
  }

  hopMethod = 0;
  return currentChannel();
}

// The refusal is usually transient, not permanent: the driver declines while it is busy servicing
// the association and allows it a moment later.
static bool hopUntil(uint8_t channel) {
  for (int i = 0; i < ESPNOW_HOP_TRIES; i++) {
    if (setRadioChannel(channel) == channel) {
      if (i > 0) Serial.printf("[ESP-NOW] reached channel %u after %d tries\n",
                               (unsigned)channel, i + 1);
      return true;
    }
    delay(2);
  }
  return false;
}

// Broadcast reaches any ESP-NOW receiver on the channel regardless of its MAC, because an
// unencrypted receiver's callback does not consult its peer list.
static const uint8_t bcastMac[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

#define STRINGIFY_(x) #x
#define STRINGIFY(x)  STRINGIFY_(x)

// ── Setup ───────────────────────────────────────────────────────────────────
void espnowBegin() {
  linkUp    = false;
  hopToSend = false;

  // All zeros means LCU_MAC isn't in .env yet.
  bool macSet = false;
  for (uint8_t i = 0; i < 6; i++) if (lcuMac[i]) macSet = true;
  if (!macSet) {
    Serial.println("[ESP-NOW] LCU_MAC is not set in .env, so the LCU downlink is off.");
    Serial.println("[ESP-NOW] Flash the LCU, copy the MAC it prints into .env, then");
    Serial.println("[ESP-NOW] re-flash this board (npm run flash:gateway).");
    return;
  }

  // Idempotent: connectWiFi() calls WiFi.disconnect(true), which takes the stack (and every
  // registered peer) down.
  esp_now_deinit();

  // ESP-NOW receives are dropped while the STA is in modem sleep.
  WiFi.setSleep(false);

  if (esp_now_init() != ESP_OK) {
    Serial.println("[ESP-NOW] init FAILED — LCU downlink is dark");
    return;
  }

  esp_now_register_send_cb(onEspNowSent);
  esp_now_register_recv_cb(onEspNowRecv);

  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, lcuMac, 6);
  // 0 = "use whatever channel the radio is on at transmit time", which is what makes hop-to-send
  // work without re-registering the peer.
  peer.channel = 0;
  peer.encrypt = false;
  peer.ifidx   = WIFI_IF_STA;

  if (esp_now_add_peer(&peer) != ESP_OK) {
    Serial.println("[ESP-NOW] add_peer FAILED — check LCU_MAC in .env");
    return;
  }

  // Broadcast needs its own peer entry.
  esp_now_peer_info_t bpeer = {};
  memcpy(bpeer.peer_addr, bcastMac, 6);
  bpeer.channel = 0;
  bpeer.encrypt = false;
  bpeer.ifidx   = WIFI_IF_STA;
  esp_now_add_peer(&bpeer);

  linkUp = true;

  wifi_second_chan_t second;
  esp_wifi_get_channel(&staChannel, &second);
  // LCU_CHANNEL 0 means the LCU rides the same AP we do, so it is on our channel by definition and
  // there is nothing to hop to.
  hopToSend = (LCU_CHANNEL != 0) && (staChannel != LCU_CHANNEL);

  Serial.printf("[ESP-NOW] ready — this board %s, LCU %02X:%02X:%02X:%02X:%02X:%02X\n",
                WiFi.macAddress().c_str(),
                lcuMac[0], lcuMac[1], lcuMac[2], lcuMac[3], lcuMac[4], lcuMac[5]);

  if (hopToSend) {
    Serial.printf("[ESP-NOW] STA on channel %u, LCU on channel %u — hop-to-send enabled\n",
                  staChannel, (unsigned)LCU_CHANNEL);
    Serial.println("[ESP-NOW] replies from the LCU cannot arrive while hopping; the event");
    Serial.println("[ESP-NOW] window is timed locally. Put the AP on the LCU's channel to");
    Serial.println("[ESP-NOW] retire this — the hop then stops engaging by itself.");
  } else if (LCU_CHANNEL == 0) {
    Serial.printf("[ESP-NOW] LCU follows the AP — both on channel %u, direct send\n", staChannel);
  } else {
    Serial.printf("[ESP-NOW] STA and LCU both on channel %u — direct send\n", staChannel);
  }
}

// ── Watts → the LCU's percentage ────────────────────────────────────────────
// The server speaks absolute watts to shed; the LCU reads `powerPercent` as the level to RUN AT, as
// a percentage of its total capacity.
static float wattsToRunLevelPercent(float wattsToShed) {
  float shedPct = (wattsToShed / LCU_TOTAL_CAPACITY_W) * 100.0f;
  if (shedPct < 0.0f)   shedPct = 0.0f;
  if (shedPct > 100.0f) shedPct = 100.0f;   // asking for more than the load has
  return 100.0f - shedPct;                  // ...clamps to 0% = fully off
}

// ── Send ────────────────────────────────────────────────────────────────────
// Returns true only when the LCU's radio acked the frame.
static bool sendCommandToLcu(float runLevelPercent, uint32_t durationMs) {
  PowerCommand cmd;
  cmd.powerPercent = runLevelPercent;
  cmd.duration_ms  = durationMs;

  // Get on the LCU's channel FIRST, and do not transmit until we are.
  bool onChannel = true;
  if (hopToSend) {
    onChannel = hopUntil(LCU_CHANNEL);
    if (!onChannel) {
      Serial.printf("[ESP-NOW] HOP REFUSED: asked for channel %u, radio stayed on %u\n",
                    (unsigned)LCU_CHANNEL, currentChannel());
      Serial.println("[ESP-NOW] this board cannot leave its AP's channel, so with the LCU");
      Serial.println("[ESP-NOW] fixed on channel 1 the AP has to move instead — put the");
      Serial.println("[ESP-NOW] board on a network that is on channel 1. See config.h.");
    }
  }

  // Retry inside the hop window.
  bool acked = false;
  for (int attempt = 1; onChannel && attempt <= ESPNOW_SEND_ATTEMPTS && !acked; attempt++) {
    if (hopToSend && currentChannel() != LCU_CHANNEL && !hopUntil(LCU_CHANNEL)) {
      Serial.println("[ESP-NOW] radio slipped back to the AP's channel mid-send");
      break;
    }

    sendResultPending = false;
    sendResultOk      = false;
    esp_err_t queued = esp_now_send(lcuMac, (uint8_t*)&cmd, sizeof(cmd));

    if (queued != ESP_OK) {
      Serial.printf("[ESP-NOW] send failed to queue (esp_err %d)\n", queued);
      break;
    }

    // Bounded wait so the frame and its ack complete before we leave the LCU's channel.
    unsigned long start = millis();
    while (!sendResultPending && millis() - start < ESPNOW_ACK_TIMEOUT_MS) {
      delay(1);
    }
    acked = sendResultPending && sendResultOk;

    if (!acked && attempt < ESPNOW_SEND_ATTEMPTS) {
      Serial.printf("[ESP-NOW] no ack on attempt %d/%d — retrying\n",
                    attempt, ESPNOW_SEND_ATTEMPTS);
    }
  }

  // Unconditional, including on every failure path: leaving the radio parked on the LCU's channel
  // would take the server WebSocket down with it.
  if (hopToSend) {
    if (hopMethod == 3) esp_wifi_set_promiscuous(false);
    uint8_t back = setRadioChannel(staChannel);
    if (back != staChannel) {
      Serial.printf("[ESP-NOW] WARNING: failed to return to channel %u (now %u)\n",
                    staChannel, back);
    }
  }

  return acked;
}

// ── Remember ────────────────────────────────────────────────────────────────
void espnowRememberAlert(const char* alertId, float targetReductionW,
                         int durationMinutes) {
  if (!alertId || !alertId[0]) return;

  // LOAD-BEARING, and more so than it looks.
  if (targetReductionW <= 0.0f || durationMinutes <= 0) {
    Serial.printf("[ESP-NOW] alert %s carries no setpoint — nothing to command\n",
                  alertId);
    return;
  }

  CachedThrottle* slot = findCached(alertId);
  if (!slot) {
    slot = &cache[cacheNext];
    cacheNext = (cacheNext + 1) % ESPNOW_THROTTLE_CACHE_SIZE;
    slot->dispatched = false;
  }

  strncpy(slot->alertId, alertId, sizeof(slot->alertId) - 1);
  slot->alertId[sizeof(slot->alertId) - 1] = '\0';
  slot->watts   = targetReductionW;
  slot->minutes = (uint16_t)durationMinutes;

  Serial.printf("[ESP-NOW] cached setpoint: %s -> %.0f W for %d min\n",
                slot->alertId, slot->watts, durationMinutes);
}

// ── Dispatch ────────────────────────────────────────────────────────────────
bool espnowDispatchAccepted(const char* alertId, const char* username) {
  if (!linkUp) {
    Serial.println("[ESP-NOW] link down — accept not commanded to the LCU");
    return false;
  }

  CachedThrottle* slot = findCached(alertId);
  if (!slot) {
    Serial.printf("[ESP-NOW] no cached setpoint for %s — nothing commanded\n",
                  alertId ? alertId : "(null)");
    return false;
  }

#if ESPNOW_ONE_COMMAND_PER_ALERT
  // One alert fans out to every phone, so several households can accept it — but there is a single
  // physical load downstream.
  if (slot->dispatched) {
    Serial.printf("[ESP-NOW] %s already commanded — %s's accept not re-sent\n",
                  slot->alertId, username && username[0] ? username : "a household");
    return false;
  }
#endif

  // A newer ask wins an in-flight event rather than being refused.
  if (eventActive && !eventExpired() && strcmp(eventAlertId, slot->alertId) != 0) {
    Serial.printf("[ESP-NOW] %s supersedes in-flight event %s (%lu ms remaining)\n",
                  slot->alertId, eventAlertId,
                  (unsigned long)(eventEndsAtMs - millis()));
  }

  float    runLevel   = wattsToRunLevelPercent(slot->watts);
  uint32_t durationMs = (uint32_t)slot->minutes * 60000UL;

  Serial.printf("[ESP-NOW] -> LCU  %s accepted by %s: run level %.1f%% "
                "(shed %.0f W of %.0f W) for %lu ms\n",
                slot->alertId, username && username[0] ? username : "(anonymous)",
                runLevel, slot->watts, (float)LCU_TOTAL_CAPACITY_W,
                (unsigned long)durationMs);

  if (!sendCommandToLcu(runLevel, durationMs)) {
    // Deliberately leaves `dispatched` clear.
    Serial.println("[ESP-NOW] LCU did NOT ack — not marked commanded, a later accept will retry");
    return false;
  }

  slot->dispatched = true;
  eventActive      = true;
  eventEndsAtMs    = millis() + durationMs;
  strncpy(eventAlertId, slot->alertId, sizeof(eventAlertId) - 1);
  eventAlertId[sizeof(eventAlertId) - 1] = '\0';

  Serial.println("[ESP-NOW] LCU acked the command frame");
  return true;
}

// ── Serial bring-up console ─────────────────────────────────────────────────
// Type `<watts>,<minutes>` at this board's serial monitor to fire one command at the LCU without
// involving the server, the dashboards or a household.
static void sweepForLcu() {
  Serial.println("[ESP-NOW] sweeping channels 1-13 for the LCU...");
  Serial.println("[ESP-NOW] probe = run level 100% for 1 ms (a no-op for the load)");

  PowerCommand probe;
  probe.powerPercent = 100.0f;
  probe.duration_ms  = 1;

  uint8_t found = 0;
  for (uint8_t ch = 1; ch <= 13; ch++) {
    uint8_t landed = setRadioChannel(ch);

    sendResultPending = false;
    sendResultOk      = false;
    esp_err_t queued = esp_now_send(lcuMac, (uint8_t*)&probe, sizeof(probe));

    bool acked = false;
    if (queued == ESP_OK) {
      unsigned long start = millis();
      while (!sendResultPending && millis() - start < ESPNOW_ACK_TIMEOUT_MS) delay(1);
      acked = sendResultPending && sendResultOk;
    }

    Serial.printf("  ch %2u -> radio on %2u : %s\n", ch, landed,
                  acked ? "ACK  <<< the LCU is here" : "no ack");
    if (acked && !found) found = ch;
  }

  setRadioChannel(staChannel);

  Serial.println();
  if (found) {
    Serial.printf("[ESP-NOW] LCU answered on channel %u. Set LCU_CHANNEL to %u in\n",
                  found, found);
    Serial.println("[ESP-NOW] config.h, rebuild, and the hop will target it correctly.");
  } else {
    Serial.println("[ESP-NOW] no channel answered.");
    Serial.println("[ESP-NOW] If the 'radio on' column never changed, this board cannot");
    Serial.println("[ESP-NOW] leave its AP's channel and the LCU must be moved to it.");
    Serial.println("[ESP-NOW] If it did change, check LCU_MAC in .env and that the LCU is on.");
  }
}

// Separates "wrong channel" from "wrong MAC", which a unicast no-ack cannot.
static void broadcastProbe() {
  Serial.println("[ESP-NOW] broadcasting a probe on the LCU's channel.");
  Serial.println("[ESP-NOW] WATCH THE LCU'S SERIAL MONITOR, not this one. A broadcast is");
  Serial.println("[ESP-NOW] never acked at the MAC layer, so this board cannot tell you");
  Serial.println("[ESP-NOW] whether it landed — the LCU printing NEW COMMAND RECEIVED is");
  Serial.println("[ESP-NOW] the only evidence, and it would mean the channel is fine and");
  Serial.println("[ESP-NOW] LCU_MAC in .env is the thing that is wrong.");

  if (hopToSend && !hopUntil(LCU_CHANNEL)) {
    Serial.println("[ESP-NOW] could not reach the LCU's channel — nothing sent");
    setRadioChannel(staChannel);
    return;
  }

  PowerCommand probe;
  probe.powerPercent = 100.0f;   // full power for 1 ms: the load's normal state
  probe.duration_ms  = 1;

  heardPending = false;

  for (int i = 0; i < 5; i++) {
    esp_now_send(bcastMac, (uint8_t*)&probe, sizeof(probe));
    delay(5);
  }

  // Stay put long enough for the LCU's own reply to come back.
  Serial.println("[ESP-NOW] listening 800 ms for a reply...");
  unsigned long until = millis() + 800;
  while (millis() < until && !heardPending) delay(5);

  if (hopToSend) setRadioChannel(staChannel);

  Serial.println("[ESP-NOW] 5 broadcast probes sent on channel " STRINGIFY(LCU_CHANNEL) ".");

  if (heardPending) {
    Serial.printf("[ESP-NOW] REPLY from %02X:%02X:%02X:%02X:%02X:%02X — that is the LCU's\n",
                  heardMac[0], heardMac[1], heardMac[2],
                  heardMac[3], heardMac[4], heardMac[5]);
    Serial.println("[ESP-NOW] real MAC. Put it in LCU_MAC in .env and re-flash this board.");
  } else {
    Serial.println("[ESP-NOW] no reply heard. That is NOT proof the probe missed: the LCU");
    Serial.println("[ESP-NOW] only answers the GATEWAY_MAC in .env, and if that is not this");
    Serial.println("[ESP-NOW] board's MAC (printed at boot) it stays silent.");
    Serial.println("[ESP-NOW] The LCU's serial monitor is the authority here.");
  }
}

static void handleTestLine(const char* line) {
  if (strcmp(line, "scan") == 0) {
    sweepForLcu();
    return;
  }

  if (strcmp(line, "bcast") == 0) {
    broadcastProbe();
    return;
  }

  const char* comma = strchr(line, ',');
  if (!comma) {
    Serial.println("[ESP-NOW] usage: <watts>,<minutes>   e.g.  1000,2");
    Serial.println("[ESP-NOW]        scan                 find which channel the LCU is on");
    Serial.println("[ESP-NOW]        bcast                probe by broadcast — is the MAC wrong?");
    return;
  }

  float watts   = atof(line);
  int   minutes = atoi(comma + 1);
  if (watts <= 0.0f || minutes <= 0) {
    Serial.println("[ESP-NOW] both values must be positive");
    return;
  }

  espnowRememberAlert(ESPNOW_TEST_ALERT_ID, watts, minutes);
  CachedThrottle* slot = findCached(ESPNOW_TEST_ALERT_ID);
  if (slot) slot->dispatched = false;   // so the console can be used repeatedly
  espnowDispatchAccepted(ESPNOW_TEST_ALERT_ID, "serial console");
}

static void serialConsole() {
  static char    line[40];
  static uint8_t len = 0;

  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      line[len] = '\0';
      if (len > 0) handleTestLine(line);
      len = 0;
      continue;
    }
    if (len < sizeof(line) - 1) line[len++] = c;
  }
}

// ── Drain ───────────────────────────────────────────────────────────────────
void espnowLoop() {
  serialConsole();

  // Anything heard from a MAC that is not the configured LCU.
  if (heardPending) {
    heardPending = false;
    Serial.printf("[ESP-NOW] heard %02X:%02X:%02X:%02X:%02X:%02X on channel %u: \"%s\"\n",
                  heardMac[0], heardMac[1], heardMac[2],
                  heardMac[3], heardMac[4], heardMac[5],
                  currentChannel(), (const char*)heardText);
    Serial.println("[ESP-NOW] ^ same channel confirmed. If that MAC is the LCU, put it in");
    Serial.println("[ESP-NOW]   LCU_MAC in .env — the configured one is wrong.");
  }

  // A status frame from the LCU, if one reaches us at all.
  if (statusPending) {
    statusPending = false;

    // The heartbeat arrives every 2 s forever.
    if (strcmp(statusText, "LCU-ALIVE") == 0) {
      if (!lcuSeen) {
        lcuSeen = true;
        Serial.printf("[ESP-NOW] LCU is alive on channel %u\n", currentChannel());
      }
      lcuLastSeenMs = millis();
      return;
    }

    Serial.printf("[ESP-NOW] <- LCU status: %s\n", statusText);

    if (strcmp(statusText, "DONE") == 0 && eventActive) {
      Serial.printf("[ESP-NOW] event %s reported complete by the LCU\n", eventAlertId);
      eventActive = false;
    }
  }

  // Three missed beats.
  if (lcuSeen && millis() - lcuLastSeenMs > 6000) {
    lcuSeen = false;
    Serial.println("[ESP-NOW] LCU went quiet — no heartbeat for 6 s");
  }

  if (eventExpired()) {
    eventActive = false;
    Serial.printf("[ESP-NOW] event %s window elapsed — LCU idle\n", eventAlertId);
  }
}
