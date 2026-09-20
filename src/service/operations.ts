import { randomUUID, createHash } from 'node:crypto';
import type { Conversation, Turn } from '../types.js';
import { ServiceError, type HealthState } from './errors.js';

export type OperationState = 'accepted' | 'submitted' | 'streaming' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
export const terminal = (state: OperationState) => ['completed', 'failed', 'cancelled'].includes(state);
export interface OperationError { code: string; message: string; state?: HealthState }
export interface OperationView {
  id: string;
  state: OperationState;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  lastEventId: number;
  conversation?: Conversation;
  text?: string;
  content?: Turn;
  result?: { conversation: Conversation; turn: Turn; elapsedMs: number; completionEvidence: string[] };
  error?: OperationError;
  cancellationMode?: 'observation-only';
  browserMayStillBeGenerating?: boolean;
}
export interface OperationEvent { id: number; type: string; data: Record<string, unknown> }
export interface Limits { ttlMs: number; maxOperations: number; maxEvents: number; maxEventBytes: number; maxPayloadBytes: number }
export const DEFAULT_LIMITS: Limits = { ttlMs: 10 * 60_000, maxOperations: 16, maxEvents: 128, maxEventBytes: 2 * 1024 * 1024, maxPayloadBytes: 1024 * 1024 };
export class Operation {
  readonly controller = new AbortController();
  readonly listeners = new Set<() => void>();
  readonly view: OperationView;
  readonly events: { event: OperationEvent; bytes: number }[] = [];
  eventBytes = 0;
  constructor(readonly id: string, readonly fingerprint: string, readonly limits: Limits, private now: () => number) {
    const at = new Date(now()).toISOString();
    this.view = { id, state: 'accepted', createdAt: at, updatedAt: at, lastEventId: 0 };
  }
  publish(type: string, data: Record<string, unknown> = {}) {
    const payload = { operationId: this.id, ...data };
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (bytes > this.limits.maxPayloadBytes) throw new ServiceError('RESULT_TOO_LARGE', 'The response exceeds the in-memory payload limit; inspect the browser for its full content.', 413);
    const event = { id: ++this.view.lastEventId, type, data: payload };
    this.view.updatedAt = new Date(this.now()).toISOString();
    if (terminal(this.view.state)) this.view.expiresAt = new Date(this.now() + this.limits.ttlMs).toISOString();
    this.events.push({ event, bytes }); this.eventBytes += bytes;
    while (this.events.length > 1 && (this.events.length > this.limits.maxEvents || this.eventBytes > this.limits.maxEventBytes)) this.eventBytes -= this.events.shift()!.bytes;
    for (const listener of this.listeners) listener();
  }
  replay(after: number): { reset: boolean; events: OperationEvent[] } {
    if (after > this.view.lastEventId) throw new ServiceError('INVALID_CURSOR', 'Event cursor is ahead of this operation.', 400);
    const first = this.events[0]?.event.id ?? this.view.lastEventId + 1;
    return { reset: after < first - 1, events: after < first - 1 ? [] : this.events.filter(e => e.event.id > after).map(e => e.event) };
  }
}
export class OperationStore {
  private records = new Map<string, Operation>();
  readonly limits: Limits;
  constructor(limits: Partial<Limits> = {}, private now = Date.now) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Operation limits must be positive integers');
    if (this.limits.maxEventBytes < this.limits.maxPayloadBytes) throw new Error('Event budget must fit one maximum payload');
  }
  prune() {
    for (const [id, op] of this.records) if (op.view.expiresAt && Date.parse(op.view.expiresAt) <= this.now()) this.records.delete(id);
  }
  find(id: string): Operation | undefined { this.prune(); return this.records.get(id); }
  require(id: string): Operation { const op = this.find(id); if (!op) throw new ServiceError('OPERATION_NOT_FOUND', 'Operation unknown, expired, evicted, or lost on service restart.', 404); return op; }
  fingerprint(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
  create(fingerprint: string, requestedId?: string): Operation {
    this.prune();
    while (this.records.size >= this.limits.maxOperations) {
      const old = [...this.records.values()].find(o => terminal(o.view.state));
      if (!old) throw new ServiceError('CAPACITY', 'Operation capacity reached.', 503);
      this.records.delete(old.id);
    }
    const id = requestedId ?? randomUUID();
    const op = new Operation(id, fingerprint, this.limits, this.now); this.records.set(id, op); op.publish('accepted'); return op;
  }
  clear() { this.records.clear(); }
}
