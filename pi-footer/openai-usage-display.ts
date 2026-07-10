import { applyColor, resolveColor } from "./theme.ts";
import {
  getOpenAIUsageDisplay,
  refreshOpenAIUsage,
  type OpenAIUsageDisplay as OpenAIUsageDisplayValue,
} from "./openai-usage.ts";
import { isRecord } from "./util.ts";
import type { ThemeLike } from "./types.ts";

// ── OpenAI subscription usage display lifecycle ──
// Owns the rotating right-side usage line shown when the active model is on the
// openai-codex provider: the 7s wall-clock rotation between token totals and
// subscription quota, the codex guard, and the refresh that backs the cache.
// Repaints are driven by the shared footer heartbeat in index.ts, not a timer
// owned here. The model lookup, display snapshot reader, refresh call, render
// trigger, and clock are injected so the phase/rotation logic is testable
// without disk or network.

const STATS_ROTATION_MS = 7_000;

export function modelUsesOpenAISubscription(model: unknown): boolean {
  if (!isRecord(model)) return false;
  const provider = model.provider;
  if (typeof provider === "string") return provider === "openai-codex";
  if (isRecord(provider) && typeof provider.id === "string") return provider.id === "openai-codex";
  return false;
}

export interface OpenAIUsageDisplayDeps {
  getModel: () => unknown;
  getDisplay?: () => OpenAIUsageDisplayValue | null;
  refreshUsage?: (force?: boolean) => Promise<OpenAIUsageDisplayValue | null>;
  requestRender: (force?: boolean) => void;
  now?: () => number;
}

export class OpenAIUsageDisplay {
  private readonly getModel: () => unknown;
  private readonly getDisplay: () => OpenAIUsageDisplayValue | null;
  private readonly refreshUsage: (force?: boolean) => Promise<OpenAIUsageDisplayValue | null>;
  private readonly requestRender: (force?: boolean) => void;
  private readonly now: () => number;

  constructor(deps: OpenAIUsageDisplayDeps) {
    this.getModel = deps.getModel;
    this.getDisplay = deps.getDisplay ?? (() => getOpenAIUsageDisplay());
    this.refreshUsage = deps.refreshUsage ?? ((force) => refreshOpenAIUsage(force));
    this.requestRender = deps.requestRender;
    this.now = deps.now ?? (() => Date.now());
  }

  rightLine(theme: ThemeLike): string | null {
    if (!modelUsesOpenAISubscription(this.getModel())) return null;
    if (this.phase() === 0) return null;
    const display = this.getDisplay();
    if (!display) return null;
    const color = resolveColor(display.limited ? "warning" : "tokens");
    return applyColor(theme, color, display.text);
  }

  stateText(): string {
    if (!modelUsesOpenAISubscription(this.getModel())) return "";
    if (this.phase() === 0) return "";
    const display = this.getDisplay();
    if (!display) return "";
    return `${display.limited ? "limited" : "ok"}|${display.text}`;
  }

  refresh(): void {
    if (!modelUsesOpenAISubscription(this.getModel())) return;
    void this.refreshUsage().finally(() => this.requestRender(true));
  }

  private phase(): number {
    return Math.floor(this.now() / STATS_ROTATION_MS) % 2;
  }
}
