/**
 * `npm run data:full`: downloads the full 4-year replay (about 230 MB) into
 * data/full.csv.gz and checks its SHA-256. Then set DATASET=full in .env.
 *
 * The file is a GitHub Release asset of this repository, under the tag below.
 * The URL comes from DATASET_URL if set, otherwise from this clone's `origin`
 * remote, so forks work without editing anything.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const TAG = "dataset-v1";
const ASSET = "full.csv.gz";
const SHA256 = "b41908335560f3162417407fea984b917dcbb26d96b903fab23086efd69fd961";
const TARGET = "data/full.csv.gz";

function releaseUrl(): string {
  if (process.env.DATASET_URL) return process.env.DATASET_URL;
  let remote = "";
  try {
    remote = execSync("git remote get-url origin", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    // No git or no remote: handled below.
  }
  const match = remote.match(/github\.com[:/]([^/]+)\/(.+?)(\.git)?$/);
  if (!match) {
    console.error("Can't work out where to download from: this clone has no GitHub `origin` remote.");
    console.error("Set DATASET_URL to the full.csv.gz release asset and run again.");
    process.exit(1);
  }
  return `https://github.com/${match[1]}/${match[2]}/releases/download/${TAG}/${ASSET}`;
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function main() {
  if (existsSync(TARGET) && sha256(TARGET) === SHA256) {
    console.log(`✓ ${TARGET} is already here and verified. Set DATASET=full in .env to use it.`);
    return;
  }

  const url = releaseUrl();
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    console.error(`Download failed: HTTP ${res.status}. Is the ${TAG} release published with ${ASSET} attached?`);
    process.exit(1);
  }

  const total = Number(res.headers.get("content-length")) || 0;
  let received = 0;
  let lastShown = 0;
  const body = Readable.fromWeb(res.body as never);
  body.on("data", (chunk: Buffer) => {
    received += chunk.length;
    const pct = total ? Math.floor((received / total) * 100) : 0;
    if (pct >= lastShown + 5) {
      lastShown = pct;
      process.stdout.write(`\r  ${pct}%  (${(received / 1e6).toFixed(0)} MB)`);
    }
  });

  const partial = `${TARGET}.partial`;
  await pipeline(body, createWriteStream(partial));
  process.stdout.write("\n");

  if (sha256(partial) !== SHA256) {
    rmSync(partial);
    console.error("The download didn't match the expected checksum, so it was discarded. Try again.");
    process.exit(1);
  }
  renameSync(partial, TARGET);
  console.log(`✓ Saved ${TARGET} (${(statSync(TARGET).size / 1e6).toFixed(0)} MB). Now set DATASET=full in .env and restart.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
