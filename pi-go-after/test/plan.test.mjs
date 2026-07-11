import assert from "node:assert/strict";
import { formatClock, formatRemaining, parseWhen, planCommand } from "../index.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const now = new Date(2026, 6, 11, 12, 0, 0).getTime(); // local 2026-07-11 12:00:00
const cmds = ["compact", "model", "go-after"];

// ── status / cancel forms ──
assert.deepEqual(planCommand("", now, cmds), { action: "status" });
assert.deepEqual(planCommand("   ", now, cmds), { action: "status" });
assert.deepEqual(planCommand("cancel", now, cmds), { action: "cancel" });
assert.equal(planCommand("cancel it", now, cmds).action, "error");

// ── bare minutes and unit durations ──
assert.deepEqual(planCommand("180 continue", now, cmds), { action: "arm", targetMs: now + 180 * MIN, prompt: "continue" });
assert.deepEqual(planCommand("2h30m run tests", now, cmds), { action: "arm", targetMs: now + 2 * HOUR + 30 * MIN, prompt: "run tests" });
assert.deepEqual(planCommand("45s ping", now, cmds), { action: "arm", targetMs: now + 45_000, prompt: "ping" });
assert.deepEqual(planCommand("1h1m1s x", now, cmds), { action: "arm", targetMs: now + HOUR + MIN + 1000, prompt: "x" });

// ── wall clock: future today; past or exactly-now roll to tomorrow ──
assert.deepEqual(planCommand("17:05 go", now, cmds), { action: "arm", targetMs: new Date(2026, 6, 11, 17, 5).getTime(), prompt: "go" });
assert.equal(planCommand("09:00 go", now, cmds).targetMs, new Date(2026, 6, 12, 9, 0).getTime());
assert.equal(planCommand("12:00 go", now, cmds).targetMs, new Date(2026, 6, 12, 12, 0).getTime());
assert.equal(planCommand("7:30 go", now, cmds).targetMs, new Date(2026, 6, 12, 7, 30).getTime());

// ── rejected forms: error out rather than guess ──
for (const bad of ["0 x", "0m x", "0h0m0s x", "abc x", "1.5h x", "2h30 x", "30m2h x", "24:00 x", "17:60 x", "-5 x", "2h30m", "180"]) {
	assert.equal(planCommand(bad, now, cmds).action, "error", `should reject: ${bad}`);
}

// ── spaced duration is ambiguous, and the message carries the corrected form ──
const amb = planCommand("2h 30m finish", now, cmds);
assert.equal(amb.action, "error");
assert.ok(amb.message.includes(`"2h30m"`), amb.message);
const amb2 = planCommand("180 30m finish", now, cmds);
assert.equal(amb2.action, "error");
assert.ok(amb2.message.includes(`"3h30m"`), amb2.message);
// clock heads are exempt; a bare-number second word is an ordinary prompt
assert.equal(planCommand("17:05 30m review", now, cmds).action, "arm");
assert.equal(planCommand("30 30 pushups", now, cmds).prompt, "30 pushups");

// ── prompts colliding with registered commands are refused; lookalikes pass ──
assert.equal(planCommand("30 /compact", now, cmds).action, "error");
assert.equal(planCommand("30 /compact now", now, cmds).action, "error");
assert.equal(planCommand("30 /notacommand hi", now, cmds).action, "arm");
assert.equal(planCommand("30 /home/user/file.txt review this", now, cmds).action, "arm");

// ── prompt is verbatim: internal whitespace and newlines survive ──
assert.deepEqual(planCommand("10s   keep  internal   spacing", now, cmds), {
	action: "arm",
	targetMs: now + 10_000,
	prompt: "keep  internal   spacing",
});
assert.equal(planCommand("10s do this\nthen that", now, cmds).prompt, "do this\nthen that");

// ── parseWhen kinds ──
assert.equal(parseWhen("15", now).kind, "duration");
assert.equal(parseWhen("17:05", now).kind, "clock");

// ── formatting ──
assert.equal(formatRemaining(10_000), "10s");
assert.equal(formatRemaining(59_000), "59s");
assert.equal(formatRemaining(60_000), "1m");
assert.equal(formatRemaining(61_000), "1m");
assert.equal(formatRemaining(10 * MIN), "10m");
assert.equal(formatRemaining(2 * HOUR), "2h");
assert.equal(formatRemaining(150 * MIN), "2h30m");
assert.equal(formatClock(now + 5 * MIN, now), "12:05");
assert.equal(formatClock(new Date(2026, 6, 12, 9, 0).getTime(), now), "tomorrow 09:00");
assert.equal(formatClock(new Date(2026, 6, 14, 9, 0).getTime(), now), "2026-07-14 09:00");

console.log("plan.test.mjs: all assertions passed");
