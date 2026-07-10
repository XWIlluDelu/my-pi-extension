import { spawn } from "node:child_process";
import type { GitStatus } from "./types.ts";

// Staleness backstop for changes made outside pi (another terminal, an
// editor). Pi's own writes show immediately via invalidateGitStatus, so the
// TTL only bounds external-change latency; 7s matches the footer heartbeat —
// the effective idle refresh cadence before the max-level flow timer existed.
// Renders may come at 10Hz while the rainbow flows; git must not.
const CACHE_TTL = 7_000;
const ZERO: GitStatus = { staged: 0, unstaged: 0, untracked: 0 };

interface CacheEntry {
  status: GitStatus;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<void>>();
let globalInvalidationId = 0;

function parse(output: string): GitStatus {
  let staged = 0, unstaged = 0, untracked = 0;
  for (const line of output.split("\n")) {
    if (!line) continue;
    const x = line[0], y = line[1];
    if (x === "?" && y === "?") { untracked++; continue; }
    if (x && x !== " " && x !== "?") staged++;
    if (y && y !== " ") unstaged++;
  }
  return { staged, unstaged, untracked };
}

function run(cwd: string, timeoutMs = 500): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["status", "--porcelain"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let done = false;
    const finish = (r: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.on("close", (code) => finish(code === 0 ? stdout.trim() : null));
    proc.on("error", () => finish(null));
    const timer = setTimeout(() => { proc.kill(); finish(null); }, timeoutMs);
  });
}

export function getGitStatus(cwd?: string): GitStatus {
  const dir = cwd ?? process.cwd();
  const now = Date.now();
  const entry = cache.get(dir);
  if (entry && now - entry.timestamp < CACHE_TTL) return entry.status;

  if (!pending.has(dir)) {
    const id = globalInvalidationId;
    pending.set(dir, run(dir).then((output) => {
      if (id === globalInvalidationId) {
        cache.set(dir, { status: output ? parse(output) : ZERO, timestamp: Date.now() });
      }
      pending.delete(dir);
    }));
  }
  return entry?.status ?? ZERO;
}

export function invalidateGitStatus(): void {
  cache.clear();
  globalInvalidationId++;
}
