// packages/server/src/origin.ts
// Origin fix round 1 (CRITICAL finding in task-origin-review.md): the same-origin recognition
// logic used to live only in http.ts and was applied only to the HTTP CORS path -- the
// WebSocket upgrade handler (ws/browser.ts) never checked Origin at all. This module is the
// ONE place that logic lives now, imported by both http.ts (CORS) and ws/browser.ts (the `/ws`
// upgrade). Browsers do not apply the Same-Origin Policy to WebSocket connections the way they
// do to fetch/XHR -- there is no preflight -- so server-side Origin validation on the upgrade
// request is the only mechanism available to restrict which pages can drive a live call socket.
import type { IncomingMessage } from 'node:http';
import type { ServerConfig } from './config.js';

/** The only two `ServerConfig` fields this module reads -- kept as a narrow `Pick` (rather
 *  than requiring the full config) so a caller with a partial/deps-level config shape (e.g.
 *  ws/browser.ts's `BrowserWsDeps`) can pass it straight through without threading the whole
 *  `ServerConfig` object. */
type OriginConfig = Pick<ServerConfig, 'allowed_origins' | 'trust_proxy'>;

/** One comma-separated header value, picking either the first (closest to the original
 *  client) or the last (appended by the proxy hop closest to this server -- the most
 *  trusted, per the standard `X-Forwarded-*` convention). `Host` is read with `pick: 'first'`
 *  (it is not a proxy-appended list); `X-Forwarded-Proto`/`X-Forwarded-Host` are read with
 *  `pick: 'last'` when trusted, so a client that pre-sets its own `X-Forwarded-Host` on a
 *  direct request can't have that spoofed value read back as this server's own origin --
 *  only the right-most value, the one nearest proxy actually set, is trusted. Handles a
 *  Node header that arrives as a plain string, a comma-joined string, or (per Node's own
 *  typings) a string array. */
function headerValue(value: string | string[] | undefined, pick: 'first' | 'last'): string | undefined {
  let raw: string | undefined;
  if (Array.isArray(value)) {
    raw = pick === 'last' ? value.at(-1) : value[0];
  } else if (typeof value === 'string') {
    const parts = value.split(',');
    raw = pick === 'last' ? parts.at(-1) : parts[0];
  }
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** True when this request itself arrived over TLS -- the local, no-proxy-in-front fallback
 *  for `selfOrigin`'s scheme (used whenever `COUNTERSIGN_TRUST_PROXY` is not set). A plain
 *  `node:http` server is never itself terminating TLS in this stack (Render's edge does
 *  that), so in production this is always false and the scheme comes from `X-Forwarded-Proto`
 *  once `trust_proxy` is on; this fallback only matters for local dev / tests. */
function isTlsSocket(req: IncomingMessage): boolean {
  return (req.socket as unknown as { encrypted?: boolean }).encrypted === true;
}

/** Origins never carry a port for their scheme's default port (`:443` for https, `:80` for
 *  http) -- a `Host`/`X-Forwarded-Host` value that spells it out explicitly (some proxies do)
 *  must still compare equal to the browser's own port-less `Origin`. */
function stripDefaultPort(host: string, proto: string): string {
  if (proto === 'https' && host.endsWith(':443')) return host.slice(0, -4);
  if (proto === 'http' && host.endsWith(':80')) return host.slice(0, -3);
  return host;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, '');
}

/** The origin this request itself arrived on, i.e. what a browser on the SAME host+port as
 *  this server would send as its `Origin` header. Render (and most PaaS hosts) terminate TLS
 *  in front of the app and forward the original scheme/host via `X-Forwarded-Proto` /
 *  `X-Forwarded-Host` -- honoured here ONLY when `cfg.trust_proxy` is set (COUNTERSIGN_TRUST_
 *  PROXY=1, set in render.yaml; never set for local dev, where there is no proxy in front of
 *  this process and trusting a client-supplied forwarded header would let it lie about its
 *  own origin). Without proxy trust, falls back to the plain `Host` header and this request's
 *  own socket scheme (https only if the socket itself is TLS, else http). Returns `null` only
 *  when even `Host` is missing (not a real browser/HTTP request). */
export function selfOrigin(req: IncomingMessage, cfg: OriginConfig): string | null {
  const host = cfg.trust_proxy
    ? (headerValue(req.headers['x-forwarded-host'], 'last') ?? headerValue(req.headers.host, 'first'))
    : headerValue(req.headers.host, 'first');
  if (!host) return null;
  const proto = cfg.trust_proxy
    ? (headerValue(req.headers['x-forwarded-proto'], 'last') ?? (isTlsSocket(req) ? 'https' : 'http'))
    : (isTlsSocket(req) ? 'https' : 'http');
  return `${proto}://${stripDefaultPort(host, proto)}`;
}

/** An origin is allowed if it's in the configured allowlist (e.g. a custom domain or a
 *  second front end, see config.ts/docs/DEPLOY.md) OR it's this request's own origin
 *  (same-origin always works, no env var needed). An empty configured allowlist never widens
 *  this to "allow all" -- it only means no EXTRA origins beyond same-origin. Comparison is
 *  case-insensitive with configured entries' trailing slashes stripped (a real browser
 *  `Origin` header is always lowercase and never carries a trailing slash, so this only
 *  widens what a legitimate request can match, never what an attacker's own Origin can fake).
 *  A missing `Origin` header is never allowed -- callers that don't send one (a non-browser
 *  fetch, a health-check) simply get no CORS header from `applyCors`; the WS upgrade path
 *  requires one outright, since real browsers always send `Origin` on a WebSocket upgrade. */
export function isAllowedOrigin(req: IncomingMessage, cfg: OriginConfig): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return false;
  const o = normalize(origin);
  if (cfg.allowed_origins.some((entry) => normalize(entry) === o)) return true;
  const self = selfOrigin(req, cfg);
  return self !== null && o === normalize(self);
}
