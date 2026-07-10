import { isRecord } from "./util.ts";

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UsageTotals extends TokenCounts {
  cost: number;
}

export interface ContextStats {
  tokens: number | null;
  window: number | null;
  percent: number | null;
}

export const ZERO_TOKENS: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
export const ZERO_USAGE_TOTALS: UsageTotals = { ...ZERO_TOKENS, cost: 0 };

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function tokenField(v: unknown): number {
  const n = finiteNumber(v);
  return n && n > 0 ? n : 0;
}

function costField(v: unknown): number {
  const n = finiteNumber(v);
  return n !== undefined && n > 0 ? n : 0;
}

function positiveWindow(v: unknown): number | null {
  const n = finiteNumber(v);
  return n && n > 0 ? n : null;
}

export function tokenCountsFromUsage(usage: unknown): TokenCounts {
  if (!isRecord(usage)) return { ...ZERO_TOKENS };
  return {
    input: tokenField(usage.input),
    output: tokenField(usage.output),
    cacheRead: tokenField(usage.cacheRead),
    cacheWrite: tokenField(usage.cacheWrite),
  };
}

export function usageCostTotal(usage: unknown): number {
  if (!isRecord(usage)) return 0;
  if (typeof usage.cost === "number") return costField(usage.cost);
  if (!isRecord(usage.cost)) return 0;
  const explicitTotal = costField(usage.cost.total);
  if (explicitTotal > 0) return explicitTotal;
  return (
    costField(usage.cost.input) +
    costField(usage.cost.output) +
    costField(usage.cost.cacheRead) +
    costField(usage.cost.cacheWrite)
  );
}

export function usageTotalsFromUsage(usage: unknown): UsageTotals {
  return { ...tokenCountsFromUsage(usage), cost: usageCostTotal(usage) };
}

export function usageTokenTotal(usage: unknown): number {
  if (!isRecord(usage)) return 0;
  const explicitTotal = tokenField(usage.totalTokens);
  if (explicitTotal > 0) return explicitTotal;
  const counts = tokenCountsFromUsage(usage);
  return counts.input + counts.output + counts.cacheRead + counts.cacheWrite;
}

export function addTokenCounts(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

export function addUsageTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    ...addTokenCounts(a, b),
    cost: a.cost + b.cost,
  };
}

export function sumAssistantUsage(entries: readonly unknown[]): UsageTotals {
  let total = { ...ZERO_USAGE_TOTALS };
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "assistant") continue;
    if (message.stopReason === "error" || message.stopReason === "aborted") continue;
    total = addUsageTotals(total, usageTotalsFromUsage(message.usage));
  }
  return total;
}

function usageContextStats(usage: unknown, contextWindow: number | null): ContextStats | undefined {
  const tokens = usageTokenTotal(usage);
  if (tokens <= 0 || !contextWindow) return undefined;
  return { tokens, window: contextWindow, percent: (tokens / contextWindow) * 100 };
}

export function contextStatsFromContext(ctx: any, liveUsage: unknown, fallbackUsage: unknown): ContextStats {
  const modelWindow = positiveWindow(ctx?.model?.contextWindow);
  let official: unknown;
  try {
    official = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
  } catch {
    official = undefined;
  }

  const officialRecord = isRecord(official) ? official : undefined;
  const contextWindow = positiveWindow(officialRecord?.contextWindow) ?? modelWindow;

  const live = usageContextStats(liveUsage, contextWindow);
  if (live) return live;

  if (officialRecord && contextWindow) {
    const tokens = finiteNumber(officialRecord.tokens) ?? null;
    const officialPercent = finiteNumber(officialRecord.percent);
    if (tokens !== null || officialPercent !== undefined) {
      const percent = officialPercent ?? (tokens === null ? null : (tokens / contextWindow) * 100);
      return { tokens, window: contextWindow, percent };
    }

    const fallback = usageContextStats(fallbackUsage, contextWindow);
    if (fallback) return fallback;
    return { tokens: null, window: contextWindow, percent: null };
  }

  const fallback = usageContextStats(fallbackUsage, contextWindow);
  if (fallback) return fallback;

  return { tokens: null, window: contextWindow, percent: null };
}
