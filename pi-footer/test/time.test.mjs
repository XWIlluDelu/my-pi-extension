import assert from "node:assert/strict";
import {
  reconstructSessionTime,
  TurnClock,
  formatDuration,
  formatDurationCoarse,
} from "../time.ts";

// ── reconstructSessionTime: sum of per-turn (user → terminal assistant) spans ──

const ts = (iso) => ({ timestamp: iso });
const branch = [
  { ...ts("2026-07-09T10:00:00Z"), type: "message", message: { role: "user", content: "a" } },
  { ...ts("2026-07-09T10:00:05Z"), type: "message", message: { role: "assistant", stopReason: "toolUse" } },
  { ...ts("2026-07-09T10:00:20Z"), type: "message", message: { role: "assistant", stopReason: "stop" } }, // turn 1 = 20s
  { ...ts("2026-07-09T10:05:00Z"), type: "message", message: { role: "user", content: "b" } },
  { ...ts("2026-07-09T10:05:10Z"), type: "message", message: { role: "assistant", stopReason: "error" } }, // turn 2 = 10s
  { ...ts("2026-07-09T10:06:00Z"), type: "message", message: { role: "user", content: "c" } }, // in-flight, uncounted
];
assert.deepEqual(reconstructSessionTime(branch), { sumMs: 30_000, lastTurnMs: 10_000 });
assert.deepEqual(reconstructSessionTime([]), { sumMs: 0, lastTurnMs: 0 });

// A dangling assistant message without an open turn contributes nothing.
assert.deepEqual(
  reconstructSessionTime([{ ...ts("2026-07-09T10:00:00Z"), type: "message", message: { role: "assistant", stopReason: "stop" } }]),
  { sumMs: 0, lastTurnMs: 0 },
);

// ── TurnClock: active-time live turn + reconstructed base, injected clock ──

{
  const clock = { now: 1_000 };
  const c = new TurnClock(() => clock.now);
  c.hydrate(branch); // base 30s, last 10s
  assert.equal(c.running(), false);
  assert.equal(c.turnMs(), 10_000); // idle shows last turn
  assert.equal(c.sessionMs(), 30_000);

  c.onTurnStart(); // turnStart = 1_000
  clock.now = 4_500;
  assert.equal(c.running(), true);
  assert.equal(c.turnMs(), 3_500); // live, from agent_start (never inflated by history)
  assert.equal(c.sessionMs(), 33_500); // base + live

  clock.now = 6_000;
  c.onTurnEnd(); // turn = 5_000
  assert.equal(c.running(), false);
  assert.equal(c.turnMs(), 5_000);
  assert.equal(c.sessionMs(), 35_000);
}

// reset zeroes everything.
{
  const c = new TurnClock(() => 0);
  c.hydrate(branch);
  c.reset();
  assert.equal(c.sessionMs(), 0);
  assert.equal(c.turnMs(), 0);
}

// ── Formatters ──

assert.equal(formatDuration(5_000), "5s");
assert.equal(formatDuration(83_000), "1m23s");
assert.equal(formatDuration(3_723_000), "1h2m");
assert.equal(formatDurationCoarse(5_000), "5s");
assert.equal(formatDurationCoarse(83_000), "1m");
assert.equal(formatDurationCoarse(3_723_000), "1h2m");

console.log("time tests passed");
