import assert from "node:assert/strict";
import { buildPicker, isWhitelisted, normalizeState, toggleModel, withServiceTier } from "../index.ts";

const sol = { provider: "xwilludelu", id: "gpt-5.6-sol" };
const luna = { provider: "xwilludelu", id: "gpt-5.6-luna" };
const gone = { provider: "openai-codex", id: "gpt-5.5" };

// ── normalizeState: current format, legacy format, garbage ──
assert.deepEqual(normalizeState({ enabled: true, models: [sol] }), { enabled: true, models: [sol] });
assert.deepEqual(normalizeState({ enabled: false }), { enabled: false, models: [] }); // pre-whitelist file
assert.deepEqual(normalizeState({ enabled: true }), { enabled: true, models: [] });
assert.deepEqual(normalizeState(undefined), { enabled: false, models: [] });
assert.deepEqual(normalizeState("junk"), { enabled: false, models: [] });
assert.deepEqual(normalizeState({ enabled: "yes", models: {} }), { enabled: false, models: [] });
// malformed entries dropped, duplicates collapsed, extraneous fields stripped
assert.deepEqual(
	normalizeState({
		enabled: true,
		models: [sol, { provider: "x" }, { id: "y" }, { provider: "", id: "y" }, null, 7, { ...sol, extra: 1 }, luna],
	}),
	{ enabled: true, models: [sol, luna] },
);

// ── isWhitelisted / toggleModel ──
assert.equal(isWhitelisted([sol], sol), true);
assert.equal(isWhitelisted([sol], luna), false);
assert.equal(isWhitelisted([sol], undefined), false);
assert.deepEqual(toggleModel([], sol), [sol]);
assert.deepEqual(toggleModel([sol, luna], sol), [luna]);
assert.deepEqual(toggleModel(toggleModel([], sol), sol), []);

// ── buildPicker: available models keep registry order; stale whitelist entries trail, marked ──
const picker = buildPicker([sol, luna], [luna, gone]);
assert.deepEqual(
	picker.map((e) => [e.key.id, e.checked, e.missing]),
	[
		["gpt-5.6-sol", false, false],
		["gpt-5.6-luna", true, false],
		["gpt-5.5", true, true],
	],
);
assert.equal(picker[0].label, "[ ] xwilludelu/gpt-5.6-sol");
assert.equal(picker[1].label, "[✓] xwilludelu/gpt-5.6-luna");
assert.ok(picker[2].label.includes("gone from models"), picker[2].label);
// labels are unique (select() maps the chosen string back to an entry)
assert.equal(new Set(picker.map((e) => e.label)).size, picker.length);
// a fully valid whitelist produces no stale rows
assert.ok(buildPicker([sol], [sol]).every((e) => !e.missing));

// ── withServiceTier: inject on plain objects only ──
assert.deepEqual(withServiceTier({ model: "m", stream: true }), { model: "m", stream: true, service_tier: "priority" });
assert.deepEqual(withServiceTier({ service_tier: "default" }), { service_tier: "priority" });
assert.equal(withServiceTier(null), undefined);
assert.equal(withServiceTier(undefined), undefined);
assert.equal(withServiceTier("body"), undefined);
assert.equal(withServiceTier([1, 2]), undefined);

console.log("pi-fast-mode: all tests passed");
