import { AdapterError, type Status } from '../types.js';

export type HealthState = 'connecting' | 'usable' | 'generating' | 'cdp_unavailable'
  | 'approval_required_or_rejected' | 'no_chatgpt_tab' | 'ambiguous_tab' | 'tab_locked'
  | 'unauthenticated' | 'authentication_unknown' | 'navigation_changed' | 'dom_assumptions_failed'
  | 'page_error' | 'challenge' | 'draft_present' | 'shutting_down' | 'stopped';
export class ServiceError extends Error {
  constructor(public code: string, message: string, public httpStatus = 400, public state?: HealthState) {
    super(message); this.name = 'ServiceError';
  }
}
export function fromStatus(s: Status): HealthState {
  if (!s.connected) return 'cdp_unavailable';
  if (s.login === 'logged-out') return 'unauthenticated';
  if (s.reason === 'challenge') return 'challenge';
  if (s.reason === 'page-error') return 'page_error';
  if (s.login !== 'authenticated') return 'authentication_unknown';
  if (!s.usable) return 'dom_assumptions_failed';
  if (s.generating) return 'generating';
  if (s.draftPresent) return 'draft_present';
  return 'usable';
}
/** Never forward raw Playwright messages: they can contain selectors, URLs or page text. */
export function publicError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  if (error instanceof AdapterError) {
    const code = error.code;
    if (code === 'TAB_SELECTION') {
      const none = Array.isArray(error.details?.tabs) && error.details.tabs.length === 0;
      return new ServiceError(code, none ? 'No eligible selected ChatGPT tab is open.' : 'Select exactly one ChatGPT tab.', 503, none ? 'no_chatgpt_tab' : 'ambiguous_tab');
    }
    if (code === 'TAB_LOCKED') return new ServiceError(code, 'Another adapter owns the selected tab.', 503, 'tab_locked');
    if (code === 'DISCONNECTED') return new ServiceError(code, 'Chrome/CDP or the selected tab is unavailable. Restart the service after restoring it.', 503, 'cdp_unavailable');
    if (['WRONG_PAGE', 'CONVERSATION_CHANGED', 'CONVERSATION_MISMATCH', 'OBSERVER_LOST'].includes(code)) return new ServiceError(code, 'The selected conversation changed or its observation was lost. Inspect the tab before retrying.', 409, 'navigation_changed');
    if (code === 'BUSY') return new ServiceError(code, 'The selected tab is busy.', 409);
    if (code === 'DRAFT_PRESENT') return new ServiceError(code, 'An existing draft will not be overwritten.', 409, 'draft_present');
    if (code === 'GENERATION_ACTIVE') return new ServiceError(code, 'ChatGPT is already generating.', 409, 'generating');
    if (code === 'PAGE_UNUSABLE' || code === 'NAVIGATION_FAILED' || code === 'GENERATION_FAILED') {
      const reason = error.details?.reason;
      const state: HealthState = error.details?.login === 'logged-out' || reason === 'logged-out' ? 'unauthenticated' : reason === 'challenge' ? 'challenge' : reason === 'page-error' ? 'page_error' : 'dom_assumptions_failed';
      return new ServiceError(code, 'The ChatGPT page needs attention; inspect status and the selected tab.', 409, state);
    }
    if (['MISSING_LOCATOR', 'AMBIGUOUS_LOCATOR', 'SEND_DISABLED', 'COMPOSER_CHANGED', 'HISTORY_UNAVAILABLE'].includes(code)) return new ServiceError(code, 'Expected ChatGPT DOM controls are missing, ambiguous, or changed.', 409, 'dom_assumptions_failed');
    if (code === 'ABORTED') return new ServiceError(code, 'Observation cancelled; ChatGPT may still be generating.', 409);
    if (code.startsWith('INVALID_') || code === 'EMPTY_MESSAGE') return new ServiceError(code, 'Invalid adapter input.', 400);
    if (['SUBMISSION_UNCONFIRMED', 'GENERATION_TIMEOUT', 'NAVIGATION_TIMEOUT'].includes(code)) return new ServiceError(code, 'The operation could not be verified in time. Inspect the tab; do not resend automatically.', 504);
    return new ServiceError(code, 'The adapter could not complete the operation.', 500);
  }
  const message = error instanceof Error ? error.message : '';
  if (/closed|disconnected|ECONNREFUSED|ECONNRESET/i.test(message)) return new ServiceError('CDP_UNAVAILABLE', 'Chrome/CDP is unavailable.', 503, 'cdp_unavailable');
  if (/context was destroyed|navigation/i.test(message)) return new ServiceError('NAVIGATION_CHANGED', 'The page navigated during the operation.', 409, 'navigation_changed');
  return new ServiceError('ADAPTER_FAILURE', 'The adapter failed; inspect the selected page and opt-in diagnostics.', 500, 'dom_assumptions_failed');
}
export function errorJSON(error: ServiceError) {
  return { code: error.code, message: error.message, ...(error.state ? { state: error.state } : {}) };
}
