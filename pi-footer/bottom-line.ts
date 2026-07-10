import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { ThemeLike } from "./types.ts";
import { applyColor, resolveColor } from "./theme.ts";
import type { UsageTotals } from "./usage.ts";

const MIN_PROMPT_STATS_GAP = 18;
const MIN_PROMPT_TEXT_WIDTH_WITH_STATS = 12;

function formatTokenNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(Math.round(n));
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(3)}`;
}

function renderStatsLine(usage: UsageTotals, theme: ThemeLike): string {
  if (
    usage.input === 0 &&
    usage.output === 0 &&
    usage.cacheRead === 0 &&
    usage.cacheWrite === 0 &&
    usage.cost === 0
  ) return "";
  const c = resolveColor("tokens");
  const parts: string[] = [];
  if (usage.input > 0) parts.push(applyColor(theme, c, "\u2191") + applyColor(theme, c, formatTokenNumber(usage.input)));
  if (usage.output > 0) parts.push(applyColor(theme, c, "\u2193") + applyColor(theme, c, formatTokenNumber(usage.output)));
  if (usage.cacheRead > 0) parts.push(applyColor(theme, c, "R") + applyColor(theme, c, formatTokenNumber(usage.cacheRead)));
  if (usage.cacheWrite > 0) parts.push(applyColor(theme, c, "W") + applyColor(theme, c, formatTokenNumber(usage.cacheWrite)));
  if (usage.cost > 0) parts.push(applyColor(theme, c, formatCost(usage.cost)));
  return parts.join(" ");
}

function renderPromptPart(
  rawPrompt: string,
  maxWidth: number,
  theme: ThemeLike,
  minTextWidth = 0,
): string {
  const sep = applyColor(theme, resolveColor("separator"), " \u21B3 ");
  const sepW = visibleWidth(String(sep));
  let text = rawPrompt.replace(/\s+/g, " ").trim();
  const maxTextW = maxWidth - sepW;
  if (maxTextW <= 0 || maxTextW < minTextWidth) return "";
  if (visibleWidth(text) > maxTextW) text = truncateToWidth(text, maxTextW);
  return sep + applyColor(theme, resolveColor("tokens"), text);
}

/**
 * Render the bottom line: last prompt (left) + token/cost stats (right).
 * Returns an array of rendered strings; empty array means nothing to render.
 */
export function renderBottomLine(
  width: number,
  rawPrompt: string,
  usage: UsageTotals,
  theme: ThemeLike,
  rightLine?: string | null,
): string[] {
  const statsLine = rightLine ?? renderStatsLine(usage, theme);
  const statsW = statsLine ? visibleWidth(statsLine) : 0;

  function rightAlignStats(): string[] {
    if (!statsLine) return [];
    const fittedStats = statsW > width ? truncateToWidth(statsLine, width, "") : statsLine;
    const fittedStatsW = visibleWidth(fittedStats);
    const pad = " ".repeat(Math.max(0, width - fittedStatsW - 1));
    return [pad + fittedStats];
  }

  // No prompt — just right-align stats.
  if (!rawPrompt) return rightAlignStats();

  // No stats — just display prompt, truncated to fit.
  if (!statsLine) {
    const promptLine = renderPromptPart(rawPrompt, width, theme);
    return promptLine ? [promptLine] : [];
  }

  // Both prompt and stats — reserve a stable gap and only keep the prompt when
  // enough text can survive truncation to remain useful.
  const maxPromptW = width - statsW - MIN_PROMPT_STATS_GAP;
  const promptLine = renderPromptPart(
    rawPrompt,
    Math.max(1, maxPromptW),
    theme,
    MIN_PROMPT_TEXT_WIDTH_WITH_STATS,
  );
  if (!promptLine) return rightAlignStats();

  const promptW = visibleWidth(promptLine);
  const gap = Math.max(MIN_PROMPT_STATS_GAP, width - promptW - statsW);
  const line = promptLine + " ".repeat(gap) + statsLine;

  // Final safety: cost/stats are the point of the right side, so drop the
  // prompt before dropping stats.
  if (visibleWidth(line) > width) return rightAlignStats();
  return [line];
}
