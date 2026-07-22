import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderBottomLine } from "../bottom-line.ts";
import { formatExtensionStatuses, orderedExtensionStatuses } from "../segments.ts";
import {
  formatOpenAIUsageSnapshot,
  openAIUsageSnapshotActive,
  openAIUsageSnapshotFromResponse,
} from "../openai-usage.ts";
import {
  addTokenCounts,
  addUsageTotals,
  contextStatsFromContext,
  sumAssistantUsage,
  tokenCountsFromUsage,
  usageCostTotal,
  usageTokenTotal,
  usageTotalsFromUsage,
  ZERO_TOKENS,
  ZERO_USAGE_TOTALS,
} from "../usage.ts";

const usage = (overrides = {}) => ({
  input: 100,
  output: 20,
  cacheRead: 30,
  cacheWrite: 5,
  totalTokens: 155,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.123 },
  ...overrides,
});

assert.deepEqual(tokenCountsFromUsage(usage()), {
  input: 100,
  output: 20,
  cacheRead: 30,
  cacheWrite: 5,
});
assert.equal(usageCostTotal(usage()), 0.123);
assert.ok(Math.abs(usageCostTotal(usage({ cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0 } })) - 0.037) < 1e-12);
assert.deepEqual(usageTotalsFromUsage(usage()), {
  input: 100,
  output: 20,
  cacheRead: 30,
  cacheWrite: 5,
  cost: 0.123,
});
assert.equal(usageTokenTotal(usage()), 155);
assert.equal(usageTokenTotal(usage({ totalTokens: 0 })), 155);
assert.deepEqual(addTokenCounts(ZERO_TOKENS, tokenCountsFromUsage(usage())), {
  input: 100,
  output: 20,
  cacheRead: 30,
  cacheWrite: 5,
});
assert.deepEqual(addUsageTotals(ZERO_USAGE_TOTALS, usageTotalsFromUsage(usage())), {
  input: 100,
  output: 20,
  cacheRead: 30,
  cacheWrite: 5,
  cost: 0.123,
});

const branch = [
  { type: "message", message: { role: "assistant", stopReason: "stop", usage: usage() } },
  { type: "message", message: { role: "assistant", stopReason: "toolUse", usage: usage({ input: 10, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 19, cost: { total: 0.5 } }) } },
  { type: "message", message: { role: "assistant", stopReason: "error", usage: usage({ input: 999, cost: { total: 99 } }) } },
  { type: "message", message: { role: "user", content: "ignored" } },
];
assert.deepEqual(sumAssistantUsage(branch), {
  input: 110,
  output: 22,
  cacheRead: 33,
  cacheWrite: 9,
  cost: 0.623,
});

const knownCtx = {
  model: { contextWindow: 2000 },
  getContextUsage: () => ({ tokens: 400, contextWindow: 2000, percent: 20 }),
};
assert.deepEqual(contextStatsFromContext(knownCtx, undefined, undefined), {
  tokens: 400,
  window: 2000,
  percent: 20,
});

const liveCtx = {
  model: { contextWindow: 2000 },
  getContextUsage: () => ({ tokens: 300, contextWindow: 2000, percent: 15 }),
};
assert.deepEqual(contextStatsFromContext(liveCtx, usage({ totalTokens: 500 }), undefined), {
  tokens: 500,
  window: 2000,
  percent: 25,
});

const compactedCtx = {
  model: { contextWindow: 2000 },
  getContextUsage: () => ({ tokens: null, contextWindow: 2000, percent: null }),
};
assert.deepEqual(contextStatsFromContext(compactedCtx, undefined, undefined), {
  tokens: null,
  window: 2000,
  percent: null,
});
assert.deepEqual(contextStatsFromContext(compactedCtx, usage({ totalTokens: 600 }), undefined), {
  tokens: 600,
  window: 2000,
  percent: 30,
});
assert.deepEqual(contextStatsFromContext(compactedCtx, undefined, usage({ totalTokens: 500 })), {
  tokens: 500,
  window: 2000,
  percent: 25,
});
assert.deepEqual(contextStatsFromContext({ model: { contextWindow: 4000 } }, undefined, usage({ totalTokens: 1000 })), {
  tokens: 1000,
  window: 4000,
  percent: 25,
});

const rawStatuses = new Map([
  ["pi-diet", "diet: on"],
  ["fast", " ⚡ "],
  ["debug", "[debug hidden]"],
  ["blank", "   "],
  ["other", "jobs: 2"],
]);
assert.deepEqual(orderedExtensionStatuses(rawStatuses), ["⚡", "diet: on", "jobs: 2"]);
assert.equal(formatExtensionStatuses(orderedExtensionStatuses(rawStatuses)), "⚡· diet: on· jobs: 2");
assert.equal(formatExtensionStatuses([]), null);

const plainTheme = { fg: (_color, text) => text };
const footerUsage = {
  input: 1_400_000,
  output: 23_200,
  cacheRead: 7_800_000,
  cacheWrite: 0,
  cost: 9.221,
};
const statsOnly = renderBottomLine(80, "", footerUsage, plainTheme);
assert.equal(statsOnly.length, 1);
assert.match(statsOnly[0], /↑1\.4M ↓23\.2k R7\.8M \$9\.221$/);
assert.ok(visibleWidth(statsOnly[0]) <= 80);

const prompt = "Implement the pi-footer billing migration and keep enough prompt room after compression";
const promptAndStats = renderBottomLine(80, prompt, footerUsage, plainTheme);
assert.equal(promptAndStats.length, 1);
assert.ok(visibleWidth(promptAndStats[0]) <= 80);
assert.match(promptAndStats[0], /↳ Implement/);
assert.match(promptAndStats[0], /\$9\.221$/);
const statsStart = promptAndStats[0].indexOf("↑1.4M");
assert.ok(statsStart > 0);
assert.match(promptAndStats[0].slice(0, statsStart), / {18,}$/);

const narrowPromptAndStats = renderBottomLine(36, prompt, footerUsage, plainTheme);
assert.equal(narrowPromptAndStats.length, 1);
assert.ok(visibleWidth(narrowPromptAndStats[0]) <= 36);
assert.doesNotMatch(narrowPromptAndStats[0], /↳/);
assert.match(narrowPromptAndStats[0], /\$9\.221$/);

const quotaStats = renderBottomLine(80, prompt, footerUsage, plainTheme, "69%/81% ↺ 1h43m/5d22h");
assert.equal(quotaStats.length, 1);
assert.ok(visibleWidth(quotaStats[0]) <= 80);
assert.match(quotaStats[0], /69%\/81% ↺ 1h43m\/5d22h$/);
assert.doesNotMatch(quotaStats[0], /\$9\.221$/);

function usageResponse({ allowed = true, limit_reached = false, primaryUsed = 31, secondaryUsed = 19 } = {}) {
  return {
    rate_limit_reached_type: null,
    rate_limit: {
      allowed,
      limit_reached,
      primary_window: {
        used_percent: primaryUsed,
        limit_window_seconds: 18_000,
        reset_after_seconds: 6_184,
      },
      secondary_window: {
        used_percent: secondaryUsed,
        limit_window_seconds: 604_800,
        reset_after_seconds: 513_891,
      },
    },
  };
}

assert.deepEqual(formatOpenAIUsageSnapshot(openAIUsageSnapshotFromResponse(usageResponse())), {
  text: "69%/81% ↺ 1h43m/5d22h",
  limited: false,
});
assert.deepEqual(formatOpenAIUsageSnapshot(openAIUsageSnapshotFromResponse(usageResponse({ allowed: false, limit_reached: true, primaryUsed: 100 }))), {
  text: "limited 5h ↺ 1h43m",
  limited: true,
});
assert.deepEqual(formatOpenAIUsageSnapshot(openAIUsageSnapshotFromResponse(usageResponse({ allowed: false, limit_reached: true, secondaryUsed: 100 }))), {
  text: "limited 7d ↺ 5d22h",
  limited: true,
});
assert.deepEqual(formatOpenAIUsageSnapshot(openAIUsageSnapshotFromResponse(usageResponse({ allowed: false, limit_reached: true, primaryUsed: 100, secondaryUsed: 100 }))), {
  text: "limited ↺ 1h43m/5d22h",
  limited: true,
});
assert.deepEqual(formatOpenAIUsageSnapshot(openAIUsageSnapshotFromResponse(usageResponse({ primaryUsed: 100 }))), {
  text: "0%/81% ↺ 1h43m/5d22h",
  limited: false,
});

// The current API can expose the sole weekly window in either slot. The
// dormant 5h parser remains compatible if OpenAI restores that window.
for (const weeklySlot of ["primary_window", "secondary_window"]) {
  const rateLimit = {
    allowed: true,
    limit_reached: false,
    primary_window: null,
    secondary_window: null,
    [weeklySlot]: {
      used_percent: 15,
      limit_window_seconds: 604_800,
      reset_after_seconds: 570_266,
    },
  };
  assert.deepEqual(formatOpenAIUsageSnapshot(openAIUsageSnapshotFromResponse({
    rate_limit_reached_type: null,
    rate_limit: rateLimit,
  })), {
    text: "85% ↺ 6d14h",
    limited: false,
  });
}

const weeklySnapshot = openAIUsageSnapshotFromResponse({
  rate_limit_reached_type: null,
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 15,
      limit_window_seconds: 604_800,
      reset_after_seconds: 570_266,
    },
    secondary_window: null,
  },
});
assert.equal(openAIUsageSnapshotActive(weeklySnapshot, 1_000, 1_000 + 570_265_000), true);
assert.equal(openAIUsageSnapshotActive(weeklySnapshot, 1_000, 1_000 + 570_266_000), false);
assert.deepEqual(formatOpenAIUsageSnapshot(weeklySnapshot, 0, {
  windowLabel: "7d",
  usedPercent: 15,
  usedCost: 21.820896,
  estimatedLeftCost: 123.651744,
  resetAt: 604_800_000,
}), {
  text: "85% ↺ 6d14h Rem. $123.7",
  limited: false,
});
assert.deepEqual(formatOpenAIUsageSnapshot(openAIUsageSnapshotFromResponse(usageResponse()), 0, {
  windowLabel: "7d",
  usedPercent: 19,
  usedCost: 20,
  estimatedLeftCost: 85.263,
  resetAt: 604_800_000,
}), {
  text: "69%/81% ↺ 1h43m/5d22h Rem. $85.3",
  limited: false,
});

console.log("usage tests passed");
