import { createReadStream } from "node:fs";
import { mkdir, opendir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { OpenAIUsageSnapshot, OpenAIUsageWindow } from "./openai-usage.ts";
import { usageCostTotal } from "./usage.ts";
import { isRecord } from "./util.ts";

const COST_CACHE_VERSION = 2;

interface CostContribution {
  key: string;
  timestamp: number;
  cost: number;
}

interface SessionFileCostCache {
  path: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
  contributions: CostContribution[];
}

interface OpenAICostCache {
  version: typeof COST_CACHE_VERSION;
  sessionRoot: string;
  scopeKey: string;
  cycleStartedAt: number;
  resetAt: number;
  files: SessionFileCostCache[];
}

export interface OpenAIUsageCostTotals {
  cost: number;
  messages: number;
}

export interface OpenAIUsageCostEstimate {
  windowLabel: string;
  usedPercent: number;
  usedCost: number;
  estimatedLeftCost: number;
  resetAt: number;
}

export interface OpenAICostScanOptions {
  sessionRoot: string;
  costCachePath?: string;
  scopeKey?: string;
  resetAt?: number;
  signal?: AbortSignal;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error ? signal.reason : new Error("OpenAI cost scan aborted");
  error.name = "AbortError";
  throw error;
}

function timestampMs(entry: Record<string, unknown>, message: Record<string, unknown>): number | null {
  if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) return message.timestamp;
  if (typeof entry.timestamp !== "string") return null;
  const parsed = Date.parse(entry.timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

async function* sessionFiles(root: string, signal?: AbortSignal): AsyncGenerator<string> {
  throwIfAborted(signal);
  let directory;
  try {
    directory = await opendir(root);
  } catch {
    return;
  }

  for await (const entry of directory) {
    throwIfAborted(signal);
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* sessionFiles(path, signal);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      yield path;
    }
  }
}

function messageKey(entry: Record<string, unknown>, message: Record<string, unknown>, timestamp: number): string {
  if (typeof message.responseId === "string" && message.responseId) return `response:${message.responseId}`;
  const id = typeof entry.id === "string" ? entry.id : "";
  const model = typeof message.model === "string" ? message.model : "";
  return `entry:${id}|${timestamp}|${model}`;
}

function validContribution(value: unknown): value is CostContribution {
  return isRecord(value) &&
    typeof value.key === "string" &&
    typeof value.timestamp === "number" &&
    Number.isFinite(value.timestamp) &&
    typeof value.cost === "number" &&
    Number.isFinite(value.cost) &&
    value.cost > 0;
}

function validFileCache(value: unknown): value is SessionFileCostCache {
  return isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.size === "number" &&
    typeof value.mtimeMs === "number" &&
    typeof value.ctimeMs === "number" &&
    typeof value.dev === "number" &&
    typeof value.ino === "number" &&
    Array.isArray(value.contributions) &&
    value.contributions.every(validContribution);
}

async function readCostCache(path: string | undefined): Promise<OpenAICostCache | null> {
  if (!path) return null;
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value) || value.version !== COST_CACHE_VERSION) return null;
    if (typeof value.sessionRoot !== "string" || typeof value.scopeKey !== "string") return null;
    if (typeof value.cycleStartedAt !== "number" || typeof value.resetAt !== "number") return null;
    if (!Array.isArray(value.files) || !value.files.every(validFileCache)) return null;
    return {
      version: COST_CACHE_VERSION,
      sessionRoot: value.sessionRoot,
      scopeKey: value.scopeKey,
      cycleStartedAt: value.cycleStartedAt,
      resetAt: value.resetAt,
      files: value.files,
    };
  } catch {
    return null;
  }
}

async function writeCostCache(path: string | undefined, cache: OpenAICostCache): Promise<void> {
  if (!path) return;
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(cache) + "\n", { mode: 0o600 });
    await rename(tmp, path);
  } catch {
    // The estimate is optional. Cache failures must not affect official usage.
  }
}

async function parseSessionFile(
  path: string,
  startedAt: number,
  signal?: AbortSignal,
): Promise<CostContribution[]> {
  const contributions: CostContribution[] = [];
  const stream = createReadStream(path, { encoding: "utf8", signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      throwIfAborted(signal);
      // Most session lines are large tool results. Avoid parsing them unless
      // they could be an OpenAI Codex assistant response.
      if (!line.includes('"openai-codex"') || !line.includes('"assistant"')) continue;

      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
      const message = entry.message;
      if (message.role !== "assistant" || message.provider !== "openai-codex") continue;
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;

      const timestamp = timestampMs(entry, message);
      if (timestamp === null || timestamp < startedAt) continue;
      const cost = usageCostTotal(message.usage);
      if (cost <= 0) continue;
      contributions.push({ key: messageKey(entry, message, timestamp), timestamp, cost });
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return contributions;
}

function cacheMatchesCycle(
  cache: OpenAICostCache | null,
  sessionRoot: string,
  scopeKey: string,
  cycleStartedAt: number,
  resetAt: number,
): cache is OpenAICostCache {
  return !!cache &&
    cache.sessionRoot === sessionRoot &&
    cache.scopeKey === scopeKey &&
    Math.abs(cache.cycleStartedAt - cycleStartedAt) < 1000 &&
    Math.abs(cache.resetAt - resetAt) < 1000;
}

export async function sumOpenAICodexSessionCost(
  startedAt: number,
  endedAt: number,
  options: OpenAICostScanOptions,
): Promise<OpenAIUsageCostTotals> {
  const { sessionRoot, costCachePath, signal } = options;
  const scopeKey = options.scopeKey ?? "";
  const resetAt = options.resetAt ?? endedAt;
  const diskCache = await readCostCache(costCachePath);
  const previousFiles = new Map<string, SessionFileCostCache>();
  if (cacheMatchesCycle(diskCache, sessionRoot, scopeKey, startedAt, resetAt)) {
    for (const file of diskCache.files) previousFiles.set(file.path, file);
  }

  const files: SessionFileCostCache[] = [];
  for await (const path of sessionFiles(sessionRoot, signal)) {
    throwIfAborted(signal);
    try {
      const file = await stat(path);
      if (file.mtimeMs < startedAt) continue;

      const previous = previousFiles.get(path);
      if (previous &&
        previous.size === file.size &&
        previous.mtimeMs === file.mtimeMs &&
        previous.ctimeMs === file.ctimeMs &&
        previous.dev === file.dev &&
        previous.ino === file.ino) {
        files.push(previous);
        continue;
      }

      files.push({
        path,
        size: file.size,
        mtimeMs: file.mtimeMs,
        ctimeMs: file.ctimeMs,
        dev: file.dev,
        ino: file.ino,
        contributions: await parseSessionFile(path, startedAt, signal),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      // One unreadable or concurrently replaced session must not suppress the
      // official quota display or the other files' estimate.
    }
  }

  const seen = new Set<string>();
  let cost = 0;
  let messages = 0;
  for (const file of files) {
    for (const contribution of file.contributions) {
      if (contribution.timestamp > endedAt || seen.has(contribution.key)) continue;
      seen.add(contribution.key);
      cost += contribution.cost;
      messages++;
    }
  }

  throwIfAborted(signal);
  await writeCostCache(costCachePath, {
    version: COST_CACHE_VERSION,
    sessionRoot,
    scopeKey,
    cycleStartedAt: startedAt,
    resetAt,
    files,
  });
  return { cost, messages };
}

function estimationWindow(snapshot: OpenAIUsageSnapshot): OpenAIUsageWindow | null {
  let selected: OpenAIUsageWindow | null = null;
  for (const window of snapshot.windows) {
    if (!window.windowSeconds || window.windowSeconds <= 0) continue;
    if (window.resetAt === null && window.resetSeconds === null) continue;
    if (!selected || window.windowSeconds > (selected.windowSeconds ?? 0)) selected = window;
  }
  return selected;
}

function resetAtMs(window: OpenAIUsageWindow, fetchedAt: number): number {
  if (typeof window.resetAt === "number" && Number.isFinite(window.resetAt)) return window.resetAt * 1000;
  return fetchedAt + Math.max(0, window.resetSeconds ?? 0) * 1000;
}

export function costEstimateFromTotals(
  snapshot: OpenAIUsageSnapshot,
  fetchedAt: number,
  totals: OpenAIUsageCostTotals,
): OpenAIUsageCostEstimate | null {
  const window = estimationWindow(snapshot);
  if (!window || window.usedPercent <= 0 || totals.cost <= 0) return null;

  const resetAt = resetAtMs(window, fetchedAt);
  const estimatedLeftCost = totals.cost * window.leftPercent / window.usedPercent;
  if (!Number.isFinite(estimatedLeftCost)) return null;

  return {
    windowLabel: window.label,
    usedPercent: window.usedPercent,
    usedCost: totals.cost,
    estimatedLeftCost,
    resetAt,
  };
}

export async function estimateOpenAIUsageCost(
  snapshot: OpenAIUsageSnapshot,
  fetchedAt: number,
  options: Omit<OpenAICostScanOptions, "resetAt">,
): Promise<OpenAIUsageCostEstimate | null> {
  const window = estimationWindow(snapshot);
  if (!window || window.usedPercent <= 0) return null;

  const resetAt = resetAtMs(window, fetchedAt);
  const cycleStartedAt = resetAt - (window.windowSeconds ?? 0) * 1000;
  const totals = await sumOpenAICodexSessionCost(cycleStartedAt, fetchedAt, { ...options, resetAt });
  return costEstimateFromTotals(snapshot, fetchedAt, totals);
}
