import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Buffer } from "node:buffer";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  estimateOpenAIUsageCost,
  type OpenAIUsageCostEstimate,
} from "./openai-cost.ts";
import { isRecord } from "./util.ts";

const AGENT_DIR = getAgentDir();
const AUTH_PATH = join(AGENT_DIR, "auth.json");
const AUTH_KEY = "openai-codex";
const CACHE_DIR = join(AGENT_DIR, "pi-footer");
const CACHE_PATH = join(CACHE_DIR, "openai-usage-cache.json");
const COST_CACHE_PATH = join(CACHE_DIR, "openai-cost-cache.json");
const REFRESH_LOCK_PATH = join(CACHE_DIR, "openai-usage-refresh.lock");
const CACHE_VERSION = 4;
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_MS = 60 * 60_000;
const RETRY_MS = REFRESH_MS;
const DISK_RECHECK_MS = 10_000;
const FETCH_TIMEOUT_MS = 10_000;
const COST_SCAN_TIMEOUT_MS = 15_000;
const REFRESH_LOCK_STALE_MS = FETCH_TIMEOUT_MS + COST_SCAN_TIMEOUT_MS + 30_000;

let openAISessionRoot = join(AGENT_DIR, "sessions");

export function setOpenAIUsageSessionRoot(sessionRoot: string, usesDefaultSessionDir: boolean): void {
  openAISessionRoot = usesDefaultSessionDir ? join(AGENT_DIR, "sessions") : sessionRoot;
}

export interface OpenAIUsageWindow {
  label: string;
  usedPercent: number;
  leftPercent: number;
  resetSeconds: number | null;
  resetAt: number | null;
  windowSeconds: number | null;
}

export interface OpenAIUsageSnapshot {
  limited: boolean;
  windows: OpenAIUsageWindow[];
}

export interface OpenAIUsageDisplay {
  text: string;
  limited: boolean;
}

interface OpenAIUsageCache {
  version: typeof CACHE_VERSION;
  accountId: string;
  attemptedAt: number;
  fetchedAt: number;
  snapshot: OpenAIUsageSnapshot | null;
  costEstimate: OpenAIUsageCostEstimate | null;
  estimateSessionRoot: string | null;
}

let refreshPromise: Promise<OpenAIUsageDisplay | null> | null = null;
let refreshAccountId: string | null = null;

// In-memory mirror of the disk cache, which is shared by every pi process.
// While the snapshot is fresh, access is served from memory so footer
// rendering never blocks on synchronous file I/O. Once it goes stale the disk
// is re-read (throttled to DISK_RECHECK_MS) so a refresh done by another
// process is adopted instead of re-fetched: fetchedAt/attemptedAt on disk are
// what keep N processes at one upstream request per REFRESH_MS window. Writes
// go write-through: memory first, then disk.
let memCache: OpenAIUsageCache | null = null;
let memCacheLoaded = false;
let lastDiskReadAt = 0;

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function jwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - payload.length % 4) % 4);
    const decoded = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return isRecord(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function accountIdFromAuth(auth: Record<string, unknown>, access: string): string | null {
  if (typeof auth.accountId === "string" && auth.accountId) return auth.accountId;
  if (typeof auth.account_id === "string" && auth.account_id) return auth.account_id;

  const payload = jwtPayload(access);
  const nested = payload?.["https://api.openai.com/auth"];
  if (isRecord(nested) && typeof nested.chatgpt_account_id === "string") return nested.chatgpt_account_id;
  return null;
}

function readOpenAIAuth(): { access: string; accountId: string } | null {
  try {
    const root = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
    if (!isRecord(root)) return null;
    const auth = root[AUTH_KEY];
    if (!isRecord(auth) || typeof auth.access !== "string" || !auth.access) return null;
    const accountId = accountIdFromAuth(auth, auth.access);
    if (!accountId) return null;
    return { access: auth.access, accountId };
  } catch {
    return null;
  }
}

function validWindow(value: unknown): value is OpenAIUsageWindow {
  if (!isRecord(value)) return false;
  return typeof value.label === "string" &&
    typeof value.usedPercent === "number" &&
    typeof value.leftPercent === "number" &&
    (typeof value.resetSeconds === "number" || value.resetSeconds === null) &&
    (typeof value.resetAt === "number" || value.resetAt === null) &&
    (typeof value.windowSeconds === "number" || value.windowSeconds === null);
}

function validSnapshot(value: unknown): value is OpenAIUsageSnapshot {
  if (!isRecord(value)) return false;
  return typeof value.limited === "boolean" &&
    Array.isArray(value.windows) &&
    value.windows.length > 0 &&
    value.windows.every(validWindow);
}

function validCostEstimate(value: unknown): value is OpenAIUsageCostEstimate {
  if (!isRecord(value)) return false;
  return typeof value.windowLabel === "string" &&
    typeof value.usedPercent === "number" &&
    typeof value.usedCost === "number" &&
    typeof value.estimatedLeftCost === "number" &&
    typeof value.resetAt === "number";
}

function readCacheFromDisk(): OpenAIUsageCache | null {
  try {
    const value = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    if (!isRecord(value) || value.version !== CACHE_VERSION || typeof value.accountId !== "string") return null;
    const attemptedAt = numberField(value.attemptedAt) ?? 0;
    const fetchedAt = numberField(value.fetchedAt) ?? 0;
    const snapshot = validSnapshot(value.snapshot) ? value.snapshot : null;
    const costEstimate = validCostEstimate(value.costEstimate) ? value.costEstimate : null;
    const estimateSessionRoot = typeof value.estimateSessionRoot === "string" ? value.estimateSessionRoot : null;
    return {
      version: CACHE_VERSION,
      accountId: value.accountId,
      attemptedAt,
      fetchedAt: snapshot ? fetchedAt : 0,
      snapshot,
      costEstimate,
      estimateSessionRoot,
    };
  } catch {
    return null;
  }
}

function resetDeadline(snapshot: OpenAIUsageSnapshot, fetchedAt: number): number | null {
  const deadlines = snapshot.windows.flatMap((window) => {
    if (typeof window.resetAt === "number" && Number.isFinite(window.resetAt)) return [window.resetAt * 1000];
    if (typeof window.resetSeconds === "number" && Number.isFinite(window.resetSeconds)) {
      return [fetchedAt + Math.max(0, window.resetSeconds) * 1000];
    }
    return [];
  });
  return deadlines.length > 0 ? Math.min(...deadlines) : null;
}

export function openAIUsageSnapshotActive(snapshot: OpenAIUsageSnapshot, fetchedAt: number, now: number): boolean {
  const deadline = resetDeadline(snapshot, fetchedAt);
  return deadline === null || now < deadline;
}

function snapshotFresh(cache: OpenAIUsageCache | null, now: number): boolean {
  return !!cache?.snapshot &&
    now - cache.fetchedAt <= REFRESH_MS &&
    openAIUsageSnapshotActive(cache.snapshot, cache.fetchedAt, now);
}

function readCache(now: number): OpenAIUsageCache | null {
  if (!memCacheLoaded || (!snapshotFresh(memCache, now) && now - lastDiskReadAt >= DISK_RECHECK_MS)) {
    memCache = readCacheFromDisk();
    memCacheLoaded = true;
    lastDiskReadAt = now;
  }
  return memCache;
}

function writeCache(cache: OpenAIUsageCache): void {
  memCache = cache;
  memCacheLoaded = true;
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    const tmp = `${CACHE_PATH}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, CACHE_PATH);
  } catch {
    // Cache writes are best-effort. Never break footer rendering for disk I/O.
  }
}

function adoptDiskCache(now: number): OpenAIUsageCache | null {
  const cache = readCacheFromDisk();
  if (cache) {
    memCache = cache;
    memCacheLoaded = true;
    lastDiskReadAt = now;
  }
  return cache;
}

type RefreshLockResult =
  | { state: "acquired"; release: () => void }
  | { state: "busy" | "unavailable" };

interface RefreshLockRecord {
  token: string;
  pid: number;
  createdAt: number;
}

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

function readRefreshLock(): { raw: string; record: RefreshLockRecord | null } | null {
  try {
    const raw = readFileSync(REFRESH_LOCK_PATH, "utf8");
    const value = JSON.parse(raw);
    const record = isRecord(value) &&
      typeof value.token === "string" &&
      typeof value.pid === "number" &&
      typeof value.createdAt === "number"
      ? { token: value.token, pid: value.pid, createdAt: value.createdAt }
      : null;
    return { raw, record };
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function acquireRefreshLock(now: number): RefreshLockResult {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
  } catch {
    return { state: "unavailable" };
  }

  const acquire = (): RefreshLockResult => {
    const record: RefreshLockRecord = { token: randomUUID(), pid: process.pid, createdAt: Date.now() };
    let fd: number;
    try {
      fd = openSync(REFRESH_LOCK_PATH, "wx", 0o600);
    } catch (error) {
      return { state: errorCode(error) === "EEXIST" ? "busy" : "unavailable" };
    }

    try {
      writeFileSync(fd, JSON.stringify(record) + "\n");
    } catch {
      try { unlinkSync(REFRESH_LOCK_PATH); } catch { /* best effort */ }
      return { state: "unavailable" };
    } finally {
      closeSync(fd);
    }

    return {
      state: "acquired",
      release: () => {
        try {
          if (readRefreshLock()?.record?.token === record.token) unlinkSync(REFRESH_LOCK_PATH);
        } catch {
          // A stale-lock recovery may already have removed this owner's file.
        }
      },
    };
  };

  const initial = acquire();
  if (initial.state !== "busy") return initial;

  try {
    const observed = readRefreshLock();
    const age = observed?.record ? now - observed.record.createdAt : now - statSync(REFRESH_LOCK_PATH).mtimeMs;
    if (age <= REFRESH_LOCK_STALE_MS) return initial;
    if (observed?.record && processIsAlive(observed.record.pid)) return initial;
    if (observed && readRefreshLock()?.raw !== observed.raw) return initial;
    unlinkSync(REFRESH_LOCK_PATH);
  } catch {
    return initial;
  }
  return acquire();
}

function cacheForAccount(cache: OpenAIUsageCache | null, accountId: string): OpenAIUsageCache | null {
  return cache?.accountId === accountId ? cache : null;
}

function markAttempt(now: number, accountId: string, cache: OpenAIUsageCache | null): void {
  writeCache({
    version: CACHE_VERSION,
    accountId,
    attemptedAt: now,
    fetchedAt: cache?.fetchedAt ?? 0,
    snapshot: cache?.snapshot ?? null,
    costEstimate: cache?.costEstimate ?? null,
    estimateSessionRoot: cache?.estimateSessionRoot ?? null,
  });
}

function windowLabel(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "limit";
  const hour = 3600;
  const day = 24 * hour;
  if (Math.abs(seconds - 5 * hour) <= 10 * 60) return "5h";
  if (Math.abs(seconds - 7 * day) <= hour) return "7d";
  if (seconds % day === 0) return `${Math.round(seconds / day)}d`;
  if (seconds % hour === 0) return `${Math.round(seconds / hour)}h`;
  if (seconds >= day) return `${Math.round(seconds / day)}d`;
  return `${Math.round(seconds / hour)}h`;
}

export function formatResetDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const totalMinutes = Math.max(0, Math.floor(seconds / 60));
  if (totalMinutes <= 0) return seconds > 0 ? "1m" : "0m";
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

function parseUsageWindow(raw: unknown): OpenAIUsageWindow | null {
  if (!isRecord(raw)) return null;
  const used = numberField(raw.used_percent);
  if (used === null) return null;

  const windowSeconds = numberField(raw.limit_window_seconds);
  const resetAfter = numberField(raw.reset_after_seconds);
  const resetAt = numberField(raw.reset_at);
  const resetSeconds = resetAfter ?? (resetAt === null ? null : resetAt - Date.now() / 1000);

  return {
    label: windowLabel(windowSeconds),
    usedPercent: clampPercent(used),
    leftPercent: clampPercent(100 - used),
    resetSeconds,
    resetAt,
    windowSeconds,
  };
}

function resetText(windows: OpenAIUsageWindow[]): string | null {
  const parts = windows.map((window) => formatResetDuration(window.resetSeconds)).filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join("/") : null;
}

function snapshotAfterElapsed(snapshot: OpenAIUsageSnapshot, elapsedSeconds: number): OpenAIUsageSnapshot {
  if (elapsedSeconds <= 0) return snapshot;
  return {
    limited: snapshot.limited,
    windows: snapshot.windows.map((window) => ({
      ...window,
      resetSeconds: window.resetSeconds === null ? null : Math.max(0, window.resetSeconds - elapsedSeconds),
    })),
  };
}

function percentText(windows: OpenAIUsageWindow[]): string | null {
  if (windows.length === 0) return null;
  return windows.map((window) => `${window.leftPercent}%`).join("/");
}

function compactDollars(value: number): string {
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}k`;
  return `$${value.toFixed(value < 10 ? 2 : 1)}`;
}

function estimateText(estimate: OpenAIUsageCostEstimate): string {
  return `Rem. ${compactDollars(estimate.estimatedLeftCost)}`;
}

function displayFromCache(cache: OpenAIUsageCache | null, now: number): OpenAIUsageDisplay | null {
  if (!cache?.snapshot || cache.fetchedAt <= 0) return null;
  if (!openAIUsageSnapshotActive(cache.snapshot, cache.fetchedAt, now)) return null;
  const estimate = cache.costEstimate &&
    cache.estimateSessionRoot === openAISessionRoot &&
    now < cache.costEstimate.resetAt
    ? cache.costEstimate
    : null;
  return formatOpenAIUsageSnapshot(cache.snapshot, (now - cache.fetchedAt) / 1000, estimate);
}

function shouldRefresh(cache: OpenAIUsageCache | null, now: number, force: boolean): boolean {
  if (force) return true;
  if (snapshotFresh(cache, now)) return false;
  if (cache?.snapshot) {
    const deadline = resetDeadline(cache.snapshot, cache.fetchedAt);
    if (deadline !== null && now >= deadline && cache.attemptedAt < deadline) return true;
  }
  return now - (cache?.attemptedAt ?? 0) > RETRY_MS;
}

export function openAIUsageSnapshotFromResponse(value: unknown): OpenAIUsageSnapshot | null {
  if (!isRecord(value)) return null;
  const rawRateLimit = value.rate_limit;
  if (!isRecord(rawRateLimit)) return null;

  const windows = [
    parseUsageWindow(rawRateLimit.primary_window),
    parseUsageWindow(rawRateLimit.secondary_window),
  ].filter((window): window is OpenAIUsageWindow => window !== null);
  if (windows.length === 0) return null;

  const reachedType = value.rate_limit_reached_type;
  const hasReachedType = typeof reachedType === "string" && reachedType.trim() !== "";
  const limited = hasReachedType || rawRateLimit.limit_reached === true || rawRateLimit.allowed === false;

  return { limited, windows };
}

export function formatOpenAIUsageSnapshot(
  snapshot: OpenAIUsageSnapshot,
  elapsedSeconds = 0,
  costEstimate: OpenAIUsageCostEstimate | null = null,
): OpenAIUsageDisplay | null {
  const current = snapshotAfterElapsed(snapshot, elapsedSeconds);
  const windows = current.windows;
  if (windows.length === 0) return null;

  const reset = resetText(windows);
  if (current.limited) {
    const exhausted = windows.filter((window) => window.leftPercent <= 0);
    if (exhausted.length === 1) {
      const wait = formatResetDuration(exhausted[0].resetSeconds);
      return { text: `limited ${exhausted[0].label}${wait ? ` ↺ ${wait}` : ""}`, limited: true };
    }
    const wait = resetText(exhausted.length > 1 ? exhausted : windows);
    return { text: `limited${wait ? ` ↺ ${wait}` : ""}`, limited: true };
  }

  const percent = percentText(windows);
  if (!percent) return null;
  const estimate = costEstimate ? ` ${estimateText(costEstimate)}` : "";
  return { text: reset ? `${percent} ↺ ${reset}${estimate}` : `${percent}${estimate}`, limited: false };
}

async function fetchOpenAIUsageSnapshot(
  auth: { access: string; accountId: string },
): Promise<OpenAIUsageSnapshot | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${auth.access}`,
        "chatgpt-account-id": auth.accountId,
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return openAIUsageSnapshotFromResponse(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function getOpenAIUsageDisplay(): OpenAIUsageDisplay | null {
  const auth = readOpenAIAuth();
  if (!auth) return null;
  const now = Date.now();
  const cache = cacheForAccount(readCache(now), auth.accountId);
  if (shouldRefresh(cache, now, false)) void refreshOpenAIUsage();
  return displayFromCache(cache, now);
}

async function estimateOpenAIUsageCostWithTimeout(
  snapshot: OpenAIUsageSnapshot,
  fetchedAt: number,
  accountId: string,
): Promise<OpenAIUsageCostEstimate | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COST_SCAN_TIMEOUT_MS);
  try {
    return await estimateOpenAIUsageCost(snapshot, fetchedAt, {
      sessionRoot: openAISessionRoot,
      costCachePath: COST_CACHE_PATH,
      scopeKey: accountId,
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function refreshOpenAIUsage(force = false): Promise<OpenAIUsageDisplay | null> {
  const auth = readOpenAIAuth();
  if (!auth) return Promise.resolve(null);

  const now = Date.now();
  const cache = cacheForAccount(readCache(now), auth.accountId);
  if (refreshPromise) {
    return refreshAccountId === auth.accountId ? refreshPromise : Promise.resolve(null);
  }
  if (!shouldRefresh(cache, now, force)) return Promise.resolve(displayFromCache(cache, now));

  const refreshLock = acquireRefreshLock(now);
  if (refreshLock.state === "busy") {
    const adopted = cacheForAccount(adoptDiskCache(now), auth.accountId) ?? cache;
    return Promise.resolve(displayFromCache(adopted, now));
  }
  const releaseLock = refreshLock.state === "acquired" ? refreshLock.release : () => {};

  markAttempt(now, auth.accountId, cache);
  refreshAccountId = auth.accountId;
  refreshPromise = fetchOpenAIUsageSnapshot(auth)
    .then(async (snapshot) => {
      const finishedAt = Date.now();
      if (!snapshot) {
        const adopted = cacheForAccount(adoptDiskCache(finishedAt), auth.accountId) ?? cache;
        return displayFromCache(adopted, finishedAt);
      }

      const officialCache: OpenAIUsageCache = {
        version: CACHE_VERSION,
        accountId: auth.accountId,
        attemptedAt: finishedAt,
        fetchedAt: finishedAt,
        snapshot,
        costEstimate: null,
        estimateSessionRoot: null,
      };
      writeCache(officialCache);

      const costEstimate = await estimateOpenAIUsageCostWithTimeout(snapshot, finishedAt, auth.accountId);
      if (!costEstimate) return displayFromCache(officialCache, Date.now());

      const disk = readCacheFromDisk();
      if (disk && (disk.accountId !== auth.accountId || disk.fetchedAt !== finishedAt)) {
        memCache = disk;
        memCacheLoaded = true;
        lastDiskReadAt = Date.now();
        return cacheForAccount(disk, auth.accountId) ? displayFromCache(disk, Date.now()) : null;
      }

      const estimatedCache = { ...(disk ?? officialCache), costEstimate, estimateSessionRoot: openAISessionRoot };
      writeCache(estimatedCache);
      return displayFromCache(estimatedCache, Date.now());
    })
    .finally(() => {
      releaseLock();
      refreshPromise = null;
      refreshAccountId = null;
    });
  return refreshPromise;
}
