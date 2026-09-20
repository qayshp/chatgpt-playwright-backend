# Local HTTP/SSE contract — version 1

## Running and ownership

```sh
npm ci
npm run service
# Direct foreground command suitable for a future supervisor:
node --import tsx src/service/main.ts
```

The service binds **only `127.0.0.1`**, default port **3210**. `CHATGPT_SERVICE_PORT` changes the port, not the bind address. Keep Chrome open with remote debugging enabled. Chrome may require one connection approval at startup. The service opens the HTTP listener first, so `/status` works while attachment is pending or failed.

The process attempts **one Playwright/CDP attachment for its lifetime** and selects **one existing ChatGPT tab**. It never selects a different tab automatically, launches Chrome, reconnects per request, or reconnects on failure. If attachment fails or Chrome disconnects, fix the browser state and restart the foreground service. Old operations are not recovered after restart.

Environment:

| Variable | Meaning |
| --- | --- |
| `CHATGPT_SERVICE_PORT` | Loopback HTTP port; default `3210` |
| `CHATGPT_TAB_URL` | Exact URL of the already-open tab to select |
| `CHATGPT_CONVERSATION` | Select an already-open tab by conversation ID or URL |
| `CHATGPT_CDP_ENDPOINT` | `chrome` by default; explicit endpoints must be local loopback HTTP/WS URLs |
| `CHATGPT_DIAGNOSTICS=1` | Opt-in adapter/operation metadata logging; never prompts or response bodies |

`SIGINT`/`SIGTERM` stops accepting connections, cancels active observation, waits for cleanup, closes SSE connections, and disconnects CDP without closing Chrome or its tab. A stuck browser operation gets an eight-second grace period before forced CDP disconnection. If attachment is still pending, shutdown waits for the bounded startup attempt (30-second timeout by default) and disconnects any late connection. Cancellation does not press ChatGPT's Stop button; browser generation can continue after service shutdown.

## Concurrency

There is **no request queue**. One browser operation owns the tab at a time. While a send is active, a new send, navigation, new-chat creation, history enumeration, or visible-turn read returns **409 `BUSY`**. This also serializes short browser reads against navigation. Busy errors identify the active operation ID; `/status` provides its kind.

Operation lookup, SSE subscriptions, cancellation, and request-ID reuse do not acquire the tab. `/status` remains available: while busy it returns the cached browser status with `adapterStatusStale: true`, alongside the current service state and active operation. When idle it refreshes browser status. No background polling or tab navigation is performed just for health checks.

Manual use or other automation is outside this process's mutex. Supply `expectedConversationId` with sends to bind the intended destination. Existing drafts are never overwritten. Sends bring the selected ChatGPT tab to the front before using its accessible Send button; background-tab submission proved unreliable in live testing. The adapter separately checks generation state before sending or navigating.

## HTTP routes

Bodies must be JSON objects with `Content-Type: application/json`, including `{}` for empty POSTs. Unknown body fields are rejected. Request bodies are limited to **64 KiB**. Compressed bodies are not accepted. All responses are `Cache-Control: no-store`.

| Method and route | Body / query | Success |
| --- | --- | --- |
| `GET /status` | None | `200` service health, browser status, active operation, connection count, retention limits |
| `GET /conversation` | None | `200` current `Conversation` |
| `GET /conversations/recent?limit=30` | Integer limit `1..200` | `200` bounded recent-chat result; never claims complete account history |
| `POST /conversation/open` | `{ "conversation": "<id-or-https://chatgpt.com/c/...>" }` | `200` opened `Conversation` |
| `POST /conversations` | `{}` | `201` new conversation; ID remains null until the first send assigns it |
| `GET /turns` | None | `200` array of rendered `Turn` objects |
| `POST /messages` | See below | `202` operation ID and relative event/result URLs |
| `GET /operations/<id>` | None | `200` latest operation state, snapshots, and final result/error when available |
| `GET /operations/<id>/events` | Optional `Last-Event-ID` header or `?after=<event-id>` | `200` SSE stream with replay |
| `POST /operations/<id>/cancel` | `{}` | `202` cancellation requested, or `200` if already terminal |

Examples:

```sh
curl -s http://127.0.0.1:3210/status
curl -s 'http://127.0.0.1:3210/conversations/recent?limit=30'
curl -s -X POST http://127.0.0.1:3210/conversations \
  -H 'Content-Type: application/json' -d '{}'

curl -s -X POST http://127.0.0.1:3210/messages \
  -H 'Content-Type: application/json' \
  -d '{"message":"Explain rainbows in two short paragraphs.","expectedConversationId":null}'
# Use the returned id/eventsURL:
curl -N http://127.0.0.1:3210/operations/OPERATION-ID/events
curl -N -H 'Last-Event-ID: 12' \
  http://127.0.0.1:3210/operations/OPERATION-ID/events
curl -s http://127.0.0.1:3210/operations/OPERATION-ID
curl -s -X POST http://127.0.0.1:3210/operations/OPERATION-ID/cancel \
  -H 'Content-Type: application/json' -d '{}'
```

### Send request

```json
{
  "message": "Text to send",
  "requestId": "11111111-1111-4111-8111-111111111111",
  "expectedConversationId": null,
  "timeoutMs": 180000
}
```

Only `message` is required. `requestId` is an optional client-generated UUID; otherwise the service generates one. The **operation ID and adapter request ID are identical**. `expectedConversationId` can be a stable conversation ID or explicit null for a new-chat page; omitting it lets the adapter use its currently selected conversation. `timeoutMs` is an integer from 1000 to 600000, default 180000.

During retention, retrying the same request ID and same input returns the original operation with `reused: true`, without sending again. Different input under the same ID returns 409 `REQUEST_ID_CONFLICT`. Retention eviction/restart ends this protection: this is not a durable exactly-once guarantee. Never automatically resend an uncertain submission after its operation is unavailable.

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "reused": false,
  "state": "accepted",
  "eventsURL": "/operations/11111111-1111-4111-8111-111111111111/events",
  "resultURL": "/operations/11111111-1111-4111-8111-111111111111"
}
```

202 means accepted by the service, **not yet confirmed submitted to ChatGPT**. Drafts, expired login, or other browser conditions can subsequently fail the operation. Only `submitted` confirms the adapter found the corresponding user turn. The service does not automatically retry sends.

### Status and errors

`/status` includes `apiVersion: 1`, a process-lifetime `instanceId`, `connectionAttempts`, `connectedAt`, `state`, `busy`, `activeOperation`, `adapterStatus`, `adapterStatusStale`, optional sanitized `error`, and retention limits. It never returns the Chrome debugging endpoint.

States:

- `connecting`: the one startup attempt is pending; `approvalMayBeRequired` is true.
- `usable`: attached, authenticated, usable and idle.
- `generating`: an observed send is active, or idle status reports ChatGPT generating.
- `cdp_unavailable`: debugging metadata/socket missing, Chrome disconnected, or selected tab closed.
- `approval_required_or_rejected`: Chrome's debugging socket was reachable but Playwright attachment failed. The available error does **not reliably distinguish a pending consent prompt from rejection or another handshake failure**. Check Chrome and restart; the service does not claim certainty.
- `no_chatgpt_tab`, `ambiguous_tab`, `tab_locked`: tab selection/ownership needs attention.
- `unauthenticated`, `authentication_unknown`, `challenge`: ChatGPT login or page access needs attention; credentials are never automated.
- `navigation_changed`: unexpected navigation or lost observation.
- `dom_assumptions_failed`: expected controls or response structure failed verification.
- `page_error`, `draft_present`: browser state prevents a safe operation.
- `shutting_down`, `stopped`: lifecycle state.

Status describes the current health observation. A later healthy status can clear a previous health error; the failed operation retains its own error until eviction.

Errors are JSON `{ "error": { "code": "...", "message": "...", "state": "..." } }`. `state` is optional. Common HTTP codes: 400 invalid input/cursor, 403 Origin/Host forbidden, 404 unknown route/method or unavailable operation, 409 incompatible browser state/busy, 413 oversized input/result, 415 content type/encoding, 503 unavailable attachment/capacity, 504 adapter timeout. Raw Playwright error messages and page snippets are not returned or logged by the service.

## SSE events and snapshot semantics

Wire format:

```text
id: 12
event: snapshot
data: {"operationId":"…","requestId":"…","text":"Entire current response","sequence":7,"observedAt":1234567890000,"elapsedMs":2400}

```

SSE IDs are increasing integers scoped to an operation, spanning **all** event types. The adapter's text `sequence` is separate; do not use it as the replay cursor.

| Event | Data beyond `operationId` |
| --- | --- |
| `accepted` | Service has allocated the operation; no prompt is included |
| `submitted` | `requestId`, `conversation` |
| `snapshot` | `requestId`, complete `text`, adapter `sequence`, `observedAt`, `elapsedMs` |
| `content_snapshot` | `requestId`, complete normalized `turn`, `elapsedMs` |
| `completed` | `requestId`, `result` containing conversation, final turn, elapsed time, completion evidence |
| `cancelling` | `cancellationMode: "observation-only"` |
| `cancelled` | `cancellationMode`, `browserMayStillBeGenerating: true` |
| `failed` | Sanitized `error`, conservative `browserMayStillBeGenerating: true` |
| `reset` | Complete current `operation` view when older events have been evicted |

**Replace, do not append.** ChatGPT can rewrite earlier text. Apply each text snapshot by replacing the displayed text. Apply each content snapshot by replacing the structured content. Structured updates are opt-in at the library level and throttled to approximately 250 ms; they can lag text. The final `completed.result.turn.content` is authoritative for both representations. Structural changes such as paragraph-to-heading replacement can emit content snapshots even if plain text does not change.

The normalized `Content` schema remains defined in `src/types.ts` and is transport-independent. No ColorBerry, Matrix, Beeper, or AG-UI-specific fields enter the adapter. Consumers may call the existing `renderHTML()` or translate the same blocks to their own event formats.

### Disconnect, replay, and final retrieval

Disconnecting an SSE client **does not cancel** the send or disconnect Chrome. Multiple subscribers can observe the same operation. Reconnect with `Last-Event-ID`; the header takes precedence over `after`. With neither, the cursor is zero. Negative, malformed, unsafe-integer, or future cursors are rejected.

If retained events cover the cursor, the service replays events with greater IDs and then streams live updates. If the cursor falls behind the retained window, one `reset` event contains the current complete operation view and advances the cursor to `lastEventId`. Treat it as replacement state, including a final result/error if terminal. Replay does not promise every intermediate snapshot indefinitely; it preserves a route to current/final state.

A terminal stream closes after replaying its terminal event (or terminal reset). A reconnect with the final event ID can close with no new events; use `GET /operations/<id>` to read the result. SSE comment heartbeats occur every 15 seconds. Backpressure pauses a subscriber's writes and resumes from the bounded operation journal rather than building an unbounded per-client queue. There are at most 32 simultaneous SSE subscribers.

### Cancellation

Cancellation aborts adapter observation and releases its operation after cleanup. It **does not click Stop, clear a draft, navigate, or disconnect Chrome**. ChatGPT might continue generating, and any unsent draft may remain. After cancellation, consult `/status`; the adapter prevents another send/navigation while ChatGPT is generating or a draft is present. Cancellation is idempotent. If it races an already observed final response, completion may win.

`failed` and `cancelled` can contain partial text/content in the operation view. Those are not a completed answer. They retain the last known snapshots for diagnosis/recovery without an automatic resend.

## Memory and privacy limits

Nothing is persisted to disk for caching or replay. Defaults:

- At most 16 operations, including active operations.
- Terminal operations expire after 10 minutes; older terminal operations may be evicted sooner when capacity is needed.
- Up to 128 events and a 2 MiB serialized-event budget per operation.
- A single event payload is limited to 1 MiB. An oversized result fails explicitly instead of being silently truncated.
- Latest snapshots/final result are retained separately from the event window; JavaScript object overhead is additional to the serialized-event budget.
- The submitted prompt is not stored in the operation record; it exists transiently while the adapter is sending/observing it. A request fingerprint supports in-memory request-ID reuse.
- Existing conversation/history reads are returned directly and not retained as service caches.
- Shutdown/restart loses operation memory. Missing/expired/evicted operations return 404 `OPERATION_NOT_FOUND`.

No credentials, cookies, tokens, raw network traffic, or debugging endpoint are exported. The service does not expose arbitrary browser evaluation or a CDP proxy. Default logs are lifecycle/error codes only; opt-in diagnostics add metadata and counts, never message bodies. The standalone development diagnostic scripts retain their explicit opt-in behavior and are not HTTP endpoints.

Strict loopback Host validation and Origin/Fetch-Metadata checks reject browser cross-origin requests and DNS-rebinding Host names; no CORS allowance is emitted. This phase trusts local processes on the machine and has no bearer-token authentication. Do not reverse-proxy or expose it remotely without adding authenticated transport/access control in a later phase.

## Testing

```sh
npm run check
npm test
# With the foreground service running and approved; explicitly sends two prompts in a new chat:
node --import tsx scripts/verify-service.ts --live
```

The automated suite uses a fake adapter over real loopback HTTP/SSE, and DOM fixtures for browser behavior. It does not launch Chrome or send messages. The explicit live script creates a disposable chat, exercises browser operations, disconnects/reconnects SSE during generation, reads a late terminal replay, reopens that chat, and sends one follow-up. The service is stopped separately with Ctrl-C/SIGTERM to verify Chrome survives. See `SERVICE_VERIFICATION.md` for measured evidence.
