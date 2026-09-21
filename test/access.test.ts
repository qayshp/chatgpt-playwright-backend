import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { tailscaleAccess, protectRequest } from '../src/service/access.js';
const access = tailscaleAccess('https://laptop.example.ts.net', '100.83.3.8')!;
const headers = {host:'laptop.example.ts.net','x-forwarded-for':'100.83.3.8','x-forwarded-proto':'https','tailscale-user-login':'fixture@example.test'};
function req(h: Record<string,string | undefined>, peer='127.0.0.1') {return {headers:h,socket:{remoteAddress:peer}} as IncomingMessage;}
test('Tailscale access requires explicit valid configuration',()=>{
 assert.equal(tailscaleAccess(),undefined);
 for(const [o,c] of [['https://laptop.example.ts.net',''],['http://laptop.example.ts.net','100.83.3.8'],['https://evil.test','100.83.3.8'],['https://laptop.example.ts.net/path','100.83.3.8'],['https://laptop.example.ts.net','not-an-ip']])assert.throws(()=>tailscaleAccess(o,c));
});
test('only explicit Tailscale clients through loopback Serve are accepted',()=>{
 assert.doesNotThrow(()=>protectRequest(req(headers),3210,access));
 assert.doesNotThrow(()=>protectRequest(req({...headers,origin:access.origin}),3210,access));
 assert.throws(()=>protectRequest(req(headers),3210));
 assert.throws(()=>protectRequest(req(headers,'100.83.3.8'),3210,access));
 for(const patch of [{'x-forwarded-for':'100.83.3.9'},{'x-forwarded-for':'100.83.3.8, 100.83.3.9'},{'tailscale-user-login':''},{'x-forwarded-proto':'http'},{host:'localhost:3210'},{origin:'https://evil.test'},{'sec-fetch-site':'cross-site'}])assert.throws(()=>protectRequest(req({...headers,...patch}),3210,access));
});
test('local access keeps Host and origin checks; remote Host alone is insufficient',()=>{
 assert.doesNotThrow(()=>protectRequest(req({host:'localhost:3210'}),3210,access));
 assert.throws(()=>protectRequest(req({host:headers.host}),3210,access));
 assert.throws(()=>protectRequest(req({host:'localhost:3210','x-forwarded-for':'100.83.3.8'}),3210,access));
 assert.throws(()=>protectRequest(req({host:'localhost:3210',origin:'https://evil.test'}),3210,access));
});
