# pi-fast-mode

Pi extension that toggles OpenAI Codex **fast mode** — it adds `service_tier=priority` to provider requests for eligible Codex models, trading cost for lower latency.

When on and the selected model is eligible, a `⚡` status appears and every provider request carries `service_tier: "priority"`. On any other model the toggle stays armed but inactive (nothing is injected) until you switch to an eligible one.

Eligible models (`openai-codex` provider): `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`.

## Command and flag

| Trigger | Effect |
|---|---|
| `/fast` | Toggle fast mode on/off |
| `--fast` | Start the session with fast mode on |

## State

The on/off choice persists to `~/.pi/agent/pi-fast-mode.json` (or `$PI_CODING_AGENT_DIR/pi-fast-mode.json`), so it survives restarts. Safe to delete; it defaults to off.

## Linking

Linked into Pi from:

```text
~/.pi/agent/extensions/pi-fast-mode -> ~/.pi/custom-extensions/pi-fast-mode
```

## Acknowledgments

`pi-fast-mode` reproduces the fast-mode architecture of two open-source Pi extensions without depending on either:

- **[pi-better-openai](https://github.com/mattleong/pi-better-openai)** (MIT) — the design this extension follows: a `/fast` toggle plus `--fast` flag instead of a separate provider, `service_tier: "priority"` injected through `before_provider_request`, the `⚡` status, and persistence of the on/off choice.
- **[pi-openai-codex-fast](https://github.com/2h2d-co/pi-openai-codex-fast)** (MIT) — confirmation that Codex "fast" is `service_tier: "priority"` on the responses endpoint, and the source of the eligible-models allow-list (`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`). This extension replaces that package's per-model fast provider with a single toggle, so the model list is not doubled.

Both projects are licensed under the MIT License.
