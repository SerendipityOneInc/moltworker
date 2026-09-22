import { describe, it, expect, vi } from 'vitest';
import plugin, {
  buildRequestInit,
  buildWorkersAiImageProvider,
  detectMimeType,
  resolveCredentials,
  resolveDimensions,
  DEFAULT_MODEL,
} from './index.js';

const ENV = { WORKERS_AI_ACCOUNT_ID: 'acct', WORKERS_AI_API_TOKEN: 'token' };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

function jsonImageResponse(bytes = JPEG) {
  return new Response(JSON.stringify({ result: { image: bytes.toString('base64') } }), {
    headers: { 'content-type': 'application/json' },
  });
}

describe('resolveCredentials', () => {
  it('prefers WORKERS_AI_* and falls back to AI Gateway vars', () => {
    expect(resolveCredentials(ENV)).toEqual({ accountId: 'acct', apiToken: 'token' });
    expect(
      resolveCredentials({ CF_AI_GATEWAY_ACCOUNT_ID: 'a2', CLOUDFLARE_AI_GATEWAY_API_KEY: 't2' }),
    ).toEqual({ accountId: 'a2', apiToken: 't2' });
  });

  it('returns null when either value is missing', () => {
    expect(resolveCredentials({ WORKERS_AI_ACCOUNT_ID: 'acct' })).toBeNull();
  });
});

describe('resolveDimensions', () => {
  it('parses WIDTHxHEIGHT and rounds to multiples of 16', () => {
    expect(resolveDimensions({ size: '1000x770' })).toEqual({ width: 1008, height: 768 });
  });

  it('derives dimensions from an aspect ratio', () => {
    expect(resolveDimensions({ aspectRatio: '16:9' })).toEqual({ width: 1024, height: 576 });
    expect(resolveDimensions({ aspectRatio: '9:16' })).toEqual({ width: 576, height: 1024 });
  });

  it('returns null without size or aspect ratio', () => {
    expect(resolveDimensions({})).toBeNull();
    expect(resolveDimensions({ size: 'auto' })).toBeNull();
  });
});

describe('buildRequestInit', () => {
  it('uses multipart form data for FLUX.2', () => {
    const { body } = buildRequestInit(DEFAULT_MODEL, 'a cat', { width: 512, height: 768 });
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('prompt')).toBe('a cat');
    expect(body.get('width')).toBe('512');
  });

  it('uses JSON with few steps for FLUX.1 schnell', () => {
    const { body, headers } = buildRequestInit('@cf/black-forest-labs/flux-1-schnell', 'a cat', {
      width: 512,
      height: 512,
    });
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(body)).toEqual({ prompt: 'a cat', steps: 4 });
  });

  it('passes dimensions as JSON for other models', () => {
    const { body } = buildRequestInit('@cf/leonardo/lucid-origin', 'a cat', {
      width: 1024,
      height: 576,
    });
    expect(JSON.parse(body)).toEqual({ prompt: 'a cat', width: 1024, height: 576 });
  });
});

describe('detectMimeType', () => {
  it('recognizes JPEG and PNG', () => {
    expect(detectMimeType(JPEG)).toBe('image/jpeg');
    expect(detectMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBe('image/png');
  });
});

describe('generateImage', () => {
  it('calls the Workers AI run endpoint and returns the image', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonImageResponse());
    const provider = buildWorkersAiImageProvider({ env: ENV, fetchImpl });

    const result = await provider.generateImage({ prompt: 'a kite' });

    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.cloudflare.com/client/v4/accounts/acct/ai/run/${DEFAULT_MODEL}`,
      expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer token' } }),
    );
    expect(result.model).toBe(DEFAULT_MODEL);
    expect(result.images).toEqual([
      { buffer: JPEG, mimeType: 'image/jpeg', fileName: 'workers-ai-1.jpg' },
    ]);
  });

  it('accepts raw image responses', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } }));
    const provider = buildWorkersAiImageProvider({ env: ENV, fetchImpl });

    const { images } = await provider.generateImage({
      prompt: 'a kite',
      model: '@cf/bytedance/stable-diffusion-xl-lightning',
    });

    expect(images[0].buffer).toEqual(JPEG);
  });

  it('makes one call per requested image, capped at 4', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonImageResponse());
    const provider = buildWorkersAiImageProvider({ env: ENV, fetchImpl });

    const { images } = await provider.generateImage({ prompt: 'a kite', count: 9 });

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(images.map((i) => i.fileName)).toEqual([
      'workers-ai-1.jpg',
      'workers-ai-2.jpg',
      'workers-ai-3.jpg',
      'workers-ai-4.jpg',
    ]);
  });

  it('surfaces Workers AI error messages', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ message: 'Authentication error' }] }), {
        status: 401,
      }),
    );
    const provider = buildWorkersAiImageProvider({ env: ENV, fetchImpl });

    await expect(provider.generateImage({ prompt: 'a kite' })).rejects.toThrow(
      'failed (HTTP 401): Authentication error',
    );
  });

  it('reports missing credentials', async () => {
    const provider = buildWorkersAiImageProvider({ env: {}, fetchImpl: vi.fn() });
    expect(provider.isConfigured()).toBe(false);
    await expect(provider.generateImage({ prompt: 'a kite' })).rejects.toThrow('credentials missing');
  });
});

describe('plugin entry', () => {
  it('registers the workers-ai image generation provider', () => {
    const api = { registerImageGenerationProvider: vi.fn() };
    plugin.register(api);
    expect(api.registerImageGenerationProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'workers-ai', defaultModel: DEFAULT_MODEL }),
    );
  });
});
