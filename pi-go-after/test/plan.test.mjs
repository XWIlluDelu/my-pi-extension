import assert from "node:assert/strict";
import goAfter, { formatClock, formatRemaining, parseWhen, planCommand } from "../index.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const now = new Date(2026, 6, 11, 12, 0, 0).getTime(); // local 2026-07-11 12:00:00

// ── status / cancel forms ──
assert.deepEqual(planCommand("", now), { action: "status" });
assert.deepEqual(planCommand("   ", now), { action: "status" });
assert.deepEqual(planCommand("cancel", now), { action: "cancel" });
assert.equal(planCommand("cancel it", now).action, "error");

// ── bare minutes and unit durations ──
assert.deepEqual(planCommand("180 continue", now), { action: "arm", targetMs: now + 180 * MIN, prompt: "continue" });
assert.deepEqual(planCommand("2h30m run tests", now), { action: "arm", targetMs: now + 2 * HOUR + 30 * MIN, prompt: "run tests" });
assert.deepEqual(planCommand("45s ping", now), { action: "arm", targetMs: now + 45_000, prompt: "ping" });
assert.deepEqual(planCommand("1h1m1s x", now), { action: "arm", targetMs: now + HOUR + MIN + 1000, prompt: "x" });

// ── wall clock: future today; past or exactly-now roll to tomorrow ──
assert.deepEqual(planCommand("17:05 go", now), { action: "arm", targetMs: new Date(2026, 6, 11, 17, 5).getTime(), prompt: "go" });
assert.equal(planCommand("09:00 go", now).targetMs, new Date(2026, 6, 12, 9, 0).getTime());
assert.equal(planCommand("12:00 go", now).targetMs, new Date(2026, 6, 12, 12, 0).getTime());
assert.equal(planCommand("7:30 go", now).targetMs, new Date(2026, 6, 12, 7, 30).getTime());

// ── rejected forms: error out rather than guess ──
for (const bad of ["0 x", "0m x", "0h0m0s x", "abc x", "1.5h x", "2h30 x", "30m2h x", "24:00 x", "17:60 x", "-5 x", "2h30m", "180"]) {
	assert.equal(planCommand(bad, now).action, "error", `should reject: ${bad}`);
}
for (const overflow of [`${"9".repeat(400)} x`, `${"9".repeat(400)}h x`]) {
	assert.equal(planCommand(overflow, now).action, "error", "overflow must not arm an immortal timer");
}

// ── spaced duration is ambiguous, and the message carries the corrected form ──
const amb = planCommand("2h 30m finish", now);
assert.equal(amb.action, "error");
assert.ok(amb.message.includes(`"2h30m"`), amb.message);
const amb2 = planCommand("180 30m finish", now);
assert.equal(amb2.action, "error");
assert.ok(amb2.message.includes(`"3h30m"`), amb2.message);
// clock heads are exempt; a bare-number second word is an ordinary prompt
assert.equal(planCommand("17:05 30m review", now).action, "arm");
assert.equal(planCommand("30 30 pushups", now).prompt, "30 pushups");

// ── slash-command-like prompts are refused; absolute paths pass ──
assert.equal(planCommand("30 /compact", now).action, "error");
assert.equal(planCommand("30 /compact now", now).action, "error");
assert.equal(planCommand("30 /notacommand hi", now).action, "error");
assert.equal(planCommand("30 /home/user/file.txt review this", now).action, "arm");

// ── prompt is verbatim: internal whitespace and newlines survive ──
assert.deepEqual(planCommand("10s   keep  internal   spacing", now), {
	action: "arm",
	targetMs: now + 10_000,
	prompt: "keep  internal   spacing",
});
assert.equal(planCommand("10s do this\nthen that", now).prompt, "do this\nthen that");

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

// ── runtime: local-only wait, one delivery, and shutdown cleanup ──
const realNow = Date.now;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
let clock = now;
let nextTimerId = 1;
const timers = new Map();
Date.now = () => clock;
globalThis.setInterval = (callback, delay) => {
	assert.equal(delay, 1000);
	const id = nextTimerId++;
	timers.set(id, callback);
	return id;
};
globalThis.clearInterval = (id) => timers.delete(id);

try {
	let command;
	let shutdown;
	const sent = [];
	const statuses = new Map();
	const notifications = [];
	const pi = {
		registerCommand(name, definition) {
			assert.equal(name, "go-after");
			command = definition;
		},
		registerTool() {
			assert.fail("go-after must not register an LLM-visible tool");
		},
		appendEntry() {
			assert.fail("waiting must not write session state");
		},
		on(event, handler) {
			assert.equal(event, "session_shutdown", "go-after must not register model-context hooks");
			shutdown = handler;
		},
		sendUserMessage: (content, options) => sent.push({ content, options }),
	};
	goAfter(pi);
	assert.ok(command);
	assert.ok(shutdown);

	const ctx = {
		model: { provider: "test", id: "test" },
		modelRegistry: {
			hasConfiguredAuth: () => true,
			isUsingOAuth: () => false,
		},
		ui: {
			setStatus: (key, value) => (value === undefined ? statuses.delete(key) : statuses.set(key, value)),
			notify: (message, level) => notifications.push({ message, level }),
		},
	};

	await command.handler("1s continue", ctx);
	assert.equal(sent.length, 0, "arming must not call the model");
	assert.equal(timers.size, 1);
	assert.match(statuses.get("go-after"), /^⏰ /);
	assert.match(notifications.at(-1).message, /^Fires at /);
	const firstTick = timers.values().next().value;
	clock += 1000;
	firstTick();
	assert.deepEqual(sent, [{ content: "continue", options: { deliverAs: "followUp" } }]);
	assert.equal(timers.size, 0);
	assert.equal(statuses.has("go-after"), false);
	firstTick();
	assert.equal(sent.length, 1, "an expired timer must fire only once");

	await command.handler("1h never send", ctx);
	assert.equal(timers.size, 1);
	const staleTick = timers.values().next().value;
	shutdown({}, ctx);
	assert.equal(timers.size, 0);
	clock += HOUR;
	staleTick();
	assert.equal(sent.length, 1, "session shutdown must disarm the timer");
} finally {
	Date.now = realNow;
	globalThis.setInterval = realSetInterval;
	globalThis.clearInterval = realClearInterval;
}

console.log("plan.test.mjs: all assertions passed");
