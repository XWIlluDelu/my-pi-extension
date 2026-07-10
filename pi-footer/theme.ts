import type { ThemeLike, ColorValue } from "./types.ts";

// ── Rainbow palette ──
// First and last entries match so the gradient wraps seamlessly. Starts at
// gold rather than the reference's purple: the first stop lands on the model
// icon, and purple blended into the theme's accent color.
const RAINBOW = ["#febc38", "#e4c00f", "#89d281", "#00afaf", "#178fb9", "#b281d6", "#d787af", "#febc38"];

// ── Default semantic colors ──
const DEFAULTS: Record<string, ColorValue> = {
  folder:         "#00afaf",
  thinkingOff:    "thinkingOff",
  thinkingMinimal:"thinkingMinimal",
  thinkingLow:    "thinkingLow",
  thinkingMedium: "thinkingMedium",
  thinkingHigh:   "thinkingHigh",
  gitClean:       "success",
  gitDirty:       "warning",
  context:        "success",   // <70%
  contextWarn:    "warning",   // 70–90%
  contextError:   "error",     // >90%
  tokens:         "muted",
  time:           "muted",     // idle: last turn duration
  timeActive:     "#febc38",   // running: live turn duration
  separator:      "dim",
};

// ── Hex → ANSI ──
function hexToAnsi(hex: string): string {
  const h = hex.replace("#", "");
  return `\x1b[38;2;${parseInt(h.slice(0, 2), 16)};${parseInt(h.slice(2, 4), 16)};${parseInt(h.slice(4, 6), 16)}m`;
}

// Apply a single color value to text
export function applyColor(theme: ThemeLike, color: ColorValue, text: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return `${hexToAnsi(color)}${text}\x1b[0m`;
  return theme.fg(color, text);
}

// Resolve a semantic name to its concrete colour value, falling back to the
// theme's default foreground for names not in the table.
export function resolveColor(semantic: string): ColorValue {
  return DEFAULTS[semantic] ?? "text";
}

// Thinking level → colour value for the plain levels; xhigh (rainbow) and
// max (rainbowBadge) are styled directly by the model-effort segment.
export function thinkingColor(level: string): ColorValue {
  switch (level) {
    case "off":     return "thinkingOff";
    case "minimal": return "thinkingMinimal";
    case "low":     return "thinkingLow";
    case "medium":  return "thinkingMedium";
    case "high":    return "thinkingHigh";
    default:        return "thinkingOff";
  }
}

// Rainbow gradient for xhigh thinking level
export function rainbow(text: string): string {
  let result = "";
  let ci = 0;
  for (const ch of text) {
    if (ch === " " || ch === ":" || ch === "/") { result += ch; }
    else { result += hexToAnsi(RAINBOW[ci % RAINBOW.length]) + ch; ci++; }
  }
  return result + "\x1b[0m";
}

// Flowing rainbow for max thinking level: the same gradient as xhigh, bold,
// sliding through the text. The gradient is sampled at SUBSTEPS interpolated
// stops per palette color; the phase advances one stop per frame while chars
// step SUBSTEPS apart, so the pattern drifts a third of a character per frame.
// The phase is derived from the clock — index.ts only forces repaints.
export const FLOW_FRAME_MS = 100;
const SUBSTEPS = 3;

function lerpChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

// RAINBOW's first and last entries match, giving 7 seamless gradient segments.
const FLOW_STOPS: string[] = [];
for (let k = 0; k < RAINBOW.length - 1; k++) {
  const from = RAINBOW[k].slice(1), to = RAINBOW[k + 1].slice(1);
  for (let s = 0; s < SUBSTEPS; s++) {
    const t = s / SUBSTEPS;
    const [r, g, b] = [0, 2, 4].map((o) =>
      lerpChannel(parseInt(from.slice(o, o + 2), 16), parseInt(to.slice(o, o + 2), 16), t));
    FLOW_STOPS.push(`\x1b[38;2;${r};${g};${b}m`);
  }
}

export function rainbowFlow(text: string, now = Date.now()): string {
  const phase = Math.floor(now / FLOW_FRAME_MS) % FLOW_STOPS.length;
  let result = "\x1b[1m";
  let ci = 0;
  for (const ch of text) {
    if (ch === " " || ch === ":" || ch === "/") { result += ch; }
    else {
      const idx = ((ci * SUBSTEPS - phase) % FLOW_STOPS.length + FLOW_STOPS.length) % FLOW_STOPS.length;
      result += FLOW_STOPS[idx] + ch;
      ci++;
    }
  }
  return result + "\x1b[0m";
}
