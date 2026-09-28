import type { Context, Next } from 'hono';
import type { AppEnv } from '../types';
import { GATEWAY_PORT } from '../config';
import { withTrustedForwardedHeaders } from '../gateway/forwarded-headers';

/**
 * Entry point for native OpenClaw clients (e.g. the iOS app).
 *
 * Those clients can't complete a Cloudflare Access browser login, so they
 * connect to a second custom domain (GATEWAY_WS_HOSTNAME) that has no Access
 * application in front of it. All requests are proxied to the gateway; the
 * gateway handles its own authentication (401 without a valid token), so no
 * further filtering is needed here.
 *
 * Authentication is OpenClaw's own: the gateway token plus device pairing
 * (a new device stays pending until approved in /_admin/).
 */

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

    const sandbox = c.get('sandbox');
    try {
      await sandbox.ensureStarted();
    } catch (error) {
      console.error('[GW-WS] Failed to start gateway:', error);
      return c.text('Gateway not ready', 503);
    }

    const request = withTrustedForwardedHeaders(c.req.raw);
    const isWebSocket = c.req.header('Upgrade')?.toLowerCase() === 'websocket';
    if (isWebSocket) {
      try {
        return await sandbox.wsConnect(request, GATEWAY_PORT);
      } catch (error) {
        console.error('[GW-WS] WebSocket proxy error:', error);
        return c.text('WebSocket proxy error', 502);
      }
    }

    try {
      return await sandbox.containerFetch(request, GATEWAY_PORT);
    } catch (error) {
      console.error('[GW-WS] HTTP proxy error:', error);
      return c.text('Proxy error', 502);
    }
  };
}
