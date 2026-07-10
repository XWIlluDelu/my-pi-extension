import { type ExtensionAPI, type ReadonlyFooterDataProvider, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { applyColor, FLOW_FRAME_MS, resolveColor } from "./theme.ts";
import { SEGMENTS, PRESET, orderedExtensionStatuses } from "./segments.ts";
import { renderBottomLine } from "./bottom-line.ts";
import { refreshOpenAIUsage } from "./openai-usage.ts";
import { OpenAIUsageDisplay, modelUsesOpenAISubscription } from "./openai-usage-display.ts";
import { isRecord } from "./util.ts";
import { TurnClock } from "./time.ts";
import type { SegmentContext, ThemeLike } from "./types.ts";
import { getGitStatus, invalidateGitStatus } from "./git-status.ts";
import {
  addUsageTotals,
  contextStatsFromContext,
  sumAssistantUsage,
  usageTotalsFromUsage,
  usageTokenTotal,
  ZERO_USAGE_TOTALS,
  type UsageTotals,
} from "./usage.ts";

// ═══════════════════════════════════════════
// Module state
// ═══════════════════════════════════════════

let currentCtx: any = null;
let footerDataRef: ReadonlyFooterDataProvider | null = null;
let tuiRef: any = null;
let currentResponseUsage: any = null;
let latestAssistantUsage: any = null;
let lastUserPrompt = "";
let currentThinkingLevel = "off";
let cumulativeUsage: UsageTotals = { ...ZERO_USAGE_TOTALS };
let footerRenderTimer: ReturnType<typeof setTimeout> | undefined;
let footerRenderState = "";
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let flowTimer: ReturnType<typeof setInterval> | undefined;

// A single low-frequency heartbeat drives repaints during quiet stretches: it
// rotates the OpenAI usage line and advances the turn timer between agent
// events. Active work repaints far more often through the event handlers.
const HEARTBEAT_MS = 7_000;

// While the max thinking level is selected, a fast timer forces repaints so
// its rainbow flows (the phase itself is clock-derived in theme.ts). Same
// idiom as pi-tui's Loader spinner (80ms setInterval).
function syncFlowTimer(): void {
  const wantFlow = currentThinkingLevel === "max";
  if (wantFlow && !flowTimer) {
    flowTimer = setInterval(() => requestFooterRender(true), FLOW_FRAME_MS);
    flowTimer.unref?.();
  } else if (!wantFlow && flowTimer) {
    clearInterval(flowTimer);
    flowTimer = undefined;
  }
}

const turnClock = new TurnClock();

const openaiDisplay = new OpenAIUsageDisplay({
  getModel: () => currentCtx?.model,
  requestRender: (force) => requestFooterRender(force),
});

// ── Usage totals ──

function displayedUsageTotals(): UsageTotals {
  return addUsageTotals(cumulativeUsage, usageTotalsFromUsage(currentResponseUsage));
}

function sessionUsageEntries(ctx: any): readonly unknown[] {
  return ctx?.sessionManager?.getEntries?.() ?? ctx?.sessionManager?.getBranch?.() ?? [];
}

function syncCumulativeUsage(ctx: any): void {
  cumulativeUsage = sumAssistantUsage(sessionUsageEntries(ctx));
}

function buildContext(): SegmentContext | null {
  if (!currentCtx) return null;

  const contextStats = contextStatsFromContext(currentCtx, currentResponseUsage, latestAssistantUsage);

  return {
    modelName: currentCtx.model?.name ?? currentCtx.model?.id ?? "?",
    thinkingLevel: currentThinkingLevel,
    folder: basename(currentCtx.cwd ?? ""),
    gitBranch: footerDataRef?.getGitBranch() ?? null,
    gitStatus: getGitStatus(currentCtx.cwd),
    contextPct: contextStats.percent,
    contextWindow: contextStats.window,
    statuses: footerDataRef?.getExtensionStatuses() ?? null,
    time: turnClock.stats(),
  };
}

function buildLine(width: number, theme: ThemeLike): string {
  const ctx = buildContext();
  if (!ctx) return "";

  const rendered: string[] = [];
  for (const id of PRESET) {
    const seg = SEGMENTS[id];
    if (!seg) continue;
    const content = seg.render(ctx, theme);
    if (content) rendered.push(content);
  }

  if (rendered.length === 0) return "";

  const sepColor = resolveColor("separator");
  const sep = applyColor(theme, sepColor, " │ ");
  const sepWidth = visibleWidth(String(sep));

  let cw = 1;
  const fit: string[] = [];
  for (const seg of rendered) {
    const needed = visibleWidth(seg) + (fit.length > 0 ? sepWidth : 0);
    if (cw + needed <= width - 1) { fit.push(seg); cw += needed; } else break;
  }
  if (fit.length === 0) return "";
  return " " + fit.join(sep);
}

function computeFooterRenderState(): string {
  const context = buildContext();
  const usage = displayedUsageTotals();
  const statusLine = context?.statuses ? orderedExtensionStatuses(context.statuses).join(" | ") : "";
  const model = currentCtx?.model;
  const provider = isRecord(model?.provider) ? model.provider.id : String(model?.provider ?? "");

  return [
    currentCtx?.cwd ?? "",
    provider,
    currentCtx?.model?.id ?? "",
    currentCtx?.model?.name ?? "",
    currentThinkingLevel,
    String(footerDataRef?.getGitBranch() ?? ""),
    String(context?.contextPct ?? ""),
    String(context?.contextWindow ?? ""),
    `${usage.input}|${usage.output}|${usage.cacheRead}|${usage.cacheWrite}|${usage.cost}`,
    statusLine,
    String(lastUserPrompt),
    openaiDisplay.stateText(),
    turnClock.signature(),
    currentResponseUsage ? "r" : "",
    latestAssistantUsage ? "a" : "",
  ].join("|");
}

function requestFooterRender(force = false): void {
  const state = computeFooterRenderState();
  if (!force && state === footerRenderState) return;
  footerRenderState = state;

  if (footerRenderTimer) return;
  footerRenderTimer = setTimeout(() => {
    footerRenderTimer = undefined;
    tuiRef?.requestRender?.();
  }, 0);
  footerRenderTimer.unref?.();
}

function initThinkingLevel(events: readonly unknown[]): void {
  currentThinkingLevel = "off";
  for (const e of events) {
    if (isRecord(e) && e.type === "thinking_level_change" && typeof e.thinkingLevel === "string") {
      currentThinkingLevel = e.thinkingLevel;
    }
  }
}

function restoreLastPrompt(events: readonly unknown[]): void {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!isRecord(e) || e.type !== "message" || !isRecord(e.message) || e.message.role !== "user") continue;
    const c = e.message.content;
    if (typeof c === "string") { lastUserPrompt = c; return; }
    if (Array.isArray(c)) {
      lastUserPrompt = c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ");
      if (lastUserPrompt) return;
    }
  }
}

// ═══════════════════════════════════════════
// Extension entry — thin orchestrator
// ═══════════════════════════════════════════

export default function piFooter(pi: ExtensionAPI) {
  pi.registerCommand("openai-usage", {
    description: "Refresh OpenAI subscription usage cache",
    handler: async (_args, ctx) => {
      currentCtx = ctx;
      if (!modelUsesOpenAISubscription(ctx.model)) {
        ctx.ui.notify("OpenAI usage hidden: current model is not openai-codex", "info");
        return;
      }
      const display = await refreshOpenAIUsage(true);
      if (!display) {
        ctx.ui.notify("OpenAI usage unavailable", "error");
        return;
      }
      ctx.ui.notify(`OpenAI usage: ${display.text}`, display.limited ? "warning" : "info");
      requestFooterRender();
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    currentCtx = ctx;

    ctx.ui.setFooter((tui: any, _theme: Theme, footerData: ReadonlyFooterDataProvider) => {
      footerDataRef = footerData;
      tuiRef = tui;
      footerData.onBranchChange(() => requestFooterRender());
      return { render: () => [], dispose() {} };
    });

    ctx.ui.setWidget("pi-footer", (_tui: any, theme: Theme) => ({
      render(width: number) {
        const line = buildLine(width, theme);
        return line ? [line] : [];
      },
    }), { placement: "aboveEditor" });

    // Last prompt (left) + rotating token/cost ↔ OpenAI usage (right).
    ctx.ui.setWidget("pi-footer-bottom", (_tui: any, theme: Theme) => ({
      render(width: number) {
        return renderBottomLine(width, lastUserPrompt, displayedUsageTotals(), theme, openaiDisplay.rightLine(theme));
      },
    }), { placement: "belowEditor" });

    const events = ctx.sessionManager?.getBranch?.() ?? [];
    if (!lastUserPrompt) restoreLastPrompt(events);
    initThinkingLevel(events);
    syncFlowTimer();
    turnClock.hydrate(events);

    // Rebuild cumulative tokens from all session entries (startup, /resume, reload).
    syncCumulativeUsage(ctx);
    currentResponseUsage = null;
    latestAssistantUsage = null;

    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      openaiDisplay.refresh();
      requestFooterRender();
    }, HEARTBEAT_MS);
    heartbeatTimer.unref?.();

    openaiDisplay.refresh();
    requestFooterRender(true);
  });

  // ── Events ──

  const rerender = (ctx: any) => { currentCtx = ctx; requestFooterRender(); };

  pi.on("turn_end", (_e, ctx) => {
    syncCumulativeUsage(ctx);
    rerender(ctx);
  });
  pi.on("model_select", (_e, ctx) => {
    currentCtx = ctx;
    openaiDisplay.refresh();
    requestFooterRender();
  });
  pi.on("thinking_level_select", (event, ctx) => {
    if (typeof (event as any).level === "string") currentThinkingLevel = (event as any).level;
    syncFlowTimer();
    rerender(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    currentCtx = ctx;
    currentResponseUsage = null;
    latestAssistantUsage = null;
    turnClock.onTurnStart();
    requestFooterRender();
  });
  pi.on("before_agent_start", (event, ctx) => {
    currentCtx = ctx;
    lastUserPrompt = event.prompt;
    currentResponseUsage = null;
    requestFooterRender();
  });

  pi.on("message_start", (event, ctx) => {
    if (isRecord(event.message) && event.message.role === "assistant") {
      currentResponseUsage = null;
      currentCtx = ctx;
      requestFooterRender();
    }
  });
  pi.on("message_update", (event, ctx) => {
    if (isRecord(event.message) && event.message.role === "assistant" &&
        event.message.stopReason !== "error" && event.message.stopReason !== "aborted") {
      if (isRecord(event.message.usage)) {
        currentResponseUsage = event.message.usage;
        latestAssistantUsage = event.message.usage;
      }
      currentCtx = ctx;
      requestFooterRender();
    }
  });
  pi.on("message_end", (event, ctx) => {
    if (isRecord(event.message) && event.message.role === "assistant") {
      currentResponseUsage = null;
      if (event.message.stopReason !== "error" && event.message.stopReason !== "aborted" &&
          isRecord(event.message.usage)) {
        const usageTotals = usageTotalsFromUsage(event.message.usage);
        if (usageTokenTotal(event.message.usage) > 0 || usageTotals.cost > 0) {
          latestAssistantUsage = event.message.usage;
          cumulativeUsage = addUsageTotals(cumulativeUsage, usageTotals);
        }
      }
    }
    rerender(ctx);
  });
  pi.on("agent_end", (_event, ctx) => {
    currentCtx = ctx;
    syncCumulativeUsage(ctx);
    currentResponseUsage = null;
    turnClock.onTurnEnd();
    requestFooterRender();
  });
  pi.on("tool_result", (e, ctx) => {
    currentCtx = ctx;
    if (e.toolName === "write" || e.toolName === "edit") invalidateGitStatus();
  });
  pi.on("session_compact", (_event, ctx) => {
    currentCtx = ctx;
    currentResponseUsage = null;
    latestAssistantUsage = null;
    syncCumulativeUsage(ctx);
    requestFooterRender();
  });
  pi.on("session_shutdown", () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    if (flowTimer) {
      clearInterval(flowTimer);
      flowTimer = undefined;
    }
    if (footerRenderTimer) {
      clearTimeout(footerRenderTimer);
      footerRenderTimer = undefined;
    }
    invalidateGitStatus();
    cumulativeUsage = { ...ZERO_USAGE_TOTALS };
    currentResponseUsage = null;
    latestAssistantUsage = null;
    lastUserPrompt = "";
    currentThinkingLevel = "off";
    turnClock.reset();
    footerRenderState = "";
    footerDataRef = null;
    tuiRef = null;
    currentCtx = null;
  });
}
