import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
const source=await readFile(new URL('../src/dom-runtime.js',import.meta.url),'utf8');
function fixture(extra='') {
 const dom=new JSDOM(`<div data-testid="accounts-profile-button">Profile</div><main><div id="prompt-textarea" role="textbox" contenteditable="true"></div>${extra}</main>`,{url:'https://chatgpt.com/c/12345678',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window;
 Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 w.HTMLElement.prototype.getClientRects=function(this: HTMLElement){return this.hidden?[]:[{width:1,height:1}]} as any;
 w.eval(source);
 return {dom,w,r:(w as any).__chatgptDOMAdapter_v1};
}
const user='<article><div data-message-id="u" data-message-author-role="user">Test</div></article>';
const answer=(text:string,finished=false)=>`<article data-testid="conversation-turn-2"><div data-message-id="a" data-message-author-role="assistant"><div class="markdown"><p>${text}</p></div></div>${finished?'<button data-testid="copy-turn-action-button" aria-label="Copy response">Copy</button>':''}</article>`;
test('status distinguishes authentication, drafts, and ambiguous composers',()=>{
 const {dom,w,r}=fixture();try {
  assert.equal(r.state().login,'authenticated');assert.equal(r.state().usable,true);
  w.document.querySelector('#prompt-textarea')!.textContent='unsent draft';assert.equal(r.state().draftPresent,true);
  w.document.querySelector('main')!.insertAdjacentHTML('beforeend','<div role="textbox" contenteditable="true"></div>');assert.equal(r.state().usable,false);assert.equal(r.state().composerCount,2);
  w.document.body.insertAdjacentHTML('beforeend','<button>Log in</button>');assert.equal(r.state().login,'logged-out');
 }finally{dom.window.close();}
});
test('normalizes semantic blocks, nested lists, links, code and citations',()=>{
 const {dom,r}=fixture(`<article><div data-message-id="a" data-message-author-role="assistant"><div class="markdown"><h2>Title</h2><p>Hello <strong>bold</strong> <a href="https://example.com">link</a><span data-citation-id="ref1"><a href="https://example.org">Source</a></span></p><ol start="2"><li>First<ul><li>Nested</li></ul></li><li>Second</li></ol><pre><code class="language-js">a &lt; b</code></pre><blockquote><p>Quote</p></blockquote><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></div></div><button>Copy</button></article>`);
 try {const c=r.readTurns()[0].content;assert.deepEqual(Array.from(c.blocks,(b:any)=>b.type),['heading','paragraph','list','code','quote','table']);assert.equal(c.blocks[2].items[0][1].type,'list');assert.equal(c.blocks[3].text,'a < b');assert.equal(c.blocks[1].children.at(-1).type,'citation');assert.equal(c.blocks[1].children.at(-1).url,'https://example.org/');assert(!c.text.includes('Copy'));}finally{dom.window.close();}
});
test('emits actual incremental snapshots and requires explicit completion controls',async()=>{
 const {dom,w,r}=fixture();try {
  r.observe({requestId:'r',baselineIds:[],expectedText:'Test',settleMs:30});
  w.document.querySelector('main')!.insertAdjacentHTML('beforeend',user+answer('One'));
  await delay(10);let d=r.drain('r');assert.equal(d.updates[0].text,'One');assert.equal(d.done,false);
  w.document.querySelector('.markdown p')!.textContent='One two';await delay(10);d=r.drain('r');assert.equal(d.updates[0].text,'One two');
  await delay(50);assert.equal(r.drain('r').done,false,'idle text alone cannot finish');
  const article=w.document.querySelectorAll('article')[1];article.insertAdjacentHTML('beforeend','<button data-testid="copy-turn-action-button">Copy</button>');
  w.document.querySelector('main')!.insertAdjacentHTML('beforeend','<button data-testid="stop-button">Stop</button>');assert.equal(r.drain('r').done,false);
  w.document.querySelector('[data-testid="stop-button"]')!.remove();assert.equal(r.drain('r').done,true);
  r.stop('r');assert.throws(()=>r.drain('r'));
 }finally{dom.window.close();}
});
test('never adopts an old assistant answer or another user message',()=>{
 const {dom,w,r}=fixture(answer('Old',true));try {
  r.observe({requestId:'r',baselineIds:['a'],expectedText:'Test',settleMs:0});assert.equal(r.drain('r').done,false);
  w.document.querySelector('main')!.insertAdjacentHTML('beforeend',user.replace('>Test<','>Unexpected<'));
  assert.equal(r.drain('r').error,'unexpected-user-message');
 }finally{dom.window.close();}
});
test('rejects competing assistant answers and explicit page errors',()=>{
 const {dom,w,r}=fixture();try {
  r.observe({requestId:'r',baselineIds:[],expectedText:'Test',settleMs:0});
  w.document.querySelector('main')!.insertAdjacentHTML('beforeend',user+answer('One',true)+answer('Two',true).replace('data-message-id="a"','data-message-id="b"'));
  assert.equal(r.drain('r').error,'ambiguous-assistant-response');
  w.document.body.insertAdjacentHTML('beforeend','<div role="alert">Something went wrong</div>');assert.equal(r.drain('r').error,'page-error');
 }finally{dom.window.close();}
});
test('citation with no DOM URL stays unresolved rather than inventing a URL',()=>{
 const {dom,r}=fixture('<article><div data-message-id="a" data-message-author-role="assistant"><div class="markdown"><p>Fact <span data-citation-id="source-1">1</span></p></div></div></article>');
 try {const citation=r.readTurns()[0].content.blocks[0].children.at(-1);assert.equal(citation.type,'citation');assert.equal(citation.url,undefined);assert.equal(citation.reference,'source-1');}finally{dom.window.close();}
});
test('stream snapshots support corrections rather than assuming append-only text',async()=>{
 const {dom,w,r}=fixture();try {
  r.observe({requestId:'r',baselineIds:[],expectedText:'Test',settleMs:0});
  w.document.querySelector('main')!.insertAdjacentHTML('beforeend',user+answer('Original'));
  const first=r.drain('r').updates[0];assert.equal(first.text,'Original');
  w.document.querySelector('.markdown p')!.textContent='Rewritten';await delay(5);
  const next=r.drain('r').updates[0];assert.equal(next.text,'Rewritten');assert.equal(next.sequence,first.sequence+1);
 }finally{dom.window.close();}
});
test('copy control with streaming marker cannot finish',()=>{
 const {dom,w,r}=fixture();try {
  r.observe({requestId:'r',baselineIds:[],expectedText:'Test',settleMs:0});
  w.document.querySelector('main')!.insertAdjacentHTML('beforeend',user+answer('Partial',true));
  w.document.querySelector('.markdown')!.classList.add('result-streaming');
  assert.equal(r.drain('r').done,false);
  w.document.querySelector('.markdown')!.classList.remove('result-streaming');
  assert.equal(r.drain('r').done,true);
 }finally{dom.window.close();}
});
test('current section turn layout finishes and omits code toolbar text',()=>{
 const {dom,w,r}=fixture();try {
  r.observe({requestId:'r',baselineIds:[],expectedText:'Test',settleMs:0});
  w.document.querySelector('main')!.insertAdjacentHTML('beforeend',user+'<section data-testid="conversation-turn-2"><div data-message-id="a" data-message-author-role="assistant"><div class="markdown"><h2>Example</h2><pre><div>Python<button>Run</button></div><pre><code>print("ok")</code></pre></pre></div></div><button aria-label="Copy response">Copy response</button></section>');
  const d=r.drain('r');assert.equal(d.done,true);assert.equal(d.turn.content.blocks[1].language,'python');assert.equal(d.turn.content.blocks[1].text,'print("ok")');assert(!d.turn.content.text.includes('Run'));assert(!d.turn.content.text.includes('Python'));
 }finally{dom.window.close();}
});
test('thinking placeholders do not become answer text',()=>{
 const {dom,w,r}=fixture();try {
  r.observe({requestId:'r',baselineIds:[],expectedText:'Test',settleMs:0});
  w.document.querySelector('main')!.insertAdjacentHTML('beforeend',user+'<section data-testid="conversation-turn-2"><div data-message-id="thinking" data-message-author-role="assistant">Thinking</div></section>');
  assert.equal(r.drain('r').updates.length,0);
 }finally{dom.window.close();}
});
test('opt-in normalized snapshots include structural changes even when text is unchanged',()=>{
 const {dom,w,r}=fixture();try {
  r.observe({requestId:'structured',baselineIds:[],expectedText:'Test',settleMs:0,includeContentSnapshots:true});
  w.document.querySelector('main')!.insertAdjacentHTML('beforeend',user+answer('Same text',true));
  const first=r.drain('structured');assert.equal(first.snapshot.content.blocks[0].type,'paragraph');
  const p=w.document.querySelector('.markdown p')!;const h=w.document.createElement('h2');h.textContent=p.textContent;p.replaceWith(h);
  const next=r.drain('structured');assert.equal(next.snapshot.content.blocks[0].type,'heading');assert.equal(next.updates.length,0);
  assert.equal(r.drain('structured').snapshot,undefined);
 }finally{dom.window.close();}
});
