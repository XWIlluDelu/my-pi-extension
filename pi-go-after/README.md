# pi-go-after

One-shot, in-session timer for [pi](https://pi.dev): after a delay, send a prompt exactly as if you had typed it at that moment. Built for subscription quota windows — arm it before walking away, and the request fires once the credits have refreshed.

## Usage

```
/go-after 180 continue the refactor      # bare number = minutes
/go-after 2h30m run the full test suite  # h/m/s duration, no spaces
/go-after 17:05 continue                 # 24-hour wall clock, next occurrence
/go-after                                # show the pending timer
/go-after cancel                         # cancel it
```

One timer at a time; arming again replaces the previous one and says so. While armed, the footer shows `⏰ 17:05 (2h29m)` — the chip and the timer live and die together. Malformed input is rejected with an error; nothing runs on a guess.

## Semantics

- The prompt is sent verbatim as a real user message, using whatever model is selected at fire time. If the agent is mid-run, it is queued as a follow-up and delivered when the run finishes.
- Waiting writes nothing: no session entries, no context injection, no model calls, no registered tool.
- The target is a wall-clock instant checked every second, so laptop suspend does not stretch the wait.
- Deferred prompts are sent as plain text: slash commands and prompt templates would not run, so arming rejects prompts that start with a registered command.
- If firing is impossible (no model selected, credentials expired), the prompt is parked in the input box instead of lost — press enter after fixing. Failures after sending (e.g. quota still empty) behave exactly like a hand-typed prompt; pi's own retry applies, there is no retry daemon here.

## Lifetime

The timer is process memory scoped to the current session: quitting pi, `/new`, `/resume`, `/fork`, `/clone`, and `/reload` all cancel it. `/tree` branch moves within the session do not — the prompt fires at the current leaf. Do not open the same session from two pi processes; pi does not support that in general, and each process would fire its own timer.
