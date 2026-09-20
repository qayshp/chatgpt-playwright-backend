import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ChatGPTService, type AdapterPort, type ServiceOptions } from '../src/service/service.js';
import { ServiceError, publicError } from '../src/service/errors.js';
import { OperationStore } from '../src/service/operations.js';
import { AdapterError, type SendOptions, type ResponseEvent, type Status, type Turn } from '../src/types.js';

const makeTurn = (text: string): Turn => ({ id: 'answer', role: 'assistant', content: { schemaVersion: 1, text, blocks: [{ type: 'paragraph', children: [{ type: 'text', text }] }], warnings: [] } });
class FakeAdapter implements AdapterPort {
  connects = 0; disconnects = 0; sends = 0; navigations = 0;
  disconnected = false; fail?: Error; mode: 'normal' | 'waiting' | 'incomplete' | 'large' = 'normal';
  status: Status = { connected: true, login: 'authenticated', usable: true, generating: false, composerCount: 1, draftPresent: false, conversation: { id: '12345678', url: 'https://chatgpt.com/c/12345678', title: 'Fixture' } };
  async getStatus() { if(this.disconnected)throw new AdapterError('DISCONNECTED','Closed'); return structuredClone(this.status); }
  async getCurrentConversation() { return this.status.conversation; }
  async readVisibleTurns() { return [makeTurn('Existing')]; }
  async listRecentConversations() { return { conversations: [this.status.conversation], stopReason: 'limit' as const, scrolls: 0, complete: false as const }; }
  async openConversation(value: string) { this.navigations++; this.status.conversation = { id: value.split('/').at(-1)!, url: value, title: 'Fixture' }; return this.status.conversation; }
  async createConversation() { this.navigations++; this.status.conversation = { id: null, url: 'https://chatgpt.com/', title: 'New' }; return this.status.conversation; }
  async *sendMessage(_text: string, options: SendOptions = {}): AsyncGenerator<ResponseEvent> {
    this.sends++;
    if(this.status.generating)throw new AdapterError('GENERATION_ACTIVE','Already generating');
    this.status.generating = true;
    try {
      if (this.fail) throw this.fail;
      const requestId = options.requestId!;
      yield { type: 'submitted', requestId, conversation: this.status.conversation };
      for (const [index, text] of ['Original answer', 'Revised answer'].entries()) {
        await delay(25);
        if(options.signal?.aborted)throw new AdapterError('ABORTED','Aborted');
        yield { type: 'text', requestId, text: this.mode==='large'?'x'.repeat(5000):text, sequence: index+1, observedAt: Date.now(), elapsedMs: (index+1)*25 };
        if(options.includeContentSnapshots)yield { type: 'content', requestId, turn: makeTurn(text), elapsedMs: (index+1)*25 };
      }
      if(this.mode==='waiting')while(!options.signal?.aborted && !this.disconnected)await delay(5);
      if(options.signal?.aborted)throw new AdapterError('ABORTED','Aborted');
      if(this.mode==='incomplete')return;
      yield { type: 'done', requestId, conversation: this.status.conversation, turn: makeTurn('Revised answer'), elapsedMs: 70, completionEvidence: ['fixture-complete'] };
    } finally { if(!options.signal?.aborted)this.status.generating=false; }
  }
  async disconnect() { this.disconnects++; this.disconnected=true; }
}
async function setup(options: Partial<ServiceOptions> = {}) {
  const adapter = new FakeAdapter();
  const logs: unknown[]=[];
  const service = new ChatGPTService({ connect: async()=>{adapter.connects++;return adapter;}, logger: e=>logs.push(e), heartbeatMs: 50, ...options });
  const base = await service.start(0); await service.ready;
  const get = async(path:string)=>fetch(base+path);
  const post = async(path:string,body:unknown={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  return {adapter,service,base,get,post,logs};
}
async function waitFor<T>(fn:()=>Promise<T>, predicate:(v:T)=>boolean):Promise<T> {
  for(let i=0;i<150;i++){const v=await fn();if(predicate(v))return v;await delay(10);}throw Error('Condition did not settle');
}
async function finalResult(get:(p:string)=>Promise<Response>,id:string) {
  return waitFor(async()=> (await get('/operations/'+id)).json(),v=>['completed','failed','cancelled'].includes(v.state));
}
function parseEvents(text:string) {
  return text.split('\n\n').filter(x=>x.includes('data: ')).map(x=>({id:Number(x.match(/^id: (\d+)/m)?.[1]),type:x.match(/^event: (.+)/m)?.[1],data:JSON.parse(x.match(/^data: (.+)/m)![1])}));
}
test('one persistent connection serves multiple HTTP operations; SSE reconnect replays snapshots and final result',async()=>{
  const h=await setup();try {
    assert.equal((await (await h.get('/status')).json()).state,'usable');
    assert.equal((await h.get('/conversation')).status,200);
    assert.equal((await h.get('/turns')).status,200);
    assert.equal((await h.get('/conversations/recent?limit=30')).status,200);
    assert.equal((await h.post('/conversations')).status,201);
    assert.equal((await h.post('/conversation/open',{conversation:'12345678'})).status,200);
    const id=randomUUID();const accepted=await h.post('/messages',{message:'PRIVATE_PROMPT_MARKER',requestId:id});assert.equal(accepted.status,202);
    const controller=new AbortController();
    const stream=await fetch(h.base+`/operations/${id}/events`,{signal:controller.signal});
    const reader=stream.body!.getReader();const first=await reader.read();const received=parseEvents(new TextDecoder().decode(first.value));assert(received.length>0);controller.abort();await reader.cancel().catch(()=>{});
    const cursor=received.at(-1)!.id;
    const replay=await fetch(h.base+`/operations/${id}/events`,{headers:{'Last-Event-ID':String(cursor)}});
    const events=parseEvents(await replay.text());assert(events.every(e=>e.id>cursor));assert.equal(events.at(-1)?.type,'completed');
    const snapshots=[...received,...events].filter(e=>e.type==='snapshot');assert.deepEqual(snapshots.map(e=>e.data.text),['Original answer','Revised answer']);
    assert(events.some(e=>e.type==='content_snapshot'));
    const result=await finalResult(h.get,id);assert.equal(result.result.turn.content.text,'Revised answer');
    assert.equal(result.id,id);assert(!JSON.stringify(result).includes('PRIVATE_PROMPT_MARKER'));
    await waitFor(async()=> (await h.get('/status')).json(),s=>!s.busy);
    const late=parseEvents(await (await h.get(`/operations/${id}/events`)).text());assert.equal(late.at(-1)?.type,'completed');
    const second=await h.post('/messages',{message:'Second message'});assert.equal(second.status,202);await finalResult(h.get,(await second.json()).id);
    assert.equal(h.adapter.connects,1);assert.equal(h.adapter.sends,2);assert(!JSON.stringify(h.logs).includes('PRIVATE_PROMPT_MARKER'));
  }finally{await h.service.close();}assert.equal(h.adapter.disconnects,1);
});
test('concurrent mutations are rejected; same request ID reuses operation; cancellation leaves browser generation alone',async()=>{
  const h=await setup();h.adapter.mode='waiting';try {
    const id=randomUUID();const input={message:'Hold',requestId:id};assert.equal((await h.post('/messages',input)).status,202);
    assert.equal((await h.post('/messages',{message:'Race'})).status,409);
    assert.equal((await h.post('/conversation/open',{conversation:'87654321'})).status,409);
    assert.equal((await h.get('/turns')).status,409);
    assert.equal((await h.post('/conversations')).status,409);
    assert.equal((await (await h.post('/messages',input)).json()).reused,true);
    assert.equal((await h.post('/messages',{...input,message:'Different'})).status,409);
    assert.equal(h.adapter.sends,1);assert.equal(h.adapter.navigations,0);
    assert.equal((await h.post(`/operations/${id}/cancel`)).status,202);
    const result=await finalResult(h.get,id);assert.equal(result.state,'cancelled');assert.equal(result.browserMayStillBeGenerating,true);
    const status=await waitFor(async()=> (await h.get('/status')).json(),s=>!s.busy);assert.equal(status.state,'generating');
    const retry=await h.post('/messages',{message:'Still busy browser'});const failure=await finalResult(h.get,(await retry.json()).id);assert.equal(failure.error.code,'GENERATION_ACTIVE');
  }finally{await h.service.close();}
});
test('startup failures remain visible and never trigger automatic reattachment',async()=>{
  for(const [error,state] of [
    [new ServiceError('CDP_UNAVAILABLE','Unavailable',503,'cdp_unavailable'),'cdp_unavailable'],
    [new ServiceError('CDP_APPROVAL_REQUIRED_OR_REJECTED','Prompt',503,'approval_required_or_rejected'),'approval_required_or_rejected'],
    [new AdapterError('TAB_SELECTION','None',{tabs:[]}),'no_chatgpt_tab'],
  ] as const){
    let connects=0;const h=await setup({connect:async()=>{connects++;throw error;}});try{
      for(let i=0;i<3;i++)assert.equal((await (await h.get('/status')).json()).state,state);
      assert.equal((await h.post('/messages',{message:'No'})).status,503);assert.equal(connects,1);
    }finally{await h.service.close();}
  }
});
test('status distinguishes unauthenticated, DOM drift and unexpected navigation failures without leaking raw errors',async()=>{
  const h=await setup();try{
    h.adapter.status.login='logged-out';assert.equal((await (await h.get('/status')).json()).state,'unauthenticated');
    h.adapter.status.login='authenticated';h.adapter.status.usable=false;assert.equal((await (await h.get('/status')).json()).state,'dom_assumptions_failed');
    h.adapter.status.usable=true;h.adapter.fail=new AdapterError('CONVERSATION_CHANGED','PRIVATE_PAGE_TEXT');
    const result=await finalResult(h.get,(await (await h.post('/messages',{message:'x'})).json()).id);
    assert.equal(result.state,'failed');assert.equal(result.error.state,'navigation_changed');assert(!JSON.stringify(result).includes('PRIVATE_PAGE_TEXT'));
    assert(!JSON.stringify(h.logs).includes('PRIVATE_PAGE_TEXT'));
    assert.equal(publicError(new Error('Sensitive unknown DOM text')).message.includes('Sensitive'),false);
  }finally{await h.service.close();}
});
test('SSE replay gaps reset to authoritative latest state; bounded retention expires and evicts',async()=>{
  const h=await setup({limits:{maxEvents:2}});try{
    const id=(await (await h.post('/messages',{message:'x'})).json()).id;await finalResult(h.get,id);
    const events=parseEvents(await (await h.get(`/operations/${id}/events?after=0`)).text());assert.equal(events.length,1);assert.equal(events[0].type,'reset');assert.equal(events[0].data.operation.result.turn.content.text,'Revised answer');
    assert.equal((await h.get(`/operations/${id}/events?after=999999`)).status,400);
    assert.equal((await h.get(`/operations/${id}/events?after=-1`)).status,400);
  }finally{await h.service.close();}
  let now=1000;const store=new OperationStore({ttlMs:50,maxOperations:1,maxEvents:2,maxEventBytes:1024,maxPayloadBytes:512},()=>now);
  const one=store.create('a');one.view.state='completed';one.publish('completed');const two=store.create('b');assert.equal(store.find(one.id),undefined);two.view.state='failed';two.publish('failed');now+=51;assert.equal(store.find(two.id),undefined);
});
test('payload bounds and incomplete adapter streams fail explicitly',async()=>{
  for(const mode of ['large','incomplete'] as const){const h=await setup({limits:{maxPayloadBytes:1024,maxEventBytes:2048}});h.adapter.mode=mode;try{
    const id=(await (await h.post('/messages',{message:'x'})).json()).id;const result=await finalResult(h.get,id);
    assert.equal(result.state,'failed');assert.equal(result.error.code,mode==='large'?'RESULT_TOO_LARGE':'INCOMPLETE_STREAM');
  }finally{await h.service.close();}}
});
test('localhost security rejects cross-origin/Host requests, bad content types, and oversized input',async()=>{
  const h=await setup();try{
    assert.equal((await fetch(h.base+'/status',{headers:{Origin:'https://evil.example'}})).status,403);
    assert.equal((await fetch(h.base+'/status',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
    const status=await new Promise<number>(resolve=>{const r=httpRequest(h.base+'/status',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode!);});r.end();});assert.equal(status,403);
    assert.equal((await fetch(h.base+'/messages',{method:'POST',body:'x'})).status,415);
    assert.equal((await h.post('/messages',{message:'x',extra:true})).status,400);
    assert.equal((await h.post('/messages',{message:'x'.repeat(66*1024)})).status,413);
    assert.equal((await h.get('/conversations/recent?limit=NaN')).status,400);
    assert.equal(h.adapter.sends,0);
  }finally{await h.service.close();}
});
test('shutdown cancels active observation, closes SSE, and disconnects once without a browser-close operation',async()=>{
  const h=await setup();h.adapter.mode='waiting';
  const id=(await (await h.post('/messages',{message:'Wait'})).json()).id;
  const stream=await h.get(`/operations/${id}/events`);const text=stream.text();
  await h.service.close();await h.service.close();
  assert(parseEvents(await text).some(e=>e.type==='cancelled'));assert.equal(h.adapter.disconnects,1);assert.equal(h.service.operations.find(id),undefined);
});
test('shutdown while attachment is pending disconnects a late connection exactly once',async()=>{
  const adapter=new FakeAdapter();let resolve!:(a:AdapterPort)=>void;
  const service=new ChatGPTService({connect:()=>new Promise(r=>{resolve=r;}),shutdownGraceMs:5});await service.start(0);
  const closing=service.close();await delay(10);resolve(adapter);await closing;assert.equal(adapter.disconnects,1);
});

test('successful browser actions remain successful when only the follow-up status check fails', async () => {
  const h = await setup();
  try {
    h.adapter.getStatus = async () => { throw new AdapterError('DISCONNECTED', 'PRIVATE_DISCONNECT_DETAIL'); };
    assert.equal((await h.post('/conversations')).status, 201);
    assert.equal((await h.post('/conversation/open', { conversation: '87654321' })).status, 200);
    assert.equal((await h.get('/turns')).status, 200);
    assert.equal(h.adapter.navigations, 2);
    const status = await (await h.get('/status')).json();
    assert.equal(status.state, 'cdp_unavailable');
    assert.equal(status.adapterStatusStale, true);
    assert.equal(status.busy, false);
    assert(!JSON.stringify(h.logs).includes('PRIVATE_DISCONNECT_DETAIL'));
  } finally { await h.service.close(); }
});

test('HTTP and SSE diagnostics correlate requests without logging private content or caller-controlled URLs', async () => {
  const h = await setup({ limits: { maxEvents: 2 } });
  try {
    h.adapter.status.conversation.title = 'PRIVATE_CHAT_TITLE';
    const id = randomUUID();
    const input = { message: 'PRIVATE_MESSAGE_BODY', requestId: id };
    const response = await h.post('/messages', input);
    const requestId = response.headers.get('x-request-id');
    assert.match(requestId!, /^[a-f0-9-]{36}$/);
    assert.equal((await response.json()).id, id);
    await finalResult(h.get, id);
    await h.post('/messages', input);
    const replay = await h.get(`/operations/${id}/events`);
    assert.equal(parseEvents(await replay.text())[0].type, 'reset');
    const failed = await h.get('/PRIVATE_PATH?secret=PRIVATE_QUERY');
    assert.equal(failed.status, 404);
    assert.notEqual(failed.headers.get('x-request-id'), requestId);
    const logs = await waitFor(async () => h.logs as Record<string, unknown>[], values => values.some(v => v.event === 'sse-closed'));
    const accepted = logs.find(v => v.event === 'operation-accepted');
    assert.equal(accepted?.requestId, requestId);
    assert.equal(accepted?.operationId, id);
    const finished = logs.find(v => v.event === 'operation-finished');
    assert.equal(finished?.textSnapshots, 2);
    assert.equal(finished?.contentSnapshots, 2);
    assert.equal(finished?.submitted, true);
    const stream = logs.find(v => v.event === 'sse-closed');
    assert.equal(stream?.resets, 1);
    assert.equal(stream?.terminal, true);
    assert.equal(stream?.requestId, replay.headers.get('x-request-id'));
    const encoded = JSON.stringify(logs);
    for (const privateValue of ['PRIVATE_MESSAGE_BODY', 'PRIVATE_CHAT_TITLE', 'PRIVATE_PATH', 'PRIVATE_QUERY', 'Original answer', 'Revised answer', 'https://chatgpt.com']) assert(!encoded.includes(privateValue), privateValue);
  } finally { await h.service.close(); }
});

test('an optional logger failure cannot break startup, sends, or cleanup', async () => {
  const h = await setup({ logger: () => { throw new Error('Diagnostic sink unavailable'); } });
  try {
    const response = await h.post('/messages', { message: 'Fixture' });
    assert.equal(response.status, 202);
    assert.equal((await finalResult(h.get, (await response.json()).id)).state, 'completed');
  } finally { await h.service.close(); }
  assert.equal(h.adapter.disconnects, 1);
});

test('a disconnect failure still closes HTTP, clears retained operations, and reports stopped', async () => {
  const h = await setup();
  const id = (await (await h.post('/messages', { message: 'Fixture' })).json()).id;
  await finalResult(h.get, id);
  h.adapter.disconnect = async () => { h.adapter.disconnects++; throw new Error('PRIVATE_DISCONNECT_MESSAGE'); };
  await assert.rejects(h.service.close(), /PRIVATE_DISCONNECT_MESSAGE/);
  assert.equal(h.service.server.listening, false);
  assert.equal(h.service.operations.find(id), undefined);
  assert.equal((await h.service.status()).state, 'stopped');
  assert.equal(h.adapter.disconnects, 1);
  assert(!JSON.stringify(h.logs).includes('PRIVATE_DISCONNECT_MESSAGE'));
});

test('an occupied HTTP port is diagnosed without a misleading browser error or attachment attempt', async () => {
  const h = await setup();
  let connects = 0;
  const second = new ChatGPTService({ connect: async () => { connects++; return new FakeAdapter(); } });
  try {
    await assert.rejects(second.start(Number(new URL(h.base).port)), (error: unknown) => error instanceof ServiceError && error.code === 'LISTEN_ADDRESS_IN_USE');
    assert.equal(connects, 0);
  } finally { await second.close(); await h.service.close(); }
});

test('SSE backpressure catches up through a reset and retains the final result', async () => {
  const h = await setup({ limits: { maxEvents: 2 } });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  h.adapter.sendMessage = async function* (_message: string, options: SendOptions = {}): AsyncGenerator<ResponseEvent> {
    const requestId = options.requestId!;
    yield { type: 'submitted', requestId, conversation: h.adapter.status.conversation };
    await gate;
    for (let sequence = 1; sequence <= 24; sequence++) {
      yield { type: 'text', requestId, text: 'x'.repeat(128 * 1024) + sequence, sequence, observedAt: Date.now(), elapsedMs: sequence };
    }
    yield { type: 'done', requestId, conversation: h.adapter.status.conversation, turn: makeTurn('Final replacement'), elapsedMs: 30, completionEvidence: ['fixture-complete'] };
  };
  try {
    const id = (await (await h.post('/messages', { message: 'Fixture' })).json()).id;
    const response = await h.get(`/operations/${id}/events`);
    release();
    const events = parseEvents(await response.text());
    assert(events.some(event => event.type === 'reset'));
    const last = events.at(-1)!;
    assert.equal(last.type, 'reset');
    assert.equal(last.data.operation.state, 'completed');
    assert.equal(last.data.operation.result.turn.content.text, 'Final replacement');
    const closed = await waitFor(async () => h.logs as Record<string, unknown>[], values => values.some(v => v.event === 'sse-closed'));
    assert(Number(closed.find(v => v.event === 'sse-closed')?.backpressurePauses) > 0);
    assert(h.service.operations.require(id).events.length <= 2);
  } finally { release(); await h.service.close(); }
});

test('SSE subscriber limits reject excess connections and release disconnected slots', async () => {
  const h = await setup(); h.adapter.mode = 'waiting';
  const controllers: AbortController[] = [];
  try {
    const id = (await (await h.post('/messages', { message: 'Fixture' })).json()).id;
    for (let i = 0; i < 32; i++) {
      const controller = new AbortController(); controllers.push(controller);
      assert.equal((await fetch(h.base + `/operations/${id}/events`, { signal: controller.signal })).status, 200);
    }
    assert.equal((await h.get(`/operations/${id}/events`)).status, 503);
    controllers[0].abort();
    await waitFor(async () => h.service.operations.require(id).listeners.size, count => count === 31);
    const controller = new AbortController(); controllers.push(controller);
    assert.equal((await fetch(h.base + `/operations/${id}/events`, { signal: controller.signal })).status, 200);
    assert.equal(h.adapter.connects, 1);
    assert.equal(h.adapter.sends, 1);
  } finally { for (const controller of controllers) controller.abort(); await h.service.close(); }
});

test('initial browser health inspection shares the same exclusive tab reservation as API actions', async () => {
  const adapter = new FakeAdapter();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const getStatus = adapter.getStatus.bind(adapter);
  adapter.getStatus = async () => { await gate; return getStatus(); };
  const service = new ChatGPTService({ connect: async () => adapter });
  const base = await service.start(0);
  try {
    const status = await (await fetch(base + '/status')).json();
    assert.equal(status.state, 'connecting');
    assert.equal(status.activeOperation.kind, 'initialize');
    assert.equal(status.adapterStatusStale, true);
    const response = await fetch(base + '/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 409);
    assert.equal(adapter.navigations, 0);
    release(); await service.ready;
    assert.equal((await (await fetch(base + '/status')).json()).state, 'usable');
  } finally { release(); await service.close(); }
});

test('failure to disconnect a late attachment is reported after HTTP cleanup', async () => {
  const adapter = new FakeAdapter();
  adapter.disconnect = async () => { adapter.disconnects++; throw new Error('PRIVATE_LATE_DISCONNECT'); };
  let resolve!: (adapter: AdapterPort) => void;
  const service = new ChatGPTService({ connect: () => new Promise(r => { resolve = r; }), shutdownGraceMs: 5 });
  await service.start(0);
  const closing = service.close();
  const rejected = assert.rejects(closing, /PRIVATE_LATE_DISCONNECT/);
  await delay(10); resolve(adapter); await rejected;
  assert.equal(service.server.listening, false);
  assert.equal((await service.status()).state, 'stopped');
  assert.equal(adapter.disconnects, 1);
});
