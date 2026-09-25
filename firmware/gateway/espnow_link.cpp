// ============================================================================
// DSM gateway — ESP-NOW downlink to the Load Control Unit
// See espnow_link.h for why this is a cache, and why the channel is the hard
// part of doing this on a board that also holds a Wi-Fi connection.
// ============================================================================

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

// Where the STA is parked, recorded at begin(). Hopping has to come back to
// exactly this or the WebSocket dies.
static uint8_t staChannel = 0;

// True when the LCU is not on our channel and every command needs a brief
// excursion. Decided at begin() by comparison, never configured — fix the AP or
// the LCU and this turns itself off.
static bool hopToSend = false;

// ── The alert_id → setpoint cache ───────────────────────────────────────────
//
// A ring, not a map: it only has to survive the gap between an alert being
// pushed and a household answering it. Overwriting the oldest entry is the
// correct failure mode — an accept for an alert that has scrolled out dispatches
// nothing, the same outcome as an accept for one this board never saw.
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
//
// The CC tracked this as `waitingForFinish`, set on send and cleared *only* when
// the LCU replied "DONE". That is not ported, deliberately: it wedges the board
// permanently if the reply never comes, and under hop-to-send it never can —
// "DONE" arrives minutes later, with the radio long since back on the STA's
// channel.
//
// This board computed the window, so it does not need to be told. A reply is
// still honoured if one turns up; it is simply never required.
static bool          eventActive    = false;
static unsigned long eventEndsAtMs  = 0;
static char          eventAlertId[24] = {0};

// Overflow-safe: millis() wraps at ~49 days and a plain `>=` compares wrong
// across the wrap.
static bool eventExpired() {
  return eventActive && (long)(millis() - eventEndsAtMs) >= 0;
}

// ── Callback state ──────────────────────────────────────────────────────────
//
// Both ESP-NOW callbacks run on the Wi-Fi task. They set flags and copy bytes;
// nothing here does I/O. Serial from a radio callback is how you get a watchdog
// reset that looks like a network fault.
static volatile bool sendResultPending = false;
static volatile bool sendResultOk      = false;
static volatile bool statusPending     = false;
static char          statusText[sizeof(StatusMessage) + 1];

// Set only while the `bcast` probe is listening, so an unexpected sender's MAC
// is captured instead of dropped. Off at all other times: the alert path must
// not act on a frame from an unknown radio.
// Liveness from the LCU's 2 s heartbeat. Edge-reported, not streamed.
static bool          lcuSeen       = false;
static unsigned long lcuLastSeenMs = 0;

static volatile bool    heardPending = false;
static volatile uint8_t heardMac[6]  = {0};
static volatile char    heardText[sizeof(StatusMessage) + 1] = {0};

static void onEspNowSent(const uint8_t* mac, esp_now_send_status_t status) {
  sendResultOk      = (status == ESP_NOW_SEND_SUCCESS);
  sendResultPending = true;
}

// Arduino-ESP32 3.x changed this signature; keep both so a core bump does not
// silently stop compiling the callback in.
#if ESP_ARDUINO_VERSION_MAJOR >= 3
static void onEspNowRecv(const esp_now_recv_info_t* info, const uint8_t* data, int len) {
  const uint8_t* mac = info->src_addr;
#else
static void onEspNowRecv(const uint8_t* mac, const uint8_t* data, int len) {
#endif
  // Length-checked, unlike the CC sketch's callback. A frame shorter than the
  // struct would otherwise have us memcpy past the driver's buffer, and a
  // message[] with no NUL runs Serial.print off the end of RAM.
  if (len <= 0 || (size_t)len > sizeof(StatusMessage)) return;

  if (memcmp(mac, lcuMac, 6) != 0) {
    // Not the MAC we are configured for. Recorded and reported, never acted on:
    // the alert path must not be steerable by an unknown radio. Reporting it is
    // the point — a frame arriving from an unexpected MAC is the single most
    // useful thing this link can tell us, and it used to be dropped in silence.
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
//
// The promiscuous toggle is what makes set_channel take on an associated STA;
// it is the same dance the CC-side sketches use.
// Returns the channel the radio is ACTUALLY on afterwards, which is not always
// the one asked for. An associated STA is owned by the Wi-Fi driver: it keeps
// the radio on the AP's channel, and depending on the IDF build it either
// refuses this outright or snaps back. esp_wifi_set_channel() still returns
// ESP_OK in that case, so the return value proves nothing and the read-back is
// the only honest report.
static uint8_t currentChannel() {
  uint8_t ch; wifi_second_chan_t second;
  esp_wifi_get_channel(&ch, &second);
  return ch;
}

// There is more than one incantation for this and which one works depends on the
// IDF build, so try them rather than picking one and hoping. Method 3 leaves the
// radio in promiscuous mode, which is why the restore path has to clear it.
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

// Which method last moved the radio: -1 unknown, 0 none of them work here,
// 1..3 that one. Remembered so a working hop costs one call, and re-probed the
// moment it stops working rather than being trusted forever.
static int hopMethod = -1;

// Move the radio, by whatever means actually works. Returns where it landed,
// which is the only honest report: esp_wifi_set_channel() returns ESP_OK even
// when an associated STA's driver ignores it and keeps the AP's channel.
static uint8_t setRadioChannel(uint8_t channel) {
  // Already there: do nothing and announce nothing. Without this the restore
  // call at the end of every send asks to go back to the AP's channel the radio
  // never left, method 1 "succeeds" trivially, and the board cheerfully reports
  // a working channel hop — which is what it did, right after refusing 25 times.
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

// The refusal is usually transient, not permanent: the driver declines while it
// is busy servicing the association and allows it a moment later. So ask
// repeatedly, yielding between tries, and only give up after ESPNOW_HOP_TRIES.
// delay() is what hands the CPU to the Wi-Fi task, so it is doing work here.
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

// Broadcast reaches any ESP-NOW receiver on the channel regardless of its MAC,
// because an unencrypted receiver's callback does not consult its peer list.
// That makes it the one way to separate "wrong channel" from "wrong MAC"
// without touching the LCU.
static const uint8_t bcastMac[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

#define STRINGIFY_(x) #x
#define STRINGIFY(x)  STRINGIFY_(x)

// ── Setup ───────────────────────────────────────────────────────────────────
void espnowBegin() {
  linkUp    = false;
  hopToSend = false;

  // All zeros means LCU_MAC isn't in .env yet. esp_now_add_peer() would accept
  // it and every frame would go unacked, which looks exactly like an LCU that is
  // powered off. Say so instead.
  bool macSet = false;
  for (uint8_t i = 0; i < 6; i++) if (lcuMac[i]) macSet = true;
  if (!macSet) {
    Serial.println("[ESP-NOW] LCU_MAC is not set in .env, so the LCU downlink is off.");
    Serial.println("[ESP-NOW] Flash the LCU, copy the MAC it prints into .env, then");
    Serial.println("[ESP-NOW] re-flash this board (npm run flash:gateway).");
    return;
  }

  // Idempotent: connectWiFi() calls WiFi.disconnect(true), which takes the stack
  // (and every registered peer) down. Deinit first so a rebuild after a
  // reconnect does not fail on ESP_ERR_ESPNOW_EXIST.
  esp_now_deinit();

  // ESP-NOW receives are dropped while the STA is in modem sleep. The board is
  // mains-powered and is the thing the whole alert path waits on, so the trade
  // is not close.
  WiFi.setSleep(false);

  if (esp_now_init() != ESP_OK) {
    Serial.println("[ESP-NOW] init FAILED — LCU downlink is dark");
    return;
  }

  esp_now_register_send_cb(onEspNowSent);
  esp_now_register_recv_cb(onEspNowRecv);

  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, lcuMac, 6);
  // 0 = "use whatever channel the radio is on at transmit time", which is what
  // makes hop-to-send work without re-registering the peer.
  peer.channel = 0;
  peer.encrypt = false;
  peer.ifidx   = WIFI_IF_STA;

  if (esp_now_add_peer(&peer) != ESP_OK) {
    Serial.println("[ESP-NOW] add_peer FAILED — check LCU_MAC in .env");
    return;
  }

  // Broadcast needs its own peer entry. Used only by the `bcast` console
  // command — the alert path always unicasts, so a missing ack stays meaningful.
  esp_now_peer_info_t bpeer = {};
  memcpy(bpeer.peer_addr, bcastMac, 6);
  bpeer.channel = 0;
  bpeer.encrypt = false;
  bpeer.ifidx   = WIFI_IF_STA;
  esp_now_add_peer(&bpeer);

  linkUp = true;

  wifi_second_chan_t second;
  esp_wifi_get_channel(&staChannel, &second);
  // LCU_CHANNEL 0 means the LCU rides the same AP we do, so it is on our
  // channel by definition and there is nothing to hop to.
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
//
// The server speaks absolute watts to shed; the LCU reads `powerPercent` as the
// level to RUN AT, as a percentage of its total capacity. So this returns the
// complement — a 1000 W ask against a 2200 W load is 54.5, not 45.5.
//
// The two readings are exact complements, which is what makes a swap here so
// unpleasant: it is nearly invisible on small asks and catastrophic on large
// ones. Sending the shed figure for a 2000 W emergency ask would put 90.9 on the
// wire, the LCU would run at 90.9% = 2000 W, and it would shed 200 W — the load
// staying essentially flat out in exactly the condition the alert exists for.
//
// This is a unit conversion against a device rating, not a second model of the
// ask. The server's incentive model remains the only authority for how much an alert is worth
// asking for; this function cannot change that number, only express it.
static float wattsToRunLevelPercent(float wattsToShed) {
  float shedPct = (wattsToShed / LCU_TOTAL_CAPACITY_W) * 100.0f;
  if (shedPct < 0.0f)   shedPct = 0.0f;
  if (shedPct > 100.0f) shedPct = 100.0f;   // asking for more than the load has
  return 100.0f - shedPct;                  // ...clamps to 0% = fully off
}

// ── Send ────────────────────────────────────────────────────────────────────
//
// Returns true only when the LCU's radio acked the frame. ESP_OK from
// esp_now_send() means "queued", not "delivered", so the ack is what the caller
// must key off — see the note in espnowDispatchAccepted().
static bool sendCommandToLcu(float runLevelPercent, uint32_t durationMs) {
  PowerCommand cmd;
  cmd.powerPercent = runLevelPercent;
  cmd.duration_ms  = durationMs;

  // Get on the LCU's channel FIRST, and do not transmit until we are. Sending
  // while still on the AP's channel burns a retry on a frame nobody can hear
  // and, worse, makes the resulting "no ack" look like an LCU fault.
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

  // Retry inside the hop window. One frame can be lost to interference alone,
  // and re-hopping per attempt would cost another excursion; the radio is
  // already parked where it needs to be. Re-check the channel each time —
  // the driver can snap an associated STA back between attempts.
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

    // Bounded wait so the frame and its ack complete before we leave the LCU's
    // channel. delay(1) yields to the Wi-Fi task, which is what sets the flag.
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

  // Unconditional, including on every failure path: leaving the radio parked on
  // the LCU's channel would take the server WebSocket down with it.
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

  // LOAD-BEARING, and more so than it looks. Both fields are nullable — alerts
  // written before the throttle model carry neither. Under the run-level
  // reading, zero watts converts to 100%, which is *full power*: the fail-safe
  // direction inverted when the percentage did. This guard is the only thing
  // between a missing field and the load being commanded flat out, so it must
  // refuse rather than default.
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
    // Not an error: an alert older than the ring, or one pushed before this
    // board booted. Logged because a silent nothing here looks exactly like a
    // dead radio.
    Serial.printf("[ESP-NOW] no cached setpoint for %s — nothing commanded\n",
                  alertId ? alertId : "(null)");
    return false;
  }

#if ESPNOW_ONE_COMMAND_PER_ALERT
  // One alert fans out to every phone, so several households can accept it — but
  // there is a single physical load downstream. The first yes arms it; the rest
  // are tallied by the server and dropped here.
  if (slot->dispatched) {
    Serial.printf("[ESP-NOW] %s already commanded — %s's accept not re-sent\n",
                  slot->alertId, username && username[0] ? username : "a household");
    return false;
  }
#endif

  // A newer ask wins an in-flight event rather than being refused. Refusing
  // would mean an emergency alert loses to a warning that merely got there
  // first. Never silent, though: an override the operator cannot see is how the
  // board and the dashboard end up disagreeing about what the load is doing.
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
    // Deliberately leaves `dispatched` clear. ESP_OK only means the frame was
    // queued; marking the alert commanded on that would block every retry for an
    // ask the LCU never received.
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
//
// Type `<watts>,<minutes>` at this board's serial monitor to fire one command at
// the LCU without involving the server, the dashboards or a household. It is
// also what the retired CC's console was for, and it goes through exactly the
// same conversion and send as a real accept — it just supplies the setpoint by
// hand instead of from an alert.
//
// This exists because the ordinary path only transmits on a real accept, so the
// first test of a new LCU otherwise conflates the radio, the channel, the MAC,
// the WebSocket, the gateway token and the login into a single "nothing
// happened".
// Sweep every 2.4 GHz channel looking for the LCU. The only way to find a
// receiver whose channel you do not know — and, just as usefully, it proves
// whether this board can change channel at all: if the radio refuses to leave
// the AP's channel, every row reports the same channel and none ack.
//
// The probe is a well-formed PowerCommand of {100%, 1 ms} — "run at full power
// for one millisecond", i.e. the LCU's normal state, held for no time. It has to
// be well-formed because a short frame would be memcpy'd as garbage by a
// receiver that does not length-check, and commanding the load with garbage to
// find it would be a poor trade.
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

  // Stay put long enough for the LCU's own reply to come back. A 1 ms command
  // finishes on its next loop() pass (~10 ms) and sendStatus() fires there, so
  // hopping away immediately would guarantee we miss it.
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

  // Anything heard from a MAC that is not the configured LCU. Hearing ANY frame
  // at all proves the two radios are on the same channel, which is the question
  // this link keeps failing to answer, so this line is worth more than the ack.
  // If the MAC differs, it also hands over the right value for LCU_MAC.
  if (heardPending) {
    heardPending = false;
    Serial.printf("[ESP-NOW] heard %02X:%02X:%02X:%02X:%02X:%02X on channel %u: \"%s\"\n",
                  heardMac[0], heardMac[1], heardMac[2],
                  heardMac[3], heardMac[4], heardMac[5],
                  currentChannel(), (const char*)heardText);
    Serial.println("[ESP-NOW] ^ same channel confirmed. If that MAC is the LCU, put it in");
    Serial.println("[ESP-NOW]   LCU_MAC in .env — the configured one is wrong.");
  }

  // A status frame from the LCU, if one reaches us at all. Under hop-to-send it
  // never will — the radio is back on the STA's channel long before the event
  // ends — which is exactly why nothing above waits for it.
  if (statusPending) {
    statusPending = false;

    // The heartbeat arrives every 2 s forever. Printing each one would bury
    // every other line on this monitor, so only the edges are reported: the
    // LCU appearing, and the LCU going quiet. Those are the events; the stream
    // in between is just the absence of news.
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

  // Three missed beats. Reported once, so an LCU that powers off or wanders to
  // another channel says so instead of simply never acking again.
  if (lcuSeen && millis() - lcuLastSeenMs > 6000) {
    lcuSeen = false;
    Serial.println("[ESP-NOW] LCU went quiet — no heartbeat for 6 s");
  }

  if (eventExpired()) {
    eventActive = false;
    Serial.printf("[ESP-NOW] event %s window elapsed — LCU idle\n", eventAlertId);
  }
}
