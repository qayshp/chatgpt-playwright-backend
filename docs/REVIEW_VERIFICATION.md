# Reliability review verification — 2026-09-20

This review starts from backend `9accc87` and frontend `30c280a`. It preserves the independent browser adapter, one long-lived service connection, HTTP/SSE contract v1, and normalized content schema v1. No frontend-specific behavior was added to the browser adapter.

## Automated backend results

`npm run check` and `npm test` pass: **49 tests**, up from 27. No test launches or attaches to Chrome. Coverage added in this review includes:

- Late human drafts, navigation during identity reads, unsupported same-origin product pages, and disconnected CDP transport are rejected before unsafe browser work.
- Hidden response branches do not count as visible turns or competing replies. Empty text corrections clear prior text. Structural-only changes restart the completion-settling interval.
- Forced disconnect attempts observer cleanup before transport detach. Failed attachment preserves the original error and removes its owned lock even if detachment also fails.
- Invalid CLI arguments fail before connection. Both operation and cleanup errors are sanitized; raw Playwright call logs and tab URLs stay out of CLI error output.
- Logging callbacks cannot fail browser/service actions. Diagnostics correlate HTTP, operation, and SSE state without message bodies, titles, arbitrary paths/query strings, or raw errors.
- Successful browser actions remain successful when a subsequent health read fails. Initial health inspection respects the tab reservation.
- Failed/late disconnects still close HTTP/SSE and clear operation memory; port conflicts fail before Chrome attachment.
- Real loopback SSE backpressure catches up through a reset, retains final state, enforces 32 subscribers, and releases slots after disconnect.

## Actual TypeScript-to-Go contract

From the sibling frontend, this passed both normally and with the Go race detector:

```sh
CHATGPT_BACKEND_CONTRACT_DIR=../chatgpt-backend \
  go test -race ./backend -run TestTypeScriptServiceContract -count=1 -v
```

The real `ChatGPTService` runs over loopback HTTP/SSE with `scripts/contract-fixture.ts` supplying a synthetic adapter. The real Go client reads status/current/recent/turns, creates/opens a conversation, reuses an operation ID, receives BUSY with a correlation ID, disconnects/resumes observation, receives empty/corrected text and normalized structures, reads the final result, and cancels a synthetic holding operation. The fixture verifies one service instance, one connection, one disconnect, and exactly two synthetic sends. It is opt-in so ordinary Go tests need neither Node nor the sibling repository.

## Frontend integration and limits

Frontend ordinary tests pass **48 top-level tests**, with its optional cross-project test skipped unless enabled. Race tests, vet, native macOS ARM64 build, and static Linux ARM64 cross-build pass. A real PTY fixture run exercised 20×7 confirmation readability, chord-free multiline drafting, disabled hidden confirmation/paste at 12×4, restoration after resize, a synthetic send/stream completion, details at 32×12, and clean exit. Its opt-in log had mode 0600 and metadata only; the unique synthetic message was absent.

These results test current code against fixtures. **This review did not connect to live Chrome, send any real ChatGPT messages, or run on ColorBerry.** Earlier live evidence is recorded separately in `SERVICE_VERIFICATION.md` and `../VERIFICATION.md`; it is not reclassified as verification of these later changes. Actual UI selectors, remote-debugging approval, manual browser interaction, background throttling, and device terminal behavior remain live-environment constraints.

## Follow-up

Use the documented metadata logging workflow to capture a narrow failure before changing selectors or recovery behavior. A real ColorBerry session is the next usability check. Remote access still requires authenticated transport/access control; both the backend's loopback binding and the TUI's configurable URL remain unchanged. No launchd service, Beeper bridge, durable conversation cache, or browser-profile changes were added.
