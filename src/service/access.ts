import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { ServiceError } from './errors.js';

export interface TailscaleAccess { origin: string; clientIPs: string[] }
export function tailscaleAccess(origin?: string, clients?: string): TailscaleAccess | undefined {
  if (!origin && !clients) return undefined;
  let url: URL;
  try { url = new URL(origin ?? ''); } catch { throw new ServiceError('INVALID_TAILSCALE_CONFIG', 'Specify a Tailscale HTTPS origin and allowed client IPs.'); }
  const clientIPs = (clients ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.ts.net') || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !clientIPs.length || clientIPs.some(ip => !isIP(ip))) {
    throw new ServiceError('INVALID_TAILSCALE_CONFIG', 'Use an HTTPS ts.net origin without a path and an explicit comma-separated client IP allowlist.');
  }
  return { origin: url.origin, clientIPs };
}

/** Trust proxy metadata only from local Tailscale Serve. Local processes are already trusted. */
export function protectRequest(req: IncomingMessage, port: number, access?: TailscaleAccess) {
  const host = req.headers.host;
  const proxied = Object.keys(req.headers).some(k => k.startsWith('x-forwarded-') || k.startsWith('tailscale-') || k === 'forwarded');
  let expectedOrigin = `http://${host}`;
  if (proxied) {
    const peer = req.socket.remoteAddress;
    const source = req.headers['x-forwarded-for'];
    if (!access || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer ?? '') ||
        host !== new URL(access.origin).host || req.headers['x-forwarded-proto'] !== 'https' ||
        typeof source !== 'string' || !access.clientIPs.includes(source) ||
        typeof req.headers['tailscale-user-login'] !== 'string' || !req.headers['tailscale-user-login']) {
      throw new ServiceError('TAILSCALE_FORBIDDEN', 'This proxied client is not authorized.', 403);
    }
    expectedOrigin = access.origin;
  } else if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    throw new ServiceError('HOST_FORBIDDEN', 'Unrecognized local Host header.', 403);
  }
  if (req.headers.origin && req.headers.origin !== expectedOrigin) throw new ServiceError('ORIGIN_FORBIDDEN', 'Cross-origin requests are not allowed.', 403);
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site']))) throw new ServiceError('ORIGIN_FORBIDDEN', 'Cross-site requests are not allowed.', 403);
}
