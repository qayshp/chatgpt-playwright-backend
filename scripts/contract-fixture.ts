import { tailscaleAccess } from '../src/service/access.js';
/** Synthetic contract server for the Go integration test. Never connects to Chrome. */
import { setTimeout as delay } from 'node:timers/promises';
import { ChatGPTService, type AdapterPort } from '../src/service/service.js';
import { AdapterError, type Conversation, type ResponseEvent, type SendOptions, type Status, type Turn } from '../src/types.js';

if (!process.argv.includes('--fixture')) {
  process.stderr.write('This synthetic server requires --fixture and is intended for the cross-project contract test.\n');
  process.exit(2);
}

const fixtureName = 'chatgpt-http-contract-fixture-v1';
const knownID = '10000000-0000-4000-8000-000000000001';
const knownConversation: Conversation = { id: knownID, url: `https://chatgpt.com/c/${knownID}`, title: 'Synthetic fixture chat' };
const turn = (text: string, role: Turn['role'] = 'assistant'): Turn => ({
  id: `fixture-${role}`, role,
  content: { schemaVersion: 1, text, warnings: [], blocks: [{ type: 'paragraph', children: [{ type: 'text', text }] }] },
});
const finalTurn: Turn = {
  ...turn('Corrected answer'),
  content: {
    schemaVersion: 1, text: 'Corrected answer', warnings: [], blocks: [
      { type: 'heading', level: 2, children: [{ type: 'text', text: 'Corrected answer' }] },
      { type: 'list', ordered: true, start: 3, items: [[{ type: 'paragraph', children: [{ type: 'text', text: 'Item' }] }]] },
      { type: 'code', language: 'go', text: 'fmt.Println("fixture")' },
      { type: 'paragraph', children: [{ type: 'link', url: 'https://example.com/', children: [{ type: 'text', text: 'Example' }] }, { type: 'citation', label: '1', reference: 'fixture-source', url: 'https://example.com/source' }] },
    ],
  },
};

class ContractAdapter implements AdapterPort {
  connects = 0; disconnects = 0; sends = 0;
  private current = { ...knownConversation };
  private turns: Turn[] = [turn('Existing fixture answer')];
  private generating = false;
  async getStatus(): Promise<Status> {
    return { connected: true, login: 'authenticated', usable: true, composerCount: 1, generating: this.generating, draftPresent: false, conversation: this.current };
  }
  async getCurrentConversation() { return this.current; }
  async readVisibleTurns() { return this.turns; }
  async listRecentConversations() { return { conversations: [knownConversation], complete: false as const, stopReason: 'no-progress' as const, scrolls: 1 }; }
  async openConversation(value: string) {
    this.current = { id: value.split('/').at(-1)!, url: value, title: 'Synthetic fixture chat' };
    return this.current;
  }
  async createConversation() {
    this.current = { id: null, url: 'https://chatgpt.com/', title: 'New synthetic chat' };
    this.turns = [];
    return this.current;
  }
  async *sendMessage(message: string, options: SendOptions = {}): AsyncGenerator<ResponseEvent> {
    this.sends++;
    if (options.expectedConversationId !== this.current.id) throw new AdapterError('CONVERSATION_MISMATCH', 'Wrong fixture destination');
    if (this.current.id === null) this.current = { ...knownConversation, id: '20000000-0000-4000-8000-000000000002', url: 'https://chatgpt.com/c/20000000-0000-4000-8000-000000000002' };
    this.generating = true;
    const requestId = options.requestId!;
    this.turns.push(turn(message, 'user'));
    try {
      yield { type: 'submitted', requestId, conversation: this.current };
      if (message === 'contract/hold') {
        while (!options.signal?.aborted) await delay(10);
        throw new AdapterError('ABORTED', 'Synthetic observation cancelled');
      }
      // Wait for an actual subscriber, including after the client's deliberate disconnect.
      for (const [index, text] of ['Draft answer', '', 'Corrected answer'].entries()) {
        await delay(100);
        const deadline = Date.now() + 5000;
        while (!service.operations.require(requestId).listeners.size && !options.signal?.aborted && Date.now() < deadline) await delay(10);
        if (options.signal?.aborted) throw new AdapterError('ABORTED', 'Synthetic observation cancelled');
        yield { type: 'text', requestId, sequence: index + 1, text, elapsedMs: (index + 1) * 100, observedAt: Date.now() };
        yield { type: 'content', requestId, turn: index === 2 ? finalTurn : turn(text), elapsedMs: (index + 1) * 100 };
      }
      this.turns.push(finalTurn);
      yield { type: 'done', requestId, conversation: this.current, turn: finalTurn, elapsedMs: 300, completionEvidence: ['synthetic-contract-fixture'] };
    } finally { this.generating = false; }
  }
  async disconnect() { this.disconnects++; }
}

const adapter = new ContractAdapter();
const service = new ChatGPTService({ connect: async () => { adapter.connects++; return adapter; }, heartbeatMs: 100, tailscale: tailscaleAccess(process.env.CHATGPT_TAILSCALE_ORIGIN, process.env.CHATGPT_TAILSCALE_CLIENT_IPS) });
const baseURL = await service.start(0);
await service.ready;
process.stdout.write(JSON.stringify({ fixture: fixtureName, baseURL }) + '\n');

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearTimeout(lifetime);
  await service.close();
  process.stdout.write(JSON.stringify({ fixture: fixtureName, stopped: true, connects: adapter.connects, disconnects: adapter.disconnects, sends: adapter.sends }) + '\n');
  process.stdin.pause();
};
// Never leave this fixture behind if the test crashes or its parent disappears.
const lifetime = setTimeout(() => { void stop(); }, 30_000);
process.stdin.resume();
process.stdin.once('end', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
