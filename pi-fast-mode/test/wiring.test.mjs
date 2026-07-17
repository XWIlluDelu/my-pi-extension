import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// State file location is read at import time, so point it at a sandbox first.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-fast-mode-test-"));
const { default: activate } = await import("../index.ts");

const sol = { provider: "xwilludelu", id: "gpt-5.6-sol" };
const luna = { provider: "xwilludelu", id: "gpt-5.6-luna" };

function makePi() {
	const commands = new Map();
	const handlers = new Map();
	const api = {
		registerFlag: () => {},
		getFlag: () => undefined,
		registerCommand: (name, opts) => commands.set(name, opts),
		on: (event, fn) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
	};
	const emit = (event, payload, ctx) => {
		let result;
		for (const fn of handlers.get(event) ?? []) result = fn(payload, ctx) ?? result;
		return result;
	};
	return { api, commands, emit };
}

function makeCtx({ model, available, choices }) {
	const ctx = {
		model,
		hasUI: true,
		notifications: [],
		statuses: new Map(),
		ui: {
			notify: (message, type) => ctx.notifications.push({ type, message }),
			setStatus: (key, text) => ctx.statuses.set(key, text),
			select: async (_title, options) => {
				const pick = choices.shift();
				if (pick === undefined) return undefined; // Esc
				const match = options.find((o) => o.includes(pick));
				assert.ok(match, `no option matching "${pick}" in: ${options.join(" | ")}`);
				return match;
			},
		},
		modelRegistry: {
			refresh: async () => {},
			getAvailable: () => available.map((k) => ({ ...k, name: k.id })),
		},
	};
	return ctx;
}

// ── fresh activation: fast off, nothing injected ──
const pi1 = makePi();
activate(pi1.api);
const choices = [];
const ctx = makeCtx({ model: sol, available: [sol, luna], choices });
assert.equal(pi1.emit("before_provider_request", { payload: { model: "m" } }, ctx), undefined);

// ── /fast on with empty whitelist warns and still injects nothing ──
await pi1.commands.get("fast").handler("", ctx);
assert.equal(ctx.notifications.at(-1).type, "warning");
assert.equal(pi1.emit("before_provider_request", { payload: { model: "m" } }, ctx), undefined);

// ── /fast-models: check sol, then Done — injection turns on immediately, no restart ──
choices.push("[ ] xwilludelu/gpt-5.6-sol", "Done");
await pi1.commands.get("fast-models").handler("", ctx);
const payload = { model: "m", stream: true };
assert.deepEqual(pi1.emit("before_provider_request", { payload }, ctx), {
	model: "m",
	stream: true,
	service_tier: "priority",
});
assert.equal(payload.service_tier, undefined, "original payload must not be mutated");
assert.equal(ctx.statuses.get("fast"), "⚡");

// ── non-whitelisted model: armed but inert ──
const lunaCtx = makeCtx({ model: luna, available: [sol, luna], choices });
assert.equal(pi1.emit("before_provider_request", { payload: { model: "m" } }, lunaCtx), undefined);
pi1.emit("model_select", { model: luna }, lunaCtx);
assert.equal(lunaCtx.statuses.get("fast"), undefined);

// ── state survives a restart (fresh activation re-reads the file) ──
assert.deepEqual(JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "pi-fast-mode.json"), "utf8")), {
	enabled: true,
	models: [sol],
});
const pi2 = makePi();
activate(pi2.api);
assert.deepEqual(pi2.emit("before_provider_request", { payload: {} }, ctx), { service_tier: "priority" });

// ── sol later disappears from models.json: picker shows it stale; selecting removes it ──
const staleChoices = ["gone from models", "Done"];
const staleCtx = makeCtx({ model: luna, available: [luna], choices: staleChoices });
await pi2.commands.get("fast-models").handler("", staleCtx);
assert.deepEqual(JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "pi-fast-mode.json"), "utf8")), {
	enabled: true,
	models: [],
});
assert.equal(pi2.emit("before_provider_request", { payload: {} }, ctx), undefined);

console.log("pi-fast-mode: wiring tests passed");
