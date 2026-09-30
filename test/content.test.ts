import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHTML, safeURL } from '../src/content.js';
import { conversationURL } from '../src/adapter.js';
test('conversation inputs stay on ChatGPT and strip query/fragment',()=>{
 assert.equal(conversationURL('12345678-abcd'),'https://chatgpt.com/c/12345678-abcd');
 assert.equal(conversationURL('https://chatgpt.com/c/12345678-abcd?messageId=x#y'),'https://chatgpt.com/c/12345678-abcd');
 assert.throws(()=>conversationURL('https://evil.test/c/12345678'));
 assert.throws(()=>conversationURL('https://chatgpt.com.evil.test/c/12345678'));
 assert.throws(()=>conversationURL('https://user:pass@chatgpt.com/c/12345678'));
 assert.throws(()=>conversationURL('https://chatgpt.com/'));
});
test('renderer escapes content and rejects executable links',()=>{
 const html=renderHTML({schemaVersion:1,text:'fallback',warnings:[],blocks:[
  {type:'paragraph',children:[{type:'text',text:'<script>alert(1)</script>'},{type:'link',url:'javascript:alert(1)',children:[{type:'text',text:'bad link'}]},{type:'citation',label:'source',url:'https://example.com/?a=1&b=2'}]},
  {type:'code',language:'js" onload="bad',text:'<img onerror=bad>'},
  {type:'heading',level:99,children:[{type:'text',text:'Title'}]},
  {type:'list',ordered:true,start:3,items:[[{type:'paragraph',children:[{type:'text',text:'Item'}]}]]}
 ]});
 assert(!html.includes('<script>'));assert(!html.includes('href="javascript:'));assert(html.includes('&lt;img'));assert(html.includes('<h6>'));assert(html.includes('<ol start="3">'));assert(html.includes('<sup><a href="https://example.com/?a=1&amp;b=2"'));
 assert.equal(safeURL('data:text/html,x'),undefined);
});

test('new-chat provisional URL becomes a permanent ID exactly once',async()=>{
 const {ConversationGuard}=await import('../src/conversation.js');
 const g=new ConversationGuard('https://chatgpt.com/');
 assert(g.accept('https://chatgpt.com/c/WEB:11111111-1111-4111-8111-111111111111'));
 assert(g.accept('https://chatgpt.com/c/22222222-2222-4222-8222-222222222222'));
 assert(!g.accept('https://chatgpt.com/c/11111111-2222'));
 assert(!g.accept('https://chatgpt.com/'));
 assert(!g.accept('https://example.com/'));
});
test('default tab discovery excludes Codex and other non-chat routes',async()=>{
 const {isChatSurfaceURL}=await import('../src/conversation.js');
 assert(isChatSurfaceURL('https://chatgpt.com/'));
 assert(isChatSurfaceURL('https://chatgpt.com/c/12345678'));
 assert(!isChatSurfaceURL('https://chatgpt.com/codex/cloud/settings/analytics#usage'));
 assert(!isChatSurfaceURL('https://chatgpt.com/sites'));
 assert(!isChatSurfaceURL('https://example.com/c/12345678'));
});

test('encoded rollout provisional IDs are not durable and cannot switch conversations',async()=>{
 const {ConversationGuard,idFromURL,provisionalID}=await import('../src/conversation.js');
 const pending='https://chatgpt.com/c/local-chatgpt%3A11111111-1111-4111-8111-111111111111';
 assert(provisionalID(idFromURL(pending)));assert.throws(()=>conversationURL(pending));
 for(const initial of ['https://chatgpt.com/',pending]) {
  const g=new ConversationGuard(initial);
  assert(g.accept(pending));assert(g.accept(pending.replace('%3A',':')));
  assert(!g.accept(pending.replace('11111111','99999999')));
  assert(!g.accept('https://chatgpt.com/'));assert(!g.accept('https://chatgpt.com/sites'));
  assert(g.accept('https://chatgpt.com/c/22222222-2222-4222-8222-222222222222'));
  assert(!g.accept(pending));assert(!g.accept('https://chatgpt.com/c/33333333-3333-4333-8333-333333333333'));
 }
 assert(!new ConversationGuard('https://chatgpt.com/').accept('https://chatgpt.com/c/local-chatgpt%3Anot-a-uuid'));
});
