/**
 * OpenClaw image generation provider for Cloudflare Workers AI.
 *
 * Registers provider "workers-ai" for the built-in image_generate tool, so a
 * model ref like "workers-ai/@cf/black-forest-labs/flux-2-klein-9b" can be set
 * as agents.defaults.mediaModels.image.primary. Calls the Workers AI REST API
 * directly; usage is billed to the Cloudflare account, no third-party key.
 *
 * Credentials (first set wins):
 * - account: WORKERS_AI_ACCOUNT_ID, CF_AI_GATEWAY_ACCOUNT_ID, CLOUDFLARE_ACCOUNT_ID
 * - token:   WORKERS_AI_API_TOKEN, CLOUDFLARE_AI_GATEWAY_API_KEY
 *   (needs the "Workers AI Read" permission)
 */

export const PROVIDER_ID = 'workers-ai';
export const DEFAULT_MODEL = '@cf/black-forest-labs/flux-2-klein-9b';
export const MODELS = [
  DEFAULT_MODEL,
  '@cf/black-forest-labs/flux-2-klein-4b',
  '@cf/black-forest-labs/flux-2-dev',
  '@cf/black-forest-labs/flux-1-schnell',
  '@cf/leonardo/lucid-origin',
  '@cf/leonardo/phoenix-1.0',
];

const API_BASE = 'https://api.cloudflare.com/client/v4/accounts';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_COUNT = 4;
/** Longest edge for sizes derived from an aspect ratio */
const BASE_EDGE = 1024;

export function resolveCredentials(env = process.env) {
  const accountId =
    env.WORKERS_AI_ACCOUNT_ID || env.CF_AI_GATEWAY_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.WORKERS_AI_API_TOKEN || env.CLOUDFLARE_AI_GATEWAY_API_KEY;
  return accountId && apiToken ? { accountId, apiToken } : null;
}

function roundTo16(value) {
  return Math.max(256, Math.round(value / 16) * 16);
}

/**
 * Resolve output dimensions from "WIDTHxHEIGHT" or an aspect ratio like "16:9".
 * Returns null when neither is given, leaving the model default.
 */
export function resolveDimensions({ size, aspectRatio } = {}) {
  const sizeMatch = /^(\d+)\s*x\s*(\d+)$/i.exec(size?.trim() ?? '');
  if (sizeMatch) {
    return { width: roundTo16(Number(sizeMatch[1])), height: roundTo16(Number(sizeMatch[2])) };
  }
  const ratioMatch = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(aspectRatio?.trim() ?? '');
  if (ratioMatch) {
    const ratio = Number(ratioMatch[1]) / Number(ratioMatch[2]);
    if (!(ratio > 0)) return null;
    return ratio >= 1
      ? { width: BASE_EDGE, height: roundTo16(BASE_EDGE / ratio) }
      : { width: roundTo16(BASE_EDGE * ratio), height: BASE_EDGE };
  }
  return null;
}

/**
 * Build the request body for a model. FLUX.2 models only accept multipart
 * form data; the others take JSON.
 */
export function buildRequestInit(model, prompt, dimensions) {
  if (model.startsWith('@cf/black-forest-labs/flux-2-')) {
    const form = new FormData();
    form.append('prompt', prompt);
    if (dimensions) {
      form.append('width', String(dimensions.width));
      form.append('height', String(dimensions.height));
    }
    return { body: form, headers: {} };
  }
  const body = { prompt };
  if (model === '@cf/black-forest-labs/flux-1-schnell') {
    // schnell renders a fixed 1024x1024 and is tuned for few steps (max 8)
    body.steps = 4;
  } else if (dimensions) {
    body.width = dimensions.width;
    body.height = dimensions.height;
  }
  return { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } };
}

export function detectMimeType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** Workers AI returns either raw image bytes or JSON with base64 in result.image */
async function readImageBytes(response, model) {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.startsWith('image/')) {
    return Buffer.from(await response.arrayBuffer());
  }
  const payload = await response.json();
  const image = payload?.result?.image;
  if (typeof image !== 'string' || image.length === 0) {
    throw new Error(`Workers AI ${model} returned no image`);
  }
  return Buffer.from(image, 'base64');
}

async function runModel({ accountId, apiToken }, model, prompt, dimensions, signal, fetchImpl) {
  const { body, headers } = buildRequestInit(model, prompt, dimensions);
  const response = await fetchImpl(`${API_BASE}/${accountId}/ai/run/${model}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, ...headers },
    body,
    signal,
  });
  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json();
      detail = payload?.errors?.map((e) => e.message).join('; ') ?? '';
    } catch {
      // not JSON
    }
    throw new Error(`Workers AI ${model} failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`);
  }
  return readImageBytes(response, model);
}

export function buildWorkersAiImageProvider({ env = process.env, fetchImpl = fetch } = {}) {
  return {
    id: PROVIDER_ID,
    label: 'Cloudflare Workers AI',
    defaultModel: DEFAULT_MODEL,
    models: MODELS,
    isConfigured: () => resolveCredentials(env) !== null,
    capabilities: {
      generate: { maxCount: MAX_COUNT, supportsSize: true, supportsAspectRatio: true },
      edit: { enabled: false },
    },
    async generateImage(req) {
      const credentials = resolveCredentials(env);
      if (!credentials) {
        throw new Error(
          'Workers AI credentials missing: set WORKERS_AI_ACCOUNT_ID and WORKERS_AI_API_TOKEN',
        );
      }
      const model = req.model?.trim() || DEFAULT_MODEL;
      const count = Math.min(Math.max(req.count ?? 1, 1), MAX_COUNT);
      const dimensions = resolveDimensions(req);
      const signal = AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      const images = [];
      // Sequential: Workers AI image models return one image per call
      for (let i = 0; i < count; i++) {
        // oxlint-disable-next-line no-await-in-loop
        const buffer = await runModel(credentials, model, req.prompt, dimensions, signal, fetchImpl);
        const mimeType = detectMimeType(buffer);
        images.push({
          buffer,
          mimeType,
          fileName: `workers-ai-${i + 1}.${EXTENSIONS[mimeType] ?? 'bin'}`,
        });
      }
      return { images, model };
    },
  };
}

export default {
  id: 'workers-ai-image',
  name: 'Workers AI Images',
  description: 'Image generation with Cloudflare Workers AI models',
  register(api) {
    api.registerImageGenerationProvider(buildWorkersAiImageProvider());
  },
};
