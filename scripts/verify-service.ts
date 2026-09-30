/** Explicit live smoke test. Creates one disposable chat; never modifies an existing chat. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
if (!process.argv.includes('--live')) throw new Error('This sends two prompts to a new ChatGPT chat. Invoke explicitly with --live.');
const base = process.env.CHATGPT_SERVICE_URL ?? 'http://127.0.0.1:3210';
const endpoint = new URL(base);
if (endpoint.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(endpoint.hostname)) throw new Error('Use a loopback HTTP service');
async function api(path:string, body?:unknown) {
  const response=await fetch(base+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw new Error(`HTTP ${response.status}: ${data.error?.code}`);return data;
}
interface Event {id:number;type:string;data:any}
async function* events(path:string,after=0,signal?:AbortSignal):AsyncGenerator<Event> {
  const response=await fetch(base+path,{headers:{'Last-Event-ID':String(after)},signal});
  assert.equal(response.status,200);const reader=response.body!.getReader();const decoder=new TextDecoder();let buffer='';
  try {
    while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let index:number;
      while((index=buffer.indexOf('\n\n'))!==-1){const frame=buffer.slice(0,index);buffer=buffer.slice(index+2);const data=frame.match(/^data: (.+)$/m);if(data)yield {id:Number(frame.match(/^id: (\d+)$/m)![1]),type:frame.match(/^event: (.+)$/m)![1],data:JSON.parse(data[1])};}
    }
  }finally{await reader.cancel().catch(()=>{});}
}
const initial=await api('/status');assert.equal(initial.state,'usable');assert.equal(initial.connectionAttempts,1);
const fresh=await api('/conversations',{});assert.equal(fresh.id,null);
assert.equal((await api('/conversation')).id,null);assert.equal((await api('/turns')).length,0);
const recent=await api('/conversations/recent?limit=5');assert(recent.conversations.length>0);assert(recent.conversations.every((c:any)=>c.title&&c.id&&c.url));
const requestId=randomUUID();
const first=await api('/messages',{requestId,expectedConversationId:null,message:'Disposable local HTTP service verification. Explain rainbows in about 180 words, with a heading, two short paragraphs, a three-item numbered list, and a two-line Python code block. Do not browse or use tools.'});assert.equal(first.id,requestId);
let cursor=0;let snapshots=0;let structured=0;let completed=false;const controller=new AbortController();
for await(const event of events(first.eventsURL,0,controller.signal)) {
  cursor=event.id;if(event.type==='snapshot')snapshots++;if(event.type==='content_snapshot')structured++;
  assert(!['failed','cancelled','completed'].includes(event.type),`Must disconnect during generation; received ${event.type}${event.data?.error?.code ? ': '+event.data.error.code : ''}`);
  if(snapshots>=3){controller.abort();break;}
}
const conflict=await fetch(base+'/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'This incompatible request must never be sent.'})});assert.equal(conflict.status,409);
const busy=await api('/status');assert.equal(busy.busy,true);assert.equal(busy.connectionAttempts,1);
await delay(200);
const disconnectedAt=cursor;
for await(const event of events(first.eventsURL,cursor)) {
  assert(event.id>cursor);cursor=event.id;
  if(event.type==='snapshot')snapshots++;if(event.type==='content_snapshot')structured++;
  if(event.type==='completed')completed=true;
  assert(!['failed','cancelled','reset'].includes(event.type),`Unexpected ${event.type}: ${event.data?.error?.code ?? 'no error code'}`);
}
assert(completed);assert(structured>0);
const result=await api(first.resultURL);assert.equal(result.state,'completed');assert.equal(result.result.turn.content.text,result.text);assert(result.result.conversation.id);
const late=[];for await(const event of events(first.eventsURL,cursor-1))late.push(event);assert.equal(late.at(-1)?.type,'completed');
const opened=await api('/conversation/open',{conversation:result.result.conversation.url});assert.equal(opened.id,result.result.conversation.id);
const turns=await api('/turns');assert(turns.length>=2);
const second=await api('/messages',{expectedConversationId:opened.id,message:'Second and final disposable service test: give about 70 words describing why a prism separates white light, with a short bullet list. No browsing or tools.'});
let secondSnapshots=0;let secondCompleted=false;
for await(const event of events(second.eventsURL)){if(event.type==='snapshot')secondSnapshots++;if(event.type==='completed')secondCompleted=true;assert(!['failed','cancelled'].includes(event.type),`Unexpected ${event.type}: ${event.data?.error?.code ?? 'no error code'}`);}
assert(secondCompleted);const final=await api('/status');assert.equal(final.state,'usable');assert.equal(final.connectionAttempts,1);assert.equal(final.instanceId,initial.instanceId);
console.log(JSON.stringify({passed:true,instanceId:final.instanceId,connectionAttempts:final.connectionAttempts,historyCount:recent.conversations.length,first:{snapshotEvents:snapshots,structuredSnapshots:structured,disconnectedAtEvent:disconnectedAt,lastEvent:cursor,reconnectedDuringGeneration:true,lateReplayCompleted:true,blockTypes:result.result.turn.content.blocks.map((b:any)=>b.type)},second:{snapshotEvents:secondSnapshots,completed:secondCompleted},authenticated:final.adapterStatus.login==='authenticated',idle:!final.adapterStatus.generating},null,2));
