/** Developer verification console. Keeps one approved connection alive; does not save content. */
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { ChatGPTAdapter, renderHTML } from '../src/index.js';
let a=await ChatGPTAdapter.connect({timeoutMs:600000,tabURL:process.env.CHATGPT_TAB_URL});
console.log(JSON.stringify({ready:true,status:await a.getStatus()}));
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
try {
 for await(const line of input) {
  if(!line.trim())continue;
  try {
   const cmd=JSON.parse(line);
   if(cmd.action==='exit')break;
   if(cmd.action==='reload') {
    if(a['busy'])throw Error('Adapter is busy');
    const p=a['page'];
    await p.evaluate(() => { delete (window as any).__chatgptDOMAdapter_v1; });
    const fresh=await import('../src/adapter.ts?refresh='+Date.now());
    a=new fresh.ChatGPTAdapter(a['browser'],p,a['log'],a['lockPath']);
   }
   if(cmd.action==='diagnostic') {
    console.log(JSON.stringify(await a['page'].evaluate(await readFile(new URL('./diagnostic.js',import.meta.url),'utf8')),null,2));
   }
   if(cmd.action==='status')console.log(JSON.stringify(await a.getStatus()));
   if(cmd.action==='new')console.log(JSON.stringify(await a.createConversation()));
   if(cmd.action==='open')console.log(JSON.stringify(await a.openConversation(cmd.url)));
   if(cmd.action==='list') {const result=await a.listRecentConversations({limit:cmd.limit??50});console.log(JSON.stringify({...result,conversations:cmd.showTitles?result.conversations:result.conversations.map((c,i)=>({index:i,id:c.id,hasTitle:!!c.title}))}));}
   if(cmd.action==='read')console.log(JSON.stringify((await a.readVisibleTurns()).map(t=>cmd.full?t:{id:t.id,role:t.role,characters:t.content.text.length,blockTypes:t.content.blocks.map(b=>b.type),warnings:t.content.warnings})));
   if(cmd.action==='send') {
    let count=0;const times:number[]=[];let lastText='';
    for await(const e of a.sendMessage(cmd.text,{timeoutMs:cmd.timeoutMs??240000})) {
     if(e.type==='text'){count++;times.push(e.elapsedMs);lastText=e.text;console.log(JSON.stringify({type:e.type,sequence:e.sequence,elapsedMs:e.elapsedMs,characters:e.text.length}));}
     else if(e.type==='done') console.log(JSON.stringify({type:'done',conversation:e.conversation,elapsedMs:e.elapsedMs,completionEvidence:e.completionEvidence,updates:count,firstUpdateMs:times[0],lastUpdateMs:times.at(-1),maxUpdateGapMs:Math.max(0,...times.slice(1).map((t,i)=>t-times[i])),finalMatchesLastUpdate:e.turn.content.text===lastText,content:e.turn.content,html:renderHTML(e.turn.content)}));
     else console.log(JSON.stringify(e));
    }
   }
   if(cmd.action==='inspect') {
    const p=a['page'];
    console.log(JSON.stringify(await p.evaluate(()=>({url:location.href,articles:Array.from(document.querySelectorAll('article')).map(e=>({attrs:Array.from(e.attributes).filter(a=>!['class','style'].includes(a.name)).map(a=>[a.name,a.value]),messages:Array.from(e.querySelectorAll('[data-message-author-role]')).map(m=>({role:m.getAttribute('data-message-author-role'),id:m.getAttribute('data-message-id'),html:m.outerHTML.slice(0,12000)})),buttons:Array.from(e.querySelectorAll('button')).map(b=>({label:b.getAttribute('aria-label'),testid:b.getAttribute('data-testid'),text:b.innerText}))}))})),null,2));
   }
   console.log(JSON.stringify({commandComplete:cmd.action}));
  }catch(e){console.log(JSON.stringify({commandError:e instanceof Error?e.message:String(e),code:(e as any).code,details:(e as any).details}));}
 }
}finally{await a.disconnect();}
