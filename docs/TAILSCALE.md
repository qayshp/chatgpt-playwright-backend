# ColorBerry access through Tailscale Serve

The backend still listens only on `127.0.0.1:3210`. Tailscale Serve terminates HTTPS on this laptop's tailnet hostname and proxies to that listener. Chrome's debugging endpoint is never published. Tailscale Funnel is not used.

Configured URL: **https://qhp-mbp-14-6.albacore-dinosaur.ts.net**

## Start and connect

The ignored, private `.env.tailscale` holds this laptop's HTTPS origin and ColorBerry's allowed Tailscale IP. From this repository:

```sh
npm run service:tailscale
```

This is a foreground backend process with one persistent Chrome connection. Chrome may request debugging approval at startup. Stop with Ctrl-C. There is no launchd daemon or automatic backend restart. Keep the laptop awake, Tailscale connected, and the selected authenticated ChatGPT tab available.

Tailscale Serve is already configured in background mode. Its mapping persists independently of the backend process. On ColorBerry, supply the full HTTPS URL to the frontend:

```sh
chatgpt-tui --backend https://qhp-mbp-14-6.albacore-dinosaur.ts.net
# Or set CHATGPT_BACKEND_URL to that URL before running the TUI.
```

TLS certificate verification remains enabled. No new token or ChatGPT login is needed. This setup does not install the TUI binary on ColorBerry.

## Authorization boundary

- Tailscale authenticates the device and applies tailnet policy. The backend additionally permits only ColorBerry's source IP (`100.83.3.8`) remotely. Other tailnet devices are rejected even if network policy lets them reach HTTPS.
- Proxied requests must arrive from loopback with the exact configured Host, HTTPS forwarding metadata, a single allowed source IP, and a nonempty Serve-injected `Tailscale-User-Login` identity. Tagged devices without that identity are rejected.
- Cross-origin/cross-site checks remain enforced. Serve replaces incoming source metadata. Proxied requests using a local Host are rejected, preventing bypass of remote checks.
- Local processes remain trusted. This trusts the local Tailscale Serve process, not arbitrary reverse proxies; do not add another forwarding service to this listener or expose its port on the LAN.

Only the HTTP service knows about this policy. The browser adapter/schema remain unchanged. Remote access is disabled unless both configuration fields are supplied. Logs do not record identity headers or client IPs.

## Reconfigure or disable

On another machine, create `.env.tailscale` with mode 0600, substituting its actual hostname and approved client IPs:

```dotenv
CHATGPT_TAILSCALE_ORIGIN=https://laptop.example.ts.net
CHATGPT_TAILSCALE_CLIENT_IPS=100.64.1.2
```

Multiple IPs are comma-separated. Restart the backend after edits. If ColorBerry's Tailscale IP changes after re-enrollment, update this allowlist. A 403 is an access-policy issue, not a ChatGPT login failure.

Inspect existing Serve mappings first; this setup found none. Configure or disable only the intended mapping:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:3210
tailscale serve status
tailscale serve --https=443 off
```

On this Mac the matching CLI is `/Applications/Tailscale.app/Contents/MacOS/Tailscale`; the Homebrew CLI reports a build mismatch with the running app. No upgrade or tailnet ACL change was needed. Do not use `serve reset`, which could remove unrelated future mappings.

With Serve disabled, local access still works. With Node stopped but Serve enabled, remote requests receive a proxy error. Serve does not start Node or Chrome.

## Verification — 2026-09-20

- TypeScript and 52 automated tests pass, including default-deny proxy access, exact origin/client checks, missing identity, source chains, wrong peers/Hosts, and cross-origin requests.
- ColorBerry's real HTTPS `/status` returned 200, `usable`, and one Chrome connection attempt. Repeated checks reused that connection. No real ChatGPT message was sent.
- Spoofed source headers from ColorBerry were overwritten by Serve. Cross-origin and forged localhost Host requests returned 403. This laptop's non-allowlisted tailnet HTTPS request also returned 403; local loopback access remained available.
- A synthetic service temporarily exposed on HTTPS 8443 delivered incremental text/structured SSE snapshots to ColorBerry, then completed with a retrievable final result. Events arrived across approximately 0.48–0.69 seconds after subscription; this is fixture evidence, not ChatGPT latency. The temporary mapping/process were removed.
- The production listener remained on `127.0.0.1`; only the intended HTTPS 443 mapping remains. No Funnel, browser-profile changes, device settings, or TUI installation were introduced.

See [Tailscale Serve documentation](https://tailscale.com/docs/features/tailscale-serve), [CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve), and [local diagnostics](DEBUGGING.md).
