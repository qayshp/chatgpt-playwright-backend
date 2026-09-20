# Debugging without recording conversations

The default service emits lifecycle/error codes only. The standalone adapter and CLI are quiet unless a logger is supplied or `CHATGPT_DIAGNOSTICS=1` is set. Neither the service nor adapter creates log files or caches conversation content on disk.

## Capture metadata deliberately

From the backend directory, start the foreground service directly to keep stderr JSON-only:

```sh
umask 077
CHATGPT_DIAGNOSTICS=1 node --import tsx src/service/main.ts 2>chatgpt-backend.log
```

The shell creates the file, which Git ignores. This service log is not automatically rotated: use a bounded reproduction session, stop the service with Ctrl-C, and delete the file when it is no longer needed. Restarting the service can require Chrome's debugging approval again; enable diagnostics when starting the service rather than repeatedly running the one-shot CLI.

Logs contain timestamps, stable event names, selector labels, route templates, status/error codes, UUIDs, booleans, counts, and timings. They do not contain prompts, answers, titles, conversation URLs, raw request paths/query strings, cookies, debugging endpoints, or raw Playwright errors. IDs and timing still describe local activity, so share only the relevant records. `GET /status`, `/turns`, operation results, CLI stdout, and development inspection tools can contain actual conversation data; they are not sanitized diagnostic exports.

## Follow one failed interaction

1. Find its HTTP response's `X-Request-ID`. This ID is generated for every request; it differs from the persistent send operation's ID.
2. Match `requestId` in `http-request-started`, `http-request-finished`, or `http-request-failed` records. Paths use templates such as `/operations/:id/events`.
3. For a send, `operation-accepted` or `operation-reused` links that HTTP request ID to `operationId`. A reused ID must not send a second browser message.
4. Follow `sse-opened` / `sse-closed` and `operation-finished` for that operation. Nonterminal SSE closure means the observing client left, not that ChatGPT stopped.
5. Read the final operation by ID if needed. Its contents remain in memory only within retention limits. Do not automatically resend if that operation is missing after a timeout or service restart.

Adapter progress records occur approximately every ten seconds while observation is consumed. `userDetected: false` after an attempted send points toward submission not being confirmed. `assistantDetected: false` after submission points toward no matching rendered answer. `generating`, DOM sample/mutation counts, and delivered/dropped snapshots distinguish a waiting page from a busy stream or slow consumer. These are observations, not guesses about ChatGPT's private backend. Successful completion also records latency and completion evidence.

## Common situations

| Symptom | Check or recovery |
| --- | --- |
| `LISTEN_ADDRESS_IN_USE` | Another process owns the port. Stop the intended existing service or choose a different `CHATGPT_SERVICE_PORT`; startup does not attempt Chrome attachment in this case. |
| `approval_required_or_rejected` | Inspect Chrome's debugging approval UI. Pending approval and rejected/failed handshake cannot be distinguished reliably. Restart intentionally after resolving it. |
| `no_chatgpt_tab`, `ambiguous_tab`, `tab_locked` | Open/select the intended chat tab. Inspect the owner process before removing any stale lock. Do not copy or reset a profile. |
| `unauthenticated` / `challenge` | Resolve the browser page manually. No automated credentials are supported. |
| `409 BUSY` | One browser operation owns the tab. Wait or observe the active operation; cancellation only ends adapter observation. |
| `DRAFT_PRESENT` / unexpected navigation | Inspect the selected tab. Do not overwrite its draft or automatically retry a send. |
| `dom_assumptions_failed` | Compare the selected page's controls with `src/selectors.ts` and `src/dom-runtime.js`. Add a sanitized fixture and regression test before changing selector assumptions. |
| SSE reconnect/reset | Apply replacement state; empty text is a valid correction. Use the final result when completed. Backpressure and journal eviction may drop intermediate snapshots. |
| Successful create/open, unhealthy subsequent status | The action remains successful. Inspect `/status` before another browser action; do not repeat creation merely because a follow-up health read failed. |

## Reproduce without Chrome

```sh
npm run check
npm test
```

For the actual TypeScript service plus Go client, run from the sibling frontend repository after installing this backend's dependencies:

```sh
CHATGPT_BACKEND_CONTRACT_DIR=../chatgpt-backend \
  go test -race ./backend -run TestTypeScriptServiceContract -count=1 -v
```

This starts `scripts/contract-fixture.ts` with a synthetic adapter on an ephemeral loopback port. It never attaches to Chrome. It checks the real transport contract and shuts down its own process. See [review verification](REVIEW_VERIFICATION.md) for coverage and limits, and [HTTP_API.md](HTTP_API.md) for the authoritative transport contract.
