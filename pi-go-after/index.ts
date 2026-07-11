/**
 * /go-after — one-shot in-session timer: after a delay, send a prompt exactly
 * as if the user typed it at that moment.
 *
 *   /go-after 180 continue the refactor      bare number = minutes
 *   /go-after 2h30m run the full test suite  h/m/s duration, no spaces
 *   /go-after 17:05 continue                 24-hour wall clock, next occurrence
 *   /go-after                                show the pending timer
 *   /go-after cancel                         cancel it
 *
 * Waiting writes nothing: no session entries, no context injection, no model
 * calls. The timer is process memory scoped to the current session; quitting
 * pi, /new, /resume, /fork, /clone, and /reload all cancel it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const COMMAND = "go-after";
const STATUS_KEY = "go-after";
const TICK_MS = 1000;
const PREVIEW_CHARS = 48;
const USAGE = "usage: /go-after <minutes|2h30m|17:05> <prompt>";

// ---------------------------------------------------------------------------
// Pure planning layer (unit-tested; no pi dependencies)
// ---------------------------------------------------------------------------

export type WhenResult = { targetMs: number; kind: "duration" | "clock" } | { error: string };

export type Plan =
	| { action: "status" }
	| { action: "cancel" }
	| { action: "arm"; targetMs: number; prompt: string }
	| { action: "error"; message: string };

const BARE_MINUTES = /^\d+$/;
const UNIT_DURATION = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
const CLOCK = /^(\d{1,2}):(\d{2})$/;

function unitDurationMs(token: string): number | undefined {
	const m = UNIT_DURATION.exec(token);
	if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return undefined;
	return (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000;
}

export function parseWhen(token: string, nowMs: number): WhenResult {
	if (BARE_MINUTES.test(token)) {
		const minutes = Number(token);
		if (minutes === 0) return { error: "duration must be positive" };
		return { targetMs: nowMs + minutes * 60_000, kind: "duration" };
	}
	const clock = CLOCK.exec(token);
	if (clock) {
		const hh = Number(clock[1]);
		const mm = Number(clock[2]);
		if (hh > 23) return { error: `invalid time "${token}" — hours are 0-23` };
		if (mm > 59) return { error: `invalid time "${token}" — minutes are 0-59` };
		const d = new Date(nowMs);
		d.setHours(hh, mm, 0, 0);
		if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
		return { targetMs: d.getTime(), kind: "clock" };
	}
	const ms = unitDurationMs(token);
	if (ms !== undefined) {
		if (ms === 0) return { error: "duration must be positive" };
		return { targetMs: nowMs + ms, kind: "duration" };
	}
	return { error: `cannot parse "${token}" — use minutes (180), a duration (2h30m), or 24-hour time (17:05)` };
}

export function planCommand(args: string, nowMs: number, commandNames: readonly string[]): Plan {
	const input = args.trim();
	if (!input) return { action: "status" };
	const firstSpace = input.search(/\s/);
	const head = firstSpace === -1 ? input : input.slice(0, firstSpace);
	const prompt = firstSpace === -1 ? "" : input.slice(firstSpace + 1).trim();
	if (head === "cancel") {
		return prompt ? { action: "error", message: `"cancel" takes no arguments` } : { action: "cancel" };
	}
	const when = parseWhen(head, nowMs);
	if ("error" in when) return { action: "error", message: `${when.error} — ${USAGE}` };
	if (!prompt) return { action: "error", message: `missing prompt, nothing would be sent — ${USAGE}` };
	const firstWord = prompt.split(/\s/, 1)[0]!;
	if (when.kind === "duration") {
		const extraMs = unitDurationMs(firstWord);
		if (extraMs !== undefined) {
			const combined = exactDuration(when.targetMs - nowMs + extraMs);
			return {
				action: "error",
				message: `ambiguous: "${head} ${firstWord}" — for one duration write "${combined}" (no spaces); otherwise rephrase the prompt so it does not start with a duration`,
			};
		}
	}
	if (firstWord.startsWith("/") && commandNames.includes(firstWord.slice(1))) {
		return {
			action: "error",
			message: `prompt starts with the registered command "${firstWord}" — deferred prompts are sent as plain text, so commands and templates would not run`,
		};
	}
	return { action: "arm", targetMs: when.targetMs, prompt };
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/** "17:05" today, "tomorrow 17:05", or "2026-07-14 17:05" further out. */
export function formatClock(targetMs: number, nowMs: number): string {
	const t = new Date(targetMs);
	const n = new Date(nowMs);
	const hhmm = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
	const dayDelta = Math.round(
		(new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime() -
			new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()) /
			86_400_000,
	);
	if (dayDelta === 0) return hhmm;
	if (dayDelta === 1) return `tomorrow ${hhmm}`;
	return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${hhmm}`;
}

/** Countdown for the status chip: seconds under a minute, then whole minutes, then h/m. */
export function formatRemaining(ms: number): string {
	const s = Math.max(1, Math.ceil(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	const rm = m % 60;
	return rm ? `${h}h${rm}m` : `${h}h`;
}

function exactDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const r = s % 60;
	return `${h ? `${h}h` : ""}${m ? `${m}m` : ""}${r ? `${r}s` : ""}` || "0s";
}

function preview(prompt: string): string {
	const flat = prompt.replace(/\s+/g, " ").trim();
	return flat.length <= PREVIEW_CHARS ? flat : `${flat.slice(0, PREVIEW_CHARS - 1)}…`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	let armed: { targetMs: number; prompt: string } | undefined;
	let interval: ReturnType<typeof setInterval> | undefined;
	let chip: string | undefined;

	function disarm(ctx?: ExtensionContext): void {
		if (interval !== undefined) {
			clearInterval(interval);
			interval = undefined;
		}
		armed = undefined;
		chip = undefined;
		try {
			ctx?.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// teardown may have taken the UI first
		}
	}

	function paint(ctx: ExtensionContext, nowMs: number): void {
		if (!armed) return;
		const text = `⏰ ${formatClock(armed.targetMs, nowMs)} (${formatRemaining(armed.targetMs - nowMs)})`;
		if (text !== chip) {
			chip = text;
			ctx.ui.setStatus(STATUS_KEY, text);
		}
	}

	function fire(ctx: ExtensionContext, prompt: string): void {
		const model = ctx.model;
		const problem =
			model === undefined
				? "no model selected"
				: !ctx.modelRegistry.hasConfiguredAuth(model)
					? ctx.modelRegistry.isUsingOAuth(model)
						? `credentials for "${model.provider}" expired — run /login ${model.provider}`
						: `no API key for "${model.provider}"`
					: undefined;
		if (problem !== undefined) {
			// The prompt was never written anywhere; park it in the input box so it
			// is not lost, unless the user left a draft there.
			let parked = false;
			try {
				if (ctx.ui.getEditorText().trim() === "") {
					ctx.ui.pasteToEditor(prompt);
					parked = true;
				}
			} catch {
				// no editor in this mode; the notification below still carries the prompt
			}
			ctx.ui.notify(
				parked
					? `Scheduled prompt not sent: ${problem}. The prompt is waiting in the input box.`
					: `Scheduled prompt not sent: ${problem}. The prompt was: ${prompt}`,
				"error",
			);
			return;
		}
		// followUp: idle → fires immediately; mid-run → queued until the agent finishes.
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
	}

	function tick(ctx: ExtensionContext): void {
		if (!armed) return;
		const now = Date.now();
		if (now >= armed.targetMs) {
			const prompt = armed.prompt;
			disarm(ctx); // before sending, so a slow turn cannot double-fire a later tick
			fire(ctx, prompt);
			return;
		}
		paint(ctx, now);
	}

	pi.registerCommand(COMMAND, {
		description: "Send a prompt later, as if typed now (minutes, 2h30m, or 17:05; cancel; no args = status)",
		getArgumentCompletions: (prefix: string) => {
			if (armed && "cancel".startsWith(prefix.trim())) {
				return [{ value: "cancel", label: "cancel — clear the pending timer" }];
			}
			return null;
		},
		handler: async (args, ctx) => {
			const now = Date.now();
			const plan = planCommand(
				args ?? "",
				now,
				pi.getCommands().map((c) => c.name),
			);
			switch (plan.action) {
				case "status":
					if (armed) {
						ctx.ui.notify(
							`Fires at ${formatClock(armed.targetMs, now)} (in ${formatRemaining(armed.targetMs - now)}): "${preview(armed.prompt)}"`,
							"info",
						);
					} else {
						ctx.ui.notify(`No pending timer — ${USAGE}, /go-after cancel`, "info");
					}
					return;
				case "cancel":
					if (!armed) {
						ctx.ui.notify("No pending timer.", "info");
						return;
					}
					{
						const was = formatClock(armed.targetMs, now);
						disarm(ctx);
						ctx.ui.notify(`Canceled timer set for ${was}.`, "info");
					}
					return;
				case "error":
					ctx.ui.notify(plan.message, "error");
					return;
				case "arm": {
					const replaced = armed !== undefined ? formatClock(armed.targetMs, now) : undefined;
					disarm(ctx);
					armed = { targetMs: plan.targetMs, prompt: plan.prompt };
					interval = setInterval(() => tick(ctx), TICK_MS);
					paint(ctx, now);
					ctx.ui.notify(
						`${replaced !== undefined ? `Replaced timer (was ${replaced}). ` : ""}Fires at ` +
							`${formatClock(plan.targetMs, now)} (in ${formatRemaining(plan.targetMs - now)}): "${preview(plan.prompt)}"`,
						"info",
					);
					return;
				}
			}
		},
	});

	pi.on("session_shutdown", (_event, ctx) => disarm(ctx));
}
