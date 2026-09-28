import type { Context, Next } from 'hono';
import type { AppEnv } from '../types';
import { GATEWAY_PORT } from '../config';
import { withTrustedForwardedHeaders } from '../gateway/forwarded-headers';

/**
 * Entry point for native OpenClaw clients (e.g. the iOS app).
 *
 * Those clients can't complete a Cloudflare Access browser login, so they
 * connect to a second custom domain (GATEWAY_WS_HOSTNAME) that has no Access
 * application in front of it. To keep that opening as small as possible this
 * host:
 * - accepts WebSocket upgrades and GET/HEAD for chat media (native clients
 *   fetch generated images over HTTP); everything else gets 404, so the
 *   Control UI, admin UI and the gateway token script stay off this host.
 *   The gateway authenticates media requests itself (401 without a token)
 * - never injects MOLTBOT_GATEWAY_TOKEN: clients must present their own token
 *
 * Authentication is OpenClaw's own: the gateway token plus device pairing
 * (a new device stays pending until approved in /_admin/).
 */

/** Chat media (images, audio) that native clients load over HTTP */
const MEDIA_PATH_PREFIX = '/api/chat/media/';

export function isAllowedGatewayHttpRequest(method: string, pathname: string): boolean {
  const readOnly = method === 'GET' || method === 'HEAD';
  return readOnly && pathname.startsWith(MEDIA_PATH_PREFIX);
}

export function isGatewayWsHost(env: AppEnv['Bindings'], host: string): boolean {
  const configured = env.GATEWAY_WS_HOSTNAME?.trim().toLowerCase();
  return configured !== undefined && configured !== '' && configured === host.toLowerCase();
}

export function gatewayWsMiddleware() {
  return async (c: Context<AppEnv>, next: Next) => {
    const url = new URL(c.req.url);
    if (!isGatewayWsHost(c.env, url.host)) {
      return next();
    }

    const isWebSocket = c.req.header('Upgrade')?.toLowerCase() === 'websocket';
    if (!isWebSocket && !isAllowedGatewayHttpRequest(c.req.method, url.pathname)) {
      console.log('[GW-WS] Request rejected:', c.req.method, url.pathname);
      return c.text('Not Found', 404);
    }

    const sandbox = c.get('sandbox');
    try {
      await sandbox.ensureStarted();
    } catch (error) {
      console.error('[GW-WS] Failed to start gateway:', error);
      return c.text('Gateway not ready', 503);
    }

    const request = withTrustedForwardedHeaders(c.req.raw);
    if (!isWebSocket) {
      console.log('[GW-WS] Proxying media request:', url.pathname);
      try {
        return await sandbox.containerFetch(request, GATEWAY_PORT);
      } catch (error) {
        console.error('[GW-WS] Media proxy error:', error);
        return c.text('Proxy error', 502);
      }
    }

    console.log('[GW-WS] Proxying WebSocket connection to gateway:', url.pathname);
    try {
      return await sandbox.wsConnect(request, GATEWAY_PORT);
    } catch (error) {
      console.error('[GW-WS] WebSocket proxy error:', error);
      return c.text('WebSocket proxy error', 502);
    }
  };
}
