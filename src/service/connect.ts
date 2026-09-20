import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { ChatGPTAdapter, type ConnectOptions } from '../adapter.js';
import { AdapterError } from '../types.js';
import { ServiceError } from './errors.js';

async function probe(host: string, port: number) {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    const finish = (error?: Error) => { socket.destroy(); error ? reject(error) : resolve(); };
    socket.setTimeout(1500, () => finish(new Error('timeout')));
    socket.once('connect', () => finish()); socket.once('error', finish);
  });
}
/** Probe only the browser's local debugging transport, never ChatGPT's network protocol. */
export async function connectLocalAdapter(options: ConnectOptions = {}) {
  const endpoint = options.endpoint ?? 'chrome';
  try {
    if (endpoint === 'chrome') {
      let directory: string;
      if (process.platform === 'darwin') directory = join(homedir(), 'Library/Application Support/Google/Chrome');
      else if (process.platform === 'linux') directory = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'google-chrome');
      else if (process.platform === 'win32' && process.env.LOCALAPPDATA) directory = join(process.env.LOCALAPPDATA, 'Google/Chrome/User Data');
      else throw new ServiceError('CDP_UNAVAILABLE', 'Use an explicit loopback CDP endpoint on this platform.', 503, 'cdp_unavailable');
      const metadata = await readFile(join(directory, 'DevToolsActivePort'), 'utf8');
      const port = Number(metadata.split(/\r?\n/)[0]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
      await probe('127.0.0.1', port);
    } else {
      const url = new URL(endpoint);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'ws:'].includes(url.protocol) || url.username || url.password) throw new ServiceError('INVALID_ENDPOINT', 'Only a loopback CDP endpoint is allowed.');
      await probe(url.hostname.replace(/^\[|\]$/g, ''), Number(url.port || 80));
    }
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError('CDP_UNAVAILABLE', 'Chrome remote debugging is unavailable. Enable it in the existing browser, then restart this service.', 503, 'cdp_unavailable');
  }
  try { return await ChatGPTAdapter.connect({ ...options, timeoutMs: options.timeoutMs ?? 30000 }); }
  catch (error) {
    if (error instanceof AdapterError) throw error;
    // The listening socket is evidence of availability, not of consent. Playwright's
    // channel error does not reliably distinguish a pending prompt from rejection.
    throw new ServiceError('CDP_APPROVAL_REQUIRED_OR_REJECTED', 'Chrome was reachable but attachment failed. Check its Allow remote debugging prompt, then restart the service. Approval versus rejection could not be distinguished.', 503, 'approval_required_or_rejected');
  }
}
