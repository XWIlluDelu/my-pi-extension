/**
 * pi-fast-mode — inject service_tier=priority for a user-managed model whitelist.
 *
 *   /fast          toggle fast mode on/off (takes effect on the next request)
 *   /fast-models   edit the whitelist interactively
 *   --fast         start the session with fast mode on
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SERVICE_TIER = "priority";
const STATUS_KEY = "fast";
const COMMAND = "fast";
const MODELS_COMMAND = "fast-models";
const FLAG = "fast";
const DONE_LABEL = "Done";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const STATE_FILE = join(AGENT_DIR, "pi-fast-mode.json");

// ---------------------------------------------------------------------------
// Pure state/whitelist layer (unit-tested; no pi dependencies)
// ---------------------------------------------------------------------------

export type ModelKey = { provider: string; id: string };
export type FastState = { enabled: boolean; models: ModelKey[] };
export type PickerEntry = { key: ModelKey; checked: boolean; missing: boolean; label: string };

/** Tolerant parse of the persisted state, including the pre-whitelist `{enabled}` format. */
export function normalizeState(raw: unknown): FastState {
	const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	const models: ModelKey[] = [];
	if (Array.isArray(obj.models)) {
		for (const m of obj.models) {
			const provider = (m as Record<string, unknown>)?.provider;
			const id = (m as Record<string, unknown>)?.id;
			if (typeof provider !== "string" || provider === "" || typeof id !== "string" || id === "") continue;
			if (!models.some((k) => k.provider === provider && k.id === id)) models.push({ provider, id });
		}
	}
	return { enabled: obj.enabled === true, models };
}

export function isWhitelisted(models: ModelKey[], model: { provider: string; id: string } | undefined): boolean {
	return model !== undefined && models.some((k) => k.provider === model.provider && k.id === model.id);
}

export function toggleModel(models: ModelKey[], key: ModelKey): ModelKey[] {
	return isWhitelisted(models, key)
		? models.filter((k) => !(k.provider === key.provider && k.id === key.id))
		: [...models, { provider: key.provider, id: key.id }];
}

/**
 * Picker rows: every available model with its checked state, then whitelisted
 * models that no longer exist in the registry (removed from models.json or
 * auth revoked) — kept visible so they can be unchecked, inert otherwise.
 */
export function buildPicker(available: ModelKey[], whitelist: ModelKey[]): PickerEntry[] {
	const entries: PickerEntry[] = available.map((key) => ({
		key,
		checked: isWhitelisted(whitelist, key),
		missing: false,
		label: `[${isWhitelisted(whitelist, key) ? "✓" : " "}] ${key.provider}/${key.id}`,
	}));
	for (const key of whitelist) {
		if (isWhitelisted(available, key)) continue;
		entries.push({ key, checked: true, missing: true, label: `[✓] ${key.provider}/${key.id} — gone from models; select to remove` });
	}
	return entries;
}

/** Copy of the request payload with service_tier set, or undefined when the payload is not an injectable object. */
export function withServiceTier(payload: unknown): Record<string, unknown> | undefined {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
	return { ...(payload as Record<string, unknown>), service_tier: SERVICE_TIER };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function load(): FastState {
	try {
		return normalizeState(JSON.parse(readFileSync(STATE_FILE, "utf8")));
	} catch {
		return { enabled: false, models: [] };
	}
}

function save(state: FastState): void {
	try {
		writeFileSync(STATE_FILE, JSON.stringify(state));
	} catch {
		// persistence is a convenience; a failed write must not break the session
	}
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	let state = load();

	pi.registerFlag(FLAG, {
		description: `Start with fast mode on (service_tier=${SERVICE_TIER} for whitelisted models)`,
		type: "boolean",
	});

	function paint(model: { provider: string; id: string } | undefined, ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, state.enabled && isWhitelisted(state.models, model) ? "⚡" : undefined);
	}

	pi.registerCommand(COMMAND, {
		description: `Toggle fast mode (service_tier=${SERVICE_TIER} for whitelisted models; /${MODELS_COMMAND} to edit)`,
		handler: async (_args, ctx) => {
			state = { ...state, enabled: !state.enabled };
			save(state);
			paint(ctx.model, ctx);
			if (!state.enabled) ctx.ui.notify("Fast mode off.", "info");
			else if (state.models.length === 0)
				ctx.ui.notify(`Fast mode on, but the whitelist is empty — run /${MODELS_COMMAND} to add models.`, "warning");
			else if (isWhitelisted(state.models, ctx.model))
				ctx.ui.notify(`Fast mode on — ${SERVICE_TIER} tier for ${ctx.model!.provider}/${ctx.model!.id}.`, "info");
			else
				ctx.ui.notify(
					`Fast mode on, inactive for the current model — /${MODELS_COMMAND} to whitelist it.`,
					"warning",
				);
		},
	});

	pi.registerCommand(MODELS_COMMAND, {
		description: "Edit the fast-mode model whitelist",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				const list = state.models.map((k) => `${k.provider}/${k.id}`).join(", ") || "(empty)";
				ctx.ui.notify(`Fast whitelist: ${list}. Editing needs an interactive session.`, "info");
				return;
			}
			await ctx.modelRegistry.refresh();
			for (;;) {
				const available: ModelKey[] = ctx.modelRegistry
					.getAvailable()
					.map((m) => ({ provider: m.provider, id: m.id }));
				const entries = buildPicker(available, state.models);
				if (entries.length === 0) {
					ctx.ui.notify("No models available — configure providers/auth first.", "warning");
					return;
				}
				const labels = [...entries.map((e) => e.label), DONE_LABEL];
				const choice = await ctx.ui.select("Fast whitelist — select to toggle, Esc when done", labels);
				if (choice === undefined || choice === DONE_LABEL) break;
				const entry = entries[labels.indexOf(choice)];
				if (!entry) break;
				state = { ...state, models: toggleModel(state.models, entry.key) };
				save(state);
				paint(ctx.model, ctx);
			}
			const n = state.models.length;
			ctx.ui.notify(
				`Fast whitelist: ${n} model${n === 1 ? "" : "s"}. Fast mode is ${state.enabled ? "on" : `off — /${COMMAND} to enable`}.`,
				"info",
			);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (pi.getFlag(FLAG) === true && !state.enabled) {
			state = { ...state, enabled: true };
			save(state);
		}
		paint(ctx.model, ctx);
	});

	pi.on("model_select", (event, ctx) => paint(event.model, ctx));

	pi.on("before_provider_request", (event, ctx) => {
		if (!state.enabled || !isWhitelisted(state.models, ctx.model)) return undefined;
		return withServiceTier(event.payload);
	});
}
