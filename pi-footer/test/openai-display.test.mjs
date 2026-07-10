import assert from "node:assert/strict";
import { OpenAIUsageDisplay, modelUsesOpenAISubscription } from "../openai-usage-display.ts";

const plainTheme = { fg: (_color, text) => text };

// Non-codex model: rightLine and stateText are always empty, refresh is a no-op,
// and getDisplay is never consulted.
{
  let refreshed = 0;
  const od = new OpenAIUsageDisplay({
    getModel: () => ({ provider: "anthropic", id: "claude" }),
    getDisplay: () => { throw new Error("getDisplay must not be called for non-codex"); },
    refreshUsage: () => { refreshed++; return Promise.resolve(null); },
    requestRender: () => {},
    now: () => 0,
  });
  assert.equal(od.rightLine(plainTheme), null);
  assert.equal(od.stateText(), "");
  od.refresh();
  assert.equal(refreshed, 0);
}

// Codex model + snapshot: rightLine/stateText respect the 7s phase rotation, and
// phase 0 never reads the display cache.
{
  const clock = { now: 0 };
  const od = new OpenAIUsageDisplay({
    getModel: () => ({ provider: "openai-codex", id: "gpt-5" }),
    getDisplay: () => {
      if (clock.now < 7_000) throw new Error("getDisplay must not be called in phase 0");
      return { text: "69%/81% ↺ 1h43m/5d22h", limited: false };
    },
    refreshUsage: () => Promise.resolve(null),
    requestRender: () => {},
    now: () => clock.now,
  });
  assert.equal(od.rightLine(plainTheme), null); // phase 0 → hidden
  assert.equal(od.stateText(), "");

  clock.now = 7_000; // phase 1 → shown
  assert.equal(od.rightLine(plainTheme), "69%/81% ↺ 1h43m/5d22h");
  assert.equal(od.stateText(), "ok|69%/81% ↺ 1h43m/5d22h");
}

// Limited display reports "limited" in state text; object-form provider works.
{
  const od = new OpenAIUsageDisplay({
    getModel: () => ({ provider: { id: "openai-codex" }, id: "gpt-5" }),
    getDisplay: () => ({ text: "limited ↺ 1h43m/5d22h", limited: true }),
    refreshUsage: () => Promise.resolve(null),
    requestRender: () => {},
    now: () => 7_000,
  });
  assert.equal(od.rightLine(plainTheme), "limited ↺ 1h43m/5d22h");
  assert.equal(od.stateText(), "limited|limited ↺ 1h43m/5d22h");
}

// refresh requests a render once the async refresh settles.
{
  let rendered = 0;
  const od = new OpenAIUsageDisplay({
    getModel: () => ({ provider: "openai-codex", id: "gpt-5" }),
    getDisplay: () => null,
    refreshUsage: () => Promise.resolve(null),
    requestRender: () => { rendered++; },
    now: () => 7_000,
  });
  od.refresh();
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(rendered > 0, "refresh should request a render on completion");
}

// modelUsesOpenAISubscription: string provider, object provider, and non-codex.
assert.equal(modelUsesOpenAISubscription({ provider: "openai-codex", id: "x" }), true);
assert.equal(modelUsesOpenAISubscription({ provider: { id: "openai-codex" }, id: "x" }), true);
assert.equal(modelUsesOpenAISubscription({ provider: "anthropic", id: "claude" }), false);
assert.equal(modelUsesOpenAISubscription(null), false);
assert.equal(modelUsesOpenAISubscription(undefined), false);

console.log("openai display tests passed");
