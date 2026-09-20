export type Inline =
  | { type: 'text'; text: string; marks?: ('strong' | 'emphasis' | 'strike')[] }
  | { type: 'code'; text: string }
  | { type: 'link'; url: string; children: Inline[] }
  | { type: 'citation'; label: string; url?: string; reference?: string }
  | { type: 'break' };
export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'list'; ordered: boolean; start?: number; items: Block[][] }
  | { type: 'code'; language?: string; text: string }
  | { type: 'quote'; children: Block[] }
  | { type: 'table'; rows: Inline[][][] }
  | { type: 'separator' }
  | { type: 'image'; alt: string; url?: string };
export interface Content { schemaVersion: 1; text: string; blocks: Block[]; warnings: string[] }
export interface Conversation { id: string | null; url: string; title: string; temporary?: boolean; provisional?: boolean }
export interface Turn { id: string; role: 'user' | 'assistant' | 'system'; content: Content }
export interface Status {
  connected: boolean;
  login: 'authenticated' | 'logged-out' | 'unknown';
  usable: boolean;
  generating: boolean;
  composerCount: number;
  draftPresent: boolean;
  reason?: string;
  conversation: Conversation;
}
export interface RecentConversations {
  conversations: Conversation[];
  stopReason: 'limit' | 'no-progress' | 'max-scrolls' | 'no-scroll-container';
  scrolls: number;
  complete: false; // The UI does not expose a trustworthy total history count.
}
export type ResponseEvent =
  | { type: 'submitted'; requestId: string; conversation: Conversation }
  | { type: 'text'; requestId: string; sequence: number; text: string; elapsedMs: number; observedAt: number }
  | { type: 'content'; requestId: string; turn: Turn; elapsedMs: number }
  | { type: 'done'; requestId: string; conversation: Conversation; turn: Turn; elapsedMs: number; completionEvidence: string[] };
export interface SendOptions { requestId?: string; includeContentSnapshots?: boolean; timeoutMs?: number; signal?: AbortSignal; expectedConversationId?: string | null }
export type Logger = (event: {event: string; at: string; [key: string]: unknown}) => void;
export class AdapterError extends Error {
  constructor(public code: string, message: string, public details?: Record<string, unknown>) { super(message); this.name = 'AdapterError'; }
}
