# Persistent service verification — 2026-09-20

Base adapter commit: `c275625`. Environment: macOS, Node.js 26.8.2, Playwright 1.63.0, existing authenticated Google Chrome 153.0.8010.48. The service uses the existing default Chrome profile; no browser restart, profile copy, login automation, cookie export, private ChatGPT protocol, or API integration was used.

## Automated verification

`npm run check` passes. `npm test` passes **27 tests** without attaching to Chrome or sending ChatGPT messages.

Nine service tests use a fake adapter and real localhost HTTP/SSE sockets. They cover:

- One connection reused across operations; same operation/request ID throughout; full-text replacement, normalized content, live SSE disconnect/reconnect, late terminal replay, and final retrieval.
- Explicit concurrent-operation rejection, retained request-ID reuse/conflicts, cancellation and continued browser generation.
- Unavailable CDP, failed approval/handshake, missing tab, unauthenticated/DOM/navigation failures, sanitized errors, and no automatic reattachment.
- Replay-window gaps producing a full-state reset, TTL/capacity eviction, bad cursors, response-size bounds, and incomplete adapter streams.
- Local Host/Origin/Fetch-Metadata checks, JSON validation, and request limits.
- Shutdown during observation and pending attachment, including disconnecting a late connection exactly once.

Adapter/DOM fixtures additionally verify draft/destination/generation guards, delayed sidebar loading, structural-only content updates, text corrections, normalized rendering, and completion evidence. Fixtures do not establish that every error layout or Chrome consent failure maps identically in the live product.

## Live verification

Explicit opt-in command, with the foreground service already running and its Chrome connection approved:

```sh
node --import tsx scripts/verify-service.ts --live
```

The successful run created **one new disposable ChatGPT conversation** and sent two harmless verification prompts there. It did not send into a pre-existing conversation. The same service instance reported **one connection attempt** throughout these operations:

1. Read usable/authenticated status.
2. Create a new chat; verify no ID yet and no visible turns.
3. Enumerate five recent chats with titles, URLs and IDs.
4. Send a message with a client-supplied request ID and expected null conversation ID.
5. Disconnect the SSE client after three text snapshots, verify a competing send receives 409 without submission, then reconnect with `Last-Event-ID` while generation continues.
6. Receive completion, retrieve the final result, and verify late replay includes completion.
7. Navigate directly back to the new conversation's durable URL, read its turns, and send a second message.
8. Confirm authenticated, usable, idle status and the same service instance/connection count.

Measured results for this run:

| Observation | Result |
| --- | --- |
| First response text snapshots | 101 |
| First response structured snapshots | 19 |
| SSE disconnect cursor / final cursor | 6 / 123 |
| Reconnect during generation | Passed |
| Late completion replay and final lookup | Passed |
| First response normalized blocks | Heading, two paragraphs, numbered list, code block |
| Second response text snapshots | 23 |
| Second response completion | Passed |
| Maximum DOM-observation-to-delivery delay | 83 ms first response; 77 ms second |
| CDP connection attempts in successful service lifetime | 1 |

The timing values describe this run, not a latency guarantee. This phase enumerated only five recent entries; broader lazy-loading behavior (60 entries) and real citation extraction were live-tested in the original adapter phase, documented in `../VERIFICATION.md`. This service phase reused that normalized schema without retesting live citations.

Afterwards, the service was stopped through its interrupt handler. It logged one disconnect and a clean stop; no listener remained on port 3210. The original Chrome main process remained running with the same PID. Native accessibility inspection confirmed the same conversation page, response content, composer, and account/profile control remained present, with no login prompt. No new CDP connection was opened for that final check. The service was left stopped.

## Issues discovered and addressed

Early development runs exposed an initially empty, still-loading history sidebar. The adapter now gives that condition a bounded five-second readiness window before returning an empty result.

Two preliminary submission attempts in the new-chat page did not submit: pointer activation timed out in the background tab, and keyboard activation returned without a matching user turn. Both failed explicitly; the unsent verification drafts were inspected and cleared before further tests. There was no automatic resend. The final implementation activates the selected tab and uses its accessible Send button. The successful two-send run used that implementation. Moving activation after destination validation was subsequently covered by the guard fixtures.

The service does not attempt fully invisible background browser control. A send may activate the ChatGPT tab. Completion still depends on the adapter's DOM evidence rather than private network messages.

## Scope and untested live cases

Cancellation is deliberately **observation-only**, not browser-generation cancellation. This behavior, startup failures, active/pending-attachment shutdown, retention expiry, replay gaps, and hostile HTTP inputs are fixture-tested; they were not induced against the user's authenticated ChatGPT session. Live shutdown was verified after completed operations. No crash recovery across process restart is promised because operation memory is intentionally ephemeral.

Chrome's reachable-but-failed CDP handshake cannot reliably distinguish pending consent from rejection or another handshake error; the service reports that uncertainty. Background throttling, DOM changes, manual edits/navigation, thinking/tool phases, and unusual response widgets remain browser-automation limitations.

No frontend, Beeper/Matrix translation, launchd job, remote listener, or on-disk content cache was added.
