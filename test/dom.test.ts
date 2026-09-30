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
  w.document.querySelector('main')!.insertAdjacentHTML('beforeend','<div role="textbox" contenteditable="true" aria-label="Ask ChatGPT"></div>');assert.equal(r.state().usable,false);assert.equal(r.state().composerCount,2);
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

test('an empty replacement clears prior text instead of leaving a stale answer',()=>{
 const {dom,w,r}=fixture();try {
  r.observe({requestId:'r',baselineIds:[],expectedText:'Test',settleMs:0});
  w.document.querySelector('main')!.insertAdjacentHTML('beforeend',user+answer('Withdrawn text'));
  assert.equal(r.drain('r').updates[0].text,'Withdrawn text');
  w.document.querySelector('.markdown p')!.textContent='';
  const d=r.drain('r');assert.equal(d.updates.length,1);assert.equal(d.updates[0].text,'');assert.equal(d.done,false);
  assert.equal(d.diagnostics.userDetected,true);assert.equal(d.diagnostics.assistantDetected,true);
  assert(!JSON.stringify(d.diagnostics).includes('Withdrawn'));assert(!JSON.stringify(d.diagnostics).includes('Test'));
 }finally{dom.window.close();}
});
test('structural changes reset completion settling even if plain text does not change',()=>{
 const {dom,w,r}=fixture();try {
  let now=1000;w.Date.now=()=>now;
  r.observe({requestId:'r',baselineIds:[],expectedText:'Test',settleMs:100});
  w.document.querySelector('main')!.insertAdjacentHTML('beforeend',user+answer('Same words',true));
  assert.equal(r.drain('r').done,false);now+=101;assert.equal(r.drain('r').done,true);
  const p=w.document.querySelector('.markdown p')!;const h=w.document.createElement('h2');h.textContent=p.textContent;p.replaceWith(h);
  assert.equal(r.drain('r').done,false);now+=101;assert.equal(r.drain('r').done,true);
 }finally{dom.window.close();}
});
test('hidden branches do not become visible turns or competing replies',()=>{
 const {dom,w,r}=fixture();try {
  r.observe({requestId:'r',baselineIds:[],expectedText:'Test',settleMs:0});
  w.document.querySelector('main')!.insertAdjacentHTML('beforeend',user+answer('Visible',true)+'<div hidden>'+user.replace('data-message-id="u"','data-message-id="hidden-user"')+answer('Hidden',true).replace('data-message-id="a"','data-message-id="hidden-answer"')+'</div>');
  const d=r.drain('r');assert.equal(d.error,null);assert.equal(d.done,true);assert.equal(d.turn.content.text,'Visible');assert.equal(r.readTurns().length,2);
 }finally{dom.window.close();}
});

test('rollout profile control authenticates only in app navigation and honors logged-out state',()=>{
 const {dom,w,r}=fixture();try {
  w.document.querySelector('[data-testid="accounts-profile-button"]')!.remove();
  w.document.body.insertAdjacentHTML('beforeend','<button aria-label="Open profile menu"></button>');
  assert.equal(r.state().login,'unknown','unrelated profile text is not authentication evidence');
  w.document.body.insertAdjacentHTML('beforeend','<nav aria-label="App navigation"><button aria-label="Open profile menu"></button></nav>');
  assert.equal(r.state().login,'authenticated');assert.equal(r.state().usable,true);
  w.document.querySelector('nav')!.hidden=true;assert.equal(r.state().login,'unknown');
  w.document.querySelector('nav')!.hidden=false;
  w.document.body.insertAdjacentHTML('beforeend','<button>Log in</button>');assert.equal(r.state().login,'logged-out');
 }finally{dom.window.close();}
});

test('both history layouts scope links, reject ambiguity, and restore lazy-list scrolling',()=>{
 for(const label of ['Chat history','Home']) {
  const {dom,w,r}=fixture();try {
   w.document.body.insertAdjacentHTML('beforeend',`<a href="/c/outside">Outside</a><nav aria-label="${label}"><div style="overflow-y:auto"><a href="/c/12345678">Test chat</a></div></nav><nav aria-label="Home" hidden><a href="/c/hidden">Hidden</a></nav>`);
   const scroller=w.document.querySelector('nav div')!;
   Object.defineProperties(scroller,{clientHeight:{value:100},scrollHeight:{value:1000}});scroller.scrollTop=90;
   r.history('start');assert.equal(scroller.scrollTop,0);
   let scan=r.history('read');assert.equal(scan.links.length,1);assert.equal(scan.links[0].title,'Test chat');assert.equal(scan.scrollable,true);
   r.history('scroll');assert.equal(scroller.scrollTop,200);
   scroller.innerHTML='<a href="/c/87654321">Next chat</a>';assert.equal(r.history('read').links[0].title,'Next chat');
   r.history('restore');assert.equal(scroller.scrollTop,90);
   w.document.body.insertAdjacentHTML('beforeend','<nav aria-label="Home"></nav>');assert.throws(()=>r.history('read'),/ambiguous/);
  }finally{dom.window.close();}
 }
});

test('editable answer code is not a second composer or unsent message draft',()=>{
 const {dom,w,r}=fixture('<div role="textbox" contenteditable="true" aria-label="Edit code">print("sample")</div>');try {
  assert.equal(r.state().composerCount,1);assert.equal(r.state().draftPresent,false);assert.equal(r.state().usable,true);
  w.document.querySelector('#prompt-textarea')!.remove();
  assert.equal(r.state().composerCount,0);assert.equal(r.state().usable,false);
 }finally{dom.window.close();}
});

const rolloutTurn=(id='a', text='Partial')=>`<div data-turn-key="turn-${id}"><div data-chatgpt-search-unit-key="turn:0:user" data-chatgpt-search-message-ids="u-${id}"><div data-user-message-bubble="true">Test</div><button aria-label="Copy message"></button></div><div data-chatgpt-search-unit-key="turn:2:assistant" data-chatgpt-search-message-ids="${id} ${id}"><h4 class="sr-only" data-conversation-role="assistant">Assistant</h4><div data-markdown-text-style="assistant-message"><h2>Answer</h2><p>${text}</p><div data-markdown-copy="code-block"><div data-markdown-copy="exclude">Python<button aria-label="Copy">Copy</button><button>Run code</button></div><div role="textbox" aria-label="Edit code" contenteditable="true" data-language="python"><div class="cm-line">print(1)</div><div class="cm-line">print(2)</div></div></div></div></div></div>`;

test('rollout turns stream replacements and require their own non-code completion toolbar',()=>{
 const {dom,w,r}=fixture();try {
  r.observe({requestId:'r',baselineIds:[],expectedText:'Test',settleMs:0,includeContentSnapshots:true});
  w.document.querySelector('main')!.insertAdjacentHTML('beforeend',rolloutTurn());
  let d=r.drain('r');assert.equal(d.userId,'u-a');assert.equal(d.assistantId,'a');assert.equal(d.done,false,'code Copy is not completion');
  assert.deepEqual(Array.from(r.readTurns(),(t:any)=>t.role),['user','assistant']);
  const answer=r.readTurns()[1].content;assert.equal(answer.blocks[2].type,'code');assert.equal(answer.blocks[2].text,'print(1)\nprint(2)');assert.equal(answer.blocks[2].language,'python');assert(!answer.text.includes('Run code'));assert(!answer.text.includes('Python'));assert(answer.text.includes('print(1)\nprint(2)'));
  w.document.querySelector('[data-markdown-text-style] p')!.textContent='Revised';d=r.drain('r');assert(d.updates.at(-1).text.includes('Revised'));
  w.document.querySelector('[data-chatgpt-search-unit-key$=":assistant"]')!.insertAdjacentHTML('beforeend','<button aria-label="Copy"></button>');
  assert.equal(r.drain('r').done,false,'Copy inside answer content is not a completion toolbar');
  w.document.querySelector('[data-turn-key]')!.insertAdjacentHTML('beforeend','<button aria-label="Copy"></button>');
  w.document.body.insertAdjacentHTML('beforeend','<form data-chatgpt-composer><button aria-label="Stop"></button></form>');
  assert.equal(r.state().generating,true);assert.equal(r.drain('r').done,false);
  w.document.querySelector('form')!.remove();assert.equal(r.drain('r').done,true);
 }finally{dom.window.close();}
});

test('rollout completion cannot borrow an old answer toolbar or ambiguous message identity',()=>{
 const {dom,w,r}=fixture(rolloutTurn('old'));try {
  w.document.querySelector('[data-turn-key]')!.insertAdjacentHTML('beforeend','<button aria-label="Copy"></button>');
  r.observe({requestId:'r',baselineIds:['u-old','old'],expectedText:'Test',settleMs:0});
  w.document.querySelector('main')!.insertAdjacentHTML('beforeend',rolloutTurn('new'));
  assert.equal(r.drain('r').done,false);
  w.document.querySelector('[data-chatgpt-search-message-ids="new new"]')!.setAttribute('data-chatgpt-search-message-ids','new other');
  assert.equal(r.drain('r').error,'ambiguous-message-identity');assert.throws(()=>r.readTurns(),/ambiguous/);
 }finally{dom.window.close();}
});
