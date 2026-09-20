import { chromium, type Browser, type Page, type Locator } from 'playwright';
import { readFile, mkdir, open, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ConversationGuard, idFromURL, provisionalID, isChatSurfaceURL } from './conversation.js';
import { locators } from './selectors.js';
import { safeLogger } from './diagnostics.js';
import { AdapterError, type Conversation, type Status, type Turn, type ResponseEvent, type SendOptions, type Logger, type RecentConversations } from './types.js';

const runtimeSource = readFile(new URL('./dom-runtime.js', import.meta.url), 'utf8');
const KEY = '__chatgptDOMAdapter_v1';
const ID = /^[a-zA-Z0-9][a-zA-Z0-9-]{7,127}$/;
export function conversationURL(value: string): string {
  if (ID.test(value)) return `https://chatgpt.com/c/${value}`;
  let u: URL;
  try {u = new URL(value);} catch {throw new AdapterError('INVALID_CONVERSATION','Expected a ChatGPT conversation ID or URL.');}
  if(u.origin!=='https://chatgpt.com'||u.username||u.password||!/^\/(?:g\/[^/]+\/)?c\/[a-zA-Z0-9-]+\/?$/.test(u.pathname))throw new AdapterError('INVALID_CONVERSATION','Only https://chatgpt.com conversation URLs are accepted.');
  u.search='';u.hash='';return u.href.replace(/\/$/,'');
}
function isChatGPT(url:string):boolean {try{return new URL(url).origin==='https://chatgpt.com';}catch{return false;}}
export interface ConnectOptions { endpoint?: string; conversation?: string; tabURL?: string; logger?: Logger; timeoutMs?: number }
interface ObservationDiagnostics {samples:number;mutationBatches:number;droppedSnapshots:number;generating:boolean;userDetected:boolean;assistantDetected:boolean}
interface Drain {diagnostics?:ObservationDiagnostics;updates:{sequence:number;text:string;elapsedMs:number;observedAt:number}[];userId:string|null;assistantId:string|null;seenGenerating:boolean;done:boolean;error:string|null;turn?:Turn;snapshot?:Turn;evidence:string[]}

export class ChatGPTAdapter {
  private busy=false;
  private closed=false;
  private constructor(private browser:Browser, private page:Page, private log:Logger, private lockPath:string) {}
  private emit(event:string, details:Record<string,unknown>={}) {safeLogger(this.log)({event,at:new Date().toISOString(),...details});}
  static async connect(options:ConnectOptions={}):Promise<ChatGPTAdapter> {
    const endpoint=options.endpoint??'chrome';
    if(endpoint!=='chrome') {
      let u:URL;try{u=new URL(endpoint);}catch{throw new AdapterError('INVALID_ENDPOINT','Use chrome or a loopback CDP endpoint.');}
      if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||!['http:','ws:'].includes(u.protocol)||u.username||u.password)throw new AdapterError('INVALID_ENDPOINT','Only local loopback debugging endpoints are supported.');
    }
    const log=safeLogger(options.logger);
    log({event:'connecting',at:new Date().toISOString()});
    const browser=await chromium.connectOverCDP(endpoint,{noDefaults:true,timeout:options.timeoutMs??60000});
    let lockPath:string|undefined;
    try {
      let pages=browser.contexts().flatMap(c=>c.pages()).filter(p=>isChatSurfaceURL(p.url()));
      if(options.conversation) {const id=idFromURL(conversationURL(options.conversation));pages=pages.filter(p=>idFromURL(p.url())===id);}
      if(options.tabURL)pages=pages.filter(p=>p.url()===options.tabURL);
      if(pages.length!==1)throw new AdapterError('TAB_SELECTION',`Expected one matching ChatGPT tab, found ${pages.length}. Select explicitly with tabURL or conversation.`,{tabs:pages.map(p=>p.url())});
      const page=pages[0];
      // CDP is used only for browser/tab identity and attachment, never ChatGPT traffic.
      const cdp=await page.context().newCDPSession(page);
      let targetId:string;try{targetId=(await cdp.send('Target.getTargetInfo')).targetInfo.targetId;}finally{await cdp.detach();}
      const dir=join(tmpdir(),`chatgpt-browser-adapter-${process.getuid?.()??'local'}`);
      await mkdir(dir,{recursive:true,mode:0o700});
      lockPath=join(dir,createHash('sha256').update(targetId).digest('hex')+'.lock');
      try {const f=await open(lockPath,'wx',0o600);await f.writeFile(String(process.pid));await f.close();}
      catch(e) {if((e as NodeJS.ErrnoException).code==='EEXIST') {lockPath=undefined;throw new AdapterError('TAB_LOCKED','Another adapter may own this tab. If a previous adapter crashed, inspect and remove its stale lock in the system temporary directory.');}throw e;}
      const adapter=new ChatGPTAdapter(browser,page,log,lockPath);
      await adapter.inject();await adapter.call('dispose');adapter.emit('connected',{browserVersion:browser.version()});return adapter;
    } catch(e) {
      // A detach failure must not mask the attachment failure or strand our lock.
      await browser.close().catch(()=>{});
      if(lockPath)await unlink(lockPath).catch(()=>{});
      throw e;
    }
  }
  private assertPage() {if(this.closed||!this.browser.isConnected()||this.page.isClosed())throw new AdapterError('DISCONNECTED','The selected page or adapter is closed.');if(!isChatSurfaceURL(this.page.url()))throw new AdapterError('WRONG_PAGE','The selected tab is no longer on a supported ChatGPT conversation surface.');}
  private async inject() {this.assertPage();await this.page.evaluate(await runtimeSource);}
  private async call<T>(method:string,arg?:unknown):Promise<T> {
    this.assertPage();
    return this.page.evaluate(({key,method,arg})=>{
      const runtime=(window as unknown as Record<string,any>)[key];
      if(!runtime)throw new Error('DOM adapter lost after navigation; reopen the conversation before continuing.');
      return runtime[method](arg);
    },{key:KEY,method,arg});
  }
  private enter() {if(this.busy)throw new AdapterError('BUSY','Only one mutating operation may run per adapter.');this.assertPage();this.busy=true;}
  private async unique(candidates:{name:string;locator:Locator}[], waitMs=0):Promise<Locator> {
    const deadline=Date.now()+waitMs;
    do {
      for(const c of candidates) {
        const count=await c.locator.count();
        if(count>1)throw new AdapterError('AMBIGUOUS_LOCATOR',`${c.name} matched multiple visible controls.`,{selector:c.name,count});
        if(count===1){this.emit('locator',{selector:c.name});return c.locator;}
      }
      if(Date.now()>=deadline)break;
      await delay(50);
    } while(true);
    throw new AdapterError('MISSING_LOCATOR','No supported visible control found.',{selectors:candidates.map(c=>c.name)});
  }
  async getCurrentConversation():Promise<Conversation> {
    this.assertPage();const url=this.page.url();const title=await this.page.title();if(this.page.url()!==url)throw new AdapterError('CONVERSATION_CHANGED','The conversation changed while reading its identity.');return {id:provisionalID(idFromURL(url))?null:idFromURL(url),provisional:provisionalID(idFromURL(url)),url,title,temporary:new URL(url).searchParams.get('temporary-chat')==='true'};
  }
  async getStatus():Promise<Status> {await this.inject();return {connected:this.browser.isConnected(),...await this.call<Omit<Status,'connected'|'conversation'>>('state'),conversation:await this.getCurrentConversation()};}
  async readVisibleTurns():Promise<Turn[]> {await this.inject();return this.call('readTurns');}
  private async assertIdle() {const s=await this.getStatus();if(!s.usable)throw new AdapterError('PAGE_UNUSABLE','ChatGPT is not ready.',{reason:s.reason,login:s.login,composerCount:s.composerCount});if(s.generating)throw new AdapterError('GENERATION_ACTIVE','The page is already generating.');if(s.draftPresent)throw new AdapterError('DRAFT_PRESENT','The composer has an existing draft; it will not be overwritten.');}
  private async ready(expectedID:string|null,timeoutMs=30000) {
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline) {
      await this.inject();const s=await this.getStatus();
      if(s.login==='logged-out'||['page-error','challenge'].includes(s.reason??''))throw new AdapterError('NAVIGATION_FAILED','Conversation is unavailable or requires attention.',{reason:s.reason});
      if(s.usable&&s.conversation.id===expectedID) {
        const turns=await this.readVisibleTurns();
        if(expectedID===null?turns.length===0:turns.length>0)return s.conversation;
      }
      await delay(200);
    }
    throw new AdapterError('NAVIGATION_TIMEOUT','ChatGPT did not load the requested conversation in time.');
  }
  async openConversation(value:string):Promise<Conversation> {
    const url=conversationURL(value);this.enter();
    try {await this.assertIdle();await this.page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});const result=await this.ready(idFromURL(url));this.emit('conversation-opened');return result;}finally{this.busy=false;}
  }
  async createConversation():Promise<Conversation> {
    this.enter();try {await this.assertIdle();await this.page.goto('https://chatgpt.com/',{waitUntil:'domcontentloaded',timeout:30000});const result=await this.ready(null);this.emit('new-conversation-ready');return result;}finally{this.busy=false;}
  }
  async listRecentConversations(options:{limit?:number;maxScrolls?:number}={}):Promise<RecentConversations> {
    if ((options.limit !== undefined && !Number.isFinite(options.limit)) || (options.maxScrolls !== undefined && !Number.isFinite(options.maxScrolls))) throw new AdapterError('INVALID_LIMIT', 'History bounds must be finite numbers.');
    const limit=Math.max(1,Math.min(200,Math.trunc(options.limit??30)));
    const maxScrolls=Math.max(0,Math.min(100,Math.trunc(options.maxScrolls??20)));
    this.enter();let started=false;
    try {
      const status=await this.getStatus();if(!status.usable)throw new AdapterError('PAGE_UNUSABLE','Chat history is unavailable.',{reason:status.reason});
      if(!(await locators.history(this.page).isVisible())) {const button=locators.openSidebar(this.page);if(await button.count()!==1)throw new AdapterError('HISTORY_UNAVAILABLE','Open the chat sidebar before listing conversations.');await button.click();await locators.history(this.page).waitFor({state:'visible'});}
      type Scan={links:{title:string;url:string}[];scrollable:boolean;position:number;height:number};
      await this.call('history','start');started=true;await delay(150);
      const historyReadyDeadline=Date.now()+5000;
      const found=new Map<string,Conversation>();let scrolls=0;let noProgress=0;let previous='';let stopReason:RecentConversations['stopReason']='max-scrolls';
      while(true) {
        const scan=await this.call<Scan>('history','read');
        if(found.size===0&&scan.links.length===0&&Date.now()<historyReadyDeadline){await delay(200);continue;}
        const before=found.size;
        for(const link of scan.links) {try {const url=conversationURL(link.url);const id=idFromURL(url)!;if(!found.has(id))found.set(id,{id,url,title:link.title});}catch{ /* non-conversation sidebar links */ }}
        if(found.size>=limit){stopReason='limit';break;}
        if(!scan.scrollable){stopReason='no-scroll-container';break;}
        const progress=`${scan.position}:${scan.height}`;
        noProgress=found.size===before&&progress===previous?noProgress+1:0;previous=progress;
        if(noProgress>=3){stopReason='no-progress';break;}
        if(scrolls>=maxScrolls)break;
        await this.call('history','scroll');scrolls++;await delay(450);
      }
      this.emit('history-listed',{count:Math.min(found.size,limit),scrolls,stopReason});
      return {conversations:[...found.values()].slice(0,limit),stopReason,scrolls,complete:false};
    }finally{if(started)await this.call('history','restore').catch(()=>{});this.busy=false;}
  }
  /** Consuming this async iterable performs one send; abandoning it does not stop ChatGPT. */
  async *sendMessage(text:string,options:SendOptions={}):AsyncGenerator<ResponseEvent> {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new AdapterError('INVALID_TIMEOUT', 'timeoutMs must be a positive finite number.');
    if(!text.trim())throw new AdapterError('EMPTY_MESSAGE','Message must not be empty.');
    this.enter();const requestId=options.requestId??randomUUID();const started=Date.now();let observing=false;let clicked=false;let submitted=false;let navigationUnexpected=false;
    let conversation:Conversation|undefined;
    let guard:ConversationGuard|undefined;
    let deliveredUpdates=0;let maxDeliveryDelayMs=0;let lastProgressAt=started;let diagnostics:ObservationDiagnostics|undefined;
    const navigation=(frame:import('playwright').Frame)=>{
      if(frame!==this.page.mainFrame()||!conversation)return;
      const current=this.page.url();
      if(!isChatGPT(current)){navigationUnexpected=true;return;}
      if(!guard?.accept(current))navigationUnexpected=true;
    };
    try {
      await this.assertIdle();conversation=await this.getCurrentConversation();guard=new ConversationGuard(conversation.url);
      if('expectedConversationId' in options&&conversation.id!==options.expectedConversationId)throw new AdapterError('CONVERSATION_MISMATCH','Current conversation differs from the requested destination.');
      await this.page.bringToFront();
      const baseline=await this.readVisibleTurns();const composer=await this.unique(locators.composer(this.page));
      await this.call('observe',{requestId,baselineIds:baseline.map(t=>t.id),expectedText:text,settleMs:700,includeContentSnapshots:options.includeContentSnapshots??false});observing=true;
      this.page.on('framenavigated',navigation);
      if(options.signal?.aborted)throw new AdapterError('ABORTED','Request aborted before sending.');
      // Recheck after focus/DOM observation, before touching any composer content.
      if(navigationUnexpected||this.page.url()!==conversation.url)throw new AdapterError('CONVERSATION_CHANGED','The conversation changed before filling the composer.');
      const draft=await composer.evaluate(e => e instanceof HTMLTextAreaElement ? e.value : (e as HTMLElement).innerText);
      if(draft.trim())throw new AdapterError('DRAFT_PRESENT','A draft appeared before filling the composer; it will not be overwritten.');
      if(navigationUnexpected||this.page.url()!==conversation.url)throw new AdapterError('CONVERSATION_CHANGED','The conversation changed before filling the composer.');
      await composer.fill(text,{timeout:5000});
      if(this.page.url()!==conversation.url)throw new AdapterError('CONVERSATION_CHANGED','The conversation changed before submission; no automatic retry.');
      const send=await this.unique(locators.send(this.page),5000);
      const composed=await composer.evaluate(e => e instanceof HTMLTextAreaElement ? e.value : (e as HTMLElement).innerText);
      if(composed.replace(/\r\n/g,'\n').trim()!==text.replace(/\r\n/g,'\n').trim())throw new AdapterError('COMPOSER_CHANGED','The composer content changed before submission; it will not be sent.');
      if(navigationUnexpected||this.page.url()!==conversation.url)throw new AdapterError('CONVERSATION_CHANGED','The conversation changed before submission; no automatic retry.');
      if(options.signal?.aborted)throw new AdapterError('ABORTED','Request aborted before sending.');
      if(!await send.isEnabled())throw new AdapterError('SEND_DISABLED','The send button is disabled.');
      // ChatGPT input needs the selected tab active; use the actual accessible button.
      clicked=true;await send.click({timeout:5000});this.emit('send-clicked',{requestId});
      const deadline=Date.now()+(options.timeoutMs??180000);
      while(Date.now()<deadline) {
        if(options.signal?.aborted)throw new AdapterError('ABORTED','Observation cancelled. ChatGPT may still be generating; inspect the page before sending again.');
        if(navigationUnexpected)throw new AdapterError('CONVERSATION_CHANGED','The tab navigated away during generation.');
        let d:Drain;
        try{d=await this.call<Drain>('drain',requestId);}catch{throw new AdapterError('OBSERVER_LOST','The page reloaded or disconnected during generation. Do not resend automatically.');}
        diagnostics=d.diagnostics;
        if(Date.now()-lastProgressAt>=10000){lastProgressAt=Date.now();this.emit('observation-progress',{requestId,elapsedMs:Date.now()-started,deliveredUpdates,...diagnostics});}
        if(d.error)throw new AdapterError('GENERATION_FAILED','ChatGPT response could not be verified.',{reason:d.error});
        if(d.userId&&!submitted) {submitted=true;const current=await this.getCurrentConversation();if(conversation.id===null&&current.id)conversation=current;yield {type:'submitted',requestId,conversation:current};}
        for(const update of d.updates){deliveredUpdates++;maxDeliveryDelayMs=Math.max(maxDeliveryDelayMs,Date.now()-update.observedAt);yield {type:'text',requestId,...update};}
        if(d.snapshot)yield {type:'content',requestId,turn:d.snapshot,elapsedMs:Date.now()-started};
        if(d.done&&d.turn) {
          const current=await this.getCurrentConversation();
          if(!guard.accept(current.url))throw new AdapterError('CONVERSATION_CHANGED','Conversation changed before completion.');
          this.emit('response-complete',{requestId,elapsedMs:Date.now()-started,characters:d.turn.content.text.length,deliveredUpdates,maxDeliveryDelayMs,...diagnostics,evidence:d.evidence});
          yield {type:'done',requestId,conversation:current,turn:d.turn,elapsedMs:Date.now()-started,completionEvidence:d.evidence};return;
        }
        if(!submitted&&Date.now()-started>15000)throw new AdapterError('SUBMISSION_UNCONFIRMED','No matching user turn appeared. Inspect the page before any retry.');
        await delay(75);
      }
      throw new AdapterError('GENERATION_TIMEOUT','No verified completion before timeout; ChatGPT may still be generating.');
    } catch(error) {
      this.emit('operation-failed',{requestId,code:error instanceof AdapterError?error.code:'PLAYWRIGHT_ERROR',submissionAttempted:clicked,submissionConfirmed:submitted,elapsedMs:Date.now()-started,deliveredUpdates,...diagnostics});throw error;
    } finally {this.page.off('framenavigated',navigation);if(observing)await this.call('stop',requestId).catch(()=>{});this.busy=false;}
  }
  async disconnect(options:{force?:boolean}={}):Promise<void> {
    if(this.busy&&!options.force)throw new AdapterError('BUSY','Finish or cancel the active iterator before disconnecting.');
    if(this.closed)return;this.closed=true;
    // Release page-side observer state before detaching, including forced shutdown.
    // Bound this best-effort step when the page is unresponsive.
    if(this.browser.isConnected()&&!this.page.isClosed()) {
      let timer:NodeJS.Timeout|undefined;
      const cleanup=this.page.evaluate(key=>{(window as unknown as Record<string,any>)[key]?.dispose?.();},KEY).then(()=>true,()=>false);
      const cleaned=await Promise.race([cleanup,new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),1000);timer.unref();})]);
      clearTimeout(timer);this.emit('observer-cleanup',{cleaned});
    }
    try {await this.browser.close();} finally {await unlink(this.lockPath).catch(()=>{});this.emit('disconnected');}
  }
}
