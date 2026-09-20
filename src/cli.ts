import { readFile } from 'node:fs/promises';
import { diagnosticError } from './diagnostics.js';
import { ChatGPTAdapter, AdapterError, renderHTML, conversationURL } from './index.js';
const [command='status', ...args] = process.argv.slice(2);
if(command==='help'||command==='--help') {
 console.log(`Usage: npm run cli -- <command> [argument]
  status                  Check authentication, usability, and current conversation
  current                 Current conversation URL and ID
  turns                   Read the rendered conversation turns
  list [limit]            Enumerate recent UI chats (default 30, maximum 200)
  open <id-or-url>        Navigate to a conversation
  new                     Open a new conversation (ID assigned on first send)
  send <text>             Send text; emit newline-delimited JSON stream events
  send-file <path|->      Read message from a UTF-8 file or standard input

Environment: CHATGPT_TAB_URL selects one exact existing tab URL.
CHATGPT_CONVERSATION selects an existing tab by conversation ID or URL.
CHATGPT_CDP_ENDPOINT defaults to chrome. No browser is launched.
Each invocation may require Chrome's Allow remote debugging prompt.
Keep an adapter connection alive in a service to avoid repeated reconnection.
Output includes content only when requested. CHATGPT_DIAGNOSTICS=1 enables
body-free diagnostics on stderr. Errors never include raw Playwright call logs.`);
 process.exit(0);
}
const abort=new AbortController();process.once('SIGINT',()=>abort.abort());
let adapter:ChatGPTAdapter|undefined;
try {
 if(!['status','current','turns','list','open','new','send','send-file'].includes(command))throw new AdapterError('INVALID_COMMAND','Unknown command. Run help for supported commands.');
 if((command==='open'||command==='send-file')&&!args[0])throw new AdapterError('INVALID_ARGUMENT','A conversation or file argument is required.');
 if(command==='open')conversationURL(args[0]);
 if(command==='list'&&args[0]!==undefined&&!Number.isFinite(Number(args[0])))throw new AdapterError('INVALID_LIMIT','History limit must be a finite number.');
 let message:string|undefined;
 if(command==='send')message=args.join(' ');
 if(command==='send-file'){try{message=await readFile(args[0]==='-'?'/dev/stdin':args[0],'utf8');}catch{throw new AdapterError('MESSAGE_READ_FAILED','Could not read the message file or standard input.');}}
 if(message!==undefined&&!message.trim())throw new AdapterError('EMPTY_MESSAGE','Message must not be empty.');
 adapter=await ChatGPTAdapter.connect({logger:process.env.CHATGPT_DIAGNOSTICS==='1'?e=>process.stderr.write(JSON.stringify(e)+'\n'):undefined,endpoint:process.env.CHATGPT_CDP_ENDPOINT,tabURL:process.env.CHATGPT_TAB_URL,conversation:process.env.CHATGPT_CONVERSATION});
 const print=(value:unknown)=>process.stdout.write(JSON.stringify(value)+'\n');
 switch(command) {
  case 'status':print(await adapter.getStatus());break;
  case 'current':print(await adapter.getCurrentConversation());break;
  case 'turns':print(await adapter.readVisibleTurns());break;
  case 'list':print(await adapter.listRecentConversations({limit:args[0]?Number(args[0]):undefined}));break;
  case 'open':if(!args[0])throw new Error('Missing conversation ID or URL');print(await adapter.openConversation(args[0]));break;
  case 'new':print(await adapter.createConversation());break;
  case 'send':case 'send-file':{
   for await(const event of adapter.sendMessage(message!,{signal:abort.signal}))print(event.type==='done'?{...event,html:renderHTML(event.turn.content)}:event);
   break;
  }
  default:throw new Error(`Unknown command: ${command}. Use help.`);
 }
}catch(e){process.stderr.write(JSON.stringify(diagnosticError(e))+'\n');process.exitCode=1;}
finally{
 try{await adapter?.disconnect();}
 catch(e){process.stderr.write(JSON.stringify(diagnosticError(e))+'\n');process.exitCode=1;}
}
