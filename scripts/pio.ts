/**
 * Runs PlatformIO against firmware/ for the flash/monitor npm scripts.
 *
 * Finds `pio` on PATH, or where the VS Code PlatformIO extension installs it
 * (which is not on PATH), so beginners don't have to fix their PATH first.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";

function findPio(): string | null {
  const onPath = spawnSync(platform() === "win32" ? "where" : "which", ["pio"], { encoding: "utf8" });
  if (onPath.status === 0 && onPath.stdout.trim()) return "pio";
  const bin = platform() === "win32" ? "Scripts" : "bin";
  const exe = platform() === "win32" ? "pio.exe" : "pio";
  const vscode = path.join(homedir(), ".platformio", "penv", bin, exe);
  return existsSync(vscode) ? vscode : null;
}

const pio = findPio();
if (!pio) {
  console.error(`
PlatformIO isn't installed. Install either:
  - the "PlatformIO IDE" extension for VS Code, or
  - the command-line tool:  pip install platformio
then run this again.`);
  process.exit(1);
}

const args = process.argv.slice(2);
// `pio device monitor` and `pio run` both accept -d <project dir>.
const result = spawnSync(pio, [...args, "-d", "firmware"], { stdio: "inherit" });
process.exit(result.status ?? 1);
