/**
 * Rebuild forwarded-client headers on a request proxied to the gateway.
 *
 * OpenClaw >= 2026.9 rejects proxied requests unless client attribution is
 * trustworthy: forwarded headers must come from a trusted proxy that
 * overwrites them (otherwise it answers 403 proxy_attribution_required).
 * Browser-supplied headers can't be trusted, so drop every forwarded header
 * and set X-Forwarded-For from Cloudflare's CF-Connecting-IP, which clients
 * cannot spoof. gateway.trustedProxies (start-openclaw.sh) must cover the
 * address the Worker's requests arrive from.
 */
export function withTrustedForwardedHeaders(request: Request): Request {
  const headers = new Headers(request.headers);
  // Snapshot the names first: deleting while iterating Headers skips entries
  for (const name of Array.from(headers.keys())) {
    if (name === 'forwarded' || name === 'x-real-ip' || name.startsWith('x-forwarded-')) {
      headers.delete(name);
    }
  }

  const clientIp = headers.get('cf-connecting-ip');
  if (clientIp) {
    const url = new URL(request.url);
    headers.set('x-forwarded-for', clientIp);
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
    headers.set('x-forwarded-host', url.host);
  }

  return new Request(request, { headers });
}
