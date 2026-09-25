"""
PlatformIO pre-build script: reads the repo-root .env and writes the settings
each board needs into a generated header, dsm_settings.h, in the build folder.
That's why there's no secrets.h to write by hand: the server and both boards
read the same file, so the gateway token can't drift out of sync.

A header rather than -D flags, because Wi-Fi passwords contain quotes, $ and
backslashes that don't survive a trip through the shell.

Runs inside PlatformIO's own Python, so there's nothing extra to install.
"""

import os
import re

Import("env")  # noqa: F821  (provided by PlatformIO)

PIOENV = env["PIOENV"]  # noqa: F821
REPO_ROOT = os.path.abspath(os.path.join(env.subst("$PROJECT_DIR"), ".."))  # noqa: F821
MAC_RE = re.compile(r"^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$")


def parse_env_file(path):
    """The same subset of .env syntax Node's parser reads: KEY=VALUE, optional quotes, # comments."""
    values = {}
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if key.startswith("export "):
                key = key[len("export "):].strip()
            value = value.strip()
            if value[:1] in ("'", '"', "`") and value.rfind(value[0]) > 0:
                quote = value[0]
                value = value[1:value.rfind(quote)]
                if quote == '"':
                    value = value.replace("\\n", "\n")
            else:
                value = value.split(" #", 1)[0].strip()
            values[key] = value
    return values


def fail(message):
    print("\n" + "=" * 70 + "\n  " + message.replace("\n", "\n  ") + "\n" + "=" * 70 + "\n")
    env.Exit(1)  # noqa: F821


# DSM_ENV_FILE points the build at another file (CI builds against .env.example).
env_path = os.environ.get("DSM_ENV_FILE") or os.path.join(REPO_ROOT, ".env")
if os.path.exists(env_path):
    settings = parse_env_file(env_path)
else:
    # Lets CI (and a curious first build) compile without a real .env.
    settings = parse_env_file(os.path.join(REPO_ROOT, ".env.example"))
    print("[load_env] No .env found. Building with the PLACEHOLDER values from .env.example.")
    print("[load_env] Run `npm run setup` before flashing a real board.")


def c_string(value):
    """A C string literal for any text: escapes quotes and backslashes, octal for the rest."""
    out = []
    for byte in value.encode("utf-8"):
        ch = chr(byte)
        if ch in ('"', "\\"):
            out.append("\\" + ch)
        elif 32 <= byte < 127 and ch != "?":  # '?' avoids trigraph surprises
            out.append(ch)
        else:
            out.append("\\%03o" % byte)
    return '"' + "".join(out) + '"'


def mac(name):
    """'AA:BB:CC:DD:EE:FF' -> '0xAA, 0xBB, ...', or zeros (and False) when unset."""
    value = settings.get(name, "").strip()
    if not value:
        print(f"[load_env] {name} is not set yet: building with 00:00:00:00:00:00.")
        return "0, 0, 0, 0, 0, 0", False
    if not MAC_RE.match(value):
        fail(f"{name}={value!r} in .env is not a MAC address.\nExpected six pairs of hex digits, like AA:BB:CC:DD:EE:FF.")
    return ", ".join("0x" + p.upper() for p in re.split(r"[:-]", value)), True


def number(name, default):
    raw = settings.get(name) or str(default)
    try:
        return float(raw)
    except ValueError:
        fail(f"{name}={raw!r} in .env is not a number.")


ssid = settings.get("WIFI_SSID", "")
if not ssid:
    fail("WIFI_SSID is empty in .env.\nRun `npm run setup` (from the repo root) and enter your 2.4 GHz Wi-Fi name.")

lines = [
    "// Generated from .env by scripts/load_env.py on every build. Don't edit.",
    "#pragma once",
    f"#define WIFI_SSID {c_string(ssid)}",
    f"#define WIFI_PASSWORD {c_string(settings.get('WIFI_PASSWORD', ''))}",
]

if PIOENV == "gateway":
    token = settings.get("GATEWAY_TOKEN", "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{16,}", token):
        fail("GATEWAY_TOKEN in .env is missing or not URL-safe.\nRun `npm run setup` to generate one.")
    lcu_mac, _ = mac("LCU_MAC")
    lines += [
        f"#define GATEWAY_TOKEN {c_string(token)}",
        f"#define LCU_PEER_MAC {lcu_mac}",
        f"#define SERVER_HOST {c_string(settings.get('SERVER_HOST', ''))}",
        f"#define SERVER_PORT {int(number('PORT', 3000))}",
        f"#define LCU_TOTAL_CAPACITY_W {number('LCU_CAPACITY_W', 3000)}f",
    ]

if PIOENV == "lcu":
    gateway_mac, known = mac("GATEWAY_MAC")
    lines += [
        f"#define GATEWAY_MAC_BYTES {gateway_mac}",
        f"#define GATEWAY_MAC_SET {1 if known else 0}",
        f"#define RATED_POWER_W {number('LCU_CAPACITY_W', 3000)}f",
    ]

out_dir = os.path.join(env.subst("$BUILD_DIR"), "generated")  # noqa: F821
os.makedirs(out_dir, exist_ok=True)
header = os.path.join(out_dir, "dsm_settings.h")
content = "\n".join(lines) + "\n"
# Only rewrite when something changed, so an unchanged .env doesn't force a rebuild.
if not os.path.exists(header) or open(header, encoding="utf-8").read() != content:
    with open(header, "w", encoding="utf-8") as f:
        f.write(content)
env.Append(CPPPATH=[out_dir])  # noqa: F821

print(f"[load_env] {PIOENV}: settings loaded from {os.path.basename(env_path) if os.path.exists(env_path) else '.env.example'}")
