# pi-footer

Minimal powerline-style footer for [Pi](https://pi.dev). Shows model, thinking level, folder, git status, context usage, turn/session timing, and extension statuses in a compact line above the editor. Below the editor: the last prompt with rotating token/cost and OpenAI subscription usage stats.

The package ships three independent extensions:

- **pi-footer** (`index.ts`) — the status footer described above.
- **editor-clip** (`editor-clip.ts`) — editor stash + clipboard shortcuts. It mutates the editor, not the status line, so it lives on its own; disable it without touching the footer.
- **freeze** (`freeze.ts`) — render-freeze toggle for stable terminal text selection while the agent is streaming.

## Layout

```
┌─  claude-sonnet-4 med  │  pi  │  main *3 +1  │  12.3%/200k  │  ⧗ 1m23s / 12m  │  ⚡· diet: on ─┐  ← above editor
│                                                                                              │
│  [editor area]                                                                               │
│                                                                                              │
│  ↳ Show me the current status...                       ↑12k ↓3.4k R1.2k W400 $0.123          │  ← below editor
│  ↳ Show me the current status...                       69%/81% ↺ 1h43m/5d22h                 │  ← same right slot, rotated
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Features

- **Powerline above editor**: model + thinking effort, folder basename (joined with the session name while `/name` is set, e.g. `pi • fix-footer`; names are capped at 24 columns with an ellipsis), git branch with staged/unstaged/untracked counts, context-window usage, turn/session timing, extension statuses with pi-fast-mode's ⚡ (`fast` key) first. Segments drop from the right when the terminal is too narrow. The two highest thinking levels get escalating styles: `xhigh` renders as a static rainbow gradient, `max` as the same rainbow in bold, flowing through the text (a 100ms repaint timer that only runs while max is selected).
- **Turn/session timing** (`⧗ turn / session`): the live turn runs from the first `agent_start` to `agent_settled`, so automatic retries, mid-run compaction, and queued follow-ups extend one turn instead of restarting it, and it never inflates across interrupts. The session total (sum of past turns) is reconstructed from the session log's per-turn timestamps, so it survives `/resume` and reload. A turn interrupted and resumed adds its gap to the historical session total only.
- **Last prompt + rotating stats**: alternates every 7 seconds between token/cost totals and OpenAI subscription usage, with ANSI-aware truncation that keeps the stats when the prompt can't fit.
- **Token/cost totals**: input, output, cache-read, cache-write, and Pi's API-equivalent cost with live in-flight usage.
- **OpenAI subscription usage**: when the selected model provider is `openai-codex`, reads the local OAuth entry, fetches ChatGPT usage asynchronously at most every 15 minutes, caches it on disk, and displays remaining 5h/7d quota plus resets, e.g. `69%/81% ↺ 1h43m/5d22h` or `limited ↺ 1h43m/5d22h`.
- **Render coalescing**: repaints are skipped while the visible footer state is unchanged; a single 7s heartbeat rotates the usage line and advances the turn timer between agent events.
- **`/resume` recovery**: last user prompt, cumulative token counts, and session timing are all restored from session history.

## Slash commands

| Command | Description |
|---|---|
| `/openai-usage` | Force-refresh OpenAI subscription usage and write the shared disk cache |
| `/stash-history` | Open the editor stash history picker (editor-clip) |
| `/freeze` | Toggle render freeze (freeze) |

## Keyboard shortcuts (editor-clip)

| Shortcut | Action |
|---|---|
| `Alt+S` | Stash editor text / restore last stash / update stash |
| `Ctrl+Alt+C` | Copy full editor text to clipboard |
| `Ctrl+Alt+X` | Cut full editor text to clipboard (copy then clear) |
| `Ctrl+Alt+H` | Open the editor stash history picker |

`getEditorText` returns the paste-expanded content, so a stashed or copied prompt keeps the real text behind a `[pasted N lines]` marker that a terminal-level copy would lose. Restores paste the text back so large content re-collapses into a marker. Stashed text is restored automatically when the agent finishes and the editor is empty. The last 12 stashed prompts persist across sessions in `config.json`.

## Render freeze (freeze)

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+Z` | Freeze rendering; any other key (or the same chord) resumes |

Terminal-native mouse selection cannot survive streaming redraws: rows at and
below the streaming tail are rewritten in place every newline, and the editor's
buffer rows migrate on every scroll, so a selection anchored there drifts into
the output or keeps growing. `Ctrl+Alt+Z` freezes the renderer so the screen is
fully static — select and copy anything (a part of the input box, mid-stream
output) with the mouse, then press any key to resume. Streaming continues in
memory while frozen; resuming repaints through one ordinary incremental diff,
so no output is lost and the scrollback is preserved. Implementation: the TUI's
`requestRender`/`doRender` are shadowed with instance-level no-ops and restored
on resume (kitty key-release events and the toggle chord itself do not resume).

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `POWERLINE_NERD_FONTS` | auto | Set to `1` to force Nerd Font icons, `0` for ASCII fallback |

## Configuration

State lives under `~/.pi/agent/pi-footer/`:

- `config.json` — editor-clip stash history (last 12 stashed prompts). Written as a single read-modify-write on each change.
- `openai-usage-cache.json` — OpenAI subscription usage cache, shared across concurrent pi processes so at most one of them fetches per 15-minute window (mode 0600, atomic tmp+rename, active only when the provider is `openai-codex`). Safe to delete; it rebuilds on next refresh.

## Architecture

```
pi-footer/
├── index.ts                 — pi-footer extension: event handlers, widgets, render coalescing, heartbeat
├── editor-clip.ts           — editor-clip extension: stash/restore, clipboard, history picker
├── freeze.ts                — freeze extension: render-freeze toggle for stable text selection
├── segments.ts              — powerline segment renderers, Nerd Font icons, extension-status ordering
├── time.ts                  — turn/session timing: active-time clock + log reconstruction + formatters
├── openai-usage.ts          — OpenAI usage fetch, parsing, in-memory + disk cache, compact formatting
├── openai-usage-display.ts  — OpenAI usage line: 7s rotation, codex guard, refresh
├── bottom-line.ts           — pure function: prompt + right-side stats layout with ANSI-aware truncation
├── usage.ts                 — token/cost/context math over session usage
├── git-status.ts            — cached git porcelain status, cwd-aware
├── stash-store.ts           — stash history persistence (config.json read-modify-write)
├── theme.ts                 — color resolution: hex→ANSI, rainbow gradient (xhigh) and clock-phased flow (max), thinking level mapping
├── types.ts                 — shared interfaces: SegmentContext, StatusLineSegment, ThemeLike
├── util.ts                  — shared isRecord guard
└── package.json
```

## Acknowledgments

Both extensions in this package draw architecture and implementation patterns from two open-source Pi extensions:

- **[pi-powerline-footer](https://github.com/nicobailon/pi-powerline-footer)** (MIT) — for **pi-footer**: powerline segment architecture, color system, icon codepoints, last-prompt display, and the `setWidget`/`setFooter` widget approach. For **editor-clip**: the whole editor stash + clipboard + history system is derived from it — the `Alt+S` / `Ctrl+Alt+C` / `Ctrl+Alt+X` / `Ctrl+Alt+H` bindings, the 12-entry persisted stash history with 72-char previews, the paste-expanded (`getExpandedText`-first) read that keeps `[pasted N lines]` content, and the replace/append history-insert flow.
- **[pi-better-openai](https://github.com/mattleong/pi-better-openai)** (MIT) — OpenAI subscription usage endpoint shape, Fast-mode status conventions, and `openai-codex` OAuth/account-id handling. `pi-footer` does not depend on this extension; it owns its own usage cache, request throttle, and footer rendering.

These projects are licensed under the MIT License. Their copyright notices and permission statements are reproduced in [LICENSE](./LICENSE).
