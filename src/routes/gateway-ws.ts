import type { Context, Next } from 'hono';
import type { AppEnv } from '../types';
import { GATEWAY_PORT } from '../config';
import { withTrustedForwardedHeaders } from '../gateway/forwarded-headers';

/**
 * WebSocket-only entry point for native OpenClaw clients (e.g. the iOS app).
 *
 * Those clients can't complete a Cloudflare Access browser login, so they
 * connect to a second custom domain (GATEWAY_WS_HOSTNAME) that has no Access
 * application in front of it. To keep that opening as small as possible this
 * host:
 * - only accepts WebSocket upgrades; everything else gets 404, so the Control
 *   UI, admin UI and the gateway token script are not reachable there
 * - never injects MOLTBOT_GATEWAY_TOKEN: clients must present their own token
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

    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      console.log('[GW-WS] Non-WebSocket request rejected:', c.req.method, url.pathname);
      return c.text('Not Found', 404);
    }

    const sandbox = c.get('sandbox');
    try {
      await sandbox.ensureStarted();
    } catch (error) {
      console.error('[GW-WS] Failed to start gateway:', error);
      return c.text('Gateway not ready', 503);
    }

    console.log('[GW-WS] Proxying WebSocket connection to gateway:', url.pathname);
    try {
      return await sandbox.wsConnect(withTrustedForwardedHeaders(c.req.raw), GATEWAY_PORT);
    } catch (error) {
      console.error('[GW-WS] WebSocket proxy error:', error);
      return c.text('WebSocket proxy error', 502);
    }
  };
}
