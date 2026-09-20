import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { safeLogger, diagnosticError } from '../src/diagnostics.js';
import { AdapterError } from '../src/types.js';

test('logging is opt-in and a failed diagnostic sink does not fail browser work',()=>{
 assert.doesNotThrow(()=>safeLogger()({event:'stage',at:'now'}));
 assert.doesNotThrow(()=>safeLogger(()=>{throw Error('disk full');})({event:'stage',at:'now'}));
 const events:unknown[]=[];safeLogger(e=>events.push(e))({event:'stage',at:'now',count:3});assert.equal(events.length,1);
});
test('CLI errors omit raw Playwright call logs and tab URLs',()=>{
 const raw=diagnosticError(Error('locator.fill("PRIVATE PROMPT"): https://private.test/token'));
 assert(!JSON.stringify(raw).includes('PRIVATE'));assert(!JSON.stringify(raw).includes('private.test'));
 const selection=diagnosticError(new AdapterError('TAB_SELECTION','Select one tab',{tabs:['https://chatgpt.com/c/private-id'],count:2}));
 assert.deepEqual(selection.details,{count:2});assert(!JSON.stringify(selection).includes('private-id'));
});
test('invalid CLI commands and missing messages fail before requesting Chrome attachment',()=>{
 for(const args of [['not-a-command'],['send'],['send-file'],['open'],['open','https://untrusted.test/c/12345678'],['list','not-a-number'],['send-file','/nonexistent-chatgpt-fixture-message']]){
  const p=spawnSync(process.execPath,['--import','tsx','src/cli.ts',...args],{cwd:new URL('..',import.meta.url),encoding:'utf8',env:{...process.env,CHATGPT_CDP_ENDPOINT:'invalid',CHATGPT_DIAGNOSTICS:'1'}});
  assert.equal(p.status,1);assert.equal(p.stdout,'');assert(!p.stderr.includes('INVALID_ENDPOINT'));assert(!p.stderr.includes('connecting'));assert.match(p.stderr,/INVALID_COMMAND|EMPTY_MESSAGE|INVALID_ARGUMENT|INVALID_CONVERSATION|INVALID_LIMIT|MESSAGE_READ_FAILED/);
 }
});
