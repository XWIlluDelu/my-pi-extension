import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";

// ── Render freeze ──
// Terminal-native mouse selection cannot survive streaming redraws: rows at
// and below the streaming tail are rewritten in place, and the editor's
// buffer rows migrate on every scroll, so a selection anchored there drifts
// into the output or keeps growing. Freezing the renderer makes the whole
// screen static: select and copy anything with the mouse, then any key (or
// the toggle) resumes. Streaming continues in memory while frozen; resuming
// repaints through one ordinary incremental diff, so nothing is lost.

const FREEZE_KEY = "ctrl+alt+f";

// Delay between the freeze notification and suppressing renders so the
// notification itself still paints (the TUI coalesces renders at ~16ms).
const PATCH_DELAY_MS = 80;

let tuiRef: any = null;
let unsubscribeInput: (() => void) | null = null;
let frozen = false;
let patched = false;
let generation = 0;

// Own properties shadow the TUI prototype methods; delete restores them.
// requestRender must be no-oped as well as doRender: requestRender(force)
// mutates renderer state (previousLines/width) even when no paint happens,
// which would force a scrollback-clearing full redraw on resume.
function applyPatch(): void {
  if (patched || !tuiRef) return;
  patched = true;
  tuiRef.requestRender = () => {};
  tuiRef.doRender = () => {};
}

function removePatch(): void {
  if (!patched) return;
  patched = false;
  if (!tuiRef) return;
  delete tuiRef.requestRender;
  delete tuiRef.doRender;
}

function freeze(ctx: any): void {
  if (frozen || !tuiRef) return;
  frozen = true;
  const gen = ++generation;
  ctx.ui.notify(`Rendering frozen for selection — any key or ${FREEZE_KEY} resumes`, "info");
  const timer = setTimeout(() => {
    if (frozen && gen === generation) applyPatch();
  }, PATCH_DELAY_MS);
  (timer as any).unref?.();
}

function unfreeze(repaint = true): void {
  if (!frozen) return;
  frozen = false;
  generation++;
  removePatch();
  if (repaint) tuiRef?.requestRender?.();
}

function toggle(ctx: any): void {
  if (frozen) unfreeze();
  else freeze(ctx);
}

function watchInput(tui: any): void {
  unsubscribeInput?.();
  unsubscribeInput =
    tui.addInputListener?.((data: string) => {
      if (!frozen) return undefined;
      // Ignore key releases (kitty protocol reports them) and the toggle
      // chord itself, which the shortcut handler turns into an unfreeze.
      if (isKeyRelease(data) || matchesKey(data, FREEZE_KEY)) return undefined;
      unfreeze();
      return undefined;
    }) ?? null;
}

export default function freezeRender(pi: ExtensionAPI) {
  pi.registerCommand("freeze", {
    description: "Toggle render freeze (stable text selection while streaming)",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) toggle(ctx);
    },
  });

  pi.registerShortcut(FREEZE_KEY, {
    description: "Freeze/resume rendering for stable text selection",
    handler: (ctx) => {
      if (ctx.hasUI) toggle(ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    unfreeze(false);
    // Invisible widget solely to obtain the TUI instance.
    ctx.ui.setWidget(
      "pi-freeze",
      (tui: any) => {
        tuiRef = tui;
        watchInput(tui);
        return { render: () => [] };
      },
      { placement: "belowEditor" },
    );
  });

  pi.on("session_shutdown", () => {
    unfreeze(false);
    unsubscribeInput?.();
    unsubscribeInput = null;
    tuiRef = null;
  });
}
