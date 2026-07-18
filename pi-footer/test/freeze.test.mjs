import assert from "node:assert/strict";

// freeze.ts suppresses TUI painting by shadowing requestRender/doRender with
// instance properties and restoring them on resume. The fake TUI mirrors the
// real shape: prototype methods plus addInputListener, so the shadow/delete
// mechanics are exercised exactly as in production.

class FakeTui {
  constructor() {
    this.renders = 0;
    this.listeners = new Set();
  }
  requestRender() {
    this.renders++;
  }
  doRender() {}
  addInputListener(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  input(data) {
    for (const fn of this.listeners) fn(data);
  }
}

const { default: freezeRender } = await import("../freeze.ts");

const commands = new Map();
const shortcuts = new Map();
const events = new Map();
freezeRender({
  registerCommand: (name, def) => commands.set(name, def),
  registerShortcut: (key, def) => shortcuts.set(key, def),
  on: (event, fn) => events.set(event, fn),
});

const tui = new FakeTui();
const notifications = [];
const ctx = {
  hasUI: true,
  ui: {
    notify: (msg) => notifications.push(msg),
    setWidget: (_id, factory) => {
      const widget = factory(tui);
      assert.deepEqual(widget.render(80), [], "the tui-grabbing widget must render nothing");
    },
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toggle = shortcuts.get("ctrl+alt+z").handler;

events.get("session_start")(undefined, ctx);
assert.equal(tui.listeners.size, 1, "input listener registered on session start");

// Freeze: notification fires, and after the paint-grace delay renders are
// swallowed by the instance-level no-ops.
toggle(ctx);
assert.equal(notifications.length, 1);
await sleep(120);
assert.ok(Object.hasOwn(tui, "requestRender") && Object.hasOwn(tui, "doRender"), "patched while frozen");
const rendersWhileFrozen = tui.renders;
tui.requestRender();
tui.requestRender();
assert.equal(tui.renders, rendersWhileFrozen, "renders suppressed while frozen");

// Key releases and the toggle chord itself must not resume.
tui.input("\x1b[97;1:3u"); // kitty release event
tui.input("\x1b[122;7u"); // ctrl+alt+z press (handled by the shortcut, not the listener)
assert.ok(Object.hasOwn(tui, "doRender"), "still frozen after release/toggle-chord input");

// Any other key resumes: patch removed, one catch-up repaint requested.
tui.input("x");
assert.ok(!Object.hasOwn(tui, "requestRender") && !Object.hasOwn(tui, "doRender"), "patch removed on resume");
assert.equal(tui.renders, rendersWhileFrozen + 1, "catch-up render requested on resume");

// Toggling twice: freeze then unfreeze via the shortcut, without input.
toggle(ctx);
await sleep(120);
assert.ok(Object.hasOwn(tui, "doRender"), "frozen again");
toggle(ctx);
assert.ok(!Object.hasOwn(tui, "doRender"), "shortcut toggle resumes");

// A stale patch timer from a cancelled freeze must not fire later.
toggle(ctx);
toggle(ctx); // cancel before PATCH_DELAY_MS elapses
await sleep(120);
assert.ok(!Object.hasOwn(tui, "doRender"), "cancelled freeze leaves no patch behind");

// Shutdown restores everything even when frozen.
toggle(ctx);
await sleep(120);
events.get("session_shutdown")();
assert.ok(!Object.hasOwn(tui, "requestRender") && !Object.hasOwn(tui, "doRender"), "shutdown unpatches");
assert.equal(tui.listeners.size, 0, "shutdown unsubscribes the input listener");

console.log("freeze tests passed");
