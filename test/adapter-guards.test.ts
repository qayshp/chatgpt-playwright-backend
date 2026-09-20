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
