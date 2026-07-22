import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  costEstimateFromTotals,
  sumOpenAICodexSessionCost,
} from "../openai-cost.ts";

const root = await mkdtemp(join(tmpdir(), "pi-footer-cost-"));
try {
  const nested = join(root, "project", "child");
  await mkdir(nested, { recursive: true });

  const entry = (id, timestamp, overrides = {}) => JSON.stringify({
    type: "message",
    id,
    timestamp: new Date(timestamp).toISOString(),
    message: {
      role: "assistant",
      provider: "openai-codex",
      model: "gpt-test",
      stopReason: "stop",
      timestamp,
      responseId: `response-${id}`,
      usage: { cost: { total: 1 } },
      ...overrides,
    },
  });

  await writeFile(join(root, "one.jsonl"), [
    entry("before", 900, { usage: { cost: { total: 20 } } }),
    entry("one", 1100, { responseId: "shared", usage: { cost: { total: 2 } } }),
    entry("error", 1300, { stopReason: "error", usage: { cost: { total: 20 } } }),
    entry("other", 1400, { provider: "anthropic", usage: { cost: { total: 20 } } }),
    "not json",
  ].join("\n") + "\n");

  await writeFile(join(nested, "two.jsonl"), [
    entry("duplicate", 1100, { responseId: "shared", usage: { cost: { total: 2 } } }),
    entry("two", 1200, { responseId: undefined, usage: { cost: { total: 1.5 } } }),
    entry("aborted", 1500, { stopReason: "aborted", usage: { cost: { total: 20 } } }),
    entry("after", 2100, { usage: { cost: { total: 20 } } }),
  ].join("\n") + "\n");

  const costCachePath = join(root, "cost-cache.json");
  const scanOptions = { sessionRoot: root, costCachePath, resetAt: 502_000 };
  const totals = await sumOpenAICodexSessionCost(1000, 2000, scanOptions);
  assert.deepEqual(totals, { cost: 3.5, messages: 2 });
  const costCache = JSON.parse(await readFile(costCachePath, "utf8"));
  assert.equal(costCache.files.length, 2);

  const twoPath = join(nested, "two.jsonl");
  await appendFile(twoPath, entry("three", 1250, {
    usage: { cost: { total: 0.5 } },
  }) + "\n");
  await utimes(twoPath, 2, 2);
  assert.deepEqual(await sumOpenAICodexSessionCost(1000, 2000, scanOptions), {
    cost: 4,
    messages: 3,
  });

  const beforeRewrite = await stat(twoPath);
  const replacementPath = `${twoPath}.replacement`;
  const replacement = (await readFile(twoPath, "utf8")).replace('"total":1.5', '"total":9.5');
  await writeFile(replacementPath, replacement);
  await utimes(replacementPath, 2, 2);
  await rename(replacementPath, twoPath);
  const afterRewrite = await stat(twoPath);
  assert.equal(afterRewrite.size, beforeRewrite.size);
  assert.equal(afterRewrite.mtimeMs, beforeRewrite.mtimeMs);
  assert.notEqual(afterRewrite.ino, beforeRewrite.ino);
  assert.deepEqual(await sumOpenAICodexSessionCost(1000, 2000, scanOptions), {
    cost: 12,
    messages: 3,
  });

  const snapshot = {
    limited: false,
    windows: [{
      label: "7d",
      usedPercent: 25,
      leftPercent: 75,
      resetSeconds: 500,
      resetAt: null,
      windowSeconds: 1000,
    }],
  };
  assert.deepEqual(costEstimateFromTotals(snapshot, 2000, totals), {
    windowLabel: "7d",
    usedPercent: 25,
    usedCost: 3.5,
    estimatedLeftCost: 10.5,
    resetAt: 502000,
  });
  assert.equal(costEstimateFromTotals({
    ...snapshot,
    windows: [{ ...snapshot.windows[0], usedPercent: 0, leftPercent: 100 }],
  }, 2000, totals), null);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("openai cost tests passed");
