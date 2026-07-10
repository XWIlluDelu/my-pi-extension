import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CODEX_PROVIDER = "openai-codex";
const SERVICE_TIER = "priority";
const STATUS_KEY = "fast";
const COMMAND = "fast";
const FLAG = "fast";
// Models the Codex backend accepts service_tier=priority for.
const PRIORITY_MODELS = new Set(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]);
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const STATE_FILE = join(AGENT_DIR, "pi-fast-mode.json");

type SelectedModel = { provider: string; id: string };

function eligible(model: SelectedModel | undefined): boolean {
	return model?.provider === CODEX_PROVIDER && PRIORITY_MODELS.has(model.id);
}

function load(): boolean {
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8")).enabled === true;
	} catch {
		return false;
	}
}

function save(enabled: boolean): void {
	try {
		writeFileSync(STATE_FILE, JSON.stringify({ enabled }));
	} catch {
		// persistence is a convenience; a failed write must not break the session
	}
}

export default function (pi: ExtensionAPI): void {
	let enabled = load();

	pi.registerFlag(FLAG, {
		description: `Start with fast mode on (service_tier=${SERVICE_TIER} on ${CODEX_PROVIDER})`,
		type: "boolean",
	});

	function paint(model: SelectedModel | undefined, ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, enabled && eligible(model) ? "⚡" : undefined);
	}

	pi.registerCommand(COMMAND, {
		description: `Toggle OpenAI Codex fast mode (service_tier=${SERVICE_TIER})`,
		handler: async (_args, ctx) => {
			enabled = !enabled;
			save(enabled);
			paint(ctx.model, ctx);
			if (!enabled) ctx.ui.notify("Fast mode off.", "info");
			else if (eligible(ctx.model))
				ctx.ui.notify(`Fast mode on — ${SERVICE_TIER} tier for ${ctx.model!.provider}/${ctx.model!.id}.`, "info");
			else
				ctx.ui.notify(
					`Fast mode on, inactive until you switch to a Codex model: ${[...PRIORITY_MODELS].join(", ")}.`,
					"warning",
				);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (pi.getFlag(FLAG) === true && !enabled) {
			enabled = true;
			save(enabled);
		}
		paint(ctx.model, ctx);
	});

	pi.on("model_select", (event, ctx) => paint(event.model, ctx));

	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || !eligible(ctx.model) || typeof event.payload !== "object" || event.payload === null)
			return undefined;
		return { ...event.payload, service_tier: SERVICE_TIER };
	});
}
