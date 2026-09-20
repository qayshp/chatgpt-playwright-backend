# Verification record

Date: 2026-09-20. Project: `chatgpt-browser-adapter`.

## Environment and session preservation

- Existing Chrome 153.0.8010.48 using the authenticated default profile.
- User enabled Chrome's in-place remote debugging. Playwright 1.63.0 attached with `chromium.connectOverCDP('chrome', { noDefaults: true })`.
- No browser launch, restart, profile copying, cookie/token export, login automation, or private ChatGPT/OpenAI/Codex request was used.
- Native Chrome connection approval is separate from enabling the setting. A long-lived connection avoids repeated reconnection prompts.
- Final CLI verification (`npx tsx src/cli.ts status`) succeeded without explicit tab selection while the Codex analytics tab remained open, reported the correct authenticated/usable test conversation, and disconnected. The original Chrome process remained running afterward, the test conversation remained displayed, and no adapter lock files remained.
- Chrome also had a Codex analytics tab. An initial ambiguous selection failed explicitly; tab selection was supplied, and the final adapter now excludes non-chat URL routes by default.
- All message tests were made in **new test chats**, as requested. No pre-existing conversation was modified. Four test prompts were sent in total, across two new chats.

Test conversations:

- Test chat A — “Explain Rainbow Formation”: initial DOM discovery, successful full stream, and navigation/citation test.
- Test chat B — “Write Adapter Verification”: final new-chat lifecycle and delivery-latency test.

Only test labels and aggregate results are saved here; private conversation URLs and machine-specific profile details are omitted. Response bodies, recent-chat titles, page dumps, authentication state, and screenshots are not persisted by the adapter.

## Requirement-by-requirement live results

| Requirement | Observed evidence |
| --- | --- |
| Attach to existing authenticated Chrome | Successful Playwright connections to the same running Chrome/profile; no new browser/profile |
| Detect login and usability | `login: authenticated`, `usable: true`, one visible composer, no draft or active generation; logged-out/ambiguous states additionally covered in synthetic tests |
| Current conversation identity | Correct new-chat `id: null`; provisional `WEB:` state; durable IDs and titles matching both test conversations |
| Read existing rendered turns | After reopening the first test chat, four stored user/assistant turns read successfully; headings, paragraphs, ordered/unordered lists, code and links recognized |
| Send through composer | Four labelled test prompts submitted through the accessible textbox and Send message button; new user turn text/ID confirmed |
| Incremental DOM streaming | 133 updates in the long formatting test; 33 updates in the navigation/citation test; 63 updates in the final new-chat test |
| Generation completion | Each successful stream ended only after the new assistant turn had its Copy response control, no stop/streaming marker, and 700 ms of settled text; final snapshot equalled returned final text |
| Plain and normalized content | Actual headings, paragraphs, numbered and bullet lists, strong emphasis, inline code, Python code block/language, links, and two NASA citation links preserved; escaped HTML generated from the schema |
| Recent UI chats / lazy loading | 60 unique conversations with nonempty titles and canonical URLs collected after two scrolls, exceeding the initial 33/34 loaded links; original scroll position restored; result explicitly reports a limit and does not claim complete history |
| Direct conversation navigation and repeat send | `openConversation()` loaded the first test URL; its existing four turns were read; a subsequent prompt produced 33 updates and a completed cited response in the same conversation |
| Create conversation | `createConversation()` opened an empty new-chat page; the final send accepted `/c/WEB:<uuid>` becoming a durable `/c/<id>` and completed successfully |

## Stream measurements

These are actual DOM snapshots from the real ChatGPT page, not tokens from a private network response.

| Test | Text snapshots | First text observed | Last text change | Completion reported | Maximum observed DOM-to-adapter delay |
| --- | ---: | ---: | ---: | ---: | ---: |
| Formatting / blue sky | 133 | 5.009 s | 12.180 s | 13.004 s | Not instrumented in this run |
| Reopened chat / NASA citations | 33 | 5.461 s | 6.880 s | 9.834 s | Not instrumented in this run |
| Fresh chat / final verification | 63 | 5.579 s | 9.662 s | 11.161 s | **77 ms** |

First/last observation times are measured from installation of the page observer, just before filling/sending. Completion time includes adapter preparation. First-text delay includes ChatGPT processing and generation time; it is not the adapter's delivery latency. The 77 ms measurement uses the page observation timestamp and the adapter's delivery time on the same machine. It is a single-run measurement, not a latency guarantee under background throttling or load.

The last answer was read again after completion: the assistant text remained 658 characters and the page was authenticated, usable, idle, and had an empty composer.

## Live discoveries incorporated into the adapter

1. Current turns use `section[data-testid="conversation-turn-N"]`, not `article`. Completion now scopes controls by the test-ID turn container, with an article fallback.
2. A new chat first receives a provisional `WEB:` URL. The initial exploratory send stopped its observer on that transition; the message itself completed normally in ChatGPT and was not resent. The adapter now handles and has live-tested the transition explicitly.
3. Initial assistant “Thinking” placeholders can have message IDs without answer markdown. They are excluded from streamed answer text.
4. User messages have a collapsible content region; its text is read without Show more/Show less controls.
5. Code widgets include Copy/Run controls and nested pre/code elements. The adapter extracts actual code, omits toolbar text, and recognizes the visible Python language label.
6. Citations are available in the rendered DOM. The NASA test returned two citation nodes with their actual linked URLs plus an ordinary reference link.
7. Chat history can be collapsed. The adapter opens the semantic sidebar control when needed, enumerates the labelled history navigation region, and restores scroll position after bounded enumeration.

## Automated checks

- `npm run check`: passes.
- `npm test`: **16 tests pass**.
- `npm run cli -- help`: passes.
- Tests cover URL boundaries; exclusion of Codex/non-chat tabs; one-way provisional conversation identity; existing-draft and destination guards; authentication/ambiguous composers; HTML escaping and safe URL protocols; semantic content and citations; incremental snapshots including corrections; completion controls and streaming markers; competing messages; current section-based turn containers; code-toolbar filtering; and thinking-placeholder exclusion.

The synthetic tests do not establish every ChatGPT layout, language, model, tool, or error flow. Tables, nested lists, quotes, and unresolved citations are fixture-tested; basic formatted content and real linked citations were live-tested. Manual cancellation, branching/regeneration, attachments, voice, interactive widgets, long-chat virtualization, multiple simultaneous replies, session expiration, and background timer throttling need further integration coverage before unattended use.

## Remaining product work

The requested backend proof of concept is implemented. A long-lived local service, SSE transport, ColorBerry frontend, and Beeper/Matrix bridge are deliberately not part of this phase. The next step is to wrap this adapter with one serialized tab owner and authenticated local transport, retaining request IDs and normalized content independently of any frontend.

The subsequent persistent localhost HTTP/SSE service phase is documented separately in [docs/SERVICE_VERIFICATION.md](docs/SERVICE_VERIFICATION.md), with its lifecycle, reconnection, and shutdown evidence.
