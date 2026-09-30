/* This file is evaluated in the selected tab. No network, storage, cookies, or app internals. */
(() => {
  const KEY = '__chatgptDOMAdapter_v1';
  if (window[KEY]?.version === 7) return;
  window[KEY]?.dispose?.();
  const S = {
    messages: '[data-message-author-role][data-message-id], [data-chatgpt-search-unit-key$=":user"][data-chatgpt-search-message-ids], [data-chatgpt-search-unit-key$=":assistant"][data-chatgpt-search-message-ids]',
    turn: '[data-testid^="conversation-turn-"], article, [data-turn-key]',
    userContent: '[data-testid="collapsible-user-message-content"], [data-user-message-bubble]',
    composer: '#prompt-textarea, [role="textbox"][contenteditable="true"]:is([aria-label="Ask ChatGPT" i],[aria-label="Message ChatGPT" i],[aria-label="Chat with ChatGPT" i]), textarea:is([aria-label="Ask ChatGPT" i],[aria-label="Message ChatGPT" i],[aria-label="Chat with ChatGPT" i])',
    account: '[data-testid="accounts-profile-button"], nav[aria-label="App navigation"] button[aria-label="Open profile menu"]',
    stop: '[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"], form[data-chatgpt-composer] button[aria-label="Stop"]',
    copy: '[data-testid="copy-turn-action-button"], button[aria-label="Copy response"]',
    error: '[data-testid="conversation-turn-error"], [data-testid="error-message"], [role="alert"]',
    history: 'nav[aria-label="Chat history"], nav[aria-label="Home"]',
    links: 'a[href*="/c/"]',
    markdown: '.markdown, [data-markdown-text-style="assistant-message"]',
    codeBlock: '[data-markdown-copy="code-block"]',
    codeEditor: '[role="textbox"][aria-label="Edit code"]',
    citation: '[data-citation-id], [data-testid*="citation"], [data-state] a[target="_blank"]',
  };
  const visible = e => !!e && !e.closest('[hidden],[aria-hidden="true"]') && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none';
  const visibleAll = selector => Array.from(document.querySelectorAll(selector)).filter(visible);
  const messageRole = e => e.getAttribute('data-message-author-role') || e.getAttribute('data-chatgpt-search-unit-key')?.match(/:(user|assistant)$/)?.[1];
  const messageID = e => {
    const legacy=e.getAttribute('data-message-id');if(legacy)return legacy;
    const ids=[...new Set((e.getAttribute('data-chatgpt-search-message-ids')||'').trim().split(/\s+/).filter(Boolean))];
    return ids.length===1?ids[0]:null;
  };
  function finishedControl(message) {
    const turn=message.closest(S.turn);if(!turn)return false;
    // The rollout's Copy button is outside its answer unit. Scope to this turn,
    // exclude code/user controls, and refuse to borrow another answer's toolbar.
    const answers=Array.from(turn.querySelectorAll(S.messages)).filter(e=>messageRole(e)==='assistant');
    if(answers.length!==1)return false;
    const rollout=message.hasAttribute('data-chatgpt-search-unit-key');
    return Array.from(turn.querySelectorAll(S.copy+(rollout?', button[aria-label="Copy"]':''))).some(e=>visible(e)&&!e.closest(S.markdown)&&!e.closest(S.userContent)&&!e.closest('[data-chatgpt-search-unit-key$=":user"]')&&(e.getAttribute('aria-label')!=='Copy'||!message.contains(e)));
  }
  function editorCode(root) {
    const editor=root.querySelector(S.codeEditor);
    const lines=editor?Array.from(editor.querySelectorAll('.cm-line')):[];
    const code=root.querySelector('pre code, code');
    return {type:'code',text:editor?(lines.length?lines.map(e=>e.textContent||'').join('\n'):editor.textContent||''):code?.textContent||'',...(editor?.getAttribute('data-language')?{language:editor.getAttribute('data-language')}:{})};
  }
  const safeURL = value => { if (!value) return undefined; try { const u=new URL(value, location.href);return /^(https?:|mailto:)$/.test(u.protocol)?u.href:undefined; } catch {return undefined;} };
  const skipped = e => e.matches('script,style,svg,button,nav,[aria-hidden="true"],.sr-only') && !e.matches(S.citation);
  function inline(node, marks = []) {
    if (node.nodeType === Node.TEXT_NODE) return [{type:'text',text:node.textContent || '',...(marks.length?{marks}: {})}];
    if (!(node instanceof Element) || skipped(node)) return [];
    const tag=node.tagName.toLowerCase();
    if (node.matches('[data-citation-id], [data-testid*="citation"]') || (tag==='a' && node.closest('[data-citation-id], [data-testid*="citation"], .citation'))) {
      return [{type:'citation',label:(node.textContent||node.getAttribute('aria-label')||'Source').trim(),url:safeURL(node.getAttribute('href')||node.querySelector('a')?.getAttribute('href')),reference:node.getAttribute('data-citation-id')||undefined}];
    }
    if(tag==='br') return [{type:'break'}];
    if(tag==='code') return [{type:'code',text:node.textContent||''}];
    const mark={strong:'strong',b:'strong',em:'emphasis',i:'emphasis',s:'strike',del:'strike'}[tag];
    const children=Array.from(node.childNodes).flatMap(n=>inline(n,mark?[...marks,mark]:marks));
    if(tag==='a') {const url=safeURL(node.getAttribute('href'));return url?[{type:'link',url,children}]:children;}
    return children;
  }
  function codeLanguage(pre,code) {
    const declared=code?.className.match(/language-([\w+-]+)/)?.[1]||pre.getAttribute('data-language');
    if(declared)return declared;
    const names={python:'python',javascript:'javascript',typescript:'typescript',json:'json',bash:'bash',shell:'shell',html:'html',css:'css',sql:'sql',swift:'swift','c++':'cpp','c#':'csharp',rust:'rust',go:'go',java:'java',text:'text','plain text':'text',markdown:'markdown',yaml:'yaml'};
    const walker=document.createTreeWalker(pre,NodeFilter.SHOW_TEXT);
    while(walker.nextNode()) {
      const n=walker.currentNode;
      if(n.parentElement?.closest('code,button,svg,[aria-hidden="true"]'))continue;
      const value=n.textContent.trim().toLowerCase();
      if(value)return names[value];
    }
    return undefined;
  }
  function blocks(root) {
    const result=[];
    let pending=[];
    const flush=()=>{if(pending.some(n=>n.type!=='text'||n.text.trim()))result.push({type:'paragraph',children:pending});pending=[];};
    for(const node of root.childNodes) {
      if(node.nodeType===Node.TEXT_NODE) {pending.push(...inline(node));continue;}
      if(!(node instanceof Element)||skipped(node))continue;
      const tag=node.tagName.toLowerCase();
      if(node.matches(S.codeBlock)) {flush();result.push(editorCode(node));}
      else if(tag==='p') {flush();result.push({type:'paragraph',children:Array.from(node.childNodes).flatMap(n=>inline(n))});}
      else if(/^h[1-6]$/.test(tag)) {flush();result.push({type:'heading',level:Number(tag[1]),children:Array.from(node.childNodes).flatMap(n=>inline(n))});}
      else if(tag==='pre') {flush();const code=node.querySelector('code');const language=codeLanguage(node,code);result.push({type:'code',text:code?.textContent??node.textContent??'',...(language?{language}:{})});}
      else if(tag==='ul'||tag==='ol') {flush();result.push({type:'list',ordered:tag==='ol',...(tag==='ol'?{start:Number(node.getAttribute('start')||1)}:{}),items:Array.from(node.children).filter(e=>e.tagName==='LI').map(blocks)});}
      else if(tag==='blockquote') {flush();result.push({type:'quote',children:blocks(node)});}
      else if(tag==='table') {flush();result.push({type:'table',rows:Array.from(node.querySelectorAll('tr')).map(row=>Array.from(row.children).filter(c=>/^(TD|TH)$/.test(c.tagName)).map(c=>Array.from(c.childNodes).flatMap(n=>inline(n))))});}
      else if(tag==='hr') {flush();result.push({type:'separator'});}
      else if(tag==='img') {flush();result.push({type:'image',alt:node.getAttribute('alt')||'Image'});}
      else if(/^(div|section|article|figure|details)$/.test(tag)) {flush();result.push(...blocks(node));}
      else pending.push(...inline(node));
    }
    flush();return result;
  }
  function cleanText(root) {
    // Replace code widgets with the actual code and omit UI controls from plain text.
    const clone=root.cloneNode(true);
    for(const widget of clone.querySelectorAll(S.codeBlock)){const pre=document.createElement('pre');pre.textContent=editorCode(widget).text;widget.replaceWith(pre);}
    for(const pre of Array.from(clone.querySelectorAll('pre')).filter(e=>!e.parentElement?.closest('pre'))) {
      const code=pre.querySelector('code');if(code)pre.replaceChildren(document.createTextNode(code.textContent||''));
    }
    for(const e of clone.querySelectorAll('button,svg,script,style,[aria-hidden="true"],.sr-only'))e.remove();
    // innerText on a detached clone loses paragraph boundaries, so walk semantic blocks.
    function text(n) {
      if(n.nodeType===Node.TEXT_NODE)return n.textContent||'';
      if(!(n instanceof Element))return '';
      const tag=n.tagName.toLowerCase();
      if(tag==='br')return '\n';
      if(tag==='pre')return (n.textContent||'')+'\n\n';
      const value=Array.from(n.childNodes).map(text).join('');
      if(tag==='li') {const parent=n.parentElement;const prefix=parent?.tagName==='OL'?String(Number(parent.getAttribute('start')||1)+Array.from(parent.children).indexOf(n))+'. ':'- ';return prefix+value.trim()+'\n';}
      return /^(p|h[1-6]|ul|ol|blockquote|div|section|tr)$/.test(tag)?value+'\n\n':value;
    }
    return text(clone).replace(/\n[ \t]*\n(?:[ \t]*\n)+/g,'\n\n').trim();
  }
  function content(message) {
    const roots=Array.from(message.querySelectorAll(S.markdown)).filter(e=>!e.parentElement?.closest(S.markdown));
    const targets=roots.length?roots:[message.querySelector(S.userContent)||message];
    const warnings=[];
    if(message.querySelector('canvas,iframe,audio,video'))warnings.push('Interactive or media content is represented only by visible text.');
    if(message.querySelector(S.codeBlock+' .cm-gap'))warnings.push('Code editor is virtualized; only rendered code lines are available.');
    if(messageRole(message)==='assistant'&&!roots.length)warnings.push('Markdown container not found; using semantic descendants and visible text.');
    return {schemaVersion:1,text:targets.map(cleanText).join('\n\n').trim(),blocks:targets.flatMap(blocks),warnings};
  }
  function readTurns() {return visibleAll(S.messages).map(e=>{const id=messageID(e);if(!id)throw Error('Message identity missing or ambiguous');return {id,role:messageRole(e),content:content(e)};});}
  function state() {
    const composers=visibleAll(S.composer);
    const loggedOut=Array.from(document.querySelectorAll('button,a')).some(e=>visible(e)&&/^(Log in|Sign in|Sign up)$/i.test((e.textContent||'').trim()));
    const authenticated=visibleAll(S.account).length>0&&!loggedOut;
    const stop=visibleAll(S.stop).length>0;
    const errors=visibleAll(S.error).filter(e=>/error|went wrong|unable|failed|limit|try again|not found/i.test(e.textContent||''));
    const challenge=!!document.querySelector('iframe[src*="challenges.cloudflare.com"]')||/^(Just a moment|Verify you are human)/i.test(document.title);
    return {login:loggedOut?'logged-out':authenticated?'authenticated':'unknown',usable:authenticated&&composers.length===1&&!errors.length&&!challenge,generating:stop,composerCount:composers.length,draftPresent:composers.some(e=>(e.value??e.innerText??'').trim()),reason:challenge?'challenge':loggedOut?'logged-out':errors.length?'page-error':composers.length!==1?'composer-missing-or-ambiguous':!authenticated?'authentication-unconfirmed':undefined,errorCount:errors.length};
  }
  let active;
  function observe(options) {
    if(active)throw Error('Observer already active');
    const baseline=new Set(options.baselineIds);
    const a={samples:0,mutationBatches:0,droppedSnapshots:0,generating:false,lastContentSignature:null,includeContentSnapshots:options.includeContentSnapshots,lastSnapshotAt:0,lastSnapshotSignature:null,requestId:options.requestId,baseline,expectedText:options.expectedText,started:Date.now(),queue:[],sequence:0,lastText:undefined,lastChange:Date.now(),seenGenerating:false,userId:null,assistantId:null,error:null,settled:false};
    function sample() {
      a.settled=false;a.samples++;
      const s=state();a.generating=s.generating;
      if(s.generating)a.seenGenerating=true;
      const messages=visibleAll(S.messages);
      if(messages.some(e=>!messageID(e))){a.error='ambiguous-message-identity';return;}
      const freshUsers=messages.filter(e=>!baseline.has(messageID(e))&&messageRole(e)==='user');
      if(freshUsers.length>1) a.error='concurrent-user-message';
      if(a.userId&&freshUsers.length===0)a.error='submitted-turn-lost';
      if(freshUsers.length===1) {
        const u=freshUsers[0];
        if(((u.querySelector(S.userContent)||u).innerText||'').trim().replace(/\s+/g,' ')!==a.expectedText.trim().replace(/\s+/g,' '))a.error='unexpected-user-message';
        a.userId=messageID(u);
        const following=messages.slice(messages.indexOf(u)+1).filter(e=>messageRole(e)==='assistant'&&!baseline.has(messageID(e))&&(e.querySelector(S.markdown)||finishedControl(e)));
        // More than one final-answer message can indicate parallel responses; never pick arbitrarily.
        if(following.length>1)a.error='ambiguous-assistant-response';
        const assistant=following[0];
        if(assistant) {
          a.assistantId=messageID(assistant);
          const answer=content(assistant);
          const signature=JSON.stringify(answer);
          if(signature!==a.lastContentSignature){a.lastContentSignature=signature;a.lastChange=Date.now();}
          if(answer.text!==a.lastText) {
            const hadSnapshot=a.lastText!==undefined;
            a.lastText=answer.text;a.lastChange=Date.now();
            if(answer.text||hadSnapshot)a.queue.push({sequence:++a.sequence,text:answer.text,elapsedMs:Date.now()-a.started,observedAt:Date.now()});
            if(a.queue.length>256){const dropped=a.queue.length-256;a.droppedSnapshots+=dropped;a.queue.splice(0,dropped);} // Bounded snapshots, no unbounded backlog.
          }
          const article=assistant.closest(S.turn);
          const hasFinishedControl=finishedControl(assistant);
          const streaming=!!article?.querySelector('[data-is-streaming="true"], .result-streaming');
          a.settled=!!answer.text&&!s.generating&&!streaming&&hasFinishedControl&&Date.now()-a.lastChange>=options.settleMs;
          a.turn={id:a.assistantId,role:'assistant',content:answer};
          a.evidence=hasFinishedControl?['assistant-copy-control','stop-control-absent','streaming-marker-absent','text-settled','content-settled']:[];
        }
      }
      if(s.login==='logged-out')a.error='logged-out';
      if(s.reason==='challenge'||s.reason==='page-error')a.error=s.reason;
    }
    let scheduled=false;
    a.observer=new MutationObserver(()=>{a.mutationBatches++;if(!scheduled){scheduled=true;queueMicrotask(()=>{scheduled=false;sample();});}});
    a.observer.observe(document.querySelector('main')||document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['disabled','aria-disabled','data-is-streaming','data-testid','aria-label','class']});
    a.timer=setInterval(sample,100); // Completion can change without another text mutation.
    a.sample=sample;active=a;sample();
  }
  function drain(requestId) {
    if(!active||active.requestId!==requestId)throw Error('Observer missing or replaced');
    active.sample();
    const a=active;
    let snapshot;
    if(a.includeContentSnapshots&&a.turn&&(a.settled||Date.now()-a.lastSnapshotAt>=250)) {
      const signature=JSON.stringify(a.turn);
      if(signature!==a.lastSnapshotSignature){snapshot=a.turn;a.lastSnapshotSignature=signature;a.lastSnapshotAt=Date.now();}
    }
    return {diagnostics:{samples:a.samples,mutationBatches:a.mutationBatches,droppedSnapshots:a.droppedSnapshots,generating:a.generating,userDetected:!!a.userId,assistantDetected:!!a.assistantId},snapshot,updates:a.queue.splice(0),userId:a.userId,assistantId:a.assistantId,seenGenerating:a.seenGenerating,done:a.settled,error:a.error,turn:a.settled?a.turn:undefined,evidence:a.evidence};
  }
  function stop(requestId) {if(active&&active.requestId===requestId){active.observer.disconnect();clearInterval(active.timer);active=null;}}
  let historyScroll;
  function history(action) {
    const nav=visibleAll(S.history);
    if(nav.length!==1)throw Error('Chat history missing or ambiguous');
    const root=nav[0];
    const links=Array.from(root.querySelectorAll(S.links)).map(e=>({title:(e.innerText||e.getAttribute('aria-label')||'').trim(),url:e.href}));
    const scrollable=e=>e.clientHeight>0&&e.scrollHeight>e.clientHeight+2&&/(auto|scroll)/.test(getComputedStyle(e).overflowY);
    let scroller=scrollable(root)?root:Array.from(root.querySelectorAll('*')).find(e=>scrollable(e)&&e.querySelector(S.links));
    if(!scroller){let e=root.parentElement;while(e&&e!==document.body){if(scrollable(e)){scroller=e;break;}e=e.parentElement;}}
    if(action==='start') {historyScroll=scroller?{element:scroller,top:scroller.scrollTop}:null;if(scroller)scroller.scrollTop=0;}
    if(action==='scroll'&&scroller)scroller.scrollTop+=Math.max(200,scroller.clientHeight*0.8);
    if(action==='restore'&&historyScroll){historyScroll.element.scrollTop=historyScroll.top;historyScroll=null;}
    return {links,scrollable:!!scroller,position:scroller?.scrollTop??0,height:scroller?.scrollHeight??0};
  }
  window[KEY]={state,readTurns,observe,drain,stop,history,dispose:()=>{if(active)stop(active.requestId);},version:7};
})();
