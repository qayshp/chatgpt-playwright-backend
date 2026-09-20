import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Status, Conversation, Turn, RecentConversations, ResponseEvent, SendOptions, Logger } from '../types.js';
import { conversationURL } from '../adapter.js';
import { ServiceError, publicError, errorJSON, fromStatus, type HealthState } from './errors.js';
import { OperationStore, type Operation, type OperationView, type Limits, terminal } from './operations.js';

/** Only this transport-independent port couples the service to the browser library. */
export interface AdapterPort {
  getStatus(): Promise<Status>;
  getCurrentConversation(): Promise<Conversation>;
  readVisibleTurns(): Promise<Turn[]>;
  listRecentConversations(options?: { limit?: number; maxScrolls?: number }): Promise<RecentConversations>;
  openConversation(value: string): Promise<Conversation>;
  createConversation(): Promise<Conversation>;
  sendMessage(text: string, options?: SendOptions): AsyncIterable<ResponseEvent>;
  disconnect(options?: { force?: boolean }): Promise<void>;
}
export interface ServiceOptions {
  connect: () => Promise<AdapterPort>;
  logger?: Logger;
  limits?: Partial<Limits>;
  heartbeatMs?: number;
  shutdownGraceMs?: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BODY_LIMIT = 64 * 1024;
// Never include user-controlled paths or query values in diagnostics.
function routeLabel(rawURL: string | undefined): string {
  const path = rawURL?.split('?')[0];
  if (['/status', '/conversation', '/turns', '/conversations/recent', '/conversation/open', '/conversations', '/messages'].includes(path ?? '')) return path!;
  const match = path?.match(/^\/operations\/[a-f0-9-]+(?:\/(events|cancel))?$/i);
  return match ? `/operations/:id${match[1] ? `/${match[1]}` : ''}` : 'unknown';
}
const json = (res: ServerResponse, code: number, value: unknown) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
};
function requireKeys(body: Record<string, unknown>, keys: string[]) {
  if (Object.keys(body).some(k => !keys.includes(k))) throw new ServiceError('INVALID_INPUT', 'Unknown request field.');
}
async function bodyJSON(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new ServiceError('CONTENT_TYPE', 'Use application/json.', 415);
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new ServiceError('CONTENT_ENCODING', 'Compressed request bodies are not supported.', 415);
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > BODY_LIMIT) throw new ServiceError('BODY_TOO_LARGE', 'Request body exceeds 64 KiB.', 413);
    chunks.push(chunk);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ServiceError('INVALID_JSON', 'Invalid JSON body.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ServiceError('INVALID_INPUT', 'Expected a JSON object.');
  return value as Record<string, unknown>;
}
export class ChatGPTService {
  readonly instanceId = randomUUID();
  readonly operations: OperationStore;
  readonly server = createServer((req, res) => this.handle(req, res));
  ready: Promise<void> = Promise.resolve();
  private adapter?: AdapterPort;
  private health: HealthState = 'connecting';
  private lastError?: ReturnType<typeof errorJSON>;
  private adapterStatus?: Status;
  private active?: { id: string; kind: string; task?: Promise<void>; operation?: Operation };
  private closing = false;
  private closePromise?: Promise<void>;
  private streams = new Set<ServerResponse>();
  private janitor?: NodeJS.Timeout;
  private port = 0;
  private started = false;
  private connectionAttempts = 0;
  private connectedAt?: string;
  private attachmentShutdownError?: unknown;
  constructor(private options: ServiceOptions) { this.operations = new OperationStore(options.limits); }
  private log(event: string, data: Record<string, unknown> = {}) {
    // Diagnostics must never turn a successful browser action into an API failure.
    try { this.options.logger?.({ event, at: new Date().toISOString(), ...data }); } catch { /* Optional observer only. */ }
  }
  private handle(req: IncomingMessage, res: ServerResponse) {
    const requestId = randomUUID();
    const startedAt = performance.now();
    const route = routeLabel(req.url);
    const method = ['GET', 'POST', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method ?? '') ? req.method : 'OTHER';
    res.setHeader('X-Request-ID', requestId);
    this.log('http-request-started', { requestId, route, method });
    let finished = false;
    const record = (outcome: 'finished' | 'disconnected') => {
      if (finished) return;
      finished = true;
      this.log('http-request-finished', { requestId, route, method, status: res.headersSent ? res.statusCode : undefined, outcome, elapsedMs: Math.round(performance.now() - startedAt) });
    };
    res.once('finish', () => record('finished'));
    res.once('close', () => record('disconnected'));
    void this.route(req, res).catch(error => {
      const e = publicError(error);
      this.log('http-request-failed', { requestId, route, code: e.code, status: e.httpStatus });
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      json(res, e.httpStatus, { error: errorJSON(e) });
    });
  }
  async start(port = 3210): Promise<string> {
    if (this.started) throw new Error('Service already started');
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid local port');
    this.started = true;
    this.server.requestTimeout = 10_000;
    this.server.headersTimeout = 10_000;
    this.server.maxHeadersCount = 40;
    try {
      await new Promise<void>((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(port, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new ServiceError('LISTEN_ADDRESS_IN_USE', 'The local service port is already in use. Choose another CHATGPT_SERVICE_PORT or stop the other service.', 503);
      throw new ServiceError('LISTEN_FAILED', 'The local HTTP listener could not start. Check the port and local permissions.', 503);
    }
    this.port = (this.server.address() as { port: number }).port;
    this.janitor = setInterval(() => this.operations.prune(), 30_000); this.janitor.unref();
    this.ready = this.attachOnce();
    this.log('service-listening', { port: this.port, instanceId: this.instanceId });
    return `http://127.0.0.1:${this.port}`;
  }
  private async attachOnce() {
    this.connectionAttempts++;
    try {
      const adapter = await this.options.connect();
      if (this.closing) {
        try { await adapter.disconnect({ force: true }); }
        catch (error) { this.attachmentShutdownError = error; }
        return;
      }
      this.adapter = adapter;
      this.connectedAt = new Date().toISOString();
      if (!this.closing) await this.exclusive('initialize', async () => undefined);
      this.log('service-attached', { instanceId: this.instanceId });
    } catch (error) { if (!this.closing) this.remember(error); }
  }
  private remember(error: unknown) {
    const e = publicError(error); this.lastError = errorJSON(e);
    if (e.state) this.health = e.state;
    this.log('service-error', { code: e.code, state: e.state }); return e;
  }
  private requireAdapter(): AdapterPort {
    if (this.closing) throw new ServiceError('SHUTTING_DOWN', 'Service is shutting down.', 503, 'shutting_down');
    if (!this.adapter) throw new ServiceError('NOT_CONNECTED', 'The browser connection is not ready. Inspect GET /status.', 503, this.health);
    return this.adapter;
  }
  private reserve(kind: string, id: string = randomUUID()) {
    this.requireAdapter();
    if (this.active) throw new ServiceError('BUSY', `Tab is busy with operation ${this.active.id}.`, 409);
    const active = { kind, id } as NonNullable<ChatGPTService['active']>; this.active = active; return active;
  }
  private async refreshStatus() {
    const status = await this.adapter!.getStatus();
    this.adapterStatus = status; this.health = fromStatus(status); this.lastError = undefined; return status;
  }
  async status() {
    if (this.adapter && !this.active && !this.closing) {
      const active = this.reserve('status');
      const task=this.refreshStatus();active.task=task.then(()=>{},()=>{});
      try { await task; } catch (error) { this.remember(error); } finally { if (this.active === active) this.active = undefined; }
    }
    return { apiVersion: 1, instanceId: this.instanceId, state: this.health, connectionAttempts: this.connectionAttempts, connectedAt: this.connectedAt,
      approvalMayBeRequired: this.health === 'connecting' || this.health === 'approval_required_or_rejected',
      busy: !!this.active, activeOperation: this.active ? { id: this.active.id, kind: this.active.kind } : null,
      adapterStatus: this.adapterStatus, adapterStatusStale: !!this.active || !!this.lastError || this.closing,
      error: this.lastError, retention: this.operations.limits };
  }
  private async exclusive<T>(kind: string, action: (adapter: AdapterPort) => Promise<T>): Promise<T> {
    const active = this.reserve(kind);
    const task = (async () => {
      try {
        const result = await action(this.adapter!);
        // A failed follow-up health read cannot undo a successful mutation. Returning an
        // error here invited clients to repeat an already completed navigation/new chat.
        try { await this.refreshStatus(); } catch (error) { this.remember(error); }
        return result;
      } catch (error) { throw this.remember(error); }
      finally { if (this.active === active) this.active = undefined; }
    })();
    active.task = task.then(() => {}, () => {}); return task;
  }
  private send(body: Record<string, unknown>, httpRequestId: string) {
    requireKeys(body, ['message', 'requestId', 'timeoutMs', 'expectedConversationId']);
    if (typeof body.message !== 'string' || !body.message.trim()) throw new ServiceError('INVALID_INPUT', 'message must be a nonempty string.');
    if (body.requestId !== undefined && (typeof body.requestId !== 'string' || !UUID.test(body.requestId))) throw new ServiceError('INVALID_INPUT', 'requestId must be a UUID.');
    if (body.timeoutMs !== undefined && (!Number.isInteger(body.timeoutMs) || Number(body.timeoutMs) < 1000 || Number(body.timeoutMs) > 600_000)) throw new ServiceError('INVALID_INPUT', 'timeoutMs must be an integer between 1000 and 600000.');
    if (body.expectedConversationId !== undefined && body.expectedConversationId !== null && (typeof body.expectedConversationId !== 'string' || !/^[a-zA-Z0-9-]{8,128}$/.test(body.expectedConversationId))) throw new ServiceError('INVALID_INPUT', 'expectedConversationId must be a stable conversation ID or null.');
    const fingerprint = this.operations.fingerprint([body.message, body.timeoutMs ?? 180000, Object.hasOwn(body, 'expectedConversationId'), body.expectedConversationId]);
    if (body.requestId) {
      const old = this.operations.find(body.requestId as string);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new ServiceError('REQUEST_ID_CONFLICT', 'requestId was used with different input.', 409);
        this.log('operation-reused', { requestId: httpRequestId, operationId: old.id, state: old.view.state });
        return { operation: old.view, reused: true };
      }
    }
    const active = this.reserve('send', body.requestId as string | undefined);
    let op: Operation;
    try { op = this.operations.create(fingerprint, active.id); } catch (error) { this.active = undefined; throw error; }
    active.operation = op;
    this.log('operation-accepted', { requestId: httpRequestId, operationId: op.id });
    active.task = this.runSend(op, body.message as string, {
      requestId: op.id, signal: op.controller.signal, includeContentSnapshots: true, timeoutMs: body.timeoutMs as number | undefined,
      ...(Object.hasOwn(body, 'expectedConversationId') ? { expectedConversationId: body.expectedConversationId as string | null } : {})
    }).finally(() => { if (this.active === active) this.active = undefined; });
    return { operation: op.view, reused: false };
  }
  private update(op: Operation, type: string, data: Record<string, unknown>, patch: Partial<OperationView>) {
    if (Buffer.byteLength(JSON.stringify({ operationId: op.id, ...data })) > op.limits.maxPayloadBytes) throw new ServiceError('RESULT_TOO_LARGE', 'Response exceeds the in-memory payload limit; inspect the browser.', 413);
    Object.assign(op.view, patch); op.publish(type, data);
  }
  private async runSend(op: Operation, message: string, options: SendOptions) {
    const startedAt = performance.now();
    let textSnapshots = 0; let contentSnapshots = 0; let submitted = false;
    try {
      let final: Extract<ResponseEvent,{type:'done'}> | undefined;
      for await (const event of this.adapter!.sendMessage(message, options)) {
        if (op.controller.signal.aborted) throw new ServiceError('CANCELLED', 'Observation cancelled; browser generation was not stopped.', 409);
        if (event.requestId !== op.id) throw new ServiceError('REQUEST_ID_MISMATCH', 'Adapter response identity did not match this operation.', 500, 'dom_assumptions_failed');
        switch (event.type) {
          case 'submitted':
            submitted = true;
            this.health='generating';
            this.update(op, 'submitted', { requestId: event.requestId, conversation: event.conversation }, { state: 'submitted', conversation: event.conversation }); break;
          case 'text':
            textSnapshots++;
            this.update(op, 'snapshot', { requestId: event.requestId, text: event.text, sequence: event.sequence, observedAt: event.observedAt, elapsedMs: event.elapsedMs }, { state: 'streaming', text: event.text }); break;
          case 'content':
            contentSnapshots++;
            this.update(op, 'content_snapshot', { requestId: event.requestId, turn: event.turn, elapsedMs: event.elapsedMs }, { state: 'streaming', content: event.turn }); break;
          case 'done': {
            final=event;break;
          }
        }
      }
      if (!final) throw new ServiceError('INCOMPLETE_STREAM', 'Adapter ended without verified completion.', 500, 'dom_assumptions_failed');
      if(!this.closing){try{await this.refreshStatus();}catch(error){this.remember(error);}}
      const result={conversation:final.conversation,turn:final.turn,elapsedMs:final.elapsedMs,completionEvidence:final.completionEvidence};
      if(this.active?.operation===op)this.active=undefined;
      this.update(op,'completed',{requestId:op.id,result},{state:'completed',conversation:final.conversation,result,content:final.turn,text:final.turn.content.text});
    } catch (error) {
      if(this.active?.operation===op)this.active=undefined;
      if (op.controller.signal.aborted) {
        op.view.state = 'cancelled'; op.view.cancellationMode = 'observation-only'; op.view.browserMayStillBeGenerating = true;
        op.publish('cancelled', { cancellationMode: 'observation-only', browserMayStillBeGenerating: true });
      } else {
        const e = this.remember(error); op.view.state = 'failed'; op.view.error = errorJSON(e); op.view.browserMayStillBeGenerating = true;
        op.publish('failed', { error: op.view.error, browserMayStillBeGenerating: true });
      }
    } finally {
      message = ''; // Do not retain the submitted prompt in operation state.
      this.log('operation-finished', { operationId: op.id, state: op.view.state, submitted, textSnapshots, contentSnapshots, elapsedMs: Math.round(performance.now() - startedAt), code: op.view.error?.code });
    }
  }
  private cancel(op: Operation) {
    if (!terminal(op.view.state) && !op.controller.signal.aborted) {
      op.view.state = 'cancelling'; op.view.cancellationMode = 'observation-only';
      op.controller.abort(); op.publish('cancelling', { cancellationMode: 'observation-only' });
    }
    return op.view;
  }
  private protect(req: IncomingMessage) {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) throw new ServiceError('HOST_FORBIDDEN', 'Unrecognized local Host header.', 403);
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) throw new ServiceError('ORIGIN_FORBIDDEN', 'Cross-origin requests are not allowed.', 403);
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site']))) throw new ServiceError('ORIGIN_FORBIDDEN', 'Cross-site requests are not allowed.', 403);
  }
  private async route(req: IncomingMessage, res: ServerResponse) {
    this.protect(req);
    const url = new URL(req.url!, 'http://127.0.0.1');
    const path = url.pathname;
    if (req.method === 'GET' && path === '/status') { json(res, 200, await this.status()); return; }
    if (this.closing) throw new ServiceError('SHUTTING_DOWN', 'Service is shutting down.', 503);
    if (req.method === 'GET' && path === '/conversation') { json(res, 200, await this.exclusive('current', a => a.getCurrentConversation())); return; }
    if (req.method === 'GET' && path === '/turns') { json(res, 200, await this.exclusive('turns', a => a.readVisibleTurns())); return; }
    if (req.method === 'GET' && path === '/conversations/recent') {
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 30;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ServiceError('INVALID_INPUT', 'limit must be an integer between 1 and 200.');
      json(res, 200, await this.exclusive('recent', a => a.listRecentConversations({ limit }))); return;
    }
    if (req.method === 'POST' && path === '/conversation/open') {
      const body = await bodyJSON(req); requireKeys(body, ['conversation']);
      if (typeof body.conversation !== 'string') throw new ServiceError('INVALID_INPUT', 'conversation must be an ID or URL.');
      const destination = conversationURL(body.conversation);
      json(res, 200, await this.exclusive('open', a => a.openConversation(destination))); return;
    }
    if (req.method === 'POST' && path === '/conversations') {
      requireKeys(await bodyJSON(req), []); json(res, 201, await this.exclusive('new', a => a.createConversation())); return;
    }
    if (req.method === 'POST' && path === '/messages') {
      const result = this.send(await bodyJSON(req), String(res.getHeader('X-Request-ID'))); const id = result.operation.id;
      json(res, 202, { id, reused: result.reused, state: result.operation.state, eventsURL: `/operations/${id}/events`, resultURL: `/operations/${id}` }); return;
    }
    const match = path.match(/^\/operations\/([a-f0-9-]+)(?:\/(events|cancel))?$/i);
    if (match) {
      const op = this.operations.require(match[1]);
      if (req.method === 'GET' && !match[2]) { json(res, 200, op.view); return; }
      if (req.method === 'POST' && match[2] === 'cancel') { requireKeys(await bodyJSON(req), []); json(res, terminal(op.view.state) ? 200 : 202, this.cancel(op)); return; }
      if (req.method === 'GET' && match[2] === 'events') {
        const cursor = req.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0';
        if (typeof cursor !== 'string' || !/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw new ServiceError('INVALID_CURSOR', 'Use a nonnegative numeric Last-Event-ID or after cursor.');
        this.stream(res, op, Number(cursor)); return;
      }
    }
    throw new ServiceError('NOT_FOUND', 'Unknown route or method.', 404);
  }
  private stream(res: ServerResponse, op: Operation, after: number) {
    op.replay(after);
    if (this.streams.size >= 32) throw new ServiceError('STREAM_LIMIT', 'Too many SSE clients.', 503);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
    this.streams.add(res);
    const requestId = res.getHeader('X-Request-ID');
    const startedAt = performance.now();
    let sentEvents = 0; let resets = 0; let backpressurePauses = 0;
    this.log('sse-opened', { requestId, operationId: op.id, after });
    let cursor = after; let blocked = false;
    const write = (id: number, type: string, data: unknown) => {
      cursor = id; sentEvents++;
      if (type === 'reset') resets++;
      blocked = !res.write(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      if (blocked) backpressurePauses++;
    };
    const pump = () => {
      if (res.destroyed || res.writableEnded || blocked) return;
      const replay = op.replay(cursor);
      if (replay.reset) write(op.view.lastEventId, 'reset', { operationId: op.id, operation: op.view });
      else for (const event of replay.events) { write(event.id, event.type, event.data); if (blocked) break; }
      if (!blocked && terminal(op.view.state) && cursor === op.view.lastEventId) res.end();
    };
    const drain = () => { blocked = false; pump(); };
    res.on('drain', drain); op.listeners.add(pump);
    const heartbeat = setInterval(() => { if (!blocked && !res.writableEnded) blocked = !res.write(': keepalive\n\n'); }, this.options.heartbeatMs ?? 15_000);
    heartbeat.unref();
    res.once('close', () => {
      clearInterval(heartbeat); op.listeners.delete(pump); this.streams.delete(res); res.off('drain', drain);
      this.log('sse-closed', { requestId, operationId: op.id, after, cursor, sentEvents, resets, backpressurePauses, terminal: terminal(op.view.state), elapsedMs: Math.round(performance.now() - startedAt) });
    });
    pump();
  }
  close(): Promise<void> {
    return this.closePromise ??= this.shutdown();
  }
  private async shutdown() {
    this.closing = true; this.health = 'shutting_down'; clearInterval(this.janitor);
    const httpClosed = new Promise<void>(resolve => this.server.close(() => resolve()));
    this.active?.operation && this.cancel(this.active.operation);
    // Closing this CDP attachment never closes Chrome. Bound teardown if an operation is stuck.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled([this.ready, this.active?.task ?? Promise.resolve()]), new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.shutdownGraceMs ?? 8000); })]);
    clearTimeout(timer);
    try {
      const adapter = this.adapter; this.adapter = undefined;
      if (adapter) await adapter.disconnect({ force: true });
      // A connection still pending at shutdown is disconnected when it eventually settles.
      await this.ready;
      if (this.attachmentShutdownError) throw this.attachmentShutdownError;
    } catch (error) {
      this.log('service-disconnect-failed', { code: publicError(error).code });
      throw error;
    } finally {
      // Cleanup still runs if the browser transport rejects its disconnect request.
      for (const res of this.streams) res.end();
      this.server.closeAllConnections(); await httpClosed;
      this.operations.clear(); this.adapterStatus = undefined; this.health = 'stopped'; this.log('service-stopped');
    }
  }
}
