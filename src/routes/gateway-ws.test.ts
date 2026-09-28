import { describe, it, expect, vi } from 'vitest';
import type { Context } from 'hono';
import { gatewayWsMiddleware, isGatewayWsHost } from './gateway-ws';
import type { AppEnv, OpenClawEnv } from '../types';
import { createMockEnv } from '../test-utils';

const GW_HOST = 'gw.example.com';

function createContext(options: {
  url: string;
  upgrade?: string;
  env?: Partial<OpenClawEnv>;
  ensureStarted?: ReturnType<typeof vi.fn>;
  wsConnect?: ReturnType<typeof vi.fn>;
  containerFetch?: ReturnType<typeof vi.fn>;
}) {
  const headers = new Headers({ 'cf-connecting-ip': '203.0.113.5', 'x-forwarded-for': 'spoofed' });
  if (options.upgrade) headers.set('Upgrade', options.upgrade);
  const request = new Request(options.url, { headers });
  const textMock = vi.fn((body: string, status?: number) => new Response(body, { status }));
  const sandbox = {
    containerFetch:
      options.containerFetch ?? vi.fn().mockResolvedValue(new Response('img', { status: 200 })),
    ensureStarted: options.ensureStarted ?? vi.fn().mockResolvedValue(undefined),
    // Response can't be constructed with 101, so stand in for the upgrade
    wsConnect:
      options.wsConnect ?? vi.fn().mockResolvedValue({ status: 101 } as unknown as Response),
  };

  const c = {
    req: {
      raw: request,
      method: request.method,
      url: request.url,
      header: (n: string) => headers.get(n) ?? undefined,
    },
    env: createMockEnv({ GATEWAY_WS_HOSTNAME: GW_HOST, ...options.env }),
    get: (key: string) => (key === 'sandbox' ? sandbox : undefined),
    text: textMock,
  } as unknown as Context<AppEnv>;

  return { c, sandbox, textMock };
}

describe('isGatewayWsHost', () => {
  it('matches the configured hostname, ignoring case', () => {
    const env = createMockEnv({ GATEWAY_WS_HOSTNAME: GW_HOST });
    expect(isGatewayWsHost(env, GW_HOST)).toBe(true);
    expect(isGatewayWsHost(env, 'GW.example.com')).toBe(true);
    expect(isGatewayWsHost(env, 'moltbot.example.com')).toBe(false);
  });

  it('is off when unset or empty', () => {
    expect(isGatewayWsHost(createMockEnv(), GW_HOST)).toBe(false);
    expect(isGatewayWsHost(createMockEnv({ GATEWAY_WS_HOSTNAME: '  ' }), GW_HOST)).toBe(false);
  });
});

describe('gatewayWsMiddleware', () => {
  it('passes other hosts through untouched', async () => {
    const { c, sandbox } = createContext({
      url: 'https://moltbot.example.com/',
      upgrade: 'websocket',
    });
    const next = vi.fn();

    await gatewayWsMiddleware()(c, next);

    expect(next).toHaveBeenCalled();
    expect(sandbox.wsConnect).not.toHaveBeenCalled();
  });

  it('proxies WebSocket upgrades on the gateway host without Access', async () => {
    const { c, sandbox } = createContext({ url: `https://${GW_HOST}/`, upgrade: 'WebSocket' });
    const next = vi.fn();

    const response = await gatewayWsMiddleware()(c, next);

    expect(next).not.toHaveBeenCalled();
    expect(sandbox.ensureStarted).toHaveBeenCalled();
    expect(response?.status).toBe(101);
    const proxied = sandbox.wsConnect.mock.calls[0][0] as Request;
    // Client-supplied forwarded headers are rebuilt, and no token is injected
    expect(proxied.headers.get('x-forwarded-for')).toBe('203.0.113.5');
    expect(new URL(proxied.url).searchParams.has('token')).toBe(false);
  });

  it('proxies HTTP requests so native clients can load chat media', async () => {
    const { c, sandbox } = createContext({
      url: `https://${GW_HOST}/api/chat/media/outgoing/agent%3Amain/abc/full`,
    });

    const response = await gatewayWsMiddleware()(c, vi.fn());

    expect(response?.status).toBe(200);
    expect(sandbox.containerFetch).toHaveBeenCalled();
    const proxied = sandbox.containerFetch.mock.calls[0][0] as Request;
    expect(proxied.headers.get('x-forwarded-for')).toBe('203.0.113.5');
    // The gateway authenticates itself, so no token is injected here either
    expect(new URL(proxied.url).searchParams.has('token')).toBe(false);
  });

  it('reports 502 when the HTTP proxy fails', async () => {
    const { c, textMock } = createContext({
      url: `https://${GW_HOST}/api/chat/sessions`,
      containerFetch: vi.fn().mockRejectedValue(new Error('nope')),
    });

    await gatewayWsMiddleware()(c, vi.fn());

    expect(textMock).toHaveBeenCalledWith('Proxy error', 502);
  });

  it('reports 503 when the gateway cannot start', async () => {
    const { c, textMock } = createContext({
      url: `https://${GW_HOST}/`,
      upgrade: 'websocket',
      ensureStarted: vi.fn().mockRejectedValue(new Error('boom')),
    });

    await gatewayWsMiddleware()(c, vi.fn());

    expect(textMock).toHaveBeenCalledWith('Gateway not ready', 503);
  });

  it('reports 502 when the WebSocket proxy fails', async () => {
    const { c, textMock } = createContext({
      url: `https://${GW_HOST}/`,
      upgrade: 'websocket',
      wsConnect: vi.fn().mockRejectedValue(new Error('nope')),
    });

    await gatewayWsMiddleware()(c, vi.fn());

    expect(textMock).toHaveBeenCalledWith('WebSocket proxy error', 502);
  });
});
