import { type ExtensionAPI, copyToClipboard } from "@earendil-works/pi-coding-agent";
import { getStashHistory, pushStashHistory } from "./stash-store.ts";

// ── Editor stash + clipboard ──
// Independent of the footer display: it mutates the editor, not the status line.
// The unique value over the system clipboard is that getEditorText returns the
// paste-expanded content, so a stashed prompt keeps the real text behind a
// [pasted N lines] marker that a terminal-level copy would lose. Restores paste
// the text back so large content re-collapses into a marker.

function getEditorText(ctx: any): string {
  return ctx?.ui?.getEditorText?.() ?? "";
}

// Replace the editor with text, routing through pasteToEditor so large content
// re-collapses into a [pasted N lines] marker instead of flooding the input.
function setEditorContent(ctx: any, text: string): void {
  ctx.ui.setEditorText("");
  ctx.ui.pasteToEditor(text);
}

let stashedEditorText: string | null = null;

function stashOrRestoreEditorText(ctx: any): void {
  const rawText = getEditorText(ctx);
  const hasStash = stashedEditorText !== null;

  if (!rawText.trim()) {
    if (!hasStash) { ctx.ui.notify("Nothing to stash", "info"); return; }
    setEditorContent(ctx, stashedEditorText!);
    stashedEditorText = null;
    ctx.ui.notify("Stash restored", "info");
    return;
  }

  stashedEditorText = rawText;
  pushStashHistory(rawText);
  ctx.ui.setEditorText("");
  ctx.ui.notify(hasStash ? "Stash updated" : "Text stashed", "info");
}

function copyEditorText(ctx: any): void {
  const text = getEditorText(ctx);
  if (!text.trim()) { ctx.ui.notify("Editor is empty", "info"); return; }
  copyToClipboard(text);
  ctx.ui.notify("Copied editor text", "info");
}

function cutEditorText(ctx: any): void {
  const text = getEditorText(ctx);
  if (!text.trim()) { ctx.ui.notify("Editor is empty", "info"); return; }
  copyToClipboard(text);
  ctx.ui.setEditorText("");
  ctx.ui.notify("Cut editor text", "info");
}

async function openStashHistory(ctx: any): Promise<void> {
  const history = getStashHistory();
  if (history.length === 0) { ctx.ui.notify("No stash history yet", "info"); return; }
  const labels = history.map((entry, i) => `#${i + 1} ${entry.replace(/\s+/g, " ").trim().slice(0, 72)}`);
  const selected = await ctx.ui.select("Stash history", labels);
  if (!selected) return;
  const index = labels.indexOf(selected);
  const text = index === -1 ? undefined : history[index];
  if (!text) return;

  if (!getEditorText(ctx).trim()) {
    setEditorContent(ctx, text);
    ctx.ui.notify("Inserted stashed prompt", "info");
    return;
  }
  const action = await ctx.ui.select("Insert prompt", ["Replace", "Append", "Cancel"]);
  if (action === "Replace") {
    setEditorContent(ctx, text);
    ctx.ui.notify("Replaced editor with prompt", "info");
  } else if (action === "Append") {
    const current = getEditorText(ctx);
    ctx.ui.setEditorText("");
    ctx.ui.pasteToEditor(current + (current.endsWith("\n") ? "" : "\n") + text);
    ctx.ui.notify("Appended prompt", "info");
  }
}

export default function editorClip(pi: ExtensionAPI) {
  pi.registerCommand("stash-history", {
    description: "Open the editor stash history picker",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) await openStashHistory(ctx);
    },
  });

  pi.registerShortcut("alt+s", {
    description: "Stash / restore / update editor text",
    handler: (ctx) => { if (ctx.hasUI) stashOrRestoreEditorText(ctx); },
  });

  pi.registerShortcut("ctrl+alt+c", {
    description: "Copy full editor text to clipboard",
    handler: (ctx) => { if (ctx.hasUI) copyEditorText(ctx); },
  });

  pi.registerShortcut("ctrl+alt+x", {
    description: "Cut full editor text to clipboard",
    handler: (ctx) => { if (ctx.hasUI) cutEditorText(ctx); },
  });

  pi.registerShortcut("ctrl+alt+h", {
    description: "Open the editor stash history picker",
    handler: (ctx) => { if (ctx.hasUI) void openStashHistory(ctx); },
  });

  // Auto-restore the stash when the editor is empty after the agent finishes.
  pi.on("agent_end", (_event, ctx) => {
    if (stashedEditorText !== null && ctx.hasUI && getEditorText(ctx).trim() === "") {
      setEditorContent(ctx, stashedEditorText);
      stashedEditorText = null;
      ctx.ui.notify("Stash restored", "info");
    }
  });

  pi.on("session_shutdown", () => {
    stashedEditorText = null;
  });
}
