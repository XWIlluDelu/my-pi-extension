import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// stash-store.ts reads CONFIG_PATH at module load via homedir(). To test the
// read-modify-write without touching the user's real config, we point HOME at a
// temp dir before importing the module. Node strips types on import, so we use
// dynamic import after setting env.

const sandbox = join(tmpdir(), `pi-footer-stash-test-${process.pid}-${Date.now()}`);
const agentDir = join(sandbox, ".pi", "agent", "pi-footer");
mkdirSync(agentDir, { recursive: true });

const originalHome = process.env.HOME;
process.env.HOME = sandbox;
try {
  // A pre-existing unrelated key must survive every stash write.
  writeFileSync(join(agentDir, "config.json"), JSON.stringify({ keep: "me" }) + "\n");

  const { getStashHistory, pushStashHistory } = await import("../stash-store.ts");

  assert.deepEqual(getStashHistory(), []);

  // pushStashHistory writes through to config.json and is visible on re-read.
  pushStashHistory("first prompt");
  assert.deepEqual(getStashHistory(), ["first prompt"]);

  // The most recent entry always wins; duplicates are deduped, not appended.
  pushStashHistory("second prompt");
  pushStashHistory("second prompt");
  assert.deepEqual(getStashHistory(), ["second prompt", "first prompt"]);

  // Re-pushing an older entry promotes it to the front.
  pushStashHistory("first prompt");
  assert.deepEqual(getStashHistory(), ["first prompt", "second prompt"]);

  // The unrelated key coexists with stashHistory in the same file, and every
  // stash write preserves it (read-modify-write, not overwrite).
  const onDisk = JSON.parse(readFileSync(join(agentDir, "config.json"), "utf8"));
  assert.deepEqual(onDisk.stashHistory, ["first prompt", "second prompt"]);
  assert.equal(onDisk.keep, "me");

  // Sanity: the file lives inside the pi-footer subdirectory, not the agent root.
  assert.ok(existsSync(join(agentDir, "config.json")), "config.json should live in ~/.pi/agent/pi-footer/");
  assert.ok(!existsSync(join(sandbox, ".pi", "agent", "pi-footer.json")), "no stray config in the agent root");

  console.log("stash history tests passed");
} finally {
  process.env.HOME = originalHome;
  rmSync(sandbox, { recursive: true, force: true });
}
