import { ChatGPTService } from './service.js';
import { connectLocalAdapter } from './connect.js';
import { publicError, errorJSON } from './errors.js';

if (process.argv.includes('--help')) {
  console.log(`Foreground ChatGPT HTTP/SSE service
npm run service

Binds only to 127.0.0.1. CHATGPT_SERVICE_PORT defaults to 3210.
CHATGPT_TAB_URL or CHATGPT_CONVERSATION selects an already open tab.
CHATGPT_CDP_ENDPOINT defaults to chrome (only loopback endpoints allowed).
CHATGPT_DIAGNOSTICS=1 enables body-free adapter/operation diagnostics.
Chrome may ask you to approve remote debugging. GET /status remains available.
SIGINT/SIGTERM shuts down the service without closing Chrome.
No daemon, automatic reconnect, credentials, or on-disk response cache.
See docs/HTTP_API.md for routes, SSE replay, limits, and cancellation semantics.`);
  process.exit(0);
}
const diagnostic = process.env.CHATGPT_DIAGNOSTICS === '1';
const log = (value: unknown) => process.stderr.write(JSON.stringify(value) + '\n');
const service = new ChatGPTService({
  connect: () => connectLocalAdapter({
    endpoint: process.env.CHATGPT_CDP_ENDPOINT,
    tabURL: process.env.CHATGPT_TAB_URL,
    conversation: process.env.CHATGPT_CONVERSATION,
    logger: diagnostic ? log : () => {},
  }),
  logger: e => { if (diagnostic || ['service-listening', 'service-attached', 'service-error', 'service-stopped'].includes(e.event)) log(e); },
});
let stopping = false;
const stop = () => {
  if (stopping) return; stopping = true;
  void service.close().then(() => { process.exitCode = 0; }, error => { log({ error: errorJSON(publicError(error)) }); process.exitCode = 1; });
};
try {
  await service.start(Number(process.env.CHATGPT_SERVICE_PORT ?? 3210));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} catch (error) { log({ error: errorJSON(publicError(error)) }); process.exitCode = 1; }
