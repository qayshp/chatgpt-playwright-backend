import { AdapterError, type Logger } from './types.js';

/** Diagnostics are optional and must never interrupt an in-flight browser action. */
export function safeLogger(logger?: Logger): Logger {
  return event => { try { logger?.(event); } catch { /* A logging sink is not a browser-operation failure. */ } };
}
/** A CLI failure must not print Playwright call logs, which can contain prompt text. */
export function diagnosticError(error: unknown) {
  if (!(error instanceof AdapterError)) return { error: 'ADAPTER_FAILURE', message: 'The adapter failed. Check Chrome and the selected tab; opt-in diagnostics contain the last verified stage.' };
  const details: Record<string, unknown> = {};
  for (const key of ['reason', 'login', 'composerCount', 'count', 'selector', 'selectors']) {
    if (error.details?.[key] !== undefined) details[key] = error.details[key];
  }
  return { error: error.code, message: error.message, ...(Object.keys(details).length ? { details } : {}) };
}
