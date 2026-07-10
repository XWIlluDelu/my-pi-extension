import { isRecord } from "./util.ts";

// ── Turn / session timing ──
// One live turn spans a whole agent-run chain: it opens at the first
// agent_start and closes at agent_settled. Pi fires agent_start once per
// chained run — automatic retries, mid-run compaction, queued continuations —
// but agent_settled only after the chain is done, so those extend the turn
// instead of restarting it. The session total (sum of past turns) is
// reconstructed from the session log's per-turn timestamps, so it survives
// /resume and extension reload without any separate persistence. The two only
// diverge across an interrupt gap; a normal turn has no idle within it, so
// log-reconstructed duration equals active time. An interrupted-then-resumed
// turn adds its gap to the historical sum only — the live turn, timed from
// agent_start, never inflates.

function entryMs(entry: Record<string, unknown>): number | null {
  const ts = entry.timestamp;
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    return Number.isNaN(parsed) ? null : parsed;
  }
  const message = entry.message;
  if (isRecord(message) && typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
    return message.timestamp;
  }
  return null;
}

export interface SessionTimeBase {
  sumMs: number;
  lastTurnMs: number;
}

// A turn opens at the first user message after the previous turn closed, and
// closes at the first assistant message whose stopReason is terminal (anything
// other than "toolUse", which only marks a mid-turn tool step). The log has no
// settle marker, so a run chain reconstructs as one turn per prompt→terminal
// response; chain links abut in time, so the sum is unaffected.
export function reconstructSessionTime(entries: readonly unknown[]): SessionTimeBase {
  let sumMs = 0;
  let lastTurnMs = 0;
  let turnStart: number | null = null;

  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    const role = entry.message.role;
    const ms = entryMs(entry);
    if (ms === null) continue;

    if (role === "user") {
      if (turnStart === null) turnStart = ms;
      continue;
    }
    if (role !== "assistant") continue;

    const stopReason = entry.message.stopReason;
    const terminal = typeof stopReason === "string" && stopReason !== "toolUse";
    if (terminal && turnStart !== null) {
      const duration = Math.max(0, ms - turnStart);
      sumMs += duration;
      lastTurnMs = duration;
      turnStart = null;
    }
  }

  return { sumMs, lastTurnMs };
}

export class TurnClock {
  private turnStartMs: number | null = null;
  private sessionBaseMs = 0;
  private lastTurnMs = 0;
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  hydrate(entries: readonly unknown[]): void {
    const { sumMs, lastTurnMs } = reconstructSessionTime(entries);
    this.sessionBaseMs = sumMs;
    this.lastTurnMs = lastTurnMs;
    this.turnStartMs = null;
  }

  reset(): void {
    this.turnStartMs = null;
    this.sessionBaseMs = 0;
    this.lastTurnMs = 0;
  }

  onTurnStart(): void {
    // agent_start fires once per run in a chain (retry, compaction, queued
    // continuation); only the first opens the turn — agent_settled closes it.
    if (this.turnStartMs === null) this.turnStartMs = this.now();
  }

  onTurnEnd(): void {
    if (this.turnStartMs === null) return;
    this.lastTurnMs = Math.max(0, this.now() - this.turnStartMs);
    this.sessionBaseMs += this.lastTurnMs;
    this.turnStartMs = null;
  }

  running(): boolean {
    return this.turnStartMs !== null;
  }

  turnMs(): number {
    return this.turnStartMs === null ? this.lastTurnMs : Math.max(0, this.now() - this.turnStartMs);
  }

  sessionMs(): number {
    return this.sessionBaseMs + (this.turnStartMs === null ? 0 : Math.max(0, this.now() - this.turnStartMs));
  }

  stats(): { turnMs: number; sessionMs: number; running: boolean } {
    return { turnMs: this.turnMs(), sessionMs: this.sessionMs(), running: this.running() };
  }

  // Second-resolution signature so the render coalescer repaints while a turn
  // runs, but stays quiet once idle (turn/session values are then static).
  signature(): string {
    return `${Math.floor(this.turnMs() / 1000)}|${Math.floor(this.sessionMs() / 1000)}|${this.running() ? 1 : 0}`;
  }
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

export function formatDurationCoarse(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}
