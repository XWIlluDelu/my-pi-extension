import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Buffer } from "node:buffer";
import { isRecord } from "./util.ts";

const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");
const AUTH_KEY = "openai-codex";
const CACHE_PATH = join(homedir(), ".pi", "agent", "pi-footer", "openai-usage-cache.json");
const CACHE_VERSION = 1;
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_MS = 15 * 60_000;
const RETRY_MS = 2 * 60_000;
const DISK_RECHECK_MS = 10_000;
const FETCH_TIMEOUT_MS = 10_000;

export interface OpenAIUsageWindow {
  label: string;
  usedPercent: number;
  leftPercent: number;
  resetSeconds: number | null;
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
  attemptedAt: number;
  fetchedAt: number;
  snapshot: OpenAIUsageSnapshot | null;
}

let lastAttemptAt = 0;
let refreshPromise: Promise<OpenAIUsageDisplay | null> | null = null;

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
    (typeof value.windowSeconds === "number" || value.windowSeconds === null);
}

function validSnapshot(value: unknown): value is OpenAIUsageSnapshot {
  if (!isRecord(value)) return false;
  return typeof value.limited === "boolean" &&
    Array.isArray(value.windows) &&
    value.windows.length > 0 &&
    value.windows.every(validWindow);
}

function readCacheFromDisk(): OpenAIUsageCache | null {
  try {
    const value = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    if (!isRecord(value) || value.version !== CACHE_VERSION) return null;
    const attemptedAt = numberField(value.attemptedAt) ?? 0;
    const fetchedAt = numberField(value.fetchedAt) ?? 0;
    const snapshot = validSnapshot(value.snapshot) ? value.snapshot : null;
    return { version: CACHE_VERSION, attemptedAt, fetchedAt: snapshot ? fetchedAt : 0, snapshot };
  } catch {
    return null;
  }
}

function snapshotFresh(cache: OpenAIUsageCache | null, now: number): boolean {
  return !!cache?.snapshot && now - cache.fetchedAt <= REFRESH_MS;
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

function markAttempt(now: number): void {
  lastAttemptAt = now;
  const cache = readCache(now);
  writeCache({
    version: CACHE_VERSION,
    attemptedAt: now,
    fetchedAt: cache?.fetchedAt ?? 0,
    snapshot: cache?.snapshot ?? null,
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

function displayFromCache(cache: OpenAIUsageCache | null, now: number): OpenAIUsageDisplay | null {
  if (!cache?.snapshot || cache.fetchedAt <= 0) return null;
  return formatOpenAIUsageSnapshot(cache.snapshot, (now - cache.fetchedAt) / 1000);
}

function shouldRefresh(cache: OpenAIUsageCache | null, now: number, force: boolean): boolean {
  if (force) return true;
  if (snapshotFresh(cache, now)) return false;
  return now - Math.max(lastAttemptAt, cache?.attemptedAt ?? 0) > RETRY_MS;
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

export function formatOpenAIUsageSnapshot(snapshot: OpenAIUsageSnapshot, elapsedSeconds = 0): OpenAIUsageDisplay | null {
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
  return { text: reset ? `${percent} ↺ ${reset}` : percent, limited: false };
}

async function fetchOpenAIUsageSnapshot(): Promise<OpenAIUsageSnapshot | null> {
  const auth = readOpenAIAuth();
  if (!auth) return null;

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
  const now = Date.now();
  const cache = readCache(now);
  if (shouldRefresh(cache, now, false)) void refreshOpenAIUsage();
  return displayFromCache(cache, now);
}

export function refreshOpenAIUsage(force = false): Promise<OpenAIUsageDisplay | null> {
  const now = Date.now();
  const cache = readCache(now);
  if (refreshPromise) return refreshPromise;
  if (!shouldRefresh(cache, now, force)) return Promise.resolve(displayFromCache(cache, now));

  markAttempt(now);
  refreshPromise = fetchOpenAIUsageSnapshot()
    .then((snapshot) => {
      const finishedAt = Date.now();
      if (!snapshot) return displayFromCache(readCache(finishedAt), finishedAt) ?? displayFromCache(cache, finishedAt);
      const nextCache: OpenAIUsageCache = {
        version: CACHE_VERSION,
        attemptedAt: finishedAt,
        fetchedAt: finishedAt,
        snapshot,
      };
      writeCache(nextCache);
      return displayFromCache(nextCache, finishedAt);
    })
    .finally(() => { refreshPromise = null; });
  return refreshPromise;
}
