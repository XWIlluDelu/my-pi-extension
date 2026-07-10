import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type { SegmentContext, StatusLineSegment, ThemeLike } from "./types.ts";
import { applyColor, rainbow, rainbowFlow, resolveColor, thinkingColor } from "./theme.ts";
import { formatDuration, formatDurationCoarse } from "./time.ts";

// ── Nerd Font icons with ASCII fallback ──
// Codepoints from pi-powerline-footer, except model (nf-md-creation).

function hasNerd(): boolean {
  if (process.env.POWERLINE_NERD_FONTS === "1") return true;
  if (process.env.POWERLINE_NERD_FONTS === "0") return false;
  if (process.env.GHOSTTY_RESOURCES_DIR) return true;
  const term = (process.env.TERM_PROGRAM || "").toLowerCase();
  return ["iterm", "wezterm", "kitty", "ghostty", "alacritty"].some(t => term.includes(t));
}

const nerd = hasNerd();

const icons = {
  model:   nerd ? "\u{F0674}" : "M",    // nf-md-creation
  folder:  nerd ? "\uF115" : "dir",     // nf-fa-folder_open
  branch:  nerd ? "\uF126" : "\u2387",  // nf-fa-code_fork / ⎇
  context: nerd ? "\uF200" : "%",       // nf-fa-pie-chart
  time:    nerd ? "\uF017" : "\u29D7",  // nf-fa-clock_o / \u29D7
};

// Thinking level short labels (matching pi-powerline-footer)
const thinkingLabel: Record<string, string> = {
  off:     "off",
  minimal: "min",
  low:     "low",
  medium:  "med",
  high:    "high",
  xhigh:   "xhigh",
  max:     "max",
};

function contextColorName(pct: number): string {
  if (pct >= 90) return "contextError";
  if (pct >= 70) return "contextWarn";
  return "context";
}

function formatContextWindow(contextWindow: number): string {
  return contextWindow >= 1_000_000
    ? (contextWindow / 1_000_000).toFixed(1) + "M"
    : contextWindow >= 1_000
      ? (contextWindow / 1_000).toFixed(1) + "k"
      : String(contextWindow);
}

// ── Extension status ordering ──
// One concept lives here: turn the raw extension-status map into the ordered,
// filtered, joined string shown in the statuses segment. Callers (index.ts render
// signature, tests) cross the same seam via orderedExtensionStatuses.

// pi-fast-mode publishes its ⚡ under this key; it leads the status list.
const FAST_STATUS_KEY = "fast";
const EXTENSION_STATUS_SEPARATOR = "· ";

const PRIORITY_STATUS_KEYS = [FAST_STATUS_KEY] as const;
const PRIORITY_STATUS_INDEX = new Map<string, number>(
  PRIORITY_STATUS_KEYS.map((key, index) => [key, index]),
);

function visibleStatusText(value: string | undefined): string | null {
  const text = value?.trim() ?? "";
  if (!text || text.startsWith("[")) return null;
  return text;
}

export function orderedExtensionStatuses(
  statuses: ReadonlyMap<string, string> | null | undefined,
): string[] {
  if (!statuses || statuses.size === 0) return [];

  const priority = new Array<string | null>(PRIORITY_STATUS_KEYS.length).fill(null);
  const rest: string[] = [];

  for (const [key, value] of statuses) {
    const text = visibleStatusText(value);
    if (!text) continue;

    const index = PRIORITY_STATUS_INDEX.get(key);
    if (index === undefined) rest.push(text);
    else priority[index] = text;
  }

  return [...priority.filter((text): text is string => text !== null), ...rest];
}

export function formatExtensionStatuses(statuses: readonly string[]): string | null {
  return statuses.length > 0 ? statuses.join(EXTENSION_STATUS_SEPARATOR) : null;
}

// ── Segment renderers ──

const modelEffort: StatusLineSegment = {
  id: "model-effort",
  render(ctx, theme) {
    const label = thinkingLabel[ctx.thinkingLevel] ?? ctx.thinkingLevel;
    const text = `${icons.model} ${ctx.modelName} ${label}`;

    if (ctx.thinkingLevel === "max") return rainbowFlow(text);
    if (ctx.thinkingLevel === "xhigh") return rainbow(text);
    const color = resolveColor(thinkingColor(ctx.thinkingLevel));
    return applyColor(theme, color, text);
  },
};

// Session names are user-typed and unbounded; cap their footprint (in display
// columns) so a long name degrades itself instead of evicting the segments
// rendered after it. sliceByColumn rather than truncateToWidth: the latter
// injects an ANSI reset that would knock the ellipsis out of the segment color.
const SESSION_NAME_MAX_WIDTH = 24;

function clipSessionName(name: string): string {
  if (visibleWidth(name) <= SESSION_NAME_MAX_WIDTH) return name;
  return sliceByColumn(name, 0, SESSION_NAME_MAX_WIDTH - 1, true) + "…";
}

const folder: StatusLineSegment = {
  id: "folder",
  render(ctx, theme) {
    const color = resolveColor("folder");
    // Session name rides in the folder slot, pi's native footer convention.
    const text = ctx.sessionName ? `${ctx.folder} • ${clipSessionName(ctx.sessionName)}` : ctx.folder;
    return applyColor(theme, color, `${icons.folder} ${text}`);
  },
};

const git: StatusLineSegment = {
  id: "git",
  render(ctx, theme) {
    if (!ctx.gitBranch) return null;
    const st = ctx.gitStatus;
    const dirty = st.staged > 0 || st.unstaged > 0 || st.untracked > 0;
    const branchColor = dirty ? resolveColor("gitDirty") : resolveColor("gitClean");

    let seg = applyColor(theme, branchColor, `${icons.branch} ${ctx.gitBranch}`);

    const parts: string[] = [];
    if (st.unstaged > 0) parts.push(applyColor(theme, "warning", `*${st.unstaged}`));
    if (st.staged > 0) parts.push(applyColor(theme, "success", `+${st.staged}`));
    if (st.untracked > 0) parts.push(applyColor(theme, "muted", `?${st.untracked}`));
    if (parts.length > 0) seg += " " + parts.join(" ");

    return seg;
  },
};

const context: StatusLineSegment = {
  id: "context",
  render(ctx, theme) {
    if (!ctx.contextWindow || ctx.contextWindow <= 0) return null;
    const ccolor = resolveColor(ctx.contextPct === null ? "tokens" : contextColorName(ctx.contextPct));
    const pctStr = ctx.contextPct === null ? "?" : ctx.contextPct.toFixed(1) + "%";
    const text = `${pctStr}/${formatContextWindow(ctx.contextWindow)}`;
    return `${icons.context} ${applyColor(theme, ccolor, text)}`;
  },
};

const time: StatusLineSegment = {
  id: "time",
  render(ctx, theme) {
    if (!ctx.time) return null;
    const { turnMs, sessionMs, running } = ctx.time;
    if (!running && turnMs === 0 && sessionMs === 0) return null;
    const color = resolveColor(running ? "timeActive" : "time");
    const text = `${formatDuration(turnMs)} / ${formatDurationCoarse(sessionMs)}`;
    return `${icons.time} ${applyColor(theme, color, text)}`;
  },
};

const statuses: StatusLineSegment = {
  id: "statuses",
  render(ctx, _theme) {
    return formatExtensionStatuses(orderedExtensionStatuses(ctx.statuses));
  },
};

// ── Registry: segment id → renderer ──

export const SEGMENTS: Record<string, StatusLineSegment> = {
  "model-effort": modelEffort,
  folder,
  git,
  context,
  time,
  statuses,
};

// ── Preset: segment order ──

export const PRESET = [
  "model-effort",
  "folder",
  "git",
  "context",
  "time",
  "statuses",
] as const;
