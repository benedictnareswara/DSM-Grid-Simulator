// ============================================================
// LCU — ESP-NOW POWER CONTROLLER
// ============================================================
//
// Receives a PowerCommand from the gateway over ESP-NOW when a
// household accepts an alert, and drives a TRIAC dimmer to run
// the load at the commanded level for the commanded window.
//
// WHY IT JOINS WI-FI
//
// ESP-NOW only works when both radios are on the same channel.
// The gateway is associated to your Wi-Fi, and an associated
// ESP32 can't leave its AP's channel. So this board joins the
// same Wi-Fi: it is then on the AP's channel by definition, and
// the two follow each other through any channel change.
//
// Settings (WIFI_SSID, WIFI_PASSWORD, GATEWAY_MAC, LCU_CAPACITY_W)
// come from the repo-root .env at build time. See
// scripts/load_env.py.
// ------------------------------------------------------------

#include <Arduino.h>
#include <dimmable_light.h>

// WIFI_SSID, WIFI_PASSWORD, GATEWAY_MAC_BYTES, GATEWAY_MAC_SET and
// RATED_POWER_W, generated from .env at build time.
#include "dsm_settings.h"
#include <math.h>

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>

// ============================================================
// HARDWARE SETTINGS
// ============================================================

constexpr int SYNC_PIN = 34;
constexpr int THYRISTOR_PIN = 14;

DimmableLight light(THYRISTOR_PIN);

// ============================================================
// POWER / SYSTEM SETTINGS
// ============================================================

// Nameplate rating: RATED_POWER_W, from LCU_CAPACITY_W in .env
// (default 3000). The gateway converts watts to a percentage of
// this same figure.
// What the load actually draws at full conduction. The phase-angle
// curve is calibrated against this, not the nameplate. Re-measure
// it for your load.
constexpr float MEASURED_FULL_POWER_W = 2810.0f;
constexpr float AC_FREQUENCY_HZ = 50.0f;

constexpr float HALF_CYCLE_US =
    1000000.0f /
    (2.0f * AC_FREQUENCY_HZ);
constexpr float HARDWARE_DELAY_OFFSET_US = 1140.0f;

// ============================================================
// ESP-NOW MESSAGE CONTRACT
// ============================================================
//
// PowerCommand / StatusMessage, shared with the gateway.

#include "dsm_protocol.h"

static const uint8_t BCAST_MAC[6] =
    {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

// ============================================================
// WHO MAY COMMAND THIS BOARD
// ============================================================
//
// This board switches a multi-kilowatt load, so it only obeys
// the gateway named by GATEWAY_MAC in .env. A command from any
// other ESP32 in range is logged, with its MAC, and ignored.
// If GATEWAY_MAC isn't set yet, any sender is accepted, and the
// boot log says so.

static const uint8_t ALLOWED_GATEWAY[6] = {GATEWAY_MAC_BYTES};

volatile bool   rejectedPending = false;
volatile uint8_t rejectedMac[6] = {0};

// ============================================================
// STATE
// ============================================================

PowerCommand receivedCommand;
bool commandActive = false;
unsigned long commandStartTime = 0;

// Work handed from the receive callback to loop(). The callback
// runs on the Wi-Fi task: driving the TRIAC and calling
// esp_now_send() from inside it means reentering the driver that
// is calling you. Costs up to one loop pass (~10 ms).
volatile bool commandPending = false;

// Whoever actually sent the last command. Replying to the sender
// instead of a MAC hardcoded here means the gateway's MAC never
// has to be configured on this board, and cannot go stale.
uint8_t lastSender[6] = {0};
bool    senderKnown   = false;

unsigned long lastBeaconMs = 0;

// ============================================================
// PHASE CONTROL EQUATION
// ============================================================

float powerFractionFromAlpha(float alpha)
{
  return
      1.0f - alpha / PI + sinf(2.0f * alpha) / (2.0f * PI);
}

// ============================================================
// FIND FIRING ANGLE
// ============================================================

float findFiringAngle(float powerFraction)
{
  if(powerFraction >= 1.0f)
    return 0.0f;
  if(powerFraction <= 0.0f)
    return PI;

  float low = 0.0f;
  float high = PI;

  for(int i=0;i<40;i++)
  {
    float alpha =
        0.5f*(low+high);
    float calculatedPower =
        powerFractionFromAlpha(alpha);

    if(calculatedPower > powerFraction)
    {
      low = alpha;
    }
    else
    {
      high = alpha;
    }
  }

  return
      0.5f*(low+high);
}

// ============================================================
// SET POWER PERCENTAGE
// ============================================================

void setPowerPercent(float percent)
{
  if(percent <= 0.0f)
  {
    light.setBrightness(0);
    Serial.println("LOAD OFF");
    return;
  }

  if(percent > 100.0f)
      percent = 100.0f;

  float targetPowerW =
      RATED_POWER_W * percent / 100.0f;

  if(targetPowerW >= MEASURED_FULL_POWER_W)
  {
    light.setBrightness(255);
    Serial.println(
        "FULL POWER"
    );
    return;
  }

  float powerFraction =
      targetPowerW / MEASURED_FULL_POWER_W;

  float alphaRad =
      findFiringAngle(powerFraction);

  float alphaDeg =
      alphaRad * 180.0f / PI;

  float requiredActualDelayUs =
      alphaRad / PI * HALF_CYCLE_US;

  float libraryDelayUs =
      requiredActualDelayUs - HARDWARE_DELAY_OFFSET_US;

  if (libraryDelayUs < 0.0f)
    libraryDelayUs = 0.0f;

  if (libraryDelayUs > HALF_CYCLE_US)
    libraryDelayUs = HALF_CYCLE_US;

  float brightnessFloat =
      255.0f * (1.0f - libraryDelayUs / HALF_CYCLE_US);

  int brightness =
      (int)roundf(brightnessFloat);

  brightness =
      constrain(brightness, 0, 255);

  light.setBrightness(brightness);

  Serial.println();
  Serial.println("============================");

  Serial.printf(
      "Power request : %.1f %%\n",
      percent
  );

  Serial.printf(
      "Target power  : %.0f W\n",
      targetPowerW
  );

  Serial.printf(
      "Alpha         : %.2f deg\n",
      alphaDeg
  );

  Serial.printf(
      "Brightness    : %d /255\n",
      brightness
  );

  Serial.println("============================");
}

// ============================================================
// ESP-NOW RECEIVE CALLBACK
// ============================================================
//
// Length-checked, unlike before. A frame of the wrong size used
// to be memcpy'd into the struct anyway, so a stray packet could
// drive the load to an arbitrary power for an arbitrary time.

#if ESP_IDF_VERSION_MAJOR >= 5
void OnDataRecv(const esp_now_recv_info_t *info,
                const uint8_t *incomingData, int len)
{
  const uint8_t *mac = info->src_addr;
#else
void OnDataRecv(const uint8_t *mac,
                const uint8_t *incomingData, int len)
{
#endif
  if (len != sizeof(PowerCommand))
  {
    // Another LCU's heartbeat, or noise. Not worth a line: this
    // callback runs on the Wi-Fi task and must stay quick.
    return;
  }

  if (GATEWAY_MAC_SET && memcmp(mac, ALLOWED_GATEWAY, 6) != 0)
  {
    // Not our gateway. Reported from loop(), never acted on.
    if (!rejectedPending)
    {
      memcpy((void *)rejectedMac, mac, 6);
      rejectedPending = true;
    }
    return;
  }

  memcpy(&receivedCommand, incomingData, sizeof(receivedCommand));
  memcpy(lastSender, mac, 6);
  senderKnown = true;
  commandPending = true;
}

// ============================================================
// FEEDBACK
// ============================================================

void sendStatus(const char *text)
{
  StatusMessage status;
  memset(&status, 0, sizeof(status));
  strncpy(status.message, text, sizeof(status.message) - 1);

  if (!senderKnown)
  {
    Serial.println("no sender known yet — status not sent");
    return;
  }

  // Peers are add-if-absent; re-adding an existing one is a
  // harmless error we ignore.
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, lastSender, 6);
  peer.channel = 0;
  peer.encrypt = false;
  peer.ifidx   = WIFI_IF_STA;
  esp_now_add_peer(&peer);

  esp_now_send(lastSender, (uint8_t *)&status, sizeof(status));
  Serial.printf("-> sent \"%s\"\n", text);
}

// ============================================================
// HEARTBEAT
// ============================================================
//
// A broadcast every 2 s, carrying nothing but "I am here". The
// gateway hears it only if the two radios are on the same
// channel, which turns the hardest question on this link into a
// line that either appears or does not — and it hands the
// gateway this board's real MAC, so LCU_PEER_MAC stops being a
// number copied from an old sketch and never verified.

void beacon()
{
  if (millis() - lastBeaconMs < 2000)
    return;
  lastBeaconMs = millis();

  StatusMessage hb;
  memset(&hb, 0, sizeof(hb));
  strcpy(hb.message, "LCU-ALIVE");

  esp_now_send(BCAST_MAC, (uint8_t *)&hb, sizeof(hb));
}

// ============================================================
// SETUP
// ============================================================

void setup()
{
  Serial.begin(115200);
  delay(1000);

  // The first thing printed, because it's what you need to fill in .env.
  WiFi.mode(WIFI_STA);
  Serial.println();
  Serial.println("================================");
  Serial.println("  DSM LCU (load control unit)");
  Serial.printf("  MAC: %s\n", WiFi.macAddress().c_str());
  Serial.println("  ^ put this in .env as LCU_MAC");
  Serial.println("================================");

  if (GATEWAY_MAC_SET)
    Serial.printf("Only obeying gateway %02X:%02X:%02X:%02X:%02X:%02X\n",
                  ALLOWED_GATEWAY[0], ALLOWED_GATEWAY[1], ALLOWED_GATEWAY[2],
                  ALLOWED_GATEWAY[3], ALLOWED_GATEWAY[4], ALLOWED_GATEWAY[5]);
  else
    Serial.println("GATEWAY_MAC not set in .env: accepting commands from ANY ESP32.");

  // TRIAC initialization

  DimmableLight::setSyncPin(SYNC_PIN);
  DimmableLight::begin();

  light.setBrightness(0);

  // ---- Wi-Fi: join the AP so we sit on its channel ----------

  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("joining " WIFI_SSID);

  unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 20000)
  {
    delay(300);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() != WL_CONNECTED)
  {
    // Not fatal: unassociated we fall back to channel 1, which is
    // where this board always used to be. Say so loudly rather
    // than carrying on looking healthy — a silent fallback here
    // is exactly the failure that cost us a week.
    Serial.println("!! COULD NOT JOIN — falling back to channel 1.");
    Serial.println("!! The gateway will not be able to reach this board.");
    Serial.println("!! Check WIFI_SSID / WIFI_PASSWORD in .env (2.4 GHz only),");
    Serial.println("!! then re-flash: npm run flash:lcu");
  }
  else
  {
    // An associated STA modem-sleeps between beacons and drops
    // ESP-NOW frames that arrive while it is asleep. Unassociated
    // it listened continuously, which is why this was never
    // needed before. Intermittent loss without it.
    WiFi.setSleep(false);
    Serial.printf("joined, IP %s\n", WiFi.localIP().toString().c_str());
  }

  uint8_t ch;
  wifi_second_chan_t sec;
  esp_wifi_get_channel(&ch, &sec);
  Serial.printf("LCU listening on channel %u\n", ch);

  // ---- ESP-NOW ----------------------------------------------

  if (esp_now_init() != ESP_OK)
  {
    Serial.println("ESP-NOW INIT FAILED");
    return;
  }

  esp_now_register_recv_cb(OnDataRecv);

  esp_now_peer_info_t bpeer = {};
  memcpy(bpeer.peer_addr, BCAST_MAC, 6);
  bpeer.channel = 0;
  bpeer.encrypt = false;
  bpeer.ifidx   = WIFI_IF_STA;
  if (esp_now_add_peer(&bpeer) != ESP_OK)
    Serial.println("Failed adding broadcast peer");

  Serial.println("LCU READY");
}

// ============================================================
// LOOP
// ============================================================

void loop()
{
  if (rejectedPending)
  {
    rejectedPending = false;
    Serial.printf(
        "REJECTED command from %02X:%02X:%02X:%02X:%02X:%02X (not GATEWAY_MAC in .env)\n",
        rejectedMac[0], rejectedMac[1], rejectedMac[2],
        rejectedMac[3], rejectedMac[4], rejectedMac[5]);
  }

  if (commandPending)
  {
    commandPending = false;

    Serial.println();
    Serial.println("NEW COMMAND RECEIVED");
    Serial.printf("from %02X:%02X:%02X:%02X:%02X:%02X\n",
                  lastSender[0], lastSender[1], lastSender[2],
                  lastSender[3], lastSender[4], lastSender[5]);
    Serial.printf("Power = %.1f %%\n", receivedCommand.powerPercent);
    Serial.printf("Duration = %lu ms\n", receivedCommand.duration_ms);

    setPowerPercent(receivedCommand.powerPercent);

    commandStartTime = millis();
    commandActive = true;

    // Acknowledge receipt NOW, not when the event ends. "DONE"
    // can be 90 minutes away; the gateway needs to know the
    // command landed while it still means something.
    sendStatus("GOT");
  }

  if (commandActive)
  {
    unsigned long elapsed = millis() - commandStartTime;

    if (elapsed >= receivedCommand.duration_ms)
    {
      setPowerPercent(0);
      commandActive = false;
      Serial.println("COMMAND FINISHED");
      sendStatus("DONE");
    }
  }

  beacon();

  delay(10);
}
