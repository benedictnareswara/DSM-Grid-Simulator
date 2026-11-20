// ============================================================================ DSM gateway firmware

#include <Arduino.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

#include "config.h"
#include "espnow_link.h"

// ── Globals ──
WebSocketsClient webSocket;
bool wsConnected = false;

// Where the server is, and how we found out.
IPAddress serverIp;
uint16_t  serverPort          = SERVER_PORT;
bool      resolvedViaMdns     = false;
bool      mdnsStarted         = false;
uint8_t   consecutiveFailures = 0;

// The token rides as a query parameter.
static const String wsPath = String(WS_PATH_BASE) + "?token=" + GATEWAY_TOKEN;
static const char* SAFE_WS_PATH = WS_PATH_BASE "?token=<redacted>";

void webSocketEvent(WStype_t type, uint8_t* payload, size_t length);

// ── Wi-Fi ──
void connectWiFi() {
  Serial.println();
  Serial.print("[WiFi] SSID: \"");
  Serial.print(WIFI_SSID);
  Serial.println("\"");
  WiFi.disconnect(true);  // Clear any previous connection state
  delay(100);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);

  // Pass credentials as const char* — spaces are fine in string literals
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("[WiFi] Connecting");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - start > WIFI_CONNECT_TIMEOUT_MS) {
      Serial.println();
      Serial.printf("[WiFi] FAILED — status %d after %lu ms\n",
                    WiFi.status(), (unsigned long)WIFI_CONNECT_TIMEOUT_MS);

      // The status code narrows this down a long way, and the raw WiFiGeneric reason spam above
      // does not.
      switch (WiFi.status()) {
        case WL_NO_SSID_AVAIL:
          Serial.println("[WiFi]   No AP with that SSID is on the air.");
          Serial.println("[WiFi]   WIFI_SSID is wrong, the AP is off, or it is 5 GHz only");
          Serial.println("[WiFi]   (this board is 2.4 GHz only — on an iPhone hotspot,");
          Serial.println("[WiFi]   turn on 'Maximize Compatibility').");
          break;
        case WL_CONNECT_FAILED:
          Serial.println("[WiFi]   The AP answered and refused us. WIFI_PASSWORD is");
          Serial.println("[WiFi]   almost certainly wrong. A repeating AUTH_LEAVE above");
          Serial.println("[WiFi]   means the same thing: the AP exists, the key does not");
          Serial.println("[WiFi]   match. WPA3-only APs and full hotspots also land here.");
          break;
        default:
          Serial.println("[WiFi]   Associated then dropped, or still negotiating.");
          Serial.println("[WiFi]   Check signal, and that the AP is not at its device limit.");
      }
      Serial.println("[WiFi] Reminder: this board, the LCU and the computer running the");
      Serial.println("[WiFi] server must all be on the SAME 2.4 GHz network (WIFI_SSID in .env).");
      Serial.println("[WiFi] Restarting in 5 seconds...");
      delay(5000);
      ESP.restart();
    }
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.print("[WiFi] Connected — IP: ");
  Serial.println(WiFi.localIP());
  Serial.print("[WiFi] Gateway: ");
  Serial.println(WiFi.gatewayIP());
  Serial.print("[WiFi] Signal: ");
  Serial.print(WiFi.RSSI());
  Serial.println(" dBm");
}

// ── Finding the server ── The server advertises `_dsm._tcp` over mDNS with its port, so this board
// needs no IP address at all, and a DHCP change on the laptop costs nothing.
bool resolveServer() {
  if (!mdnsStarted) {
    // The responder has to be running before we can query, even though we only use it to look the
    // server up.
    mdnsStarted = MDNS.begin(MDNS_DEVICE_NAME);
    if (!mdnsStarted) Serial.println("[mDNS] responder failed to start");
  }

  if (mdnsStarted) {
    int n = MDNS.queryService(MDNS_SERVICE, MDNS_PROTO);
    if (n > 0) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
      serverIp = MDNS.address(0);
#else
      serverIp = MDNS.IP(0);
#endif
      serverPort = MDNS.port(0);
      resolvedViaMdns = true;
      Serial.printf("[WS] Server found via mDNS (_%s._%s) -> %s:%u\n", MDNS_SERVICE, MDNS_PROTO,
                    serverIp.toString().c_str(), serverPort);
      return true;
    }
  }

  resolvedViaMdns = false;
  serverPort = SERVER_PORT;
  if (strlen(SERVER_HOST) > 0 && serverIp.fromString(SERVER_HOST)) {
    Serial.printf("[WS] mDNS found nothing; using SERVER_HOST fallback -> %s:%u\n",
                  serverIp.toString().c_str(), serverPort);
    return true;
  }

  Serial.println("[WS] Could not find the server. Check that `npm run dev` is running on a");
  Serial.println("[WS] computer on the same Wi-Fi. If your network blocks mDNS, set");
  Serial.println("[WS] SERVER_HOST in .env to that computer's IP and re-flash.");
  return false;
}

// ── WebSocket (re)start ── Every path that brings the socket up goes through here, so the
// heartbeat cannot be configured on one and forgotten on another.
void startWebSocket() {
  // No-op if it was never up.
  webSocket.disconnect();

  webSocket.begin(serverIp, serverPort, wsPath.c_str());
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(WS_RECONNECT_INTERVAL_MS);

  // The heartbeat is what makes a dead link *observable*.
  webSocket.enableHeartbeat(WS_PING_INTERVAL_MS, WS_PONG_TIMEOUT_MS,
                            WS_MISSED_PONG_LIMIT);

  Serial.printf("[WS] Connecting to ws://%s:%u%s ...\n",
                serverIp.toString().c_str(), serverPort, SAFE_WS_PATH);
}

// ── Relay: Admin -> ESP32 -> Consumer ── Logs the admin-approved alert, then immediately forwards
// it back to the server so it can be fanned out to household phones.
void relayAlert(JsonObject alert) {
  const char* severity  = alert["severity"]  | "unknown";
  const char* title     = alert["title"]     | "(no title)";
  const char* message   = alert["message"]   | "(no message)";
  const char* parameter = alert["parameter"] | "(none)";
  int tick              = alert["tick"]       | -1;

  Serial.println("┌─────────────────────────────────────");
  Serial.printf( "│ ALERT [%s] tick=%d\n", severity, tick);
  Serial.printf( "│ %s\n", title);
  Serial.printf( "│ %s\n", message);
  Serial.printf( "│ param: %s\n", parameter);
  Serial.println("└─────────────────────────────────────");

  // Remember what this alert asks the load for.
  espnowRememberAlert(alert["id"] | "",
                      alert["target_reduction_w"] | 0.0f,
                      alert["duration_minutes"] | 0);

  JsonDocument out;
  out["type"] = "forward_alert";
  out["alert"] = alert;
  String payload;
  serializeJson(out, payload);
  webSocket.sendTXT(payload);
  Serial.println("[Relay] forward_alert -> server (for households)");
}

// ── Relay: Consumer -> ESP32 -> Admin ── Logs the household's accept/decline, then forwards it
// back to the server so it can be delivered to the operator.
void relayResponse(JsonObject response) {
  const char* alertId     = response["alert_id"]     | "(unknown)";
  bool accepted            = response["accepted"]     | false;
  const char* respondedAt = response["responded_at"] | "";

  // Who answered, copied through unchanged.
  const char* userId      = response["user_id"]      | "";
  const char* username    = response["username"]     | "(anonymous)";

  Serial.printf("[Response] alert_id=%s accepted=%s from=%s\n",
                alertId, accepted ? "true" : "false", username);

  JsonDocument out;
  out["type"] = "forward_response";
  out["alert_id"] = alertId;
  out["accepted"] = accepted;
  out["responded_at"] = respondedAt;
  out["user_id"] = userId;
  out["username"] = username;
  String payload;
  serializeJson(out, payload);
  webSocket.sendTXT(payload);
  Serial.println("[Relay] forward_response -> server (for the operator)");

  // Only after the response is on its way to the Admin.
  if (accepted) {
    espnowDispatchAccepted(alertId, username);
  }
}

// ── WebSocket Event Handler ──
void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {

    case WStype_CONNECTED:
      wsConnected = true;
      consecutiveFailures = 0;
      Serial.printf("[WS] Connected to ws://%s:%u%s\n",
                    serverIp.toString().c_str(), serverPort, SAFE_WS_PATH);
      break;

    case WStype_DISCONNECTED:
      wsConnected = false;
      // Fires on a failed *attempt* as well as on losing an established connection, which is what
      // makes it usable as a "wrong address" signal — loop() re-resolves once these stack up.
      if (consecutiveFailures < 255) consecutiveFailures++;
      Serial.println("[WS] Disconnected — will auto-reconnect");
      break;

    case WStype_TEXT: {
      JsonDocument doc;
      DeserializationError err = deserializeJson(doc, payload, length);
      if (err) {
        Serial.printf("[WS] JSON parse error: %s (len=%u)\n", err.c_str(), length);
        break;
      }

      const char* msgType = doc["type"] | "";

      if (strcmp(msgType, "relay_alert") == 0) {
        // Admin pushed an alert — relay it onward to Consumer dashboards.
        JsonObject alert = doc["alert"].as<JsonObject>();
        if (alert) {
          relayAlert(alert);
        }
      } else if (strcmp(msgType, "relay_response") == 0) {
        // Consumer accepted/declined — relay it onward to Admin dashboards.
        relayResponse(doc.as<JsonObject>());
      } else if (strcmp(msgType, "error") == 0) {
        // The server refused us.
        Serial.printf("[WS] Server rejected this gateway: %s\n", doc["message"] | "(no reason)");
        Serial.println("[WS] Re-flash it so it picks up GATEWAY_TOKEN from .env: npm run flash:gateway");
      } else if (strcmp(msgType, "esp32_status") == 0) {
        // Echo of our own connection status — nothing to do.
      }
      break;
    }

    case WStype_PING:
      // Library auto-responds with pong
      break;

    case WStype_PONG:
      break;

    case WStype_ERROR:
      Serial.println("[WS] Error occurred");
      break;

    default:
      break;
  }
}

// ── Setup ──
void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(500);  // Allow serial monitor to connect

  // The first thing printed, because it's what you need to fill in .env.
  WiFi.mode(WIFI_STA);
  Serial.println();
  Serial.println("================================");
  Serial.println("  DSM gateway");
  Serial.printf( "  MAC: %s\n", WiFi.macAddress().c_str());
  Serial.println("  ^ put this in .env as GATEWAY_MAC");
  Serial.println("================================");
  Serial.println();

  Serial.println("[Config] from .env at build time:");
  Serial.printf( "  Wi-Fi:       \"%s\"\n", WIFI_SSID);
  Serial.printf( "  Server:      mDNS _%s._%s%s%s\n", MDNS_SERVICE, MDNS_PROTO,
                strlen(SERVER_HOST) ? ", fallback " : "", SERVER_HOST);
  Serial.printf( "  Path:        %s\n", SAFE_WS_PATH);
  Serial.println();

  connectWiFi();
  espnowBegin();  // after Wi-Fi: ESP-NOW rides the STA radio and its channel
  while (!resolveServer()) {
    delay(3000);
  }
  startWebSocket();
}

// ── Loop ──
void loop() {
  // Check Wi-Fi health
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] Connection lost — reconnecting...");
    connectWiFi();

    // WiFi.disconnect(true) took the stack down and every ESP-NOW peer with it.
    espnowBegin();

    // The responder doesn't survive the reconnect, and the server may have taken a new lease while
    // we were off the air, so look it up again.
    if (mdnsStarted) {
      MDNS.end();
      mdnsStarted = false;
    }
    if (resolveServer()) startWebSocket();
    consecutiveFailures = 0;
  }

  // Repeated failures with Wi-Fi up means we're dialling the wrong address, almost always the
  // laptop's DHCP lease moving.
  if (consecutiveFailures >= WS_FAILURES_BEFORE_RERESOLVE) {
    consecutiveFailures = 0;
    Serial.println("[WS] Repeated connect failures — looking the server up again");
    if (resolveServer()) startWebSocket();
  }

  // Process WebSocket events (non-blocking)
  webSocket.loop();

  // Print whatever the ESP-NOW callbacks left behind (they run on the Wi-Fi task and deliberately
  // do no I/O of their own).
  espnowLoop();
}
