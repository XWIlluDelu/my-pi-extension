# pi-fast-mode

Pi extension that toggles **fast mode** — it adds `service_tier=priority` to provider requests for models on a user-managed whitelist, trading cost for lower latency.

When fast mode is on and the selected model is whitelisted, a `⚡` status appears and every provider request carries `service_tier: "priority"`. On any other model the toggle stays armed but inactive (nothing is injected) until you switch to a whitelisted one. Both the toggle and whitelist edits take effect on the next request — no restart needed.

The value is injected verbatim into the request body; whitelist a model only if its backend accepts `service_tier: "priority"` (OpenAI-shaped APIs and proxies that pass it through).

## Commands and flag

| Trigger | Effect |
|---|---|
| `/fast` | Toggle fast mode on/off |
| `/fast-models` | Edit the whitelist: pick models from the current registry to toggle, `Done`/Esc to finish |
| `--fast` | Start the session with fast mode on |

## Whitelist and stale entries

`/fast-models` lists every currently available model (`models.json` plus configured auth, refreshed on open) with `[✓]`/`[ ]` markers. A whitelisted model that has since disappeared from the registry — removed from `models.json` or auth revoked — is shown at the bottom marked *gone from models*; select it to remove it. Stale entries are otherwise inert: injection only ever matches the model a request actually uses.

## State

State persists to `~/.pi/agent/pi-fast-mode.json` (or `$PI_CODING_AGENT_DIR/pi-fast-mode.json`) as `{"enabled": bool, "models": [{"provider", "id"}]}`, so it survives restarts. Safe to delete; it defaults to off with an empty whitelist. The pre-0.2 format (`{"enabled"}` only, with a hardcoded `openai-codex` model list) is read transparently; the hardcoded list is gone, so re-add models via `/fast-models`.

## Development

```sh
npm test
```

Pure whitelist/state logic is exported from `index.ts` and tested in `test/whitelist.test.mjs`; `test/wiring.test.mjs` drives the extension through a stub `ExtensionAPI` (commands, picker, injection, persistence).

## Linking

Linked into Pi from:

```text
~/.pi/agent/extensions/pi-fast-mode -> ~/.pi/custom-extensions/pi-fast-mode
```

## Acknowledgments

`pi-fast-mode` reproduces the fast-mode architecture of two open-source Pi extensions without depending on either:

- **[pi-better-openai](https://github.com/mattleong/pi-better-openai)** (MIT) — the design this extension follows: a `/fast` toggle plus `--fast` flag instead of a separate provider, `service_tier: "priority"` injected through `before_provider_request`, the `⚡` status, and persistence of the on/off choice.
- **[pi-openai-codex-fast](https://github.com/2h2d-co/pi-openai-codex-fast)** (MIT) — confirmation that Codex "fast" is `service_tier: "priority"` on the responses endpoint, and the source of the original eligible-models allow-list, since replaced by the user-managed whitelist.

Both projects are licensed under the MIT License.
