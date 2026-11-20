/** `npm run setup`: writes .env, the only file you need to edit. */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseEnv } from "node:util";

const ENV_FILE = ".env";
const nonInteractive = process.argv.includes("--yes") || !process.stdin.isTTY;

const existing: Record<string, string> = existsSync(ENV_FILE)
  ? (parseEnv(readFileSync(ENV_FILE, "utf8")) as Record<string, string>)
  : {};

const secret = (bytes: number) => randomBytes(bytes).toString("base64url");
// Easy to type on a phone: no look-alike characters.
function readablePassword(length = 14): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

const MAC_RE = /^([0-9A-F]{2}[:-]){5}[0-9A-F]{2}$/i;
const normaliseMac = (v: string) => v.trim().toUpperCase().replace(/-/g, ":");

async function main() {
  const rl = nonInteractive ? null : createInterface({ input: process.stdin, output: process.stdout });

  async function ask(key: string, question: string, opts: { validate?: (v: string) => string | null } = {}) {
    const current = process.env[key] ?? existing[key] ?? "";
    if (!rl) return current;
    for (;;) {
      const hint = current ? ` [${key.includes("PASSWORD") ? "keep current" : current}]` : " (Enter to skip)";
      const answer = (await rl.question(`${question}${hint}: `)).trim();
      const value = answer || current;
      const problem = value && opts.validate ? opts.validate(value) : null;
      if (!problem) return value;
      console.log(`  ✗ ${problem}`);
    }
  }

  const macCheck = (v: string) => (MAC_RE.test(v) ? null : "Expected six pairs of hex digits, like AA:BB:CC:DD:EE:FF");

  console.log("\nDSM setup: writes .env. You can re-run this any time.\n");
  if (rl) {
    console.log("Skip anything you don't know yet (the board MACs, say). The app runs without them,");
    console.log("and you can come back once you've flashed the boards.\n");
  }

  const wifiSsid = await ask("WIFI_SSID", "Wi-Fi network name (2.4 GHz)");
  const wifiPassword = await ask("WIFI_PASSWORD", "Wi-Fi password");
  const gatewayMac = await ask("GATEWAY_MAC", "Gateway ESP32 MAC address", { validate: macCheck });
  const lcuMac = await ask("LCU_MAC", "Load-control (LCU) ESP32 MAC address", { validate: macCheck });
  rl?.close();

  const generatedAdminPassword = !existing.ADMIN_PASSWORD && !process.env.ADMIN_PASSWORD;
  const values = {
    WIFI_SSID: wifiSsid,
    WIFI_PASSWORD: wifiPassword,
    GATEWAY_MAC: gatewayMac ? normaliseMac(gatewayMac) : "",
    LCU_MAC: lcuMac ? normaliseMac(lcuMac) : "",
    JWT_SECRET: existing.JWT_SECRET || secret(48),
    GATEWAY_TOKEN: existing.GATEWAY_TOKEN || secret(24),
    ADMIN_USERNAME: process.env.ADMIN_USERNAME ?? existing.ADMIN_USERNAME ?? "admin",
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? existing.ADMIN_PASSWORD ?? readablePassword(),
  };

  // Optional settings the user may have added by hand survive a re-run.
  const optional = ["ADMIN_EMAIL", "PORT", "SERVER_HOST", "DATASET", "LCU_CAPACITY_W"];
  const known = new Set([...Object.keys(values), ...optional]);
  const extra = Object.entries(existing).filter(([k]) => !known.has(k));

  const line = (k: string, v: string) => `${k}=${quote(v)}`;
  const optionalLine = (k: string, example: string, note: string) =>
    existing[k] !== undefined ? `${line(k, existing[k])}  # ${note}` : `# ${k}=${example}  # ${note}`;

  const out = [
    "# DSM settings. Written by `npm run setup`; safe to edit by hand.",
    "# Never commit this file: it holds your Wi-Fi password and secrets.",
    "",
    "# ── You fill these in ────────────────────────────────────────────",
    "# 2.4 GHz network. Both boards AND this computer must be on it.",
    line("WIFI_SSID", values.WIFI_SSID),
    line("WIFI_PASSWORD", values.WIFI_PASSWORD),
    "# Printed on the first line of each board's serial monitor (npm run monitor:gateway / monitor:lcu).",
    line("GATEWAY_MAC", values.GATEWAY_MAC),
    line("LCU_MAC", values.LCU_MAC),
    "",
    "# ── Generated (don't share these) ────────────────────────────────",
    line("JWT_SECRET", values.JWT_SECRET),
    "# Compiled into the gateway firmware, so re-flash the gateway if you change it.",
    line("GATEWAY_TOKEN", values.GATEWAY_TOKEN),
    "# Only used to create the admin account on first start. Change it later in the app.",
    line("ADMIN_USERNAME", values.ADMIN_USERNAME),
    line("ADMIN_PASSWORD", values.ADMIN_PASSWORD),
    "",
    "# ── Optional ─────────────────────────────────────────────────────",
    optionalLine("ADMIN_EMAIL", "admin@example.com", "the admin account's email"),
    optionalLine("PORT", "3000", "web server port"),
    optionalLine("SERVER_HOST", "192.168.1.50", "this computer's IP, only if your network blocks mDNS"),
    optionalLine("DATASET", "full", "'sample' (default) or 'full' after `npm run data:full`"),
    optionalLine("LCU_CAPACITY_W", "3000", "rated power of the load the LCU drives, in watts"),
    ...extra.map(([k, v]) => line(k, v)),
    "",
  ].join("\n");

  writeFileSync(ENV_FILE, out, { mode: 0o600 });

  console.log(`\n✓ Wrote ${ENV_FILE}`);
  if (generatedAdminPassword) {
    console.log(`\n  Admin sign-in   username: ${values.ADMIN_USERNAME}   password: ${values.ADMIN_PASSWORD}`);
    console.log("  (Also saved in .env. It only takes effect the first time the app starts.)");
  }
  const missing = [
    !values.WIFI_SSID && "WIFI_SSID",
    !values.GATEWAY_MAC && "GATEWAY_MAC",
    !values.LCU_MAC && "LCU_MAC",
  ].filter(Boolean);
  if (missing.length) {
    console.log(`\n  Still blank: ${missing.join(", ")}. That's fine without hardware;`);
    console.log("  fill them in (or re-run `npm run setup`) before flashing the boards.");
  }
  console.log("\nNext: npm run dev\n");
}

/** Quote a value so Node's .env parser and firmware/scripts/load_env.py both read it back exactly. */
function quote(v: string): string {
  if (v === "") return "";
  if (!v.includes("'")) return `'${v}'`;
  if (!v.includes('"') && !v.includes("\\n")) return `"${v}"`;
  throw new Error(`Can't store a value containing both ' and " in .env: ${v.slice(0, 3)}…`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
