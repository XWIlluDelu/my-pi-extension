// ── Specialised color values (hex or a single ThemeColor) ──
export type ColorValue = string; // hex #rrggbb | Pi theme color name

// ── Colour resolution interface ──
export interface ThemeLike {
  fg(color: string, text: string): string;
}

// ── Git status ──
export interface GitStatus {
  staged: number;
  unstaged: number;
  untracked: number;
}

// ── Turn/session timing shown in the powerline ──
export interface TurnTimeStats {
  turnMs: number;
  sessionMs: number;
  running: boolean;
}

// ── Typed context passed to every segment ──
export interface SegmentContext {
  modelName: string;
  thinkingLevel: string;
  folder: string;
  gitBranch: string | null;
  gitStatus: GitStatus;
  contextPct: number | null;
  contextWindow: number | null;
  statuses: ReadonlyMap<string, string> | null;
  time: TurnTimeStats | null;
}

// ── Segment interface: id + typed render ──
export interface StatusLineSegment {
  id: string;
  render(ctx: SegmentContext, theme: ThemeLike): string | null; // null = hidden
}
