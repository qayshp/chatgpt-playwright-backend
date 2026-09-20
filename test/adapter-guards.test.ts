import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTAdapter, AdapterError } from '../src/index.js';
// A narrow fake page verifies that guard failures cannot reach browser mutations.
function harness(overrides:Record<string,unknown>={}) {
 let mutations=0;
 const page={url:()=> 'https://chatgpt.com/c/12345678',isClosed:()=>false,off:()=>{},goto:()=>{mutations++;},getByRole:()=>{mutations++;}};
 const adapter=new (ChatGPTAdapter as any)({isConnected:()=>true},page,()=>{},'unused') as ChatGPTAdapter;
 adapter.getStatus=async()=>({connected:true,login:'authenticated',usable:true,generating:false,composerCount:1,draftPresent:false,conversation:{id:'12345678',url:page.url(),title:'Test'},...overrides}) as any;
 adapter.getCurrentConversation=async()=>({id:'12345678',url:page.url(),title:'Test'});
 return {adapter,mutations:()=>mutations};
}
const code=(value:string)=>(e:unknown)=>e instanceof AdapterError&&e.code===value;
test('existing drafts prevent send, navigation, and new-chat mutations',async()=>{
 const h=harness({draftPresent:true});
 await assert.rejects(h.adapter.sendMessage('New message').next(),code('DRAFT_PRESENT'));
 await assert.rejects(h.adapter.openConversation('87654321'),code('DRAFT_PRESENT'));
 await assert.rejects(h.adapter.createConversation(),code('DRAFT_PRESENT'));
 assert.equal(h.mutations(),0);
});
test('generating, unusable, and wrong-destination pages prevent sending',async()=>{
 for(const [overrides,expected] of [[{generating:true},'GENERATION_ACTIVE'],[{usable:false,login:'logged-out'},'PAGE_UNUSABLE']] as const){
  const h=harness(overrides);await assert.rejects(h.adapter.sendMessage('Message').next(),code(expected));assert.equal(h.mutations(),0);
 }
 const h=harness();await assert.rejects(h.adapter.sendMessage('Message',{expectedConversationId:'87654321'}).next(),code('CONVERSATION_MISMATCH'));assert.equal(h.mutations(),0);
});
test('history waits for initially empty lazy-loaded links instead of returning premature emptiness',async()=>{
 const h=harness();let scans=0;let restored=false;
 h.adapter['page']={url:()=> 'https://chatgpt.com/c/12345678',isClosed:()=>false,getByRole:()=>({isVisible:async()=>true})} as any;
 h.adapter['call']=async function<T>(_method:string,arg:unknown):Promise<T>{
  if(arg==='restore')restored=true;
  if(arg==='read'){scans++;return {links:scans<2?[]:[{title:'Loaded',url:'https://chatgpt.com/c/12345678'}],scrollable:false,position:0,height:0} as T;}
  return {} as T;
 };
 const result=await h.adapter.listRecentConversations({limit:1});assert.equal(result.conversations[0].title,'Loaded');assert.equal(scans,2);assert(restored);
});

test('an attached tab that leaves a chat surface is rejected before reading or mutating it',async()=>{
 let touched=false;
 const page={url:()=> 'https://chatgpt.com/finances',isClosed:()=>false,title:async()=>{touched=true;return 'Other product';},evaluate:async()=>{touched=true;}};
 const adapter=new (ChatGPTAdapter as any)({isConnected:()=>true},page,()=>{},'unused') as ChatGPTAdapter;
 await assert.rejects(adapter.getCurrentConversation(),code('WRONG_PAGE'));
 await assert.rejects(adapter.getStatus(),code('WRONG_PAGE'));
 await assert.rejects(adapter.sendMessage('must not send').next(),code('WRONG_PAGE'));
 assert.equal(touched,false);
});
test('conversation identity cannot mix a URL and title across navigation',async()=>{
 let url='https://chatgpt.com/c/12345678';
 const page={url:()=>url,isClosed:()=>false,title:async()=>{url='https://chatgpt.com/c/87654321';return 'Different conversation';}};
 const adapter=new (ChatGPTAdapter as any)({isConnected:()=>true},page,()=>{},'unused') as ChatGPTAdapter;
 await assert.rejects(adapter.getCurrentConversation(),code('CONVERSATION_CHANGED'));
});
test('drafts or navigation appearing after initial readiness cannot reach composer fill',async()=>{
 for(const cause of ['draft','navigation'] as const){
  let url='https://chatgpt.com/c/12345678';let fills=0;let stopped=false;
  const locator={filter:()=>({})};
  const page={url:()=>url,isClosed:()=>false,on:()=>{},off:()=>{},bringToFront:async()=>{},getByRole:()=>locator,locator:()=>locator};
  const adapter=new (ChatGPTAdapter as any)({isConnected:()=>true},page,()=>{},'unused') as ChatGPTAdapter;
  adapter.getStatus=async()=>({connected:true,login:'authenticated',usable:true,generating:false,draftPresent:false,composerCount:1,conversation:{id:'12345678',url,title:'Test'}});
  adapter.getCurrentConversation=async()=>({id:'12345678',url,title:'Test'});
  adapter.readVisibleTurns=async()=>{if(cause==='navigation')url='https://chatgpt.com/c/87654321';return [];};
  (adapter as any).unique=async()=>({evaluate:async()=>cause==='draft'?'A newly typed human draft':'',fill:async()=>{fills++;}});
  (adapter as any).call=async(method:string)=>{if(method==='stop')stopped=true;};
  await assert.rejects(adapter.sendMessage('Automated message').next(),code(cause==='draft'?'DRAFT_PRESENT':'CONVERSATION_CHANGED'));
  assert.equal(fills,0);assert(stopped);
 }
});
test('lost CDP connection has a stable error before reading the page',async()=>{
 const adapter=new (ChatGPTAdapter as any)({isConnected:()=>false},{isClosed:()=>false},()=>{},'unused') as ChatGPTAdapter;
 await assert.rejects(adapter.getCurrentConversation(),code('DISCONNECTED'));
});

test('forced disconnect disposes page observation before detaching and never closes a tab',async()=>{
 const order:string[]=[];const logs:unknown[]=[];
 const browser={isConnected:()=>true,close:async()=>{order.push('disconnect');}};
 const page={isClosed:()=>false,evaluate:async()=>{order.push('dispose');}};
 const adapter=new (ChatGPTAdapter as any)(browser,page,(e:unknown)=>logs.push(e),'/nonexistent-chatgpt-test-lock') as ChatGPTAdapter;
 (adapter as any).busy=true;
 await assert.rejects(adapter.disconnect(),code('BUSY'));assert.equal(order.length,0);
 await adapter.disconnect({force:true});await adapter.disconnect({force:true});
 assert.deepEqual(order,['dispose','disconnect']);assert(JSON.stringify(logs).includes('observer-cleanup'));
});
