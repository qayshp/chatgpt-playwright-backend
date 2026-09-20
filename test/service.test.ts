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
