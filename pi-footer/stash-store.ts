import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { isRecord } from "./util.ts";

// Editor stash history, persisted in the shared pi-footer config.json. Kept in a
// node-only module (no pi imports) so the read-modify-write is unit-testable.

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-footer", "config.json");
const STASH_HISTORY_LIMIT = 12;

function readConfigFile(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeConfigFile(config: Record<string, unknown>): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

function loadStashHistory(): string[] {
  const history = readConfigFile().stashHistory;
  return isStringArray(history)
    ? history.filter((s) => s.trim().length > 0).slice(0, STASH_HISTORY_LIMIT)
    : [];
}

let stashHistory = loadStashHistory();

export function getStashHistory(): string[] {
  return [...stashHistory];
}

export function pushStashHistory(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed || stashHistory[0] === trimmed) return [...stashHistory];
  stashHistory = [trimmed, ...stashHistory.filter((s) => s !== trimmed)];
  if (stashHistory.length > STASH_HISTORY_LIMIT) stashHistory.length = STASH_HISTORY_LIMIT;
  const config = readConfigFile();
  config.stashHistory = stashHistory;
  writeConfigFile(config);
  return [...stashHistory];
}
