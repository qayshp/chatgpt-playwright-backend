# ChatGPT UI rollout verification — 2026-09-30

Environment: existing default Chrome profile on macOS, Chrome 154.0.8037.58, Node 26.8.2, Playwright 1.63.0. Chrome was not restarted and its profile was not copied or reset. The user completed passkey authentication; remote debugging was enabled and the adapter connections were approved with explicit authorization.

## Compatibility fixes

The old fixtures passed but the live rollout was incompatible. Updated the adapter layer while retaining the HTTP/SSE contract, normalized schema version 1, and authoritative replacement snapshots:

- Recognize the profile menu inside App navigation and the Home history navigation region, retaining legacy selectors. Hidden regions are excluded and ambiguous history fails explicitly.
- Recognize exact Send and composer-scoped Stop labels. Only named ChatGPT textboxes (or the legacy composer ID) count as composers; editable answer code does not become a draft or competing input.
- Accept `/c/local-chatgpt%3A<uuid>` as a provisional new-chat URL, retaining the old WEB form. Provisional IDs are not advertised as durable IDs. Another provisional ID or a different durable conversation is rejected.
- Read rollout search-unit attributes for roles and message IDs. Repeated identical IDs are deduplicated; distinct IDs in one message are rejected rather than chosen arbitrarily.
- Normalize answer content from the new semantic Markdown root. Editable code becomes a code block with language and line breaks, excluding code-toolbar text.
- Require the new answer's own completion toolbar. A code widget's Copy button and an older answer's toolbar cannot finish a response. Stop state and the existing settling interval still apply.
- Improve live smoke-test failures to print the event type and sanitized error code instead of a generic assertion, without dumping message bodies.

## Fixture verification

`npm run check` and `npm test` pass: **58 tests**, no skips. These commands do not attach to Chrome or send anything to ChatGPT. Added coverage includes rollout authentication and hidden controls, both sidebar layouts with lazy-list scroll restoration, encoded provisional identity transitions, editable-code exclusion, normalized code, replacement streaming, generation controls, and completion/identity ambiguity guards. Legacy fixtures still pass.

The sibling Go client's `TestTypeScriptServiceContract` is also run with the race detector against the real TypeScript HTTP/SSE server and a synthetic adapter. This is a contract test, not live ChatGPT interaction.

## Live verification

Explicit command, against the already attached service:

```sh
node --import tsx scripts/verify-service.ts --live
```

The successful diagnostic run created a new disposable chat and sent two small optics prompts. It checked status, new-chat identity, visible turns, five recent conversations, send/submitted events, text and structured snapshots, SSE disconnect/reconnect after three text snapshots, 409 rejection of a competing send, final lookup, late completion replay, direct reopening of the new conversation, and a follow-up send. The same service instance used one CDP connection throughout.

| Measurement | Result |
| --- | --- |
| First answer text snapshots | 117 |
| First answer structured snapshots | 27 |
| Disconnect cursor / final cursor | 6 / 147 |
| First answer normalized blocks | Heading, paragraphs, numbered list, Python code |
| First answer maximum observation-to-delivery delay | 74 ms |
| Follow-up text snapshots | 66 |
| Follow-up maximum observation-to-delivery delay | 79 ms |
| SSE reconnect, final lookup, late replay | Passed |
| Final authenticated / usable / idle state | Passed |
| Service connection attempts | 1 |
| Additional history scan | 60 conversations, 3 scrolls, limit reached |

After tightening the Copy-control guard to exclude controls anywhere inside answer content, the complete two-send workflow passed again with the final code and normal logging: **113 text / 26 structured snapshots** for the first answer, **41 text snapshots** for the follow-up, cursor **6 / 142**, successful reconnect and late replay, and one service connection. This final repeat used another new disposable chat.

These are observations from individual runs, not latency or availability guarantees. Only counts and diagnostic metadata were retained in this document.

Preliminary runs used disposable chats only. Some attempts stopped before submission and left a verification draft, which was explicitly inspected and cleared. Two submitted prompts exposed the previously unsupported provisional URL transition, and subsequent inspection exposed the new turn markup. One follow-up attempt stopped before submission without a useful error code in the old smoke assertion; its exact cause was not established. Both subsequent complete runs passed both sends. No automatic resend was added, and no test prompt was sent into a pre-existing personal conversation.

## Limits

Live citations, research/tool-heavy replies, branching/parallel answers, long virtualized code editors, and non-English accessibility labels were not verified in this rollout. Existing citation fixtures still pass, but are not proof of current live citation markup. Code extraction uses rendered DOM lines only and warns on observed CodeMirror virtualization gaps; it does not access editor internals. The sidebar remains a bounded UI scan, not a complete account export.

The adapter remains coupled to undocumented UI attributes. Chrome consent may be needed for each new connection; the service avoids repeated connections during normal requests. Operation results remain memory-only. Cancellation still stops observation, not ChatGPT generation. No frontend changes, private ChatGPT protocol, cookie/token exports, API integration, or launchd supervision were introduced.

## Shutdown and current service

After the diagnostic run, the service received SIGTERM, its loopback listener disappeared, and the unchanged Chrome process (PID checked before/after) stayed running. Native Chrome accessibility inspection confirmed the authenticated profile control, same disposable conversation, and empty composer. Diagnostic inspection connections were detached as well.

The service was then restarted using `npm run service:tailscale` in a foreground terminal session, approved once, and passed the final complete live repeat. It was left running with opt-in diagnostics disabled. The configured tailnet-only Tailscale Serve proxy still points to `127.0.0.1:3210`. ColorBerry was offline according to Tailscale and its SSH connection timed out, so a fresh device-to-laptop HTTP check was unavailable. Local service compatibility is verified; current remote reachability from ColorBerry is not.

This is an unsupervised foreground process, not a guarantee of restart or survival across closing its session, logout, sleep, or reboot. No launchd job was installed.
