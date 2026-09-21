# ChatGPT browser adapter

A local TypeScript proof of concept that operates the **actual ChatGPT website** through Playwright. It attaches to your running, authenticated Chrome. It does not launch Chrome, automate login, export cookies, use an OpenAI/Codex API, or call ChatGPT's private endpoints.

## Setup

Requires Node.js 22+ and an existing Chrome session. Tested dependency version: Playwright 1.63.0. Dependencies are pinned in `package-lock.json`.

```sh
npm ci
npm run check
npm test
```

In Chrome 144+, open `chrome://inspect/#remote-debugging` and enable **Allow remote debugging for this browser instance**. Keep one ChatGPT tab open. Chrome may ask **Allow remote debugging?** when the adapter attaches; approve the connection in Chrome. No restart, profile copy, or separate login is needed. This grants debugging access to the browser, although the adapter deliberately operates only its selected ChatGPT tab.

The adapter uses `chromium.connectOverCDP('chrome', { noDefaults: true })`. Playwright discovers Chrome's endpoint from its local debugging metadata. It preserves the existing viewport, download behavior, and emulation settings. The CDP attachment's `browser.close()` disconnects the transport; it does not quit the external browser or close its tabs. The adapter never closes a page or browser context.

For a non-default profile/debugging setup, `CHATGPT_CDP_ENDPOINT` can specify a loopback `ws://` or `http://` endpoint. Chrome's new UI-enabled endpoint may not provide `/json/version`; prefer `chrome` discovery instead of assuming `http://localhost:9222` will work.

## Foreground local service

For ColorBerry access through this laptop's tailnet HTTPS name, use `npm run service:tailscale`; see [Tailscale setup and access controls](docs/TAILSCALE.md). The listener remains loopback-only. Plain `npm run service` retains local-only access.

```sh
npm run service
# Equivalent direct command for later supervision:
node --import tsx src/service/main.ts
```

The service listens at `http://127.0.0.1:3210` and owns one persistent CDP connection and one selected ChatGPT tab. Approve Chrome's attachment prompt once at startup if requested. Multiple HTTP requests and SSE reconnects reuse that connection. Ctrl-C/SIGTERM disconnects the service without closing Chrome or its authenticated tab. No launchd setup is included.

Use `GET /status`, `GET /conversation`, `GET /conversations/recent`, `GET /turns`, `POST /conversations`, and `POST /conversation/open` for browser operations. `POST /messages` returns an operation ID; `GET /operations/<id>/events` streams replaceable text and normalized-content snapshots, and `GET /operations/<id>` retrieves current/final state. Incompatible concurrent browser operations return **409 BUSY**; there is no queue. SSE reconnect supports `Last-Event-ID`, bounded replay, and a full-state reset after older events expire from the journal.

See [the HTTP/SSE contract](docs/HTTP_API.md) for complete routes, JSON/event shapes, retention, health states, cancellation, security, and environment variables. [Service verification](docs/SERVICE_VERIFICATION.md) separates fixture coverage from live browser results.

Sends activate the selected ChatGPT tab before clicking its accessible Send button. This can change the foreground tab: live testing found background-tab submission unreliable. Cancellation stops observation only; it does not press ChatGPT's Stop button. The service keeps operation contents in bounded memory for recovery, never in a disk cache. It trusts local processes; remote access requires the explicit Tailscale Serve configuration described above.

## Command line

Run from this directory:

```sh
npm run cli -- status
npm run cli -- current
npm run cli -- list 40
npm run cli -- turns
npm run cli -- new
npm run cli -- open 'https://chatgpt.com/c/CONVERSATION-ID'
npm run cli -- send 'Please explain asynchronous iterators in three short paragraphs.'
printf '%s' 'A multiline message can also come from standard input.' | npm run cli -- send-file -
```

`turns` and `send` deliberately print requested conversation content to standard output. The adapter does not save it. The library and CLI are quiet by default; `CHATGPT_DIAGNOSTICS=1` enables diagnostic JSON on standard error, excluding message bodies, conversation titles, cookies, and tokens. CLI errors are sanitized, including disconnect failures. Invalid command arguments fail before requesting Chrome attachment. Shell history may retain text supplied as a command argument; use `send-file` when appropriate. `npm` adds its own banner; invoke `npx tsx src/cli.ts ...` for pure newline-delimited JSON on stdout.

Codex analytics and other non-chat routes are excluded from automatic selection. If more than one ChatGPT chat tab is open, attachment fails explicitly. Select one:

```sh
CHATGPT_TAB_URL='https://chatgpt.com/c/CONVERSATION-ID' npm run cli -- status
# Or select a tab by conversation identity:
CHATGPT_CONVERSATION='CONVERSATION-ID' npm run cli -- status
```

The command `open` navigates the already selected tab. Selection environment variables identify the **source** tab, not a destination to open automatically.

Each CLI invocation connects and disconnects. Chrome may request approval each time. Use the foreground service above to retain one adapter instance. For development, `npx tsx scripts/live-session.ts` provides a persistent newline-delimited JSON verification console; use `{"action":"status"}`, `{"action":"new"}`, `{"action":"send","text":"Hello"}`, `{"action":"read"}`, `{"action":"list","limit":40}`, `{"action":"open","url":"https://chatgpt.com/c/..."}`, and `{"action":"exit"}`. Its `inspect` action intentionally prints DOM fragments and is only for opt-in diagnosis.

## Backend interface

Save a TypeScript caller in this project and run it with `npx tsx your-script.ts`; no web server or frontend is required.

```ts
import { ChatGPTAdapter, renderHTML } from './src/index.js';

const adapter = await ChatGPTAdapter.connect();
try {
  const status = await adapter.getStatus();
  const current = await adapter.getCurrentConversation();
  const history = await adapter.listRecentConversations({ limit: 40 });
  const turns = await adapter.readVisibleTurns();

  // Optional: navigate only when there is no existing draft or generation.
  // await adapter.openConversation('https://chatgpt.com/c/...');
  // await adapter.createConversation();

  for await (const event of adapter.sendMessage('Explain this in two paragraphs.', {
    expectedConversationId: current.id,
    timeoutMs: 180_000,
  })) {
    if (event.type === 'submitted') console.log(event.conversation);
    if (event.type === 'text') {
      // Replace your displayed response with event.text: these are snapshots,
      // not blindly appendable deltas. ChatGPT can revise earlier markup/text.
      console.log(event.sequence, event.text);
    }
    if (event.type === 'done') {
      console.log(event.turn.content.text);
      console.log(event.turn.content.blocks);
      console.log(renderHTML(event.turn.content));
    }
  }
} finally {
  await adapter.disconnect();
}
```

`createConversation()` opens the new-chat page; a durable conversation ID is normally assigned after the first message. The observed UI briefly uses `/c/WEB:<uuid>`. During that transition, `id` remains `null` and `provisional` is `true`; the `done` event provides the durable ID. The adapter permits this one-way transition while continuing to correlate the submitted user turn. A later change to a different durable conversation fails explicitly. `getStatus()` distinguishes authenticated, logged-out, and unknown states; merely seeing a textbox does not prove authentication.

`sendMessage()` is an async generator. Execution starts when consumed. It yields `submitted`, zero or more `text` snapshots, and one `done`; `includeContentSnapshots: true` additionally yields normalized `content` snapshots and `requestId` can supply the caller’s correlation ID; failures throw `AdapterError` with a stable `code`. Breaking the iterator or aborting its `AbortSignal` cleans up observation but **does not press Stop** or cancel generation in ChatGPT. Check status before the next operation. Never automatically resend after an uncertain submission.

## DOM knowledge and safeguards

Page-side DOM knowledge is in `src/dom-runtime.js`. Semantic Playwright locators and their fallbacks are in `src/selectors.ts`.

| Purpose | Current assumption |
| --- | --- |
| Composer | One visible textbox labelled `Chat with ChatGPT`, `Message ChatGPT`, or `Ask ChatGPT`; fallback `#prompt-textarea` |
| Send | Button named `Send message` or `Send prompt`; fallback `data-testid="send-button"` |
| Authentication | Visible `data-testid="accounts-profile-button"` and no visible Log in/Sign in/Sign up control |
| Conversation | ChatGPT URL containing `/c/<id>`, optionally under a custom GPT path |
| Turns | `data-message-author-role` and `data-message-id` attributes, inside `[data-testid^="conversation-turn-"]`; legacy `article` fallback |
| Answer body | `.markdown` inside a message; non-markdown thinking placeholders are not streamed as answer text. Completed non-markdown content falls back to semantic descendants and text |
| Generation | Stop generating/Stop streaming button or `data-testid="stop-button"` |
| Completion | New matching assistant turn, its Copy response/copy-turn-action-button control, no stop control or streaming marker, and text plus normalized content settled for 700 ms; controls must belong to the new assistant turn |
| Recent chats | Navigation region named `Chat history`, conversation anchors, and a scrollable container determined from DOM scroll geometry |

Before sending, the adapter refuses an existing draft, an active generation, a missing/ambiguous composer, a mismatched expected conversation, or an unusable page. It rechecks the destination and draft immediately before filling the composer. It identifies the submitted user turn by new message ID and matching text, then tracks the following new assistant turn. Hidden branches are excluded. It refuses competing user or assistant responses. It detects page reloads/disconnection and navigation away from the selected conversation, including to other products on chatgpt.com. A process lock prevents two instances of this adapter from controlling the same tab; it cannot prevent manual typing or other automation. Avoid editing the selected tab concurrently: DOM checks reduce race windows but cannot make browser interaction atomic.

Locks contain only the owning process ID and live under the system temporary directory in `chatgpt-browser-adapter-<uid>`. Normal disconnect removes the lock and attempts to dispose the page observer before detaching (bounded to one second if the page is unresponsive). Attachment clears stale observer state after acquiring the lock. A crash may leave a stale lock: verify that the recorded process is gone before removing that lock. Locks are never silently stolen.

A `MutationObserver` watches message and generation-control changes. Node drains updates every 75 ms; a 100 ms page-side heartbeat handles completion without further mutations. The queue is bounded to 256 text snapshots, so slow consumers may miss intermediate snapshots but still receive the latest full text. An empty replacement is a valid update when ChatGPT retracts earlier text. Events include an `observedAt` Unix timestamp in milliseconds. Opt-in progress diagnostics report DOM sample/mutation counts, dropped snapshots, and whether generation/user/assistant controls were detected; completion also reports delivered updates and maximum DOM-observation-to-delivery delay. This is DOM streaming, not network interception. Background-tab timer throttling and large answers may increase latency. See [debugging](docs/DEBUGGING.md) for a private diagnostic workflow.

Recent-chat enumeration allows up to five seconds for an initially empty sidebar to load, then collects links on each bounded scroll, deduplicates IDs, and restores the original scroll position. It stops at the requested limit (maximum 200), maximum scroll count, or repeated lack of progress. It always returns `complete: false` because the UI cannot establish an authoritative history total. Pinned chats and sidebar groups can affect ordering; this is UI order, not a timestamp-sorted account export.

## Content contract

Every response has `schemaVersion: 1`, `text`, `blocks`, and `warnings`.

Blocks include paragraphs, headings, ordered/unordered nested lists, code blocks, quotes, tables, separators, and image descriptions. Inline nodes include text with emphasis marks, inline code, links, citations, and line breaks. Code is plain text with an optional language, read from a declared language class/attribute or a recognized visible code-widget label. Code-widget Copy/Run controls are excluded from the answer text. Citation labels and public DOM URLs are preserved when available; no citation URLs are invented or resolved via private services.

`renderHTML()` creates allowlisted, escaped HTML from this schema. It never returns ChatGPT's arbitrary `innerHTML` and never imports its CSS. Only HTTP, HTTPS, and mailto links survive URL filtering. Images are represented by alt text rather than automatically fetched. Interactive widgets, canvases, media, and tool-specific cards are not fully represented.

## Limitations and next step

This prototype targets the English text-chat UI. UI experiments, localized labels, project/custom-GPT layouts, thinking/tool phases, refusal/error layouts, hidden/virtualized older turns, and citation widgets can change the observed DOM. Copy controls are evidence of a completed rendered turn, not a private protocol guarantee. A user manually stopping a response or editing the chat concurrently may produce states that need additional handling. No background daemon, ColorBerry frontend, or Matrix/Beeper bridge is included. The HTTP service remains separate from the independently usable browser adapter.

The sibling `chatgpt-tui-frontend` now consumes the documented HTTP/SSE contract through an independent Go client. The next step is a real ColorBerry usability check and authenticated access control before any remote exposure. Keep exercising service recovery against browser UI changes and retain explicit snapshot replacement in every consumer. The browser adapter and normalized content schema remain independent of the TUI and a future Beeper bridge. See [review verification](docs/REVIEW_VERIFICATION.md) for the later reliability pass, separate from the original live-browser evidence below.

Live verification passed on 2026-09-20: new-chat send/stream, direct conversation navigation and a second send/stream, normalized content including real citations, and 60 recent chats across lazy loading. One test delivered 63 snapshots with a measured maximum observation-to-delivery delay of 77 ms. See `VERIFICATION.md` for the evidence and limits of these measurements.
